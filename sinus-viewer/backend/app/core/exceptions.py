
"""
SINUS VIEWER — CENTRAL EXCEPTION HANDLING
==========================================

Provides:
- Stable application error codes.
- Typed domain exceptions.
- Safe user-facing error messages.
- Consistent JSON API error responses.
- Request correlation identifiers.
- FastAPI exception handler registration.
- PHI-safe operational logging.

Security:
- Never expose raw Python exceptions to browsers.
- Never expose original DICOM paths or patient metadata.
- Never log request URLs, bodies or DICOM identifiers.
- Never modify original dataset files.

Python 3.10+
FastAPI / Starlette / Pydantic v2
"""

from __future__ import annotations

import logging
import re
import uuid
from dataclasses import dataclass
from enum import Enum
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from .logging import get_logger


# ============================================================
# 01 — STABLE ERROR CODES
# ============================================================

class ErrorCode(str, Enum):
    INTERNAL_ERROR = "INTERNAL_ERROR"
    CONFIG_ERROR = "CONFIG_ERROR"

    INVALID_REQUEST = "INVALID_REQUEST"
    RESOURCE_NOT_FOUND = "RESOURCE_NOT_FOUND"
    METHOD_NOT_ALLOWED = "METHOD_NOT_ALLOWED"
    RATE_LIMITED = "RATE_LIMITED"

    AUTH_REQUIRED = "AUTH_REQUIRED"
    AUTH_FAILED = "AUTH_FAILED"
    ACCESS_DENIED = "ACCESS_DENIED"
    SESSION_EXPIRED = "SESSION_EXPIRED"

    PATH_REJECTED = "PATH_REJECTED"
    DATASET_NOT_FOUND = "DATASET_NOT_FOUND"
    DATASET_EMPTY = "DATASET_EMPTY"
    DATASET_UNAVAILABLE = "DATASET_UNAVAILABLE"

    PATIENT_NOT_FOUND = "PATIENT_NOT_FOUND"
    SERIES_NOT_FOUND = "SERIES_NOT_FOUND"
    SERIES_INVALID = "SERIES_INVALID"
    SERIES_AMBIGUOUS = "SERIES_AMBIGUOUS"

    DICOM_INVALID = "DICOM_INVALID"
    DICOM_UNSUPPORTED = "DICOM_UNSUPPORTED"
    DICOM_DECODING_FAILED = "DICOM_DECODING_FAILED"

    GEOMETRY_INVALID = "GEOMETRY_INVALID"
    VOLUME_TOO_LARGE = "VOLUME_TOO_LARGE"
    MEMORY_LIMIT = "MEMORY_LIMIT"

    PROCESSING_FAILED = "PROCESSING_FAILED"
    OPERATION_TIMEOUT = "OPERATION_TIMEOUT"
    SERVICE_UNAVAILABLE = "SERVICE_UNAVAILABLE"


# ============================================================
# 02 — SAFE PUBLIC ERROR DEFINITIONS
# ============================================================

@dataclass(frozen=True)
class ErrorDefinition:
    status_code: int
    message: str
    retryable: bool = False


ERROR_DEFINITIONS: dict[ErrorCode, ErrorDefinition] = {
    ErrorCode.INTERNAL_ERROR: ErrorDefinition(
        500, "An unexpected server error occurred."
    ),
    ErrorCode.CONFIG_ERROR: ErrorDefinition(
        503, "The application is not configured correctly."
    ),

    ErrorCode.INVALID_REQUEST: ErrorDefinition(
        400, "The submitted request is invalid."
    ),
    ErrorCode.RESOURCE_NOT_FOUND: ErrorDefinition(
        404, "The requested resource was not found."
    ),
    ErrorCode.METHOD_NOT_ALLOWED: ErrorDefinition(
        405, "This operation is not supported."
    ),
    ErrorCode.RATE_LIMITED: ErrorDefinition(
        429, "Too many requests. Please try again later.", True
    ),

    ErrorCode.AUTH_REQUIRED: ErrorDefinition(
        401, "Authentication is required."
    ),
    ErrorCode.AUTH_FAILED: ErrorDefinition(
        401, "Authentication failed."
    ),
    ErrorCode.ACCESS_DENIED: ErrorDefinition(
        403, "Access to this resource is not permitted."
    ),
    ErrorCode.SESSION_EXPIRED: ErrorDefinition(
        401, "Your session has expired."
    ),

    ErrorCode.PATH_REJECTED: ErrorDefinition(
        403, "The selected folder is not permitted."
    ),
    ErrorCode.DATASET_NOT_FOUND: ErrorDefinition(
        404, "The selected dataset folder was not found."
    ),
    ErrorCode.DATASET_EMPTY: ErrorDefinition(
        422, "No supported patient scans were found."
    ),
    ErrorCode.DATASET_UNAVAILABLE: ErrorDefinition(
        503, "The dataset is temporarily unavailable.", True
    ),

    ErrorCode.PATIENT_NOT_FOUND: ErrorDefinition(
        404, "The selected patient was not found."
    ),
    ErrorCode.SERIES_NOT_FOUND: ErrorDefinition(
        404, "The selected scan series was not found."
    ),
    ErrorCode.SERIES_INVALID: ErrorDefinition(
        422, "This scan series cannot be reconstructed."
    ),
    ErrorCode.SERIES_AMBIGUOUS: ErrorDefinition(
        409, "Please select a specific scan series."
    ),

    ErrorCode.DICOM_INVALID: ErrorDefinition(
        422, "One or more DICOM files are invalid."
    ),
    ErrorCode.DICOM_UNSUPPORTED: ErrorDefinition(
        415, "This DICOM encoding is not supported."
    ),
    ErrorCode.DICOM_DECODING_FAILED: ErrorDefinition(
        422, "The scan image data could not be decoded."
    ),

    ErrorCode.GEOMETRY_INVALID: ErrorDefinition(
        422, "The scan geometry is incomplete or inconsistent."
    ),
    ErrorCode.VOLUME_TOO_LARGE: ErrorDefinition(
        413, "This scan exceeds the configured volume limit."
    ),
    ErrorCode.MEMORY_LIMIT: ErrorDefinition(
        503, "Insufficient memory to load this scan.", True
    ),

    ErrorCode.PROCESSING_FAILED: ErrorDefinition(
        500, "Scan processing failed."
    ),
    ErrorCode.OPERATION_TIMEOUT: ErrorDefinition(
        504, "The operation timed out.", True
    ),
    ErrorCode.SERVICE_UNAVAILABLE: ErrorDefinition(
        503, "The service is temporarily unavailable.", True
    ),
}


# ============================================================
# 03 — APPLICATION EXCEPTION BASE CLASS
# ============================================================

class SinusViewerError(Exception):
    """
    Base class for expected application errors.

    Only standardized public messages are returned to users.
    Raw exception details are deliberately excluded.
    """

    def __init__(
        self,
        code: ErrorCode,
        *,
        request_id: str | None = None,
    ) -> None:
        self.code = code
        self.definition = ERROR_DEFINITIONS[code]
        self.request_id = request_id

        super().__init__(self.definition.message)

    @property
    def status_code(self) -> int:
        return self.definition.status_code

    @property
    def retryable(self) -> bool:
        return self.definition.retryable


# ============================================================
# 04 — DOMAIN-SPECIFIC EXCEPTIONS
# ============================================================

class ConfigurationFailure(SinusViewerError):
    def __init__(self) -> None:
        super().__init__(ErrorCode.CONFIG_ERROR)


class AuthenticationRequired(SinusViewerError):
    def __init__(self) -> None:
        super().__init__(ErrorCode.AUTH_REQUIRED)


class AuthenticationFailed(SinusViewerError):
    def __init__(self) -> None:
        super().__init__(ErrorCode.AUTH_FAILED)


class AccessDenied(SinusViewerError):
    def __init__(self) -> None:
        super().__init__(ErrorCode.ACCESS_DENIED)


class SessionExpired(SinusViewerError):
    def __init__(self) -> None:
        super().__init__(ErrorCode.SESSION_EXPIRED)


class PathRejected(SinusViewerError):
    def __init__(self) -> None:
        super().__init__(ErrorCode.PATH_REJECTED)


class DatasetNotFound(SinusViewerError):
    def __init__(self) -> None:
        super().__init__(ErrorCode.DATASET_NOT_FOUND)


class DatasetEmpty(SinusViewerError):
    def __init__(self) -> None:
        super().__init__(ErrorCode.DATASET_EMPTY)


class DatasetUnavailable(SinusViewerError):
    def __init__(self) -> None:
        super().__init__(ErrorCode.DATASET_UNAVAILABLE)


class PatientNotFound(SinusViewerError):
    def __init__(self) -> None:
        super().__init__(ErrorCode.PATIENT_NOT_FOUND)


class SeriesNotFound(SinusViewerError):
    def __init__(self) -> None:
        super().__init__(ErrorCode.SERIES_NOT_FOUND)


class SeriesInvalid(SinusViewerError):
    def __init__(self) -> None:
        super().__init__(ErrorCode.SERIES_INVALID)


class SeriesAmbiguous(SinusViewerError):
    def __init__(self) -> None:
        super().__init__(ErrorCode.SERIES_AMBIGUOUS)


class DicomInvalid(SinusViewerError):
    def __init__(self) -> None:
        super().__init__(ErrorCode.DICOM_INVALID)


class DicomUnsupported(SinusViewerError):
    def __init__(self) -> None:
        super().__init__(ErrorCode.DICOM_UNSUPPORTED)


class DicomDecodingFailed(SinusViewerError):
    def __init__(self) -> None:
        super().__init__(ErrorCode.DICOM_DECODING_FAILED)


class GeometryInvalid(SinusViewerError):
    def __init__(self) -> None:
        super().__init__(ErrorCode.GEOMETRY_INVALID)


class VolumeTooLarge(SinusViewerError):
    def __init__(self) -> None:
        super().__init__(ErrorCode.VOLUME_TOO_LARGE)


class MemoryLimitExceeded(SinusViewerError):
    def __init__(self) -> None:
        super().__init__(ErrorCode.MEMORY_LIMIT)


class ProcessingFailed(SinusViewerError):
    def __init__(self) -> None:
        super().__init__(ErrorCode.PROCESSING_FAILED)


class OperationTimeout(SinusViewerError):
    def __init__(self) -> None:
        super().__init__(ErrorCode.OPERATION_TIMEOUT)


class ServiceUnavailable(SinusViewerError):
    def __init__(self) -> None:
        super().__init__(ErrorCode.SERVICE_UNAVAILABLE)


# ============================================================
# 05 — CORRELATION IDENTIFIERS
# ============================================================

REQUEST_ID_PATTERN = re.compile(r"^[a-zA-Z0-9_-]{8,64}$")


def get_request_id(request: Request) -> str:
    """
    Return a server-controlled request identifier.

    Untrusted incoming request-id headers are not accepted.
    """

    existing = getattr(request.state, "request_id", None)

    if (
        isinstance(existing, str)
        and REQUEST_ID_PATTERN.fullmatch(existing)
    ):
        return existing

    generated = uuid.uuid4().hex
    request.state.request_id = generated

    return generated


# ============================================================
# 06 — SAFE ERROR RESPONSE FACTORY
# ============================================================

def create_error_response(
    code: ErrorCode,
    request_id: str,
) -> JSONResponse:
    """
    Produce the consistent frontend-facing error envelope.

    No internal paths, raw exceptions, traceback details,
    patient names or DICOM metadata are returned.
    """

    definition = ERROR_DEFINITIONS[code]

    payload: dict[str, Any] = {
        "success": False,
        "error": {
            "code": code.value,
            "message": definition.message,
            "retryable": definition.retryable,
            "request_id": request_id,
        },
    }

    headers = {
        "X-Request-ID": request_id,
        "Cache-Control": "no-store",
    }

    if definition.status_code == 401:
        headers["WWW-Authenticate"] = "Session"

    if definition.status_code == 429:
        headers["Retry-After"] = "30"

    return JSONResponse(
        status_code=definition.status_code,
        content=payload,
        headers=headers,
    )


# ============================================================
# 07 — SAFE OPERATIONAL ERROR LOGGING
# ============================================================

LOGGING_ERROR_MAP: dict[ErrorCode, str] = {
    ErrorCode.CONFIG_ERROR: "CONFIG_ERROR",
    ErrorCode.AUTH_FAILED: "AUTH_FAILED",
    ErrorCode.ACCESS_DENIED: "ACCESS_DENIED",
    ErrorCode.PATH_REJECTED: "PATH_REJECTED",
    ErrorCode.DICOM_INVALID: "DICOM_INVALID",
    ErrorCode.DICOM_UNSUPPORTED: "DICOM_UNSUPPORTED",
    ErrorCode.SERIES_INVALID: "SERIES_INVALID",
    ErrorCode.GEOMETRY_INVALID: "GEOMETRY_INVALID",
    ErrorCode.VOLUME_TOO_LARGE: "VOLUME_TOO_LARGE",
    ErrorCode.MEMORY_LIMIT: "OUT_OF_MEMORY",
    ErrorCode.DICOM_DECODING_FAILED: "DECODER_ERROR",
    ErrorCode.OPERATION_TIMEOUT: "TIMEOUT",
}


def _log_safe_error(
    code: ErrorCode,
    request_id: str,
) -> None:
    """
    Log an allowlisted operational category.

    Logging never includes full URLs or patient-derived text.
    """

    safe_code = LOGGING_ERROR_MAP.get(
        code,
        "INTERNAL_ERROR",
    )

    get_logger().error(
        "request_failed",
        error_code=safe_code,
        component="api",
        request_id=request_id,
    )


# ============================================================
# 08 — FASTAPI EXCEPTION HANDLERS
# ============================================================

async def handle_application_error(
    request: Request,
    exc: SinusViewerError,
) -> JSONResponse:
    request_id = get_request_id(request)

    _log_safe_error(exc.code, request_id)

    return create_error_response(
        code=exc.code,
        request_id=request_id,
    )


async def handle_request_validation_error(
    request: Request,
    exc: RequestValidationError,
) -> JSONResponse:
    # Do not serialize exc.errors() or exc.body:
    # request validation payloads may contain sensitive data.

    request_id = get_request_id(request)

    _log_safe_error(
        ErrorCode.INVALID_REQUEST,
        request_id,
    )

    return create_error_response(
        ErrorCode.INVALID_REQUEST,
        request_id,
    )


async def handle_http_error(
    request: Request,
    exc: StarletteHTTPException,
) -> JSONResponse:
    request_id = get_request_id(request)

    if exc.status_code == 401:
        code = ErrorCode.AUTH_REQUIRED
    elif exc.status_code == 403:
        code = ErrorCode.ACCESS_DENIED
    elif exc.status_code == 404:
        code = ErrorCode.RESOURCE_NOT_FOUND
    elif exc.status_code == 405:
        code = ErrorCode.METHOD_NOT_ALLOWED
    elif exc.status_code == 429:
        code = ErrorCode.RATE_LIMITED
    elif exc.status_code == 503:
        code = ErrorCode.SERVICE_UNAVAILABLE
    else:
        code = ErrorCode.INTERNAL_ERROR

    _log_safe_error(code, request_id)

    return create_error_response(code, request_id)


async def handle_unexpected_error(
    request: Request,
    exc: Exception,
) -> JSONResponse:
    """
    Catch unexpected errors without leaking details.

    Raw exception strings and stack traces are not logged.
    """

    request_id = get_request_id(request)

    _log_safe_error(
        ErrorCode.INTERNAL_ERROR,
        request_id,
    )

    return create_error_response(
        ErrorCode.INTERNAL_ERROR,
        request_id,
    )


# ============================================================
# 09 — REGISTER ALL HANDLERS
# ============================================================

def register_exception_handlers(app: FastAPI) -> None:
    """
    Register centralized handlers during FastAPI startup.

    Calling this function does not scan or modify datasets.
    """

    app.add_exception_handler(
        SinusViewerError,
        handle_application_error,
    )

    app.add_exception_handler(
        RequestValidationError,
        handle_request_validation_error,
    )

    app.add_exception_handler(
        StarletteHTTPException,
        handle_http_error,
    )

    app.add_exception_handler(
        Exception,
        handle_unexpected_error,
    )


# ============================================================
# END OF EXCEPTION ENGINE
# ============================================================
