
"""
SINUS VIEWER — CENTRAL CONFIGURATION ENGINE
============================================

Responsibilities:
- Load config/settings.yaml safely.
- Validate important application settings.
- Resolve project-relative paths.
- Enforce configuration-level dataset protection.
- Keep runtime cache outside the original dataset.
- Provide typed configuration to backend modules.
- Read authentication secrets from environment variables.
- Never modify original dataset files.

No package installation or code execution is required locally.
"""

from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path
from typing import Any, Literal

import yaml
from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    ValidationError,
    field_validator,
    model_validator,
)


# ============================================================
# 01 — PROJECT CONSTANTS
# ============================================================

PROJECT_ROOT = Path(__file__).resolve().parents[3]

DEFAULT_CONFIG_PATH = PROJECT_ROOT / "config" / "settings.yaml"

SUPPORTED_ENVIRONMENTS = {
    "development",
    "staging",
    "production",
}

SUPPORTED_HARDWARE_MODES = {
    "auto",
    "cpu",
    "gpu",
}


# ============================================================
# 02 — CONFIGURATION EXCEPTIONS
# ============================================================

class ConfigurationError(RuntimeError):
    """Raised when configuration cannot be safely loaded."""


class ConfigurationSecurityError(ConfigurationError):
    """Raised when a configuration violates a safety rule."""


# ============================================================
# 03 — BASE MODEL
# ============================================================

class ConfigSection(BaseModel):
    """
    Shared configuration model.

    Unknown fields are rejected to catch configuration typos.
    Models are frozen to prevent direct field reassignment.
    """

    model_config = ConfigDict(
        extra="forbid",
        frozen=True,
        validate_default=True,
    )


# ============================================================
# 04 — APPLICATION CONFIGURATION
# ============================================================

class ViewerConfig(ConfigSection):
    title: str = "Sinus Viewer"
    default_theme: Literal["dark", "light"] = "dark"
    default_layout: Literal["2x2", "1x3", "single"] = "2x2"
    default_page: str = "datasets"

    enable_3d: bool = True
    enable_measurements: bool = True
    enable_crosshairs: bool = True
    enable_keyboard_shortcuts: bool = True

    show_dicom_metadata: bool = True
    show_patient_identifiers: bool = False


class ApplicationConfig(ConfigSection):
    name: str = "Sinus Viewer"
    version: str = "0.1.0"
    environment: Literal[
        "development",
        "staging",
        "production",
    ] = "development"

    debug: bool = False
    timezone: str = "UTC"

    viewer: ViewerConfig = Field(default_factory=ViewerConfig)


# ============================================================
# 05 — SERVER CONFIGURATION
# ============================================================

class CorsConfig(ConfigSection):
    enabled: bool = False
    allowed_origins: list[str] = Field(default_factory=list)
    allow_credentials: bool = False


class ServerLimits(ConfigSection):
    max_concurrent_volume_loads: int = Field(default=1, ge=1)
    max_concurrent_metadata_scans: int = Field(default=2, ge=1)
    max_request_body_mb: int = Field(default=16, ge=1)


class ServerConfig(ConfigSection):
    host: str = "127.0.0.1"
    port: int = Field(default=8000, ge=1, le=65535)
    workers: int = Field(default=1, ge=1)
    reload: bool = False

    api_prefix: str = "/api"
    docs_enabled: bool = False

    request_timeout_seconds: int = Field(default=120, ge=1)

    cors: CorsConfig = Field(default_factory=CorsConfig)
    limits: ServerLimits = Field(default_factory=ServerLimits)

    @field_validator("api_prefix")
    @classmethod
    def validate_api_prefix(cls, value: str) -> str:
        if not value.startswith("/") or value == "/":
            raise ValueError(
                "API prefix must be an absolute URL path."
            )

        if ".." in value or "//" in value:
            raise ValueError("Invalid API prefix.")

        return value.rstrip("/")


# ============================================================
# 06 — STORAGE CONFIGURATION
# ============================================================

class DatasetStorageConfig(ConfigSection):
    access_mode: Literal["read_only"] = "read_only"

    root_path: Path = Path("/content/drive/MyDrive")

    allow_arbitrary_filesystem_paths: bool = False
    follow_symlinks: bool = False
    allow_hidden_directories: bool = False


class RuntimeStorageConfig(ConfigSection):
    root_path: Path = Path("/content/sinus_viewer_runtime")
    cache_path: Path = Path("/content/sinus_viewer_runtime/cache")
    temp_path: Path = Path("/content/sinus_viewer_runtime/temp")
    logs_path: Path = Path("/content/sinus_viewer_runtime/logs")


class CleanupConfig(ConfigSection):
    delete_runtime_cache_on_exit: bool = True
    delete_temporary_files_on_exit: bool = True
    never_cleanup_dataset_paths: bool = True


class StorageConfig(ConfigSection):
    dataset: DatasetStorageConfig = Field(
        default_factory=DatasetStorageConfig
    )

    runtime: RuntimeStorageConfig = Field(
        default_factory=RuntimeStorageConfig
    )

    cleanup: CleanupConfig = Field(
        default_factory=CleanupConfig
    )


# ============================================================
# 07 — DICOM CONFIGURATION
# ============================================================

class DicomDiscoveryConfig(ConfigSection):
    recursive: bool = True
    max_directory_depth: int = Field(default=12, ge=1)

    supported_extensions: list[str] = Field(
        default_factory=lambda: [".dcm", ".dicom", ".ima", ""]
    )

    detect_extensionless_dicom: bool = True
    ignore_hidden_files: bool = True
    ignore_dicomdir: bool = True
    use_metadata_not_filename_order: bool = True


class DicomMetadataConfig(ConfigSection):
    stop_before_pixels: bool = True
    require_patient_id: bool = False
    require_study_uid: bool = False
    require_series_uid: bool = False
    mask_identifiers_in_logs: bool = True


class DicomSeriesConfig(ConfigSection):
    allow_multiple_series_per_patient: bool = True
    group_by_study_and_series_uid: bool = True
    auto_select_largest_series: bool = False

    minimum_slices_for_volume: int = Field(default=3, ge=2)

    reject_mixed_orientation: bool = True
    reject_mixed_dimensions: bool = True
    reject_inconsistent_geometry: bool = True

    slice_spacing_tolerance_mm: float = Field(
        default=0.15,
        gt=0,
    )


class DicomDecodingConfig(ConfigSection):
    enable_compressed_dicom: bool = True
    prefer_simpleitk: bool = True
    fallback_to_pydicom: bool = True
    require_pixel_data: bool = True
    validate_pixel_array: bool = True


class VolumePreviewConfig(ConfigSection):
    enabled: bool = True
    max_dimension: int = Field(default=384, ge=64)
    downsample_only: bool = True


class FullResolutionConfig(ConfigSection):
    enabled: bool = True
    load_on_demand: bool = True


class DicomVolumeConfig(ConfigSection):
    output_axis_order: Literal["zyx"] = "zyx"

    preserve_original_spacing: bool = True
    preserve_patient_orientation: bool = True

    coordinate_system: Literal["LPS"] = "LPS"

    allow_nonuniform_spacing_without_resampling: bool = False
    resample_nonuniform_spacing: bool = False

    pixel_dtype_policy: Literal["preserve"] = "preserve"
    modality_lut: bool = True

    max_voxels: int = Field(
        default=268435456,
        ge=1,
    )

    max_uncompressed_volume_mb: int = Field(
        default=2048,
        ge=64,
    )

    preview: VolumePreviewConfig = Field(
        default_factory=VolumePreviewConfig
    )

    full_resolution: FullResolutionConfig = Field(
        default_factory=FullResolutionConfig
    )


class DicomConfig(ConfigSection):
    discovery: DicomDiscoveryConfig = Field(
        default_factory=DicomDiscoveryConfig
    )

    metadata: DicomMetadataConfig = Field(
        default_factory=DicomMetadataConfig
    )

    series: DicomSeriesConfig = Field(
        default_factory=DicomSeriesConfig
    )

    decoding: DicomDecodingConfig = Field(
        default_factory=DicomDecodingConfig
    )

    volume: DicomVolumeConfig = Field(
        default_factory=DicomVolumeConfig
    )


# ============================================================
# 08 — HARDWARE CONFIGURATION
# ============================================================

class CpuConfig(ConfigSection):
    enabled: bool = True
    max_workers: int = Field(default=4, ge=1)
    reserve_system_memory_gb: float = Field(default=2, ge=0)


class GpuConfig(ConfigSection):
    enabled: bool = True
    detect_cuda: bool = True
    enable_optional_gpu_preprocessing: bool = True

    minimum_free_vram_gb: float = Field(
        default=2,
        ge=0,
    )

    supported_targets: list[str] = Field(
        default_factory=lambda: [
            "NVIDIA_T4",
            "NVIDIA_L4",
            "NVIDIA_A100",
        ]
    )


class TpuConfig(ConfigSection):
    enabled: bool = False


class BrowserHardwareConfig(ConfigSection):
    prefer_webgl2: bool = True
    allow_webgl1_fallback: bool = False
    enable_gpu_rendering: bool = True


class HardwareConfig(ConfigSection):
    selection_mode: Literal["auto", "cpu", "gpu"] = "auto"

    priority: list[Literal["gpu", "cpu"]] = Field(
        default_factory=lambda: ["gpu", "cpu"]
    )

    cpu: CpuConfig = Field(default_factory=CpuConfig)
    gpu: GpuConfig = Field(default_factory=GpuConfig)
    tpu: TpuConfig = Field(default_factory=TpuConfig)

    browser: BrowserHardwareConfig = Field(
        default_factory=BrowserHardwareConfig
    )


# ============================================================
# 09 — PERFORMANCE CONFIGURATION
# ============================================================

class IndexingConfig(ConfigSection):
    use_background_threads: bool = True
    batch_size: int = Field(default=64, ge=1)
    metadata_cache_enabled: bool = True


class StreamingConfig(ConfigSection):
    enabled: bool = True
    progressive_loading: bool = True
    chunk_size_kb: int = Field(default=1024, ge=1)
    max_parallel_requests: int = Field(default=4, ge=1)


class MemoryConfig(ConfigSection):
    enable_memory_guard: bool = True

    max_ram_utilization_percent: int = Field(
        default=75,
        ge=10,
        le=95,
    )

    minimum_free_ram_gb: float = Field(
        default=2,
        ge=0,
    )


class CacheConfig(ConfigSection):
    enabled: bool = True
    storage: Literal["disk"] = "disk"

    max_disk_cache_gb: float = Field(default=8, gt=0)
    max_in_memory_volumes: int = Field(default=1, ge=1)

    cache_ttl_minutes: int = Field(default=120, ge=1)
    invalidate_on_source_change: bool = True


class RenderingConfig(ConfigSection):
    preferred_backend: Literal["browser_webgl"] = "browser_webgl"

    enable_volume_rendering: bool = True
    enable_mpr: bool = True
    enable_interactive_quality_adaptation: bool = True

    desired_interaction_fps: int = Field(
        default=60,
        ge=1,
        le=240,
    )

    idle_quality_restore_ms: int = Field(
        default=300,
        ge=0,
    )


class PerformanceConfig(ConfigSection):
    indexing: IndexingConfig = Field(
        default_factory=IndexingConfig
    )

    streaming: StreamingConfig = Field(
        default_factory=StreamingConfig
    )

    memory: MemoryConfig = Field(
        default_factory=MemoryConfig
    )

    cache: CacheConfig = Field(
        default_factory=CacheConfig
    )

    rendering: RenderingConfig = Field(
        default_factory=RenderingConfig
    )


# ============================================================
# 10 — SECURITY CONFIGURATION
# ============================================================

class CredentialConfig(ConfigSection):
    source: Literal["environment"] = "environment"

    username_env: str = "SINUS_VIEWER_USERNAME"
    password_hash_env: str = "SINUS_VIEWER_PASSWORD_HASH"


class SessionConfig(ConfigSection):
    enabled: bool = True
    idle_timeout_minutes: int = Field(default=30, ge=1)
    absolute_timeout_hours: int = Field(default=8, ge=1)

    cookie_http_only: bool = True
    cookie_secure: bool = True

    cookie_same_site: Literal[
        "lax",
        "strict",
        "none",
    ] = "lax"


class SecurityAccessConfig(ConfigSection):
    restrict_paths_to_dataset_root: bool = True
    reject_path_traversal: bool = True
    reject_symlinks: bool = True
    require_authenticated_api: bool = True


class SecurityLoggingConfig(ConfigSection):
    log_patient_names: bool = False
    log_patient_ids: bool = False
    log_dicom_metadata: bool = False
    log_request_bodies: bool = False
    redact_query_parameters: bool = True


class SecurityConfig(ConfigSection):
    require_authentication: bool = True
    allow_anonymous_access: bool = False
    allow_public_dataset_browsing: bool = False

    credentials: CredentialConfig = Field(
        default_factory=CredentialConfig
    )

    sessions: SessionConfig = Field(
        default_factory=SessionConfig
    )

    access: SecurityAccessConfig = Field(
        default_factory=SecurityAccessConfig
    )

    logging: SecurityLoggingConfig = Field(
        default_factory=SecurityLoggingConfig
    )


# ============================================================
# 11 — DEPLOYMENT CONFIGURATION
# ============================================================

class DependencyDeploymentConfig(ConfigSection):
    install_on_colab: bool = True
    install_locally: bool = False
    build_frontend_on_colab: bool = True


class FrontendDeploymentConfig(ConfigSection):
    serve_from_fastapi: bool = True
    build_directory: str = "frontend/dist"


class ExternalAccessConfig(ConfigSection):
    enabled: bool = True
    provider: str = "configurable"

    expose_single_authenticated_origin: bool = True
    require_https: bool = True
    display_access_url_in_colab: bool = True


class StartupConfig(ConfigSection):
    check_dependencies: bool = True
    check_drive_mount: bool = True
    check_available_memory: bool = True
    check_gpu: bool = True
    check_frontend_build: bool = True
    check_backend_health: bool = True


class DeploymentConfig(ConfigSection):
    platform: Literal["google_colab"] = "google_colab"

    dependencies: DependencyDeploymentConfig = Field(
        default_factory=DependencyDeploymentConfig
    )

    frontend: FrontendDeploymentConfig = Field(
        default_factory=FrontendDeploymentConfig
    )

    external_access: ExternalAccessConfig = Field(
        default_factory=ExternalAccessConfig
    )

    startup: StartupConfig = Field(
        default_factory=StartupConfig
    )


# ============================================================
# 12 — LOGGING AND ERROR CONFIGURATION
# ============================================================

class LoggingConfig(ConfigSection):
    level: Literal[
        "DEBUG",
        "INFO",
        "WARNING",
        "ERROR",
        "CRITICAL",
    ] = "INFO"

    console: bool = True
    file_enabled: bool = True

    format: Literal["structured", "text"] = "structured"

    rotate_mb: int = Field(default=20, ge=1)
    retention_days: int = Field(default=7, ge=1)

    include_tracebacks: bool = False
    redact_sensitive_fields: bool = True


class RecoveryConfig(ConfigSection):
    allow_return_to_patient_list: bool = True
    allow_select_another_series: bool = True
    clear_failed_volume_cache: bool = True
    preserve_navigation_state: bool = True


class ErrorConfig(ConfigSection):
    expose_internal_tracebacks_to_browser: bool = False

    show_user_friendly_messages: bool = True
    enable_retry_for_transient_failures: bool = True

    maximum_retry_attempts: int = Field(
        default=2,
        ge=0,
        le=10,
    )

    recovery: RecoveryConfig = Field(
        default_factory=RecoveryConfig
    )


# ============================================================
# 13 — MAIN APPLICATION SETTINGS MODEL
# ============================================================

class AppSettings(ConfigSection):
    """
    Main validated configuration model.

    Every top-level section corresponds to settings.yaml.
    """

    application: ApplicationConfig
    server: ServerConfig
    storage: StorageConfig
    dicom: DicomConfig
    hardware: HardwareConfig
    performance: PerformanceConfig
    security: SecurityConfig
    deployment: DeploymentConfig
    logging: LoggingConfig
    errors: ErrorConfig

    @model_validator(mode="after")
    def validate_security_invariants(self) -> "AppSettings":
        """
        Reject configurations violating required safety rules.
        """

        dataset = self.storage.dataset
        access = self.security.access
        sessions = self.security.sessions

        if dataset.access_mode != "read_only":
            raise ValueError(
                "Original DICOM datasets must remain read-only."
            )

        if dataset.allow_arbitrary_filesystem_paths:
            raise ValueError(
                "Arbitrary filesystem access is forbidden."
            )

        if dataset.follow_symlinks:
            raise ValueError(
                "Dataset symlink traversal must remain disabled."
            )

        if not self.storage.cleanup.never_cleanup_dataset_paths:
            raise ValueError(
                "Dataset cleanup protection must remain enabled."
            )

        if not self.security.require_authentication:
            raise ValueError(
                "Authentication cannot be disabled."
            )

        if self.security.allow_anonymous_access:
            raise ValueError(
                "Anonymous access is forbidden."
            )

        if self.security.allow_public_dataset_browsing:
            raise ValueError(
                "Public dataset browsing is forbidden."
            )

        if not access.restrict_paths_to_dataset_root:
            raise ValueError(
                "Dataset path restrictions cannot be disabled."
            )

        if not access.reject_path_traversal:
            raise ValueError(
                "Path traversal protection cannot be disabled."
            )

        if not access.reject_symlinks:
            raise ValueError(
                "Symlink protection cannot be disabled."
            )

        if not access.require_authenticated_api:
            raise ValueError(
                "All patient data APIs require authentication."
            )

        if not sessions.enabled:
            raise ValueError("Sessions must remain enabled.")

        if not sessions.cookie_http_only:
            raise ValueError("HttpOnly cookies are required.")

        if not sessions.cookie_secure:
            raise ValueError("Secure cookies are required.")

        if self.deployment.dependencies.install_locally:
            raise ValueError(
                "Local dependency installation is disabled."
            )

        if self.deployment.external_access.enabled:
            if not self.deployment.external_access.require_https:
                raise ValueError(
                    "External access must require HTTPS."
                )

        if self.server.host not in {
            "127.0.0.1",
            "localhost",
            "::1",
        }:
            raise ValueError(
                "Backend must bind to loopback only."
            )

        if self.server.cors.enabled:
            raise ValueError(
                "Cross-origin API access is disabled in this deployment."
            )

        if self.logging.include_tracebacks:
            raise ValueError(
                "Production-safe logging cannot include tracebacks."
            )

        sensitive = self.security.logging

        if any((
            sensitive.log_patient_names,
            sensitive.log_patient_ids,
            sensitive.log_dicom_metadata,
            sensitive.log_request_bodies,
        )):
            raise ValueError(
                "Sensitive patient information logging is forbidden."
            )

        if not sensitive.redact_query_parameters:
            raise ValueError(
                "Query parameter redaction must remain enabled."
            )

        if self.errors.expose_internal_tracebacks_to_browser:
            raise ValueError(
                "Internal tracebacks must not be exposed."
            )

        self._validate_storage_paths()

        return self

    def _validate_storage_paths(self) -> None:
        """
        Validate storage isolation without creating directories.

        The dataset root must not contain runtime cache paths.
        """

        dataset_root = self.storage.dataset.root_path
        runtime = self.storage.runtime

        if not dataset_root.is_absolute():
            raise ValueError(
                "Dataset root path must be absolute."
            )

        if not runtime.root_path.is_absolute():
            raise ValueError(
                "Runtime root path must be absolute."
            )

        source = dataset_root.resolve(strict=False)
        output = runtime.root_path.resolve(strict=False)

        if source == output:
            raise ValueError(
                "Runtime and dataset roots cannot be identical."
            )

        if output.is_relative_to(source):
            raise ValueError(
                "Runtime directory cannot be inside the dataset root."
            )

        if source.is_relative_to(output):
            raise ValueError(
                "Dataset root cannot be inside runtime storage."
            )

        for name, path in (
            ("cache", runtime.cache_path),
            ("temp", runtime.temp_path),
            ("logs", runtime.logs_path),
        ):
            if not path.is_absolute():
                raise ValueError(
                    f"Runtime {name} path must be absolute."
                )

            resolved = path.resolve(strict=False)

            if resolved == output:
                raise ValueError(
                    f"Runtime {name} must be a subdirectory."
                )

            if not resolved.is_relative_to(output):
                raise ValueError(
                    f"Runtime {name} must remain inside runtime root."
                )

    @property
    def dataset_root(self) -> Path:
        """Configured dataset root; does not scan it."""
        return self.storage.dataset.root_path

    @property
    def runtime_root(self) -> Path:
        """Configured runtime root; does not create it."""
        return self.storage.runtime.root_path

    @property
    def is_production(self) -> bool:
        return self.application.environment == "production"


# ============================================================
# 14 — SAFE YAML LOADING
# ============================================================

def resolve_config_path(
    config_path: str | Path | None = None,
) -> Path:
    """
    Resolve a configuration path.

    Only the settings.yaml file under the project's config
    directory is accepted by the standard application loader.
    """

    allowed = DEFAULT_CONFIG_PATH.resolve(strict=False)

    if config_path is None:
        return allowed

    candidate = Path(config_path).expanduser()

    if not candidate.is_absolute():
        candidate = PROJECT_ROOT / candidate

    candidate = candidate.resolve(strict=False)

    if candidate != allowed:
        raise ConfigurationSecurityError(
            "Custom configuration locations are not permitted."
        )

    return candidate


def load_yaml_config(path: Path) -> dict[str, Any]:
    """
    Read YAML safely.

    This function never writes to the source file.
    """

    if not path.is_file():
        raise ConfigurationError(
            f"Configuration file not found: {path}"
        )

    try:
        with path.open(
            "r",
            encoding="utf-8",
        ) as handle:
            raw = yaml.safe_load(handle)

    except (OSError, yaml.YAMLError) as exc:
        raise ConfigurationError(
            "Unable to read application configuration."
        ) from exc

    if not isinstance(raw, dict):
        raise ConfigurationError(
            "Configuration must contain a YAML mapping."
        )

    return raw


# ============================================================
# 15 — ENVIRONMENT OVERRIDES
# ============================================================

def apply_environment_overrides(
    raw: dict[str, Any],
) -> dict[str, Any]:
    """
    Apply explicitly permitted environment overrides.

    Security settings cannot be weakened through environment
    variables.

    Secrets are never placed inside the serialized settings.
    """

    data = dict(raw)

    application = dict(data.get("application", {}))
    server = dict(data.get("server", {}))

    environment = os.getenv("SINUS_VIEWER_ENVIRONMENT")

    if environment:
        if environment not in SUPPORTED_ENVIRONMENTS:
            raise ConfigurationError(
                "Invalid SINUS_VIEWER_ENVIRONMENT value."
            )

        application["environment"] = environment

    port_value = os.getenv("SINUS_VIEWER_PORT")

    if port_value:
        try:
            port = int(port_value)
        except ValueError as exc:
            raise ConfigurationError(
                "SINUS_VIEWER_PORT must be an integer."
            ) from exc

        if not 1 <= port <= 65535:
            raise ConfigurationError(
                "SINUS_VIEWER_PORT is outside valid range."
            )

        server["port"] = port

    data["application"] = application
    data["server"] = server

    return data


# ============================================================
# 16 — LOAD AND VALIDATE SETTINGS
# ============================================================

def load_settings(
    config_path: str | Path | None = None,
) -> AppSettings:
    """
    Load the complete application configuration.

    This function:
    - Reads YAML.
    - Applies permitted environment overrides.
    - Validates schema and security invariants.

    It does NOT:
    - Install dependencies.
    - Mount Google Drive.
    - Scan patient folders.
    - Create directories.
    - Modify DICOM files.
    """

    path = resolve_config_path(config_path)

    raw = load_yaml_config(path)
    raw = apply_environment_overrides(raw)

    try:
        settings = AppSettings.model_validate(raw)

    except ValidationError as exc:
        # Avoid printing raw input values or settings content.
        problems = [
            ".".join(str(part) for part in error["loc"])
            for error in exc.errors()
        ]

        raise ConfigurationError(
            "Invalid configuration fields: "
            + ", ".join(problems)
        ) from exc

    return settings


# ============================================================
# 17 — CACHED CONFIGURATION ACCESS
# ============================================================

@lru_cache(maxsize=1)
def get_settings() -> AppSettings:
    """
    Return cached validated configuration.

    Suitable for FastAPI dependency injection.
    """

    return load_settings()


def clear_settings_cache() -> None:
    """
    Clear cached configuration.

    Intended for isolated tests and controlled reloads.
    """

    get_settings.cache_clear()


# ============================================================
# 18 — AUTHENTICATION ENVIRONMENT ACCESS
# ============================================================

def get_auth_environment(
    settings: AppSettings | None = None,
) -> tuple[str, str]:
    """
    Retrieve authentication material from environment variables.

    Never returns fallback/default credentials.

    Returns:
        (username, password_hash)

    Note:
        Password verification and session handling are
        implemented separately in security/auth.py.
    """

    active = settings or get_settings()

    credentials = active.security.credentials

    username = os.getenv(
        credentials.username_env,
        "",
    ).strip()

    password_hash = os.getenv(
        credentials.password_hash_env,
        "",
    ).strip()

    if not username or not password_hash:
        raise ConfigurationSecurityError(
            "Authentication credentials are not configured."
        )

    return username, password_hash


# ============================================================
# 19 — SAFE CONFIGURATION SUMMARY
# ============================================================

def get_safe_config_summary(
    settings: AppSettings | None = None,
) -> dict[str, Any]:
    """
    Return non-sensitive application configuration metadata.

    Dataset paths and authentication secrets are excluded.
    """

    active = settings or get_settings()

    return {
        "application": active.application.name,
        "version": active.application.version,
        "environment": active.application.environment,
        "platform": active.deployment.platform,
        "authentication_required": (
            active.security.require_authentication
        ),
        "dataset_access_mode": (
            active.storage.dataset.access_mode
        ),
        "hardware_selection": (
            active.hardware.selection_mode
        ),
        "browser_rendering": (
            active.performance.rendering.preferred_backend
        ),
        "mpr_enabled": (
            active.performance.rendering.enable_mpr
        ),
        "volume_rendering_enabled": (
            active.performance.rendering.enable_volume_rendering
        ),
    }


# ============================================================
# END OF CONFIGURATION MODULE
# ============================================================
