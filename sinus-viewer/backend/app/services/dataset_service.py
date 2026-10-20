
"""
SINUS VIEWER — DATASET MANAGEMENT SERVICE
==========================================

Coordinates read-only DICOM dataset discovery and maintains
temporary, process-local patient/series indexes.

Features:
- Authorized-root dataset selection.
- Read-only patient and series discovery.
- Thread-safe dataset session lifecycle.
- Opaque, randomly generated dataset session IDs.
- Caller-owned session isolation.
- Safe patient/series lookup.
- Explicit refresh and cancellation.
- Configurable maximum active sessions.
- Controlled scanner failures.
- No original dataset modification.

SECURITY CONTRACT:
- This service does not authenticate HTTP requests.
- The authenticated API must supply a trusted owner_id
  obtained from its verified server-side session.
- Never use an unverified browser-supplied owner_id.
- Session IDs and patient/series handles are not credentials.
- Never log raw paths, names, UIDs or exception messages.
- Raw index objects must never be serialized directly.

SCANNING CONTRACT:
- scan_dataset() is synchronous and can take substantial time.
- Call it through the backend's bounded background thread pool.
- Indexes are kept in memory, not written into the dataset.
- Source files remain strictly read-only.

Python 3.10+
"""

from __future__ import annotations

import secrets
import threading
import time
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any

from ..core.config import AppSettings, get_settings
from ..dicom.scanner import (
    DatasetScanResult,
    ScanPatient,
    ScanSeries,
    ScannerCancelled,
    ScannerError,
    ScanStatistics,
    scan_dataset,
    validate_dataset_directory,
)


# ============================================================
# 01 — CONSTANTS
# ============================================================

DEFAULT_MAX_ACTIVE_DATASETS = 1
MAX_OWNER_ID_LENGTH = 256
MAX_HANDLE_LENGTH = 128


# ============================================================
# 02 — SESSION STATE
# ============================================================

class DatasetState(str, Enum):
    READY = "ready"
    SCANNING = "scanning"
    CLOSED = "closed"


# ============================================================
# 03 — CONTROLLED ERRORS
# ============================================================

class DatasetServiceError(RuntimeError):
    """
    Safe service exception.

    Never include patient identities or source paths.
    """

    public_code = "PROCESSING_FAILED"

    def __init__(self) -> None:
        super().__init__(self.public_code)


class DatasetAccessError(DatasetServiceError):
    public_code = "ACCESS_DENIED"


class DatasetSelectionError(DatasetServiceError):
    public_code = "PATH_REJECTED"


class DatasetSessionNotFound(DatasetServiceError):
    public_code = "DATASET_NOT_FOUND"


class DatasetPatientNotFound(DatasetServiceError):
    public_code = "PATIENT_NOT_FOUND"


class DatasetSeriesNotFound(DatasetServiceError):
    public_code = "SERIES_NOT_FOUND"


class DatasetBusyError(DatasetServiceError):
    public_code = "SERVICE_UNAVAILABLE"


class DatasetScanFailed(DatasetServiceError):
    public_code = "PROCESSING_FAILED"


class DatasetOperationCancelled(DatasetServiceError):
    public_code = "OPERATION_CANCELLED"


# ============================================================
# 04 — SESSION MODELS
# ============================================================

@dataclass
class DatasetSession:
    """
    Internal dataset session.

    Sensitive scanner objects are intentionally excluded
    from automatic dataclass representations.
    """

    session_id: str = field(repr=False)
    owner_id: str = field(repr=False)
    dataset_path: Path = field(repr=False)
    result: DatasetScanResult = field(repr=False)

    created_at: float
    updated_at: float

    generation: int = 1
    state: DatasetState = DatasetState.READY

    cancel_event: threading.Event = field(
        default_factory=threading.Event,
        repr=False,
    )

    def safe_summary(self) -> dict[str, Any]:
        stats = self.result.statistics

        return {
            "dataset_session_id": self.session_id,
            "state": self.state.value,
            "generation": self.generation,
            "patient_count": (
                stats.patient_count if stats else 0
            ),
            "series_count": (
                stats.series_count if stats else 0
            ),
            "dicom_files": (
                stats.dicom_files if stats else 0
            ),
        }


@dataclass(frozen=True)
class DatasetServiceStatistics:
    active_sessions: int
    maximum_sessions: int
    scans_started: int
    scans_completed: int
    scans_failed: int
    scans_cancelled: int
    closed: bool

    def safe_summary(self) -> dict[str, Any]:
        return {
            "active_sessions": self.active_sessions,
            "maximum_sessions": self.maximum_sessions,
            "scans_started": self.scans_started,
            "scans_completed": self.scans_completed,
            "scans_failed": self.scans_failed,
            "scans_cancelled": self.scans_cancelled,
            "closed": self.closed,
        }


# ============================================================
# 05 — TRUSTED OWNER AND HANDLE VALIDATION
# ============================================================

def validate_owner_id(owner_id: str) -> str:
    """
    Validate a trusted server-side identity reference.

    This is not authentication. The caller must have
    authenticated the identity before invoking this service.
    """

    if (
        not isinstance(owner_id, str)
        or not owner_id
        or len(owner_id) > MAX_OWNER_ID_LENGTH
        or any(ord(char) < 33 for char in owner_id)
    ):
        raise DatasetAccessError()

    return owner_id


def validate_handle(handle: str) -> str:
    if (
        not isinstance(handle, str)
        or not handle
        or len(handle) > MAX_HANDLE_LENGTH
        or not all(
            char.isascii()
            and (char.isalnum() or char in "_-")
            for char in handle
        )
    ):
        raise DatasetAccessError()

    return handle


def generate_dataset_session_id() -> str:
    """
    Create an unpredictable lookup identifier.

    API authorization remains mandatory even when a valid
    session ID is supplied.
    """

    return "ds_" + secrets.token_urlsafe(24)


# ============================================================
# 06 — DATASET SERVICE
# ============================================================

class DatasetService:
    """
    Thread-safe controller for read-only dataset indexes.

    Only one scan/refresh is allowed at a time per service.
    Scans are performed outside the main session lock.
    """

    def __init__(
        self,
        settings: AppSettings | None = None,
        *,
        max_active_datasets: int = DEFAULT_MAX_ACTIVE_DATASETS,
    ) -> None:
        if (
            not isinstance(max_active_datasets, int)
            or isinstance(max_active_datasets, bool)
            or max_active_datasets < 1
        ):
            raise ValueError(
                "Maximum active datasets must be positive."
            )

        self._settings = (
            settings if settings is not None
            else get_settings()
        )

        self._maximum_sessions = max_active_datasets

        self._sessions: dict[str, DatasetSession] = {}

        self._lock = threading.RLock()
        self._scan_lock = threading.Lock()

        self._closed = False

        self._scans_started = 0
        self._scans_completed = 0
        self._scans_failed = 0
        self._scans_cancelled = 0

        self._active_scan_cancel: (
            threading.Event | None
        ) = None

    # --------------------------------------------------------
    # INTERNAL HELPERS
    # --------------------------------------------------------

    def _require_open(self) -> None:
        if self._closed:
            raise DatasetBusyError()

    def _get_authorized_session(
        self,
        session_id: str,
        owner_id: str,
    ) -> DatasetSession:
        """
        Caller must hold self._lock when using this helper.

        Return the same non-disclosing error for missing and
        unauthorized session identifiers.
        """

        validate_owner_id(owner_id)
        validate_handle(session_id)

        self._require_open()

        session = self._sessions.get(session_id)

        if (
            session is None
            or session.owner_id != owner_id
            or session.state == DatasetState.CLOSED
        ):
            raise DatasetSessionNotFound()

        return session

    def _scan(
        self,
        dataset_path: Path,
        cancel_event: threading.Event,
    ) -> DatasetScanResult:
        """
        Run scanner under a global single-scan gate.

        Scanning outside the session lock allows other
        sessions to remain readable.
        """

        if not self._scan_lock.acquire(blocking=False):
            raise DatasetBusyError()

        try:
            with self._lock:
                self._require_open()
                self._active_scan_cancel = cancel_event
                self._scans_started += 1

            try:
                result = scan_dataset(
                    dataset_path,
                    self._settings,
                    cancel_event=cancel_event,
                )

                if cancel_event.is_set():
                    raise ScannerCancelled()

                with self._lock:
                    self._scans_completed += 1

                return result

            except ScannerCancelled:
                with self._lock:
                    self._scans_cancelled += 1

                raise DatasetOperationCancelled() from None

            except ScannerError:
                with self._lock:
                    self._scans_failed += 1

                raise DatasetScanFailed() from None

            except Exception:
                with self._lock:
                    self._scans_failed += 1

                raise DatasetScanFailed() from None

        finally:
            with self._lock:
                if self._active_scan_cancel is cancel_event:
                    self._active_scan_cancel = None

            self._scan_lock.release()

    # --------------------------------------------------------
    # SELECT DATASET
    # --------------------------------------------------------

    def select_dataset(
        self,
        dataset_path: str | Path,
        *,
        owner_id: str,
    ) -> dict[str, Any]:
        """
        Scan and register one dataset for a trusted owner.

        Performs no filesystem writes.

        If the service closes while the scan is running,
        the result will not be registered.
        """

        validate_owner_id(owner_id)

        try:
            validated_path = validate_dataset_directory(
                dataset_path,
                self._settings,
            )

        except ScannerError:
            raise DatasetSelectionError() from None

        with self._lock:
            self._require_open()

            if len(self._sessions) >= self._maximum_sessions:
                raise DatasetBusyError()

        cancel_event = threading.Event()

        result = self._scan(
            validated_path,
            cancel_event,
        )

        now = time.monotonic()

        session = DatasetSession(
            session_id=generate_dataset_session_id(),
            owner_id=owner_id,
            dataset_path=validated_path,
            result=result,
            created_at=now,
            updated_at=now,
            cancel_event=cancel_event,
        )

        with self._lock:
            self._require_open()

            # Recheck capacity after scanning because another
            # caller may have registered a session meanwhile.
            if len(self._sessions) >= self._maximum_sessions:
                raise DatasetBusyError()

            self._sessions[session.session_id] = session

            return session.safe_summary()

    # --------------------------------------------------------
    # LIST OWNER DATASETS
    # --------------------------------------------------------

    def list_datasets(
        self,
        *,
        owner_id: str,
    ) -> list[dict[str, Any]]:
        validate_owner_id(owner_id)

        with self._lock:
            self._require_open()

            return [
                session.safe_summary()
                for session in self._sessions.values()
                if session.owner_id == owner_id
            ]

    # --------------------------------------------------------
    # GET DATASET SUMMARY
    # --------------------------------------------------------

    def get_dataset(
        self,
        session_id: str,
        *,
        owner_id: str,
    ) -> dict[str, Any]:
        with self._lock:
            session = self._get_authorized_session(
                session_id,
                owner_id,
            )

            return session.safe_summary()

    # --------------------------------------------------------
    # PATIENT DISCOVERY
    # --------------------------------------------------------

    def list_patients(
        self,
        session_id: str,
        *,
        owner_id: str,
    ) -> list[dict[str, Any]]:
        with self._lock:
            session = self._get_authorized_session(
                session_id,
                owner_id,
            )

            return [
                patient.safe_summary()
                for patient in session.result.patients
            ]

    def get_patient(
        self,
        session_id: str,
        patient_handle: str,
        *,
        owner_id: str,
    ) -> ScanPatient:
        """
        Return an internal patient object.

        API routes must serialize only approved fields.
        """

        validate_handle(patient_handle)

        with self._lock:
            session = self._get_authorized_session(
                session_id,
                owner_id,
            )

            patient = session.result.get_patient(
                patient_handle
            )

            if patient is None:
                raise DatasetPatientNotFound()

            return patient

    # --------------------------------------------------------
    # SERIES DISCOVERY
    # --------------------------------------------------------

    def list_series(
        self,
        session_id: str,
        patient_handle: str,
        *,
        owner_id: str,
    ) -> list[dict[str, Any]]:
        patient = self.get_patient(
            session_id,
            patient_handle,
            owner_id=owner_id,
        )

        return [
            series.safe_summary()
            for series in patient.series
        ]

    def get_series(
        self,
        session_id: str,
        series_handle: str,
        *,
        owner_id: str,
    ) -> ScanSeries:
        """
        Return an internal series only after owner validation.

        Used by the volume service to locate source metadata.
        """

        validate_handle(series_handle)

        with self._lock:
            session = self._get_authorized_session(
                session_id,
                owner_id,
            )

            series = session.result.get_series(
                series_handle
            )

            if series is None:
                raise DatasetSeriesNotFound()

            return series

    # --------------------------------------------------------
    # REFRESH DATASET
    # --------------------------------------------------------

    def refresh_dataset(
        self,
        session_id: str,
        *,
        owner_id: str,
    ) -> dict[str, Any]:
        """
        Rescan selected dataset and atomically replace index.

        If scanning fails, the previous successful index
        remains available unless the session was closed.

        A generation change indicates that volume cache
        entries derived from the old index must be invalidated
        by the calling orchestration layer.
        """

        with self._lock:
            session = self._get_authorized_session(
                session_id,
                owner_id,
            )

            if session.state != DatasetState.READY:
                raise DatasetBusyError()

            old_generation = session.generation

            session.state = DatasetState.SCANNING
            session.cancel_event = threading.Event()

            path = session.dataset_path
            cancel_event = session.cancel_event

        try:
            result = self._scan(
                path,
                cancel_event,
            )

            with self._lock:
                session = self._get_authorized_session(
                    session_id,
                    owner_id,
                )

                if (
                    session.generation != old_generation
                    or session.cancel_event is not cancel_event
                ):
                    raise DatasetBusyError()

                session.result = result
                session.generation += 1
                session.updated_at = time.monotonic()
                session.state = DatasetState.READY

                return session.safe_summary()

        finally:
            with self._lock:
                existing = self._sessions.get(session_id)

                if (
                    existing is not None
                    and existing.cancel_event is cancel_event
                    and existing.state == DatasetState.SCANNING
                ):
                    existing.state = DatasetState.READY

    # --------------------------------------------------------
    # CANCEL ACTIVE SCAN
    # --------------------------------------------------------

    def cancel_active_scan(self) -> bool:
        """
        Internal administrative operation.

        Do not expose as an unauthenticated public API.
        A caller must have administrative authorization.
        """

        with self._lock:
            if self._active_scan_cancel is None:
                return False

            self._active_scan_cancel.set()
            return True

    # --------------------------------------------------------
    # CLOSE ONE DATASET
    # --------------------------------------------------------

    def close_dataset(
        self,
        session_id: str,
        *,
        owner_id: str,
    ) -> bool:
        with self._lock:
            session = self._get_authorized_session(
                session_id,
                owner_id,
            )

            session.cancel_event.set()
            session.state = DatasetState.CLOSED

            del self._sessions[session_id]

            return True

    # --------------------------------------------------------
    # SERVICE STATISTICS
    # --------------------------------------------------------

    def statistics(self) -> DatasetServiceStatistics:
        with self._lock:
            return DatasetServiceStatistics(
                active_sessions=len(self._sessions),
                maximum_sessions=self._maximum_sessions,
                scans_started=self._scans_started,
                scans_completed=self._scans_completed,
                scans_failed=self._scans_failed,
                scans_cancelled=self._scans_cancelled,
                closed=self._closed,
            )

    # --------------------------------------------------------
    # SHUTDOWN
    # --------------------------------------------------------

    def close(self) -> None:
        """
        End all dataset sessions and request scan cancellation.

        Caller is responsible for joining the bounded worker
        pool during application shutdown.
        """

        with self._lock:
            if self._closed:
                return

            self._closed = True

            if self._active_scan_cancel is not None:
                self._active_scan_cancel.set()

            for session in self._sessions.values():
                session.cancel_event.set()
                session.state = DatasetState.CLOSED

            self._sessions.clear()


# ============================================================
# 07 — SERVICE FACTORY
# ============================================================

def create_dataset_service(
    settings: AppSettings | None = None,
    *,
    max_active_datasets: int = DEFAULT_MAX_ACTIVE_DATASETS,
) -> DatasetService:
    """
    Create service for FastAPI application lifespan.

    Startup should create one process-local instance,
    and shutdown should call close().
    """

    return DatasetService(
        settings=settings,
        max_active_datasets=max_active_datasets,
    )


# ============================================================
# 08 — SAFE SERVICE SUMMARY
# ============================================================

def get_dataset_service_summary(
    service: DatasetService,
) -> dict[str, Any]:
    return service.statistics().safe_summary()


# ============================================================
# END OF DATASET SERVICE
# ============================================================
