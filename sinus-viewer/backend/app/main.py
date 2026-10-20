
"""
SINUS VIEWER — FASTAPI MAIN APPLICATION
=======================================

Central backend application entry point.

Responsibilities:
- Load and validate application configuration.
- Construct FastAPI with a controlled lifespan.
- Initialize authentication and imaging services.
- Register the complete application service bundle.
- Register all previously implemented API routers.
- Activate the central security middleware.
- Normalize API errors without leaking patient data.
- Release service references at shutdown.
- Preserve original DICOM dataset read-only.

Deployment assumptions:
- One Uvicorn worker for process-local sessions and cache.
- Google Colab/Linux installs backend dependencies.
- Public browser access only through an appropriately
  secured HTTPS reverse proxy / tunnel.
- No anonymous access to medical image endpoints.
- No automatic dataset scan at startup.
- No writes to original Google Drive DICOM directories.

This file does NOT:
- Mount Google Drive.
- Install Python dependencies.
- Start a public tunnel.
- Build the React frontend.
- Create or modify original dataset files.

Python 3.10+
FastAPI / Pydantic v2
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.responses import Response

from .api.dependencies import (
    ApplicationServices,
    register_application_services,
    unregister_application_services,
)
from .api.routes import (
    auth,
    datasets,
    health,
    previews,
    streaming,
    volumes,
)
from .api.schemas import ERROR_MESSAGES, PublicErrorCode
from .core.config import AppSettings, get_settings
from .security.auth import (
    AuthenticationService,
    create_authentication_service,
)
from .security.middleware import register_security_middleware
from .services.cache_service import (
    VolumeCacheService,
    create_volume_cache,
)
from .services.dataset_service import (
    DatasetService,
    create_dataset_service,
)
from .services.preview_service import (
    PreviewService,
    create_preview_service,
)
from .services.streaming_service import (
    VolumeStreamingService,
    create_streaming_service,
)
from .services.volume_service import (
    VolumeService,
    create_volume_service,
)


# ============================================================
# 01 — APPLICATION CONSTANTS
# ============================================================

APP_TITLE = "Sinus Viewer"
APP_VERSION = "0.1.0"

API_PREFIX = "/api"

# Source code contains no dataset-specific patient details.
# Avoid exposing Swagger/OpenAPI schemas anonymously.
ENABLE_PUBLIC_API_DOCS = False

SAFE_RESPONSE_HEADERS = {
    "Cache-Control": "no-store, private",
    "Pragma": "no-cache",
    "X-Content-Type-Options": "nosniff",
}


# ============================================================
# 02 — SAFE ERROR CODES
# ============================================================

HTTP_ERROR_CODES: dict[int, PublicErrorCode] = {
    400: PublicErrorCode.INVALID_REQUEST,
    401: PublicErrorCode.AUTH_REQUIRED,
    403: PublicErrorCode.ACCESS_DENIED,
    404: PublicErrorCode.INVALID_REQUEST,
    405: PublicErrorCode.INVALID_REQUEST,
    409: PublicErrorCode.PROCESSING_FAILED,
    413: PublicErrorCode.REQUEST_TOO_LARGE,
    416: PublicErrorCode.RANGE_NOT_SATISFIABLE,
    422: PublicErrorCode.INVALID_REQUEST,
    429: PublicErrorCode.RATE_LIMITED,
    500: PublicErrorCode.PROCESSING_FAILED,
    503: PublicErrorCode.SERVICE_UNAVAILABLE,
    507: PublicErrorCode.OUT_OF_MEMORY,
}


# ============================================================
# 03 — ERROR RESPONSE FACTORY
# ============================================================

def create_safe_error_response(
    *,
    status_code: int,
    code: PublicErrorCode,
    request: Request,
    additional_headers: dict[str, str] | None = None,
) -> JSONResponse:
    """
    Produce a consistent, non-disclosing API error.

    Only allowlisted error codes and messages are exposed.
    No internal exception text, DICOM paths or patient data.
    """

    request_id = getattr(
        request.state,
        "request_id",
        None,
    )

    headers = dict(SAFE_RESPONSE_HEADERS)

    if additional_headers:
        # Only known HTTP headers are forwarded from the
        # original controlled HTTPException.
        permitted = {
            "retry-after",
            "www-authenticate",
            "content-range",
        }

        for name, value in additional_headers.items():
            if (
                name.lower() in permitted
                and isinstance(value, str)
                and "\r" not in value
                and "\n" not in value
            ):
                headers[name] = value

    if (
        isinstance(request_id, str)
        and len(request_id) == 32
        and all(c in "0123456789abcdef" for c in request_id)
    ):
        headers["X-Request-ID"] = request_id
    else:
        request_id = None

    content = {
        "success": False,
        "error": {
            "code": code.value,
            "message": ERROR_MESSAGES[code],
            "retryable": status_code in (429, 503),
            "request_id": request_id,
        },
    }

    return JSONResponse(
        status_code=status_code,
        content=content,
        headers=headers,
    )


# ============================================================
# 04 — SAFE HTTP ERROR HANDLER
# ============================================================

async def http_exception_handler(
    request: Request,
    exc: HTTPException,
) -> Response:
    """
    Normalize HTTP errors into the centralized API schema.

    Route-supplied detail dictionaries are not copied
    blindly to the browser.
    """

    status_code = int(exc.status_code)

    code = HTTP_ERROR_CODES.get(
        status_code,
        PublicErrorCode.PROCESSING_FAILED,
    )

    detail = exc.detail

    if isinstance(detail, dict):
        candidate = detail.get("code")

        if isinstance(candidate, str):
            try:
                selected = PublicErrorCode(candidate)
            except ValueError:
                selected = None

            if selected is not None:
                code = selected

    return create_safe_error_response(
        status_code=status_code,
        code=code,
        request=request,
        additional_headers=exc.headers,
    )


# ============================================================
# 05 — REQUEST VALIDATION HANDLER
# ============================================================

async def request_validation_exception_handler(
    request: Request,
    exc: RequestValidationError,
) -> Response:
    """
    Return a generic 422 without echoing submitted values.

    FastAPI's default validation error may include request
    fields or rejected input. That detail is intentionally
    omitted for this medical-data API.
    """

    return create_safe_error_response(
        status_code=422,
        code=PublicErrorCode.INVALID_REQUEST,
        request=request,
    )


# ============================================================
# 06 — UNHANDLED ERROR HANDLER
# ============================================================

async def unexpected_exception_handler(
    request: Request,
    exc: Exception,
) -> Response:
    """
    Safe fallback for unexpected application exceptions.

    Do not log str(exc), traceback locals or request bodies:
    they may contain patient data or credentials.
    """

    return create_safe_error_response(
        status_code=500,
        code=PublicErrorCode.PROCESSING_FAILED,
        request=request,
    )


# ============================================================
# 07 — SERVICE INITIALIZATION
# ============================================================

def initialize_application_services(
    settings: AppSettings,
) -> ApplicationServices:
    """
    Initialize backend services in dependency order.

    Existing original DICOM files are neither opened nor
    modified during routine service construction.

    Authentication configuration fails closed when required
    environment credentials are unavailable.
    """

    authentication: AuthenticationService | None = None
    datasets: DatasetService | None = None
    cache: VolumeCacheService | None = None
    volumes: VolumeService | None = None
    previews: PreviewService | None = None
    streaming: VolumeStreamingService | None = None

    try:
        authentication = create_authentication_service(
            settings
        )

        datasets = create_dataset_service(
            settings
        )

        cache = create_volume_cache(
            settings
        )

        volumes = create_volume_service(
            dataset_service=datasets,
            cache_service=cache,
            settings=settings,
        )

        previews = create_preview_service(
            dataset_service=datasets,
            settings=settings,
        )

        streaming = create_streaming_service(
            volume_service=volumes,
            settings=settings,
        )

        bundle = ApplicationServices(
            authentication=authentication,
            datasets=datasets,
            cache=cache,
            volumes=volumes,
            previews=previews,
            streaming=streaming,
            settings=settings,
        )

        bundle.validate()

        return bundle

    except Exception:
        # Cleanup partial construction without hiding
        # the original startup failure.
        for service in (
            streaming,
            previews,
            volumes,
            cache,
            datasets,
            authentication,
        ):
            if service is not None:
                try:
                    service.close()
                except Exception:
                    pass

        raise


# ============================================================
# 08 — SERVICE SHUTDOWN
# ============================================================

def shutdown_application_services(
    services: ApplicationServices,
) -> None:
    """
    Close services in reverse dependency order.

    This detaches references held by process-local caches
    and dataset registries. Active worker requests must
    be drained by the ASGI server before shutdown.

    No original DICOM source files are deleted or modified.
    """

    for service in (
        services.streaming,
        services.previews,
        services.volumes,
        services.cache,
        services.datasets,
        services.authentication,
    ):
        try:
            service.close()
        except Exception:
            # Continue closing remaining services.
            # Do not expose internal details.
            pass


# ============================================================
# 09 — FASTAPI LIFESPAN
# ============================================================

@asynccontextmanager
async def application_lifespan(
    app: FastAPI,
) -> AsyncIterator[None]:
    """
    Create services on startup and release on shutdown.

    Only one process-local service bundle is registered
    per application instance.
    """

    settings = app.state.bootstrap_settings

    services = initialize_application_services(
        settings
    )

    try:
        register_application_services(
            app,
            services,
        )

        yield

    finally:
        shutdown_application_services(services)

        unregister_application_services(app)


# ============================================================
# 10 — REGISTER API ROUTERS
# ============================================================

def register_api_routes(
    application: FastAPI,
) -> None:
    """
    Register all implemented backend routers.

    Each router retains its existing /api prefix.
    No duplicate prefixes are applied here.
    """

    application.include_router(auth.router)
    application.include_router(datasets.router)
    application.include_router(volumes.router)
    application.include_router(streaming.router)
    application.include_router(previews.router)
    application.include_router(health.router)


# ============================================================
# 11 — REGISTER SAFE ERROR HANDLERS
# ============================================================

def register_error_handlers(
    application: FastAPI,
) -> None:
    application.add_exception_handler(
        HTTPException,
        http_exception_handler,
    )

    application.add_exception_handler(
        RequestValidationError,
        request_validation_exception_handler,
    )

    application.add_exception_handler(
        Exception,
        unexpected_exception_handler,
    )


# ============================================================
# 12 — APPLICATION FACTORY
# ============================================================

def create_app(
    settings: AppSettings | None = None,
) -> FastAPI:
    """
    Build the Sinus Viewer FastAPI application.

    The startup lifespan initializes credentials, services
    and authenticated application state.

    OpenAPI/Swagger docs are disabled on the public server.
    """

    active = (
        settings
        if settings is not None
        else get_settings()
    )

    application = FastAPI(
        title=APP_TITLE,
        version=APP_VERSION,
        docs_url=None if not ENABLE_PUBLIC_API_DOCS else "/docs",
        redoc_url=None,
        openapi_url=None if not ENABLE_PUBLIC_API_DOCS else "/openapi.json",
        lifespan=application_lifespan,
    )

    application.state.bootstrap_settings = active

    register_error_handlers(application)
    register_api_routes(application)

    # Registration occurs at application-construction time
    # before Starlette builds the ASGI middleware stack.
    register_security_middleware(
        application,
        active,
    )

    return application


# ============================================================
# 13 — ASGI APPLICATION
# ============================================================

app = create_app()


# ============================================================
# 14 — STATIC CAPABILITY REPORT
# ============================================================

def get_main_application_capabilities() -> dict:
    return {
        "application": APP_TITLE,
        "version": APP_VERSION,
        "api_prefix": API_PREFIX,
        "authentication": True,
        "security_middleware": True,
        "service_registry": True,
        "lifespan_management": True,
        "dataset_routes": True,
        "volume_routes": True,
        "streaming_routes": True,
        "preview_routes": True,
        "health_routes": True,
        "public_api_docs": ENABLE_PUBLIC_API_DOCS,
        "read_only_original_dataset": True,
        "frontend_build_included": False,
        "tunnel_launcher_included": False,
    }


# ============================================================
# END OF SINUS VIEWER MAIN APPLICATION
# ============================================================
