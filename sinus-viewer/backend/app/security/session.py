
"""
SINUS VIEWER — FASTAPI SESSION SECURITY
=======================================

Provides:
- AuthenticationService retrieval from FastAPI app state.
- HttpOnly cookie-based session authentication.
- Trusted AuthIdentity injection through FastAPI Depends.
- Server-side owner identity for dataset/volume services.
- Cross-origin protection for unsafe HTTP methods.
- Fetch Metadata protection for cross-site requests.
- Explicit configured public origin for origin checks.
- Safe request-state identity access.
- Separate dependency for unauthenticated login routes.

Security boundaries:
- No client-supplied owner ID is accepted as identity.
- Raw tokens, cookies, URLs and request bodies are not logged.
- CSRF protection must be applied to login/logout and all
  cookie-authenticated state-changing API routes.
- Authenticated read endpoints must still validate ownership.
- Reverse-proxy and HTTPS controls are configured elsewhere.
- This module does not grant access merely because a cookie
  is present; the server-side session must be valid.
- Real patient data must not be exposed through an
  unapproved public Colab tunnel.

No dataset access or filesystem writing occurs here.

Python 3.10+
FastAPI / Starlette
"""

from __future__ import annotations

import hmac
import os
import re
from dataclasses import dataclass
from typing import Annotated
from urllib.parse import urlsplit

from fastapi import Depends, Request

from ..core.exceptions import (
    AccessDenied,
    AuthenticationRequired,
    ConfigurationFailure,
    SessionExpired,
)
from .auth import (
    AuthIdentity,
    AuthenticationService,
    AuthenticationRequired as AuthSessionRequired,
    AuthenticationServiceClosed,
    SessionExpired as AuthSessionExpired,
    get_session_cookie_name,
)


# ============================================================
# 01 — CONSTANTS
# ============================================================

AUTH_SERVICE_STATE_NAME = "auth_service"

PUBLIC_ORIGIN_ENV = "SINUS_VIEWER_PUBLIC_ORIGIN"

SAFE_HTTP_METHODS = frozenset({
    "GET",
    "HEAD",
    "OPTIONS",
})

UNSAFE_HTTP_METHODS = frozenset({
    "POST",
    "PUT",
    "PATCH",
    "DELETE",
})

ALLOWED_FETCH_SITE = frozenset({
    "same-origin",
    "none",
})

MAX_ORIGIN_LENGTH = 512
MAX_COOKIE_LENGTH = 256

ORIGIN_PATTERN = re.compile(
    r"^https?://[^/?#]+$",
    re.IGNORECASE,
)


# ============================================================
# 02 — TRUSTED CONTEXT
# ============================================================

@dataclass(frozen=True)
class AuthenticatedContext:
    """
    Trusted identity available to protected API routes.

    owner_id is produced by AuthenticationService after
    validating the server-side session.
    """

    owner_id: str
    issued_at: float
    expires_at: float

    @classmethod
    def from_identity(
        cls,
        identity: AuthIdentity,
    ) -> "AuthenticatedContext":
        return cls(
            owner_id=identity.owner_id,
            issued_at=identity.issued_at,
            expires_at=identity.expires_at,
        )


# ============================================================
# 03 — AUTHENTICATION SERVICE LOOKUP
# ============================================================

def get_authentication_service(
    request: Request,
) -> AuthenticationService:
    """
    Retrieve service initialized by the FastAPI lifespan.

    Expected startup setup:
        app.state.auth_service = create_authentication_service()

    Never instantiate AuthenticationService per request.
    """

    service = getattr(
        request.app.state,
        AUTH_SERVICE_STATE_NAME,
        None,
    )

    if not isinstance(service, AuthenticationService):
        raise ConfigurationFailure()

    return service


# ============================================================
# 04 — COOKIE EXTRACTION
# ============================================================

def extract_session_token(
    request: Request,
) -> str | None:
    """
    Read bearer token only from the configured cookie.

    Authorization headers, query strings and request bodies
    are deliberately not accepted as alternative sources.
    """

    cookie_name = get_session_cookie_name()

    # Reject duplicate cookie names, which might otherwise
    # be interpreted inconsistently by different components.
    raw_headers = request.headers.getlist("cookie")

    matches: list[str] = []

    for raw_header in raw_headers:
        if len(raw_header) > 8192:
            raise AuthenticationRequired()

        for fragment in raw_header.split(";"):
            name, separator, value = fragment.strip().partition("=")

            if separator and name == cookie_name:
                matches.append(value.strip())

    if not matches:
        return None

    if len(matches) != 1:
        raise AuthenticationRequired()

    token = matches[0]

    if not token or len(token) > MAX_COOKIE_LENGTH:
        raise AuthenticationRequired()

    return token


# ============================================================
# 05 — PUBLIC ORIGIN VALIDATION
# ============================================================

def _normalize_origin(
    origin: str,
) -> str:
    """
    Validate the syntax of one HTTP origin.

    No paths, credentials, fragments or query parameters.
    Public deployment requires HTTPS.
    """

    if (
        not isinstance(origin, str)
        or len(origin) > MAX_ORIGIN_LENGTH
        or not ORIGIN_PATTERN.fullmatch(origin)
    ):
        raise ConfigurationFailure()

    parsed = urlsplit(origin)

    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path
        or parsed.query
        or parsed.fragment
    ):
        raise ConfigurationFailure()

    try:
        port = parsed.port
    except ValueError:
        raise ConfigurationFailure() from None

    if (
        parsed.scheme != "https"
        and parsed.hostname not in {
            "localhost",
            "127.0.0.1",
            "::1",
        }
    ):
        raise ConfigurationFailure()

    host = parsed.hostname.lower()

    if ":" in host:
        host = f"[{host}]"

    default_port = (
        443 if parsed.scheme == "https" else 80
    )

    suffix = (
        f":{port}"
        if port is not None and port != default_port
        else ""
    )

    return f"{parsed.scheme}://{host}{suffix}"


def get_trusted_public_origin() -> str:
    """
    Read explicitly configured browser origin.

    This must be the trusted HTTPS tunnel URL in Colab.
    Never derive it from untrusted Host/X-Forwarded headers.

    Missing configuration fails closed.
    """

    value = os.environ.get(PUBLIC_ORIGIN_ENV)

    if not value:
        raise ConfigurationFailure()

    return _normalize_origin(value)


# ============================================================
# 06 — CROSS-ORIGIN REQUEST PROTECTION
# ============================================================

def validate_request_origin(
    request: Request,
) -> None:
    """
    Enforce Origin and Fetch Metadata checks.

    This is intended for browser cookie-authenticated APIs,
    including login/logout and all unsafe methods.

    For unsafe methods, a valid Origin header is mandatory.
    Cross-site fetches are rejected even for safe methods.

    This does not replace HTTPS, auth or proxy protections.
    """

    method = request.method.upper()

    fetch_sites = request.headers.getlist(
        "sec-fetch-site"
    )

    if len(fetch_sites) > 1:
        raise AccessDenied()

    if fetch_sites:
        fetch_site = fetch_sites[0].strip().lower()

        if fetch_site not in ALLOWED_FETCH_SITE:
            raise AccessDenied()

    if method in SAFE_HTTP_METHODS:
        return

    if method not in UNSAFE_HTTP_METHODS:
        raise AccessDenied()

    origin_headers = request.headers.getlist("origin")

    if len(origin_headers) != 1:
        raise AccessDenied()

    received = origin_headers[0]

    # Validation of malformed request origin must return a
    # client access error, not disclose server configuration.
    try:
        normalized_received = _normalize_origin(received)
    except ConfigurationFailure:
        raise AccessDenied() from None

    trusted = get_trusted_public_origin()

    if not hmac.compare_digest(
        normalized_received,
        trusted,
    ):
        raise AccessDenied()


# ============================================================
# 07 — AUTHENTICATE CURRENT REQUEST
# ============================================================

def authenticate_request(
    request: Request,
    service: AuthenticationService | None = None,
) -> AuthenticatedContext:
    """
    Verify cookie against the server-side session registry.

    Successful validation stores trusted identity on
    request.state for use within this request only.
    """

    auth_service = (
        service
        if service is not None
        else get_authentication_service(request)
    )

    token = extract_session_token(request)

    if token is None:
        raise AuthenticationRequired()

    try:
        identity = auth_service.authenticate(token)

    except AuthSessionExpired:
        raise SessionExpired() from None

    except AuthSessionRequired:
        raise AuthenticationRequired() from None

    except AuthenticationServiceClosed:
        raise ConfigurationFailure() from None

    context = AuthenticatedContext.from_identity(
        identity
    )

    request.state.authenticated_context = context

    return context


# ============================================================
# 08 — FASTAPI AUTHENTICATION DEPENDENCIES
# ============================================================

def require_authenticated_context(
    request: Request,
) -> AuthenticatedContext:
    """
    Apply Origin/Fetch Metadata checks, then authenticate.

    Typical protected route:
        @router.get("/patients")
        def patients(
            auth: Annotated[
                AuthenticatedContext,
                Depends(require_authenticated_context),
            ],
        ):
            return dataset_service.list_patients(
                session_id,
                owner_id=auth.owner_id,
            )
    """

    validate_request_origin(request)

    return authenticate_request(request)


def require_authenticated_owner(
    context: Annotated[
        AuthenticatedContext,
        Depends(require_authenticated_context),
    ],
) -> str:
    """
    Inject only trusted server-side owner identity.

    Never obtain owner_id from request body, query string
    or browser local storage.
    """

    return context.owner_id


def require_safe_login_request(
    request: Request,
) -> None:
    """
    Apply origin protection to unauthenticated login routes.

    Login endpoints must additionally enforce:
    - POST only
    - Request size limits
    - Brute-force throttling
    - HTTPS
    - Safe responses with no user enumeration
    """

    if request.method.upper() != "POST":
        raise AccessDenied()

    validate_request_origin(request)


def require_safe_logout_request(
    request: Request,
) -> AuthenticatedContext:
    """
    Protect logout with authentication and Origin checks.
    """

    if request.method.upper() != "POST":
        raise AccessDenied()

    return require_authenticated_context(request)


# ============================================================
# 09 — READ TRUSTED REQUEST STATE
# ============================================================

def get_authenticated_request_context(
    request: Request,
) -> AuthenticatedContext:
    """
    Retrieve identity already validated in this request.

    This is for use only after an authentication dependency.
    Never populate this state from untrusted request input.
    """

    context = getattr(
        request.state,
        "authenticated_context",
        None,
    )

    if not isinstance(context, AuthenticatedContext):
        raise AuthenticationRequired()

    return context


# ============================================================
# 10 — OPTIONAL SESSION INFORMATION
# ============================================================

def get_authenticated_session_summary(
    context: AuthenticatedContext,
) -> dict:
    """
    Limited frontend session state.

    No bearer token, source path or patient identifiers.
    """

    return {
        "authenticated": True,
        "expires_at": context.expires_at,
    }


# ============================================================
# 11 — SERVICE REGISTRATION
# ============================================================

def register_authentication_service(
    app: object,
    service: AuthenticationService,
) -> None:
    """
    Register the initialized authentication service.

    Intended for FastAPI application lifespan startup.
    """

    if not isinstance(service, AuthenticationService):
        raise TypeError(
            "AuthenticationService required."
        )

    state = getattr(app, "state", None)

    if state is None:
        raise TypeError(
            "FastAPI application state required."
        )

    existing = getattr(
        state,
        AUTH_SERVICE_STATE_NAME,
        None,
    )

    if existing is not None:
        raise RuntimeError(
            "Authentication service already registered."
        )

    setattr(
        state,
        AUTH_SERVICE_STATE_NAME,
        service,
    )


# ============================================================
# END OF FASTAPI SESSION SECURITY
# ============================================================
