
"""
SINUS VIEWER — DATASET AND PATIENT API ROUTES
=============================================

Authenticated, read-only dataset browser API.

Endpoints:
    POST   /api/datasets
    GET    /api/datasets
    GET    /api/datasets/{dataset_session_id}
    POST   /api/datasets/{dataset_session_id}/refresh
    DELETE /api/datasets/{dataset_session_id}
    GET    /api/datasets/{dataset_session_id}/patients
    GET    /api/datasets/{dataset_session_id}/patients/{patient_handle}/series
    GET    /api/datasets/{dataset_session_id}/series/{series_handle}/validation

Security:
- Every endpoint requires an authenticated server session.
- owner_id comes only from trusted authentication context.
- Original patient identifiers and DICOM paths are excluded.
- Internal scanner objects are never serialized directly.
- Only approved output fields are copied into API schemas.
- No file or folder is created, renamed, modified or deleted.

Runtime:
- Dataset scanning is blocking and potentially expensive.
- FastAPI executes synchronous route functions in its
  worker-thread pool.
- Application-level scan concurrency is managed by
  DatasetService.
- Auth, Origin and HTTPS protections must be registered
  at application startup.

Python 3.10+ / FastAPI / Pydantic v2
"""

from __future__ import annotations

import re
from typing import Annotated, Any

from fastapi import (
    APIRouter,
    Depends,
    HTTPException,
    status,
)

from ..dependencies import require_dataset_service
from ..schemas import (
    DatasetCloseResponse,
    DatasetListResponse,
    DatasetResponse,
    DatasetSelectRequest,
    DatasetSummary,
    PatientListResponse,
    PatientSummary,
    SeriesIssue,
    SeriesListResponse,
    SeriesSummary,
    SeriesValidationResponse,
    ValidationSeverity,
)
from ...security.session import (
    AuthenticatedContext,
    require_authenticated_context,
)
from ...services.dataset_service import (
    DatasetAccessError,
    DatasetBusyError,
    DatasetOperationCancelled,
    DatasetPatientNotFound,
    DatasetSelectionError,
    DatasetService,
    DatasetServiceError,
    DatasetSessionNotFound,
    DatasetSeriesNotFound,
)


# ============================================================
# 01 — ROUTER
# ============================================================

router = APIRouter(
    prefix="/api/datasets",
    tags=["Datasets"],
)

MAX_PUBLIC_ISSUES = 256
MAX_PUBLIC_PATIENTS = 100000
MAX_PUBLIC_SERIES = 100000

SAFE_ISSUE_CODE = re.compile(
    r"^[A-Z0-9_]{1,64}$"
)


# ============================================================
# 02 — AUTHENTICATED DEPENDENCY ALIASES
# ============================================================

TrustedUser = Annotated[
    AuthenticatedContext,
    Depends(require_authenticated_context),
]

TrustedDatasets = Annotated[
    DatasetService,
    Depends(require_dataset_service),
]


# ============================================================
# 03 — CONTROLLED HTTP ERRORS
# ============================================================

def _api_error(
    status_code: int,
    code: str,
) -> HTTPException:
    """
    No scanner exception text or raw source metadata.
    """

    return HTTPException(
        status_code=status_code,
        detail={"code": code},
        headers={
            "Cache-Control": "no-store",
            "Pragma": "no-cache",
        },
    )


def _translate_dataset_error(
    error: DatasetServiceError,
) -> HTTPException:
    """
    Centralized mapping from internal dataset failures.

    Never include error.args, filenames or source paths.
    """

    if isinstance(error, DatasetSessionNotFound):
        return _api_error(404, "DATASET_NOT_FOUND")

    if isinstance(error, DatasetPatientNotFound):
        return _api_error(404, "PATIENT_NOT_FOUND")

    if isinstance(error, DatasetSeriesNotFound):
        return _api_error(404, "SERIES_NOT_FOUND")

    if isinstance(error, DatasetSelectionError):
        return _api_error(403, "PATH_REJECTED")

    if isinstance(error, DatasetAccessError):
        return _api_error(403, "ACCESS_DENIED")

    if isinstance(error, DatasetOperationCancelled):
        return _api_error(409, "OPERATION_CANCELLED")

    if isinstance(error, DatasetBusyError):
        return _api_error(409, "SERVICE_UNAVAILABLE")

    return _api_error(500, "PROCESSING_FAILED")


# ============================================================
# 04 — STRICT DATASET RESPONSE ADAPTER
# ============================================================

def _dataset_summary(
    value: dict[str, Any],
) -> DatasetSummary:
    """
    Explicit allowlist of dataset summary fields.
    """

    return DatasetSummary(
        dataset_session_id=value["dataset_session_id"],
        state=value["state"],
        generation=value["generation"],
        patient_count=value["patient_count"],
        series_count=value["series_count"],
        dicom_files=value["dicom_files"],
    )


# ============================================================
# 05 — STRICT PATIENT RESPONSE ADAPTER
# ============================================================

def _patient_summary(patient: Any) -> PatientSummary:
    """
    Construct browser-safe patient information.

    PatientID, PatientName, StudyDate and folder names
    are deliberately not exposed.
    """

    series_items = tuple(patient.series)

    ready_count = sum(
        1
        for series in series_items
        if (
            series.validation is not None
            and series.validation.volume_ready
        )
    )

    return PatientSummary(
        patient_handle=patient.handle,
        series_count=len(series_items),
        volume_ready_series=ready_count,
    )


# ============================================================
# 06 — STRICT SERIES RESPONSE ADAPTER
# ============================================================

def _series_summary(
    series: Any,
    patient_handle: str,
) -> SeriesSummary:
    """
    Construct series summary without DICOM identifiers.

    Original descriptions, UID values and source paths
    never become API response fields.
    """

    instances = tuple(series.instances)

    first = instances[0] if instances else None

    validation = series.validation

    geometry = (
        validation.geometry
        if validation is not None
        else None
    )

    rows = 0
    columns = 0

    if first is not None:
        rows = first.geometry.rows or 0
        columns = first.geometry.columns or 0

    if geometry is not None:
        rows = geometry.rows
        columns = geometry.columns

    modality: str | None = None

    if first is not None and first.modality is not None:
        candidate = str(first.modality)

        if (
            len(candidate) <= 16
            and re.fullmatch(
                r"[A-Za-z0-9_-]*",
                candidate,
            )
        ):
            modality = candidate

    slice_count = (
        validation.frame_count
        if validation is not None
        else len(instances)
    )

    return SeriesSummary(
        series_handle=series.handle,
        patient_handle=patient_handle,
        modality=modality,
        slice_count=slice_count,
        rows=rows,
        columns=columns,
        volume_ready=bool(
            validation is not None
            and validation.volume_ready
        ),
    )


# ============================================================
# 07 — STRICT VALIDATION ISSUE ADAPTER
# ============================================================

def _public_issue_code(issue: Any) -> str:
    """
    Accept only a valid generic machine-readable code.

    Unknown fields are not reflected into the response.
    """

    raw = getattr(issue, "code", None)

    if hasattr(raw, "value"):
        raw = raw.value

    if not isinstance(raw, str):
        return "VALIDATION_ISSUE"

    normalized = raw.upper()

    if SAFE_ISSUE_CODE.fullmatch(normalized) is None:
        return "VALIDATION_ISSUE"

    return normalized


def _public_issue_severity(issue: Any) -> ValidationSeverity:
    raw = getattr(issue, "severity", None)

    if hasattr(raw, "value"):
        raw = raw.value

    if not isinstance(raw, str):
        return ValidationSeverity.WARNING

    normalized = raw.lower()

    if normalized == "error":
        return ValidationSeverity.ERROR

    if normalized == "info":
        return ValidationSeverity.INFO

    return ValidationSeverity.WARNING


def _validation_response(
    series: Any,
) -> SeriesValidationResponse:
    """
    Build a safe validation summary.

    No original issue messages, filenames or metadata.
    """

    validation = series.validation

    if validation is None:
        raise _api_error(409, "SERIES_INVALID")

    issues = [
        SeriesIssue(
            code=_public_issue_code(item),
            severity=_public_issue_severity(item),
        )
        for item in validation.issues[:MAX_PUBLIC_ISSUES]
    ]

    return SeriesValidationResponse(
        series_handle=series.handle,
        valid=bool(validation.valid),
        volume_ready=bool(validation.volume_ready),
        file_count=int(validation.file_count),
        frame_count=int(validation.frame_count),
        issues=issues,
    )


# ============================================================
# 08 — SELECT DATASET
# ============================================================

@router.post(
    "",
    response_model=DatasetResponse,
    status_code=status.HTTP_201_CREATED,
)
def select_dataset(
    payload: DatasetSelectRequest,
    auth: TrustedUser,
    datasets: TrustedDatasets,
) -> DatasetResponse:
    """
    Select a read-only dataset beneath configured root.

    The path is never returned to the browser.
    """

    try:
        summary = datasets.select_dataset(
            payload.dataset_path,
            owner_id=auth.owner_id,
        )

        return DatasetResponse(
            dataset=_dataset_summary(summary),
        )

    except DatasetServiceError as error:
        raise _translate_dataset_error(error) from None


# ============================================================
# 09 — LIST DATASETS
# ============================================================

@router.get(
    "",
    response_model=DatasetListResponse,
)
def list_datasets(
    auth: TrustedUser,
    datasets: TrustedDatasets,
) -> DatasetListResponse:
    try:
        summaries = datasets.list_datasets(
            owner_id=auth.owner_id,
        )

        return DatasetListResponse(
            datasets=[
                _dataset_summary(item)
                for item in summaries
            ],
        )

    except DatasetServiceError as error:
        raise _translate_dataset_error(error) from None


# ============================================================
# 10 — GET DATASET STATUS
# ============================================================

@router.get(
    "/{dataset_session_id}",
    response_model=DatasetResponse,
)
def get_dataset(
    dataset_session_id: str,
    auth: TrustedUser,
    datasets: TrustedDatasets,
) -> DatasetResponse:
    try:
        summary = datasets.get_dataset(
            dataset_session_id,
            owner_id=auth.owner_id,
        )

        return DatasetResponse(
            dataset=_dataset_summary(summary),
        )

    except DatasetServiceError as error:
        raise _translate_dataset_error(error) from None


# ============================================================
# 11 — REFRESH DATASET
# ============================================================

@router.post(
    "/{dataset_session_id}/refresh",
    response_model=DatasetResponse,
)
def refresh_dataset(
    dataset_session_id: str,
    auth: TrustedUser,
    datasets: TrustedDatasets,
) -> DatasetResponse:
    """
    Rescan the selected dataset, preserving its original files.

    Dataset generation increments after successful refresh.

    Cache keys use the generation, so a refreshed dataset
    does not reuse an older generation's cached volume.
    """

    try:
        summary = datasets.refresh_dataset(
            dataset_session_id,
            owner_id=auth.owner_id,
        )

        return DatasetResponse(
            dataset=_dataset_summary(summary),
        )

    except DatasetServiceError as error:
        raise _translate_dataset_error(error) from None


# ============================================================
# 12 — CLOSE DATASET
# ============================================================

@router.delete(
    "/{dataset_session_id}",
    response_model=DatasetCloseResponse,
)
def close_dataset(
    dataset_session_id: str,
    auth: TrustedUser,
    datasets: TrustedDatasets,
) -> DatasetCloseResponse:
    """
    Close selected in-memory dataset session.

    This does not delete any original dataset directory.
    """

    try:
        datasets.close_dataset(
            dataset_session_id,
            owner_id=auth.owner_id,
        )

        return DatasetCloseResponse(
            success=True,
            closed=True,
        )

    except DatasetServiceError as error:
        raise _translate_dataset_error(error) from None


# ============================================================
# 13 — LIST PATIENTS
# ============================================================

@router.get(
    "/{dataset_session_id}/patients",
    response_model=PatientListResponse,
)
def list_patients(
    dataset_session_id: str,
    auth: TrustedUser,
    datasets: TrustedDatasets,
) -> PatientListResponse:
    """
    List opaque patient handles only.

    Uses the authorized scanner index; never serializes
    raw ScanPatient objects to HTTP.
    """

    try:
        # Verify ownership before accessing internal index.
        datasets.get_dataset(
            dataset_session_id,
            owner_id=auth.owner_id,
        )

        # DatasetService.list_patients() provides only
        # summaries. Patient handles are resolved through
        # its authorized get_patient() method.
        summaries = datasets.list_patients(
            dataset_session_id,
            owner_id=auth.owner_id,
        )

        if len(summaries) > MAX_PUBLIC_PATIENTS:
            raise _api_error(409, "PROCESSING_FAILED")

        patients: list[PatientSummary] = []

        for item in summaries:
            handle = item.get("patient_handle")

            if not isinstance(handle, str):
                raise _api_error(409, "PROCESSING_FAILED")

            patient = datasets.get_patient(
                dataset_session_id,
                handle,
                owner_id=auth.owner_id,
            )

            patients.append(
                _patient_summary(patient)
            )

        return PatientListResponse(
            dataset_session_id=dataset_session_id,
            patients=patients,
        )

    except DatasetServiceError as error:
        raise _translate_dataset_error(error) from None


# ============================================================
# 14 — LIST SERIES OF ONE PATIENT
# ============================================================

@router.get(
    "/{dataset_session_id}/patients/"
    "{patient_handle}/series",
    response_model=SeriesListResponse,
)
def list_patient_series(
    dataset_session_id: str,
    patient_handle: str,
    auth: TrustedUser,
    datasets: TrustedDatasets,
) -> SeriesListResponse:
    """
    Show series associated with a selected patient handle.
    """

    try:
        patient = datasets.get_patient(
            dataset_session_id,
            patient_handle,
            owner_id=auth.owner_id,
        )

        series_items = tuple(patient.series)

        if len(series_items) > MAX_PUBLIC_SERIES:
            raise _api_error(409, "PROCESSING_FAILED")

        return SeriesListResponse(
            dataset_session_id=dataset_session_id,
            patient_handle=patient_handle,
            series=[
                _series_summary(
                    series,
                    patient_handle,
                )
                for series in series_items
            ],
        )

    except DatasetServiceError as error:
        raise _translate_dataset_error(error) from None


# ============================================================
# 15 — SERIES VALIDATION
# ============================================================

@router.get(
    "/{dataset_session_id}/series/"
    "{series_handle}/validation",
    response_model=SeriesValidationResponse,
)
def get_series_validation(
    dataset_session_id: str,
    series_handle: str,
    auth: TrustedUser,
    datasets: TrustedDatasets,
) -> SeriesValidationResponse:
    """
    Return technical volume-readiness and safe issue codes.
    """

    try:
        series = datasets.get_series(
            dataset_session_id,
            series_handle,
            owner_id=auth.owner_id,
        )

        return _validation_response(series)

    except DatasetServiceError as error:
        raise _translate_dataset_error(error) from None


# ============================================================
# 16 — ROUTE CAPABILITIES
# ============================================================

def get_dataset_route_capabilities() -> dict[str, Any]:
    return {
        "dataset_selection": True,
        "dataset_listing": True,
        "dataset_refresh": True,
        "dataset_close": True,
        "patient_listing": True,
        "series_listing": True,
        "series_validation": True,
        "authentication_required": True,
        "opaque_handles": True,
        "original_paths_in_responses": False,
        "patient_names_in_responses": False,
        "read_only_original_dataset": True,
    }


# ============================================================
# END OF DATASET API ROUTES
# ============================================================
