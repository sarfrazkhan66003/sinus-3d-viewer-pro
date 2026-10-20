
"""
SINUS VIEWER — AUTHENTICATED BINARY STREAMING ROUTES
====================================================

Endpoints:
    GET  /api/streaming/{dataset}/{series}/levels/{level}/bytes
    HEAD /api/streaming/{dataset}/{series}/levels/{level}/bytes

Features:
- Server-side cookie session authentication.
- Owner-authorized dataset and volume selection.
- Single HTTP byte-range support.
- HTTP 200, 206 and 416 handling.
- Bounded streaming with a synchronous generator.
- No-cache, nosniff response headers.
- No image pixels encoded as JSON.
- Controlled errors without patient identifiers.
- No filesystem writes.

Data contract:
    Pixel dtype: float32
    Array layout: Z, Y, X
    Byte order: little-endian
    Geometry: obtain separately from Volume API.

Important:
- The underlying VolumeService must verify the declared
  binary encoding before this API is enabled.
- Authentication and authorization must also be applied
  at the reverse proxy and application level.
- A range request does not bypass full-volume RAM loading.
- Streamed patient image pixels remain sensitive data.
- No actual anonymization occurs in this module.

Python 3.10+
FastAPI / Starlette
"""

from __future__ import annotations

import sys
import threading
from typing import Annotated, Iterator

from fastapi import (
    APIRouter,
    Depends,
    Header,
    HTTPException,
    Path,
    Request,
    status,
)
from fastapi.responses import Response, StreamingResponse

from ..dependencies import require_streaming_service
from ...security.session import (
    AuthenticatedContext,
    require_authenticated_context,
)
from ...services.streaming_service import (
    StreamingErrorCode,
    StreamingServiceError,
    StreamPlan,
    VolumeStreamingService,
    build_stream_headers,
    build_unsatisfied_range_headers,
)
from ...services.volume_service import (
    VolumeServiceError,
)


# ============================================================
# 01 — ROUTER AND LIMITS
# ============================================================

router = APIRouter(
    prefix="/api/streaming",
    tags=["Volume Streaming"],
)

MAX_LEVEL = 64

TrustedUser = Annotated[
    AuthenticatedContext,
    Depends(require_authenticated_context),
]

TrustedStreaming = Annotated[
    VolumeStreamingService,
    Depends(require_streaming_service),
]


# ============================================================
# 02 — SAFE ERRORS
# ============================================================

def _error(
    status_code: int,
    code: str,
    *,
    headers: dict[str, str] | None = None,
) -> HTTPException:
    """
    No patient metadata, token, path or raw exception text.
    """

    response_headers = {
        "Cache-Control": "no-store, private",
        "Pragma": "no-cache",
        "X-Content-Type-Options": "nosniff",
    }

    if headers:
        response_headers.update(headers)

    return HTTPException(
        status_code=status_code,
        detail={"code": code},
        headers=response_headers,
    )


def _translate_streaming_error(
    error: StreamingServiceError,
    *,
    total_bytes: int | None = None,
) -> HTTPException:
    """
    Convert controlled errors to HTTP status codes.

    For an unsatisfiable range, include Content-Range
    only when the authorized resource size is known.
    """

    code = error.code

    if code == StreamingErrorCode.INVALID_RANGE:
        return _error(400, "INVALID_REQUEST")

    if code == StreamingErrorCode.RANGE_NOT_SATISFIABLE:
        range_headers = (
            build_unsatisfied_range_headers(total_bytes)
            if total_bytes is not None
            else None
        )

        return _error(
            416,
            "RANGE_NOT_SATISFIABLE",
            headers=range_headers,
        )

    if code == StreamingErrorCode.VOLUME_NOT_FOUND:
        return _error(404, "SERIES_NOT_FOUND")

    if code == StreamingErrorCode.STREAM_CANCELLED:
        return _error(409, "OPERATION_CANCELLED")

    if code == StreamingErrorCode.SERVICE_CLOSED:
        return _error(503, "SERVICE_UNAVAILABLE")

    return _error(500, "PROCESSING_FAILED")


# ============================================================
# 03 — INPUT VALIDATION
# ============================================================

def _validate_public_handle(value: str) -> str:
    if (
        not isinstance(value, str)
        or not 1 <= len(value) <= 128
        or not all(
            char.isascii()
            and (
                char.isalnum()
                or char in "_-"
            )
            for char in value
        )
    ):
        raise _error(422, "INVALID_REQUEST")

    return value


def _require_binary_compatibility() -> None:
    """
    Float32 volume bytes must match our advertised format.

    The current volume reader produces native float32 data.
    This API is restricted to little-endian platforms.
    """

    if sys.byteorder != "little":
        raise _error(503, "SERVICE_UNAVAILABLE")


# ============================================================
# 04 — STREAM PLAN PREPARATION
# ============================================================

def _prepare_authorized_plan(
    dataset_session_id: str,
    series_handle: str,
    level: int,
    range_header: str | None,
    owner_id: str,
    streaming: VolumeStreamingService,
) -> StreamPlan:
    """
    Validate inputs and authorize volume before headers
    or medical pixel data are sent.
    """

    _require_binary_compatibility()

    _validate_public_handle(dataset_session_id)
    _validate_public_handle(series_handle)

    if not 0 <= level <= MAX_LEVEL:
        raise _error(422, "INVALID_REQUEST")

    try:
        return streaming.prepare_stream(
            dataset_session_id,
            series_handle,
            owner_id=owner_id,
            level=level,
            range_header=range_header,
        )

    except StreamingServiceError as error:
        if (
            error.code
            == StreamingErrorCode.RANGE_NOT_SATISFIABLE
        ):
            # Only retrieve the authorized resource size to
            # provide an RFC-compatible HTTP 416 response.
            #
            # The first prepare_stream call already performed
            # authorization. Reauthorize here to avoid
            # exposing a resource's size after session change.
            try:
                volume = streaming._volumes.get_level(
                    dataset_session_id,
                    series_handle,
                    owner_id=owner_id,
                    level=level,
                )
                total_bytes = int(volume.byte_size)
            except (VolumeServiceError, AttributeError):
                total_bytes = None

            raise _translate_streaming_error(
                error,
                total_bytes=total_bytes,
            ) from None

        raise _translate_streaming_error(error) from None


# ============================================================
# 05 — STREAM GENERATOR
# ============================================================

def _stream_authorized_chunks(
    plan: StreamPlan,
    streaming: VolumeStreamingService,
    owner_id: str,
    cancel_event: threading.Event,
) -> Iterator[bytes]:
    """
    Yield bounded pixel chunks.

    When a StreamingResponse is cancelled or its generator
    is closed, cleanup requests cancellation.

    Starlette handles a synchronous iterator through its
    thread-pool adapter. Disconnect behavior depends on
    ASGI server and Starlette runtime versions.

    No original DICOM file is opened by this function.
    """

    iterator = streaming.iter_volume_bytes(
        plan,
        owner_id=owner_id,
        cancel_event=cancel_event,
    )

    try:
        for chunk in iterator:
            if cancel_event.is_set():
                return

            yield chunk

    finally:
        cancel_event.set()

        close_iterator = getattr(
            iterator,
            "close",
            None,
        )

        if callable(close_iterator):
            close_iterator()


# ============================================================
# 06 — GET BINARY VOLUME CONTENT
# ============================================================

@router.get(
    "/{dataset_session_id}/{series_handle}"
    "/levels/{level}/bytes",
    response_class=StreamingResponse,
    responses={
        200: {
            "description": "Complete bounded volume level",
        },
        206: {
            "description": "Single partial byte range",
        },
        400: {
            "description": "Malformed byte range",
        },
        401: {
            "description": "Authentication required",
        },
        416: {
            "description": "Unsatisfiable byte range",
        },
    },
)
def get_volume_binary(
    request: Request,
    dataset_session_id: str,
    series_handle: str,
    level: Annotated[int, Path(ge=0, le=MAX_LEVEL)],
    auth: TrustedUser,
    streaming: TrustedStreaming,
    range_header: Annotated[
        str | None,
        Header(alias="Range"),
    ] = None,
) -> StreamingResponse:
    """
    Stream authorized binary volume bytes.

    Example Range header:
        Range: bytes=0-1048575

    Volume arrays are not included in JSON responses.
    """

    plan = _prepare_authorized_plan(
        dataset_session_id,
        series_handle,
        level,
        range_header,
        auth.owner_id,
        streaming,
    )

    headers = build_stream_headers(plan)

    cancel_event = threading.Event()

    generator = _stream_authorized_chunks(
        plan,
        streaming,
        auth.owner_id,
        cancel_event,
    )

    # Avoid leaking request URL, Range value or series IDs
    # through response headers.
    return StreamingResponse(
        content=generator,
        status_code=plan.status_code,
        headers=headers,
        media_type="application/octet-stream",
    )


# ============================================================
# 07 — HEAD BINARY VOLUME CONTENT
# ============================================================

@router.head(
    "/{dataset_session_id}/{series_handle}"
    "/levels/{level}/bytes",
    status_code=status.HTTP_200_OK,
    include_in_schema=True,
)
def head_volume_binary(
    dataset_session_id: str,
    series_handle: str,
    level: Annotated[int, Path(ge=0, le=MAX_LEVEL)],
    auth: TrustedUser,
    streaming: TrustedStreaming,
    range_header: Annotated[
        str | None,
        Header(alias="Range"),
    ] = None,
) -> Response:
    """
    Return volume byte-range headers without image pixels.

    HEAD may still cause the underlying full volume to load
    into backend memory if it is not already cached.
    """

    plan = _prepare_authorized_plan(
        dataset_session_id,
        series_handle,
        level,
        range_header,
        auth.owner_id,
        streaming,
    )

    return Response(
        content=b"",
        status_code=plan.status_code,
        headers=build_stream_headers(plan),
        media_type="application/octet-stream",
    )


# ============================================================
# 08 — SAFE CAPABILITY DECLARATION
# ============================================================

def get_streaming_route_capabilities() -> dict:
    return {
        "get_binary": True,
        "head_binary": True,
        "http_200": True,
        "http_206": True,
        "http_416": True,
        "single_byte_ranges": True,
        "multi_ranges": False,
        "bounded_response": True,
        "authentication_required": True,
        "owner_authorization": True,
        "pixel_encoding": "float32",
        "axis_order": "zyx",
        "byte_order": "little",
        "full_volume_load_required": True,
        "original_dataset_read_only": True,
    }


# ============================================================
# END OF BINARY STREAMING API ROUTES
# ============================================================
