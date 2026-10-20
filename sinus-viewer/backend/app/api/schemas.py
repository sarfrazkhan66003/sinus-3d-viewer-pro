
"""
SINUS VIEWER — CENTRALIZED FASTAPI SCHEMAS
==========================================

Strict Pydantic v2 contracts for authenticated APIs.

Covers:
- Login / logout / session status
- Dataset selection and indexing
- Patient and series discovery
- Series validation and safe issues
- Volume geometry and preview levels
- Byte-range streaming descriptors
- Service health and sanitized errors

SECURITY:
- Do not serialize pydicom Dataset objects directly.
- Do not return original paths, DICOM UIDs, PatientID,
  PatientName, StudyDate or raw image metadata.
- All identifiers exposed here are opaque server handles.
- These models do not implement authentication themselves.
- API routes must authenticate and authorize before
  constructing responses.
- Volume bytes are transferred separately, never in JSON.

Pydantic v2 / Python 3.10+
No filesystem operations.
"""

from __future__ import annotations

import math
import re
from enum import Enum
from typing import Annotated, Literal

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    field_validator,
    model_validator,
)


# ============================================================
# 01 — COMMON CONSTRAINTS
# ============================================================

HANDLE_PATTERN = r"^[A-Za-z0-9_-]{1,128}$"
REQUEST_ID_PATTERN = r"^[a-f0-9]{32}$"

OpaqueHandle = Annotated[
    str,
    StringConstraints(
        min_length=1,
        max_length=128,
        pattern=HANDLE_PATTERN,
        strict=True,
    ),
]

RequestId = Annotated[
    str,
    StringConstraints(
        pattern=REQUEST_ID_PATTERN,
        strict=True,
    ),
]

PositiveCount = Annotated[
    int,
    Field(strict=True, ge=0),
]

PositiveSize = Annotated[
    int,
    Field(strict=True, gt=0),
]

FiniteNumber = Annotated[
    float,
    Field(allow_inf_nan=False),
]

PositiveFiniteNumber = Annotated[
    float,
    Field(gt=0, allow_inf_nan=False),
]

Vector3 = tuple[FiniteNumber, FiniteNumber, FiniteNumber]
Direction9 = tuple[
    FiniteNumber, FiniteNumber, FiniteNumber,
    FiniteNumber, FiniteNumber, FiniteNumber,
    FiniteNumber, FiniteNumber, FiniteNumber,
]

Shape3 = tuple[PositiveSize, PositiveSize, PositiveSize]
Shape2 = tuple[PositiveSize, PositiveSize]


class StrictAPIModel(BaseModel):
    """
    Every JSON API model rejects undeclared fields.

    Never pass an entire internal object through
    model_dump() or attribute reflection into these schemas.
    """

    model_config = ConfigDict(
        extra="forbid",
        validate_assignment=True,
        use_enum_values=False,
    )


# ============================================================
# 02 — SAFE ERROR CONTRACT
# ============================================================

class PublicErrorCode(str, Enum):
    AUTH_REQUIRED = "AUTH_REQUIRED"
    AUTH_FAILED = "AUTH_FAILED"
    SESSION_EXPIRED = "SESSION_EXPIRED"
    ACCESS_DENIED = "ACCESS_DENIED"
    RATE_LIMITED = "RATE_LIMITED"
    INVALID_REQUEST = "INVALID_REQUEST"
    REQUEST_TOO_LARGE = "REQUEST_TOO_LARGE"
    PATH_REJECTED = "PATH_REJECTED"
    DATASET_NOT_FOUND = "DATASET_NOT_FOUND"
    PATIENT_NOT_FOUND = "PATIENT_NOT_FOUND"
    SERIES_NOT_FOUND = "SERIES_NOT_FOUND"
    SERIES_INVALID = "SERIES_INVALID"
    SOURCE_CHANGED = "SOURCE_CHANGED"
    DECODER_ERROR = "DECODER_ERROR"
    OUT_OF_MEMORY = "OUT_OF_MEMORY"
    RANGE_NOT_SATISFIABLE = "RANGE_NOT_SATISFIABLE"
    OPERATION_CANCELLED = "OPERATION_CANCELLED"
    SERVICE_UNAVAILABLE = "SERVICE_UNAVAILABLE"
    PROCESSING_FAILED = "PROCESSING_FAILED"
    CONFIG_ERROR = "CONFIG_ERROR"
    HTTPS_REQUIRED = "HTTPS_REQUIRED"


ERROR_MESSAGES: dict[PublicErrorCode, str] = {
    PublicErrorCode.AUTH_REQUIRED: "Authentication is required.",
    PublicErrorCode.AUTH_FAILED: "Authentication failed.",
    PublicErrorCode.SESSION_EXPIRED: "Session expired.",
    PublicErrorCode.ACCESS_DENIED: "Access denied.",
    PublicErrorCode.RATE_LIMITED: "Too many requests.",
    PublicErrorCode.INVALID_REQUEST: "Invalid request.",
    PublicErrorCode.REQUEST_TOO_LARGE: "Request too large.",
    PublicErrorCode.PATH_REJECTED: "Dataset path rejected.",
    PublicErrorCode.DATASET_NOT_FOUND: "Dataset not found.",
    PublicErrorCode.PATIENT_NOT_FOUND: "Patient not found.",
    PublicErrorCode.SERIES_NOT_FOUND: "Series not found.",
    PublicErrorCode.SERIES_INVALID: "Series is not volume-ready.",
    PublicErrorCode.SOURCE_CHANGED: "Source data changed.",
    PublicErrorCode.DECODER_ERROR: "Image decoding failed.",
    PublicErrorCode.OUT_OF_MEMORY: "Memory limit exceeded.",
    PublicErrorCode.RANGE_NOT_SATISFIABLE: "Invalid byte range.",
    PublicErrorCode.OPERATION_CANCELLED: "Operation cancelled.",
    PublicErrorCode.SERVICE_UNAVAILABLE: "Service unavailable.",
    PublicErrorCode.PROCESSING_FAILED: "Processing failed.",
    PublicErrorCode.CONFIG_ERROR: "Service configuration error.",
    PublicErrorCode.HTTPS_REQUIRED: "Secure transport required.",
}


class APIErrorDetail(StrictAPIModel):
    code: PublicErrorCode
    message: str = Field(min_length=1, max_length=160)
    retryable: bool = False
    request_id: RequestId | None = None

    @model_validator(mode="after")
    def enforce_safe_message(self) -> "APIErrorDetail":
        if self.message != ERROR_MESSAGES[self.code]:
            raise ValueError("Error message is not allowlisted.")
        return self


class APIErrorResponse(StrictAPIModel):
    success: Literal[False] = False
    error: APIErrorDetail


def make_error_response(
    code: PublicErrorCode,
    *,
    request_id: str | None = None,
    retryable: bool = False,
) -> APIErrorResponse:
    return APIErrorResponse(
        error=APIErrorDetail(
            code=code,
            message=ERROR_MESSAGES[code],
            retryable=retryable,
            request_id=request_id,
        )
    )


# ============================================================
# 03 — AUTHENTICATION
# ============================================================

class LoginRequest(StrictAPIModel):
    username: str = Field(
        min_length=1,
        max_length=128,
    )
    password: str = Field(
        min_length=1,
        max_length=1024,
        repr=False,
    )


class SessionStatus(StrictAPIModel):
    authenticated: Literal[True] = True
    expires_at: FiniteNumber = Field(gt=0)


class LoginResponse(StrictAPIModel):
    success: Literal[True] = True
    session: SessionStatus


class LogoutResponse(StrictAPIModel):
    success: Literal[True] = True
    authenticated: Literal[False] = False


# ============================================================
# 04 — DATASET SESSION
# ============================================================

class DatasetSelectRequest(StrictAPIModel):
    """
    Absolute path selection must be independently validated
    by DatasetService and the centralized path guard.

    This schema only restricts request size and syntax.
    """

    dataset_path: str = Field(
        min_length=1,
        max_length=2048,
    )

    @field_validator("dataset_path")
    @classmethod
    def reject_unsafe_text(cls, value: str) -> str:
        if (
            "\x00" in value
            or "\r" in value
            or "\n" in value
        ):
            raise ValueError("Invalid dataset path.")
        return value


class DatasetStatus(str, Enum):
    READY = "ready"
    SCANNING = "scanning"
    CLOSED = "closed"


class DatasetSummary(StrictAPIModel):
    dataset_session_id: OpaqueHandle
    state: DatasetStatus
    generation: PositiveSize
    patient_count: PositiveCount
    series_count: PositiveCount
    dicom_files: PositiveCount


class DatasetResponse(StrictAPIModel):
    success: Literal[True] = True
    dataset: DatasetSummary


class DatasetListResponse(StrictAPIModel):
    success: Literal[True] = True
    datasets: list[DatasetSummary] = Field(max_length=100)


class DatasetCloseResponse(StrictAPIModel):
    success: Literal[True] = True
    closed: Literal[True] = True


# ============================================================
# 05 — PATIENT AND SERIES BROWSER
# ============================================================

class PatientSummary(StrictAPIModel):
    """
    No real patient names or IDs.

    UI can display a generic Patient 1, Patient 2 label
    based on ordering, without storing identifying labels.
    """

    patient_handle: OpaqueHandle
    series_count: PositiveCount
    volume_ready_series: PositiveCount

    @model_validator(mode="after")
    def valid_ready_count(self) -> "PatientSummary":
        if self.volume_ready_series > self.series_count:
            raise ValueError("Invalid series counts.")
        return self


class PatientListResponse(StrictAPIModel):
    success: Literal[True] = True
    dataset_session_id: OpaqueHandle
    patients: list[PatientSummary] = Field(
        max_length=100000
    )


class SeriesSummary(StrictAPIModel):
    series_handle: OpaqueHandle
    patient_handle: OpaqueHandle
    modality: str | None = Field(
        default=None,
        max_length=16,
        pattern=r"^[A-Za-z0-9_-]*$",
    )
    slice_count: PositiveCount
    rows: PositiveCount
    columns: PositiveCount
    volume_ready: bool


class SeriesListResponse(StrictAPIModel):
    success: Literal[True] = True
    dataset_session_id: OpaqueHandle
    patient_handle: OpaqueHandle
    series: list[SeriesSummary] = Field(
        max_length=100000
    )


# ============================================================
# 06 — SERIES VALIDATION
# ============================================================

class ValidationSeverity(str, Enum):
    INFO = "info"
    WARNING = "warning"
    ERROR = "error"


class SeriesIssue(StrictAPIModel):
    """
    Only approved generic codes are exposed.

    No DICOM metadata, paths or vendor exception strings.
    """

    code: str = Field(
        min_length=1,
        max_length=64,
        pattern=r"^[A-Z0-9_]+$",
    )
    severity: ValidationSeverity


class SeriesValidationResponse(StrictAPIModel):
    success: Literal[True] = True
    series_handle: OpaqueHandle
    valid: bool
    volume_ready: bool
    file_count: PositiveCount
    frame_count: PositiveCount
    issues: list[SeriesIssue] = Field(
        default_factory=list,
        max_length=256,
    )


# ============================================================
# 07 — MEDICAL GEOMETRY
# ============================================================

class VolumeGeometrySchema(StrictAPIModel):
    shape_zyx: Shape3
    spacing_xyz_mm: tuple[
        PositiveFiniteNumber,
        PositiveFiniteNumber,
        PositiveFiniteNumber,
    ]
    origin_lps: Vector3
    direction_lps: Direction9
    coordinate_system: Literal["LPS"] = "LPS"

    @field_validator("direction_lps")
    @classmethod
    def validate_direction(cls, value: Direction9) -> Direction9:
        matrix = (
            value[0:3],
            value[3:6],
            value[6:9],
        )

        for axis in matrix:
            squared_norm = sum(component * component for component in axis)
            if not math.isclose(squared_norm, 1.0, abs_tol=1e-3):
                raise ValueError("Invalid direction matrix.")

        for a, b in ((0, 1), (0, 2), (1, 2)):
            dot = sum(
                matrix[a][i] * matrix[b][i]
                for i in range(3)
            )
            if not math.isclose(dot, 0.0, abs_tol=1e-3):
                raise ValueError("Invalid direction matrix.")

        return value


# ============================================================
# 08 — FULL / PREVIEW VOLUME LEVELS
# ============================================================

class VolumeLevelSchema(StrictAPIModel):
    level: int = Field(strict=True, ge=0, le=64)
    is_preview: bool
    shape_zyx: Shape3
    byte_size: PositiveSize
    dtype: Literal["float32"] = "float32"
    axis_order: Literal["zyx"] = "zyx"
    byte_order: Literal["little"] = "little"
    geometry: VolumeGeometrySchema

    @model_validator(mode="after")
    def check_level_consistency(self) -> "VolumeLevelSchema":
        if self.is_preview != (self.level > 0):
            raise ValueError("Invalid preview level.")
        expected_bytes = math.prod(self.shape_zyx) * 4
        if self.byte_size != expected_bytes:
            raise ValueError("Invalid volume byte size.")
        if self.geometry.shape_zyx != self.shape_zyx:
            raise ValueError("Inconsistent geometry.")
        return self


class VolumeDescriptor(StrictAPIModel):
    format: Literal["sinus-viewer-volume-v1"] = (
        "sinus-viewer-volume-v1"
    )
    coordinate_system: Literal["LPS"] = "LPS"
    levels: list[VolumeLevelSchema] = Field(
        min_length=1,
        max_length=65,
    )

    @model_validator(mode="after")
    def validate_level_order(self) -> "VolumeDescriptor":
        identifiers = [entry.level for entry in self.levels]
        if len(identifiers) != len(set(identifiers)):
            raise ValueError("Duplicate volume levels.")
        if 0 not in identifiers:
            raise ValueError("Full-resolution level is missing.")
        return self


class VolumeResponse(StrictAPIModel):
    success: Literal[True] = True
    series_handle: OpaqueHandle
    volume: VolumeDescriptor


# ============================================================
# 09 — NAVIGATION PREVIEWS
# ============================================================

class PreviewPlaneName(str, Enum):
    AXIAL = "axial"
    CORONAL = "coronal"
    SAGITTAL = "sagittal"


class PreviewImageSchema(StrictAPIModel):
    plane: PreviewPlaneName
    shape_yx: Shape2
    dtype: Literal["uint8"] = "uint8"
    byte_size: PositiveSize
    sampled_slice_count: PositiveSize
    representative_slice_index: PositiveCount
    window_low: FiniteNumber
    window_high: FiniteNumber
    diagnostic_quality: Literal[False] = False

    @model_validator(mode="after")
    def validate_preview(self) -> "PreviewImageSchema":
        if self.byte_size != math.prod(self.shape_yx):
            raise ValueError("Invalid preview byte size.")
        if self.window_high <= self.window_low:
            raise ValueError("Invalid preview window.")
        return self


class PreviewDescriptor(StrictAPIModel):
    axial: PreviewImageSchema
    coronal: PreviewImageSchema
    sagittal: PreviewImageSchema
    diagnostic_quality: Literal[False] = False

    @model_validator(mode="after")
    def verify_planes(self) -> "PreviewDescriptor":
        if (
            self.axial.plane != PreviewPlaneName.AXIAL
            or self.coronal.plane != PreviewPlaneName.CORONAL
            or self.sagittal.plane != PreviewPlaneName.SAGITTAL
        ):
            raise ValueError("Invalid preview plane mapping.")
        return self


class PreviewResponse(StrictAPIModel):
    success: Literal[True] = True
    series_handle: OpaqueHandle
    previews: PreviewDescriptor


# ============================================================
# 10 — STREAMING CONTRACTS
# ============================================================

class StreamRangeRequest(StrictAPIModel):
    level: int = Field(strict=True, ge=0, le=64)
    offset: int = Field(strict=True, ge=0)
    length: int = Field(
        strict=True,
        ge=1,
        le=64 * 1024 * 1024,
    )


class StreamDescriptor(StrictAPIModel):
    level: int = Field(strict=True, ge=0, le=64)
    total_bytes: PositiveSize
    content_length: PositiveSize
    chunk_size_bytes: PositiveSize
    status_code: Literal[200, 206]
    is_partial: bool
    content_type: Literal["application/octet-stream"] = (
        "application/octet-stream"
    )
    encoding: Literal["sinus-viewer-f32-zyx-v1"] = (
        "sinus-viewer-f32-zyx-v1"
    )

    @model_validator(mode="after")
    def validate_stream_contract(self) -> "StreamDescriptor":
        if self.content_length > self.total_bytes:
            raise ValueError("Invalid stream length.")
        if self.is_partial != (self.status_code == 206):
            raise ValueError("Invalid streaming status.")
        if self.chunk_size_bytes > 4 * 1024 * 1024:
            raise ValueError("Stream chunk is too large.")
        return self


class StreamResponse(StrictAPIModel):
    success: Literal[True] = True
    stream: StreamDescriptor


# ============================================================
# 11 — HEALTH RESPONSE
# ============================================================

class HealthStatus(str, Enum):
    OK = "ok"
    DEGRADED = "degraded"


class HealthResponse(StrictAPIModel):
    """
    Suitable for a minimal public health endpoint.

    No hardware inventory, paths, patient information,
    credentials or configuration are exposed.
    """

    status: HealthStatus
    service: Literal["sinus-viewer"] = "sinus-viewer"


# ============================================================
# 12 — SCHEMA CAPABILITIES
# ============================================================

def get_api_schema_capabilities() -> dict:
    return {
        "schema_version": "1",
        "pydantic_version": "2",
        "strict_extra_fields": True,
        "opaque_handles": True,
        "patient_identifiers_exposed": False,
        "raw_dicom_paths_exposed": False,
        "volume_binary_separate": True,
        "coordinate_system": "LPS",
        "volume_axis_order": "zyx",
        "volume_dtype": "float32",
    }


# ============================================================
# END OF CENTRALIZED FASTAPI SCHEMAS
# ============================================================
