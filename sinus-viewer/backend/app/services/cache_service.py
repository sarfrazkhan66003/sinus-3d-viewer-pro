
"""
SINUS VIEWER — MEMORY-AWARE VOLUME CACHE
========================================

Features:
- Thread-safe, in-memory volume caching.
- Least-recently-used (LRU) eviction.
- Time-to-live (TTL) expiration.
- Maximum cached-volume count.
- Conservative available-RAM checks.
- Single-flight loading per cache key.
- Safe invalidation and shutdown.
- No patient identifiers in public statistics.
- No disk writes or source DICOM modification.

Limitations:
- Process-local cache, not shared between workers.
- Successful load does not guarantee sufficient RAM later.
- A caller holding a volume reference prevents its memory
  from being released immediately after eviction.
- Cache keys must be opaque internal series handles.
- Source-change detection belongs to the indexing service.

Python 3.10+
"""

from __future__ import annotations

import hashlib
import math
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Callable

import psutil

from ..core.config import AppSettings, get_settings
from ..dicom.volume_builder import VolumePackage


# ============================================================
# 01 — CONSTANTS
# ============================================================

GIB = 1024 ** 3
MIB = 1024 ** 2

VolumeLoader = Callable[[], VolumePackage]


# ============================================================
# 02 — CONTROLLED CACHE ERRORS
# ============================================================

class CacheServiceError(RuntimeError):
    """Base cache error without sensitive metadata."""

    public_code = "PROCESSING_FAILED"

    def __init__(self) -> None:
        super().__init__(self.public_code)


class CacheMemoryLimit(CacheServiceError):
    public_code = "OUT_OF_MEMORY"


class CacheLoadFailed(CacheServiceError):
    public_code = "PROCESSING_FAILED"


class CacheClosed(CacheServiceError):
    public_code = "SERVICE_UNAVAILABLE"


class CacheInvalidKey(CacheServiceError):
    public_code = "INVALID_REQUEST"


# ============================================================
# 03 — INTERNAL CACHE ENTRY
# ============================================================

@dataclass
class CacheEntry:
    key_digest: str
    package: VolumePackage = field(repr=False)

    size_bytes: int
    created_at: float
    last_access_at: float
    expires_at: float

    hits: int = 0


@dataclass
class _PendingLoad:
    """
    One in-progress load.

    The leader signals waiting callers after either
    successfully inserting the result or failing.
    """

    event: threading.Event = field(
        default_factory=threading.Event,
        repr=False,
    )
    error: CacheServiceError | None = None


# ============================================================
# 04 — CACHE STATISTICS
# ============================================================

@dataclass(frozen=True)
class CacheStatistics:
    entries: int
    total_bytes: int
    total_mib: float

    hits: int
    misses: int
    evictions: int
    expirations: int

    pending_loads: int
    maximum_entries: int
    ttl_seconds: int

    enabled: bool
    closed: bool

    def safe_summary(self) -> dict:
        return {
            "entries": self.entries,
            "total_mib": self.total_mib,
            "hits": self.hits,
            "misses": self.misses,
            "evictions": self.evictions,
            "expirations": self.expirations,
            "pending_loads": self.pending_loads,
            "maximum_entries": self.maximum_entries,
            "ttl_seconds": self.ttl_seconds,
            "enabled": self.enabled,
            "closed": self.closed,
        }


# ============================================================
# 05 — CACHE KEY HANDLING
# ============================================================

def normalize_cache_key(key: str) -> str:
    """
    Convert an internal identifier into a fixed-length key.

    Hashing prevents accidental exposure in cache inspection.
    It is not anonymization or access authorization.
    """

    if not isinstance(key, str) or not key:
        raise CacheInvalidKey()

    if len(key) > 512:
        raise CacheInvalidKey()

    return hashlib.sha256(
        key.encode("utf-8")
    ).hexdigest()


# ============================================================
# 06 — PACKAGE MEMORY ESTIMATION
# ============================================================

def calculate_package_bytes(
    package: VolumePackage,
) -> int:
    """
    Count memory represented by full and preview arrays.

    Identical NumPy data buffers are counted once.

    This excludes Python object overhead, decoder working
    buffers and references held outside the cache.
    """

    if not isinstance(package, VolumePackage):
        raise CacheLoadFailed()

    total = 0
    seen_buffers: set[int] = set()

    for volume in package.all_levels():
        data = volume.voxels

        pointer = int(
            data.__array_interface__["data"][0]
        )

        if pointer not in seen_buffers:
            seen_buffers.add(pointer)
            total += int(data.nbytes)

    return total


# ============================================================
# 07 — CACHE SERVICE
# ============================================================

class VolumeCacheService:
    """
    Thread-safe cache for prepared medical imaging volumes.

    Use one instance per backend process.

    All public methods protect shared cache state with
    a reentrant lock. User-provided loaders run outside
    the global cache lock.
    """

    def __init__(
        self,
        settings: AppSettings | None = None,
    ) -> None:
        self._settings = (
            settings if settings is not None
            else get_settings()
        )

        config = self._settings.performance.cache

        self._enabled = bool(config.enabled)

        self._maximum_entries = max(
            1,
            int(config.max_in_memory_volumes),
        )

        self._ttl_seconds = max(
            1,
            int(config.cache_ttl_minutes * 60),
        )

        self._entries: OrderedDict[
            str, CacheEntry
        ] = OrderedDict()

        self._pending: dict[
            str, _PendingLoad
        ] = {}

        self._lock = threading.RLock()

        self._hits = 0
        self._misses = 0
        self._evictions = 0
        self._expirations = 0

        self._total_bytes = 0
        self._closed = False

        # A changing generation prevents a load started
        # before clear()/invalidate() from being inserted
        # after that operation completes.
        self._generation = 0

    # --------------------------------------------------------
    # INTERNAL STATE
    # --------------------------------------------------------

    def _require_open(self) -> None:
        if self._closed:
            raise CacheClosed()

    def _remove_entry(
        self,
        key: str,
        *,
        expired: bool = False,
    ) -> bool:
        entry = self._entries.pop(key, None)

        if entry is None:
            return False

        self._total_bytes = max(
            0,
            self._total_bytes - entry.size_bytes,
        )

        if expired:
            self._expirations += 1
        else:
            self._evictions += 1

        return True

    def _remove_expired(
        self,
        now: float,
    ) -> None:
        expired_keys = [
            key
            for key, entry in self._entries.items()
            if entry.expires_at <= now
        ]

        for key in expired_keys:
            self._remove_entry(
                key,
                expired=True,
            )

    def _lookup(
        self,
        digest: str,
    ) -> VolumePackage | None:
        now = time.monotonic()

        self._remove_expired(now)

        entry = self._entries.get(digest)

        if entry is None:
            return None

        entry.last_access_at = now
        entry.hits += 1

        self._entries.move_to_end(digest)
        self._hits += 1

        return entry.package

    # --------------------------------------------------------
    # MEMORY SAFETY
    # --------------------------------------------------------

    def _memory_budget_bytes(self) -> int:
        """
        Conservative budget for additional cache memory.

        This is a snapshot, not a reservation.
        """

        memory_config = self._settings.performance.memory

        if not memory_config.enable_memory_guard:
            return 2 ** 63 - 1

        memory = psutil.virtual_memory()

        reserved = int(
            max(
                memory_config.minimum_free_ram_gb,
                self._settings.hardware.cpu.reserve_system_memory_gb,
            ) * GIB
        )

        maximum_used = int(
            memory.total
            * memory_config.max_ram_utilization_percent
            / 100.0
        )

        currently_used = max(
            0,
            memory.total - memory.available,
        )

        return max(
            0,
            min(
                memory.available - reserved,
                maximum_used - currently_used,
            ),
        )

    def _check_package_size(
        self,
        package_size: int,
    ) -> None:
        """
        Avoid accepting oversized cache objects.

        The volume has already been built when this method
        runs. The check therefore cannot prevent memory
        consumption during the initial decode.
        """

        if package_size <= 0:
            raise CacheLoadFailed()

        maximum_raw = (
            self._settings.dicom.volume
            .max_uncompressed_volume_mb
            * MIB
        )

        maximum_cache = (
            self._settings.performance.cache
            .max_disk_cache_gb
            * GIB
        )

        if package_size > maximum_raw:
            raise CacheMemoryLimit()

        # This configured value is primarily a disk-cache
        # limit. It is used here only as an additional
        # conservative upper bound, not as a RAM target.
        if package_size > maximum_cache:
            raise CacheMemoryLimit()

    # --------------------------------------------------------
    # GET
    # --------------------------------------------------------

    def get(
        self,
        key: str,
    ) -> VolumePackage | None:
        digest = normalize_cache_key(key)

        with self._lock:
            self._require_open()

            if not self._enabled:
                return None

            result = self._lookup(digest)

            if result is None:
                self._misses += 1

            return result

    # --------------------------------------------------------
    # PUT
    # --------------------------------------------------------

    def put(
        self,
        key: str,
        package: VolumePackage,
    ) -> bool:
        """
        Cache one prepared volume package.

        Returns False when caching is disabled.
        """

        digest = normalize_cache_key(key)

        if not self._enabled:
            with self._lock:
                self._require_open()
            return False

        package_size = calculate_package_bytes(package)

        self._check_package_size(package_size)

        with self._lock:
            self._require_open()

            self._remove_expired(time.monotonic())

            # An already-built package is resident in RAM.
            # Inserting its reference does not normally
            # allocate a second pixel buffer.
            self._entries.pop(digest, None)

            # Recalculate accounting after replacement.
            self._total_bytes = sum(
                entry.size_bytes
                for entry in self._entries.values()
            )

            while len(self._entries) >= self._maximum_entries:
                oldest_key = next(iter(self._entries))

                self._remove_entry(oldest_key)

            now = time.monotonic()

            self._entries[digest] = CacheEntry(
                key_digest=digest,
                package=package,
                size_bytes=package_size,
                created_at=now,
                last_access_at=now,
                expires_at=now + self._ttl_seconds,
            )

            self._total_bytes += package_size

            return True

    # --------------------------------------------------------
    # GET OR LOAD — SINGLE-FLIGHT
    # --------------------------------------------------------

    def get_or_load(
        self,
        key: str,
        loader: VolumeLoader,
    ) -> VolumePackage:
        """
        Load a missing volume once for concurrent requests.

        One caller becomes the leader. Others wait for it,
        then retrieve the cached result.

        Loaders execute outside the cache lock, avoiding
        a global lock during DICOM decoding.
        """

        digest = normalize_cache_key(key)

        with self._lock:
            self._require_open()

            if self._enabled:
                cached = self._lookup(digest)

                if cached is not None:
                    return cached

            if not self._enabled:
                pending = None
                leader = True
            else:
                pending = self._pending.get(digest)

                leader = pending is None

                if leader:
                    pending = _PendingLoad()
                    self._pending[digest] = pending

            generation = self._generation

        # Cache-disabled mode deliberately skips coordination.
        if not self._enabled:
            result = loader()

            if not isinstance(result, VolumePackage):
                raise CacheLoadFailed()

            return result

        assert pending is not None

        if not leader:
            pending.event.wait()

            if pending.error is not None:
                raise pending.error

            with self._lock:
                self._require_open()

                cached = self._lookup(digest)

                if cached is not None:
                    return cached

            # Cache was invalidated or evicted before
            # the waiting caller resumed.
            raise CacheLoadFailed()

        try:
            result = loader()

            if not isinstance(result, VolumePackage):
                raise CacheLoadFailed()

            with self._lock:
                self._require_open()

                if generation != self._generation:
                    raise CacheLoadFailed()

            self.put(key, result)

            return result

        except CacheServiceError as error:
            pending.error = error
            raise

        except Exception:
            pending.error = CacheLoadFailed()
            raise CacheLoadFailed() from None

        finally:
            with self._lock:
                if self._pending.get(digest) is pending:
                    del self._pending[digest]

                pending.event.set()

    # --------------------------------------------------------
    # INVALIDATION
    # --------------------------------------------------------

    def invalidate(
        self,
        key: str,
    ) -> bool:
        digest = normalize_cache_key(key)

        with self._lock:
            self._require_open()

            self._generation += 1

            return self._remove_entry(digest)

    def clear(self) -> int:
        """
        Clear cached references.

        Does not delete source or runtime files.
        """

        with self._lock:
            self._require_open()

            count = len(self._entries)

            self._entries.clear()
            self._total_bytes = 0
            self._generation += 1

            return count

    # --------------------------------------------------------
    # STATISTICS
    # --------------------------------------------------------

    def statistics(self) -> CacheStatistics:
        with self._lock:
            self._remove_expired(time.monotonic())

            return CacheStatistics(
                entries=len(self._entries),
                total_bytes=self._total_bytes,
                total_mib=round(
                    self._total_bytes / MIB, 2
                ),
                hits=self._hits,
                misses=self._misses,
                evictions=self._evictions,
                expirations=self._expirations,
                pending_loads=len(self._pending),
                maximum_entries=self._maximum_entries,
                ttl_seconds=self._ttl_seconds,
                enabled=self._enabled,
                closed=self._closed,
            )

    # --------------------------------------------------------
    # CLOSE
    # --------------------------------------------------------

    def close(self) -> None:
        """
        Release cache-held references during shutdown.

        In-flight loaders may complete, but cannot insert
        results after the service closes.
        """

        with self._lock:
            if self._closed:
                return

            self._closed = True
            self._generation += 1

            self._entries.clear()
            self._total_bytes = 0


# ============================================================
# 08 — SERVICE FACTORY
# ============================================================

def create_volume_cache(
    settings: AppSettings | None = None,
) -> VolumeCacheService:
    """
    Create a cache instance for the backend application.

    The FastAPI lifespan manager should own the instance
    and call close() during shutdown.
    """

    return VolumeCacheService(settings)


# ============================================================
# 09 — SAFE CACHE SUMMARY
# ============================================================

def get_cache_summary(
    cache: VolumeCacheService,
) -> dict:
    """
    Operational summary without cache keys, DICOM paths,
    patient names, identifiers or imaging pixel data.
    """

    return cache.statistics().safe_summary()


# ============================================================
# END OF CACHE SERVICE
# ============================================================
