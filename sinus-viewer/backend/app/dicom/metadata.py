
"""
SINUS VIEWER — DICOM METADATA ENGINE
====================================

Purpose:
- Read medical image metadata without decoding pixels.
- Identify studies, series and individual instances.
- Extract geometry information needed for MPR.
- Identify compressed transfer syntaxes.
- Support conventional and multiframe DICOM metadata.
- Return structured results and controlled failures.

Dataset protection:
- Strictly read-only operations.
- No renaming, modification, deletion or writing.
- Reject paths outside the authorized dataset root.
- Reject symlinks along the source path.
- Never place patient identifiers in logs or errors.

Important:
- This module does NOT build 3D volumes.
- This module does NOT establish clinically valid geometry.
- Enhanced multiframe per-frame geometry is handled later.

Python 3.10+
pydicom 3.x
"""

from __future__ import annotations

import math
import os
import stat
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

import pydicom
from pydicom.dataset import Dataset
from pydicom.errors import InvalidDicomError
from pydicom.uid import UID

from ..core.config import AppSettings, get_settings


# ============================================================
# 01 — CONSTANTS
# ============================================================

SUPPORTED_IMAGE_MODALITIES = frozenset({
    "CT",
    "CBCT",
    "DX",
    "CR",
    "OT",
    "XA",
})

DICOM_EXTENSIONS = frozenset({
    ".dcm",
    ".dicom",
    ".ima",
    "",
})

MAX_METADATA_FILE_BYTES = 1024 ** 3 * 4

METADATA_TAGS = [
    "PatientID",
    "PatientName",
    "StudyInstanceUID",
    "SeriesInstanceUID",
    "SOPInstanceUID",
    "SOPClassUID",
    "FrameOfReferenceUID",
    "Modality",
    "Manufacturer",
    "ManufacturerModelName",
    "StudyDescription",
    "SeriesDescription",
    "StudyDate",
    "StudyTime",
    "SeriesNumber",
    "InstanceNumber",
    "Rows",
    "Columns",
    "NumberOfFrames",
    "SamplesPerPixel",
    "PhotometricInterpretation",
    "BitsAllocated",
    "BitsStored",
    "HighBit",
    "PixelRepresentation",
    "PixelSpacing",
    "ImagerPixelSpacing",
    "SliceThickness",
    "SpacingBetweenSlices",
    "ImagePositionPatient",
    "ImageOrientationPatient",
    "RescaleSlope",
    "RescaleIntercept",
    "RescaleType",
    "ImageType",
    "VolumetricProperties",
    "BodyPartExamined",
    "AcquisitionNumber",
    "SliceLocation",
]

MetadataStatus = Literal[
    "ok",
    "invalid",
    "unreadable",
    "unsupported",
]


# ============================================================
# 02 — CONTROLLED ERRORS
# ============================================================

class MetadataError(Exception):
    """Base metadata processing error."""

    public_code = "DICOM_INVALID"

    def __init__(self) -> None:
        super().__init__("DICOM metadata could not be processed.")


class MetadataPathError(MetadataError):
    public_code = "PATH_REJECTED"


class MetadataReadError(MetadataError):
    public_code = "DICOM_INVALID"


class MetadataUnsupportedError(MetadataError):
    public_code = "DICOM_UNSUPPORTED"


# ============================================================
# 03 — STRUCTURED METADATA MODELS
# ============================================================

@dataclass(frozen=True)
class DicomGeometry:
    rows: int | None = None
    columns: int | None = None

    pixel_spacing: tuple[float, float] | None = None
    imager_pixel_spacing: tuple[float, float] | None = None

    image_position: tuple[float, float, float] | None = None

    image_orientation: (
        tuple[float, float, float, float, float, float] | None
    ) = None

    slice_thickness: float | None = None
    spacing_between_slices: float | None = None

    geometry_complete: bool = False


@dataclass(frozen=True)
class DicomPixelInfo:
    frames: int = 1
    samples_per_pixel: int | None = None
    photometric_interpretation: str | None = None

    bits_allocated: int | None = None
    bits_stored: int | None = None
    high_bit: int | None = None
    pixel_representation: int | None = None

    transfer_syntax_uid: str | None = None
    is_compressed: bool | None = None

    rescale_slope: float | None = None
    rescale_intercept: float | None = None
    rescale_type: str | None = None

    @property
    def is_multiframe(self) -> bool:
        return self.frames > 1


@dataclass(frozen=True)
class DicomMetadata:
    # Internal indexing identifiers.
    # Do not serialize this object directly into public API
    # responses, logs or debugging output.

    source_path: Path = field(repr=False)

    patient_id: str | None = field(default=None, repr=False)
    patient_name: str | None = field(default=None, repr=False)

    study_uid: str | None = field(default=None, repr=False)
    series_uid: str | None = field(default=None, repr=False)
    sop_instance_uid: str | None = field(
        default=None,
        repr=False,
    )
    sop_class_uid: str | None = field(
        default=None,
        repr=False,
    )
    frame_of_reference_uid: str | None = field(
        default=None,
        repr=False,
    )

    modality: str | None = None
    manufacturer: str | None = field(default=None, repr=False)
    manufacturer_model: str | None = field(
        default=None,
        repr=False,
    )

    study_description: str | None = field(
        default=None,
        repr=False,
    )
    series_description: str | None = field(
        default=None,
        repr=False,
    )
    study_date: str | None = field(default=None, repr=False)

    series_number: int | None = None
    instance_number: int | None = None

    geometry: DicomGeometry = field(
        default_factory=DicomGeometry
    )

    pixels: DicomPixelInfo = field(
        default_factory=DicomPixelInfo
    )

    file_size_bytes: int = 0

    @property
    def is_volume_candidate(self) -> bool:
        return (
            self.geometry.rows is not None
            and self.geometry.columns is not None
            and self.geometry.rows > 0
            and self.geometry.columns > 0
            and self.modality in SUPPORTED_IMAGE_MODALITIES
        )

    def safe_summary(self) -> dict[str, Any]:
        """
        Non-identifying technical summary only.

        Do not add identifiers, source paths, descriptions
        or manufacturer free text to this response.
        """

        return {
            "modality": self.modality,
            "rows": self.geometry.rows,
            "columns": self.geometry.columns,
            "frames": self.pixels.frames,
            "multiframe": self.pixels.is_multiframe,
            "geometry_complete": (
                self.geometry.geometry_complete
            ),
            "bits_allocated": self.pixels.bits_allocated,
            "compressed": self.pixels.is_compressed,
            "volume_candidate": self.is_volume_candidate,
        }


@dataclass(frozen=True)
class MetadataResult:
    status: MetadataStatus
    metadata: DicomMetadata | None = field(
        default=None,
        repr=False,
    )
    error_code: str | None = None

    @property
    def success(self) -> bool:
        return self.status == "ok" and self.metadata is not None


# ============================================================
# 04 — BASIC FIELD CONVERSION
# ============================================================

def _text(value: Any) -> str | None:
    if value is None:
        return None

    result = str(value).strip()

    return result or None


def _integer(value: Any) -> int | None:
    if value is None:
        return None

    try:
        result = int(value)
    except (TypeError, ValueError, OverflowError):
        return None

    return result


def _float(value: Any) -> float | None:
    if value is None:
        return None

    try:
        result = float(value)
    except (TypeError, ValueError, OverflowError):
        return None

    return result if math.isfinite(result) else None


def _vector(
    value: Any,
    length: int,
) -> tuple[float, ...] | None:
    if value is None:
        return None

    try:
        values = list(value)
    except TypeError:
        return None

    if len(values) != length:
        return None

    converted = tuple(_float(v) for v in values)

    if any(v is None for v in converted):
        return None

    return converted


def _positive_vector(
    value: Any,
    length: int,
) -> tuple[float, ...] | None:
    converted = _vector(value, length)

    if converted is None or any(v <= 0 for v in converted):
        return None

    return converted


# ============================================================
# 05 — SOURCE PATH PROTECTION
# ============================================================

def validate_dicom_path(
    path: str | Path,
    dataset_root: str | Path,
) -> Path:
    """
    Restrict reading to files inside the configured dataset.

    Reject:
    - Paths outside dataset root.
    - Symlinked directory components.
    - Symlinked DICOM files.
    - Missing and non-regular files.

    The later path_guard module will centralize filesystem
    access and handle additional race-condition protections.
    """

    root = Path(dataset_root).expanduser().absolute()
    candidate = Path(path).expanduser().absolute()

    if candidate == root or not candidate.is_relative_to(root):
        raise MetadataPathError()

    # Check the directory chain for symlinks.
    current = root

    try:
        if current.is_symlink():
            raise MetadataPathError()

        relative_parts = candidate.relative_to(root).parts

        for part in relative_parts:
            current = current / part

            if current.is_symlink():
                raise MetadataPathError()

        resolved_root = root.resolve(strict=True)
        resolved_file = candidate.resolve(strict=True)

        if not resolved_file.is_relative_to(resolved_root):
            raise MetadataPathError()

        file_stat = resolved_file.stat()

        if not stat.S_ISREG(file_stat.st_mode):
            raise MetadataPathError()

    except MetadataPathError:
        raise
    except (OSError, RuntimeError, ValueError):
        raise MetadataPathError() from None

    return resolved_file


# ============================================================
# 06 — TRANSFER SYNTAX IDENTIFICATION
# ============================================================

def read_transfer_syntax(
    dataset: Dataset,
) -> tuple[str | None, bool | None]:
    """
    Return (transfer_syntax_uid, compressed).

    Missing transfer syntax is reported as unknown.
    """

    file_meta = getattr(dataset, "file_meta", None)

    if file_meta is None:
        return None, None

    value = getattr(
        file_meta,
        "TransferSyntaxUID",
        None,
    )

    if value is None:
        return None, None

    try:
        uid = UID(str(value))

        return str(uid), bool(uid.is_compressed)
    except (TypeError, ValueError, AttributeError):
        return None, None


# ============================================================
# 07 — GEOMETRY EXTRACTION
# ============================================================

def extract_geometry(dataset: Dataset) -> DicomGeometry:
    rows = _integer(getattr(dataset, "Rows", None))
    columns = _integer(getattr(dataset, "Columns", None))

    spacing = _positive_vector(
        getattr(dataset, "PixelSpacing", None),
        2,
    )

    imager_spacing = _positive_vector(
        getattr(dataset, "ImagerPixelSpacing", None),
        2,
    )

    position = _vector(
        getattr(dataset, "ImagePositionPatient", None),
        3,
    )

    orientation = _vector(
        getattr(dataset, "ImageOrientationPatient", None),
        6,
    )

    thickness = _float(
        getattr(dataset, "SliceThickness", None)
    )

    between_slices = _float(
        getattr(dataset, "SpacingBetweenSlices", None)
    )

    if thickness is not None and thickness <= 0:
        thickness = None

    valid_dimensions = (
        rows is not None
        and columns is not None
        and rows > 0
        and columns > 0
    )

    # Presence is necessary but not sufficient for valid MPR.
    complete = (
        valid_dimensions
        and spacing is not None
        and position is not None
        and orientation is not None
    )

    return DicomGeometry(
        rows=rows,
        columns=columns,
        pixel_spacing=spacing,
        imager_pixel_spacing=imager_spacing,
        image_position=position,
        image_orientation=orientation,
        slice_thickness=thickness,
        spacing_between_slices=between_slices,
        geometry_complete=bool(complete),
    )


# ============================================================
# 08 — PIXEL HEADER EXTRACTION
# ============================================================

def extract_pixel_info(dataset: Dataset) -> DicomPixelInfo:
    transfer_uid, compressed = read_transfer_syntax(dataset)

    frames = _integer(
        getattr(dataset, "NumberOfFrames", None)
    )

    if frames is None or frames < 1:
        frames = 1

    return DicomPixelInfo(
        frames=frames,
        samples_per_pixel=_integer(
            getattr(dataset, "SamplesPerPixel", None)
        ),
        photometric_interpretation=_text(
            getattr(dataset, "PhotometricInterpretation", None)
        ),
        bits_allocated=_integer(
            getattr(dataset, "BitsAllocated", None)
        ),
        bits_stored=_integer(
            getattr(dataset, "BitsStored", None)
        ),
        high_bit=_integer(
            getattr(dataset, "HighBit", None)
        ),
        pixel_representation=_integer(
            getattr(dataset, "PixelRepresentation", None)
        ),
        transfer_syntax_uid=transfer_uid,
        is_compressed=compressed,
        rescale_slope=_float(
            getattr(dataset, "RescaleSlope", None)
        ),
        rescale_intercept=_float(
            getattr(dataset, "RescaleIntercept", None)
        ),
        rescale_type=_text(
            getattr(dataset, "RescaleType", None)
        ),
    )


# ============================================================
# 09 — CONVERT DATASET TO STRUCTURED METADATA
# ============================================================

def extract_metadata(
    dataset: Dataset,
    *,
    source_path: Path,
    file_size_bytes: int,
) -> DicomMetadata:
    """
    Convert a pydicom Dataset to internal structured data.

    Never log or automatically serialize the result.
    """

    return DicomMetadata(
        source_path=source_path,
        patient_id=_text(
            getattr(dataset, "PatientID", None)
        ),
        patient_name=_text(
            getattr(dataset, "PatientName", None)
        ),
        study_uid=_text(
            getattr(dataset, "StudyInstanceUID", None)
        ),
        series_uid=_text(
            getattr(dataset, "SeriesInstanceUID", None)
        ),
        sop_instance_uid=_text(
            getattr(dataset, "SOPInstanceUID", None)
        ),
        sop_class_uid=_text(
            getattr(dataset, "SOPClassUID", None)
        ),
        frame_of_reference_uid=_text(
            getattr(dataset, "FrameOfReferenceUID", None)
        ),
        modality=_text(
            getattr(dataset, "Modality", None)
        ),
        manufacturer=_text(
            getattr(dataset, "Manufacturer", None)
        ),
        manufacturer_model=_text(
            getattr(dataset, "ManufacturerModelName", None)
        ),
        study_description=_text(
            getattr(dataset, "StudyDescription", None)
        ),
        series_description=_text(
            getattr(dataset, "SeriesDescription", None)
        ),
        study_date=_text(
            getattr(dataset, "StudyDate", None)
        ),
        series_number=_integer(
            getattr(dataset, "SeriesNumber", None)
        ),
        instance_number=_integer(
            getattr(dataset, "InstanceNumber", None)
        ),
        geometry=extract_geometry(dataset),
        pixels=extract_pixel_info(dataset),
        file_size_bytes=file_size_bytes,
    )


# ============================================================
# 10 — READ DICOM METADATA
# ============================================================

def read_dicom_metadata(
    path: str | Path,
    settings: AppSettings | None = None,
    *,
    allow_non_part10: bool = False,
) -> DicomMetadata:
    """
    Read DICOM headers without decoding pixel data.

    Strict default:
    - Standard Part-10 files only.
    - Non-Part-10 reading requires explicit opt-in.
    - No arbitrary filesystem paths.
    - No writing or source modification.

    Non-Part-10 parsing may be useful for vendor exports,
    but its success does not prove the file is valid DICOM.
    """

    active = settings if settings is not None else get_settings()

    root = active.storage.dataset.root_path

    safe_path = validate_dicom_path(path, root)

    try:
        file_size = safe_path.stat().st_size

        if file_size <= 0:
            raise MetadataReadError()

        if file_size > MAX_METADATA_FILE_BYTES:
            raise MetadataUnsupportedError()

        # Open source in read-binary mode only.
        # No pixel arrays are accessed.
        with safe_path.open("rb") as stream:
            dataset = pydicom.dcmread(
                stream,
                stop_before_pixels=True,
                force=allow_non_part10,
                specific_tags=METADATA_TAGS,
            )

        # Reject arbitrary binary files that accidentally
        # parse when force=True was explicitly requested.
        if not (
            getattr(dataset, "SOPClassUID", None)
            or getattr(dataset, "Modality", None)
            or getattr(dataset, "Rows", None)
        ):
            raise MetadataReadError()

        metadata = extract_metadata(
            dataset,
            source_path=safe_path,
            file_size_bytes=file_size,
        )

        return metadata

    except (MetadataReadError, MetadataUnsupportedError):
        raise

    except (
        InvalidDicomError,
        OSError,
        EOFError,
        ValueError,
        TypeError,
    ):
        # Never put raw exception strings or file paths
        # into application errors.
        raise MetadataReadError() from None


# ============================================================
# 11 — CONTROLLED RESULT WRAPPER
# ============================================================

def inspect_dicom_metadata(
    path: str | Path,
    settings: AppSettings | None = None,
    *,
    allow_non_part10: bool = False,
) -> MetadataResult:
    """
    Safe wrapper for bulk patient-folder scanning.

    Returns an error code rather than throwing expected
    metadata and filesystem exceptions.
    """

    try:
        metadata = read_dicom_metadata(
            path,
            settings=settings,
            allow_non_part10=allow_non_part10,
        )

        return MetadataResult(
            status="ok",
            metadata=metadata,
        )

    except MetadataPathError:
        return MetadataResult(
            status="unreadable",
            error_code="PATH_REJECTED",
        )

    except MetadataUnsupportedError:
        return MetadataResult(
            status="unsupported",
            error_code="DICOM_UNSUPPORTED",
        )

    except MetadataReadError:
        return MetadataResult(
            status="invalid",
            error_code="DICOM_INVALID",
        )


# ============================================================
# 12 — INTERNAL SERIES GROUPING KEYS
# ============================================================

def get_series_group_key(
    metadata: DicomMetadata,
) -> tuple[str | None, str | None]:
    """
    Return internal Study/Series UID grouping keys.

    Missing UIDs remain None. Do not use fabricated
    identifiers for clinical series grouping.

    Never expose these identifiers without authorization.
    """

    return metadata.study_uid, metadata.series_uid


def get_instance_sort_hint(
    metadata: DicomMetadata,
) -> int | None:
    """
    Return InstanceNumber as a diagnostic hint only.

    Correct 3D ordering must use DICOM geometry:
    ImagePositionPatient and ImageOrientationPatient.

    InstanceNumber must never be the sole ordering rule.
    """

    return metadata.instance_number


# ============================================================
# 13 — PUBLIC-SAFE TECHNICAL SUMMARY
# ============================================================

def build_safe_metadata_summary(
    metadata: DicomMetadata,
) -> dict[str, Any]:
    """
    Return only selected technical imaging attributes.

    This result deliberately excludes:
    - PatientName and PatientID
    - Study, Series and SOP UIDs
    - File paths and filenames
    - Study dates and free-text descriptions
    - Manufacturer identifiers

    The API must still require authentication.
    """

    return metadata.safe_summary()


# ============================================================
# END OF DICOM METADATA ENGINE
# ============================================================
