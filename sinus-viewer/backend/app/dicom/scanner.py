
"""
SINUS VIEWER — READ-ONLY DICOM DATASET SCANNER
==============================================

Purpose:
- Discover patient folders inside a selected dataset.
- Recursively inspect supported DICOM files.
- Read metadata without decoding pixel arrays.
- Group scans by StudyInstanceUID and SeriesInstanceUID.
- Report missing, invalid and unsupported files.
- Preserve multiple studies and series per patient.
- Generate stable internal handles for navigation.
- Never modify source datasets.

Patient layout:
    dataset/
        Patient_001/
            scan1.dcm
            scan2.dcm
        Patient_002/
            DICOM/
                image001.dcm

Security:
- Dataset path must remain inside authorized root.
- Symlink directories and files are rejected.
- Patient identities and paths remain internal.
- Public-safe reports omit identifiers and filenames.
- No filesystem writing takes place.

This is a synchronous scanning foundation.
Background indexing and API pagination will be implemented
in the services and API layers.
"""

from __future__ import annotations

import hashlib
import os
import stat
import threading
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Iterator, Sequence

from ..core.config import AppSettings, get_settings
from .metadata import (
    DicomMetadata,
    inspect_dicom_metadata,
)
from .validator import (
    SeriesValidationReport,
    validate_series,
)


# ============================================================
# 01 — CONSTANTS
# ============================================================

SUPPORTED_DEFAULT_EXTENSIONS = frozenset({
    ".dcm",
    ".dicom",
    ".ima",
    "",
})

IGNORED_FILENAMES = frozenset({
    "DICOMDIR",
    "DICOMRM",
    "desktop.ini",
    "Thumbs.db",
})

ERROR_CATEGORIES = frozenset({
    "PATH_REJECTED",
    "DICOM_INVALID",
    "DICOM_UNSUPPORTED",
    "DIRECTORY_UNREADABLE",
    "SCAN_CANCELLED",
})

DEFAULT_MAX_CANDIDATE_FILES = 250000

ProgressCallback = Callable[[int, int], None]


# ============================================================
# 02 — SCANNER EXCEPTIONS
# ============================================================

class ScannerError(Exception):
    """Base scanner exception without sensitive path details."""

    def __init__(self, message: str = "Dataset scanning failed."):
        super().__init__(message)


class ScannerPathError(ScannerError):
    """Invalid or unauthorized dataset directory."""


class ScannerCancelled(ScannerError):
    """Scanning was cancelled by the caller."""


class ScannerLimitExceeded(ScannerError):
    """Configured scanner resource limit exceeded."""


# ============================================================
# 03 — RESULT DATA MODELS
# ============================================================

@dataclass(frozen=True)
class ScanStatistics:
    patient_count: int
    series_count: int
    dicom_files: int
    invalid_files: int
    unsupported_files: int
    rejected_files: int
    unreadable_directories: int
    inspected_candidates: int
    total_frames: int
    cancelled: bool = False

    def safe_summary(self) -> dict:
        return {
            "patient_count": self.patient_count,
            "series_count": self.series_count,
            "dicom_files": self.dicom_files,
            "invalid_files": self.invalid_files,
            "unsupported_files": self.unsupported_files,
            "rejected_files": self.rejected_files,
            "unreadable_directories": self.unreadable_directories,
            "inspected_candidates": self.inspected_candidates,
            "total_frames": self.total_frames,
            "cancelled": self.cancelled,
        }


@dataclass(frozen=True)
class ScanSeries:
    handle: str
    patient_handle: str

    study_uid: str | None = field(repr=False)
    series_uid: str | None = field(repr=False)

    instances: tuple[DicomMetadata, ...] = field(
        repr=False,
        default_factory=tuple,
    )

    validation: SeriesValidationReport | None = field(
        repr=False,
        default=None,
    )

    @property
    def file_count(self) -> int:
        return len(self.instances)

    @property
    def frame_count(self) -> int:
        return sum(
            max(1, item.pixels.frames)
            for item in self.instances
        )

    def safe_summary(self) -> dict:
        return {
            "handle": self.handle,
            "patient_handle": self.patient_handle,
            "file_count": self.file_count,
            "frame_count": self.frame_count,
            "modalities": sorted({
                item.modality
                for item in self.instances
                if item.modality
            }),
            "volume_ready": (
                self.validation.volume_ready
                if self.validation else False
            ),
            "validation": (
                self.validation.safe_summary()
                if self.validation else None
            ),
        }


@dataclass(frozen=True)
class ScanPatient:
    handle: str
    folder_name: str = field(repr=False)
    folder_path: Path = field(repr=False)

    series: tuple[ScanSeries, ...] = ()

    @property
    def file_count(self) -> int:
        return sum(s.file_count for s in self.series)

    def safe_summary(self) -> dict:
        return {
            "handle": self.handle,
            "series_count": len(self.series),
            "file_count": self.file_count,
        }


@dataclass(frozen=True)
class DatasetScanResult:
    dataset_path: Path = field(repr=False)
    patients: tuple[ScanPatient, ...] = ()
    statistics: ScanStatistics | None = None

    def safe_summary(self) -> dict:
        return {
            "patients": [
                patient.safe_summary()
                for patient in self.patients
            ],
            "statistics": (
                self.statistics.safe_summary()
                if self.statistics else None
            ),
        }

    def get_patient(
        self,
        handle: str,
    ) -> ScanPatient | None:
        return next(
            (p for p in self.patients if p.handle == handle),
            None,
        )

    def get_series(
        self,
        handle: str,
    ) -> ScanSeries | None:
        for patient in self.patients:
            for series in patient.series:
                if series.handle == handle:
                    return series
        return None


# ============================================================
# 04 — INTERNAL OPAQUE HANDLES
# ============================================================

def make_handle(
    kind: str,
    *parts: str,
) -> str:
    """
    Generate an internal deterministic lookup handle.

    This is NOT authentication, anonymization or an access
    token. API authorization must be enforced separately.
    """

    digest = hashlib.sha256()

    for part in (kind, *parts):
        encoded = part.encode("utf-8", errors="surrogatepass")
        digest.update(len(encoded).to_bytes(8, "big"))
        digest.update(encoded)

    return f"{kind}_{digest.hexdigest()[:24]}"


# ============================================================
# 05 — DATASET PATH VALIDATION
# ============================================================

def validate_dataset_directory(
    path: str | Path,
    settings: AppSettings,
) -> Path:
    """
    Validate a directory under the authorized dataset root.

    Reject symlinks in every component between dataset root
    and the selected directory.
    """

    root = settings.storage.dataset.root_path.expanduser().absolute()
    candidate = Path(path).expanduser()

    if not candidate.is_absolute():
        candidate = root / candidate

    candidate = candidate.absolute()

    if not candidate.is_relative_to(root):
        raise ScannerPathError("Dataset path is not permitted.")

    try:
        current = root

        if current.is_symlink():
            raise ScannerPathError("Symlink paths are not permitted.")

        for component in candidate.relative_to(root).parts:
            current = current / component

            if current.is_symlink():
                raise ScannerPathError(
                    "Symlink paths are not permitted."
                )

        resolved_root = root.resolve(strict=True)
        resolved = candidate.resolve(strict=True)

        if not resolved.is_relative_to(resolved_root):
            raise ScannerPathError("Dataset path is not permitted.")

        if not resolved.is_dir():
            raise ScannerPathError("Dataset directory not found.")

    except ScannerPathError:
        raise
    except (OSError, RuntimeError, ValueError):
        raise ScannerPathError(
            "Dataset directory is unavailable."
        ) from None

    return resolved


# ============================================================
# 06 — FILE ELIGIBILITY
# ============================================================

def is_dicom_candidate(
    filename: str,
    settings: AppSettings,
) -> bool:
    """
    Identify candidate file names only.

    True does not prove the file contains valid DICOM data.
    """

    discovery = settings.dicom.discovery

    if filename in IGNORED_FILENAMES:
        return False

    if discovery.ignore_hidden_files and filename.startswith("."):
        return False

    extension = Path(filename).suffix.lower()

    allowed = set(discovery.supported_extensions)

    if extension:
        return extension in allowed

    return discovery.detect_extensionless_dicom


# ============================================================
# 07 — READ-ONLY DIRECTORY WALKER
# ============================================================

def iter_candidate_files(
    patient_directory: Path,
    settings: AppSettings,
    *,
    cancel_event: threading.Event | None = None,
    on_directory_error: Callable[[], None] | None = None,
) -> Iterator[Path]:
    """
    Iterative directory traversal.

    Avoids recursive Python call-stack growth.
    Does not follow symlinks.
    Does not write to source folders.
    """

    discovery = settings.dicom.discovery

    stack: list[tuple[Path, int]] = [
        (patient_directory, 0)
    ]

    while stack:
        if cancel_event is not None and cancel_event.is_set():
            raise ScannerCancelled("Dataset scan cancelled.")

        directory, depth = stack.pop()

        try:
            with os.scandir(directory) as iterator:
                entries = sorted(
                    list(iterator),
                    key=lambda e: e.name.casefold(),
                )

        except OSError:
            if on_directory_error:
                on_directory_error()
            continue

        for entry in entries:
            if cancel_event is not None and cancel_event.is_set():
                raise ScannerCancelled("Dataset scan cancelled.")

            name = entry.name

            if (
                discovery.ignore_hidden_files
                and name.startswith(".")
            ):
                continue

            try:
                if entry.is_symlink():
                    continue

                if entry.is_dir(follow_symlinks=False):
                    if (
                        discovery.recursive
                        and depth < discovery.max_directory_depth
                    ):
                        stack.append(
                            (Path(entry.path), depth + 1)
                        )

                    continue

                if not entry.is_file(follow_symlinks=False):
                    continue

                if is_dicom_candidate(name, settings):
                    yield Path(entry.path)

            except OSError:
                if on_directory_error:
                    on_directory_error()
                continue


# ============================================================
# 08 — PATIENT FOLDER DISCOVERY
# ============================================================

def discover_patient_directories(
    dataset_path: str | Path,
    settings: AppSettings | None = None,
) -> tuple[Path, ...]:
    """
    Discover immediate child directories as patient folders.

    A dataset containing DICOMs directly is treated as one
    scan collection.

    Nested subfolders inside patients are scanned recursively.
    """

    active = settings if settings is not None else get_settings()

    dataset = validate_dataset_directory(
        dataset_path,
        active,
    )

    folders: list[Path] = []

    try:
        with os.scandir(dataset) as iterator:
            entries = sorted(
                list(iterator),
                key=lambda e: e.name.casefold(),
            )

        for entry in entries:
            if (
                active.dicom.discovery.ignore_hidden_files
                and entry.name.startswith(".")
            ):
                continue

            if entry.is_symlink():
                continue

            if entry.is_dir(follow_symlinks=False):
                folders.append(Path(entry.path))

    except OSError:
        raise ScannerPathError(
            "Unable to enumerate patient folders."
        ) from None

    if folders:
        return tuple(folders)

    # Support a single directly selected patient folder.
    return (dataset,)


# ============================================================
# 09 — SERIES GROUPING
# ============================================================

def group_patient_series(
    patient_handle: str,
    metadata_items: Sequence[DicomMetadata],
    *,
    settings: AppSettings,
) -> tuple[ScanSeries, ...]:
    """
    Group by Study UID + Series UID.

    Never automatically merge files with missing identifiers:
    they are isolated for later inspection.
    """

    groups: dict[
        tuple[str, ...],
        list[DicomMetadata],
    ] = defaultdict(list)

    for metadata in metadata_items:
        if metadata.study_uid and metadata.series_uid:
            key = (
                "identified",
                metadata.study_uid,
                metadata.series_uid,
            )
        else:
            key = (
                "unidentified",
                str(metadata.source_path),
            )

        groups[key].append(metadata)

    result: list[ScanSeries] = []

    for key in sorted(groups):
        instances = tuple(groups[key])

        study_uid = instances[0].study_uid
        series_uid = instances[0].series_uid

        handle = make_handle(
            "series",
            patient_handle,
            *key,
        )

        report = validate_series(instances, settings)

        result.append(
            ScanSeries(
                handle=handle,
                patient_handle=patient_handle,
                study_uid=study_uid,
                series_uid=series_uid,
                instances=instances,
                validation=report,
            )
        )

    return tuple(result)


# ============================================================
# 10 — MAIN DATASET SCANNER
# ============================================================

def scan_dataset(
    dataset_path: str | Path,
    settings: AppSettings | None = None,
    *,
    cancel_event: threading.Event | None = None,
    progress_callback: ProgressCallback | None = None,
    max_candidate_files: int = DEFAULT_MAX_CANDIDATE_FILES,
) -> DatasetScanResult:
    """
    Scan the selected dataset and build a patient/series index.

    Read-only:
    - No file creation.
    - No file modification.
    - No renaming or deletion.
    - No pixel decoding.

    NOTE:
    This initial synchronous implementation retains metadata
    for all accepted files in memory. Very large datasets
    may require a streaming/indexed storage strategy.
    """

    active = settings if settings is not None else get_settings()

    if max_candidate_files < 1:
        raise ValueError("max_candidate_files must be positive.")

    dataset = validate_dataset_directory(
        dataset_path,
        active,
    )

    patient_directories = discover_patient_directories(
        dataset,
        active,
    )

    patients: list[ScanPatient] = []

    valid_files = 0
    invalid_files = 0
    unsupported_files = 0
    rejected_files = 0
    unreadable_directories = 0
    candidates = 0
    frame_total = 0

    def register_directory_error() -> None:
        nonlocal unreadable_directories
        unreadable_directories += 1

    for patient_directory in patient_directories:
        if cancel_event is not None and cancel_event.is_set():
            raise ScannerCancelled("Dataset scan cancelled.")

        # Recheck selected patient directory at the boundary.
        safe_patient_directory = validate_dataset_directory(
            patient_directory,
            active,
        )

        patient_handle = make_handle(
            "patient",
            str(dataset),
            str(safe_patient_directory),
        )

        metadata_items: list[DicomMetadata] = []

        for file_path in iter_candidate_files(
            safe_patient_directory,
            active,
            cancel_event=cancel_event,
            on_directory_error=register_directory_error,
        ):
            if candidates >= max_candidate_files:
                raise ScannerLimitExceeded(
                    "Dataset scan exceeded the file limit."
                )

            candidates += 1

            inspected = inspect_dicom_metadata(
                file_path,
                active,
                allow_non_part10=False,
            )

            if inspected.success and inspected.metadata is not None:
                metadata_items.append(inspected.metadata)
                valid_files += 1
                frame_total += inspected.metadata.pixels.frames

            elif inspected.status == "unsupported":
                unsupported_files += 1

            elif inspected.error_code == "PATH_REJECTED":
                rejected_files += 1

            else:
                invalid_files += 1

            if (
                progress_callback is not None
                and candidates % 100 == 0
            ):
                progress_callback(candidates, valid_files)

        series = group_patient_series(
            patient_handle,
            metadata_items,
            settings=active,
        )

        if series:
            patients.append(
                ScanPatient(
                    handle=patient_handle,
                    folder_name=safe_patient_directory.name,
                    folder_path=safe_patient_directory,
                    series=series,
                )
            )

    patients.sort(
        key=lambda patient: patient.folder_name.casefold()
    )

    series_total = sum(
        len(patient.series)
        for patient in patients
    )

    statistics = ScanStatistics(
        patient_count=len(patients),
        series_count=series_total,
        dicom_files=valid_files,
        invalid_files=invalid_files,
        unsupported_files=unsupported_files,
        rejected_files=rejected_files,
        unreadable_directories=unreadable_directories,
        inspected_candidates=candidates,
        total_frames=frame_total,
        cancelled=False,
    )

    if progress_callback is not None:
        progress_callback(candidates, valid_files)

    return DatasetScanResult(
        dataset_path=dataset,
        patients=tuple(patients),
        statistics=statistics,
    )


# ============================================================
# 11 — PATIENT LIST FOR AUTHORIZED API LAYER
# ============================================================

def build_patient_list(
    scan_result: DatasetScanResult,
) -> list[dict]:
    """
    Generate technical patient list records.

    Patient names and folder paths are intentionally omitted.
    Later authenticated APIs may provide permitted display
    labels according to the privacy policy.
    """

    return [
        {
            "handle": patient.handle,
            "series_count": len(patient.series),
            "file_count": patient.file_count,
            "volume_ready_series": sum(
                bool(
                    series.validation
                    and series.validation.volume_ready
                )
                for series in patient.series
            ),
        }
        for patient in scan_result.patients
    ]


# ============================================================
# 12 — SERIES LIST FOR AUTHORIZED API LAYER
# ============================================================

def build_series_list(
    patient: ScanPatient,
) -> list[dict]:
    """
    Return selected technical series information.

    Actual DICOM pixel endpoints must check authentication
    and verify that the requested series belongs to the
    authorized dataset index.
    """

    return [
        series.safe_summary()
        for series in patient.series
    ]


# ============================================================
# END OF DICOM SCANNER
# ============================================================
