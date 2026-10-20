
"""
SINUS VIEWER — LOW-MEMORY DICOM PREVIEW SERVICE
==============================================

Builds lightweight, non-diagnostic navigation previews
without allocating a complete 3D volume.

Features:
- Authorized dataset and series selection
- Validated conventional DICOM slice geometry
- Individual source-slice decoding
- Axial, coronal and sagittal sampled previews
- Bounded preview dimensions and sampled slice counts
- Cancellation and progress reporting
- Monochrome display windowing
- Immutable 8-bit preview arrays
- Privacy-safe technical metadata
- No filesystem writes

IMPORTANT:
- Original DICOM data is strictly read-only.
- No volume-sized array is allocated.
- One decoded full-resolution slice is held at a time.
- Preview quality is not suitable for diagnosis.
- Enhanced multiframe and invalid geometry are rejected.
- The previous validator must approve the series.
- HTTP authentication is implemented separately.

Python 3.10+
"""

from __future__ import annotations

import math
import threading
from dataclasses import dataclass, field
from enum import Enum
from typing import Callable

import numpy as np

from ..core.config import AppSettings, get_settings
from ..dicom.decoder import (
    DicomDecoderError,
    decode_dicom_file,
)
from ..dicom.metadata import (
    DicomMetadata,
    read_dicom_metadata,
)
from ..dicom.validator import (
    validate_series,
)
from .dataset_service import (
    DatasetService,
    DatasetServiceError,
    validate_handle,
    validate_owner_id,
)


# ============================================================
# 01 — CONSTANTS
# ============================================================

DEFAULT_PREVIEW_DIMENSION = 256
DEFAULT_MAX_SAMPLED_SLICES = 96

MAX_PREVIEW_DIMENSION = 512
MAX_SAMPLED_SLICES = 384

ProgressCallback = Callable[[int, int], None]


# ============================================================
# 02 — PREVIEW TYPES
# ============================================================

class PreviewPlane(str, Enum):
    AXIAL = "axial"
    CORONAL = "coronal"
    SAGITTAL = "sagittal"


class PreviewErrorCode(str, Enum):
    INVALID_REQUEST = "INVALID_REQUEST"
    SERIES_NOT_FOUND = "SERIES_NOT_FOUND"
    SERIES_INVALID = "SERIES_INVALID"
    SOURCE_CHANGED = "SOURCE_CHANGED"
    DECODING_FAILED = "DECODER_ERROR"
    CANCELLED = "OPERATION_CANCELLED"
    BUSY = "SERVICE_UNAVAILABLE"
    MEMORY_LIMIT = "OUT_OF_MEMORY"


class PreviewServiceError(RuntimeError):
    """
    Controlled error without source file paths or PHI.
    """

    def __init__(self, code: PreviewErrorCode) -> None:
        self.code = code
        super().__init__(code.value)


# ============================================================
# 03 — OUTPUT MODELS
# ============================================================

@dataclass(frozen=True)
class PreviewImage:
    plane: PreviewPlane
    pixels: np.ndarray = field(repr=False)

    source_shape_zyx: tuple[int, int, int]
    displayed_shape_yx: tuple[int, int]

    sampled_slice_count: int
    representative_slice_index: int

    window_low: float
    window_high: float

    @property
    def byte_size(self) -> int:
        return int(self.pixels.nbytes)

    def safe_summary(self) -> dict:
        return {
            "plane": self.plane.value,
            "shape_yx": list(self.displayed_shape_yx),
            "dtype": "uint8",
            "byte_size": self.byte_size,
            "source_shape_zyx": list(
                self.source_shape_zyx
            ),
            "sampled_slice_count": (
                self.sampled_slice_count
            ),
            "representative_slice_index": (
                self.representative_slice_index
            ),
            "window_low": self.window_low,
            "window_high": self.window_high,
            "diagnostic_quality": False,
        }


@dataclass(frozen=True)
class PreviewPackage:
    axial: PreviewImage
    coronal: PreviewImage
    sagittal: PreviewImage

    def get_plane(
        self,
        plane: PreviewPlane,
    ) -> PreviewImage:
        if plane == PreviewPlane.AXIAL:
            return self.axial

        if plane == PreviewPlane.CORONAL:
            return self.coronal

        if plane == PreviewPlane.SAGITTAL:
            return self.sagittal

        raise PreviewServiceError(
            PreviewErrorCode.INVALID_REQUEST
        )

    def safe_summary(self) -> dict:
        return {
            "axial": self.axial.safe_summary(),
            "coronal": self.coronal.safe_summary(),
            "sagittal": self.sagittal.safe_summary(),
            "diagnostic_quality": False,
        }


@dataclass(frozen=True)
class PreviewServiceStatistics:
    requests: int
    completed: int
    failed: int
    active: int
    closed: bool

    def safe_summary(self) -> dict:
        return {
            "requests": self.requests,
            "completed": self.completed,
            "failed": self.failed,
            "active": self.active,
            "closed": self.closed,
        }


# ============================================================
# 04 — VALIDATION HELPERS
# ============================================================

def _positive_integer(
    value: int,
    *,
    maximum: int,
) -> int:
    if (
        not isinstance(value, int)
        or isinstance(value, bool)
        or value < 1
        or value > maximum
    ):
        raise PreviewServiceError(
            PreviewErrorCode.INVALID_REQUEST
        )

    return value


def check_preview_cancelled(
    event: threading.Event | None,
) -> None:
    if event is not None and event.is_set():
        raise PreviewServiceError(
            PreviewErrorCode.CANCELLED
        )


def sample_indices(
    length: int,
    maximum_samples: int,
) -> np.ndarray:
    """
    Select evenly distributed integer voxel indices.

    Returns an ordered 1D array. Does not allocate a
    volume or access DICOM files.
    """

    _positive_integer(
        length,
        maximum=2**31 - 1,
    )

    _positive_integer(
        maximum_samples,
        maximum=MAX_PREVIEW_DIMENSION,
    )

    count = min(length, maximum_samples)

    if count == 1:
        indices = np.array(
            [(length - 1) // 2],
            dtype=np.int64,
        )
    else:
        indices = np.rint(
            np.linspace(
                0,
                length - 1,
                count,
                dtype=np.float64,
            )
        ).astype(np.int64)

    indices.setflags(write=False)

    return indices


# ============================================================
# 05 — SOURCE METADATA RECHECK
# ============================================================

def verify_preview_source(
    original: DicomMetadata,
    current: DicomMetadata,
) -> None:
    """
    Check important identity, geometry and pixel fields.

    This detects common changes since indexing, but is
    not a cryptographic snapshot or race-free file lock.
    """

    if (
        original.study_uid != current.study_uid
        or original.series_uid != current.series_uid
        or original.sop_instance_uid != current.sop_instance_uid
        or original.geometry != current.geometry
        or original.pixels != current.pixels
        or original.file_size_bytes != current.file_size_bytes
    ):
        raise PreviewServiceError(
            PreviewErrorCode.SOURCE_CHANGED
        )


# ============================================================
# 06 — READ ONE SOURCE SLICE
# ============================================================

def read_preview_slice(
    metadata: DicomMetadata,
    settings: AppSettings,
) -> np.ndarray:
    """
    Read a single source image without building a 3D volume.

    Uses the dedicated decoder's path and pixel checks.
    """

    try:
        current = read_dicom_metadata(
            metadata.source_path,
            settings,
        )

        verify_preview_source(
            metadata,
            current,
        )

        decoded = decode_dicom_file(
            metadata.source_path,
            settings,
            expected_metadata=metadata,
            apply_modality_rescale=True,
        )

        if decoded.pixels.ndim != 2:
            raise PreviewServiceError(
                PreviewErrorCode.DECODING_FAILED
            )

        return decoded.pixels

    except PreviewServiceError:
        raise

    except DicomDecoderError:
        raise PreviewServiceError(
            PreviewErrorCode.DECODING_FAILED
        ) from None

    except (OSError, ValueError, RuntimeError):
        raise PreviewServiceError(
            PreviewErrorCode.SOURCE_CHANGED
        ) from None


# ============================================================
# 07 — DISPLAY WINDOWING
# ============================================================

def calculate_preview_window(
    sampled_pixels: np.ndarray,
) -> tuple[float, float]:
    """
    Estimate an intensity display window from sampled data.

    No diagnostic window preset is assumed for CBCT.
    """

    values = np.asarray(
        sampled_pixels,
        dtype=np.float32,
    )

    if values.size == 0 or not np.all(np.isfinite(values)):
        raise PreviewServiceError(
            PreviewErrorCode.DECODING_FAILED
        )

    try:
        low, high = np.percentile(
            values,
            [1.0, 99.0],
        )

        low = float(low)
        high = float(high)

    except (MemoryError, ValueError):
        raise PreviewServiceError(
            PreviewErrorCode.MEMORY_LIMIT
        ) from None

    if not (math.isfinite(low) and math.isfinite(high)):
        raise PreviewServiceError(
            PreviewErrorCode.DECODING_FAILED
        )

    if high <= low:
        low = float(values.min())
        high = float(values.max())

    if high <= low:
        high = low + 1.0

    return low, high


def apply_preview_window(
    pixels: np.ndarray,
    *,
    low: float,
    high: float,
    invert: bool = False,
) -> np.ndarray:
    """
    Convert a small floating-point image into uint8.

    The operation affects RAM only, never source DICOM.
    """

    if not (
        math.isfinite(low)
        and math.isfinite(high)
        and high > low
    ):
        raise PreviewServiceError(
            PreviewErrorCode.INVALID_REQUEST
        )

    scaled = (
        np.asarray(pixels, dtype=np.float32) - low
    ) / (high - low)

    scaled = np.clip(
        scaled,
        0.0,
        1.0,
    )

    output = np.rint(
        scaled * 255.0
    ).astype(np.uint8)

    if invert:
        output = np.subtract(
            255,
            output,
            dtype=np.uint8,
        )

    output.setflags(write=False)

    return output


# ============================================================
# 08 — METADATA-VALIDATED PREVIEW BUILD
# ============================================================

def build_previews_from_series(
    instances: tuple[DicomMetadata, ...],
    settings: AppSettings | None = None,
    *,
    max_dimension: int = DEFAULT_PREVIEW_DIMENSION,
    max_sampled_slices: int = DEFAULT_MAX_SAMPLED_SLICES,
    cancel_event: threading.Event | None = None,
    progress_callback: ProgressCallback | None = None,
) -> PreviewPackage:
    """
    Build three navigation previews using selected slices.

    Peak working memory is driven primarily by a single
    decoded source slice and small preview arrays, not
    the full volume's voxel count.

    Assumes conventional single-frame, regular geometry
    approved by validate_series().
    """

    active = settings if settings is not None else get_settings()

    dimension = _positive_integer(
        max_dimension,
        maximum=MAX_PREVIEW_DIMENSION,
    )

    sampled_limit = _positive_integer(
        max_sampled_slices,
        maximum=MAX_SAMPLED_SLICES,
    )

    check_preview_cancelled(cancel_event)

    report = validate_series(
        instances,
        active,
    )

    if not report.volume_ready or report.geometry is None:
        raise PreviewServiceError(
            PreviewErrorCode.SERIES_INVALID
        )

    geometry = report.geometry

    ordered = tuple(
        instances[index]
        for index in geometry.sorted_indices
    )

    depth = len(ordered)
    height = geometry.rows
    width = geometry.columns

    # Evenly sample source slices and horizontal/vertical
    # voxel indices. Only one original slice is decoded
    # at a time.
    z_indices = sample_indices(
        depth,
        min(sampled_limit, dimension),
    )

    y_indices = sample_indices(
        height,
        dimension,
    )

    x_indices = sample_indices(
        width,
        dimension,
    )

    center_z = depth // 2
    center_y = height // 2
    center_x = width // 2

    axial_float: np.ndarray | None = None

    try:
        coronal_float = np.empty(
            (len(z_indices), len(x_indices)),
            dtype=np.float32,
        )

        sagittal_float = np.empty(
            (len(z_indices), len(y_indices)),
            dtype=np.float32,
        )

        # Include exact central axial source slice even
        # when it is absent from the distributed samples.
        selected_slices = sorted(
            set(int(z) for z in z_indices)
            | {center_z}
        )

        lookup = {
            int(z): position
            for position, z in enumerate(z_indices)
        }

        invert_display = (
            ordered[center_z]
            .pixels.photometric_interpretation
            == "MONOCHROME1"
        )

        for completed, z in enumerate(
            selected_slices,
            start=1,
        ):
            check_preview_cancelled(cancel_event)

            image = read_preview_slice(
                ordered[z],
                active,
            )

            if image.shape != (height, width):
                raise PreviewServiceError(
                    PreviewErrorCode.SOURCE_CHANGED
                )

            if z in lookup:
                row = lookup[z]

                coronal_float[row] = image[
                    center_y, x_indices
                ]

                sagittal_float[row] = image[
                    y_indices, center_x
                ]

            if z == center_z:
                axial_float = image[
                    np.ix_(
                        y_indices,
                        x_indices,
                    )
                ].copy()

            del image

            if progress_callback is not None:
                progress_callback(
                    completed,
                    len(selected_slices),
                )

        if axial_float is None:
            raise PreviewServiceError(
                PreviewErrorCode.DECODING_FAILED
            )

        check_preview_cancelled(cancel_event)

        # A shared window helps the three planes represent
        # comparable intensity ranges for navigation.
        window_samples = np.concatenate([
            axial_float.ravel(),
            coronal_float.ravel(),
            sagittal_float.ravel(),
        ])

        low, high = calculate_preview_window(
            window_samples
        )

        def make_image(
            plane: PreviewPlane,
            pixels: np.ndarray,
        ) -> PreviewImage:
            display = apply_preview_window(
                pixels,
                low=low,
                high=high,
                invert=invert_display,
            )

            return PreviewImage(
                plane=plane,
                pixels=display,
                source_shape_zyx=(
                    depth,
                    height,
                    width,
                ),
                displayed_shape_yx=tuple(
                    int(v) for v in display.shape
                ),
                sampled_slice_count=len(z_indices),
                representative_slice_index=center_z,
                window_low=low,
                window_high=high,
            )

        return PreviewPackage(
            axial=make_image(
                PreviewPlane.AXIAL,
                axial_float,
            ),
            coronal=make_image(
                PreviewPlane.CORONAL,
                coronal_float,
            ),
            sagittal=make_image(
                PreviewPlane.SAGITTAL,
                sagittal_float,
            ),
        )

    except MemoryError:
        raise PreviewServiceError(
            PreviewErrorCode.MEMORY_LIMIT
        ) from None


# ============================================================
# 09 — AUTHORIZED PREVIEW SERVICE
# ============================================================

class PreviewService:
    """
    Process-local preview service.

    Uses the existing DatasetService for ownership and
    series lookup. One preview build runs at a time by
    default to limit simultaneous decoder memory usage.
    """

    def __init__(
        self,
        dataset_service: DatasetService,
        settings: AppSettings | None = None,
    ) -> None:
        if not isinstance(dataset_service, DatasetService):
            raise TypeError(
                "DatasetService instance required."
            )

        self._datasets = dataset_service

        self._settings = (
            settings if settings is not None
            else get_settings()
        )

        self._lock = threading.RLock()

        self._build_gate = threading.BoundedSemaphore(1)

        self._closed = False
        self._requests = 0
        self._completed = 0
        self._failed = 0
        self._active = 0

    def _require_open(self) -> None:
        if self._closed:
            raise PreviewServiceError(
                PreviewErrorCode.BUSY
            )

    def build_preview(
        self,
        dataset_session_id: str,
        series_handle: str,
        *,
        owner_id: str,
        max_dimension: int = DEFAULT_PREVIEW_DIMENSION,
        max_sampled_slices: int = DEFAULT_MAX_SAMPLED_SLICES,
        cancel_event: threading.Event | None = None,
        progress_callback: ProgressCallback | None = None,
    ) -> PreviewPackage:
        """
        Build authorized navigation previews.

        The owner_id must come from verified server-side
        authentication context, never a browser-supplied
        username or arbitrary request parameter.
        """

        validate_owner_id(owner_id)
        validate_handle(dataset_session_id)
        validate_handle(series_handle)

        _positive_integer(
            max_dimension,
            maximum=MAX_PREVIEW_DIMENSION,
        )

        _positive_integer(
            max_sampled_slices,
            maximum=MAX_SAMPLED_SLICES,
        )

        with self._lock:
            self._require_open()
            self._requests += 1

        if not self._build_gate.acquire(blocking=False):
            with self._lock:
                self._failed += 1

            raise PreviewServiceError(
                PreviewErrorCode.BUSY
            )

        with self._lock:
            self._active += 1

        try:
            try:
                session = self._datasets.get_dataset(
                    dataset_session_id,
                    owner_id=owner_id,
                )

                series = self._datasets.get_series(
                    dataset_session_id,
                    series_handle,
                    owner_id=owner_id,
                )

            except DatasetServiceError:
                raise PreviewServiceError(
                    PreviewErrorCode.SERIES_NOT_FOUND
                ) from None

            if session.get("state") != "ready":
                raise PreviewServiceError(
                    PreviewErrorCode.BUSY
                )

            generation = session["generation"]

            result = build_previews_from_series(
                series.instances,
                self._settings,
                max_dimension=max_dimension,
                max_sampled_slices=max_sampled_slices,
                cancel_event=cancel_event,
                progress_callback=progress_callback,
            )

            # Recheck authorization after potentially long
            # image decoding, before returning patient data.
            try:
                current = self._datasets.get_dataset(
                    dataset_session_id,
                    owner_id=owner_id,
                )

                self._datasets.get_series(
                    dataset_session_id,
                    series_handle,
                    owner_id=owner_id,
                )

            except DatasetServiceError:
                raise PreviewServiceError(
                    PreviewErrorCode.SOURCE_CHANGED
                ) from None

            if (
                current.get("state") != "ready"
                or current.get("generation") != generation
            ):
                raise PreviewServiceError(
                    PreviewErrorCode.SOURCE_CHANGED
                )

            with self._lock:
                self._require_open()
                self._completed += 1

            return result

        except Exception:
            with self._lock:
                self._failed += 1
            raise

        finally:
            with self._lock:
                self._active -= 1

            self._build_gate.release()

    def statistics(self) -> PreviewServiceStatistics:
        with self._lock:
            return PreviewServiceStatistics(
                requests=self._requests,
                completed=self._completed,
                failed=self._failed,
                active=self._active,
                closed=self._closed,
            )

    def close(self) -> None:
        """
        Prevent new preview requests.

        Active worker tasks finish or observe their
        supplied cancellation event.
        """

        with self._lock:
            self._closed = True


# ============================================================
# 10 — SERVICE FACTORY AND SAFE SUMMARY
# ============================================================

def create_preview_service(
    dataset_service: DatasetService,
    settings: AppSettings | None = None,
) -> PreviewService:
    return PreviewService(
        dataset_service=dataset_service,
        settings=settings,
    )


def get_preview_service_summary(
    service: PreviewService,
) -> dict:
    return service.statistics().safe_summary()


# ============================================================
# 11 — CAPABILITY REPORT
# ============================================================

def get_preview_capabilities() -> dict:
    return {
        "planes": [
            "axial",
            "coronal",
            "sagittal",
        ],
        "output_dtype": "uint8",
        "preview_only": True,
        "full_volume_required": False,
        "source_slice_decode_required": True,
        "multiframe_supported": False,
        "maximum_dimension": MAX_PREVIEW_DIMENSION,
        "maximum_sampled_slices": MAX_SAMPLED_SLICES,
        "read_only_source": True,
        "output_format": "raw_grayscale_array",
        "http_endpoint_implemented": False,
    }


# ============================================================
# END OF LOW-MEMORY PREVIEW SERVICE
# ============================================================
