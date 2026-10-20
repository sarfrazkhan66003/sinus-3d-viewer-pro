
/**
 * SINUS VIEWER — VIEWPORT RENDER TELEMETRY
 * ========================================
 *
 * File 112
 *
 * Local-only, bounded rendering measurements.
 *
 * - Receives completed-frame samples from parent.
 * - Computes FPS from accepted frame timestamps.
 * - Computes average frame render duration.
 * - Rejects invalid/out-of-order measurements.
 * - Prevents cross-generation sample mixing.
 * - Rejects stale samples in display snapshots.
 * - Supports explicit reset and refresh.
 * - Does not poll automatically.
 * - Does not transmit or persist telemetry.
 *
 * IMPORTANT:
 * All timestamps must use the same monotonic
 * clock basis, normally performance.now().
 *
 * A frame sample is recorded ONLY after the
 * current frame has been accepted for display.
 *
 * Rendering performance is NOT a measure of
 * medical image accuracy or clinical validity.
 *
 * Original DICOM dataset remains READ ONLY.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

// ============================================================
// 01 — PUBLIC TYPES
// ============================================================

export type TelemetryViewportPlane =
  | "axial"
  | "coronal"
  | "sagittal";

export interface ViewportRenderSample {
  readonly plane: TelemetryViewportPlane;
  readonly generation: number;

  /**
   * Monotonic timestamp of accepted presentation.
   * Should use performance.now(), not Date.now().
   */
  readonly completedAtMs: number;

  /**
   * Measured duration of this rendering operation.
   * Must come from actual instrumentation.
   */
  readonly renderDurationMs: number;
}

export interface ViewportRenderTelemetryOptions {
  readonly plane: TelemetryViewportPlane;
  readonly generation: number;
  readonly maxSamples?: number;
  readonly staleAfterMs?: number;
}

export interface ViewportRenderTelemetrySnapshot {
  readonly plane: TelemetryViewportPlane;
  readonly generation: number;
  readonly sampleCount: number;
  readonly samplesFresh: boolean;
  readonly fps: number | null;
  readonly frameTimeMs: number | null;
  readonly lastRenderMs: number | null;
}

export interface UseViewportRenderTelemetryOptions
  extends ViewportRenderTelemetryOptions {
  readonly enabled?: boolean;
}

// ============================================================
// 02 — CONSTANTS
// ============================================================

export const TELEMETRY_DEFAULT_MAX_SAMPLES = 30;
export const TELEMETRY_MAX_SAMPLES_LIMIT = 120;
export const TELEMETRY_DEFAULT_STALE_MS = 2000;
export const TELEMETRY_MAX_DURATION_MS = 600000;
export const TELEMETRY_MAX_FPS = 1000;

// ============================================================
// 03 — PURE VALIDATION
// ============================================================

export function isValidTelemetryGeneration(
  value: unknown,
): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
  );
}

export function isValidTelemetryTimestamp(
  value: unknown,
): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0
  );
}

export function isValidTelemetryDuration(
  value: unknown,
): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= TELEMETRY_MAX_DURATION_MS
  );
}

export function normalizeTelemetryMaxSamples(
  value: number | undefined,
): number {
  if (
    value === undefined ||
    !Number.isSafeInteger(value)
  ) {
    return TELEMETRY_DEFAULT_MAX_SAMPLES;
  }

  return Math.max(
    2,
    Math.min(TELEMETRY_MAX_SAMPLES_LIMIT, value),
  );
}

export function normalizeTelemetryStaleAfter(
  value: number | undefined,
): number {
  if (
    value === undefined ||
    !Number.isFinite(value) ||
    value < 100 ||
    value > 60000
  ) {
    return TELEMETRY_DEFAULT_STALE_MS;
  }

  return value;
}

export function telemetryPlaneLabel(
  plane: TelemetryViewportPlane,
): string {
  switch (plane) {
    case "axial":
      return "Axial";
    case "coronal":
      return "Coronal";
    case "sagittal":
      return "Sagittal";
  }
}

// ============================================================
// 04 — PURE METRIC CALCULATIONS
// ============================================================

/**
 * FPS describes the accepted frame cadence.
 * It does not mean the renderer can sustain
 * this rate under every workload.
 */
export function calculateTelemetryFPS(
  timestamps: readonly number[],
): number | null {
  if (timestamps.length < 2) {
    return null;
  }

  const first = timestamps[0];
  const last = timestamps[timestamps.length - 1];

  if (
    !isValidTelemetryTimestamp(first) ||
    !isValidTelemetryTimestamp(last) ||
    last <= first
  ) {
    return null;
  }

  for (let i = 1; i < timestamps.length; i++) {
    if (
      !isValidTelemetryTimestamp(timestamps[i]) ||
      timestamps[i] <= timestamps[i - 1]
    ) {
      return null;
    }
  }

  const elapsedMs = last - first;
  const framesBetween = timestamps.length - 1;

  const fps = (framesBetween * 1000) / elapsedMs;

  if (
    !Number.isFinite(fps) ||
    fps <= 0 ||
    fps > TELEMETRY_MAX_FPS
  ) {
    return null;
  }

  return fps;
}

export function calculateTelemetryAverageDuration(
  durations: readonly number[],
): number | null {
  if (durations.length === 0) {
    return null;
  }

  let total = 0;

  for (const duration of durations) {
    if (!isValidTelemetryDuration(duration)) {
      return null;
    }

    total += duration;
  }

  const average = total / durations.length;

  return Number.isFinite(average)
    ? average
    : null;
}

// ============================================================
// 05 — BOUNDED TELEMETRY STORE
// ============================================================

/**
 * No external listeners, network requests,
 * timers or persistent browser storage.
 *
 * Only non-identifying numerical measurements
 * are retained in this store.
 */
export class ViewportRenderTelemetryStore {
  private plane: TelemetryViewportPlane;
  private generation: number;

  private readonly maxSamples: number;
  private readonly staleAfterMs: number;

  private samples: ViewportRenderSample[] = [];

  constructor(options: ViewportRenderTelemetryOptions) {
    this.plane = options.plane;

    this.generation = isValidTelemetryGeneration(
      options.generation,
    )
      ? options.generation
      : -1;

    this.maxSamples =
      normalizeTelemetryMaxSamples(
        options.maxSamples,
      );

    this.staleAfterMs =
      normalizeTelemetryStaleAfter(
        options.staleAfterMs,
      );
  }

  // ==========================================================
  // 06 — RECORD ACCEPTED FRAME
  // ==========================================================

  record(sample: ViewportRenderSample): boolean {
    if (
      sample.plane !== this.plane ||
      sample.generation !== this.generation ||
      !isValidTelemetryGeneration(
        sample.generation,
      ) ||
      !isValidTelemetryTimestamp(
        sample.completedAtMs,
      ) ||
      !isValidTelemetryDuration(
        sample.renderDurationMs,
      )
    ) {
      return false;
    }

    const previous =
      this.samples[this.samples.length - 1];

    if (
      previous &&
      sample.completedAtMs <=
        previous.completedAtMs
    ) {
      return false;
    }

    this.samples.push({
      plane: sample.plane,
      generation: sample.generation,
      completedAtMs: sample.completedAtMs,
      renderDurationMs: sample.renderDurationMs,
    });

    if (this.samples.length > this.maxSamples) {
      this.samples.splice(
        0,
        this.samples.length - this.maxSamples,
      );
    }

    return true;
  }

  // ==========================================================
  // 07 — RESET ON PLANE/VOLUME CHANGE
  // ==========================================================

  reset(
    plane: TelemetryViewportPlane,
    generation: number,
  ): void {
    this.plane = plane;

    this.generation = isValidTelemetryGeneration(
      generation,
    )
      ? generation
      : -1;

    this.samples = [];
  }

  // ==========================================================
  // 08 — BUILD SAFE SNAPSHOT
  // ==========================================================

  snapshot(
    nowMs: number,
  ): ViewportRenderTelemetrySnapshot {
    const validGeneration =
      isValidTelemetryGeneration(
        this.generation,
      );

    const last =
      this.samples[this.samples.length - 1];

    const fresh =
      validGeneration &&
      last !== undefined &&
      isValidTelemetryTimestamp(nowMs) &&
      nowMs >= last.completedAtMs &&
      nowMs - last.completedAtMs <=
        this.staleAfterMs;

    if (!fresh || !last) {
      return {
        plane: this.plane,
        generation: this.generation,
        sampleCount: 0,
        samplesFresh: false,
        fps: null,
        frameTimeMs: null,
        lastRenderMs: null,
      };
    }

    const timestamps = this.samples.map(
      (sample) => sample.completedAtMs,
    );

    const durations = this.samples.map(
      (sample) => sample.renderDurationMs,
    );

    return {
      plane: this.plane,
      generation: this.generation,
      sampleCount: this.samples.length,
      samplesFresh: true,
      fps: calculateTelemetryFPS(
        timestamps,
      ),
      frameTimeMs:
        calculateTelemetryAverageDuration(
          durations,
        ),
      lastRenderMs: last.renderDurationMs,
    };
  }

  getSampleCount(): number {
    return this.samples.length;
  }

  clear(): void {
    this.samples = [];
  }
}

// ============================================================
// 09 — CLOCK HELPER
// ============================================================

/**
 * Uses a monotonic browser clock.
 *
 * Returns null when the clock is unavailable
 * rather than inventing a timestamp.
 */
export function readTelemetryClock(): number | null {
  if (
    typeof performance === "undefined" ||
    typeof performance.now !== "function"
  ) {
    return null;
  }

  const now = performance.now();

  return isValidTelemetryTimestamp(now)
    ? now
    : null;
}

// ============================================================
// 10 — REACT HOOK
// ============================================================

/**
 * useViewportRenderTelemetry lives INSIDE this
 * file; do not create a separate hook file.
 *
 * Hook does not poll or automatically measure
 * frames. Parent must report accepted frames.
 */
export function useViewportRenderTelemetry(
  options: UseViewportRenderTelemetryOptions,
) {
  const enabled = options.enabled ?? false;

  const store = useMemo(
    () =>
      new ViewportRenderTelemetryStore({
        plane: options.plane,
        generation: options.generation,
        maxSamples: options.maxSamples,
        staleAfterMs: options.staleAfterMs,
      }),
    [
      options.maxSamples,
      options.staleAfterMs,
    ],
  );

  const identityRef = useRef({
    plane: options.plane,
    generation: options.generation,
  });

  const [snapshot, setSnapshot] = useState<
    ViewportRenderTelemetrySnapshot
  >(() => store.snapshot(0));

  /**
   * Reset when volume identity changes or
   * diagnostic collection is disabled.
   */
  useEffect(() => {
    identityRef.current = {
      plane: options.plane,
      generation: options.generation,
    };

    store.reset(
      options.plane,
      options.generation,
    );

    const now = readTelemetryClock();

    setSnapshot(store.snapshot(now ?? -1));

    return () => {
      store.clear();
    };
  }, [
    store,
    options.plane,
    options.generation,
    enabled,
  ]);

  // ==========================================================
  // 11 — REPORT A COMPLETED FRAME
  // ==========================================================

  const recordFrame = useCallback(
    (sample: ViewportRenderSample): boolean => {
      if (!enabled) {
        return false;
      }

      const current = identityRef.current;

      if (
        current.plane !== sample.plane ||
        current.generation !==
          sample.generation ||
        current.plane !== options.plane ||
        current.generation !==
          options.generation
      ) {
        return false;
      }

      const now = readTelemetryClock();

      if (
        now === null ||
        sample.completedAtMs > now ||
        now - sample.completedAtMs >
          normalizeTelemetryStaleAfter(
            options.staleAfterMs,
          )
      ) {
        return false;
      }

      const accepted = store.record(sample);

      if (accepted) {
        setSnapshot(store.snapshot(now));
      }

      return accepted;
    },
    [
      enabled,
      store,
      options.plane,
      options.generation,
      options.staleAfterMs,
    ],
  );

  // ==========================================================
  // 12 — EXPLICIT SNAPSHOT REFRESH
  // ==========================================================

  const refresh = useCallback((): void => {
    const now = readTelemetryClock();

    setSnapshot(store.snapshot(now ?? -1));
  }, [store]);

  const clear = useCallback((): void => {
    store.clear();

    const now = readTelemetryClock();

    setSnapshot(store.snapshot(now ?? -1));
  }, [store]);

  return {
    snapshot,
    recordFrame,
    refresh,
    clear,
  };
}

// ============================================================
// 13 — CAPABILITIES
// ============================================================

export function getViewportRenderTelemetryCapabilities() {
  return {
    axialSupport: true,
    coronalSupport: true,
    sagittalSupport: true,
    localOnly: true,
    boundedSampleHistory: true,
    monotonicTimestamps: true,
    completedFrameMeasurements: true,
    fpsCalculation: true,
    averageRenderDuration: true,
    latestRenderDuration: true,
    invalidSampleRejection: true,
    outOfOrderSampleRejection: true,
    generationIsolation: true,
    staleSampleRejection: true,
    explicitRefresh: true,
    explicitClear: true,
    stableRecordCallback: true,
    ReactHookSupport: true,
    automaticPolling: false,
    networkTelemetry: false,
    patientMetadataStorage: false,
    browserPersistence: false,
    directDICOMAccess: false,
    sourceDatasetModification: false,
    clinicalValidationComplete: false,
  } as const;
}

// ============================================================
// END OF SINUS VIEWER VIEWPORT RENDER TELEMETRY — FILE 112
// ============================================================
