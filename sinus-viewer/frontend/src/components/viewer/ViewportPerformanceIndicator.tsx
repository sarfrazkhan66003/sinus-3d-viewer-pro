
/**
 * SINUS VIEWER — VIEWPORT PERFORMANCE INDICATOR
 * ==============================================
 *
 * Optional display-only performance diagnostics
 * for a single MPR viewport.
 *
 * Metrics supplied by the parent:
 * - Frame rate (FPS)
 * - Frame/render duration in milliseconds
 * - Optional last render duration
 * - Measurement freshness
 * - Current renderer activity
 *
 * Rules:
 * - Never invent FPS or render measurements.
 * - Do not show stale samples as current.
 * - Do not inspect GPU, CPU, device identifiers.
 * - Do not include patient, volume or file IDs.
 * - Do not send metrics to a network endpoint.
 * - No automatic polling or browser persistence.
 *
 * Performance thresholds are UI heuristics,
 * NOT clinical or diagnostic validity criteria.
 */

import {
  useMemo,
  type CSSProperties,
} from "react";

// ============================================================
// 01 — TYPES
// ============================================================

export type PerformanceIndicatorPlane =
  | "axial"
  | "coronal"
  | "sagittal";

export type ViewportRendererActivity =
  | "idle"
  | "rendering"
  | "ready"
  | "unavailable";

export type ViewportPerformanceQuality =
  | "good"
  | "moderate"
  | "slow"
  | "unknown";

export type ViewportPerformancePlacement =
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right";

export interface ViewportPerformanceMetrics {
  /**
   * Parent-measured frames rendered per second.
   */
  readonly fps?: number | null;

  /**
   * Parent-measured frame duration, milliseconds.
   */
  readonly frameTimeMs?: number | null;

  /**
   * Most recent completed render duration.
   */
  readonly lastRenderMs?: number | null;

  /**
   * True only if the parent has checked the
   * freshness of the measurement samples.
   *
   * In particular, stopped rendering must not
   * leave an old FPS labeled as current.
   */
  readonly samplesFresh: boolean;

  readonly activity: ViewportRendererActivity;
}

export interface ViewportPerformanceIndicatorProps {
  readonly plane: PerformanceIndicatorPlane;
  readonly metrics: ViewportPerformanceMetrics | null;

  readonly visible?: boolean;
  readonly compact?: boolean;

  readonly showFPS?: boolean;
  readonly showFrameTime?: boolean;
  readonly showLastRender?: boolean;
  readonly showQuality?: boolean;

  readonly placement?: ViewportPerformancePlacement;
  readonly className?: string;
}

export interface ViewportPerformanceDisplay {
  readonly activity: ViewportRendererActivity;
  readonly quality: ViewportPerformanceQuality;
  readonly fpsLabel: string | null;
  readonly frameTimeLabel: string | null;
  readonly lastRenderLabel: string | null;
  readonly statusLabel: string;
  readonly hasMeasuredValue: boolean;
}

// ============================================================
// 02 — CONSTANTS
// ============================================================

export const PERFORMANCE_MAX_FPS = 1000;
export const PERFORMANCE_MAX_DURATION_MS = 600000;

export const PERFORMANCE_GOOD_FPS_THRESHOLD = 30;
export const PERFORMANCE_MODERATE_FPS_THRESHOLD = 15;

export const PERFORMANCE_GOOD_FRAME_MS = 33.4;
export const PERFORMANCE_MODERATE_FRAME_MS = 66.7;

const QUALITY_LABELS: Readonly<
  Record<ViewportPerformanceQuality, string>
> = {
  good: "Responsive",
  moderate: "Moderate",
  slow: "Slow",
  unknown: "Not measured",
};

const ACTIVITY_LABELS: Readonly<
  Record<ViewportRendererActivity, string>
> = {
  idle: "Idle",
  rendering: "Rendering",
  ready: "Ready",
  unavailable: "Unavailable",
};

// ============================================================
// 03 — VALIDATION
// ============================================================

export function isValidPerformanceFPS(
  value: number | null | undefined,
): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value > 0 &&
    value <= PERFORMANCE_MAX_FPS
  );
}

export function isValidPerformanceDuration(
  value: number | null | undefined,
): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= PERFORMANCE_MAX_DURATION_MS
  );
}

export function isViewportRendererActivity(
  value: unknown,
): value is ViewportRendererActivity {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(
      ACTIVITY_LABELS,
      value,
    )
  );
}

// ============================================================
// 04 — QUALITY ESTIMATION
// ============================================================

/**
 * This is a UI responsiveness estimate.
 *
 * FPS and frame-time thresholds do not indicate
 * whether an image reconstruction is accurate.
 */
export function classifyViewportPerformance(
  fps: number | null,
  frameTimeMs: number | null,
): ViewportPerformanceQuality {
  const hasFPS = isValidPerformanceFPS(fps);
  const hasFrameTime =
    isValidPerformanceDuration(frameTimeMs);

  if (!hasFPS && !hasFrameTime) {
    return "unknown";
  }

  const fpsQuality: ViewportPerformanceQuality =
    !hasFPS
      ? "unknown"
      : fps >= PERFORMANCE_GOOD_FPS_THRESHOLD
        ? "good"
        : fps >= PERFORMANCE_MODERATE_FPS_THRESHOLD
          ? "moderate"
          : "slow";

  const frameQuality: ViewportPerformanceQuality =
    !hasFrameTime
      ? "unknown"
      : frameTimeMs <= PERFORMANCE_GOOD_FRAME_MS
        ? "good"
        : frameTimeMs <= PERFORMANCE_MODERATE_FRAME_MS
          ? "moderate"
          : "slow";

  /**
   * If two independent samples disagree, report
   * the poorer quality to avoid overstating
   * responsiveness.
   */
  if (
    fpsQuality === "slow" ||
    frameQuality === "slow"
  ) {
    return "slow";
  }

  if (
    fpsQuality === "moderate" ||
    frameQuality === "moderate"
  ) {
    return "moderate";
  }

  return "good";
}

// ============================================================
// 05 — DISPLAY MODEL
// ============================================================

export function buildViewportPerformanceDisplay(
  metrics: ViewportPerformanceMetrics | null,
): ViewportPerformanceDisplay {
  const activity =
    metrics &&
    isViewportRendererActivity(metrics.activity)
      ? metrics.activity
      : "unavailable";

  const fresh =
    metrics?.samplesFresh === true &&
    (
      activity === "rendering" ||
      activity === "ready"
    );

  const fps =
    fresh && isValidPerformanceFPS(metrics?.fps)
      ? metrics!.fps!
      : null;

  const frameTime =
    fresh &&
    isValidPerformanceDuration(
      metrics?.frameTimeMs,
    )
      ? metrics!.frameTimeMs!
      : null;

  const lastRender =
    fresh &&
    isValidPerformanceDuration(
      metrics?.lastRenderMs,
    )
      ? metrics!.lastRenderMs!
      : null;

  const quality = fresh
    ? classifyViewportPerformance(
        fps,
        frameTime,
      )
    : "unknown";

  const fpsLabel =
    fps !== null
      ? `${fps.toFixed(1)} FPS`
      : null;

  const frameTimeLabel =
    frameTime !== null
      ? `${frameTime.toFixed(1)} ms/frame`
      : null;

  const lastRenderLabel =
    lastRender !== null
      ? `${lastRender.toFixed(1)} ms`
      : null;

  return {
    activity,
    quality,
    fpsLabel,
    frameTimeLabel,
    lastRenderLabel,
    statusLabel: ACTIVITY_LABELS[activity],
    hasMeasuredValue:
      fps !== null ||
      frameTime !== null ||
      lastRender !== null,
  };
}

// ============================================================
// 06 — COLORS / PLACEMENT
// ============================================================

const QUALITY_COLORS: Readonly<
  Record<ViewportPerformanceQuality, string>
> = {
  good: "#34d399",
  moderate: "#fbbf24",
  slow: "#fb7185",
  unknown: "#94a3b8",
};

function performancePlacementStyle(
  placement: ViewportPerformancePlacement,
): CSSProperties {
  switch (placement) {
    case "top-left":
      return { top: 10, left: 10 };

    case "top-right":
      return { top: 10, right: 10 };

    case "bottom-left":
      return { bottom: 10, left: 10 };

    case "bottom-right":
      return { bottom: 10, right: 10 };
  }
}

export function performancePlaneLabel(
  plane: PerformanceIndicatorPlane,
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
// 07 — STYLES
// ============================================================

const rootStyle: CSSProperties = {
  position: "absolute",
  zIndex: 17,
  display: "flex",
  flexDirection: "column",
  gap: 5,
  maxWidth: "calc(100% - 20px)",
  padding: "7px 9px",
  border: "1px solid rgba(148,163,184,0.24)",
  borderRadius: 6,
  backgroundColor: "rgba(8,17,30,0.89)",
  color: "#e2e8f0",
  boxSizing: "border-box",
  pointerEvents: "none",
  userSelect: "none",
  fontVariantNumeric: "tabular-nums",
};

const rowStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "baseline",
  gap: 11,
};

const labelStyle: CSSProperties = {
  color: "#94a3b8",
  fontSize: 10,
};

const valueStyle: CSSProperties = {
  color: "#f8fafc",
  fontSize: 11,
  fontWeight: 600,
};

// ============================================================
// 08 — MAIN COMPONENT
// ============================================================

export function ViewportPerformanceIndicator({
  plane,
  metrics,
  visible = false,
  compact = false,
  showFPS = true,
  showFrameTime = true,
  showLastRender = true,
  showQuality = true,
  placement = "top-right",
  className = "",
}: ViewportPerformanceIndicatorProps) {
  const display = useMemo(
    () => buildViewportPerformanceDisplay(metrics),
    [
      metrics?.activity,
      metrics?.samplesFresh,
      metrics?.fps,
      metrics?.frameTimeMs,
      metrics?.lastRenderMs,
    ],
  );

  if (!visible) {
    return null;
  }

  const planeLabel =
    performancePlaneLabel(plane);

  const qualityLabel =
    QUALITY_LABELS[display.quality];

  return (
    <aside
      className={className}
      style={{
        ...rootStyle,
        ...performancePlacementStyle(placement),
        gap: compact ? 3 : 5,
        padding: compact ? "5px 7px" : "7px 9px",
      }}
      role="note"
      aria-label={`${planeLabel} rendering performance`}
      data-viewport-performance="true"
      data-performance-plane={plane}
      data-performance-quality={display.quality}
    >
      <div style={rowStyle}>
        <strong
          style={{
            fontSize: compact ? 10 : 11,
            color: "#e0f2fe",
          }}
        >
          {planeLabel} Performance
        </strong>
      </div>

      <div style={rowStyle}>
        <span style={labelStyle}>Renderer</span>
        <span style={valueStyle}>
          {display.statusLabel}
        </span>
      </div>

      {showQuality && (
        <div style={rowStyle}>
          <span style={labelStyle}>Responsiveness</span>
          <span
            style={{
              ...valueStyle,
              color: QUALITY_COLORS[display.quality],
            }}
          >
            {qualityLabel}
          </span>
        </div>
      )}

      {showFPS && display.fpsLabel !== null && (
        <div style={rowStyle}>
          <span style={labelStyle}>Frame rate</span>
          <span style={valueStyle}>
            {display.fpsLabel}
          </span>
        </div>
      )}

      {showFrameTime &&
        display.frameTimeLabel !== null && (
          <div style={rowStyle}>
            <span style={labelStyle}>Frame duration</span>
            <span style={valueStyle}>
              {display.frameTimeLabel}
            </span>
          </div>
        )}

      {showLastRender &&
        display.lastRenderLabel !== null && (
          <div style={rowStyle}>
            <span style={labelStyle}>Last render</span>
            <span style={valueStyle}>
              {display.lastRenderLabel}
            </span>
          </div>
        )}

      {!display.hasMeasuredValue && (
        <span
          style={{
            ...labelStyle,
            lineHeight: 1.5,
          }}
        >
          No current performance samples
        </span>
      )}
    </aside>
  );
}

// ============================================================
// 09 — CAPABILITIES
// ============================================================

export function getViewportPerformanceIndicatorCapabilities() {
  return {
    axialSupport: true,
    coronalSupport: true,
    sagittalSupport: true,
    optionalFPSDisplay: true,
    optionalFrameTimeDisplay: true,
    optionalLastRenderDisplay: true,
    parentSuppliedMetricsOnly: true,
    sampleFreshnessGate: true,
    invalidMetricRejection: true,
    allowlistedRendererStates: true,
    responsivenessClassification: true,
    responsiveCompactLayout: true,
    configurablePlacement: true,
    enabledByDefault: false,
    hardwareFingerprinting: false,
    automaticPolling: false,
    networkTelemetry: false,
    patientMetadataDisplay: false,
    browserPersistence: false,
    sourceDatasetModification: false,
    clinicalValidationComplete: false,
  } as const;
}

// ============================================================
// END OF SINUS VIEWER PERFORMANCE INDICATOR
// ============================================================
