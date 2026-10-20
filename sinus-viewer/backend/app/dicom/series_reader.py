
"""
SINUS VIEWER — DICOM SERIES READER
==================================

Reads a validated conventional single-frame DICOM series
into a geometry-ordered NumPy volume.

Features:
- Strict read-only DICOM access
- Geometry-based slice ordering
- Series and instance identity checks
- Compressed DICOM decoding through pydicom plugins
- Memory/resource preflight checks
- Modality rescale slope/intercept support
- Cancellation and progress callbacks
- Safe error categories without patient information
- No dataset writes, moves, renames or deletions

Limitations:
- Conventional, single-frame monochrome images only
- Enhanced multiframe data requires a separate reader
- Unsupported tilted/sheared/nonuniform stacks are rejected
- Diagnostic correctness requires integration testing

All dependencies are installed later in Google Colab.
"""

from __future__ import annotations

import math
import threading
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Callable, Sequence

import numpy as np
import pydicom
from pydicom.errors import InvalidDicomError

from ..core.config import AppSettings, get_settings
from ..core.hardware import (
    HardwareSnapshot,
    VolumeLoadMode,
    detect_hardware,
    estimate_volume_memory,
    evaluate_volume_load,
)
from .metadata import (
    DicomMetadata,
    validate_dicom_path,
)
from .validator import (
    SeriesGeometrySummary,
    SeriesValidationReport,
    require_valid_series,
    validate_series,
)


# ============================================================
# 01 — CONSTANTS AND TYPES
# ============================================================

OUTPUT_DTYPE = np.dtype("float32")
OUTPUT_BYTES_PER_VOXEL = 4

ReaderProgress = Callable[[int, int], None]


class ReaderErrorCode(str, Enum):
    INVALID_SERIES = "SERIES_INVALID"
    INVALID_GEOMETRY = "GEOMETRY_INVALID"
    INVALID_DICOM = "DICOM_INVALID"
    DECODER_FAILED = "DECODER_ERROR"
    UNSUPPORTED = "DICOM_UNSUPPORTED"
    MEMORY_LIMIT = "OUT_OF_MEMORY"
    CANCELLED = "SCAN_CANCELLED"
    SOURCE_CHANGED = "SOURCE_CHANGED"


# ============================================================
# 02 — CONTROLLED EXCEPTIONS
# ============================================================

class SeriesReaderError(RuntimeError):
    """
    Safe reader exception.

    Raw file paths, patient identifiers and decoder
    exception messages must never be embedded.
    """

    def __init__(
        self,
        code: ReaderErrorCode,
    ) -> None:
        self.code = code
        super().__init__(code.value)


class SeriesValidationFailure(SeriesReaderError):
    def __init__(self) -> None:
        super().__init__(
            ReaderErrorCode.INVALID_SERIES
        )


class SeriesDecodeFailure(SeriesReaderError):
    def __init__(self) -> None:
        super().__init__(
            ReaderErrorCode.DECODER_FAILED
        )


class SeriesMemoryFailure(SeriesReaderError):
    def __init__(self) -> None:
        super().__init__(
            ReaderErrorCode.MEMORY_LIMIT
        )


class SeriesReadCancelled(SeriesReaderError):
    def __init__(self) -> None:
        super().__init__(
            ReaderErrorCode.CANCELLED
        )


# ============================================================
# 03 — IMMUTABLE RESULT MODELS
# ============================================================

@dataclass(frozen=True)
class SeriesReadPlan:
    ordered_instances: tuple[DicomMetadata, ...] = field(
        repr=False
    )

    validation: SeriesValidationReport = field(
        repr=False
    )

    geometry: SeriesGeometrySummary = field(
        repr=False
    )

    shape_zyx: tuple[int, int, int]
    dtype: str
    estimated_raw_bytes: int
    estimated_peak_bytes: int
    estimated_peak_gib: float

    def safe_summary(self) -> dict:
        return {
            "shape_zyx": list(self.shape_zyx),
            "dtype": self.dtype,
            "slice_count": self.shape_zyx[0],
            "estimated_raw_bytes": self.estimated_raw_bytes,
            "estimated_peak_gib": self.estimated_peak_gib,
            "volume_ready": self.validation.volume_ready,
        }


@dataclass(frozen=True)
class SeriesVolume:
    """
    Loaded image data.

    Array shape is (Z, Y, X).
    Spatial orientation remains in DICOM LPS coordinates.

    The array is marked non-writable after construction.
    This protects in-memory pixels, not filesystem access.
    """

    voxels: np.ndarray = field(repr=False)

    geometry: SeriesGeometrySummary = field(repr=False)

    shape_zyx: tuple[int, int, int]
    dtype: str
    spacing_zyx_mm: tuple[float, float, float]

    origin_lps: tuple[float, float, float]
    direction_lps: tuple[float, ...]

    modality_values_applied: bool

    @property
    def size_bytes(self) -> int:
        return int(self.voxels.nbytes)

    def safe_summary(self) -> dict:
        return {
            "shape_zyx": list(self.shape_zyx),
            "dtype": self.dtype,
            "size_bytes": self.size_bytes,
            "spacing_zyx_mm": list(self.spacing_zyx_mm),
            "modality_values_applied": (
                self.modality_values_applied
            ),
        }


# ============================================================
# 04 — CANCELLATION
# ============================================================

def check_cancelled(
    cancel_event: threading.Event | None,
) -> None:
    if (
        cancel_event is not None
        and cancel_event.is_set()
    ):
        raise SeriesReadCancelled()


# ============================================================
# 05 — PREPARE GEOMETRY-ORDERED SERIES
# ============================================================

def prepare_series_read(
    instances: Sequence[DicomMetadata],
    settings: AppSettings | None = None,
) -> SeriesReadPlan:
    """
    Validate and order instances without reading pixels.

    The validator determines slice order using physical
    positions projected onto the orientation-derived normal.
    """

    active = settings if settings is not None else get_settings()

    images = tuple(instances)

    if not images:
        raise SeriesValidationFailure()

    validation = validate_series(
        images,
        active,
    )

    if not validation.volume_ready:
        raise SeriesValidationFailure()

    try:
        geometry = require_valid_series(validation)
    except ValueError:
        raise SeriesValidationFailure() from None

    # Enhanced multiframe data is not supported here.
    if any(image.pixels.frames != 1 for image in images):
        raise SeriesReaderError(
            ReaderErrorCode.UNSUPPORTED
        )

    ordered = tuple(
        images[index]
        for index in geometry.sorted_indices
    )

    # Float32 output is used so modality rescale transforms
    # can be applied consistently, including per-slice values.
    depth = len(ordered)
    height = geometry.rows
    width = geometry.columns

    estimate = estimate_volume_memory(
        width=width,
        height=height,
        depth=depth,
        dtype="float32",
        working_memory_multiplier=3.0,
    )

    return SeriesReadPlan(
        ordered_instances=ordered,
        validation=validation,
        geometry=geometry,
        shape_zyx=(depth, height, width),
        dtype="float32",
        estimated_raw_bytes=estimate.raw_bytes,
        estimated_peak_bytes=estimate.estimated_peak_bytes,
        estimated_peak_gib=estimate.estimated_peak_gib,
    )


# ============================================================
# 06 — MEMORY PRECHECK
# ============================================================

def check_volume_memory(
    plan: SeriesReadPlan,
    snapshot: HardwareSnapshot,
    settings: AppSettings | None = None,
) -> None:
    """
    Block loading before allocation if the full volume
    exceeds configured size or current RAM limits.

    Preview-only mode is reported to the caller.
    It is not silently substituted for full resolution.
    """

    active = settings if settings is not None else get_settings()

    depth, height, width = plan.shape_zyx

    estimate = estimate_volume_memory(
        width=width,
        height=height,
        depth=depth,
        dtype="float32",
        working_memory_multiplier=3.0,
    )

    decision = evaluate_volume_load(
        estimate,
        snapshot,
        active,
    )

    if decision.mode != VolumeLoadMode.FULL:
        raise SeriesMemoryFailure()


# ============================================================
# 07 — SOURCE INTEGRITY
# ============================================================

def verify_instance_identity(
    dataset: pydicom.dataset.Dataset,
    metadata: DicomMetadata,
) -> None:
    """
    Verify selected DICOM identity and dimensions.

    This detects obvious changes between metadata indexing
    and pixel decoding. It is not a cryptographic file
    integrity verification.
    """

    comparisons = (
        (
            "StudyInstanceUID",
            metadata.study_uid,
        ),
        (
            "SeriesInstanceUID",
            metadata.series_uid,
        ),
        (
            "SOPInstanceUID",
            metadata.sop_instance_uid,
        ),
    )

    for attribute, expected in comparisons:
        actual = getattr(dataset, attribute, None)

        if expected is not None:
            if actual is None or str(actual) != expected:
                raise SeriesReaderError(
                    ReaderErrorCode.SOURCE_CHANGED
                )

    geometry = metadata.geometry

    if (
        int(getattr(dataset, "Rows", -1))
        != geometry.rows
        or int(getattr(dataset, "Columns", -1))
        != geometry.columns
    ):
        raise SeriesReaderError(
            ReaderErrorCode.SOURCE_CHANGED
        )

    if int(getattr(dataset, "NumberOfFrames", 1)) != 1:
        raise SeriesReaderError(
            ReaderErrorCode.UNSUPPORTED
        )


# ============================================================
# 08 — SPATIAL HEADER RECHECK
# ============================================================

def verify_instance_geometry(
    dataset: pydicom.dataset.Dataset,
    metadata: DicomMetadata,
) -> None:
    """
    Compare spatial tags against the indexed metadata.

    The dedicated geometry module will provide more advanced
    physical-coordinate transformations later.
    """

    expected = metadata.geometry

    fields = (
        (
            "ImagePositionPatient",
            expected.image_position,
        ),
        (
            "ImageOrientationPatient",
            expected.image_orientation,
        ),
        (
            "PixelSpacing",
            expected.pixel_spacing,
        ),
    )

    for attribute, reference in fields:
        actual = getattr(dataset, attribute, None)

        if reference is None or actual is None:
            raise SeriesReaderError(
                ReaderErrorCode.INVALID_GEOMETRY
            )

        try:
            values = tuple(float(value) for value in actual)
        except (TypeError, ValueError, OverflowError):
            raise SeriesReaderError(
                ReaderErrorCode.INVALID_GEOMETRY
            ) from None

        if (
            len(values) != len(reference)
            or not all(
                math.isfinite(a)
                and math.isclose(
                    a,
                    b,
                    rel_tol=1e-5,
                    abs_tol=1e-4,
                )
                for a, b in zip(values, reference)
            )
        ):
            raise SeriesReaderError(
                ReaderErrorCode.SOURCE_CHANGED
            )


# ============================================================
# 09 — DECODE ONE SLICE
# ============================================================

def decode_single_slice(
    metadata: DicomMetadata,
    settings: AppSettings,
) -> np.ndarray:
    """
    Read and decode one image in read-only mode.

    The DICOM dataset is never saved or modified.
    """

    safe_path = validate_dicom_path(
        metadata.source_path,
        settings.storage.dataset.root_path,
    )

    try:
        with safe_path.open("rb") as stream:
            dataset = pydicom.dcmread(
                stream,
                force=False,
            )

        verify_instance_identity(
            dataset,
            metadata,
        )

        verify_instance_geometry(
            dataset,
            metadata,
        )

        # Confirm pixel-related attributes have not changed.
        pixel = metadata.pixels

        header_checks = (
            ("BitsAllocated", pixel.bits_allocated),
            ("BitsStored", pixel.bits_stored),
            ("PixelRepresentation", pixel.pixel_representation),
            ("SamplesPerPixel", pixel.samples_per_pixel),
        )

        for attribute, expected in header_checks:
            if expected is None:
                raise SeriesReaderError(
                    ReaderErrorCode.INVALID_DICOM
                )

            if int(getattr(dataset, attribute, -1)) != expected:
                raise SeriesReaderError(
                    ReaderErrorCode.SOURCE_CHANGED
                )

        photometric = str(
            getattr(
                dataset,
                "PhotometricInterpretation",
                "",
            )
        )

        if photometric != pixel.photometric_interpretation:
            raise SeriesReaderError(
                ReaderErrorCode.SOURCE_CHANGED
            )

        if photometric not in {
            "MONOCHROME1",
            "MONOCHROME2",
        }:
            raise SeriesReaderError(
                ReaderErrorCode.UNSUPPORTED
            )

        # pydicom delegates compressed pixel decoding to
        # installed compatible handlers/plugins.
        decoded = dataset.pixel_array

        if (
            decoded.ndim != 2
            or decoded.shape != (
                metadata.geometry.rows,
                metadata.geometry.columns,
            )
        ):
            raise SeriesReaderError(
                ReaderErrorCode.INVALID_DICOM
            )

        if not np.issubdtype(
            decoded.dtype,
            np.number,
        ):
            raise SeriesReaderError(
                ReaderErrorCode.UNSUPPORTED
            )

        slope = float(
            getattr(
                dataset,
                "RescaleSlope",
                1.0,
            )
        )

        intercept = float(
            getattr(
                dataset,
                "RescaleIntercept",
                0.0,
            )
        )

        if not (
            math.isfinite(slope)
            and math.isfinite(intercept)
        ):
            raise SeriesReaderError(
                ReaderErrorCode.INVALID_DICOM
            )

        # Convert to physical/modality-scaled values.
        # These are not automatically guaranteed to be HU
        # for all CBCT scanners.
        image = np.asarray(
            decoded,
            dtype=OUTPUT_DTYPE,
        )

        image = image * slope + intercept

        if not np.all(np.isfinite(image)):
            raise SeriesReaderError(
                ReaderErrorCode.INVALID_DICOM
            )

        return image

    except SeriesReaderError:
        raise

    except MemoryError:
        raise SeriesMemoryFailure() from None

    except (
        InvalidDicomError,
        OSError,
        ValueError,
        TypeError,
        RuntimeError,
        AttributeError,
        KeyError,
    ):
        raise SeriesDecodeFailure() from None


# ============================================================
# 10 — SPATIAL DIRECTION MATRIX
# ============================================================

def build_direction_lps(
    geometry: SeriesGeometrySummary,
) -> tuple[float, ...]:
    """
    Build a flattened 3x3 direction matrix in row-major form.

    Columns represent increasing X, Y, Z array indices
    in DICOM LPS physical coordinates.
    """

    orientation = geometry.orientation

    row_direction = np.asarray(
        orientation[:3],
        dtype=np.float64,
    )

    column_direction = np.asarray(
        orientation[3:],
        dtype=np.float64,
    )

    normal = np.cross(
        row_direction,
        column_direction,
    )

    matrix = np.column_stack((
        row_direction,
        column_direction,
        normal,
    ))

    if not np.all(np.isfinite(matrix)):
        raise SeriesReaderError(
            ReaderErrorCode.INVALID_GEOMETRY
        )

    return tuple(
        float(value)
        for value in matrix.reshape(-1)
    )


# ============================================================
# 11 — LOAD COMPLETE SERIES
# ============================================================

def load_series_volume(
    instances: Sequence[DicomMetadata],
    settings: AppSettings | None = None,
    *,
    hardware_snapshot: HardwareSnapshot | None = None,
    cancel_event: threading.Event | None = None,
    progress_callback: ReaderProgress | None = None,
) -> SeriesVolume:
    """
    Load one validated conventional DICOM series.

    Processing sequence:
      1. Validate metadata and physical geometry.
      2. Calculate correct spatial slice ordering.
      3. Evaluate memory budget.
      4. Allocate output volume.
      5. Decode slices in physical order.
      6. Apply modality rescale values.
      7. Attach LPS spatial geometry.

    Source files are opened only in read-binary mode.

    No filesystem writes occur.
    """

    active = settings if settings is not None else get_settings()

    check_cancelled(cancel_event)

    plan = prepare_series_read(
        instances,
        active,
    )

    snapshot = (
        hardware_snapshot
        if hardware_snapshot is not None
        else detect_hardware(active)
    )

    check_volume_memory(
        plan,
        snapshot,
        active,
    )

    shape = plan.shape_zyx

    try:
        volume = np.empty(
            shape,
            dtype=OUTPUT_DTYPE,
        )
    except (MemoryError, ValueError):
        raise SeriesMemoryFailure() from None

    try:
        for index, metadata in enumerate(
            plan.ordered_instances
        ):
            check_cancelled(cancel_event)

            image = decode_single_slice(
                metadata,
                active,
            )

            volume[index, :, :] = image

            del image

            if progress_callback is not None:
                progress_callback(
                    index + 1,
                    shape[0],
                )

        check_cancelled(cancel_event)

        geometry = plan.geometry

        direction = build_direction_lps(
            geometry
        )

        spacing = (
            float(geometry.slice_spacing_mm),
            float(geometry.pixel_spacing[0]),
            float(geometry.pixel_spacing[1]),
        )

        if any(
            not math.isfinite(value) or value <= 0
            for value in spacing
        ):
            raise SeriesReaderError(
                ReaderErrorCode.INVALID_GEOMETRY
            )

        volume.setflags(write=False)

        return SeriesVolume(
            voxels=volume,
            geometry=geometry,
            shape_zyx=shape,
            dtype="float32",
            spacing_zyx_mm=spacing,
            origin_lps=geometry.first_position,
            direction_lps=direction,
            modality_values_applied=True,
        )

    except BaseException:
        # Release local output buffer on any failure.
        del volume
        raise


# ============================================================
# 12 — SAFE READER INFORMATION
# ============================================================

def get_series_reader_capabilities() -> dict:
    """
    Non-sensitive description of current reader support.
    """

    return {
        "reader": "conventional_single_frame",
        "supports_ct": True,
        "supports_cbct_when_dicom_compatible": True,
        "supports_multiframe": False,
        "supports_monochrome": True,
        "supports_color": False,
        "supports_compressed_dicom": (
            "when_decoder_plugin_available"
        ),
        "output_dtype": "float32",
        "output_axis_order": "zyx",
        "coordinate_system": "LPS",
        "supports_cancel": True,
        "original_files_read_only": True,
    }


# ============================================================
# END OF DICOM SERIES READER
# ============================================================
