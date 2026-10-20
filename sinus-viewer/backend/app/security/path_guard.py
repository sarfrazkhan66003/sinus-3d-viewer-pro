
"""
SINUS VIEWER — READ-ONLY DATASET PATH GUARD
===========================================

Centralized protection for original DICOM dataset access.

Features:
- Restrict paths to a configured dataset root.
- Reject traversal components and symbolic links.
- Open files using POSIX directory file descriptors.
- Read-only binary file access with O_NOFOLLOW.
- Reject devices, sockets, FIFOs and nonregular files.
- Keep runtime storage separate from source dataset.
- Provide controlled errors without sensitive paths.
- No source file creation, writing or deletion.

Deployment target:
    Google Colab / Linux with POSIX dir_fd support.

This module deliberately fails closed on platforms that
lack the required secure opening primitives.

IMPORTANT:
- Importing this module performs no filesystem operations.
- Security checks are not a replacement for authentication.
- All HTTP requests must be authorized before path access.
- Source files must never be opened with write flags.
- Existing scanner/decoder integrations must be migrated
  to this guard in the integration phase.
"""

from __future__ import annotations

import os
import stat
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO, Iterator

from ..core.config import AppSettings, get_settings


# ============================================================
# 01 — CONTROLLED ERRORS
# ============================================================

class PathGuardError(RuntimeError):
    """Base path-security error without filesystem details."""

    public_code = "PATH_REJECTED"

    def __init__(self) -> None:
        super().__init__(self.public_code)


class PathAccessDenied(PathGuardError):
    """Path outside the permitted dataset or unsafe component."""


class PathNotFound(PathGuardError):
    """Requested source is missing or inaccessible."""


class PathTypeRejected(PathGuardError):
    """Expected file/directory type does not match."""


class PathPlatformUnsupported(PathGuardError):
    """Required secure filesystem primitives unavailable."""


# ============================================================
# 02 — IMMUTABLE SOURCE DESCRIPTION
# ============================================================

@dataclass(frozen=True)
class GuardedFileInfo:
    size_bytes: int
    device_id: int
    inode: int

    def safe_summary(self) -> dict:
        # Device/inode identifiers deliberately not exposed.
        return {
            "size_bytes": self.size_bytes,
            "regular_file": True,
        }


# ============================================================
# 03 — PLATFORM SECURITY CHECK
# ============================================================

def require_secure_posix() -> None:
    """
    Require descriptor-relative Linux/POSIX file operations.

    No silent downgrade to ordinary pathname-based opening.
    """

    if os.name != "posix":
        raise PathPlatformUnsupported()

    required_flags = (
        "O_RDONLY",
        "O_DIRECTORY",
        "O_NOFOLLOW",
        "O_CLOEXEC",
    )

    if any(not hasattr(os, name) for name in required_flags):
        raise PathPlatformUnsupported()

    if (
        os.open not in os.supports_dir_fd
        or os.stat not in os.supports_dir_fd
    ):
        raise PathPlatformUnsupported()


# ============================================================
# 04 — PATH COMPONENT VALIDATION
# ============================================================

def _split_components(value: str) -> tuple[str, ...]:
    """
    Split POSIX path components without trusting normalization.

    Explicitly rejects parent traversal, null bytes and
    alternate path separator syntax.
    """

    if not isinstance(value, str) or not value:
        raise PathAccessDenied()

    if "\x00" in value or "\\" in value:
        raise PathAccessDenied()

    components = tuple(
        component
        for component in value.split("/")
        if component not in ("", ".")
    )

    if any(component == ".." for component in components):
        raise PathAccessDenied()

    return components


def _absolute_components(path: str | Path) -> tuple[str, ...]:
    raw = os.fspath(path)

    if not isinstance(raw, str) or not raw.startswith("/"):
        raise PathAccessDenied()

    return _split_components(raw)


# ============================================================
# 05 — CONFIGURED ROOT POLICY
# ============================================================

def get_dataset_root(
    settings: AppSettings | None = None,
) -> Path:
    """
    Return configured dataset root without resolving links.

    Symlinks are checked during descriptor-based opening.
    """

    active = settings if settings is not None else get_settings()

    root = active.storage.dataset.root_path

    if not root.is_absolute():
        raise PathAccessDenied()

    _absolute_components(root)

    return root


def check_runtime_isolation(
    settings: AppSettings | None = None,
) -> None:
    """
    Reject overlapping dataset and runtime storage paths.

    This compares lexical components. Both trees must also
    be validated independently at their actual use sites.
    """

    active = settings if settings is not None else get_settings()

    dataset = _absolute_components(
        active.storage.dataset.root_path
    )

    runtime = _absolute_components(
        active.storage.runtime.root_path
    )

    if not dataset or not runtime:
        raise PathAccessDenied()

    def prefix(a: tuple[str, ...], b: tuple[str, ...]) -> bool:
        return len(a) <= len(b) and b[:len(a)] == a

    if prefix(dataset, runtime) or prefix(runtime, dataset):
        raise PathAccessDenied()


# ============================================================
# 06 — RESOLVE ALLOWED RELATIVE COMPONENTS
# ============================================================

def allowed_relative_parts(
    path: str | Path,
    settings: AppSettings | None = None,
    *,
    allow_root: bool = False,
) -> tuple[str, ...]:
    """
    Validate lexical containment inside dataset root.

    Relative paths are interpreted relative to that root.
    Absolute paths must start with the exact root components.

    This does not access the filesystem.
    """

    root_parts = _absolute_components(
        get_dataset_root(settings)
    )

    raw = os.fspath(path)

    if not isinstance(raw, str) or not raw:
        raise PathAccessDenied()

    if raw.startswith("/"):
        parts = _absolute_components(raw)

        if parts[:len(root_parts)] != root_parts:
            raise PathAccessDenied()

        relative = parts[len(root_parts):]
    else:
        relative = _split_components(raw)

    if not relative and not allow_root:
        raise PathAccessDenied()

    return relative


# ============================================================
# 07 — DESCRIPTOR-RELATIVE DIRECTORY ACCESS
# ============================================================

@contextmanager
def _open_directory_chain(
    absolute_parts: tuple[str, ...],
) -> Iterator[int]:
    """
    Safely traverse directories from filesystem root.

    Every path component is opened with O_NOFOLLOW and
    O_DIRECTORY; symlinked components are rejected.

    Uses no writable file descriptors.
    """

    require_secure_posix()

    flags = (
        os.O_RDONLY
        | os.O_DIRECTORY
        | os.O_NOFOLLOW
        | os.O_CLOEXEC
    )

    fd: int | None = None

    try:
        fd = os.open("/", flags)

        for part in absolute_parts:
            next_fd = os.open(
                part,
                flags,
                dir_fd=fd,
            )

            os.close(fd)
            fd = next_fd

        yield fd

    except (OSError, ValueError):
        raise PathAccessDenied() from None

    finally:
        if fd is not None:
            os.close(fd)


@contextmanager
def open_guarded_directory(
    path: str | Path,
    settings: AppSettings | None = None,
) -> Iterator[int]:
    """
    Open a directory beneath the authorized root.

    Caller receives a read-only directory descriptor.
    The descriptor is closed when the context ends.

    Do not expose this descriptor or its path to browser APIs.
    """

    active = settings if settings is not None else get_settings()

    check_runtime_isolation(active)

    relative = allowed_relative_parts(
        path,
        active,
        allow_root=True,
    )

    components = (
        _absolute_components(get_dataset_root(active))
        + relative
    )

    with _open_directory_chain(components) as fd:
        yield fd


# ============================================================
# 08 — SECURE READ-ONLY FILE OPENING
# ============================================================

@contextmanager
def open_guarded_binary(
    path: str | Path,
    settings: AppSettings | None = None,
    *,
    max_bytes: int | None = None,
) -> Iterator[tuple[BinaryIO, GuardedFileInfo]]:
    """
    Open a regular dataset file with read-only flags.

    Security:
    - Traversal rejected before opening.
    - Every directory component checked with O_NOFOLLOW.
    - Final file opened with O_NOFOLLOW.
    - Final descriptor verified using fstat().
    - No write/create/truncate flags used.

    Unlike returning a validated pathname, the opened
    descriptor remains tied to the verified file object.

    Intended pattern:
        with open_guarded_binary(path, settings) as (stream, info):
            dataset = pydicom.dcmread(
                stream,
                stop_before_pixels=True,
            )
    """

    active = settings if settings is not None else get_settings()

    check_runtime_isolation(active)

    parts = allowed_relative_parts(path, active)

    if not parts:
        raise PathAccessDenied()

    if max_bytes is not None and (
        not isinstance(max_bytes, int)
        or isinstance(max_bytes, bool)
        or max_bytes < 1
    ):
        raise ValueError("Invalid maximum file size.")

    parent_parts = (
        _absolute_components(get_dataset_root(active))
        + parts[:-1]
    )

    filename = parts[-1]

    flags = (
        os.O_RDONLY
        | os.O_NOFOLLOW
        | os.O_CLOEXEC
        | getattr(os, "O_NONBLOCK", 0)
    )

    with _open_directory_chain(parent_parts) as parent_fd:
        fd: int | None = None

        try:
            fd = os.open(
                filename,
                flags,
                dir_fd=parent_fd,
            )

            details = os.fstat(fd)

            if not stat.S_ISREG(details.st_mode):
                raise PathTypeRejected()

            if (
                max_bytes is not None
                and details.st_size > max_bytes
            ):
                raise PathTypeRejected()

            info = GuardedFileInfo(
                size_bytes=int(details.st_size),
                device_id=int(details.st_dev),
                inode=int(details.st_ino),
            )

            stream = os.fdopen(fd, "rb", closefd=True)
            fd = None

            with stream:
                yield stream, info

        except PathGuardError:
            raise

        except (OSError, ValueError):
            raise PathNotFound() from None

        finally:
            if fd is not None:
                os.close(fd)


# ============================================================
# 09 — READ-ONLY FILE INFORMATION
# ============================================================

def inspect_guarded_file(
    path: str | Path,
    settings: AppSettings | None = None,
    *,
    max_bytes: int | None = None,
) -> GuardedFileInfo:
    """
    Inspect a regular file through a secure descriptor.

    Does not read pixel data or modify original content.
    """

    with open_guarded_binary(
        path,
        settings,
        max_bytes=max_bytes,
    ) as (_, info):
        return info


# ============================================================
# 10 — PATH GUARD SERVICE WRAPPER
# ============================================================

class DatasetPathGuard:
    """
    Small reusable interface for DICOM reader modules.

    Actual dataset access remains read-only and occurs
    only inside explicit method calls.
    """

    def __init__(
        self,
        settings: AppSettings | None = None,
    ) -> None:
        self._settings = (
            settings if settings is not None
            else get_settings()
        )

        check_runtime_isolation(self._settings)

    def validate_relative(
        self,
        path: str | Path,
        *,
        allow_root: bool = False,
    ) -> tuple[str, ...]:
        return allowed_relative_parts(
            path,
            self._settings,
            allow_root=allow_root,
        )

    def inspect_file(
        self,
        path: str | Path,
        *,
        max_bytes: int | None = None,
    ) -> GuardedFileInfo:
        return inspect_guarded_file(
            path,
            self._settings,
            max_bytes=max_bytes,
        )

    @contextmanager
    def open_file(
        self,
        path: str | Path,
        *,
        max_bytes: int | None = None,
    ) -> Iterator[tuple[BinaryIO, GuardedFileInfo]]:
        with open_guarded_binary(
            path,
            self._settings,
            max_bytes=max_bytes,
        ) as result:
            yield result

    @contextmanager
    def open_directory(
        self,
        path: str | Path,
    ) -> Iterator[int]:
        with open_guarded_directory(
            path,
            self._settings,
        ) as fd:
            yield fd


# ============================================================
# 11 — FACTORY
# ============================================================

def create_dataset_path_guard(
    settings: AppSettings | None = None,
) -> DatasetPathGuard:
    """
    Create a guard without reading patient data.

    Runtime capability checks occur during guarded
    filesystem operations.
    """

    return DatasetPathGuard(settings)


# ============================================================
# END OF DATASET PATH GUARD
# ============================================================
