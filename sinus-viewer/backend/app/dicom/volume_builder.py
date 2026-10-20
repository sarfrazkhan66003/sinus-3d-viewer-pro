
"""
SINUS VIEWER — 3D VOLUME BUILDER
================================

Build and prepare validated medical volumes for rendering.

Features:
- Existing DICOM series reader integration
- Validated LPS voxel geometry
- Full-resolution volume preservation
- Memory-bounded preview generation
- Physical spacing preservation during downsampling
- Progressive preview levels
- Cancellation and progress callbacks
- Authenticated API-ready technical descriptors
- Zero dataset writes

IMPORTANT:
Preview generation here requires a successfully loaded
full-resolution volume. A true low-memory preview decoder
will be implemented separately.

Preview downsampling uses voxel subsampling. It preserves
sample positions but does not provide anti-alias filtering;
therefore previews are for navigation, not diagnosis.

No files are created, edited, deleted, moved or renamed.
"""

from __future__ import annotations

import math
import threading
from dataclasses import dataclass, field
from typing import Callable, Sequence

import numpy as np

from ..core.config import AppSettings, get_settings
from ..core.hardware import (
    HardwareSnapshot,
    detect_hardware,
)
from .geometry import (
    VolumeGeometry,
    build_geometry_report,
    geometry_from_series_volume,
)
from .metadata import DicomMetadata
from .series_reader import (
    SeriesVolume,
    load_series_volume,
)


# ============================================================
# 01 — TYPES AND CONSTANTS
# ============================================================

MIB = 1024 ** 2
GIB = 1024 ** 3

ProgressCallback = Callable[[int, int], None]

DEFAULT_PREVIEW_DIMENSIONS = (
    128,
    256,
    384,
)


# ============================================================
# 02 — CONTROLLED EXCEPTIONS
# ============================================================

class VolumeBuilderError(RuntimeError):
    """Base safe volume-building exception."""

    public_code = "PROCESSING_FAILED"

    def __init__(self) -> None:
        super().__init__(self.public_code)


class VolumeBuilderMemoryError(VolumeBuilderError):
    public_code = "OUT_OF_MEMORY"


class VolumeBuilderGeometryError(VolumeBuilderError):
    public_code = "GEOMETRY_INVALID"


class VolumeBuilderCancelled(VolumeBuilderError):
    public_code = "SCAN_CANCELLED"


# ============================================================
# 03 — DATA MODELS
# ============================================================

@dataclass(frozen=True)
class PreparedVolume:
    """
    One prepared 3D volume.

    voxels shape: Z, Y, X
    geometry spacing: X, Y, Z

    Full-resolution voxels may reference the existing
    SeriesVolume array without making another copy.
    """

    voxels: np.ndarray = field(repr=False)
    geometry: VolumeGeometry

    level: int
    is_preview: bool
    source_shape_zyx: tuple[int, int, int]

    stride_zyx: tuple[int, int, int]

    @property
    def shape_zyx(self) -> tuple[int, int, int]:
        return tuple(int(x) for x in self.voxels.shape)

    @property
    def byte_size(self) -> int:
        return int(self.voxels.nbytes)

    def safe_summary(self) -> dict:
        return {
            "level": self.level,
            "is_preview": self.is_preview,
            "shape_zyx": list(self.shape_zyx),
            "source_shape_zyx": list(self.source_shape_zyx),
            "stride_zyx": list(self.stride_zyx),
            "dtype": str(self.voxels.dtype),
            "byte_size": self.byte_size,
            "geometry": self.geometry.safe_summary(),
        }


@dataclass(frozen=True)
class VolumePackage:
    """
    Full volume plus available preview levels.

    No patient identifiers or source DICOM paths are
    included in frontend descriptors.
    """

    full: PreparedVolume = field(repr=False)

    previews: tuple[PreparedVolume, ...] = field(
        default_factory=tuple,
        repr=False,
    )

    def all_levels(self) -> tuple[PreparedVolume, ...]:
        return self.previews + (self.full,)

    def get_level(self, level: int) -> PreparedVolume | None:
        for item in self.all_levels():
            if item.level == level:
                return item
        return None

    def safe_summary(self) -> dict:
        return {
            "full": self.full.safe_summary(),
            "previews": [
                preview.safe_summary()
                for preview in self.previews
            ],
            "available_levels": [
                volume.level
                for volume in self.all_levels()
            ],
        }


# ============================================================
# 04 — CANCELLATION
# ============================================================

def check_cancelled(
    cancel_event: threading.Event | None,
) -> None:
    if cancel_event is not None and cancel_event.is_set():
        raise VolumeBuilderCancelled()


# ============================================================
# 05 — VALIDATE EXISTING SERIES VOLUME
# ============================================================

def prepare_full_volume(
    volume: SeriesVolume,
) -> PreparedVolume:
    """
    Wrap an already-loaded DICOM volume without copying pixels.

    Checks dtype, dimensions, finite values and geometry.
    """

    voxels = volume.voxels

    if not isinstance(voxels, np.ndarray):
        raise VolumeBuilderGeometryError()

    if voxels.ndim != 3 or any(
        dimension <= 0 for dimension in voxels.shape
    ):
        raise VolumeBuilderGeometryError()

    if tuple(voxels.shape) != tuple(volume.shape_zyx):
        raise VolumeBuilderGeometryError()

    if voxels.dtype != np.dtype("float32"):
        raise VolumeBuilderGeometryError()

    if not np.all(np.isfinite(voxels)):
        raise VolumeBuilderGeometryError()

    try:
        geometry = geometry_from_series_volume(volume)
    except (ValueError, TypeError):
        raise VolumeBuilderGeometryError() from None

    if geometry.shape_zyx != tuple(voxels.shape):
        raise VolumeBuilderGeometryError()

    voxels.setflags(write=False)

    return PreparedVolume(
        voxels=voxels,
        geometry=geometry,
        level=0,
        is_preview=False,
        source_shape_zyx=tuple(voxels.shape),
        stride_zyx=(1, 1, 1),
    )


# ============================================================
# 06 — PREVIEW STRIDE CALCULATION
# ============================================================

def calculate_preview_stride(
    shape_zyx: Sequence[int],
    max_dimension: int,
) -> tuple[int, int, int]:
    """
    Determine integer strides that keep every output axis
    within max_dimension.

    Integer-stride sampling preserves exact original
    physical voxel positions.
    """

    if (
        len(shape_zyx) != 3
        or any(
            not isinstance(size, int)
            or isinstance(size, bool)
            or size < 1
            for size in shape_zyx
        )
        or not isinstance(max_dimension, int)
        or isinstance(max_dimension, bool)
        or max_dimension < 1
    ):
        raise ValueError("Invalid preview dimensions.")

    return tuple(
        max(1, math.ceil(size / max_dimension))
        for size in shape_zyx
    )


def preview_shape(
    source_shape: Sequence[int],
    stride: Sequence[int],
) -> tuple[int, int, int]:
    if (
        len(source_shape) != 3
        or len(stride) != 3
        or any(
            not isinstance(s, int)
            or isinstance(s, bool)
            or s < 1
            for s in (*source_shape, *stride)
        )
    ):
        raise ValueError("Invalid preview shape or stride.")

    return tuple(
        (size - 1) // step + 1
        for size, step in zip(source_shape, stride)
    )


# ============================================================
# 07 — PREVIEW MEMORY CHECK
# ============================================================

def enforce_preview_memory_limit(
    shape_zyx: Sequence[int],
    dtype: np.dtype,
    settings: AppSettings,
) -> None:
    """
    Reject preview allocations exceeding available memory
    or configured limits.

    Not a guarantee of actual process peak memory usage.
    """

    voxels = math.prod(shape_zyx)
    allocation_bytes = voxels * dtype.itemsize

    if voxels > settings.dicom.volume.max_voxels:
        raise VolumeBuilderMemoryError()

    if (
        allocation_bytes
        > settings.dicom.volume.max_uncompressed_volume_mb
        * MIB
    ):
        raise VolumeBuilderMemoryError()

    import psutil

    available_bytes = psutil.virtual_memory().available

    reserve_bytes = int(
        max(
            settings.hardware.cpu.reserve_system_memory_gb,
            settings.performance.memory.minimum_free_ram_gb,
        ) * GIB
    )

    if settings.performance.memory.enable_memory_guard:
        if allocation_bytes * 2 > max(
            0,
            available_bytes - reserve_bytes,
        ):
            raise VolumeBuilderMemoryError()


# ============================================================
# 08 — PREVIEW GEOMETRY
# ============================================================

def calculate_preview_geometry(
    source: VolumeGeometry,
    stride_zyx: tuple[int, int, int],
    new_shape_zyx: tuple[int, int, int],
) -> VolumeGeometry:
    """
    Preserve physical positions when sampling source voxels.

    Sampling starts at source voxel (0,0,0), so origin and
    direction remain unchanged. Spacing grows by each stride.
    """

    stride_z, stride_y, stride_x = stride_zyx

    spacing_x, spacing_y, spacing_z = (
        source.spacing_xyz_mm
    )

    return VolumeGeometry(
        shape_zyx=new_shape_zyx,
        spacing_xyz_mm=(
            spacing_x * stride_x,
            spacing_y * stride_y,
            spacing_z * stride_z,
        ),
        origin_lps=source.origin_lps,
        direction_lps=source.direction_lps,
    )


# ============================================================
# 09 — GENERATE ONE PREVIEW
# ============================================================

def build_preview_volume(
    source: PreparedVolume,
    *,
    max_dimension: int,
    level: int,
    settings: AppSettings | None = None,
    cancel_event: threading.Event | None = None,
) -> PreparedVolume:
    """
    Generate an independent contiguous float32 preview.

    Uses nearest-neighbour voxel subsampling.

    This is intended for navigation and rapid overview only.
    It is not a diagnostic-quality resampling method.
    """

    active = settings if settings is not None else get_settings()

    check_cancelled(cancel_event)

    if level <= 0:
        raise ValueError("Preview level must be positive.")

    stride = calculate_preview_stride(
        source.shape_zyx,
        max_dimension,
    )

    new_shape = preview_shape(
        source.shape_zyx,
        stride,
    )

    enforce_preview_memory_limit(
        new_shape,
        source.voxels.dtype,
        active,
    )

    z_step, y_step, x_step = stride

    try:
        # First create a view, then one contiguous copy.
        sampled = source.voxels[
            ::z_step,
            ::y_step,
            ::x_step,
        ]

        check_cancelled(cancel_event)

        preview_pixels = np.ascontiguousarray(sampled)

        # If stride is 1 in every direction, NumPy may
        # reuse the original buffer. Force separation.
        if np.shares_memory(
            preview_pixels,
            source.voxels,
        ):
            preview_pixels = preview_pixels.copy()

        preview_pixels.setflags(write=False)

        preview_geometry = calculate_preview_geometry(
            source.geometry,
            stride,
            tuple(preview_pixels.shape),
        )

    except MemoryError:
        raise VolumeBuilderMemoryError() from None

    check_cancelled(cancel_event)

    return PreparedVolume(
        voxels=preview_pixels,
        geometry=preview_geometry,
        level=level,
        is_preview=True,
        source_shape_zyx=source.source_shape_zyx,
        stride_zyx=tuple(
            a * b
            for a, b in zip(
                source.stride_zyx,
                stride,
            )
        ),
    )


# ============================================================
# 10 — PREVIEW PYRAMID
# ============================================================

def build_preview_pyramid(
    full: PreparedVolume,
    settings: AppSettings | None = None,
    *,
    cancel_event: threading.Event | None = None,
) -> tuple[PreparedVolume, ...]:
    """
    Prepare low-resolution volume levels.

    Limits follow settings.yaml max preview dimension.
    Identical shapes are not duplicated.

    Preview memory is released with the containing package.
    """

    active = settings if settings is not None else get_settings()

    preview_config = active.dicom.volume.preview

    if not preview_config.enabled:
        return ()

    limits = sorted(set(
        min(dimension, preview_config.max_dimension)
        for dimension in DEFAULT_PREVIEW_DIMENSIONS
    ))

    previews: list[PreparedVolume] = []
    seen_shapes: set[tuple[int, int, int]] = set()

    for max_dimension in limits:
        check_cancelled(cancel_event)

        stride = calculate_preview_stride(
            full.shape_zyx,
            max_dimension,
        )

        shape = preview_shape(
            full.shape_zyx,
            stride,
        )

        # Do not duplicate the full-resolution volume.
        if shape == full.shape_zyx:
            continue

        if shape in seen_shapes:
            continue

        level = len(previews) + 1

        preview = build_preview_volume(
            full,
            max_dimension=max_dimension,
            level=level,
            settings=active,
            cancel_event=cancel_event,
        )

        previews.append(preview)
        seen_shapes.add(preview.shape_zyx)

    return tuple(previews)


# ============================================================
# 11 — BUILD PACKAGE FROM LOADED SERIES
# ============================================================

def package_loaded_volume(
    series_volume: SeriesVolume,
    settings: AppSettings | None = None,
    *,
    cancel_event: threading.Event | None = None,
) -> VolumePackage:
    """
    Package an existing volume without reading DICOM files.
    """

    active = settings if settings is not None else get_settings()

    check_cancelled(cancel_event)

    full = prepare_full_volume(series_volume)

    previews = build_preview_pyramid(
        full,
        active,
        cancel_event=cancel_event,
    )

    check_cancelled(cancel_event)

    return VolumePackage(
        full=full,
        previews=previews,
    )


# ============================================================
# 12 — COMPLETE DICOM-TO-VOLUME PIPELINE
# ============================================================

def build_volume_package(
    instances: Sequence[DicomMetadata],
    settings: AppSettings | None = None,
    *,
    hardware_snapshot: HardwareSnapshot | None = None,
    cancel_event: threading.Event | None = None,
    progress_callback: ProgressCallback | None = None,
) -> VolumePackage:
    """
    Read one validated conventional DICOM series and
    generate full-resolution plus available preview levels.

    The source reader enforces dataset path protection,
    geometric validation and full-volume memory checks.

    No DICOM source data is modified.
    """

    active = settings if settings is not None else get_settings()

    check_cancelled(cancel_event)

    snapshot = (
        hardware_snapshot
        if hardware_snapshot is not None
        else detect_hardware(active)
    )

    loaded = load_series_volume(
        instances,
        active,
        hardware_snapshot=snapshot,
        cancel_event=cancel_event,
        progress_callback=progress_callback,
    )

    check_cancelled(cancel_event)

    return package_loaded_volume(
        loaded,
        active,
        cancel_event=cancel_event,
    )


# ============================================================
# 13 — LEVEL DESCRIPTORS
# ============================================================

def describe_volume_level(
    volume: PreparedVolume,
) -> dict:
    """
    Technical descriptor for an authenticated API.

    No pixel buffer, patient identifiers or source paths.
    """

    return {
        **volume.safe_summary(),
        "geometry": build_geometry_report(
            volume.geometry
        ),
        "byte_order": "little",
        "axis_order": "zyx",
        "pixel_encoding": "float32",
        "compression": "none",
    }


def describe_volume_package(
    package: VolumePackage,
) -> dict:
    """
    Return available level descriptions.

    Actual volume bytes must be served via a separate
    authenticated, bounded streaming endpoint.
    """

    return {
        "format": "sinus-viewer-volume-v1",
        "coordinate_system": "LPS",
        "levels": [
            describe_volume_level(volume)
            for volume in package.all_levels()
        ],
    }


# ============================================================
# 14 — RAW PIXEL VIEW
# ============================================================

def get_volume_byte_view(
    volume: PreparedVolume,
) -> memoryview:
    """
    Return a read-only view over contiguous float32 bytes.

    The API layer must:
    - Authenticate and authorize every request.
    - Enforce bounded response sizes.
    - Set no-store cache headers.
    - Keep references alive while streaming.

    No network response is sent by this function.
    """

    data = volume.voxels

    if (
        data.dtype != np.dtype("float32")
        or data.ndim != 3
        or not data.flags.c_contiguous
    ):
        raise VolumeBuilderGeometryError()

    # A bytes view is read-only and does not modify pixels.
    return memoryview(data).cast("B").toreadonly()


# ============================================================
# 15 — CAPABILITY REPORT
# ============================================================

def get_volume_builder_capabilities() -> dict:
    return {
        "full_resolution": True,
        "preview_pyramid": True,
        "preview_method": "integer_stride_subsampling",
        "preview_diagnostic_quality": False,
        "preview_without_full_volume": False,
        "input_axis_order": "zyx",
        "pixel_encoding": "float32",
        "coordinate_system": "LPS",
        "geometry_preserved": True,
        "read_only_source": True,
        "gpu_preprocessing": False,
        "browser_streaming_endpoint": False,
    }


# ============================================================
# END OF VOLUME BUILDER
# ============================================================
