
"""
SINUS VIEWER — SECURE VOLUME STREAMING SERVICE
===============================================

Purpose:
- Plan bounded byte-range requests for 3D volumes.
- Support HTTP single-range byte syntax.
- Stream binary volume data in controlled chunks.
- Recheck series authorization while yielding chunks.
- Support cancellation and clean shutdown.
- Create safe HTTP response headers.
- Avoid copying the entire volume into one response.

Conventions:
    Volume dtype:       float32
    Array order:        Z, Y, X
    Byte order:         little-endian (verified by API layer)
    Range offsets:      byte offsets, not voxel offsets

Security:
- Owner identity must come from trusted authentication.
- Dataset session and series handles are not credentials.
- Every streamed chunk is obtained through VolumeService.
- Do not log Range headers, patient IDs or file paths.
- No raw exception messages are returned.
- Response caching is disabled.
- No original DICOM file is written or modified.

Limitations:
- VolumeService loads/caches a volume before streaming.
- This is not direct disk-to-browser DICOM streaming.
- One HTTP response cannot exceed its configured limit.
- This module prepares streams; FastAPI routes come later.

Python 3.10+
"""

from __future__ import annotations

import re
import threading
from dataclasses import dataclass
from enum import Enum
from typing import Any, Iterator

from ..core.config import AppSettings, get_settings
from .volume_service import (
    VolumeService,
    VolumeServiceError,
)


# ============================================================
# 01 — CONSTANTS
# ============================================================

MIB = 1024 ** 2

DEFAULT_CHUNK_SIZE_KB = 1024
DEFAULT_MAX_RESPONSE_MB = 64
DEFAULT_MAX_CHUNK_MB = 4

MAX_RANGE_HEADER_LENGTH = 128

RANGE_PATTERN = re.compile(
    r"^bytes=(\d*)-(\d*)$",
    re.ASCII,
)

BINARY_MEDIA_TYPE = "application/octet-stream"

VOLUME_FORMAT = "sinus-viewer-f32-zyx-v1"


# ============================================================
# 02 — ERROR CODES
# ============================================================

class StreamingErrorCode(str, Enum):
    INVALID_RANGE = "INVALID_REQUEST"
    RANGE_NOT_SATISFIABLE = "RANGE_NOT_SATISFIABLE"
    VOLUME_NOT_FOUND = "SERIES_NOT_FOUND"
    STREAM_CANCELLED = "OPERATION_CANCELLED"
    SERVICE_CLOSED = "SERVICE_UNAVAILABLE"
    STREAM_FAILED = "PROCESSING_FAILED"


class StreamingServiceError(RuntimeError):
    """
    Controlled streaming failure.

    Does not include patient-derived information.
    """

    def __init__(self, code: StreamingErrorCode) -> None:
        self.code = code
        super().__init__(code.value)


# ============================================================
# 03 — RANGE AND STREAM MODELS
# ============================================================

@dataclass(frozen=True)
class ByteRange:
    """
    Inclusive start/end byte positions.

    Example:
        start=0, end=1023 -> length=1024
    """

    start: int
    end: int
    total_bytes: int

    def __post_init__(self) -> None:
        if (
            self.total_bytes < 1
            or self.start < 0
            or self.end < self.start
            or self.end >= self.total_bytes
        ):
            raise StreamingServiceError(
                StreamingErrorCode.RANGE_NOT_SATISFIABLE
            )

    @property
    def length(self) -> int:
        return self.end - self.start + 1

    @property
    def content_range(self) -> str:
        return (
            f"bytes {self.start}-{self.end}/"
            f"{self.total_bytes}"
        )


@dataclass(frozen=True)
class StreamPlan:
    dataset_session_id: str
    series_handle: str
    level: int

    byte_range: ByteRange
    chunk_size_bytes: int
    status_code: int
    is_partial: bool

    def safe_summary(self) -> dict[str, Any]:
        """
        Excludes internal handles and patient identifiers.
        """

        return {
            "level": self.level,
            "content_length": self.byte_range.length,
            "total_bytes": self.byte_range.total_bytes,
            "chunk_size_bytes": self.chunk_size_bytes,
            "status_code": self.status_code,
            "is_partial": self.is_partial,
        }


@dataclass(frozen=True)
class StreamStatistics:
    plans_created: int
    streams_started: int
    streams_completed: int
    streams_failed: int
    chunks_delivered: int
    bytes_delivered: int
    active_streams: int
    closed: bool

    def safe_summary(self) -> dict[str, Any]:
        return {
            "plans_created": self.plans_created,
            "streams_started": self.streams_started,
            "streams_completed": self.streams_completed,
            "streams_failed": self.streams_failed,
            "chunks_delivered": self.chunks_delivered,
            "bytes_delivered": self.bytes_delivered,
            "active_streams": self.active_streams,
            "closed": self.closed,
        }


# ============================================================
# 04 — HTTP RANGE PARSING
# ============================================================

def parse_byte_range(
    range_header: str | None,
    total_bytes: int,
    *,
    max_response_bytes: int,
) -> tuple[ByteRange, bool]:
    """
    Parse one HTTP bytes range.

    Supported:
        bytes=0-1023
        bytes=1024-
        bytes=-4096

    Unsupported:
        Multi-range requests
        Non-byte range units
        Malformed ranges

    A missing Range header returns the full response only
    when its size fits within max_response_bytes.
    Otherwise the caller must request a bounded range.

    No raw Range header is included in errors or logs.
    """

    if (
        not isinstance(total_bytes, int)
        or isinstance(total_bytes, bool)
        or total_bytes <= 0
        or not isinstance(max_response_bytes, int)
        or isinstance(max_response_bytes, bool)
        or max_response_bytes <= 0
    ):
        raise StreamingServiceError(
            StreamingErrorCode.INVALID_RANGE
        )

    if range_header is None:
        if total_bytes > max_response_bytes:
            raise StreamingServiceError(
                StreamingErrorCode.RANGE_NOT_SATISFIABLE
            )

        return (
            ByteRange(
                start=0,
                end=total_bytes - 1,
                total_bytes=total_bytes,
            ),
            False,
        )

    if (
        not isinstance(range_header, str)
        or len(range_header) > MAX_RANGE_HEADER_LENGTH
    ):
        raise StreamingServiceError(
            StreamingErrorCode.INVALID_RANGE
        )

    match = RANGE_PATTERN.fullmatch(
        range_header.strip()
    )

    if match is None:
        raise StreamingServiceError(
            StreamingErrorCode.INVALID_RANGE
        )

    start_text, end_text = match.groups()

    if not start_text and not end_text:
        raise StreamingServiceError(
            StreamingErrorCode.INVALID_RANGE
        )

    if start_text:
        start = int(start_text)

        if start >= total_bytes:
            raise StreamingServiceError(
                StreamingErrorCode.RANGE_NOT_SATISFIABLE
            )

        if end_text:
            requested_end = int(end_text)

            if requested_end < start:
                raise StreamingServiceError(
                    StreamingErrorCode.RANGE_NOT_SATISFIABLE
                )

            end = min(
                requested_end,
                total_bytes - 1,
            )

        else:
            end = total_bytes - 1

    else:
        # Suffix range: bytes=-N
        suffix_length = int(end_text)

        if suffix_length == 0:
            raise StreamingServiceError(
                StreamingErrorCode.RANGE_NOT_SATISFIABLE
            )

        start = max(
            0,
            total_bytes - suffix_length,
        )

        end = total_bytes - 1

    selected = ByteRange(
        start=start,
        end=end,
        total_bytes=total_bytes,
    )

    if selected.length > max_response_bytes:
        raise StreamingServiceError(
            StreamingErrorCode.RANGE_NOT_SATISFIABLE
        )

    return selected, True


# ============================================================
# 05 — CHUNK ITERATION PLAN
# ============================================================

def iter_chunk_ranges(
    selected: ByteRange,
    chunk_size_bytes: int,
) -> Iterator[tuple[int, int]]:
    """
    Yield (offset, length) for bounded chunk retrieval.

    Does not allocate or read any pixel bytes.
    """

    if (
        not isinstance(chunk_size_bytes, int)
        or isinstance(chunk_size_bytes, bool)
        or chunk_size_bytes < 1
    ):
        raise StreamingServiceError(
            StreamingErrorCode.INVALID_RANGE
        )

    position = selected.start
    last_exclusive = selected.end + 1

    while position < last_exclusive:
        length = min(
            chunk_size_bytes,
            last_exclusive - position,
        )

        yield position, length

        position += length


# ============================================================
# 06 — SAFE HTTP HEADERS
# ============================================================

def build_stream_headers(
    plan: StreamPlan,
) -> dict[str, str]:
    """
    HTTP headers for the eventual authenticated API.

    The API must use these with the same selected byte range
    and response status code.

    Content-Encoding must remain identity for these raw
    byte offsets to be meaningful.
    """

    headers = {
        "Content-Type": BINARY_MEDIA_TYPE,
        "Content-Length": str(
            plan.byte_range.length
        ),
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store, private",
        "Pragma": "no-cache",
        "X-Content-Type-Options": "nosniff",
        "Content-Disposition": "inline",
        "Content-Encoding": "identity",
        "X-Volume-Format": VOLUME_FORMAT,
    }

    if plan.is_partial:
        headers["Content-Range"] = (
            plan.byte_range.content_range
        )

    return headers


def build_unsatisfied_range_headers(
    total_bytes: int,
) -> dict[str, str]:
    """
    Optional headers for HTTP 416.

    The API controls when these may be returned.
    """

    if total_bytes < 0:
        raise StreamingServiceError(
            StreamingErrorCode.INVALID_RANGE
        )

    return {
        "Content-Range": f"bytes */{total_bytes}",
        "Cache-Control": "no-store, private",
        "X-Content-Type-Options": "nosniff",
    }


# ============================================================
# 07 — STREAMING SERVICE
# ============================================================

class VolumeStreamingService:
    """
    Process-local bounded volume streamer.

    The underlying VolumeService performs owner/session
    authorization on every read_volume_bytes() call.

    This class does not create HTTP responses directly.
    """

    def __init__(
        self,
        volume_service: VolumeService,
        settings: AppSettings | None = None,
        *,
        max_response_mb: int = DEFAULT_MAX_RESPONSE_MB,
        max_chunk_mb: int = DEFAULT_MAX_CHUNK_MB,
    ) -> None:
        if not isinstance(volume_service, VolumeService):
            raise TypeError(
                "VolumeService instance is required."
            )

        if (
            not isinstance(max_response_mb, int)
            or isinstance(max_response_mb, bool)
            or max_response_mb < 1
            or not isinstance(max_chunk_mb, int)
            or isinstance(max_chunk_mb, bool)
            or max_chunk_mb < 1
        ):
            raise ValueError(
                "Invalid streaming limits."
            )

        self._volumes = volume_service

        self._settings = (
            settings if settings is not None
            else get_settings()
        )

        configured_kb = (
            self._settings.performance.streaming.chunk_size_kb
        )

        self._chunk_bytes = min(
            max(1, int(configured_kb) * 1024),
            max_chunk_mb * MIB,
        )

        self._max_response_bytes = max_response_mb * MIB
        self._max_chunk_mb = max_chunk_mb

        self._lock = threading.RLock()
        self._closed = False

        self._plans_created = 0
        self._streams_started = 0
        self._streams_completed = 0
        self._streams_failed = 0
        self._chunks_delivered = 0
        self._bytes_delivered = 0
        self._active_streams = 0

    # --------------------------------------------------------
    # SERVICE STATE
    # --------------------------------------------------------

    def _require_open(self) -> None:
        if self._closed:
            raise StreamingServiceError(
                StreamingErrorCode.SERVICE_CLOSED
            )

    # --------------------------------------------------------
    # PREPARE STREAM
    # --------------------------------------------------------

    def prepare_stream(
        self,
        dataset_session_id: str,
        series_handle: str,
        *,
        owner_id: str,
        level: int = 0,
        range_header: str | None = None,
    ) -> StreamPlan:
        """
        Verify selected level and prepare an HTTP byte range.

        The trusted owner_id must come from authenticated
        server-side request context.

        Full-volume loading may occur at this step.
        """

        with self._lock:
            self._require_open()

        if (
            not isinstance(level, int)
            or isinstance(level, bool)
            or level < 0
        ):
            raise StreamingServiceError(
                StreamingErrorCode.INVALID_RANGE
            )

        try:
            volume = self._volumes.get_level(
                dataset_session_id,
                series_handle,
                owner_id=owner_id,
                level=level,
            )

        except VolumeServiceError:
            raise StreamingServiceError(
                StreamingErrorCode.VOLUME_NOT_FOUND
            ) from None

        total_bytes = volume.byte_size

        selected, is_partial = parse_byte_range(
            range_header,
            total_bytes,
            max_response_bytes=self._max_response_bytes,
        )

        with self._lock:
            self._require_open()
            self._plans_created += 1

        return StreamPlan(
            dataset_session_id=dataset_session_id,
            series_handle=series_handle,
            level=level,
            byte_range=selected,
            chunk_size_bytes=self._chunk_bytes,
            status_code=206 if is_partial else 200,
            is_partial=is_partial,
        )

    # --------------------------------------------------------
    # ITERATE PIXEL BYTES
    # --------------------------------------------------------

    def iter_volume_bytes(
        self,
        plan: StreamPlan,
        *,
        owner_id: str,
        cancel_event: threading.Event | None = None,
    ) -> Iterator[bytes]:
        """
        Stream an already planned byte range.

        Each chunk is obtained through the authenticated
        VolumeService.read_volume_bytes() interface.

        No unbounded pixel data is copied to a response.

        If authorization is revoked or the underlying dataset
        changes, the stream fails rather than silently using
        a stale unauthorized volume.
        """

        with self._lock:
            self._require_open()

        completed = False

        with self._lock:
            self._streams_started += 1
            self._active_streams += 1

        try:
            for offset, length in iter_chunk_ranges(
                plan.byte_range,
                plan.chunk_size_bytes,
            ):
                if (
                    cancel_event is not None
                    and cancel_event.is_set()
                ):
                    raise StreamingServiceError(
                        StreamingErrorCode.STREAM_CANCELLED
                    )

                with self._lock:
                    self._require_open()

                try:
                    chunk = self._volumes.read_volume_bytes(
                        plan.dataset_session_id,
                        plan.series_handle,
                        owner_id=owner_id,
                        level=plan.level,
                        offset=offset,
                        length=length,
                        max_range_mb=self._max_chunk_mb,
                    )

                except VolumeServiceError:
                    raise StreamingServiceError(
                        StreamingErrorCode.STREAM_FAILED
                    ) from None

                if len(chunk) != length:
                    raise StreamingServiceError(
                        StreamingErrorCode.STREAM_FAILED
                    )

                with self._lock:
                    self._chunks_delivered += 1
                    self._bytes_delivered += len(chunk)

                yield chunk

            completed = True

        finally:
            with self._lock:
                self._active_streams -= 1

                if completed:
                    self._streams_completed += 1
                else:
                    self._streams_failed += 1

    # --------------------------------------------------------
    # SAFE STREAM DESCRIPTOR
    # --------------------------------------------------------

    def describe_stream(
        self,
        plan: StreamPlan,
    ) -> dict[str, Any]:
        """
        Non-identifying stream information.

        Intended for diagnostics within authenticated APIs.
        """

        return {
            **plan.safe_summary(),
            "content_type": BINARY_MEDIA_TYPE,
            "encoding": VOLUME_FORMAT,
        }

    # --------------------------------------------------------
    # STATISTICS
    # --------------------------------------------------------

    def statistics(self) -> StreamStatistics:
        with self._lock:
            return StreamStatistics(
                plans_created=self._plans_created,
                streams_started=self._streams_started,
                streams_completed=self._streams_completed,
                streams_failed=self._streams_failed,
                chunks_delivered=self._chunks_delivered,
                bytes_delivered=self._bytes_delivered,
                active_streams=self._active_streams,
                closed=self._closed,
            )

    # --------------------------------------------------------
    # SHUTDOWN
    # --------------------------------------------------------

    def close(self) -> None:
        """
        Stop new stream work.

        Existing iterators observe shutdown at their next
        chunk boundary. No dataset files are touched.
        """

        with self._lock:
            self._closed = True


# ============================================================
# 08 — SERVICE FACTORY
# ============================================================

def create_streaming_service(
    volume_service: VolumeService,
    settings: AppSettings | None = None,
) -> VolumeStreamingService:
    """
    Create one streaming service per FastAPI process.

    The application lifespan manager owns shutdown.
    """

    return VolumeStreamingService(
        volume_service=volume_service,
        settings=settings,
    )


# ============================================================
# 09 — SAFE OPERATIONAL SUMMARY
# ============================================================

def get_streaming_service_summary(
    service: VolumeStreamingService,
) -> dict[str, Any]:
    return service.statistics().safe_summary()


# ============================================================
# END OF VOLUME STREAMING SERVICE
# ============================================================
