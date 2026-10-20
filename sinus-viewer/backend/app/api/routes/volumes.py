
"""
SINUS VIEWER — AUTHENTICATED VOLUME API ROUTES
==============================================

Routes:
    POST   /api/volumes/{dataset}/{series}/load
    GET    /api/volumes/{dataset}/{series}
    GET    /api/volumes/{dataset}/{series}/levels/{level}
    DELETE /api/volumes/{dataset}/{series}/cache

Responsibilities:
- Resolve server-authenticated owner identity.
- Authorize selected dataset and DICOM series.
- Load validated DICOM volume through VolumeService.
- Reuse the process-local volume cache.
- Expose strict, privacy-safe Pydantic descriptors.
- Preserve LPS geometry and Z,Y,X array ordering.
- Reject invalid levels and unsupported pixel layouts.
- Invalidate the selected series cache on request.

Security:
- Never trust owner IDs received from the browser.
- Never return raw patient data, file paths or DICOM UIDs.
- Never serialize internal ScanSeries or pydicom Dataset.
- Volume voxel data is NOT returned by these routes.
- No source filesystem writes are performed.

Note:
    All handlers are synchronous. FastAPI runs synchronous
    endpoints in its worker pool. Building a full volume
    may be expensive; VolumeService limits concurrency.

Python 3.10+ / FastAPI / Pydantic v2
"""

from __future__ import annotations

import math
from typing import Annotated, Any

import numpy as np

from fastapi import (
    APIRouter,
    Depends,
    HTTPException,
    Path,
    status,
)

from ..dependencies import require_volume_service
from ..schemas import (
    VolumeDescriptor,
    VolumeGeometrySchema,
    VolumeLevelSchema,
    VolumeResponse,
)
from ...dicom.volume_builder import (
    PreparedVolume,
    VolumePackage,
)
from ...security.session import (
    AuthenticatedContext,
    require_authenticated_context,
)
from ...services.volume_service import (
    VolumeInvalidRange,
    VolumeLoadFailed,
    VolumeMemoryExceeded,
    VolumeNotFound,
    VolumeNotReady,
    VolumeService,
    VolumeServiceBusy,
    VolumeServiceClosed,
    VolumeServiceError,
    VolumeSourceChanged,
)


# ============================================================
# 01 — ROUTER
# ============================================================

router = APIRouter(
    prefix="/api/volumes",
    tags=["Volumes"],
)


# ============================================================
# 02 — DEPENDENCY ALIASES
# ============================================================

TrustedUser = Annotated[
    AuthenticatedContext,
    Depends(require_authenticated_context),
]

TrustedVolumes = Annotated[
    VolumeService,
    Depends(require_volume_service),
]


# ============================================================
# 03 — SAFE HTTP ERROR TRANSLATION
# ============================================================

def _api_error(
    status_code: int,
    code: str,
) -> HTTPException:
    """
    Return generic, allowlisted error identifiers.

    Do not expose internal exception text, source paths
    or DICOM patient identifiers.
    """

    return HTTPException(
        status_code=status_code,
        detail={"code": code},
        headers={
            "Cache-Control": "no-store",
            "Pragma": "no-cache",
        },
    )


def _translate_volume_error(
    error: VolumeServiceError,
) -> HTTPException:
    """
    Map known volume errors into safe HTTP responses.

    Never serialize error.args or underlying file errors.
    """

    if isinstance(error, VolumeInvalidRange):
        return _api_error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "INVALID_REQUEST",
        )

    if isinstance(error, VolumeNotFound):
        return _api_error(
            status.HTTP_404_NOT_FOUND,
            "SERIES_NOT_FOUND",
        )

    if isinstance(error, VolumeNotReady):
        return _api_error(
            status.HTTP_409_CONFLICT,
            "SERIES_INVALID",
        )

    if isinstance(error, VolumeSourceChanged):
        return _api_error(
            status.HTTP_409_CONFLICT,
            "SOURCE_CHANGED",
        )

    if isinstance(error, VolumeMemoryExceeded):
        return _api_error(
            status.HTTP_507_INSUFFICIENT_STORAGE,
            "OUT_OF_MEMORY",
        )

    if isinstance(
        error,
        (VolumeServiceBusy, VolumeServiceClosed),
    ):
        return _api_error(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "SERVICE_UNAVAILABLE",
        )

    if isinstance(error, VolumeLoadFailed):
        return _api_error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "PROCESSING_FAILED",
        )

    return _api_error(
        status.HTTP_500_INTERNAL_SERVER_ERROR,
        "PROCESSING_FAILED",
    )


# ============================================================
# 04 — HANDLE AND LEVEL VALIDATION
# ============================================================

def _validate_handle(value: str) -> str:
    """
    Enforce the public handle format before service access.

    Actual authorization remains the service's job.
    """

    if (
        not isinstance(value, str)
        or not (1 <= len(value) <= 128)
        or not all(
            char.isascii()
            and (char.isalnum() or char in "_-")
            for char in value
        )
    ):
        raise _api_error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "INVALID_REQUEST",
        )

    return value


def _validate_level(level: int) -> int:
    if (
        not isinstance(level, int)
        or isinstance(level, bool)
        or not (0 <= level <= 64)
    ):
        raise _api_error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "INVALID_REQUEST",
        )

    return level


# ============================================================
# 05 — GEOMETRY RESPONSE ADAPTER
# ============================================================

def _geometry_schema(
    volume: PreparedVolume,
) -> VolumeGeometrySchema:
    """
    Copy only approved spatial geometry fields.

    Direction is a row-major 3x3 matrix.

    This adapter deliberately does not expose scanner
    metadata, DICOM UIDs or original filesystem paths.
    """

    geometry = volume.geometry

    shape = tuple(
        int(value)
        for value in geometry.shape_zyx
    )

    spacing = tuple(
        float(value)
        for value in geometry.spacing_xyz_mm
    )

    origin = tuple(
        float(value)
        for value in geometry.origin_lps
    )

    direction = tuple(
        float(value)
        for value in geometry.direction_lps
    )

    return VolumeGeometrySchema(
        shape_zyx=shape,
        spacing_xyz_mm=spacing,
        origin_lps=origin,
        direction_lps=direction,
        coordinate_system="LPS",
    )


# ============================================================
# 06 — VOLUME LEVEL RESPONSE ADAPTER
# ============================================================

def _level_schema(
    volume: PreparedVolume,
) -> VolumeLevelSchema:
    """
    Convert a prepared level to a strict public descriptor.

    Check encoding assumptions before claiming the binary
    streaming format is little-endian float32.
    """

    pixels = volume.voxels

    if (
        not isinstance(pixels, np.ndarray)
        or pixels.ndim != 3
        or pixels.dtype.kind != "f"
        or pixels.dtype.itemsize != 4
        or pixels.dtype.byteorder not in ("<", "=", "|")
    ):
        raise _api_error(
            status.HTTP_409_CONFLICT,
            "SERIES_INVALID",
        )

    if not np.little_endian:
        raise _api_error(
            status.HTTP_409_CONFLICT,
            "SERIES_INVALID",
        )

    if (
        not pixels.flags.c_contiguous
        or pixels.flags.writeable
    ):
        raise _api_error(
            status.HTTP_409_CONFLICT,
            "SERIES_INVALID",
        )

    shape = tuple(
        int(value)
        for value in pixels.shape
    )

    expected_bytes = math.prod(shape) * 4

    if expected_bytes != int(pixels.nbytes):
        raise _api_error(
            status.HTTP_409_CONFLICT,
            "SERIES_INVALID",
        )

    return VolumeLevelSchema(
        level=int(volume.level),
        is_preview=bool(volume.is_preview),
        shape_zyx=shape,
        byte_size=int(pixels.nbytes),
        dtype="float32",
        axis_order="zyx",
        byte_order="little",
        geometry=_geometry_schema(volume),
    )


# ============================================================
# 07 — VOLUME PACKAGE RESPONSE ADAPTER
# ============================================================

def _volume_descriptor(
    package: VolumePackage,
) -> VolumeDescriptor:
    """
    Construct public metadata from validated volume levels.

    The internal package's other fields remain private.
    """

    if not isinstance(package, VolumePackage):
        raise _api_error(
            status.HTTP_500_INTERNAL_SERVER_ERROR,
            "PROCESSING_FAILED",
        )

    levels = [
        _level_schema(item)
        for item in package.all_levels()
    ]

    return VolumeDescriptor(
        format="sinus-viewer-volume-v1",
        coordinate_system="LPS",
        levels=levels,
    )


def _volume_response(
    series_handle: str,
    package: VolumePackage,
) -> VolumeResponse:
    return VolumeResponse(
        success=True,
        series_handle=series_handle,
        volume=_volume_descriptor(package),
    )


# ============================================================
# 08 — POST: LOAD VOLUME
# ============================================================

@router.post(
    "/{dataset_session_id}/{series_handle}/load",
    response_model=VolumeResponse,
    status_code=status.HTTP_200_OK,
)
def load_selected_volume(
    dataset_session_id: str,
    series_handle: str,
    auth: TrustedUser,
    volumes: TrustedVolumes,
) -> VolumeResponse:
    """
    Load or reuse an authorized medical imaging volume.

    Returns geometry and available levels, not pixel data.

    The same cache key may be reused by concurrent
    authenticated requests through VolumeCacheService.
    """

    dataset_session_id = _validate_handle(
        dataset_session_id
    )

    series_handle = _validate_handle(
        series_handle
    )

    try:
        package = volumes.load_volume(
            dataset_session_id,
            series_handle,
            owner_id=auth.owner_id,
        )

        return _volume_response(
            series_handle,
            package,
        )

    except VolumeServiceError as error:
        raise _translate_volume_error(error) from None


# ============================================================
# 09 — GET: VOLUME DESCRIPTOR
# ============================================================

@router.get(
    "/{dataset_session_id}/{series_handle}",
    response_model=VolumeResponse,
    status_code=status.HTTP_200_OK,
)
def get_volume_descriptor(
    dataset_session_id: str,
    series_handle: str,
    auth: TrustedUser,
    volumes: TrustedVolumes,
) -> VolumeResponse:
    """
    Return technical information for a selected series.

    If no cached volume exists, this request may trigger
    full-volume loading through VolumeService.

    Frontend should explicitly initiate load before
    requesting large-volume metadata when possible.
    """

    dataset_session_id = _validate_handle(
        dataset_session_id
    )

    series_handle = _validate_handle(
        series_handle
    )

    try:
        package = volumes.load_volume(
            dataset_session_id,
            series_handle,
            owner_id=auth.owner_id,
        )

        return _volume_response(
            series_handle,
            package,
        )

    except VolumeServiceError as error:
        raise _translate_volume_error(error) from None


# ============================================================
# 10 — GET: ONE VOLUME LEVEL
# ============================================================

@router.get(
    "/{dataset_session_id}/{series_handle}/levels/{level}",
    response_model=VolumeLevelSchema,
    status_code=status.HTTP_200_OK,
)
def get_volume_level_descriptor(
    dataset_session_id: str,
    series_handle: str,
    level: Annotated[int, Path(ge=0, le=64)],
    auth: TrustedUser,
    volumes: TrustedVolumes,
) -> VolumeLevelSchema:
    """
    Describe one volume level.

    Level 0: Full resolution.
    Level 1+: Available downsampled previews.

    Invalid/unavailable levels return controlled errors.
    """

    dataset_session_id = _validate_handle(
        dataset_session_id
    )

    series_handle = _validate_handle(
        series_handle
    )

    level = _validate_level(level)

    try:
        selected = volumes.get_level(
            dataset_session_id,
            series_handle,
            owner_id=auth.owner_id,
            level=level,
        )

        return _level_schema(selected)

    except VolumeServiceError as error:
        raise _translate_volume_error(error) from None


# ============================================================
# 11 — DELETE: INVALIDATE SELECTED VOLUME
# ============================================================

@router.delete(
    "/{dataset_session_id}/{series_handle}/cache",
    status_code=status.HTTP_200_OK,
)
def invalidate_selected_volume(
    dataset_session_id: str,
    series_handle: str,
    auth: TrustedUser,
    volumes: TrustedVolumes,
) -> dict[str, bool]:
    """
    Evict the selected authorized volume cache entry.

    Does not close the dataset session or modify any
    original DICOM file.

    Cached arrays may remain in RAM while referenced
    by active request handlers.
    """

    dataset_session_id = _validate_handle(
        dataset_session_id
    )

    series_handle = _validate_handle(
        series_handle
    )

    try:
        invalidated = volumes.invalidate_series(
            dataset_session_id,
            series_handle,
            owner_id=auth.owner_id,
        )

        return {
            "success": True,
            "invalidated": bool(invalidated),
        }

    except VolumeServiceError as error:
        raise _translate_volume_error(error) from None


# ============================================================
# 12 — SAFE ROUTE CAPABILITIES
# ============================================================

def get_volume_route_capabilities() -> dict[str, Any]:
    """
    Static route capability summary without patient data.
    """

    return {
        "volume_loading": True,
        "volume_descriptors": True,
        "per_level_descriptors": True,
        "selected_cache_invalidation": True,
        "authentication_required": True,
        "owner_authorization": True,
        "coordinate_system": "LPS",
        "axis_order": "zyx",
        "pixel_encoding": "float32",
        "pixel_byte_order": "little",
        "pixel_data_in_json": False,
        "binary_streaming_in_this_module": False,
        "original_dataset_read_only": True,
    }


# ============================================================
# END OF VOLUME API ROUTES
# ============================================================
