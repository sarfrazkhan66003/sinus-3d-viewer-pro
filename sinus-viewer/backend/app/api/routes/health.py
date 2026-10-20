
"""
SINUS VIEWER — HEALTH AND MONITORING API
=======================================

Endpoints:
    GET /api/health
    GET /api/health/details
    GET /api/health/capabilities

Purpose:
- Minimal public backend readiness check.
- Authenticated operational service status.
- Safe, aggregated runtime counters.
- Explicit, privacy-safe response schemas.
- No source file or DICOM dataset operations.

Security:
- Public health exposes only "ok" or "degraded".
- Detailed monitoring requires authentication.
- No usernames, passwords or bearer tokens.
- No patient names, IDs, handles or DICOM UIDs.
- No source file paths, dataset roots or environment values.
- No raw exception messages returned to clients.
- No source files or runtime files created or modified.

Limitations:
- Process-local monitoring only.
- "ok" means the core service registry is available;
  it does NOT guarantee successful DICOM decoding.
- This is not an external monitoring or alerting system.
- Detailed metrics should not be exposed publicly.

Python 3.10+
FastAPI / Pydantic v2
"""

from __future__ import annotations

from typing import Annotated, Literal

from fastapi import (
    APIRouter,
    Depends,
    Request,
    Response,
    status,
)
from pydantic import Field

from ..dependencies import (
    ApplicationServices,
    ServiceRegistryError,
    validate_service_registry,
)
from ..schemas import (
    HealthResponse,
    HealthStatus,
    StrictAPIModel,
)
from ...security.session import (
    AuthenticatedContext,
    require_authenticated_context,
)


# ============================================================
# 01 — ROUTER
# ============================================================

router = APIRouter(
    prefix="/api/health",
    tags=["Health"],
)

TrustedUser = Annotated[
    AuthenticatedContext,
    Depends(require_authenticated_context),
]

NO_STORE_HEADERS = {
    "Cache-Control": "no-store, private",
    "Pragma": "no-cache",
    "X-Content-Type-Options": "nosniff",
}


# ============================================================
# 02 — STRICT MONITORING SCHEMAS
# ============================================================

class ComponentStatus(StrictAPIModel):
    """
    Generic state only, without sensitive service details.
    """

    available: bool
    closed: bool


class OperationalCounters(StrictAPIModel):
    """
    Safe aggregate counters.

    These numbers are returned only to authenticated users.
    """

    active_dataset_sessions: int = Field(ge=0)
    active_volume_loads: int = Field(ge=0)
    active_preview_builds: int = Field(ge=0)
    active_binary_streams: int = Field(ge=0)

    cached_volumes: int = Field(ge=0)
    cached_memory_mib: float = Field(
        ge=0,
        allow_inf_nan=False,
    )

    active_login_sessions: int = Field(ge=0)

    volume_load_requests: int = Field(ge=0)
    completed_volume_loads: int = Field(ge=0)
    failed_volume_loads: int = Field(ge=0)

    completed_previews: int = Field(ge=0)
    failed_previews: int = Field(ge=0)

    completed_streams: int = Field(ge=0)
    failed_streams: int = Field(ge=0)


class OperationalHealthResponse(StrictAPIModel):
    """
    Authenticated operational summary.

    Component names are static, not derived from user data.
    """

    status: HealthStatus
    service: Literal["sinus-viewer"] = "sinus-viewer"

    components: dict[
        Literal[
            "authentication",
            "datasets",
            "cache",
            "volumes",
            "previews",
            "streaming",
        ],
        ComponentStatus,
    ]

    counters: OperationalCounters


class HealthCapabilitiesResponse(StrictAPIModel):
    """
    Static capabilities with no environment inventory.
    """

    service: Literal["sinus-viewer"] = "sinus-viewer"
    schema_version: Literal["1"] = "1"
    public_health: Literal[True] = True
    authenticated_details: Literal[True] = True

    volume_cache: Literal[True] = True
    volume_streaming: Literal[True] = True
    preview_service: Literal[True] = True
    read_only_dataset: Literal[True] = True

    runtime_integration_verified: Literal[False] = False


# ============================================================
# 03 — REGISTRY READINESS
# ============================================================

def _get_services_or_none(
    request: Request,
) -> ApplicationServices | None:
    """
    Retrieve service bundle without exposing exceptions.

    Registry existence is necessary but not sufficient for
    readiness; closed services are also checked.
    """

    try:
        return validate_service_registry(request.app)

    except (ServiceRegistryError, AttributeError, TypeError):
        return None


def _component_states(
    services: ApplicationServices,
) -> dict[str, ComponentStatus]:
    """
    Inspect service lifecycle flags through safe statistics.

    No original dataset scanning or volume loading.
    """

    states = {
        "authentication": services.authentication.statistics(),
        "datasets": services.datasets.statistics(),
        "cache": services.cache.statistics(),
        "volumes": services.volumes.statistics(),
        "previews": services.previews.statistics(),
        "streaming": services.streaming.statistics(),
    }

    return {
        name: ComponentStatus(
            available=True,
            closed=bool(statistics.closed),
        )
        for name, statistics in states.items()
    }


def _is_ready(
    services: ApplicationServices | None,
) -> bool:
    """
    Check service registry and process-local lifecycle state.

    Does not contact the filesystem or external tunnel.
    """

    if services is None:
        return False

    try:
        components = _component_states(services)

        return (
            len(components) == 6
            and all(
                component.available and not component.closed
                for component in components.values()
            )
        )

    except (AttributeError, RuntimeError, TypeError, ValueError):
        return False


# ============================================================
# 04 — PUBLIC HEALTH ENDPOINT
# ============================================================

@router.get(
    "",
    response_model=HealthResponse,
    responses={
        200: {
            "description": "Backend core services available",
        },
        503: {
            "description": "Backend not ready",
        },
    },
)
def public_health(
    request: Request,
    response: Response,
) -> HealthResponse:
    """
    Public endpoint.

    Only two values are exposed:
        service = sinus-viewer
        status  = ok | degraded

    No dataset counts, file paths, user sessions, GPU
    inventory or service statistics.
    """

    services = _get_services_or_none(request)

    ready = _is_ready(services)

    response.status_code = (
        status.HTTP_200_OK
        if ready
        else status.HTTP_503_SERVICE_UNAVAILABLE
    )

    for name, value in NO_STORE_HEADERS.items():
        response.headers[name] = value

    return HealthResponse(
        status=(
            HealthStatus.OK
            if ready
            else HealthStatus.DEGRADED
        ),
        service="sinus-viewer",
    )


# ============================================================
# 05 — OPERATIONAL COUNTERS
# ============================================================

def _build_operational_counters(
    services: ApplicationServices,
) -> OperationalCounters:
    """
    Copy only approved aggregate counters.

    Internal statistics models may contain additional fields,
    but those fields will never enter this response.
    """

    authentication = services.authentication.statistics()
    datasets = services.datasets.statistics()
    cache = services.cache.statistics()
    volumes = services.volumes.statistics()
    previews = services.previews.statistics()
    streaming = services.streaming.statistics()

    return OperationalCounters(
        active_dataset_sessions=int(
            datasets.active_sessions
        ),
        active_volume_loads=int(
            volumes.active_loads
        ),
        active_preview_builds=int(
            previews.active
        ),
        active_binary_streams=int(
            streaming.active_streams
        ),
        cached_volumes=int(
            cache.entries
        ),
        cached_memory_mib=float(
            cache.total_mib
        ),
        active_login_sessions=int(
            authentication.active_sessions
        ),
        volume_load_requests=int(
            volumes.load_requests
        ),
        completed_volume_loads=int(
            volumes.completed_loads
        ),
        failed_volume_loads=int(
            volumes.failed_loads
        ),
        completed_previews=int(
            previews.completed
        ),
        failed_previews=int(
            previews.failed
        ),
        completed_streams=int(
            streaming.streams_completed
        ),
        failed_streams=int(
            streaming.streams_failed
        ),
    )


# ============================================================
# 06 — AUTHENTICATED OPERATIONAL HEALTH
# ============================================================

@router.get(
    "/details",
    response_model=OperationalHealthResponse,
    responses={
        200: {
            "description": "Authenticated operational status",
        },
        401: {
            "description": "Authentication required",
        },
        503: {
            "description": "Service not ready",
        },
    },
)
def operational_health(
    request: Request,
    response: Response,
    auth: TrustedUser,
) -> OperationalHealthResponse:
    """
    Detailed, authenticated monitoring endpoint.

    The authentication dependency verifies the cookie
    before this handler executes.

    Operational values are aggregate counters only.
    """

    services = _get_services_or_none(request)

    if services is None:
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE

        # Protected route cannot construct meaningful
        # statistics without a registered service bundle.
        # Fail with a controlled generic HTTP error.
        from fastapi import HTTPException

        raise HTTPException(
            status_code=503,
            detail={"code": "SERVICE_UNAVAILABLE"},
        )

    try:
        components = _component_states(services)
        counters = _build_operational_counters(services)

    except (AttributeError, RuntimeError, TypeError, ValueError):
        from fastapi import HTTPException

        raise HTTPException(
            status_code=503,
            detail={"code": "SERVICE_UNAVAILABLE"},
        ) from None

    ready = all(
        component.available and not component.closed
        for component in components.values()
    )

    response.status_code = (
        status.HTTP_200_OK
        if ready
        else status.HTTP_503_SERVICE_UNAVAILABLE
    )

    for name, value in NO_STORE_HEADERS.items():
        response.headers[name] = value

    return OperationalHealthResponse(
        status=(
            HealthStatus.OK
            if ready
            else HealthStatus.DEGRADED
        ),
        service="sinus-viewer",
        components=components,
        counters=counters,
    )


# ============================================================
# 07 — AUTHENTICATED CAPABILITIES
# ============================================================

@router.get(
    "/capabilities",
    response_model=HealthCapabilitiesResponse,
)
def health_capabilities(
    response: Response,
    auth: TrustedUser,
) -> HealthCapabilitiesResponse:
    """
    Static capability declarations.

    These describe planned service contracts, not proven
    clinical correctness or successful integration tests.
    """

    for name, value in NO_STORE_HEADERS.items():
        response.headers[name] = value

    return HealthCapabilitiesResponse()


# ============================================================
# 08 — ROUTE CAPABILITY REPORT
# ============================================================

def get_health_route_capabilities() -> dict:
    """
    Safe static route summary.

    Do not expose internal application state.
    """

    return {
        "public_endpoint": "/api/health",
        "authenticated_details": "/api/health/details",
        "authenticated_capabilities": "/api/health/capabilities",
        "public_detail_level": "minimal",
        "private_counters": True,
        "patient_data_in_responses": False,
        "file_paths_in_responses": False,
        "credentials_in_responses": False,
        "read_only_original_dataset": True,
    }


# ============================================================
# END OF HEALTH AND MONITORING API
# ============================================================
