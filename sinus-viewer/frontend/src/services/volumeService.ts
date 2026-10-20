
/**
 * SINUS VIEWER — FRONTEND VOLUME SERVICE
 * ======================================
 *
 * Responsibilities:
 * - Obtain authorized 3D volume descriptors.
 * - Select full-resolution or preview levels.
 * - Download bounded HTTP byte ranges.
 * - Assemble little-endian float32 voxel arrays.
 * - Publish React-compatible loading progress.
 * - Cancel outdated downloads.
 * - Enforce per-volume browser memory limits.
 * - Clear image data after logout/unmount.
 *
 * SECURITY:
 * - Only server-issued opaque resource handles are used.
 * - The backend authenticates and authorizes every request.
 * - No pixel data, identifiers or raw errors are logged.
 * - No localStorage, IndexedDB or filesystem persistence.
 * - No original DICOM dataset modifications.
 *
 * GEOMETRY:
 * - Array storage is C-contiguous Z,Y,X.
 * - Voxel data is IEEE float32 little-endian.
 * - Physical coordinates are DICOM LPS.
 * - Geometry must be retained with the selected level.
 *
 * LIMITATION:
 * - Complete selected levels are assembled in browser RAM.
 * - This is not out-of-core or GPU streaming.
 * - For oversized volumes, use smaller preview levels.
 */

import {
  apiGetVolumeRange,
  apiLoadVolume,
  getPublicErrorText,
  isAuthenticationFailure,
} from "./apiClient";

import {
  isOpaqueHandle,
  isVolumeLevel,
  type VolumeDescriptor,
  type VolumeGeometry,
  type VolumeLevel,
} from "../types/api";


// ============================================================
// 01 — LIMITS AND CONSTANTS
// ============================================================

export const DEFAULT_VOLUME_MEMORY_LIMIT_BYTES =
  256 * 1024 * 1024;

export const DEFAULT_VOLUME_CHUNK_BYTES =
  4 * 1024 * 1024;

export const MAX_VOLUME_MEMORY_LIMIT_BYTES =
  512 * 1024 * 1024;

export const MAX_VOLUME_CHUNK_BYTES =
  16 * 1024 * 1024;

const BYTES_PER_FLOAT32 = 4;

const LITTLE_ENDIAN = true;


// ============================================================
// 02 — PUBLIC TYPES
// ============================================================

export type VolumeLoadStatus =
  | "idle"
  | "preparing"
  | "downloading"
  | "ready"
  | "cancelled"
  | "error"
  | "authentication-required";

export interface LoadedVolume {
  readonly datasetSessionId: string;
  readonly seriesHandle: string;
  readonly level: number;

  readonly shapeZYX: readonly [
    number,
    number,
    number,
  ];

  readonly geometry: VolumeGeometry;

  readonly voxelCount: number;
  readonly byteSize: number;

  /**
   * Float32Array is mutable.
   * Treat it as owned by the viewer and do not modify it
   * outside explicitly controlled rendering operations.
   */
  readonly voxels: Float32Array;
}

export interface VolumeLoadProgress {
  readonly status: VolumeLoadStatus;
  readonly downloadedBytes: number;
  readonly totalBytes: number;
  readonly percentage: number;
  readonly selectedLevel: number | null;
  readonly error: string | null;
}

export interface VolumeServiceSnapshot {
  readonly progress: VolumeLoadProgress;
  readonly volume: LoadedVolume | null;
  readonly descriptor: VolumeDescriptor | null;
}

export interface VolumeLoadOptions {
  readonly level?: number;
  readonly preferPreview?: boolean;
  readonly signal?: AbortSignal;
}

export interface VolumeServiceOptions {
  readonly memoryLimitBytes?: number;
  readonly chunkBytes?: number;
}

export type VolumeStateListener = (
  snapshot: VolumeServiceSnapshot,
) => void;


// ============================================================
// 03 — CONTROLLED ERRORS
// ============================================================

export class FrontendVolumeError extends Error {
  readonly code:
    | "INVALID_SELECTION"
    | "INVALID_VOLUME"
    | "MEMORY_LIMIT"
    | "CANCELLED"
    | "AUTH_REQUIRED"
    | "NETWORK_FAILURE";

  constructor(
    code: FrontendVolumeError["code"],
    message: string,
  ) {
    super(message);
    this.name = "FrontendVolumeError";
    this.code = code;
  }
}

function cancelledError(): FrontendVolumeError {
  return new FrontendVolumeError(
    "CANCELLED",
    "Volume loading was cancelled.",
  );
}

function convertPublicError(
  error: unknown,
): FrontendVolumeError {
  if (error instanceof FrontendVolumeError) {
    return error;
  }

  if (isAuthenticationFailure(error)) {
    return new FrontendVolumeError(
      "AUTH_REQUIRED",
      "Your session has expired. Sign in again.",
    );
  }

  return new FrontendVolumeError(
    "NETWORK_FAILURE",
    getPublicErrorText(error),
  );
}


// ============================================================
// 04 — SAFE NUMERIC VALIDATION
// ============================================================

function isPositiveSafeInteger(
  value: unknown,
): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0
  );
}

function validateConfiguration(
  memoryLimitBytes: number,
  chunkBytes: number,
): void {
  if (
    !isPositiveSafeInteger(memoryLimitBytes) ||
    memoryLimitBytes > MAX_VOLUME_MEMORY_LIMIT_BYTES ||
    memoryLimitBytes < BYTES_PER_FLOAT32 ||
    !isPositiveSafeInteger(chunkBytes) ||
    chunkBytes > MAX_VOLUME_CHUNK_BYTES ||
    chunkBytes < BYTES_PER_FLOAT32 ||
    chunkBytes % BYTES_PER_FLOAT32 !== 0
  ) {
    throw new FrontendVolumeError(
      "INVALID_VOLUME",
      "Invalid volume loading configuration.",
    );
  }
}

function validateSelection(
  datasetSessionId: string,
  seriesHandle: string,
): void {
  if (
    !isOpaqueHandle(datasetSessionId) ||
    !isOpaqueHandle(seriesHandle)
  ) {
    throw new FrontendVolumeError(
      "INVALID_SELECTION",
      "Select a valid dataset and series.",
    );
  }
}

function verifyLevel(
  level: VolumeLevel,
  memoryLimitBytes: number,
): void {
  if (!isVolumeLevel(level)) {
    throw new FrontendVolumeError(
      "INVALID_VOLUME",
      "Invalid volume geometry or data format.",
    );
  }

  if (
    level.byte_size > memoryLimitBytes ||
    level.byte_size > MAX_VOLUME_MEMORY_LIMIT_BYTES
  ) {
    throw new FrontendVolumeError(
      "MEMORY_LIMIT",
      "This volume exceeds the browser memory limit.",
    );
  }

  if (
    level.byte_size % BYTES_PER_FLOAT32 !== 0 ||
    !Number.isSafeInteger(level.byte_size)
  ) {
    throw new FrontendVolumeError(
      "INVALID_VOLUME",
      "The volume byte layout is invalid.",
    );
  }
}


// ============================================================
// 05 — LEVEL SELECTION
// ============================================================

export function chooseVolumeLevel(
  descriptor: VolumeDescriptor,
  memoryLimitBytes: number,
  requestedLevel?: number,
  preferPreview = true,
): VolumeLevel {
  if (
    !Array.isArray(descriptor.levels) ||
    descriptor.levels.length === 0
  ) {
    throw new FrontendVolumeError(
      "INVALID_VOLUME",
      "No volume levels are available.",
    );
  }

  if (requestedLevel !== undefined) {
    if (
      !Number.isSafeInteger(requestedLevel) ||
      requestedLevel < 0 ||
      requestedLevel > 64
    ) {
      throw new FrontendVolumeError(
        "INVALID_SELECTION",
        "Invalid volume resolution level.",
      );
    }

    const selected = descriptor.levels.find(
      (item) => item.level === requestedLevel,
    );

    if (!selected) {
      throw new FrontendVolumeError(
        "INVALID_SELECTION",
        "The selected volume level is unavailable.",
      );
    }

    verifyLevel(selected, memoryLimitBytes);
    return selected;
  }

  const fitting = descriptor.levels.filter(
    (item) => (
      isVolumeLevel(item) &&
      item.byte_size <= memoryLimitBytes
    ),
  );

  if (fitting.length === 0) {
    throw new FrontendVolumeError(
      "MEMORY_LIMIT",
      "No available volume level fits the memory limit.",
    );
  }

  const ordered = [...fitting].sort(
    (a, b) => a.byte_size - b.byte_size,
  );

  if (preferPreview) {
    const preview = ordered.find(
      (item) => item.is_preview,
    );

    if (preview) {
      verifyLevel(preview, memoryLimitBytes);
      return preview;
    }
  }

  const highestResolution = ordered[
    ordered.length - 1
  ];

  verifyLevel(highestResolution, memoryLimitBytes);
  return highestResolution;
}


// ============================================================
// 06 — SNAPSHOT FACTORY
// ============================================================

function makeProgress(
  status: VolumeLoadStatus = "idle",
  downloadedBytes = 0,
  totalBytes = 0,
  selectedLevel: number | null = null,
  error: string | null = null,
): VolumeLoadProgress {
  const percentage = totalBytes > 0
    ? Math.min(
        100,
        Math.max(
          0,
          (downloadedBytes / totalBytes) * 100,
        ),
      )
    : 0;

  return {
    status,
    downloadedBytes,
    totalBytes,
    percentage,
    selectedLevel,
    error,
  };
}

function makeInitialSnapshot(): VolumeServiceSnapshot {
  return {
    progress: makeProgress(),
    volume: null,
    descriptor: null,
  };
}


// ============================================================
// 07 — FRONTEND VOLUME SERVICE
// ============================================================

export class FrontendVolumeService {
  private readonly memoryLimitBytes: number;
  private readonly chunkBytes: number;

  private readonly listeners =
    new Set<VolumeStateListener>();

  private snapshot: VolumeServiceSnapshot =
    makeInitialSnapshot();

  private requestVersion = 0;
  private controller: AbortController | null = null;
  private disposed = false;

  constructor(options: VolumeServiceOptions = {}) {
    const memoryLimit =
      options.memoryLimitBytes ??
      DEFAULT_VOLUME_MEMORY_LIMIT_BYTES;

    const chunkSize =
      options.chunkBytes ??
      DEFAULT_VOLUME_CHUNK_BYTES;

    validateConfiguration(memoryLimit, chunkSize);

    this.memoryLimitBytes = memoryLimit;
    this.chunkBytes = Math.min(
      chunkSize,
      memoryLimit,
    );
  }

  // ==========================================================
  // 08 — STATE SUBSCRIPTIONS
  // ==========================================================

  getSnapshot = (): VolumeServiceSnapshot => {
    return this.snapshot;
  };

  subscribe = (
    listener: VolumeStateListener,
  ): (() => void) => {
    if (this.disposed) {
      return () => undefined;
    }

    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  };

  private publish(
    value: VolumeServiceSnapshot,
  ): void {
    if (this.disposed) {
      return;
    }

    this.snapshot = value;

    for (const listener of this.listeners) {
      try {
        listener(value);
      } catch {
        // An unrelated UI subscriber cannot interrupt
        // volume loading or other subscribers.
      }
    }
  }

  private updateProgress(
    progress: VolumeLoadProgress,
  ): void {
    this.publish({
      ...this.snapshot,
      progress,
    });
  }

  private isCurrent(
    version: number,
    controller: AbortController,
  ): boolean {
    return (
      !this.disposed &&
      this.requestVersion === version &&
      this.controller === controller &&
      !controller.signal.aborted
    );
  }

  private assertCurrent(
    version: number,
    controller: AbortController,
  ): void {
    if (!this.isCurrent(version, controller)) {
      throw cancelledError();
    }
  }

  // ==========================================================
  // 09 — CANCEL AND RESET
  // ==========================================================

  cancel(): void {
    if (this.disposed) {
      return;
    }

    this.requestVersion++;
    this.controller?.abort();
    this.controller = null;

    if (
      this.snapshot.progress.status === "preparing" ||
      this.snapshot.progress.status === "downloading"
    ) {
      this.updateProgress(
        makeProgress("cancelled"),
      );
    }
  }

  /**
   * Clear all loaded image data references.
   *
   * Call on logout, dataset change, or viewer unmount.
   * JavaScript GC determines when memory is reclaimed.
   */
  reset(): void {
    if (this.disposed) {
      return;
    }

    this.requestVersion++;
    this.controller?.abort();
    this.controller = null;

    this.publish(makeInitialSnapshot());
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }

    this.requestVersion++;
    this.controller?.abort();
    this.controller = null;
    this.disposed = true;

    this.listeners.clear();
    this.snapshot = makeInitialSnapshot();
  }

  // ==========================================================
  // 10 — LOAD SELECTED VOLUME
  // ==========================================================

  async load(
    datasetSessionId: string,
    seriesHandle: string,
    options: VolumeLoadOptions = {},
  ): Promise<LoadedVolume> {
    if (this.disposed) {
      throw new FrontendVolumeError(
        "INVALID_SELECTION",
        "The volume loader is unavailable.",
      );
    }

    validateSelection(datasetSessionId, seriesHandle);

    // A newer request must supersede older downloads.
    this.requestVersion++;
    const version = this.requestVersion;

    this.controller?.abort();

    const controller = new AbortController();
    this.controller = controller;

    const externalSignal = options.signal;

    const abortFromCaller = () => {
      controller.abort();
    };

    externalSignal?.addEventListener(
      "abort",
      abortFromCaller,
      { once: true },
    );

    if (externalSignal?.aborted) {
      controller.abort();
    }

    // Drop old image references before allocating new data.
    this.publish({
      progress: makeProgress("preparing"),
      volume: null,
      descriptor: null,
    });

    try {
      this.assertCurrent(version, controller);

      const response = await apiLoadVolume(
        datasetSessionId,
        seriesHandle,
      );

      this.assertCurrent(version, controller);

      const descriptor = response.volume;

      const level = chooseVolumeLevel(
        descriptor,
        this.memoryLimitBytes,
        options.level,
        options.preferPreview ?? true,
      );

      const totalBytes = level.byte_size;

      // Allocate once; avoid collecting all binary chunks
      // in a separate list before assembling the volume.
      const buffer = new ArrayBuffer(totalBytes);
      const destination = new Uint8Array(buffer);

      this.publish({
        descriptor,
        volume: null,
        progress: makeProgress(
          "downloading",
          0,
          totalBytes,
          level.level,
        ),
      });

      let offset = 0;

      while (offset < totalBytes) {
        this.assertCurrent(version, controller);

        const length = Math.min(
          this.chunkBytes,
          totalBytes - offset,
        );

        if (
          length <= 0 ||
          length % BYTES_PER_FLOAT32 !== 0
        ) {
          throw new FrontendVolumeError(
            "INVALID_VOLUME",
            "An invalid binary chunk was requested.",
          );
        }

        const result = await apiGetVolumeRange(
          datasetSessionId,
          seriesHandle,
          level.level,
          offset,
          length,
          controller.signal,
        );

        this.assertCurrent(version, controller);

        if (
          result.status !== 206 ||
          result.bytes.byteLength !== length
        ) {
          throw new FrontendVolumeError(
            "INVALID_VOLUME",
            "Incomplete volume data received.",
          );
        }

        destination.set(result.bytes, offset);
        offset += length;

        this.updateProgress(
          makeProgress(
            "downloading",
            offset,
            totalBytes,
            level.level,
          ),
        );
      }

      this.assertCurrent(version, controller);

      if (
        offset !== totalBytes ||
        buffer.byteLength !== totalBytes
      ) {
        throw new FrontendVolumeError(
          "INVALID_VOLUME",
          "The downloaded volume is incomplete.",
        );
      }

      // DataView performs an explicit little-endian
      // decode, including on non-little-endian hosts.
      const view = new DataView(buffer);
      const voxelCount =
        totalBytes / BYTES_PER_FLOAT32;

      const voxels = new Float32Array(voxelCount);

      for (let index = 0; index < voxelCount; index++) {
        if (
          index % 262144 === 0 &&
          !this.isCurrent(version, controller)
        ) {
          throw cancelledError();
        }

        voxels[index] = view.getFloat32(
          index * BYTES_PER_FLOAT32,
          LITTLE_ENDIAN,
        );
      }

      this.assertCurrent(version, controller);

      const volume: LoadedVolume = {
        datasetSessionId,
        seriesHandle,
        level: level.level,
        shapeZYX: level.shape_zyx,
        geometry: level.geometry,
        voxelCount,
        byteSize: totalBytes,
        voxels,
      };

      this.publish({
        descriptor,
        volume,
        progress: makeProgress(
          "ready",
          totalBytes,
          totalBytes,
          level.level,
        ),
      });

      return volume;
    } catch (error: unknown) {
      if (
        !this.isCurrent(version, controller) ||
        controller.signal.aborted
      ) {
        throw cancelledError();
      }

      const failure = convertPublicError(error);

      this.publish({
        descriptor: null,
        volume: null,
        progress: makeProgress(
          failure.code === "AUTH_REQUIRED"
            ? "authentication-required"
            : failure.code === "CANCELLED"
              ? "cancelled"
              : "error",
          0,
          0,
          null,
          failure.message,
        ),
      });

      throw failure;
    } finally {
      externalSignal?.removeEventListener(
        "abort",
        abortFromCaller,
      );

      if (this.controller === controller) {
        this.controller = null;
      }
    }
  }

  // ==========================================================
  // 11 — LOADED VOXEL ACCESS
  // ==========================================================

  getVoxel(
    z: number,
    y: number,
    x: number,
  ): number | null {
    const volume = this.snapshot.volume;

    if (!volume) {
      return null;
    }

    const [depth, height, width] = volume.shapeZYX;

    if (
      !Number.isSafeInteger(z) ||
      !Number.isSafeInteger(y) ||
      !Number.isSafeInteger(x) ||
      z < 0 ||
      y < 0 ||
      x < 0 ||
      z >= depth ||
      y >= height ||
      x >= width
    ) {
      return null;
    }

    const index = (
      z * height * width +
      y * width +
      x
    );

    return volume.voxels[index] ?? null;
  }

  // ==========================================================
  // 12 — RESOURCE INFORMATION
  // ==========================================================

  getMemoryLimitBytes(): number {
    return this.memoryLimitBytes;
  }

  getChunkSizeBytes(): number {
    return this.chunkBytes;
  }

  hasLoadedVolume(): boolean {
    return (
      this.snapshot.progress.status === "ready" &&
      this.snapshot.volume !== null
    );
  }
}


// ============================================================
// 13 — FACTORY
// ============================================================

export function createVolumeService(
  options: VolumeServiceOptions = {},
): FrontendVolumeService {
  return new FrontendVolumeService(options);
}


// ============================================================
// END OF FRONTEND VOLUME SERVICE
// ============================================================
