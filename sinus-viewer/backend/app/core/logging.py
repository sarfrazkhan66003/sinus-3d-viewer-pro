
"""
SINUS VIEWER — SECURE STRUCTURED LOGGING
=========================================

Goals:
- Standard Python logging for FastAPI and backend modules.
- JSON-formatted operational logs.
- Safe allowlisted metadata only.
- No patient identifiers, DICOM metadata or raw file paths.
- Optional rotating logs outside the dataset.
- No filesystem changes during import.
- No installation or execution required on local Windows.

IMPORTANT:
Automatic redaction cannot guarantee removal of all PHI from
arbitrary free-form text. Never pass patient-derived values,
request bodies, full paths or raw exception strings to logs.
"""

from __future__ import annotations

import json
import logging
import re
import sys
import threading
from datetime import datetime, timezone
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Any, Mapping

from .config import AppSettings, get_settings


# ============================================================
# 01 — CONSTANTS
# ============================================================

LOGGER_NAMESPACE = "sinus_viewer"

SAFE_CONTEXT_KEYS = frozenset({
    "event",
    "component",
    "operation",
    "status",
    "error_code",
    "request_id",
    "duration_ms",
    "elapsed_ms",
    "count",
    "series_count",
    "slice_count",
    "volume_count",
    "bytes_processed",
    "cache_hit",
    "retry_count",
    "hardware_type",
    "device_type",
    "memory_mb",
    "volume_mb",
})

NUMERIC_KEYS = frozenset({
    "duration_ms",
    "elapsed_ms",
    "count",
    "series_count",
    "slice_count",
    "volume_count",
    "bytes_processed",
    "retry_count",
    "memory_mb",
    "volume_mb",
})

BOOLEAN_KEYS = frozenset({
    "cache_hit",
})

SAFE_TOKEN_RE = re.compile(r"^[a-zA-Z0-9_.:-]{1,64}$")
SAFE_REQUEST_ID_RE = re.compile(r"^[a-zA-Z0-9_-]{1,64}$")

SAFE_EVENT_NAMES = frozenset({
    "startup",
    "shutdown",
    "health_check",
    "dataset_scan_started",
    "dataset_scan_completed",
    "dataset_scan_failed",
    "patient_index_completed",
    "series_discovery_completed",
    "series_load_started",
    "series_load_completed",
    "series_load_failed",
    "volume_build_started",
    "volume_build_completed",
    "volume_build_failed",
    "cache_lookup",
    "cache_eviction",
    "authentication_success",
    "authentication_failure",
    "request_completed",
    "request_failed",
    "hardware_detected",
    "unexpected_error",
})

SAFE_ERROR_CODES = frozenset({
    "CONFIG_ERROR",
    "AUTH_FAILED",
    "ACCESS_DENIED",
    "PATH_REJECTED",
    "DICOM_INVALID",
    "DICOM_UNSUPPORTED",
    "SERIES_INVALID",
    "GEOMETRY_INVALID",
    "VOLUME_TOO_LARGE",
    "OUT_OF_MEMORY",
    "DECODER_ERROR",
    "TIMEOUT",
    "INTERNAL_ERROR",
})

_SAFE_LEVELS = {
    "DEBUG": logging.DEBUG,
    "INFO": logging.INFO,
    "WARNING": logging.WARNING,
    "ERROR": logging.ERROR,
    "CRITICAL": logging.CRITICAL,
}

_CONFIGURATION_LOCK = threading.RLock()


# ============================================================
# 02 — SAFE CONTEXT SANITIZATION
# ============================================================

def _safe_token(value: Any) -> str | None:
    """
    Accept only simple machine-generated operational tokens.

    Do not use for names, patient IDs or file paths.
    """
    if not isinstance(value, str):
        return None

    if not SAFE_TOKEN_RE.fullmatch(value):
        return None

    return value


def _sanitize_context(
    context: Mapping[str, Any] | None,
) -> dict[str, Any]:
    """
    Filter additional log fields through an explicit allowlist.

    Unrecognized keys and unsafe values are dropped.
    """
    if not context:
        return {}

    result: dict[str, Any] = {}

    for key, value in context.items():
        if key not in SAFE_CONTEXT_KEYS:
            continue

        if key in NUMERIC_KEYS:
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                if abs(value) <= 1e15:
                    result[key] = value
            continue

        if key in BOOLEAN_KEYS:
            if isinstance(value, bool):
                result[key] = value
            continue

        if key == "event":
            if value in SAFE_EVENT_NAMES:
                result[key] = value
            continue

        if key == "error_code":
            if value in SAFE_ERROR_CODES:
                result[key] = value
            continue

        if key == "request_id":
            if isinstance(value, str) and SAFE_REQUEST_ID_RE.fullmatch(value):
                result[key] = value
            continue

        token = _safe_token(value)
        if token is not None:
            result[key] = token

    return result


# ============================================================
# 03 — SECURE FORMATTER
# ============================================================

class SecureJSONFormatter(logging.Formatter):
    """
    Convert log records into JSON.

    Raw record messages are intentionally excluded.
    Only controlled operational event identifiers and safe
    structured context are serialized.

    Tracebacks, stack information and arbitrary record
    attributes are never serialized.
    """

    def format(self, record: logging.LogRecord) -> str:
        event = getattr(record, "safe_event", "unexpected_error")

        if event not in SAFE_EVENT_NAMES:
            event = "unexpected_error"

        context = _sanitize_context(
            getattr(record, "safe_context", None)
        )

        output: dict[str, Any] = {
            "timestamp": datetime.fromtimestamp(
                record.created,
                tz=timezone.utc,
            ).isoformat(),
            "level": record.levelname,
            "logger": LOGGER_NAMESPACE,
            "event": event,
        }

        context.pop("event", None)
        output.update(context)

        return json.dumps(
            output,
            ensure_ascii=True,
            separators=(",", ":"),
            allow_nan=False,
        )


class SecureTextFormatter(SecureJSONFormatter):
    """
    Compact text representation of sanitized JSON records.
    """

    def format(self, record: logging.LogRecord) -> str:
        payload = json.loads(super().format(record))

        timestamp = payload.pop("timestamp")
        level = payload.pop("level")
        event = payload.pop("event")

        payload.pop("logger", None)

        details = " ".join(
            f"{key}={value}"
            for key, value in payload.items()
        )

        return (
            f"{timestamp} [{level}] {event}"
            + (f" {details}" if details else "")
        )


# ============================================================
# 04 — SAFE LOGGER ADAPTER
# ============================================================

class SecureLogger:
    """
    Controlled interface for application event logging.

    Do not pass raw exceptions or patient-derived data.
    Use fixed error codes instead.
    """

    def __init__(self, logger: logging.Logger):
        self._logger = logger

    def log(
        self,
        level: int,
        event: str,
        **context: Any,
    ) -> None:
        safe_event = (
            event if event in SAFE_EVENT_NAMES
            else "unexpected_error"
        )

        safe_context = _sanitize_context(context)

        self._logger.log(
            level,
            safe_event,
            extra={
                "safe_event": safe_event,
                "safe_context": safe_context,
            },
            exc_info=False,
            stack_info=False,
        )

    def debug(self, event: str, **context: Any) -> None:
        self.log(logging.DEBUG, event, **context)

    def info(self, event: str, **context: Any) -> None:
        self.log(logging.INFO, event, **context)

    def warning(self, event: str, **context: Any) -> None:
        self.log(logging.WARNING, event, **context)

    def error(self, event: str, **context: Any) -> None:
        self.log(logging.ERROR, event, **context)

    def critical(self, event: str, **context: Any) -> None:
        self.log(logging.CRITICAL, event, **context)


# ============================================================
# 05 — LOG PATH VALIDATION
# ============================================================

def _validate_log_directory(
    settings: AppSettings,
) -> Path:
    """
    Ensure log output remains inside the dedicated runtime.

    Dataset source and runtime destinations must remain
    separate. Path guards will additionally secure all
    patient-file API operations.
    """

    dataset_root = settings.storage.dataset.root_path.resolve(
        strict=False
    )

    runtime_root = settings.storage.runtime.root_path.resolve(
        strict=False
    )

    log_directory = settings.storage.runtime.logs_path.resolve(
        strict=False
    )

    if (
        log_directory == dataset_root
        or log_directory.is_relative_to(dataset_root)
    ):
        raise ValueError(
            "Logging inside the dataset is forbidden."
        )

    if (
        log_directory == runtime_root
        or not log_directory.is_relative_to(runtime_root)
    ):
        raise ValueError(
            "Log directory must be inside runtime storage."
        )

    return log_directory


# ============================================================
# 06 — LOGGING SETUP
# ============================================================

def configure_logging(
    settings: AppSettings | None = None,
    *,
    enable_file_logging: bool | None = None,
) -> SecureLogger:
    """
    Configure application logging once per explicit startup.

    No directories are created during module import.

    File output is optional and stored outside the dataset.
    """

    active = settings if settings is not None else get_settings()

    log_config = active.logging

    level = _SAFE_LEVELS[log_config.level]

    logger = logging.getLogger(LOGGER_NAMESPACE)

    formatter: logging.Formatter

    if log_config.format == "structured":
        formatter = SecureJSONFormatter()
    else:
        formatter = SecureTextFormatter()

    use_files = (
        log_config.file_enabled
        if enable_file_logging is None
        else enable_file_logging
    )

    with _CONFIGURATION_LOCK:
        handlers: list[logging.Handler] = []

        if log_config.console:
            console = logging.StreamHandler(sys.stdout)
            console.setFormatter(formatter)
            console.setLevel(level)
            handlers.append(console)

        if use_files:
            log_directory = _validate_log_directory(active)

            # Application logs only. Never create dataset folders.
            log_directory.mkdir(
                parents=True,
                exist_ok=True,
            )

            file_handler = RotatingFileHandler(
                filename=log_directory / "sinus_viewer.log",
                mode="a",
                maxBytes=log_config.rotate_mb * 1024 * 1024,
                backupCount=max(
                    1,
                    min(log_config.retention_days, 30),
                ),
                encoding="utf-8",
                delay=True,
            )

            file_handler.setFormatter(formatter)
            file_handler.setLevel(level)
            handlers.append(file_handler)

        logger.disabled = False
        logger.setLevel(level)

        # Avoid propagation into uncontrolled root/Uvicorn
        # handlers that might serialize raw event arguments.
        logger.propagate = False

        previous_handlers = list(logger.handlers)

        for handler in previous_handlers:
            logger.removeHandler(handler)

        for handler in handlers:
            logger.addHandler(handler)

        for handler in previous_handlers:
            handler.close()

    return SecureLogger(logger)


# ============================================================
# 07 — LOGGER ACCESS
# ============================================================

def get_logger() -> SecureLogger:
    """
    Obtain the dedicated application logger.

    This does not initialize logging or create directories.
    Startup code must call configure_logging() explicitly.
    """

    logger = logging.getLogger(LOGGER_NAMESPACE)
    return SecureLogger(logger)


# ============================================================
# 08 — SAFE ERROR LOGGING
# ============================================================

def log_error(
    *,
    error_code: str,
    component: str = "backend",
    request_id: str | None = None,
) -> None:
    """
    Log only a standardized error category.

    Do not provide exception messages, file paths,
    DICOM metadata or patient identifiers.
    """

    if error_code not in SAFE_ERROR_CODES:
        error_code = "INTERNAL_ERROR"

    context: dict[str, Any] = {
        "error_code": error_code,
        "component": component,
    }

    if request_id is not None:
        context["request_id"] = request_id

    get_logger().error(
        "unexpected_error",
        **context,
    )


# ============================================================
# END OF LOGGING MODULE
# ============================================================
