
"""
SINUS VIEWER — VOLUME MANAGEMENT SERVICE
========================================

Coordinates:
- Dataset session authorization and series lookup.
- Validated DICOM volume loading.
- Memory-aware cache integration.
- Single-flight loading through VolumeCacheService.
- Bounded concurrent full-volume reconstruction.
- Preview/full-resolution level selection.
- Safe technical volume descriptors.
- Bounded in-memory pixel byte-range access.
- Dataset generation checks against stale indexes.
- Graceful shutdown.

Security:
- The API must supply a trusted, authenticated owner_id.
- Client-supplied owner_id values are never trusted.
- Dataset/series handles are NOT authentication tokens.
- Every retrieval rechecks dataset ownership.
- Raw DICOM paths and identifiers are never logged.
- Original source data is strictly read-only.
- No disk writes are performed by this service.

This service is synchronous. FastAPI routes must call
blocking operations through a bounded thread pool.

Python 3.10+
"""

from __future__ import annotations

import hashlib
import threading
from dataclasses import dataclass
from typing import Any, Callable

from ..core.config import AppSettings, get_settings
from ..core.hardware import (
    HardwareSnapshot,
    detect_hardware,
)
from ..dicom.volume_builder import (
    PreparedVolume,
    VolumePackage,
    build_volume_package,
    describe_volume_level,
    describe_volume_package,
    get_volume_byte_view,
)
from .cache_service import (
    CacheServiceError,
    VolumeCacheService,
    create_volume_cache,
)
from .dataset_service import (
    DatasetService,
    DatasetServiceError,
    DatasetSeriesNotFound,
    validate_handle,
    validate_owner_id,
)


# ============================================================
# 01 — CONSTANTS AND TYPES
# ============================================================

MIB = 1024 ** 2

DEFAULT_MAX_CONCURRENT_LOADS = 1
DEFAULT_MAX_BYTE_RANGE_MB = 4

VolumeProgressCallback = Callable[[int, int], None]


# ============================================================
# 02 — CONTROLLED SERVICE EXCEPTIONS
# ============================================================

class VolumeServiceError(RuntimeError):
    """
    Safe error without patient identifiers or file paths.
    """

    public_code = "PROCESSING_FAILED"

    def __init__(self) -> None:
        super().__init__(self.public_code)


class VolumeServiceClosed(VolumeServiceError):
    public_code = "SERVICE_UNAVAILABLE"


class VolumeServiceBusy(VolumeServiceError):
    public_code = "SERVICE_UNAVAILABLE"


class VolumeNotFound(VolumeServiceError):
    public_code = "SERIES_NOT_FOUND"


class VolumeNotReady(VolumeServiceError):
    public_code = "SERIES_INVALID"


class VolumeLoadFailed(VolumeServiceError):
    public_code = "PROCESSING_FAILED"


class VolumeMemoryExceeded(VolumeServiceError):
    public_code = "OUT_OF_MEMORY"


class VolumeSourceChanged(VolumeServiceError):
    public_code = "SOURCE_CHANGED"


class VolumeInvalidRange(VolumeServiceError):
    public_code = "INVALID_REQUEST"


# ============================================================
# 03 — INTERNAL CONTEXT
# ============================================================

@dataclass(frozen=True)
class VolumeContext:
    """
    Authorized lookup snapshot.

    An index generation identifies the dataset version
    from which the series was selected.

    No sensitive patient metadata is stored here.
    """

    dataset_session_id: str
    series_handle: str
    generation: int
    cache_key: str


@dataclass(frozen=True)
class VolumeLevelInfo:
    level: int
    shape_zyx: tuple[int, int, int]
    byte_size: int
    is_preview: bool

    def safe_summary(self) -> dict[str, Any]:
        return {
            "level": self.level,
            "shape_zyx": list(self.shape_zyx),
            "byte_size": self.byte_size,
            "is_preview": self.is_preview,
        }


@dataclass(frozen=True)
class VolumeServiceStatistics:
    load_requests: int
    completed_loads: int
    failed_loads: int
    active_loads: int
    maximum_concurrent_loads: int
    closed: bool

    def safe_summary(self) -> dict[str, Any]:
        return {
            "load_requests": self.load_requests,
            "completed_loads": self.completed_loads,
            "failed_loads": self.failed_loads,
            "active_loads": self.active_loads,
            "maximum_concurrent_loads": (
                self.maximum_concurrent_loads
            ),
            "closed": self.closed,
        }


# ============================================================
# 04 — CACHE KEY GENERATION
# ============================================================

def make_volume_cache_key(
    dataset_session_id: str,
    series_handle: str,
    generation: int,
) -> str:
    """
    Include dataset generation to prevent using an older
    cached volume after a successful dataset refresh.

    This hash is an internal lookup key, not anonymization.
    """

    validate_handle(dataset_session_id)
    validate_handle(series_handle)

    if (
        not isinstance(generation, int)
        or isinstance(generation, bool)
        or generation < 1
    ):
        raise VolumeInvalidRange()

    value = (
        f"{dataset_session_id}:"
        f"{series_handle}:"
        f"{generation}"
    )

    return "volume_" + hashlib.sha256(
        value.encode("utf-8")
    ).hexdigest()


# ============================================================
# 05 — VOLUME SERVICE
# ============================================================

class VolumeService:
    """
    Process-local volume manager.

    The DatasetService controls dataset ownership.
    The VolumeCacheService manages cached volume packages.

    The semaphore bounds simultaneous full-volume loads.
    """

    def __init__(
        self,
        dataset_service: DatasetService,
        cache_service: VolumeCacheService | None = None,
        settings: AppSettings | None = None,
        *,
        max_concurrent_loads: int | None = None,
    ) -> None:

        if not isinstance(dataset_service, DatasetService):
            raise TypeError(
                "A DatasetService instance is required."
            )

        self._settings = (
            settings if settings is not None
            else get_settings()
        )

        configured_limit = (
            self._settings.server.limits
            .max_concurrent_volume_loads
        )

        limit = (
            configured_limit
            if max_concurrent_loads is None
            else max_concurrent_loads
        )

        if (
            not isinstance(limit, int)
            or isinstance(limit, bool)
            or limit < 1
        ):
            raise ValueError(
                "Concurrent load limit must be positive."
            )

        self._datasets = dataset_service

        self._owns_cache = cache_service is None

        self._cache = (
            cache_service
            if cache_service is not None
            else create_volume_cache(self._settings)
        )

        self._maximum_loads = limit

        self._load_semaphore = threading.BoundedSemaphore(
            value=limit
        )

        self._lock = threading.RLock()
        self._closed = False

        self._load_requests = 0
        self._completed_loads = 0
        self._failed_loads = 0
        self._active_loads = 0

    # --------------------------------------------------------
    # SERVICE STATE
    # --------------------------------------------------------

    def _require_open(self) -> None:
        if self._closed:
            raise VolumeServiceClosed()

    # --------------------------------------------------------
    # AUTHORIZED SERIES LOOKUP
    # --------------------------------------------------------

    def _resolve_context(
        self,
        dataset_session_id: str,
        series_handle: str,
        owner_id: str,
    ) -> VolumeContext:
        """
        Obtain a trusted dataset generation and verify that
        the series belongs to this owner's dataset session.

        The dataset may change concurrently, so generation
        is checked again after loading.
        """

        validate_owner_id(owner_id)
        validate_handle(dataset_session_id)
        validate_handle(series_handle)

        with self._lock:
            self._require_open()

        try:
            dataset_info = self._datasets.get_dataset(
                dataset_session_id,
                owner_id=owner_id,
            )

            self._datasets.get_series(
                dataset_session_id,
                series_handle,
                owner_id=owner_id,
            )

        except DatasetServiceError:
            raise VolumeNotFound() from None

        if dataset_info.get("state") != "ready":
            raise VolumeServiceBusy()

        generation = dataset_info["generation"]

        return VolumeContext(
            dataset_session_id=dataset_session_id,
            series_handle=series_handle,
            generation=generation,
            cache_key=make_volume_cache_key(
                dataset_session_id,
                series_handle,
                generation,
            ),
        )

    # --------------------------------------------------------
    # GENERATION / ACCESS REVALIDATION
    # --------------------------------------------------------

    def _verify_context(
        self,
        context: VolumeContext,
        owner_id: str,
    ) -> None:
        """
        Reject volumes whose dataset session is no longer
        authorized or whose index generation changed.
        """

        with self._lock:
            self._require_open()

        try:
            current = self._datasets.get_dataset(
                context.dataset_session_id,
                owner_id=owner_id,
            )

            self._datasets.get_series(
                context.dataset_session_id,
                context.series_handle,
                owner_id=owner_id,
            )

        except DatasetServiceError:
            raise VolumeNotFound() from None

        if current.get("state") != "ready":
            raise VolumeServiceBusy()

        if current.get("generation") != context.generation:
            raise VolumeSourceChanged()

    # --------------------------------------------------------
    # LOAD ONE SERIES
    # --------------------------------------------------------

    def load_volume(
        self,
        dataset_session_id: str,
        series_handle: str,
        *,
        owner_id: str,
        hardware_snapshot: HardwareSnapshot | None = None,
        cancel_event: threading.Event | None = None,
        progress_callback: VolumeProgressCallback | None = None,
    ) -> VolumePackage:
        """
        Retrieve or build a volume for an authorized series.

        No raw DICOM paths or identifiers are returned.

        A full-volume reconstruction runs only after a
        bounded-load semaphore has been acquired.
        """

        context = self._resolve_context(
            dataset_session_id,
            series_handle,
            owner_id,
        )

        with self._lock:
            self._require_open()
            self._load_requests += 1

        def loader() -> VolumePackage:
            acquired = self._load_semaphore.acquire(
                timeout=self._settings.server.request_timeout_seconds
            )

            if not acquired:
                raise VolumeServiceBusy()

            with self._lock:
                self._active_loads += 1

            try:
                self._verify_context(context, owner_id)

                series = self._datasets.get_series(
                    dataset_session_id,
                    series_handle,
                    owner_id=owner_id,
                )

                if (
                    series.validation is None
                    or not series.validation.volume_ready
                ):
                    raise VolumeNotReady()

                snapshot = (
                    hardware_snapshot
                    if hardware_snapshot is not None
                    else detect_hardware(self._settings)
                )

                package = build_volume_package(
                    series.instances,
                    self._settings,
                    hardware_snapshot=snapshot,
                    cancel_event=cancel_event,
                    progress_callback=progress_callback,
                )

                self._verify_context(context, owner_id)

                return package

            finally:
                with self._lock:
                    self._active_loads -= 1

                self._load_semaphore.release()

        try:
            package = self._cache.get_or_load(
                context.cache_key,
                loader,
            )

            # Cached results must also pass authorization
            # and generation checks before being returned.
            self._verify_context(context, owner_id)

            with self._lock:
                self._completed_loads += 1

            return package

        except VolumeServiceError:
            with self._lock:
                self._failed_loads += 1
            raise

        except CacheServiceError:
            with self._lock:
                self._failed_loads += 1
            raise VolumeLoadFailed() from None

        except DatasetServiceError:
            with self._lock:
                self._failed_loads += 1
            raise VolumeNotFound() from None

        except Exception:
            with self._lock:
                self._failed_loads += 1
            raise VolumeLoadFailed() from None

    # --------------------------------------------------------
    # GET ONE PREPARED LEVEL
    # --------------------------------------------------------

    def get_level(
        self,
        dataset_session_id: str,
        series_handle: str,
        *,
        owner_id: str,
        level: int = 0,
    ) -> PreparedVolume:
        """
        Get one full-resolution or preview level.

        Level 0 = full-resolution volume.
        Positive levels = preview levels, if generated.
        """

        if (
            not isinstance(level, int)
            or isinstance(level, bool)
            or level < 0
        ):
            raise VolumeInvalidRange()

        package = self.load_volume(
            dataset_session_id,
            series_handle,
            owner_id=owner_id,
        )

        result = package.get_level(level)

        if result is None:
            raise VolumeNotFound()

        return result

    # --------------------------------------------------------
    # SAFE VOLUME DESCRIPTORS
    # --------------------------------------------------------

    def describe_volume(
        self,
        dataset_session_id: str,
        series_handle: str,
        *,
        owner_id: str,
    ) -> dict[str, Any]:
        """
        Return volume metadata without transmitting pixels,
        source paths, patient names or DICOM identifiers.
        """

        package = self.load_volume(
            dataset_session_id,
            series_handle,
            owner_id=owner_id,
        )

        return describe_volume_package(package)

    def describe_level(
        self,
        dataset_session_id: str,
        series_handle: str,
        *,
        owner_id: str,
        level: int = 0,
    ) -> dict[str, Any]:

        volume = self.get_level(
            dataset_session_id,
            series_handle,
            owner_id=owner_id,
            level=level,
        )

        return describe_volume_level(volume)

    # --------------------------------------------------------
    # BOUNDED PIXEL BYTE-RANGE ACCESS
    # --------------------------------------------------------

    def read_volume_bytes(
        self,
        dataset_session_id: str,
        series_handle: str,
        *,
        owner_id: str,
        level: int,
        offset: int,
        length: int,
        max_range_mb: int = DEFAULT_MAX_BYTE_RANGE_MB,
    ) -> bytes:
        """
        Return a bounded slice of a prepared volume's bytes.

        This is NOT an HTTP endpoint. The eventual API must:
        - Enforce authentication, authorization and CSRF
          protections where applicable.
        - Apply request-rate and concurrency limits.
        - Disable response caching.
        - Avoid logging raw URLs or query parameters.

        Byte offset/length operate on contiguous float32
        volume data in Z,Y,X order.

        No DICOM file writing or temporary-file creation.
        """

        for value in (offset, length, max_range_mb):
            if (
                not isinstance(value, int)
                or isinstance(value, bool)
            ):
                raise VolumeInvalidRange()

        if (
            offset < 0
            or length < 1
            or max_range_mb < 1
            or length > max_range_mb * MIB
        ):
            raise VolumeInvalidRange()

        volume = self.get_level(
            dataset_session_id,
            series_handle,
            owner_id=owner_id,
            level=level,
        )

        byte_view = get_volume_byte_view(volume)

        total = len(byte_view)

        if offset > total or length > total - offset:
            raise VolumeInvalidRange()

        # Independent bounded bytes copy; it does not expose
        # a mutable NumPy array to the API layer.
        result = bytes(
            byte_view[offset:offset + length]
        )

        return result

    # --------------------------------------------------------
    # CACHE INVALIDATION
    # --------------------------------------------------------

    def invalidate_series(
        self,
        dataset_session_id: str,
        series_handle: str,
        *,
        owner_id: str,
    ) -> bool:
        """
        Invalidate the current generation's cached volume.

        Does not modify DICOM files or filesystem storage.
        """

        context = self._resolve_context(
            dataset_session_id,
            series_handle,
            owner_id,
        )

        try:
            return self._cache.invalidate(
                context.cache_key
            )

        except CacheServiceError:
            raise VolumeLoadFailed() from None

    def clear_cached_volumes(self) -> int:
        """
        Internal administrative operation.

        Do not expose without server-side authorization.
        """

        with self._lock:
            self._require_open()

        return self._cache.clear()

    # --------------------------------------------------------
    # SERVICE STATISTICS
    # --------------------------------------------------------

    def statistics(self) -> VolumeServiceStatistics:
        with self._lock:
            return VolumeServiceStatistics(
                load_requests=self._load_requests,
                completed_loads=self._completed_loads,
                failed_loads=self._failed_loads,
                active_loads=self._active_loads,
                maximum_concurrent_loads=self._maximum_loads,
                closed=self._closed,
            )

    # --------------------------------------------------------
    # SHUTDOWN
    # --------------------------------------------------------

    def close(self) -> None:
        """
        Stop accepting new service operations.

        The application lifespan manager must also drain its
        worker pool before terminating the process.
        """

        with self._lock:
            if self._closed:
                return

            self._closed = True

        if self._owns_cache:
            self._cache.close()


# ============================================================
# 06 — SERVICE FACTORY
# ============================================================

def create_volume_service(
    dataset_service: DatasetService,
    cache_service: VolumeCacheService | None = None,
    settings: AppSettings | None = None,
) -> VolumeService:
    """
    Create one process-local volume service.

    Intended for FastAPI lifespan initialization.
    """

    return VolumeService(
        dataset_service=dataset_service,
        cache_service=cache_service,
        settings=settings,
    )


# ============================================================
# 07 — SAFE SERVICE SUMMARY
# ============================================================

def get_volume_service_summary(
    service: VolumeService,
) -> dict[str, Any]:
    """
    Non-identifying operational service statistics.
    """

    return service.statistics().safe_summary()


# ============================================================
# END OF VOLUME MANAGEMENT SERVICE
# ============================================================
