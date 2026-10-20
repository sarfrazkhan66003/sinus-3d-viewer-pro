
"""
SINUS VIEWER — AUTHENTICATED DICOM PREVIEW API
==============================================

Endpoints:
    GET /api/previews/capabilities
    GET /api/previews/{dataset_session_id}/{series_handle}
    GET /api/previews/{dataset_session_id}/{series_handle}/{plane}.png

Features:
- Authentication and trusted dataset ownership.
- Axial, coronal and sagittal navigation previews.
- Strict Pydantic preview response schemas.
- In-memory, lossless 8-bit grayscale PNG encoding.
- Bounded source image dimensions.
- PreviewService concurrency safeguards.
- Controlled errors and no-store HTTP headers.
- No temporary image files or original DICOM writes.

Important:
- PreviewService currently rebuilds previews per request.
- These images are navigation aids, not diagnostic images.
- True physical-aspect-ratio reslicing is implemented later.
- HTTP authentication alone is not permission to publicly
  deploy identifiable medical images.

Python 3.10+
FastAPI, NumPy, Pydantic v2
"""

from __future__ import annotations

import re
import struct
import zlib
from typing import Annotated, Any

import numpy as np

from fastapi import (
    APIRouter,
    Depends,
    HTTPException,
    Path,
    Query,
    Response,
    status,
)

from ..dependencies import require_preview_service
from ..schemas import (
    PreviewDescriptor,
    PreviewImageSchema,
    PreviewResponse,
)
from ...security.session import (
    AuthenticatedContext,
    require_authenticated_context,
)
from ...services.preview_service import (
    MAX_PREVIEW_DIMENSION,
    MAX_SAMPLED_SLICES,
    DEFAULT_MAX_SAMPLED_SLICES,
    DEFAULT_PREVIEW_DIMENSION,
    PreviewErrorCode,
    PreviewImage,
    PreviewPackage,
    PreviewPlane,
    PreviewService,
    PreviewServiceError,
    get_preview_capabilities,
)


# ============================================================
# 01 — ROUTER AND CONSTANTS
# ============================================================

router = APIRouter(
    prefix="/api/previews",
    tags=["DICOM Previews"],
)

PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"

PNG_MAX_PIXELS = MAX_PREVIEW_DIMENSION ** 2

HANDLE_PATTERN = re.compile(
    r"^[A-Za-z0-9_-]{1,128}$",
    re.ASCII,
)

PREVIEW_HTTP_HEADERS = {
    "Cache-Control": "no-store, private",
    "Pragma": "no-cache",
    "X-Content-Type-Options": "nosniff",
    "Content-Disposition": "inline",
}


TrustedUser = Annotated[
    AuthenticatedContext,
    Depends(require_authenticated_context),
]

TrustedPreviews = Annotated[
    PreviewService,
    Depends(require_preview_service),
]


# ============================================================
# 02 — CONTROLLED HTTP ERRORS
# ============================================================

def _error(
    status_code: int,
    code: str,
) -> HTTPException:
    """
    Never include source paths, patient identifiers or
    low-level image decoder exception messages.
    """

    return HTTPException(
        status_code=status_code,
        detail={"code": code},
        headers={
            "Cache-Control": "no-store, private",
            "Pragma": "no-cache",
        },
    )


def _translate_preview_error(
    error: PreviewServiceError,
) -> HTTPException:
    code = error.code

    if code == PreviewErrorCode.INVALID_REQUEST:
        return _error(422, "INVALID_REQUEST")

    if code == PreviewErrorCode.SERIES_NOT_FOUND:
        return _error(404, "SERIES_NOT_FOUND")

    if code == PreviewErrorCode.SERIES_INVALID:
        return _error(409, "SERIES_INVALID")

    if code == PreviewErrorCode.SOURCE_CHANGED:
        return _error(409, "SOURCE_CHANGED")

    if code == PreviewErrorCode.CANCELLED:
        return _error(409, "OPERATION_CANCELLED")

    if code == PreviewErrorCode.BUSY:
        return _error(503, "SERVICE_UNAVAILABLE")

    if code == PreviewErrorCode.MEMORY_LIMIT:
        return _error(507, "OUT_OF_MEMORY")

    return _error(422, "DECODER_ERROR")


# ============================================================
# 03 — HANDLE AND PLANE VALIDATION
# ============================================================

def _validate_handle(value: str) -> str:
    if (
        not isinstance(value, str)
        or HANDLE_PATTERN.fullmatch(value) is None
    ):
        raise _error(422, "INVALID_REQUEST")

    return value


def _parse_plane(value: str) -> PreviewPlane:
    try:
        return PreviewPlane(value.lower())

    except (ValueError, AttributeError):
        raise _error(422, "INVALID_REQUEST") from None


# ============================================================
# 04 — STRICT PREVIEW RESPONSE ADAPTERS
# ============================================================

def _image_schema(
    image: PreviewImage,
) -> PreviewImageSchema:
    """
    Explicit field allowlist.

    Raw pixel arrays and source geometry details are
    never serialized into preview metadata JSON.
    """

    pixels = image.pixels

    if (
        not isinstance(pixels, np.ndarray)
        or pixels.ndim != 2
        or pixels.dtype != np.dtype("uint8")
        or pixels.size < 1
        or pixels.size > PNG_MAX_PIXELS
        or tuple(pixels.shape) != image.displayed_shape_yx
        or pixels.flags.writeable
    ):
        raise _error(409, "PROCESSING_FAILED")

    return PreviewImageSchema(
        plane=image.plane.value,
        shape_yx=tuple(int(n) for n in pixels.shape),
        dtype="uint8",
        byte_size=int(pixels.nbytes),
        sampled_slice_count=int(image.sampled_slice_count),
        representative_slice_index=int(
            image.representative_slice_index
        ),
        window_low=float(image.window_low),
        window_high=float(image.window_high),
        diagnostic_quality=False,
    )


def _package_schema(
    package: PreviewPackage,
) -> PreviewDescriptor:
    return PreviewDescriptor(
        axial=_image_schema(package.axial),
        coronal=_image_schema(package.coronal),
        sagittal=_image_schema(package.sagittal),
        diagnostic_quality=False,
    )


# ============================================================
# 05 — STANDARD PNG CHUNK
# ============================================================

def _png_chunk(
    chunk_type: bytes,
    data: bytes,
) -> bytes:
    """
    Encode one PNG chunk with CRC32.

    All inputs are generated internally, not sourced
    directly from raw DICOM metadata.
    """

    if (
        not isinstance(chunk_type, bytes)
        or len(chunk_type) != 4
        or not isinstance(data, bytes)
    ):
        raise ValueError("Invalid PNG chunk.")

    checksum = zlib.crc32(
        chunk_type + data
    ) & 0xFFFFFFFF

    return (
        struct.pack(">I", len(data))
        + chunk_type
        + data
        + struct.pack(">I", checksum)
    )


# ============================================================
# 06 — LOSSLESS GRAYSCALE PNG ENCODER
# ============================================================

def encode_grayscale_png(
    pixels: np.ndarray,
) -> bytes:
    """
    Encode a 2D uint8 array as a valid PNG grayscale image.

    PNG:
        Color type: 0 = grayscale
        Bit depth: 8
        Filter:     0 = none

    No file is written.

    This function is intentionally limited to small,
    bounded preview arrays, not full DICOM slices.
    """

    if (
        not isinstance(pixels, np.ndarray)
        or pixels.ndim != 2
        or pixels.dtype != np.dtype("uint8")
    ):
        raise ValueError("Expected 2D uint8 pixels.")

    height, width = pixels.shape

    if (
        height < 1
        or width < 1
        or height > MAX_PREVIEW_DIMENSION
        or width > MAX_PREVIEW_DIMENSION
        or pixels.size > PNG_MAX_PIXELS
    ):
        raise ValueError("Preview dimensions out of range.")

    # Create a tightly packed array in RAM only.
    image = np.ascontiguousarray(pixels)

    # PNG requires one filter byte per scanline.
    # Filter 0 means each row stores raw grayscale bytes.
    raw_scanlines = b"".join(
        b"\x00" + image[row].tobytes()
        for row in range(height)
    )

    header = struct.pack(
        ">IIBBBBB",
        width,
        height,
        8,   # Bit depth
        0,   # Grayscale color type
        0,   # Compression method
        0,   # Filter method
        0,   # Interlace method
    )

    compressed = zlib.compress(
        raw_scanlines,
        level=6,
    )

    return (
        PNG_SIGNATURE
        + _png_chunk(b"IHDR", header)
        + _png_chunk(b"IDAT", compressed)
        + _png_chunk(b"IEND", b"")
    )


# ============================================================
# 07 — AUTHORIZED PREVIEW BUILDER
# ============================================================

def _build_authorized_package(
    dataset_session_id: str,
    series_handle: str,
    owner_id: str,
    previews: PreviewService,
    *,
    max_dimension: int,
    max_sampled_slices: int,
) -> PreviewPackage:
    """
    Perform authorized preview preparation.

    All owner checks are delegated to DatasetService
    through PreviewService.
    """

    _validate_handle(dataset_session_id)
    _validate_handle(series_handle)

    try:
        return previews.build_preview(
            dataset_session_id,
            series_handle,
            owner_id=owner_id,
            max_dimension=max_dimension,
            max_sampled_slices=max_sampled_slices,
        )

    except PreviewServiceError as error:
        raise _translate_preview_error(error) from None


# ============================================================
# 08 — GET STATIC CAPABILITIES
# ============================================================

@router.get(
    "/capabilities",
    status_code=status.HTTP_200_OK,
)
def preview_capabilities(
    auth: TrustedUser,
) -> dict[str, Any]:
    """
    Non-sensitive feature declaration.

    Authentication remains required for consistency with
    the protected API route policy.
    """

    return get_preview_capabilities()


# ============================================================
# 09 — GET THREE-PLANE PREVIEW METADATA
# ============================================================

@router.get(
    "/{dataset_session_id}/{series_handle}",
    response_model=PreviewResponse,
    status_code=status.HTTP_200_OK,
)
def get_preview_metadata(
    dataset_session_id: str,
    series_handle: str,
    auth: TrustedUser,
    previews: TrustedPreviews,
    max_dimension: Annotated[
        int,
        Query(ge=1, le=MAX_PREVIEW_DIMENSION),
    ] = DEFAULT_PREVIEW_DIMENSION,
    max_sampled_slices: Annotated[
        int,
        Query(ge=1, le=MAX_SAMPLED_SLICES),
    ] = DEFAULT_MAX_SAMPLED_SLICES,
) -> PreviewResponse:
    """
    Return safe descriptions of axial/coronal/sagittal images.

    This currently builds the previews but does not return
    the actual PNG bytes. The PNG endpoint does that.
    """

    package = _build_authorized_package(
        dataset_session_id,
        series_handle,
        auth.owner_id,
        previews,
        max_dimension=max_dimension,
        max_sampled_slices=max_sampled_slices,
    )

    return PreviewResponse(
        success=True,
        series_handle=series_handle,
        previews=_package_schema(package),
    )


# ============================================================
# 10 — GET ONE PREVIEW PNG
# ============================================================

@router.get(
    "/{dataset_session_id}/{series_handle}/{plane}.png",
    response_class=Response,
    status_code=status.HTTP_200_OK,
    responses={
        200: {
            "content": {
                "image/png": {},
            },
            "description": "Authenticated grayscale preview PNG",
        },
        401: {
            "description": "Authentication required",
        },
        404: {
            "description": "Series not found",
        },
        409: {
            "description": "Series unsuitable for preview",
        },
    },
)
def get_preview_png(
    dataset_session_id: str,
    series_handle: str,
    plane: str,
    auth: TrustedUser,
    previews: TrustedPreviews,
    max_dimension: Annotated[
        int,
        Query(ge=1, le=MAX_PREVIEW_DIMENSION),
    ] = DEFAULT_PREVIEW_DIMENSION,
    max_sampled_slices: Annotated[
        int,
        Query(ge=1, le=MAX_SAMPLED_SLICES),
    ] = DEFAULT_MAX_SAMPLED_SLICES,
) -> Response:
    """
    Return one small lossless grayscale preview.

    No original source image, DICOM tags, filenames or
    patient identifiers are embedded into the PNG.

    The pixel appearance itself may still contain sensitive
    clinical information.
    """

    selected_plane = _parse_plane(plane)

    package = _build_authorized_package(
        dataset_session_id,
        series_handle,
        auth.owner_id,
        previews,
        max_dimension=max_dimension,
        max_sampled_slices=max_sampled_slices,
    )

    image = package.get_plane(selected_plane)

    # Validate output constraints before encoding.
    _image_schema(image)

    try:
        png_bytes = encode_grayscale_png(
            image.pixels
        )

    except (ValueError, MemoryError):
        raise _error(
            500,
            "PROCESSING_FAILED",
        ) from None

    return Response(
        content=png_bytes,
        media_type="image/png",
        status_code=status.HTTP_200_OK,
        headers=dict(PREVIEW_HTTP_HEADERS),
    )


# ============================================================
# 11 — SAFE CAPABILITY SUMMARY
# ============================================================

def get_preview_route_capabilities() -> dict[str, Any]:
    return {
        "metadata_endpoint": True,
        "png_endpoint": True,
        "planes": [
            "axial",
            "coronal",
            "sagittal",
        ],
        "encoding": "png_grayscale_8bit",
        "lossless_png": True,
        "image_data_in_json": False,
        "authentication_required": True,
        "owner_authorization": True,
        "maximum_dimension": MAX_PREVIEW_DIMENSION,
        "preview_diagnostic_quality": False,
        "read_only_dataset": True,
        "temporary_files": False,
    }


# ============================================================
# END OF AUTHENTICATED PREVIEW API ROUTES
# ============================================================
