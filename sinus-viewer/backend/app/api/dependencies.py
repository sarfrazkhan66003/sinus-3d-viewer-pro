
"""
SINUS VIEWER — FASTAPI SERVICE DEPENDENCIES
===========================================

Central application service access for authenticated routes.

Responsibilities:
- Register shared backend services during FastAPI startup.
- Verify the complete required service registry.
- Resolve service instances from application state.
- Require trusted authentication for protected services.
- Provide typed dependencies for API route modules.
- Prevent accidental per-request service construction.
- Expose minimal, non-sensitive service readiness data.
- Support controlled shutdown through the lifespan manager.

Security contract:
- Authentication derives identity from the server session.
- Never accept owner_id from a browser request parameter.
- Dataset and volume methods still authorize each lookup.
- Services must be registered before requests are served.
- No fallback to a new, unauthenticated service instance.
- No source paths, DICOM identifiers or credentials in errors.
- The health dependency exposes service readiness only.
- Shutdown ordering is managed by the application lifespan.

This module performs no patient dataset file operations
and creates no filesystem artifacts.

Python 3.10+
FastAPI / Pydantic v2
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Annotated, Any, TypeVar

from fastapi import Depends, FastAPI, Request

from ..core.config import AppSettings
from ..core.exceptions import ConfigurationFailure
from ..security.auth import AuthenticationService
from ..security.session import (
    AuthenticatedContext,
    get_authentication_service,
    require_authenticated_context,
)
from ..services.cache_service import VolumeCacheService
from ..services.dataset_service import DatasetService
from ..services.preview_service import PreviewService
from ..services.streaming_service import VolumeStreamingService
from ..services.volume_service import VolumeService


# ============================================================
# 01 — APPLICATION STATE NAMES
# ============================================================

AUTH_STATE = "auth_service"
DATASET_STATE = "dataset_service"
CACHE_STATE = "cache_service"
VOLUME_STATE = "volume_service"
PREVIEW_STATE = "preview_service"
STREAMING_STATE = "streaming_service"
SETTINGS_STATE = "settings"

REGISTRY_FLAG = "sinus_services_registered"

REQUIRED_SERVICE_NAMES = (
    AUTH_STATE,
    DATASET_STATE,
    CACHE_STATE,
    VOLUME_STATE,
    PREVIEW_STATE,
    STREAMING_STATE,
)

SERVICE_TYPES: tuple[tuple[str, type], ...] = (
    (AUTH_STATE, AuthenticationService),
    (DATASET_STATE, DatasetService),
    (CACHE_STATE, VolumeCacheService),
    (VOLUME_STATE, VolumeService),
    (PREVIEW_STATE, PreviewService),
    (STREAMING_STATE, VolumeStreamingService),
)

T = TypeVar("T")


# ============================================================
# 02 — CONTROLLED REGISTRY ERRORS
# ============================================================

class ServiceRegistryError(RuntimeError):
    """
    Internal service registration error.

    No environment secrets, patient metadata or
    filesystem paths are attached.
    """

    public_code = "CONFIG_ERROR"

    def __init__(self) -> None:
        super().__init__(self.public_code)


class ServiceAlreadyRegistered(ServiceRegistryError):
    pass


class ServiceNotAvailable(ServiceRegistryError):
    pass


# ============================================================
# 03 — IMMUTABLE SERVICE BUNDLE
# ============================================================

@dataclass(frozen=True)
class ApplicationServices:
    """
    References to the six process-local services.

    Service instances themselves manage mutable state.
    This container does not copy volumes or patient data.
    """

    authentication: AuthenticationService
    datasets: DatasetService
    cache: VolumeCacheService
    volumes: VolumeService
    previews: PreviewService
    streaming: VolumeStreamingService
    settings: AppSettings

    def validate(self) -> None:
        """
        Enforce exact expected service categories.

        Existing service instances must be supplied by
        the application's trusted startup code.
        """

        expected = (
            (self.authentication, AuthenticationService),
            (self.datasets, DatasetService),
            (self.cache, VolumeCacheService),
            (self.volumes, VolumeService),
            (self.previews, PreviewService),
            (self.streaming, VolumeStreamingService),
            (self.settings, AppSettings),
        )

        for instance, expected_type in expected:
            if not isinstance(instance, expected_type):
                raise ServiceRegistryError()


# ============================================================
# 04 — REGISTER APPLICATION SERVICES
# ============================================================

def register_application_services(
    app: FastAPI,
    services: ApplicationServices,
) -> None:
    """
    Register all services atomically during application
    construction/lifespan initialization.

    Registration must happen before serving HTTP requests.

    The service bundle is built by trusted startup code
    after configuration and credential validation.
    """

    if not isinstance(app, FastAPI):
        raise TypeError("FastAPI application required.")

    if not isinstance(services, ApplicationServices):
        raise ServiceRegistryError()

    services.validate()

    state = app.state

    if getattr(state, REGISTRY_FLAG, False):
        raise ServiceAlreadyRegistered()

    assignments = (
        (AUTH_STATE, services.authentication),
        (DATASET_STATE, services.datasets),
        (CACHE_STATE, services.cache),
        (VOLUME_STATE, services.volumes),
        (PREVIEW_STATE, services.previews),
        (STREAMING_STATE, services.streaming),
        (SETTINGS_STATE, services.settings),
    )

    # Reject partial or conflicting registration.
    # This intentionally detects services previously
    # registered by other startup helpers.
    for name, _ in assignments:
        if getattr(state, name, None) is not None:
            raise ServiceAlreadyRegistered()

    for name, instance in assignments:
        setattr(state, name, instance)

    setattr(state, REGISTRY_FLAG, True)


# ============================================================
# 05 — REGISTRY INSPECTION
# ============================================================

def validate_service_registry(
    app: FastAPI,
) -> ApplicationServices:
    """
    Verify that every required service exists and has
    the expected type.

    Does not read source files or disclose service secrets.
    """

    state = app.state

    if not getattr(state, REGISTRY_FLAG, False):
        raise ServiceNotAvailable()

    for name, expected_type in SERVICE_TYPES:
        instance = getattr(state, name, None)

        if not isinstance(instance, expected_type):
            raise ServiceNotAvailable()

    settings = getattr(
        state,
        SETTINGS_STATE,
        None,
    )

    if not isinstance(settings, AppSettings):
        raise ServiceNotAvailable()

    return ApplicationServices(
        authentication=getattr(state, AUTH_STATE),
        datasets=getattr(state, DATASET_STATE),
        cache=getattr(state, CACHE_STATE),
        volumes=getattr(state, VOLUME_STATE),
        previews=getattr(state, PREVIEW_STATE),
        streaming=getattr(state, STREAMING_STATE),
        settings=settings,
    )


# ============================================================
# 06 — INTERNAL SERVICE LOOKUP
# ============================================================

def _get_registered_service(
    request: Request,
    state_name: str,
    expected_type: type[T],
) -> T:
    """
    Resolve one service with fail-closed checks.

    No new service is constructed for a request.
    """

    if not getattr(
        request.app.state,
        REGISTRY_FLAG,
        False,
    ):
        raise ConfigurationFailure()

    result = getattr(
        request.app.state,
        state_name,
        None,
    )

    if not isinstance(result, expected_type):
        raise ConfigurationFailure()

    return result


# ============================================================
# 07 — INTERNAL / PUBLIC SERVICE ACCESS
# ============================================================

def get_app_settings(
    request: Request,
) -> AppSettings:
    """
    Resolve application settings from trusted startup.

    Never return this object directly in an HTTP response.
    It may contain private configuration values.
    """

    return _get_registered_service(
        request,
        SETTINGS_STATE,
        AppSettings,
    )


def get_public_health_status(
    request: Request,
) -> dict[str, str]:
    """
    Minimal unauthenticated readiness status.

    Does not expose hardware, dataset selection, settings
    or internal service implementation details.
    """

    try:
        validate_service_registry(request.app)
        return {
            "status": "ok",
            "service": "sinus-viewer",
        }
    except ServiceRegistryError:
        return {
            "status": "degraded",
            "service": "sinus-viewer",
        }


# ============================================================
# 08 — PROTECTED DATASET DEPENDENCY
# ============================================================

def require_dataset_service(
    request: Request,
    auth: Annotated[
        AuthenticatedContext,
        Depends(require_authenticated_context),
    ],
) -> DatasetService:
    """
    DatasetService is accessible only after authentication.

    Ownership still must be passed to each dataset method:
        owner_id=auth.owner_id
    """

    return _get_registered_service(
        request,
        DATASET_STATE,
        DatasetService,
    )


# ============================================================
# 09 — PROTECTED CACHE DEPENDENCY
# ============================================================

def require_cache_service(
    request: Request,
    auth: Annotated[
        AuthenticatedContext,
        Depends(require_authenticated_context),
    ],
) -> VolumeCacheService:
    """
    Internal authenticated cache access.

    Never expose administrative clear/invalidate
    functions as unrestricted browser endpoints.
    """

    return _get_registered_service(
        request,
        CACHE_STATE,
        VolumeCacheService,
    )


# ============================================================
# 10 — PROTECTED VOLUME DEPENDENCY
# ============================================================

def require_volume_service(
    request: Request,
    auth: Annotated[
        AuthenticatedContext,
        Depends(require_authenticated_context),
    ],
) -> VolumeService:
    """
    Authenticated access to volume management.

    The route must use auth.owner_id when requesting
    any patient-related imaging content.
    """

    return _get_registered_service(
        request,
        VOLUME_STATE,
        VolumeService,
    )


# ============================================================
# 11 — PROTECTED PREVIEW DEPENDENCY
# ============================================================

def require_preview_service(
    request: Request,
    auth: Annotated[
        AuthenticatedContext,
        Depends(require_authenticated_context),
    ],
) -> PreviewService:
    """
    Authenticated access to low-memory preview generation.
    """

    return _get_registered_service(
        request,
        PREVIEW_STATE,
        PreviewService,
    )


# ============================================================
# 12 — PROTECTED STREAMING DEPENDENCY
# ============================================================

def require_streaming_service(
    request: Request,
    auth: Annotated[
        AuthenticatedContext,
        Depends(require_authenticated_context),
    ],
) -> VolumeStreamingService:
    """
    Authenticated access to bounded volume streaming.

    Pixel data must be requested with auth.owner_id.
    """

    return _get_registered_service(
        request,
        STREAMING_STATE,
        VolumeStreamingService,
    )


# ============================================================
# 13 — AUTHENTICATED API CONTEXT
# ============================================================

@dataclass(frozen=True)
class AuthorizedDatasetContext:
    """
    Bound owner identity plus authorized dataset service.

    This object is for internal route handlers only,
    not JSON serialization.
    """

    owner_id: str
    datasets: DatasetService

    def list_datasets(self) -> list[dict[str, Any]]:
        return self.datasets.list_datasets(
            owner_id=self.owner_id,
        )


def require_authorized_dataset_context(
    auth: Annotated[
        AuthenticatedContext,
        Depends(require_authenticated_context),
    ],
    datasets: Annotated[
        DatasetService,
        Depends(require_dataset_service),
    ],
) -> AuthorizedDatasetContext:
    """
    Bind a verified owner to DatasetService.

    Reduces the chance of routes accidentally accepting
    owner IDs supplied by the browser.
    """

    return AuthorizedDatasetContext(
        owner_id=auth.owner_id,
        datasets=datasets,
    )


# ============================================================
# 14 — SERVICE BUNDLE FOR TRUSTED INTERNAL OPERATIONS
# ============================================================

def get_internal_service_bundle(
    app: FastAPI,
) -> ApplicationServices:
    """
    For application lifespan and trusted internal code only.

    Do not expose this function as a public API dependency.
    It includes administrative-capable service references.
    """

    return validate_service_registry(app)


# ============================================================
# 15 — REGISTRY CLEANUP
# ============================================================

def unregister_application_services(
    app: FastAPI,
) -> None:
    """
    Detach service references after controlled shutdown.

    This function does NOT close services itself.

    Shutdown order should be:
        1. Stop accepting new HTTP requests.
        2. Drain active request/worker tasks.
        3. Close streaming and preview services.
        4. Close volume, cache and dataset services.
        5. Close authentication service.
        6. Unregister the service bundle.

    Only trusted application lifespan code may call this.
    """

    state = app.state

    if not getattr(state, REGISTRY_FLAG, False):
        return

    for name in (
        *REQUIRED_SERVICE_NAMES,
        SETTINGS_STATE,
    ):
        if hasattr(state, name):
            delattr(state, name)

    setattr(state, REGISTRY_FLAG, False)


# ============================================================
# 16 — CAPABILITIES
# ============================================================

def get_dependency_capabilities() -> dict[str, Any]:
    """
    Static, non-sensitive integration feature declaration.
    """

    return {
        "service_registry": True,
        "process_local_services": True,
        "authentication_required": True,
        "trusted_owner_context": True,
        "default_anonymous_service_access": False,
        "request_service_creation": False,
        "patient_data_serialization": False,
        "read_only_dataset": True,
    }


# ============================================================
# END OF FASTAPI DEPENDENCY INJECTION
# ============================================================
