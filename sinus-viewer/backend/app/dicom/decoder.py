
"""
SINUS VIEWER — DICOM PIXEL DECODER
==================================

Purpose:
- Decode conventional single-frame monochrome DICOM.
- Support uncompressed and plugin-supported compression.
- Check transfer syntax and pixel metadata.
- Validate output dimensions and numeric values.
- Apply modality rescale slope/intercept when requested.
- Enforce per-image memory limits.
- Return safe, structured errors.
- Preserve original DICOM files strictly read-only.

Notes:
- Uses pydicom 3.x pixel decoding.
- Plugins are installed later in Google Colab.
- This module does not build 3D volumes.
- Enhanced multiframe is deliberately unsupported here.
- Rescaled CBCT values are not necessarily calibrated HU.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any

import numpy as np
import pydicom
from pydicom.dataset import Dataset
from pydicom.errors import InvalidDicomError
from pydicom.uid import UID

from ..core.config import AppSettings, get_settings
from .metadata import (
    DicomMetadata,
    validate_dicom_path,
)


# ============================================================
# 01 — CONSTANTS
# ============================================================

MIB = 1024 * 1024

SUPPORTED_PHOTOMETRIC = frozenset({
    "MONOCHROME1",
    "MONOCHROME2",
})

SUPPORTED_BITS_ALLOCATED = frozenset({
    8,
    16,
    32,
})

# Well-known uncompressed transfer syntaxes.
UNCOMPRESSED_UIDS = frozenset({
    "1.2.840.10008.1.2",
    "1.2.840.10008.1.2.1",
    "1.2.840.10008.1.2.2",
})

# Common compressed transfer syntaxes.
# Actual availability is determined by installed plugins.
KNOWN_COMPRESSED_UIDS = frozenset({
    "1.2.840.10008.1.2.5",
    "1.2.840.10008.1.2.4.50",
    "1.2.840.10008.1.2.4.51",
    "1.2.840.10008.1.2.4.57",
    "1.2.840.10008.1.2.4.70",
    "1.2.840.10008.1.2.4.80",
    "1.2.840.10008.1.2.4.81",
    "1.2.840.10008.1.2.4.90",
    "1.2.840.10008.1.2.4.91",
    "1.2.840.10008.1.2.4.201",
    "1.2.840.10008.1.2.4.202",
    "1.2.840.10008.1.2.4.203",
})

MAX_DECODED_SLICE_MB = 256
MAX_DICOM_FILE_MB = 2048


# ============================================================
# 02 — CONTROLLED ERROR CODES
# ============================================================

class DecoderErrorCode(str, Enum):
    INVALID_DICOM = "DICOM_INVALID"
    UNSUPPORTED_SYNTAX = "DICOM_UNSUPPORTED"
    DECODER_UNAVAILABLE = "DECODER_UNAVAILABLE"
    DECODING_FAILED = "DECODER_ERROR"
    INVALID_PIXELS = "INVALID_PIXEL_DATA"
    SOURCE_CHANGED = "SOURCE_CHANGED"
    MEMORY_LIMIT = "OUT_OF_MEMORY"
    PATH_REJECTED = "PATH_REJECTED"


class DicomDecoderError(RuntimeError):
    """
    Safe decoder exception.

    Do not expose raw vendor metadata, original file paths
    or low-level library exception strings.
    """

    def __init__(self, code: DecoderErrorCode) -> None:
        self.code = code
        super().__init__(code.value)


# ============================================================
# 03 — OUTPUT DATA MODELS
# ============================================================

@dataclass(frozen=True)
class TransferSyntaxInfo:
    uid: str
    name: str
    compressed: bool
    recognized: bool

    def safe_summary(self) -> dict[str, Any]:
        return {
            "compressed": self.compressed,
            "recognized": self.recognized,
        }


@dataclass(frozen=True)
class DecodeResult:
    pixels: np.ndarray = field(repr=False)

    rows: int
    columns: int
    dtype: str

    compressed_source: bool
    photometric_interpretation: str
    modality_rescale_applied: bool

    @property
    def size_bytes(self) -> int:
        return int(self.pixels.nbytes)

    def safe_summary(self) -> dict[str, Any]:
        return {
            "rows": self.rows,
            "columns": self.columns,
            "dtype": self.dtype,
            "size_bytes": self.size_bytes,
            "compressed_source": self.compressed_source,
            "modality_rescale_applied": (
                self.modality_rescale_applied
            ),
        }


# ============================================================
# 04 — TRANSFER SYNTAX INSPECTION
# ============================================================

def inspect_transfer_syntax(
    dataset: Dataset,
) -> TransferSyntaxInfo:
    """
    Inspect file transfer syntax.

    Recognition does not guarantee decoder availability.
    """

    file_meta = getattr(dataset, "file_meta", None)

    if file_meta is None:
        raise DicomDecoderError(
            DecoderErrorCode.INVALID_DICOM
        )

    value = getattr(
        file_meta,
        "TransferSyntaxUID",
        None,
    )

    if value is None:
        raise DicomDecoderError(
            DecoderErrorCode.INVALID_DICOM
        )

    try:
        uid = UID(str(value))
        compressed = bool(uid.is_compressed)
    except (TypeError, ValueError, AttributeError):
        raise DicomDecoderError(
            DecoderErrorCode.INVALID_DICOM
        ) from None

    recognized = (
        str(uid) in UNCOMPRESSED_UIDS
        or str(uid) in KNOWN_COMPRESSED_UIDS
    )

    return TransferSyntaxInfo(
        uid=str(uid),
        name=str(uid.name),
        compressed=compressed,
        recognized=recognized,
    )


# ============================================================
# 05 — PIXEL HEADER VALIDATION
# ============================================================

def validate_pixel_header(dataset: Dataset) -> tuple[int, int]:
    """
    Restrict this decoder to conventional monochrome images.
    """

    try:
        rows = int(dataset.Rows)
        columns = int(dataset.Columns)

        samples = int(dataset.SamplesPerPixel)
        bits = int(dataset.BitsAllocated)
        stored = int(dataset.BitsStored)
        high_bit = int(dataset.HighBit)
        representation = int(dataset.PixelRepresentation)

        frames = int(
            getattr(dataset, "NumberOfFrames", 1)
        )

        photometric = str(
            dataset.PhotometricInterpretation
        )

    except (
        AttributeError,
        TypeError,
        ValueError,
        OverflowError,
    ):
        raise DicomDecoderError(
            DecoderErrorCode.INVALID_DICOM
        ) from None

    if rows <= 0 or columns <= 0:
        raise DicomDecoderError(
            DecoderErrorCode.INVALID_PIXELS
        )

    if frames != 1 or samples != 1:
        raise DicomDecoderError(
            DecoderErrorCode.UNSUPPORTED_SYNTAX
        )

    if photometric not in SUPPORTED_PHOTOMETRIC:
        raise DicomDecoderError(
            DecoderErrorCode.UNSUPPORTED_SYNTAX
        )

    if (
        bits not in SUPPORTED_BITS_ALLOCATED
        or stored < 1
        or stored > bits
        or high_bit != stored - 1
        or representation not in (0, 1)
    ):
        raise DicomDecoderError(
            DecoderErrorCode.INVALID_PIXELS
        )

    return rows, columns


# ============================================================
# 06 — SOURCE HEADER COMPARISON
# ============================================================

def verify_expected_metadata(
    dataset: Dataset,
    expected: DicomMetadata,
) -> None:
    """
    Detect changes since the initial metadata scan.

    Identity and geometry verification in series_reader.py
    remains mandatory before full volume reconstruction.
    """

    comparisons = (
        ("StudyInstanceUID", expected.study_uid),
        ("SeriesInstanceUID", expected.series_uid),
        ("SOPInstanceUID", expected.sop_instance_uid),
    )

    for attribute, original in comparisons:
        if original is None:
            continue

        current = getattr(dataset, attribute, None)

        if current is None or str(current) != original:
            raise DicomDecoderError(
                DecoderErrorCode.SOURCE_CHANGED
            )

    try:
        rows = int(dataset.Rows)
        columns = int(dataset.Columns)
    except (AttributeError, ValueError, TypeError):
        raise DicomDecoderError(
            DecoderErrorCode.SOURCE_CHANGED
        ) from None

    if (
        rows != expected.geometry.rows
        or columns != expected.geometry.columns
    ):
        raise DicomDecoderError(
            DecoderErrorCode.SOURCE_CHANGED
        )

    current_syntax = inspect_transfer_syntax(dataset)

    if (
        expected.pixels.transfer_syntax_uid is not None
        and current_syntax.uid
        != expected.pixels.transfer_syntax_uid
    ):
        raise DicomDecoderError(
            DecoderErrorCode.SOURCE_CHANGED
        )


# ============================================================
# 07 — DECODED MEMORY ESTIMATION
# ============================================================

def estimate_slice_memory(
    rows: int,
    columns: int,
    *,
    output_float32: bool = True,
) -> int:
    """
    Conservative planning estimate.

    Includes estimated decoded data, float conversion,
    and intermediate buffers. Not a peak-RAM guarantee.
    """

    if (
        isinstance(rows, bool)
        or isinstance(columns, bool)
        or not isinstance(rows, int)
        or not isinstance(columns, int)
        or rows <= 0
        or columns <= 0
    ):
        raise DicomDecoderError(
            DecoderErrorCode.INVALID_PIXELS
        )

    bytes_per_pixel = 4 if output_float32 else 4

    return rows * columns * bytes_per_pixel * 4


# ============================================================
# 08 — ACTUAL PIXEL DECODING
# ============================================================

def decode_dataset_pixels(
    dataset: Dataset,
    *,
    apply_modality_rescale: bool = True,
    max_decoded_slice_mb: int = MAX_DECODED_SLICE_MB,
) -> DecodeResult:
    """
    Decode pixels from an already loaded DICOM Dataset.

    Uses pydicom's installed decoder plugins.

    No Dataset.decompress() or Dataset.save_as() is used.
    The input dataset is not intentionally modified.

    Pixel decoding may internally allocate additional buffers.
    """

    syntax = inspect_transfer_syntax(dataset)

    if not syntax.recognized:
        raise DicomDecoderError(
            DecoderErrorCode.UNSUPPORTED_SYNTAX
        )

    rows, columns = validate_pixel_header(dataset)

    if max_decoded_slice_mb < 1:
        raise ValueError(
            "max_decoded_slice_mb must be positive."
        )

    estimated_bytes = estimate_slice_memory(
        rows,
        columns,
        output_float32=True,
    )

    if estimated_bytes > max_decoded_slice_mb * MIB:
        raise DicomDecoderError(
            DecoderErrorCode.MEMORY_LIMIT
        )

    if "PixelData" not in dataset:
        raise DicomDecoderError(
            DecoderErrorCode.INVALID_PIXELS
        )

    try:
        # Plugin selection is delegated to pydicom.
        # This supports uncompressed data and codecs
        # actually available in the Colab environment.
        decoded = dataset.pixel_array

    except MemoryError:
        raise DicomDecoderError(
            DecoderErrorCode.MEMORY_LIMIT
        ) from None

    except (RuntimeError, ImportError, NotImplementedError):
        raise DicomDecoderError(
            DecoderErrorCode.DECODER_UNAVAILABLE
        ) from None

    except (
        ValueError,
        TypeError,
        AttributeError,
        OSError,
    ):
        raise DicomDecoderError(
            DecoderErrorCode.DECODING_FAILED
        ) from None

    if (
        not isinstance(decoded, np.ndarray)
        or decoded.ndim != 2
        or decoded.shape != (rows, columns)
        or not np.issubdtype(decoded.dtype, np.number)
        or np.iscomplexobj(decoded)
    ):
        raise DicomDecoderError(
            DecoderErrorCode.INVALID_PIXELS
        )

    try:
        output = np.array(
            decoded,
            dtype=np.float32,
            copy=True,
        )

        if apply_modality_rescale:
            slope = float(
                getattr(dataset, "RescaleSlope", 1.0)
            )
            intercept = float(
                getattr(dataset, "RescaleIntercept", 0.0)
            )

            if (
                not math.isfinite(slope)
                or not math.isfinite(intercept)
            ):
                raise DicomDecoderError(
                    DecoderErrorCode.INVALID_PIXELS
                )

            # Equivalent linear rescale:
            # value = stored_value * slope + intercept
            output *= slope
            output += intercept

        if not np.all(np.isfinite(output)):
            raise DicomDecoderError(
                DecoderErrorCode.INVALID_PIXELS
            )

        output.setflags(write=False)

    except MemoryError:
        raise DicomDecoderError(
            DecoderErrorCode.MEMORY_LIMIT
        ) from None

    return DecodeResult(
        pixels=output,
        rows=rows,
        columns=columns,
        dtype=str(output.dtype),
        compressed_source=syntax.compressed,
        photometric_interpretation=str(
            dataset.PhotometricInterpretation
        ),
        modality_rescale_applied=apply_modality_rescale,
    )


# ============================================================
# 09 — READ AND DECODE FROM A DICOM FILE
# ============================================================

def decode_dicom_file(
    path: str | Path,
    settings: AppSettings | None = None,
    *,
    expected_metadata: DicomMetadata | None = None,
    apply_modality_rescale: bool = True,
) -> DecodeResult:
    """
    Read one conventional DICOM image and decode pixels.

    Original file is opened only in binary read mode.
    Path validation restricts access to authorized datasets.

    No source modification, file creation or deletion.
    """

    active = settings if settings is not None else get_settings()

    try:
        safe_path = validate_dicom_path(
            path,
            active.storage.dataset.root_path,
        )

    except (OSError, ValueError, RuntimeError):
        raise DicomDecoderError(
            DecoderErrorCode.PATH_REJECTED
        ) from None

    try:
        file_size = safe_path.stat().st_size

        if (
            file_size <= 0
            or file_size > MAX_DICOM_FILE_MB * MIB
        ):
            raise DicomDecoderError(
                DecoderErrorCode.MEMORY_LIMIT
            )

        with safe_path.open("rb") as stream:
            dataset = pydicom.dcmread(
                stream,
                force=False,
            )

        if expected_metadata is not None:
            verify_expected_metadata(
                dataset,
                expected_metadata,
            )

        if (
            not active.dicom.decoding.enable_compressed_dicom
            and inspect_transfer_syntax(dataset).compressed
        ):
            raise DicomDecoderError(
                DecoderErrorCode.UNSUPPORTED_SYNTAX
            )

        return decode_dataset_pixels(
            dataset,
            apply_modality_rescale=apply_modality_rescale,
        )

    except DicomDecoderError:
        raise

    except MemoryError:
        raise DicomDecoderError(
            DecoderErrorCode.MEMORY_LIMIT
        ) from None

    except (
        InvalidDicomError,
        OSError,
        EOFError,
        ValueError,
        TypeError,
    ):
        raise DicomDecoderError(
            DecoderErrorCode.INVALID_DICOM
        ) from None


# ============================================================
# 10 — SAFE RESULT WRAPPER
# ============================================================

@dataclass(frozen=True)
class DecodeAttempt:
    success: bool
    result: DecodeResult | None = field(
        default=None,
        repr=False,
    )
    error_code: str | None = None

    def safe_summary(self) -> dict[str, Any]:
        return {
            "success": self.success,
            "error_code": self.error_code,
            "image": (
                self.result.safe_summary()
                if self.result else None
            ),
        }


def try_decode_dicom_file(
    path: str | Path,
    settings: AppSettings | None = None,
    *,
    expected_metadata: DicomMetadata | None = None,
) -> DecodeAttempt:
    """
    Return a controlled outcome for expected decoder errors.

    Never fall back to fabricated or arbitrary pixel data.
    """

    try:
        result = decode_dicom_file(
            path,
            settings,
            expected_metadata=expected_metadata,
        )

        return DecodeAttempt(
            success=True,
            result=result,
        )

    except DicomDecoderError as exc:
        return DecodeAttempt(
            success=False,
            error_code=exc.code.value,
        )


# ============================================================
# 11 — DECODER CAPABILITIES
# ============================================================

def get_decoder_capabilities() -> dict[str, Any]:
    """
    Describe implemented decoder contracts.

    This is not a live check of installed codec plugins.
    """

    return {
        "engine": "pydicom",
        "single_frame": True,
        "multiframe": False,
        "monochrome": True,
        "color": False,
        "output_dtype": "float32",
        "compressed_requires_plugins": True,
        "supported_pixel_bits": sorted(
            SUPPORTED_BITS_ALLOCATED
        ),
        "known_compressed_syntaxes": len(
            KNOWN_COMPRESSED_UIDS
        ),
        "modality_rescale": True,
        "read_only_source": True,
    }


# ============================================================
# END OF DICOM PIXEL DECODER
# ============================================================
