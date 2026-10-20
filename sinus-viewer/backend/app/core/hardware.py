
"""
SINUS VIEWER — HARDWARE & RESOURCE MANAGEMENT
=============================================

Responsibilities:
- Detect CPU and system RAM.
- Detect available NVIDIA GPUs using nvidia-smi.
- Inspect GPU memory and CUDA availability.
- Select a safe processing device.
- Estimate DICOM volume memory requirements.
- Prevent oversized allocations before volume loading.
- Recommend full-resolution or preview-only processing.
- Provide sanitized hardware information to the backend.

IMPORTANT:
- GPU presence does not imply GPU acceleration is implemented.
- GPU processing requires an actual CUDA-compatible pipeline.
- Browser WebGL rendering is independent of Colab GPU.
- No hardware packages are installed by this module.
- No DICOM files are opened or modified.
- No filesystem writes during import or detection.

Python: 3.10+
Dependencies: psutil, Pydantic configuration module
"""

from __future__ import annotations

import math
import os
import shutil
import subprocess
from dataclasses import asdict, dataclass
from enum import Enum
from typing import Any, Literal

import psutil

from .config import AppSettings, get_settings


# ============================================================
# 01 — CONSTANTS
# ============================================================

GIB = 1024 ** 3
MIB = 1024 ** 2

NVIDIA_SMI_TIMEOUT = 5

SUPPORTED_GPU_IDENTIFIERS = {
    "NVIDIA_T4": ("t4", "tesla t4"),
    "NVIDIA_L4": ("l4", "nvidia l4"),
    "NVIDIA_A100": ("a100",),
}

SUPPORTED_PIXEL_DTYPES = {
    "uint8": 1,
    "int8": 1,
    "uint16": 2,
    "int16": 2,
    "uint32": 4,
    "int32": 4,
    "float32": 4,
    "float64": 8,
}


# ============================================================
# 02 — ENUMERATIONS
# ============================================================

class DeviceType(str, Enum):
    CPU = "cpu"
    GPU = "gpu"


class VolumeLoadMode(str, Enum):
    FULL = "full"
    PREVIEW = "preview"
    REJECT = "reject"


# ============================================================
# 03 — IMMUTABLE HARDWARE DATA MODELS
# ============================================================

@dataclass(frozen=True)
class CPUInfo:
    logical_cores: int
    physical_cores: int | None
    total_ram_bytes: int
    available_ram_bytes: int
    used_ram_percent: float


@dataclass(frozen=True)
class GPUInfo:
    index: int
    name: str
    total_vram_bytes: int
    free_vram_bytes: int
    used_vram_bytes: int
    recognized_target: str | None
    supported_by_config: bool


@dataclass(frozen=True)
class HardwareSnapshot:
    cpu: CPUInfo
    gpus: tuple[GPUInfo, ...]
    nvidia_smi_available: bool
    tpu_enabled: bool


@dataclass(frozen=True)
class DeviceSelection:
    device: DeviceType
    gpu_index: int | None
    reason: str
    acceleration_ready: bool


@dataclass(frozen=True)
class VolumeMemoryEstimate:
    width: int
    height: int
    depth: int
    dtype: str
    voxel_count: int
    raw_bytes: int
    estimated_peak_bytes: int
    estimated_peak_gib: float


@dataclass(frozen=True)
class VolumeLoadDecision:
    mode: VolumeLoadMode
    reason: str
    estimate: VolumeMemoryEstimate
    available_memory_bytes: int
    permitted_memory_bytes: int


# ============================================================
# 04 — CPU AND RAM DETECTION
# ============================================================

def detect_cpu() -> CPUInfo:
    """
    Return the current CPU and system RAM snapshot.

    Read-only system inspection.
    """

    memory = psutil.virtual_memory()

    logical = psutil.cpu_count(logical=True) or 1
    physical = psutil.cpu_count(logical=False)

    return CPUInfo(
        logical_cores=max(1, logical),
        physical_cores=physical,
        total_ram_bytes=int(memory.total),
        available_ram_bytes=int(memory.available),
        used_ram_percent=float(memory.percent),
    )


# ============================================================
# 05 — NVIDIA GPU IDENTIFICATION
# ============================================================

def recognize_gpu(name: str) -> str | None:
    """
    Recognize known GPU families.

    An unrecognized NVIDIA GPU may still be usable by
    compatible libraries, but is not automatically approved.
    """

    normalized = name.casefold().strip()

    for target, patterns in SUPPORTED_GPU_IDENTIFIERS.items():
        if any(pattern in normalized for pattern in patterns):
            return target

    return None


def _nvidia_smi_path() -> str | None:
    """Find nvidia-smi without installing additional software."""

    return shutil.which("nvidia-smi")


def detect_nvidia_gpus(
    settings: AppSettings | None = None,
) -> tuple[GPUInfo, ...]:
    """
    Inspect NVIDIA GPU memory via nvidia-smi.

    Fail safely if nvidia-smi is unavailable, times out,
    or produces unexpected output.

    No PyTorch/CuPy import and no GPU memory allocation.
    """

    active = settings if settings is not None else get_settings()

    if not active.hardware.gpu.enabled:
        return ()

    command = _nvidia_smi_path()

    if command is None:
        return ()

    args = [
        command,
        "--query-gpu=index,name,memory.total,memory.free,memory.used",
        "--format=csv,noheader,nounits",
    ]

    try:
        result = subprocess.run(
            args,
            capture_output=True,
            text=True,
            timeout=NVIDIA_SMI_TIMEOUT,
            check=False,
            shell=False,
        )

    except (
        OSError,
        subprocess.TimeoutExpired,
        UnicodeError,
    ):
        return ()

    if result.returncode != 0:
        return ()

    supported_targets = set(
        active.hardware.gpu.supported_targets
    )

    detected: list[GPUInfo] = []

    for line in result.stdout.splitlines():
        parts = [part.strip() for part in line.split(",")]

        if len(parts) != 5:
            continue

        try:
            index = int(parts[0])
            name = parts[1]

            total_mb = int(parts[2])
            free_mb = int(parts[3])
            used_mb = int(parts[4])

        except (ValueError, IndexError):
            continue

        if (
            index < 0
            or total_mb <= 0
            or free_mb < 0
            or used_mb < 0
            or free_mb > total_mb
        ):
            continue

        recognized = recognize_gpu(name)

        detected.append(
            GPUInfo(
                index=index,
                name=name,
                total_vram_bytes=total_mb * MIB,
                free_vram_bytes=free_mb * MIB,
                used_vram_bytes=used_mb * MIB,
                recognized_target=recognized,
                supported_by_config=(
                    recognized in supported_targets
                ),
            )
        )

    return tuple(
        sorted(detected, key=lambda gpu: gpu.index)
    )


# ============================================================
# 06 — COMPLETE HARDWARE SNAPSHOT
# ============================================================

def detect_hardware(
    settings: AppSettings | None = None,
) -> HardwareSnapshot:
    """
    Detect current backend compute resources.

    This function does not initialize CUDA contexts.
    """

    active = settings if settings is not None else get_settings()

    return HardwareSnapshot(
        cpu=detect_cpu(),
        gpus=detect_nvidia_gpus(active),
        nvidia_smi_available=(
            _nvidia_smi_path() is not None
        ),
        tpu_enabled=active.hardware.tpu.enabled,
    )


# ============================================================
# 07 — DEVICE SELECTION
# ============================================================

def select_processing_device(
    snapshot: HardwareSnapshot,
    settings: AppSettings | None = None,
    *,
    gpu_acceleration_available: bool = False,
) -> DeviceSelection:
    """
    Select processing hardware without claiming unsupported CUDA.

    gpu_acceleration_available must only be True after the
    actual GPU processing implementation has passed its own
    initialization and capability checks.

    Selecting a GPU here does not transfer data to CUDA.
    """

    active = settings if settings is not None else get_settings()

    hardware = active.hardware
    mode = hardware.selection_mode

    if mode == "cpu":
        return DeviceSelection(
            device=DeviceType.CPU,
            gpu_index=None,
            reason="cpu_explicitly_selected",
            acceleration_ready=False,
        )

    candidates = [
        gpu for gpu in snapshot.gpus
        if gpu.supported_by_config
        and gpu.free_vram_bytes >= (
            hardware.gpu.minimum_free_vram_gb * GIB
        )
    ]

    candidates.sort(
        key=lambda gpu: gpu.free_vram_bytes,
        reverse=True,
    )

    gpu_ready = (
        hardware.gpu.enabled
        and hardware.gpu.detect_cuda
        and hardware.gpu.enable_optional_gpu_preprocessing
        and gpu_acceleration_available
    )

    if gpu_ready and candidates:
        selected = candidates[0]

        return DeviceSelection(
            device=DeviceType.GPU,
            gpu_index=selected.index,
            reason="gpu_available_and_processing_supported",
            acceleration_ready=True,
        )

    if not hardware.cpu.enabled:
        raise RuntimeError(
            "No usable processing device is available."
        )

    return DeviceSelection(
        device=DeviceType.CPU,
        gpu_index=None,
        reason=(
            "gpu_processing_unavailable_cpu_fallback"
            if mode == "gpu"
            else "safe_cpu_processing"
        ),
        acceleration_ready=False,
    )


# ============================================================
# 08 — DICOM VOLUME MEMORY ESTIMATION
# ============================================================

def estimate_volume_memory(
    *,
    width: int,
    height: int,
    depth: int,
    dtype: str = "int16",
    working_memory_multiplier: float = 3.0,
) -> VolumeMemoryEstimate:
    """
    Estimate raw and peak volume memory requirements.

    The multiplier accounts approximately for temporary
    decode, resampling and volume-processing buffers.

    It is a conservative planning estimate, not a guarantee
    of actual peak memory usage.
    """

    if any(
        not isinstance(value, int)
        or isinstance(value, bool)
        or value <= 0
        for value in (width, height, depth)
    ):
        raise ValueError(
            "Volume dimensions must be positive integers."
        )

    if dtype not in SUPPORTED_PIXEL_DTYPES:
        raise ValueError(
            "Unsupported volume pixel dtype."
        )

    if (
        not math.isfinite(working_memory_multiplier)
        or working_memory_multiplier < 1.0
    ):
        raise ValueError(
            "Invalid working memory multiplier."
        )

    voxels = width * height * depth

    raw_bytes = voxels * SUPPORTED_PIXEL_DTYPES[dtype]

    peak_bytes = math.ceil(
        raw_bytes * working_memory_multiplier
    )

    return VolumeMemoryEstimate(
        width=width,
        height=height,
        depth=depth,
        dtype=dtype,
        voxel_count=voxels,
        raw_bytes=raw_bytes,
        estimated_peak_bytes=peak_bytes,
        estimated_peak_gib=round(
            peak_bytes / GIB, 3
        ),
    )


# ============================================================
# 09 — ALLOCATION SAFETY CHECK
# ============================================================

def evaluate_volume_load(
    estimate: VolumeMemoryEstimate,
    snapshot: HardwareSnapshot,
    settings: AppSettings | None = None,
) -> VolumeLoadDecision:
    """
    Evaluate whether a volume can be loaded safely.

    Checks:
    - Configured maximum voxel count.
    - Configured raw volume size.
    - Available RAM after safety reservation.
    - Maximum permitted RAM utilization.

    Does not load or allocate the volume.
    """

    active = settings if settings is not None else get_settings()

    volume_config = active.dicom.volume
    memory_config = active.performance.memory

    available = snapshot.cpu.available_ram_bytes

    reserve = int(
        max(
            active.hardware.cpu.reserve_system_memory_gb,
            memory_config.minimum_free_ram_gb,
        ) * GIB
    )

    memory_fraction = (
        memory_config.max_ram_utilization_percent / 100.0
    )

    total_budget = int(
        snapshot.cpu.total_ram_bytes * memory_fraction
    )

    currently_used = max(
        0,
        snapshot.cpu.total_ram_bytes - available,
    )

    remaining_budget = max(
        0,
        total_budget - currently_used,
    )

    available_after_reserve = max(
        0,
        available - reserve,
    )

    permitted = min(
        remaining_budget,
        available_after_reserve,
    )

    exceeds_voxel_limit = (
        estimate.voxel_count > volume_config.max_voxels
    )

    exceeds_raw_size_limit = (
        estimate.raw_bytes >
        volume_config.max_uncompressed_volume_mb * MIB
    )

    exceeds_memory_budget = (
        memory_config.enable_memory_guard
        and estimate.estimated_peak_bytes > permitted
    )

    if not (
        exceeds_voxel_limit
        or exceeds_raw_size_limit
        or exceeds_memory_budget
    ):
        return VolumeLoadDecision(
            mode=VolumeLoadMode.FULL,
            reason="full_volume_within_limits",
            estimate=estimate,
            available_memory_bytes=available,
            permitted_memory_bytes=permitted,
        )

    if volume_config.preview.enabled:
        return VolumeLoadDecision(
            mode=VolumeLoadMode.PREVIEW,
            reason="full_volume_exceeds_limits",
            estimate=estimate,
            available_memory_bytes=available,
            permitted_memory_bytes=permitted,
        )

    return VolumeLoadDecision(
        mode=VolumeLoadMode.REJECT,
        reason="volume_exceeds_limits_preview_disabled",
        estimate=estimate,
        available_memory_bytes=available,
        permitted_memory_bytes=permitted,
    )


# ============================================================
# 10 — PREVIEW DIMENSION PLANNING
# ============================================================

def suggest_preview_dimensions(
    *,
    width: int,
    height: int,
    depth: int,
    max_dimension: int = 384,
) -> tuple[int, int, int]:
    """
    Calculate aspect-ratio-preserving preview dimensions.

    Dimensions are returned as (width, height, depth).

    No pixel data is read or modified.

    The volume builder must also verify physical voxel
    spacing and orientation before any actual resampling.
    """

    dimensions = (width, height, depth)

    if any(
        not isinstance(value, int)
        or isinstance(value, bool)
        or value <= 0
        for value in dimensions
    ):
        raise ValueError(
            "Invalid preview volume dimensions."
        )

    if max_dimension < 1:
        raise ValueError(
            "max_dimension must be positive."
        )

    largest = max(dimensions)

    if largest <= max_dimension:
        return dimensions

    scale = max_dimension / largest

    return tuple(
        max(1, round(value * scale))
        for value in dimensions
    )


# ============================================================
# 11 — SAFE HARDWARE SUMMARY
# ============================================================

def get_hardware_summary(
    snapshot: HardwareSnapshot,
    selection: DeviceSelection,
) -> dict[str, Any]:
    """
    Return operational hardware details.

    No patient information, dataset paths, machine usernames
    or authentication credentials are included.
    """

    return {
        "cpu": {
            "logical_cores": snapshot.cpu.logical_cores,
            "physical_cores": snapshot.cpu.physical_cores,
            "total_ram_gib": round(
                snapshot.cpu.total_ram_bytes / GIB, 2
            ),
            "available_ram_gib": round(
                snapshot.cpu.available_ram_bytes / GIB, 2
            ),
            "used_ram_percent": snapshot.cpu.used_ram_percent,
        },
        "gpu": [
            {
                "index": gpu.index,
                "name": gpu.name,
                "total_vram_gib": round(
                    gpu.total_vram_bytes / GIB, 2
                ),
                "free_vram_gib": round(
                    gpu.free_vram_bytes / GIB, 2
                ),
                "supported": gpu.supported_by_config,
            }
            for gpu in snapshot.gpus
        ],
        "selection": {
            "device": selection.device.value,
            "gpu_index": selection.gpu_index,
            "reason": selection.reason,
            "acceleration_ready": selection.acceleration_ready,
        },
        "browser_gpu": {
            "checked_by_backend": False,
            "note": "WebGL capability is checked in the browser.",
        },
    }


# ============================================================
# 12 — MAIN DETECTION HELPER
# ============================================================

def initialize_hardware(
    settings: AppSettings | None = None,
    *,
    gpu_acceleration_available: bool = False,
) -> tuple[HardwareSnapshot, DeviceSelection]:
    """
    Detect hardware and select a processing device.

    This function does not:
    - Install drivers.
    - Initialize PyTorch or CUDA.
    - Allocate GPU memory.
    - Read DICOM files.
    - Modify original patient datasets.
    """

    active = settings if settings is not None else get_settings()

    snapshot = detect_hardware(active)

    selection = select_processing_device(
        snapshot,
        active,
        gpu_acceleration_available=gpu_acceleration_available,
    )

    return snapshot, selection


# ============================================================
# END OF HARDWARE ENGINE
# ============================================================
