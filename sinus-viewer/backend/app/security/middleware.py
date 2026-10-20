
"""
SINUS VIEWER — CENTRAL HTTP SECURITY MIDDLEWARE
================================================

Provides:
- Default authentication for /api routes.
- Exact allowlist for public login and basic health checks.
- Origin / Fetch Metadata validation.
- Production HTTPS transport checks.
- Bounded request body buffering.
- Process-local login request throttling.
- Protective HTTP response headers.
- Server-generated request correlation IDs.
- Sanitized security failure responses.
- No raw request URL, cookie, token or patient-data logging.

Security boundaries:
- The authentication service is registered at app startup.
- Same-origin browser deployment is expected.
- Reverse proxies must terminate HTTPS and connect from
  an explicitly trusted loopback address.
- This is not a complete reverse-proxy trust framework.
- Rate limiting here is global and process-local.
- Do not deploy identifiable clinical patient data to a
  public Colab tunnel without an approved security design.
- No DICOM files are read, written, renamed or deleted.

Python 3.10+
FastAPI / Starlette
"""

from __future__ import annotations

import hmac
import json
import threading
import time
import uuid
from collections import deque
from dataclasses import dataclass
from typing import Any, Callable

from fastapi import FastAPI, Request
from starlette.datastructures import Headers
from starlette.responses import JSONResponse
from starlette.types import (
    ASGIApp,
    Message,
    Receive,
    Scope,
    Send,
)

from ..core.config import AppSettings, get_settings
from ..core.exceptions import (
    AccessDenied,
    AuthenticationRequired,
    ConfigurationFailure,
    SessionExpired,
)
from .session import (
    authenticate_request,
    get_trusted_public_origin,
    validate_request_origin,
)


# ============================================================
# 01 — CONSTANTS
# ============================================================

API_PREFIX = "/api"

PUBLIC_API_PATHS = frozenset({
    "/api/auth/login",
    "/api/health",
})

LOGIN_PATH = "/api/auth/login"

SAFE_METHODS = frozenset({
    "GET",
    "HEAD",
    "OPTIONS",
})

BODY_METHODS = frozenset({
    "POST",
    "PUT",
    "PATCH",
    "DELETE",
})

LOGIN_RATE_WINDOW_SECONDS = 60
LOGIN_RATE_MAX_REQUESTS = 8

MAX_REQUEST_ID_LENGTH = 64

TRUSTED_LOOPBACK_HOSTS = frozenset({
    "127.0.0.1",
    "::1",
})

CONTENT_SECURITY_POLICY = (
    "default-src 'self'; "
    "base-uri 'self'; "
    "object-src 'none'; "
    "frame-ancestors 'none'; "
    "form-action 'self'; "
    "script-src 'self'; "
    "style-src 'self' 'unsafe-inline'; "
    "img-src 'self' data: blob:; "
    "font-src 'self' data:; "
    "connect-src 'self' wss:; "
    "worker-src 'self' blob:"
)


# ============================================================
# 02 — CONTROLLED SECURITY FAILURES
# ============================================================

class SecurityMiddlewareError(RuntimeError):
    """
    Internal controlled security error.

    Never carry request content or patient information.
    """

    def __init__(
        self,
        code: str,
        status_code: int,
    ) -> None:
        self.code = code
        self.status_code = status_code
        super().__init__(code)


# ============================================================
# 03 — RATE LIMITER
# ============================================================

class LoginRateLimiter:
    """
    Thread-safe, process-local global login throttle.

    It intentionally does not store IP addresses or usernames.

    Limitation:
        The global limit can also affect legitimate users
        during high traffic or deliberate request flooding.
        A trusted gateway should provide stronger per-client
        rate limiting for production deployment.
    """

    def __init__(
        self,
        *,
        maximum_requests: int = LOGIN_RATE_MAX_REQUESTS,
        window_seconds: int = LOGIN_RATE_WINDOW_SECONDS,
    ) -> None:

        if (
            not isinstance(maximum_requests, int)
            or isinstance(maximum_requests, bool)
            or maximum_requests < 1
            or not isinstance(window_seconds, int)
            or isinstance(window_seconds, bool)
            or window_seconds < 1
        ):
            raise ValueError("Invalid rate-limit configuration.")

        self._maximum = maximum_requests
        self._window = window_seconds

        self._attempts: deque[float] = deque()
        self._lock = threading.Lock()

    @property
    def window_seconds(self) -> int:
        return self._window

    def allow_request(self) -> bool:
        """
        Count login requests in a rolling monotonic window.

        No filesystem or network operations.
        """

        now = time.monotonic()
        threshold = now - self._window

        with self._lock:
            while (
                self._attempts
                and self._attempts[0] <= threshold
            ):
                self._attempts.popleft()

            if len(self._attempts) >= self._maximum:
                return False

            self._attempts.append(now)

            return True


# ============================================================
# 04 — SECURITY RESPONSE HEADERS
# ============================================================

def get_security_headers(
    *,
    api_response: bool,
    secure_transport: bool,
) -> dict[str, str]:
    """
    Produce standard protective response headers.

    No user-controlled values are interpolated.
    """

    headers = {
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "X-Frame-Options": "DENY",
        "Content-Security-Policy": CONTENT_SECURITY_POLICY,
        "Permissions-Policy": (
            "camera=(), microphone=(), "
            "geolocation=(), payment=()"
        ),
        "Cross-Origin-Resource-Policy": "same-origin",
    }

    if api_response:
        headers["Cache-Control"] = (
            "no-store, private"
        )
        headers["Pragma"] = "no-cache"

    if secure_transport:
        headers["Strict-Transport-Security"] = (
            "max-age=31536000"
        )

    return headers


# ============================================================
# 05 — SAFE ERROR RESPONSE
# ============================================================

def make_security_error_response(
    code: str,
    status_code: int,
    request_id: str,
    *,
    secure_transport: bool,
) -> JSONResponse:
    """
    Return standardized, non-disclosing security errors.
    """

    messages = {
        "AUTH_REQUIRED": "Authentication is required.",
        "SESSION_EXPIRED": "Your session has expired.",
        "ACCESS_DENIED": "Access denied.",
        "RATE_LIMITED": "Too many requests. Try again later.",
        "REQUEST_TOO_LARGE": "Request exceeds the size limit.",
        "HTTPS_REQUIRED": "A secure connection is required.",
        "CONFIG_ERROR": "Service configuration is unavailable.",
        "INVALID_REQUEST": "The request is invalid.",
    }

    if code not in messages:
        code = "ACCESS_DENIED"
        status_code = 403

    headers = get_security_headers(
        api_response=True,
        secure_transport=secure_transport,
    )

    headers["X-Request-ID"] = request_id

    if status_code == 429:
        headers["Retry-After"] = str(
            LOGIN_RATE_WINDOW_SECONDS
        )

    return JSONResponse(
        status_code=status_code,
        content={
            "success": False,
            "error": {
                "code": code,
                "message": messages[code],
                "retryable": status_code in (429, 503),
                "request_id": request_id,
            },
        },
        headers=headers,
    )


# ============================================================
# 06 — TRANSPORT SECURITY
# ============================================================

def _is_loopback_client(scope: Scope) -> bool:
    client = scope.get("client")

    if not client:
        return False

    return client[0] in TRUSTED_LOOPBACK_HOSTS


def is_secure_request(scope: Scope) -> bool:
    """
    Determine whether incoming HTTP transport is secure.

    Direct HTTPS is accepted.

    For a local reverse proxy, one X-Forwarded-Proto value
    may be accepted only from loopback. This assumes the
    loopback listener is not accessible to untrusted users
    and the trusted proxy overwrites forwarded headers.
    """

    if scope.get("scheme") == "https":
        return True

    if not _is_loopback_client(scope):
        return False

    headers = Headers(scope=scope)
    forwarded = headers.getlist("x-forwarded-proto")

    return (
        len(forwarded) == 1
        and forwarded[0].strip().lower() == "https"
    )


def enforce_transport_security(
    scope: Scope,
) -> None:
    """
    Reject non-HTTPS requests unless explicitly using
    an authorized localhost development origin.
    """

    if is_secure_request(scope):
        return

    try:
        trusted_origin = get_trusted_public_origin()
    except ConfigurationFailure:
        raise SecurityMiddlewareError(
            "HTTPS_REQUIRED",
            403,
        ) from None

    local_development = (
        trusted_origin.startswith("http://localhost")
        or trusted_origin.startswith("http://127.0.0.1")
        or trusted_origin.startswith("http://[::1]")
    )

    if not (
        local_development
        and _is_loopback_client(scope)
    ):
        raise SecurityMiddlewareError(
            "HTTPS_REQUIRED",
            403,
        )


# ============================================================
# 07 — REQUEST BODY LIMIT
# ============================================================

async def read_bounded_body(
    receive: Receive,
    *,
    maximum_bytes: int,
) -> bytes:
    """
    Buffer a bounded request body before sending it to app.

    This protects endpoints even when Content-Length is
    absent or misleading.

    Memory usage is bounded by configured max request size.
    """

    if maximum_bytes < 1:
        raise ValueError("Invalid maximum request size.")

    chunks: list[bytes] = []
    total = 0

    while True:
        message = await receive()

        message_type = message["type"]

        if message_type == "http.disconnect":
            raise SecurityMiddlewareError(
                "INVALID_REQUEST",
                400,
            )

        if message_type != "http.request":
            raise SecurityMiddlewareError(
                "INVALID_REQUEST",
                400,
            )

        chunk = message.get("body", b"")

        if not isinstance(chunk, bytes):
            raise SecurityMiddlewareError(
                "INVALID_REQUEST",
                400,
            )

        total += len(chunk)

        if total > maximum_bytes:
            raise SecurityMiddlewareError(
                "REQUEST_TOO_LARGE",
                413,
            )

        chunks.append(chunk)

        if not message.get("more_body", False):
            break

    return b"".join(chunks)


# ============================================================
# 08 — MIDDLEWARE STATISTICS
# ============================================================

@dataclass(frozen=True)
class MiddlewareStatistics:
    requests: int
    rejected: int
    login_rate_limited: int

    def safe_summary(self) -> dict[str, Any]:
        return {
            "requests": self.requests,
            "rejected": self.rejected,
            "login_rate_limited": self.login_rate_limited,
        }


# ============================================================
# 09 — ASGI SECURITY MIDDLEWARE
# ============================================================

class SinusSecurityMiddleware:
    """
    Pure ASGI middleware for FastAPI.

    Security checks execute before protected route handlers.

    Login and health endpoints are explicitly exempted
    from session authentication, not from security headers
    or transport checks.
    """

    def __init__(
        self,
        app: ASGIApp,
        settings: AppSettings | None = None,
    ) -> None:

        self.app = app

        self.settings = (
            settings if settings is not None
            else get_settings()
        )

        self.max_request_bytes = (
            self.settings.server.limits.max_request_body_mb
            * 1024 * 1024
        )

        self.login_limiter = LoginRateLimiter()

        self._lock = threading.Lock()
        self._requests = 0
        self._rejected = 0
        self._login_rate_limited = 0

    def statistics(self) -> MiddlewareStatistics:
        with self._lock:
            return MiddlewareStatistics(
                requests=self._requests,
                rejected=self._rejected,
                login_rate_limited=self._login_rate_limited,
            )

    async def __call__(
        self,
        scope: Scope,
        receive: Receive,
        send: Send,
    ) -> None:

        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        request_id = uuid.uuid4().hex

        scope.setdefault("state", {})
        scope["state"]["request_id"] = request_id

        path = scope.get("path", "")
        method = scope.get("method", "GET").upper()

        api_request = (
            path == API_PREFIX
            or path.startswith(API_PREFIX + "/")
        )

        secure = is_secure_request(scope)

        with self._lock:
            self._requests += 1

        async def send_secure(message: Message) -> None:
            if message["type"] == "http.response.start":
                existing = list(
                    message.get("headers", [])
                )

                security_headers = get_security_headers(
                    api_response=api_request,
                    secure_transport=secure,
                )

                security_headers["X-Request-ID"] = request_id

                # Replace matching header names rather than
                # producing inconsistent duplicate policies.
                replacement_names = {
                    key.lower().encode("latin-1")
                    for key in security_headers
                }

                existing = [
                    (key, value)
                    for key, value in existing
                    if key.lower() not in replacement_names
                ]

                existing.extend(
                    (
                        key.lower().encode("latin-1"),
                        value.encode("latin-1"),
                    )
                    for key, value in security_headers.items()
                )

                message["headers"] = existing

            await send(message)

        try:
            if api_request:
                enforce_transport_security(scope)

                request = Request(scope, receive=receive)

                # Origin checks protect both login and
                # authenticated unsafe API operations.
                validate_request_origin(request)

                if path == LOGIN_PATH:
                    if method != "POST":
                        raise SecurityMiddlewareError(
                            "ACCESS_DENIED",
                            403,
                        )

                    if not self.login_limiter.allow_request():
                        with self._lock:
                            self._login_rate_limited += 1

                        raise SecurityMiddlewareError(
                            "RATE_LIMITED",
                            429,
                        )

                elif path not in PUBLIC_API_PATHS:
                    # This sets a verified, server-derived
                    # authenticated context on request.state.
                    authenticate_request(request)

            # Protect all API methods with request bodies.
            if api_request and method in BODY_METHODS:
                headers = Headers(scope=scope)

                values = headers.getlist("content-length")

                if len(values) > 1:
                    raise SecurityMiddlewareError(
                        "INVALID_REQUEST",
                        400,
                    )

                if values:
                    try:
                        declared = int(values[0])
                    except ValueError:
                        raise SecurityMiddlewareError(
                            "INVALID_REQUEST",
                            400,
                        ) from None

                    if declared < 0:
                        raise SecurityMiddlewareError(
                            "INVALID_REQUEST",
                            400,
                        )

                    if declared > self.max_request_bytes:
                        raise SecurityMiddlewareError(
                            "REQUEST_TOO_LARGE",
                            413,
                        )

                body = await read_bounded_body(
                    receive,
                    maximum_bytes=self.max_request_bytes,
                )

                body_sent = False

                async def buffered_receive() -> Message:
                    nonlocal body_sent

                    if not body_sent:
                        body_sent = True

                        return {
                            "type": "http.request",
                            "body": body,
                            "more_body": False,
                        }

                    return await receive()

                await self.app(
                    scope,
                    buffered_receive,
                    send_secure,
                )

            else:
                await self.app(
                    scope,
                    receive,
                    send_secure,
                )

        except SecurityMiddlewareError as exc:
            with self._lock:
                self._rejected += 1

            response = make_security_error_response(
                exc.code,
                exc.status_code,
                request_id,
                secure_transport=secure,
            )

            await response(scope, receive, send_secure)

        except AuthenticationRequired:
            with self._lock:
                self._rejected += 1

            response = make_security_error_response(
                "AUTH_REQUIRED",
                401,
                request_id,
                secure_transport=secure,
            )

            await response(scope, receive, send_secure)

        except SessionExpired:
            with self._lock:
                self._rejected += 1

            response = make_security_error_response(
                "SESSION_EXPIRED",
                401,
                request_id,
                secure_transport=secure,
            )

            await response(scope, receive, send_secure)

        except AccessDenied:
            with self._lock:
                self._rejected += 1

            response = make_security_error_response(
                "ACCESS_DENIED",
                403,
                request_id,
                secure_transport=secure,
            )

            await response(scope, receive, send_secure)

        except ConfigurationFailure:
            with self._lock:
                self._rejected += 1

            response = make_security_error_response(
                "CONFIG_ERROR",
                503,
                request_id,
                secure_transport=secure,
            )

            await response(scope, receive, send_secure)


# ============================================================
# 10 — REGISTRATION HELPER
# ============================================================

def register_security_middleware(
    app: FastAPI,
    settings: AppSettings | None = None,
) -> None:
    """
    Register middleware before serving HTTP requests.

    FastAPI middleware registration must happen during
    application construction, before application startup.
    """

    active = settings if settings is not None else get_settings()

    app.add_middleware(
        SinusSecurityMiddleware,
        settings=active,
    )


# ============================================================
# END OF CENTRAL HTTP SECURITY MIDDLEWARE
# ============================================================
