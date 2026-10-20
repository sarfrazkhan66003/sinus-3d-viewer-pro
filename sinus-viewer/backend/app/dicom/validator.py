
"""
SINUS VIEWER — DICOM VALIDATION ENGINE
======================================

Responsibilities:
- Validate DICOM image metadata.
- Validate physical image geometry.
- Verify consistency within a scan series.
- Detect duplicate and irregular slice positions.
- Calculate geometry-based slice ordering.
- Estimate memory requirements.
- Reject unsafe 3D reconstruction candidates.
- Produce privacy-safe validation reports.

Important:
- No DICOM files are opened by this module.
- No original dataset files are modified.
- Validation does not decode pixel data.
- Enhanced multiframe geometry requires a separate reader.
- Validation PASS does not certify diagnostic correctness.

Python 3.10+
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from enum import Enum
from typing import Iterable, Sequence

from .metadata import DicomMetadata, DicomGeometry
from ..core.config import AppSettings, get_settings


# ============================================================
# 01 — CONSTANTS
# ============================================================

ORIENTATION_TOLERANCE = 1e-4
SPACING_RELATIVE_TOLERANCE = 1e-3
MIN_POSITION_TOLERANCE_MM = 1e-4

SUPPORTED_SCALAR_PHOTOMETRIC = frozenset({
    "MONOCHROME1",
    "MONOCHROME2",
})

SUPPORTED_PIXEL_BITS = frozenset({
    8,
    16,
    32,
})


# ============================================================
# 02 — VALIDATION ENUMS
# ============================================================

class ValidationSeverity(str, Enum):
    INFO = "info"
    WARNING = "warning"
    ERROR = "error"


class ValidationCode(str, Enum):
    EMPTY_SERIES = "EMPTY_SERIES"
    INSUFFICIENT_SLICES = "INSUFFICIENT_SLICES"

    INVALID_DIMENSIONS = "INVALID_DIMENSIONS"
    MIXED_DIMENSIONS = "MIXED_DIMENSIONS"

    INVALID_PIXEL_FORMAT = "INVALID_PIXEL_FORMAT"
    MIXED_PIXEL_FORMAT = "MIXED_PIXEL_FORMAT"

    MISSING_SERIES_UID = "MISSING_SERIES_UID"
    MIXED_SERIES_UID = "MIXED_SERIES_UID"
    MIXED_STUDY_UID = "MIXED_STUDY_UID"
    MIXED_FRAME_OF_REFERENCE = "MIXED_FRAME_OF_REFERENCE"

    MISSING_GEOMETRY = "MISSING_GEOMETRY"
    INVALID_ORIENTATION = "INVALID_ORIENTATION"
    MIXED_ORIENTATION = "MIXED_ORIENTATION"
    INVALID_PIXEL_SPACING = "INVALID_PIXEL_SPACING"
    MIXED_PIXEL_SPACING = "MIXED_PIXEL_SPACING"

    DUPLICATE_SLICE_POSITION = "DUPLICATE_SLICE_POSITION"
    IRREGULAR_SLICE_SPACING = "IRREGULAR_SLICE_SPACING"
    INPLANE_POSITION_DRIFT = "INPLANE_POSITION_DRIFT"

    MULTIFRAME_GEOMETRY_REQUIRED = (
        "MULTIFRAME_GEOMETRY_REQUIRED"
    )

    VOLUME_LIMIT_EXCEEDED = "VOLUME_LIMIT_EXCEEDED"


# ============================================================
# 03 — IMMUTABLE REPORT MODELS
# ============================================================

@dataclass(frozen=True)
class ValidationIssue:
    code: ValidationCode
    severity: ValidationSeverity
    message: str


@dataclass(frozen=True)
class SeriesGeometrySummary:
    rows: int
    columns: int
    slice_count: int
    pixel_spacing: tuple[float, float]
    slice_spacing_mm: float
    orientation: tuple[float, ...]
    first_position: tuple[float, float, float]

    # Sorted source indices in the original input sequence.
    sorted_indices: tuple[int, ...]


@dataclass(frozen=True)
class SeriesValidationReport:
    valid: bool
    volume_ready: bool
    file_count: int
    frame_count: int
    issues: tuple[ValidationIssue, ...]
    geometry: SeriesGeometrySummary | None

    @property
    def error_count(self) -> int:
        return sum(
            issue.severity == ValidationSeverity.ERROR
            for issue in self.issues
        )

    @property
    def warning_count(self) -> int:
        return sum(
            issue.severity == ValidationSeverity.WARNING
            for issue in self.issues
        )

    def safe_summary(self) -> dict:
        """
        Excludes filenames, paths, UIDs and patient identifiers.
        """

        return {
            "valid": self.valid,
            "volume_ready": self.volume_ready,
            "file_count": self.file_count,
            "frame_count": self.frame_count,
            "error_count": self.error_count,
            "warning_count": self.warning_count,
            "issues": [
                {
                    "code": issue.code.value,
                    "severity": issue.severity.value,
                    "message": issue.message,
                }
                for issue in self.issues
            ],
        }


# ============================================================
# 04 — VECTOR MATH HELPERS
# ============================================================

def dot(
    a: Sequence[float],
    b: Sequence[float],
) -> float:
    return sum(x * y for x, y in zip(a, b))


def subtract(
    a: Sequence[float],
    b: Sequence[float],
) -> tuple[float, float, float]:
    return (
        a[0] - b[0],
        a[1] - b[1],
        a[2] - b[2],
    )


def cross(
    a: Sequence[float],
    b: Sequence[float],
) -> tuple[float, float, float]:
    return (
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    )


def norm(values: Sequence[float]) -> float:
    return math.sqrt(dot(values, values))


def normalize(
    values: Sequence[float],
) -> tuple[float, float, float]:
    magnitude = norm(values)

    if not math.isfinite(magnitude) or magnitude <= 0:
        raise ValueError("Invalid direction vector.")

    return tuple(value / magnitude for value in values)


def are_close(
    a: float,
    b: float,
    *,
    absolute: float,
    relative: float = 0.0,
) -> bool:
    return math.isclose(
        a,
        b,
        abs_tol=absolute,
        rel_tol=relative,
    )


# ============================================================
# 05 — ISSUE HELPER
# ============================================================

def make_issue(
    code: ValidationCode,
    severity: ValidationSeverity = ValidationSeverity.ERROR,
) -> ValidationIssue:
    """
    Standardized issue descriptions.

    No raw metadata values are inserted into messages.
    """

    descriptions = {
        ValidationCode.EMPTY_SERIES:
            "No DICOM image instances were provided.",

        ValidationCode.INSUFFICIENT_SLICES:
            "Not enough slices are available for 3D reconstruction.",

        ValidationCode.INVALID_DIMENSIONS:
            "An image has invalid dimensions.",

        ValidationCode.MIXED_DIMENSIONS:
            "The scan contains inconsistent image dimensions.",

        ValidationCode.INVALID_PIXEL_FORMAT:
            "An image has unsupported pixel metadata.",

        ValidationCode.MIXED_PIXEL_FORMAT:
            "The scan contains inconsistent pixel formats.",

        ValidationCode.MISSING_SERIES_UID:
            "A required series identifier is missing.",

        ValidationCode.MIXED_SERIES_UID:
            "Images from different series were mixed.",

        ValidationCode.MIXED_STUDY_UID:
            "Images from different studies were mixed.",

        ValidationCode.MIXED_FRAME_OF_REFERENCE:
            "Images use different frames of reference.",

        ValidationCode.MISSING_GEOMETRY:
            "Required spatial metadata is missing.",

        ValidationCode.INVALID_ORIENTATION:
            "Image orientation vectors are invalid.",

        ValidationCode.MIXED_ORIENTATION:
            "The scan contains inconsistent orientations.",

        ValidationCode.INVALID_PIXEL_SPACING:
            "Pixel spacing is missing or invalid.",

        ValidationCode.MIXED_PIXEL_SPACING:
            "Pixel spacing differs across images.",

        ValidationCode.DUPLICATE_SLICE_POSITION:
            "Multiple slices have the same spatial position.",

        ValidationCode.IRREGULAR_SLICE_SPACING:
            "Slice spacing is not uniform.",

        ValidationCode.INPLANE_POSITION_DRIFT:
            "Slice origins shift unexpectedly within the image plane.",

        ValidationCode.MULTIFRAME_GEOMETRY_REQUIRED:
            "Multiframe geometry requires specialized validation.",

        ValidationCode.VOLUME_LIMIT_EXCEEDED:
            "The reconstructed volume exceeds configured limits.",
    }

    return ValidationIssue(
        code=code,
        severity=severity,
        message=descriptions[code],
    )


# ============================================================
# 06 — INDIVIDUAL IMAGE VALIDATION
# ============================================================

def validate_image_metadata(
    metadata: DicomMetadata,
) -> tuple[ValidationIssue, ...]:
    issues: list[ValidationIssue] = []

    geometry = metadata.geometry
    pixels = metadata.pixels

    if (
        geometry.rows is None
        or geometry.columns is None
        or geometry.rows <= 0
        or geometry.columns <= 0
    ):
        issues.append(
            make_issue(ValidationCode.INVALID_DIMENSIONS)
        )

    if (
        pixels.samples_per_pixel != 1
        or pixels.photometric_interpretation
        not in SUPPORTED_SCALAR_PHOTOMETRIC
        or pixels.bits_allocated not in SUPPORTED_PIXEL_BITS
        or pixels.bits_stored is None
        or pixels.bits_stored <= 0
        or (
            pixels.bits_allocated is not None
            and pixels.bits_stored > pixels.bits_allocated
        )
        or pixels.pixel_representation not in (0, 1)
    ):
        issues.append(
            make_issue(ValidationCode.INVALID_PIXEL_FORMAT)
        )

    if metadata.series_uid is None:
        issues.append(
            make_issue(ValidationCode.MISSING_SERIES_UID)
        )

    spacing = geometry.pixel_spacing

    if (
        spacing is None
        or len(spacing) != 2
        or any(
            not math.isfinite(value) or value <= 0
            for value in spacing
        )
    ):
        issues.append(
            make_issue(ValidationCode.INVALID_PIXEL_SPACING)
        )

    if (
        geometry.image_position is None
        or geometry.image_orientation is None
    ):
        issues.append(
            make_issue(ValidationCode.MISSING_GEOMETRY)
        )
    elif not valid_orientation(
        geometry.image_orientation
    ):
        issues.append(
            make_issue(ValidationCode.INVALID_ORIENTATION)
        )

    if metadata.pixels.frames > 1:
        issues.append(
            make_issue(
                ValidationCode.MULTIFRAME_GEOMETRY_REQUIRED
            )
        )

    return tuple(issues)


# ============================================================
# 07 — ORIENTATION VALIDATION
# ============================================================

def valid_orientation(
    orientation: Sequence[float],
) -> bool:
    if len(orientation) != 6:
        return False

    if not all(math.isfinite(v) for v in orientation):
        return False

    row = orientation[:3]
    column = orientation[3:]

    return (
        are_close(
            norm(row),
            1.0,
            absolute=ORIENTATION_TOLERANCE,
        )
        and are_close(
            norm(column),
            1.0,
            absolute=ORIENTATION_TOLERANCE,
        )
        and are_close(
            dot(row, column),
            0.0,
            absolute=ORIENTATION_TOLERANCE,
        )
    )


def slice_normal(
    orientation: Sequence[float],
) -> tuple[float, float, float]:
    if not valid_orientation(orientation):
        raise ValueError("Invalid image orientation.")

    return normalize(
        cross(
            orientation[:3],
            orientation[3:],
        )
    )


# ============================================================
# 08 — SERIES VALIDATION
# ============================================================

def validate_series(
    instances: Iterable[DicomMetadata],
    settings: AppSettings | None = None,
) -> SeriesValidationReport:
    """
    Validate a conventional single-frame DICOM series.

    This routine never changes the input collection and does
    not load pixel data.
    """

    active = settings if settings is not None else get_settings()

    images = tuple(instances)
    issues: list[ValidationIssue] = []

    def add(
        code: ValidationCode,
        severity: ValidationSeverity = ValidationSeverity.ERROR,
    ) -> None:
        if not any(issue.code == code for issue in issues):
            issues.append(make_issue(code, severity))

    if not images:
        add(ValidationCode.EMPTY_SERIES)

        return SeriesValidationReport(
            valid=False,
            volume_ready=False,
            file_count=0,
            frame_count=0,
            issues=tuple(issues),
            geometry=None,
        )

    frame_count = sum(max(1, m.pixels.frames) for m in images)

    for image in images:
        for issue in validate_image_metadata(image):
            add(issue.code, issue.severity)

    if frame_count < active.dicom.series.minimum_slices_for_volume:
        add(ValidationCode.INSUFFICIENT_SLICES)

    study_uids = {m.study_uid for m in images}
    series_uids = {m.series_uid for m in images}
    frame_uids = {m.frame_of_reference_uid for m in images}

    if len(study_uids) > 1:
        add(ValidationCode.MIXED_STUDY_UID)

    if len(series_uids) > 1:
        add(ValidationCode.MIXED_SERIES_UID)

    if len(frame_uids) > 1:
        add(ValidationCode.MIXED_FRAME_OF_REFERENCE)

    rows = {m.geometry.rows for m in images}
    columns = {m.geometry.columns for m in images}

    if len(rows) > 1 or len(columns) > 1:
        add(ValidationCode.MIXED_DIMENSIONS)

    pixel_formats = {
        (
            m.pixels.samples_per_pixel,
            m.pixels.photometric_interpretation,
            m.pixels.bits_allocated,
            m.pixels.bits_stored,
            m.pixels.pixel_representation,
        )
        for m in images
    }

    if len(pixel_formats) > 1:
        add(ValidationCode.MIXED_PIXEL_FORMAT)

    if any(m.pixels.frames > 1 for m in images):
        return SeriesValidationReport(
            valid=False,
            volume_ready=False,
            file_count=len(images),
            frame_count=frame_count,
            issues=tuple(issues),
            geometry=None,
        )

    # Spatial validation requires every slice to have
    # consistent orientation, spacing and position.

    if any(
        not m.geometry.geometry_complete
        or not valid_orientation(
            m.geometry.image_orientation or ()
        )
        for m in images
    ):
        add(ValidationCode.MISSING_GEOMETRY)

        return SeriesValidationReport(
            valid=False,
            volume_ready=False,
            file_count=len(images),
            frame_count=frame_count,
            issues=tuple(issues),
            geometry=None,
        )

    reference = images[0].geometry

    reference_orientation = reference.image_orientation
    reference_spacing = reference.pixel_spacing

    assert reference_orientation is not None
    assert reference_spacing is not None

    for image in images[1:]:
        geometry = image.geometry

        if any(
            not are_close(
                a,
                b,
                absolute=ORIENTATION_TOLERANCE,
            )
            for a, b in zip(
                reference_orientation,
                geometry.image_orientation or (),
            )
        ):
            add(ValidationCode.MIXED_ORIENTATION)

        if any(
            not are_close(
                a,
                b,
                absolute=1e-5,
                relative=SPACING_RELATIVE_TOLERANCE,
            )
            for a, b in zip(
                reference_spacing,
                geometry.pixel_spacing or (),
            )
        ):
            add(ValidationCode.MIXED_PIXEL_SPACING)

    if any(
        issue.severity == ValidationSeverity.ERROR
        for issue in issues
    ):
        return SeriesValidationReport(
            valid=False,
            volume_ready=False,
            file_count=len(images),
            frame_count=frame_count,
            issues=tuple(issues),
            geometry=None,
        )

    normal = slice_normal(reference_orientation)

    # Project image origins onto the reference slice normal.
    projections = []

    for index, image in enumerate(images):
        position = image.geometry.image_position

        assert position is not None

        projections.append(
            (dot(position, normal), index, position)
        )

    projections.sort(key=lambda item: item[0])

    # Validate consecutive slice separations.
    differences = [
        projections[i + 1][0] - projections[i][0]
        for i in range(len(projections) - 1)
    ]

    tolerance = max(
        MIN_POSITION_TOLERANCE_MM,
        active.dicom.series.slice_spacing_tolerance_mm,
    )

    if any(delta <= tolerance for delta in differences):
        add(ValidationCode.DUPLICATE_SLICE_POSITION)

    positive_deltas = [
        delta for delta in differences
        if delta > tolerance
    ]

    slice_spacing = (
        sorted(positive_deltas)[len(positive_deltas) // 2]
        if positive_deltas
        else 0.0
    )

    if positive_deltas and any(
        abs(delta - slice_spacing) > tolerance
        for delta in positive_deltas
    ):
        add(ValidationCode.IRREGULAR_SLICE_SPACING)

    # Detect origins shifting within the image plane.
    # Oblique but parallel image stacks remain supported.
    first_position = projections[0][2]

    for _, _, position in projections[1:]:
        displacement = subtract(position, first_position)
        normal_component = dot(displacement, normal)

        in_plane = tuple(
            displacement[i] - normal_component * normal[i]
            for i in range(3)
        )

        if norm(in_plane) > tolerance:
            add(ValidationCode.INPLANE_POSITION_DRIFT)
            break

    # Estimated raw volume memory.
    bits = images[0].pixels.bits_allocated or 16
    bytes_per_voxel = max(1, math.ceil(bits / 8))

    voxel_count = (
        (reference.rows or 0)
        * (reference.columns or 0)
        * len(images)
    )

    raw_bytes = voxel_count * bytes_per_voxel

    if (
        voxel_count > active.dicom.volume.max_voxels
        or raw_bytes >
        active.dicom.volume.max_uncompressed_volume_mb
        * 1024 * 1024
    ):
        add(ValidationCode.VOLUME_LIMIT_EXCEEDED)

    valid = not any(
        issue.severity == ValidationSeverity.ERROR
        for issue in issues
    )

    geometry_summary = None

    if valid:
        geometry_summary = SeriesGeometrySummary(
            rows=reference.rows,
            columns=reference.columns,
            slice_count=len(images),
            pixel_spacing=reference_spacing,
            slice_spacing_mm=slice_spacing,
            orientation=reference_orientation,
            first_position=first_position,
            sorted_indices=tuple(
                item[1] for item in projections
            ),
        )

    return SeriesValidationReport(
        valid=valid,
        volume_ready=valid,
        file_count=len(images),
        frame_count=frame_count,
        issues=tuple(issues),
        geometry=geometry_summary,
    )


# ============================================================
# 09 — RECONSTRUCTION GATE
# ============================================================

def require_valid_series(
    report: SeriesValidationReport,
) -> SeriesGeometrySummary:
    """
    Prevent invalid series from reaching volume reconstruction.
    """

    if not report.volume_ready or report.geometry is None:
        raise ValueError(
            "DICOM series failed spatial validation."
        )

    return report.geometry


# ============================================================
# END OF VALIDATION ENGINE
# ============================================================
