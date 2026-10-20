
"""
SINUS VIEWER — AUTHENTICATION API ROUTES
========================================

Endpoints:
    POST /api/auth/login
    POST /api/auth/logout
    GET  /api/auth/session

Integrates:
- AuthenticationService (security/auth.py)
- Origin and session dependencies (security/session.py)
- Strict API schemas (api/schemas.py)
- Dataset session ownership (services/dataset_service.py)

Security:
- No bearer tokens returned in JSON.
- Session token is placed in an HttpOnly cookie.
- Login route requires valid same-origin request.
- Invalid credentials receive generic responses.
- Logout revokes the server-side session.
- Logout closes datasets owned by that session.
- No patient identifiers or paths in responses or logs.
- No original DICOM files are modified.

Runtime:
    Routes are synchronous so FastAPI may execute them
    through its thread pool. The frontend must include
    credentials with browser API requests.

IMPORTANT:
    Login throttling and HTTPS checks are supplied by
    the central middleware. Register the middleware
    before serving requests.

Python 3.10+
"""

from __future__ import annotations

from typing import Annotated

from fastapi import (
    APIRouter,
    Depends,
    HTTPException,
    Request,
    Response,
    status,
)

from ..dependencies import (
    require_dataset_service,
)
from ..schemas import (
    LoginRequest,
    LoginResponse,
    LogoutResponse,
    SessionStatus,
)
from ...security.auth import (
    AuthConfigurationError,
    AuthError,
    AuthenticationService,
    InvalidCredentials,
    SessionCapacityExceeded,
    clear_session_cookie,
    set_session_cookie,
)
from ...security.session import (
    AuthenticatedContext,
    extract_session_token,
    get_authentication_service,
    require_authenticated_context,
    require_safe_login_request,
    require_safe_logout_request,
)
from ...services.dataset_service import (
    DatasetService,
    DatasetServiceError,
)


# ============================================================
# 01 — ROUTER
# ============================================================

router = APIRouter(
    prefix="/api/auth",
    tags=["Authentication"],
)


# ============================================================
# 02 — SAFE ERROR HELPER
# ============================================================

def _auth_http_error(
    status_code: int,
    code: str,
) -> HTTPException:
    """
    Return only a generic error code.

    No username, token, password hash, source filename
    or low-level authentication exception is disclosed.
    """

    return HTTPException(
        status_code=status_code,
        detail={
            "code": code,
        },
        headers={
            "Cache-Control": "no-store",
            "Pragma": "no-cache",
        },
    )


# ============================================================
# 03 — LOGIN
# ============================================================

@router.post(
    "/login",
    response_model=LoginResponse,
    status_code=status.HTTP_200_OK,
)
def login(
    credentials: LoginRequest,
    response: Response,
    request: Request,
    _: Annotated[
        None,
        Depends(require_safe_login_request),
    ],
) -> LoginResponse:
    """
    Authenticate configured operator credentials.

    On success:
    - Create a server-side session.
    - Set a secure HttpOnly cookie.
    - Return non-sensitive session metadata.

    Token is never included in the JSON response.
    """

    service: AuthenticationService = (
        get_authentication_service(request)
    )

    try:
        token = service.login(
            credentials.username,
            credentials.password,
        )

    except InvalidCredentials:
        raise _auth_http_error(
            status.HTTP_401_UNAUTHORIZED,
            "AUTH_FAILED",
        ) from None

    except SessionCapacityExceeded:
        raise _auth_http_error(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "SERVICE_UNAVAILABLE",
        ) from None

    except AuthConfigurationError:
        raise _auth_http_error(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "CONFIG_ERROR",
        ) from None

    except AuthError:
        raise _auth_http_error(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "SERVICE_UNAVAILABLE",
        ) from None

    try:
        # Confirm that session registration succeeded
        # before attaching the cookie to the response.
        identity = service.authenticate(
            token,
            update_activity=False,
        )

        set_session_cookie(
            response,
            token,
        )

        response.headers["Cache-Control"] = "no-store"
        response.headers["Pragma"] = "no-cache"

        return LoginResponse(
            session=SessionStatus(
                authenticated=True,
                expires_at=identity.expires_at,
            )
        )

    except Exception:
        # If cookie creation or response validation fails,
        # revoke the newly issued server-side token.
        try:
            service.logout(token)
        except AuthError:
            pass
        raise


# ============================================================
# 04 — CURRENT SESSION STATUS
# ============================================================

@router.get(
    "/session",
    response_model=SessionStatus,
    status_code=status.HTTP_200_OK,
)
def current_session(
    context: Annotated[
        AuthenticatedContext,
        Depends(require_authenticated_context),
    ],
) -> SessionStatus:
    """
    Return current authenticated session information.

    Invalid or expired sessions are rejected by the
    dependency; no anonymous success response is returned.
    """

    return SessionStatus(
        authenticated=True,
        expires_at=context.expires_at,
    )


# ============================================================
# 05 — LOGOUT CLEANUP
# ============================================================

def close_owned_dataset_sessions(
    datasets: DatasetService,
    *,
    owner_id: str,
) -> int:
    """
    Close every dataset session belonging to this login.

    This does not modify DICOM files.

    An earlier in-flight image operation may still hold
    in-memory references; HTTP authorization must also
    be enforced for all later requests.
    """

    closed = 0

    sessions = datasets.list_datasets(
        owner_id=owner_id,
    )

    for session in sessions:
        session_id = session.get(
            "dataset_session_id"
        )

        if not isinstance(session_id, str):
            continue

        try:
            datasets.close_dataset(
                session_id,
                owner_id=owner_id,
            )
            closed += 1

        except DatasetServiceError:
            # A scan may be cancelled or a session may
            # already have closed concurrently.
            continue

    return closed


# ============================================================
# 06 — LOGOUT
# ============================================================

@router.post(
    "/logout",
    response_model=LogoutResponse,
    status_code=status.HTTP_200_OK,
)
def logout(
    request: Request,
    response: Response,
    context: Annotated[
        AuthenticatedContext,
        Depends(require_safe_logout_request),
    ],
    datasets: Annotated[
        DatasetService,
        Depends(require_dataset_service),
    ],
) -> LogoutResponse:
    """
    Revoke session and release owned dataset indexes.

    Session revocation takes priority. Dataset cleanup
    failures do not restore an authenticated session.

    Note:
        Cached volumes are managed by a separate cache
        service and are not globally cleared here because
        global eviction could interfere with other users.
    """

    service = get_authentication_service(request)

    token = extract_session_token(request)

    if token is None:
        raise _auth_http_error(
            status.HTTP_401_UNAUTHORIZED,
            "AUTH_REQUIRED",
        )

    try:
        revoked = service.logout(token)

        if not revoked:
            raise _auth_http_error(
                status.HTTP_401_UNAUTHORIZED,
                "AUTH_REQUIRED",
            )

        # Dataset ownership is tied to the authenticated
        # session's randomly generated owner ID.
        try:
            close_owned_dataset_sessions(
                datasets,
                owner_id=context.owner_id,
            )
        except DatasetServiceError:
            # Session is already revoked. The dataset
            # registry will need lifecycle cleanup.
            pass

    finally:
        clear_session_cookie(response)

    response.headers["Cache-Control"] = "no-store"
    response.headers["Pragma"] = "no-cache"

    return LogoutResponse(
        success=True,
        authenticated=False,
    )


# ============================================================
# 07 — ROUTE CAPABILITIES
# ============================================================

def get_auth_route_capabilities() -> dict:
    """
    Static, non-sensitive route contract declaration.
    """

    return {
        "login": "/api/auth/login",
        "logout": "/api/auth/logout",
        "session": "/api/auth/session",
        "cookie_authentication": True,
        "token_in_json": False,
        "login_origin_check": True,
        "logout_origin_check": True,
        "server_side_session_revocation": True,
        "logout_dataset_cleanup": True,
        "read_only_dataset": True,
    }


# ============================================================
# END OF AUTHENTICATION API ROUTES
# ============================================================
