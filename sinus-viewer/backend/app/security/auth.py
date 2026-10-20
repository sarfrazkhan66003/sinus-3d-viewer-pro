
"""
SINUS VIEWER — SECURE AUTHENTICATION ENGINE
===========================================

Features:
- Argon2id password verification.
- Credentials loaded from environment variables.
- Cryptographically random session tokens.
- Only SHA-256 token digests retained in session storage.
- Idle and absolute session expiration.
- Session renewal by authenticated activity.
- Logout and global session revocation.
- Bounded in-memory session registry.
- Secure, HttpOnly, SameSite cookies.
- Random, per-session owner IDs for dataset isolation.
- No authentication credentials in logs or API errors.
- No filesystem operations or dataset modification.

SECURITY LIMITATIONS:
- This module does not implement HTTP login routes.
- Origin validation, CSRF protection, HTTPS enforcement,
  request throttling and proxy trust checks are required
  in the FastAPI security integration.
- Session state is process-local and is lost on restart.
- Multiple backend workers require shared session storage
  or sticky routing; this initial deployment uses one worker.
- In-memory logout revocation does not revoke any HTTP
  response that has already transmitted patient data.

Python 3.10+
Required dependency on Colab: argon2-cffi
"""

from __future__ import annotations

import hashlib
import hmac
import os
import re
import secrets
import threading
import time
from dataclasses import dataclass, field
from typing import Any

from argon2 import PasswordHasher
from argon2.exceptions import (
    InvalidHashError,
    VerificationError,
    VerifyMismatchError,
)
from fastapi import Response

from ..core.config import AppSettings, get_settings


# ============================================================
# 01 — CONSTANTS
# ============================================================

USERNAME_ENV = "SINUS_VIEWER_USERNAME"
PASSWORD_HASH_ENV = "SINUS_VIEWER_PASSWORD_HASH"

SECURE_COOKIE_NAME = "__Host-sinus_viewer_session"
DEVELOPMENT_COOKIE_NAME = "sinus_viewer_session"

MAX_USERNAME_LENGTH = 128
MAX_PASSWORD_LENGTH = 1024
MAX_SESSION_TOKEN_LENGTH = 128
MAX_ACTIVE_SESSIONS = 32

SESSION_TOKEN_PATTERN = re.compile(
    r"^[A-Za-z0-9_-]{32,128}$",
    re.ASCII,
)

ARGON2ID_PREFIX = "$argon2id$"


# ============================================================
# 02 — CONTROLLED AUTHENTICATION ERRORS
# ============================================================

class AuthError(RuntimeError):
    """Safe authentication exception."""

    public_code = "AUTH_FAILED"

    def __init__(self) -> None:
        super().__init__(self.public_code)


class AuthConfigurationError(AuthError):
    public_code = "CONFIG_ERROR"


class InvalidCredentials(AuthError):
    public_code = "AUTH_FAILED"


class AuthenticationRequired(AuthError):
    public_code = "AUTH_REQUIRED"


class SessionExpired(AuthError):
    public_code = "SESSION_EXPIRED"


class SessionCapacityExceeded(AuthError):
    public_code = "SERVICE_UNAVAILABLE"


class AuthenticationServiceClosed(AuthError):
    public_code = "SERVICE_UNAVAILABLE"


# ============================================================
# 03 — SAFE DATA MODELS
# ============================================================

@dataclass(frozen=True)
class AuthIdentity:
    """
    Trusted identity returned after session validation.

    owner_id is an opaque server-generated value suitable
    for DatasetService ownership checks.

    Never construct this object from request parameters.
    """

    owner_id: str
    issued_at: float
    expires_at: float


@dataclass
class _SessionRecord:
    owner_id: str = field(repr=False)
    created_monotonic: float
    last_seen_monotonic: float
    absolute_deadline: float
    idle_deadline: float
    issued_wall_time: float


@dataclass(frozen=True)
class AuthenticationStatistics:
    active_sessions: int
    maximum_sessions: int
    login_successes: int
    login_failures: int
    expired_sessions: int
    revoked_sessions: int
    closed: bool

    def safe_summary(self) -> dict[str, Any]:
        return {
            "active_sessions": self.active_sessions,
            "maximum_sessions": self.maximum_sessions,
            "login_successes": self.login_successes,
            "login_failures": self.login_failures,
            "expired_sessions": self.expired_sessions,
            "revoked_sessions": self.revoked_sessions,
            "closed": self.closed,
        }


# ============================================================
# 04 — ENVIRONMENT CREDENTIAL LOADING
# ============================================================

def load_auth_credentials(
    settings: AppSettings | None = None,
) -> tuple[str, str]:
    """
    Load configured credentials without printing their values.

    Fails closed when credentials are absent or malformed.
    """

    active = settings if settings is not None else get_settings()

    credentials = active.security.credentials

    if credentials.source != "environment":
        raise AuthConfigurationError()

    username_key = credentials.username_env
    hash_key = credentials.password_hash_env

    if not username_key or not hash_key:
        raise AuthConfigurationError()

    username = os.environ.get(username_key)
    password_hash = os.environ.get(hash_key)

    if (
        not isinstance(username, str)
        or not username
        or len(username) > MAX_USERNAME_LENGTH
        or username.strip() != username
        or not isinstance(password_hash, str)
        or not password_hash.startswith(ARGON2ID_PREFIX)
        or len(password_hash) > 1024
    ):
        raise AuthConfigurationError()

    return username, password_hash


# ============================================================
# 05 — TOKEN HELPERS
# ============================================================

def generate_session_token() -> str:
    """
    Generate a high-entropy bearer session token.

    The plaintext token must only travel in a secure cookie.
    """

    return secrets.token_urlsafe(48)


def digest_session_token(token: str) -> str:
    """
    Hash a bearer token before using it as an internal key.
    """

    if (
        not isinstance(token, str)
        or not SESSION_TOKEN_PATTERN.fullmatch(token)
        or len(token) > MAX_SESSION_TOKEN_LENGTH
    ):
        raise AuthenticationRequired()

    return hashlib.sha256(
        token.encode("ascii")
    ).hexdigest()


def generate_owner_id() -> str:
    """
    Create an opaque per-login owner identifier.

    Do not use usernames, patient IDs or source paths.
    """

    return "owner_" + secrets.token_urlsafe(24)


# ============================================================
# 06 — PASSWORD VERIFICATION
# ============================================================

def verify_password(
    password: str,
    expected_hash: str,
    *,
    hasher: PasswordHasher | None = None,
) -> bool:
    """
    Verify Argon2id hash using argon2-cffi.

    Never compare plaintext passwords directly.
    Never emit password values or verifier exceptions.

    Rate limiting is required at the HTTP layer.
    """

    if (
        not isinstance(password, str)
        or not password
        or len(password) > MAX_PASSWORD_LENGTH
    ):
        return False

    if (
        not isinstance(expected_hash, str)
        or not expected_hash.startswith(ARGON2ID_PREFIX)
    ):
        raise AuthConfigurationError()

    verifier = hasher if hasher is not None else PasswordHasher()

    try:
        return bool(
            verifier.verify(expected_hash, password)
        )

    except VerifyMismatchError:
        return False

    except (VerificationError, InvalidHashError):
        return False


# ============================================================
# 07 — AUTHENTICATION SERVICE
# ============================================================

class AuthenticationService:
    """
    Thread-safe, process-local authentication manager.

    Session records are keyed by token digests, never
    by plaintext bearer tokens.
    """

    def __init__(
        self,
        settings: AppSettings | None = None,
        *,
        max_active_sessions: int = MAX_ACTIVE_SESSIONS,
    ) -> None:
        if (
            not isinstance(max_active_sessions, int)
            or isinstance(max_active_sessions, bool)
            or max_active_sessions < 1
        ):
            raise ValueError("Invalid session capacity.")

        self._settings = (
            settings if settings is not None
            else get_settings()
        )

        security = self._settings.security

        if (
            not security.require_authentication
            or security.allow_anonymous_access
            or not security.sessions.enabled
        ):
            raise AuthConfigurationError()

        self._username, self._password_hash = (
            load_auth_credentials(self._settings)
        )

        self._hasher = PasswordHasher()

        self._idle_seconds = (
            security.sessions.idle_timeout_minutes * 60
        )
        self._absolute_seconds = (
            security.sessions.absolute_timeout_hours * 3600
        )

        if (
            self._idle_seconds <= 0
            or self._absolute_seconds <= 0
        ):
            raise AuthConfigurationError()

        self._maximum_sessions = max_active_sessions

        self._sessions: dict[str, _SessionRecord] = {}
        self._lock = threading.RLock()

        self._closed = False

        self._login_successes = 0
        self._login_failures = 0
        self._expired_sessions = 0
        self._revoked_sessions = 0

    # --------------------------------------------------------
    # INTERNAL STATE
    # --------------------------------------------------------

    def _require_open(self) -> None:
        if self._closed:
            raise AuthenticationServiceClosed()

    def _remove_expired(self, now: float) -> None:
        expired = [
            digest
            for digest, record in self._sessions.items()
            if (
                now >= record.idle_deadline
                or now >= record.absolute_deadline
            )
        ]

        for digest in expired:
            del self._sessions[digest]
            self._expired_sessions += 1

    # --------------------------------------------------------
    # LOGIN
    # --------------------------------------------------------

    def login(
        self,
        username: str,
        password: str,
    ) -> str:
        """
        Authenticate credentials and return a bearer token.

        This is an internal service method, not an API
        response. The HTTP route must set a secure cookie
        and must not put the token into JSON or logs.
        """

        with self._lock:
            self._require_open()

        username_valid = (
            isinstance(username, str)
            and 0 < len(username) <= MAX_USERNAME_LENGTH
            and hmac.compare_digest(
                username.encode("utf-8"),
                self._username.encode("utf-8"),
            )
        )

        # Always verify the password hash for valid
        # bounded passwords, even if username is wrong.
        password_valid = verify_password(
            password,
            self._password_hash,
            hasher=self._hasher,
        )

        with self._lock:
            self._require_open()

            if not (username_valid and password_valid):
                self._login_failures += 1
                raise InvalidCredentials()

            now = time.monotonic()

            self._remove_expired(now)

            if len(self._sessions) >= self._maximum_sessions:
                raise SessionCapacityExceeded()

            token = generate_session_token()
            digest = digest_session_token(token)

            self._sessions[digest] = _SessionRecord(
                owner_id=generate_owner_id(),
                created_monotonic=now,
                last_seen_monotonic=now,
                absolute_deadline=now + self._absolute_seconds,
                idle_deadline=now + self._idle_seconds,
                issued_wall_time=time.time(),
            )

            self._login_successes += 1

            return token

    # --------------------------------------------------------
    # AUTHENTICATE SESSION
    # --------------------------------------------------------

    def authenticate(
        self,
        token: str | None,
        *,
        update_activity: bool = True,
    ) -> AuthIdentity:
        """
        Validate an existing session and return trusted
        server-side identity information.
        """

        if token is None:
            raise AuthenticationRequired()

        digest = digest_session_token(token)

        with self._lock:
            self._require_open()

            now = time.monotonic()
            record = self._sessions.get(digest)

            if record is None:
                raise AuthenticationRequired()

            if (
                now >= record.idle_deadline
                or now >= record.absolute_deadline
            ):
                del self._sessions[digest]
                self._expired_sessions += 1
                raise SessionExpired()

            if update_activity:
                record.last_seen_monotonic = now
                record.idle_deadline = min(
                    now + self._idle_seconds,
                    record.absolute_deadline,
                )

            self._remove_expired(now)

            return AuthIdentity(
                owner_id=record.owner_id,
                issued_at=record.issued_wall_time,
                expires_at=(
                    time.time()
                    + max(
                        0.0,
                        record.absolute_deadline - now,
                    )
                ),
            )

    # --------------------------------------------------------
    # LOGOUT
    # --------------------------------------------------------

    def logout(self, token: str | None) -> bool:
        """
        Revoke one bearer token.

        Safe to call with a missing or already-revoked token.
        """

        if token is None:
            return False

        try:
            digest = digest_session_token(token)
        except AuthenticationRequired:
            return False

        with self._lock:
            self._require_open()

            removed = self._sessions.pop(
                digest,
                None,
            )

            if removed is not None:
                self._revoked_sessions += 1
                return True

            return False

    def revoke_all_sessions(self) -> int:
        """
        Revoke all sessions.

        Expose only through trusted administrative code.
        """

        with self._lock:
            self._require_open()

            count = len(self._sessions)

            self._sessions.clear()
            self._revoked_sessions += count

            return count

    # --------------------------------------------------------
    # STATISTICS
    # --------------------------------------------------------

    def statistics(self) -> AuthenticationStatistics:
        with self._lock:
            self._remove_expired(time.monotonic())

            return AuthenticationStatistics(
                active_sessions=len(self._sessions),
                maximum_sessions=self._maximum_sessions,
                login_successes=self._login_successes,
                login_failures=self._login_failures,
                expired_sessions=self._expired_sessions,
                revoked_sessions=self._revoked_sessions,
                closed=self._closed,
            )

    # --------------------------------------------------------
    # SHUTDOWN
    # --------------------------------------------------------

    def close(self) -> None:
        """
        Revoke all in-memory sessions and prevent new ones.
        """

        with self._lock:
            if self._closed:
                return

            self._closed = True
            self._revoked_sessions += len(self._sessions)
            self._sessions.clear()


# ============================================================
# 08 — COOKIE POLICY
# ============================================================

def get_session_cookie_name(
    settings: AppSettings | None = None,
) -> str:
    active = settings if settings is not None else get_settings()

    if active.security.sessions.cookie_secure:
        return SECURE_COOKIE_NAME

    return DEVELOPMENT_COOKIE_NAME


def set_session_cookie(
    response: Response,
    token: str,
    settings: AppSettings | None = None,
) -> None:
    """
    Attach a bearer token to an HttpOnly session cookie.

    Only call after successful login and HTTPS/origin
    checks performed by the API security layer.
    """

    active = settings if settings is not None else get_settings()
    sessions = active.security.sessions

    digest_session_token(token)

    if not sessions.cookie_http_only:
        raise AuthConfigurationError()

    same_site = sessions.cookie_same_site.lower()

    if same_site not in {"strict", "lax", "none"}:
        raise AuthConfigurationError()

    if same_site == "none" and not sessions.cookie_secure:
        raise AuthConfigurationError()

    lifetime = int(
        sessions.absolute_timeout_hours * 3600
    )

    response.set_cookie(
        key=get_session_cookie_name(active),
        value=token,
        max_age=lifetime,
        path="/",
        secure=sessions.cookie_secure,
        httponly=True,
        samesite=same_site,
    )

    response.headers["Cache-Control"] = "no-store"
    response.headers["Pragma"] = "no-cache"


def clear_session_cookie(
    response: Response,
    settings: AppSettings | None = None,
) -> None:
    """
    Remove browser cookie after server-side logout.

    The HTTP logout route must call logout() before this.
    """

    active = settings if settings is not None else get_settings()

    response.delete_cookie(
        key=get_session_cookie_name(active),
        path="/",
        secure=active.security.sessions.cookie_secure,
        httponly=True,
        samesite=active.security.sessions.cookie_same_site.lower(),
    )

    response.headers["Cache-Control"] = "no-store"
    response.headers["Pragma"] = "no-cache"


# ============================================================
# 09 — SERVICE FACTORY
# ============================================================

def create_authentication_service(
    settings: AppSettings | None = None,
) -> AuthenticationService:
    """
    Construct one authentication service per backend process.

    Environment credentials must exist before startup.
    """

    return AuthenticationService(settings)


def get_authentication_summary(
    service: AuthenticationService,
) -> dict[str, Any]:
    """
    Non-identifying operational statistics only.
    """

    return service.statistics().safe_summary()


# ============================================================
# END OF AUTHENTICATION ENGINE
# ============================================================
