
/**
 * SINUS VIEWER — REUSABLE PROGRESS BAR
 * ====================================
 *
 * Presentation-only linear progress component.
 *
 * Features:
 * - Determinate progress (0 to 100 percent).
 * - Indeterminate progress.
 * - Predefined non-identifying loading stages.
 * - Optional stage sequence visualization.
 * - Compact and normal layouts.
 * - Optional cancellation callback.
 * - Accessible progress information.
 * - Reduced-motion CSS support.
 * - Explicit completed and error states.
 *
 * Security:
 * - No direct API requests.
 * - No source DICOM filesystem operations.
 * - No logging of patient data.
 * - No browser persistence.
 * - No arbitrary backend errors displayed.
 *
 * The parent application owns progress,
 * cancellation and authorization.
 */

import {
  useCallback,
  type CSSProperties,
} from "react";


// ============================================================
// 01 — PUBLIC TYPES
// ============================================================

export type ProgressBarStage =
  | "idle"
  | "discovering"
  | "validating"
  | "downloading"
  | "decoding"
  | "building-volume"
  | "generating-previews"
  | "rendering"
  | "complete"
  | "cancelled"
  | "error";

export type ProgressBarSize =
  | "compact"
  | "normal";

export type ProgressBarTone =
  | "default"
  | "success"
  | "warning"
  | "error";

export interface ProgressBarProps {
  readonly stage?: ProgressBarStage;

  /**
   * Finite percentage between 0 and 100.
   *
   * Null/undefined means indeterminate while active.
   * No progress percentage is fabricated.
   */
  readonly progress?: number | null;

  readonly size?: ProgressBarSize;
  readonly tone?: ProgressBarTone;

  readonly showPercentage?: boolean;
  readonly showStage?: boolean;

  /**
   * Optional ordered stages for a multistep workflow.
   */
  readonly stages?: readonly ProgressBarStage[];

  readonly cancellable?: boolean;
  readonly cancelling?: boolean;

  readonly disabled?: boolean;

  readonly onCancel?: () => void;

  readonly className?: string;
}


// ============================================================
// 02 — CONSTANTS
// ============================================================

export const PROGRESS_BAR_MAX = 100;

export const PROGRESS_BAR_COMPACT_HEIGHT = 6;

export const PROGRESS_BAR_NORMAL_HEIGHT = 9;

export const PROGRESS_BAR_MAX_STAGES = 12;


// ============================================================
// 03 — PREDEFINED STAGE LABELS
// ============================================================

export const PROGRESS_STAGE_LABELS: Readonly<
  Record<ProgressBarStage, string>
> = {
  idle: "Waiting",

  discovering: "Discovering datasets",

  validating: "Validating imaging series",

  downloading: "Loading image data",

  decoding: "Decoding medical images",

  "building-volume": "Preparing volume",

  "generating-previews": "Generating previews",

  rendering: "Rendering images",

  complete: "Complete",

  cancelled: "Cancelled",

  error: "Operation unsuccessful",
};


// ============================================================
// 04 — SAFE VALIDATION HELPERS
// ============================================================

export function normalizeProgressBarValue(
  value: number | null | undefined,
): number | null {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value)
  ) {
    return null;
  }

  return Math.min(
    PROGRESS_BAR_MAX,
    Math.max(0, value),
  );
}

export function formatProgressBarPercentage(
  value: number | null | undefined,
): string {
  const normalized = normalizeProgressBarValue(
    value,
  );

  if (normalized === null) {
    return "In progress";
  }

  return `${Math.round(normalized)}%`;
}

function isActiveStage(
  stage: ProgressBarStage,
): boolean {
  return (
    stage !== "idle" &&
    stage !== "complete" &&
    stage !== "cancelled" &&
    stage !== "error"
  );
}

function resolveProgressTone(
  stage: ProgressBarStage,
  tone: ProgressBarTone,
): ProgressBarTone {
  if (stage === "error") {
    return "error";
  }

  if (stage === "complete") {
    return "success";
  }

  if (stage === "cancelled") {
    return "warning";
  }

  return tone;
}

function toneColor(
  tone: ProgressBarTone,
): string {
  switch (tone) {
    case "success":
      return "#34d399";

    case "warning":
      return "#fbbf24";

    case "error":
      return "#f87171";

    case "default":
      return "#38bdf8";
  }
}


// ============================================================
// 05 — STAGE PROGRESSION
// ============================================================

export type ProgressStageState =
  | "completed"
  | "current"
  | "upcoming";

/**
 * Only the stage order supplied by the parent
 * is used. Skipped stage names are not inferred.
 */
export function getProgressStageState(
  item: ProgressBarStage,
  active: ProgressBarStage,
  stages: readonly ProgressBarStage[],
): ProgressStageState {
  const activeIndex = stages.indexOf(active);
  const itemIndex = stages.indexOf(item);

  if (
    activeIndex < 0 ||
    itemIndex < 0
  ) {
    return "upcoming";
  }

  if (itemIndex < activeIndex) {
    return "completed";
  }

  if (itemIndex === activeIndex) {
    return "current";
  }

  return "upcoming";
}


// ============================================================
// 06 — PRESENTATION STYLES
// ============================================================

const rootStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 9,
  width: "100%",
  minWidth: 0,
  boxSizing: "border-box",
  color: "#e2e8f0",
};

const headerStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  flexWrap: "wrap",
  gap: 8,
};

const trackStyle: CSSProperties = {
  position: "relative",
  width: "100%",
  overflow: "hidden",
  backgroundColor: "#263244",
  borderRadius: 999,
};

const fillStyle: CSSProperties = {
  height: "100%",
  borderRadius: 999,
  transition: "width 150ms ease-out",
};

const labelStyle: CSSProperties = {
  fontSize: 12,
  color: "#cbd5e1",
  fontWeight: 600,
};

const secondaryStyle: CSSProperties = {
  fontSize: 11,
  color: "#94a3b8",
  fontVariantNumeric: "tabular-nums",
};

const buttonStyle: CSSProperties = {
  padding: "5px 9px",
  minHeight: 30,
  backgroundColor: "#192437",
  border: "1px solid #344258",
  color: "#e2e8f0",
  borderRadius: 5,
  fontSize: 11,
  fontWeight: 600,
  cursor: "pointer",
};


// ============================================================
// 07 — REDUCED MOTION
// ============================================================

const PROGRESS_ANIMATION_CSS = `
  @keyframes sinus-viewer-progress-slide {
    0% {
      transform: translateX(-110%);
    }
    100% {
      transform: translateX(310%);
    }
  }

  .sinus-viewer-progress-indeterminate {
    position: absolute;
    width: 28%;
    left: 0;
    top: 0;
    height: 100%;
    animation: sinus-viewer-progress-slide 1.5s
      ease-in-out infinite;
  }

  @media (prefers-reduced-motion: reduce) {
    .sinus-viewer-progress-indeterminate {
      animation: none !important;
      transform: translateX(0);
    }

    .sinus-viewer-progress-determinate {
      transition: none !important;
    }
  }
`;


// ============================================================
// 08 — STAGE INDICATOR
// ============================================================

interface StageIndicatorProps {
  readonly stage: ProgressBarStage;
  readonly state: ProgressStageState;
  readonly color: string;
}

function StageIndicator({
  stage,
  state,
  color,
}: StageIndicatorProps) {
  const marked =
    state === "completed" ||
    state === "current";

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 5,
        flex: "1 1 85px",
        minWidth: 0,
      }}
      data-progress-stage={stage}
      data-progress-stage-state={state}
    >
      <span
        aria-hidden="true"
        style={{
          width: 8,
          height: 8,
          borderRadius: "50%",
          backgroundColor: marked
            ? color
            : "#475569",
          border:
            state === "current"
              ? "1px solid #f8fafc"
              : "1px solid transparent",
        }}
      />

      <span
        style={{
          fontSize: 10,
          textAlign: "center",
          lineHeight: 1.4,
          color: marked
            ? "#e2e8f0"
            : "#94a3b8",
        }}
        aria-current={
          state === "current"
            ? "step"
            : undefined
        }
      >
        {PROGRESS_STAGE_LABELS[stage]}
      </span>
    </div>
  );
}


// ============================================================
// 09 — MAIN PROGRESS BAR
// ============================================================

export function ProgressBar({
  stage = "idle",
  progress = null,
  size = "normal",
  tone = "default",
  showPercentage = true,
  showStage = true,
  stages,
  cancellable = false,
  cancelling = false,
  disabled = false,
  onCancel,
  className = "",
}: ProgressBarProps) {
  const isActive = isActiveStage(stage);

  const rawProgress = normalizeProgressBarValue(
    progress,
  );

  /**
   * Completed stages display 100%.
   * Cancelled/error stages display only their
   * last actual supplied progress, if available.
   */
  const normalizedProgress =
    stage === "complete"
      ? PROGRESS_BAR_MAX
      : rawProgress;

  const indeterminate =
    isActive &&
    normalizedProgress === null;

  const resolvedTone = resolveProgressTone(
    stage,
    tone,
  );

  const color = toneColor(
    resolvedTone,
  );

  const progressText =
    stage === "complete"
      ? "100%"
      : stage === "idle" &&
          normalizedProgress === null
        ? "Not started"
        : formatProgressBarPercentage(
            normalizedProgress,
          );

  const canCancel =
    isActive &&
    cancellable &&
    !disabled &&
    !cancelling &&
    typeof onCancel === "function";

  const height =
    size === "compact"
      ? PROGRESS_BAR_COMPACT_HEIGHT
      : PROGRESS_BAR_NORMAL_HEIGHT;

  const visibleStages =
    stages?.slice(0, PROGRESS_BAR_MAX_STAGES) ?? [];

  // ==========================================================
  // 10 — CANCEL CALLBACK
  // ==========================================================

  const handleCancel = useCallback((): void => {
    if (canCancel) {
      onCancel?.();
    }
  }, [canCancel, onCancel]);

  // ==========================================================
  // 11 — ACCESSIBILITY
  // ==========================================================

  const currentStageLabel =
    PROGRESS_STAGE_LABELS[stage];

  const accessibleStatus =
    `${currentStageLabel}. ${progressText}.`;

  // ==========================================================
  // 12 — JSX
  // ==========================================================

  return (
    <section
      className={className}
      style={rootStyle}
      aria-label="Operation progress"
      data-progress-bar="true"
      data-progress-stage={stage}
      data-progress-indeterminate={
        indeterminate ? "true" : "false"
      }
    >
      <style>{PROGRESS_ANIMATION_CSS}</style>

      {(showStage ||
        showPercentage ||
        cancellable) && (
        <div style={headerStyle}>
          {showStage && (
            <strong style={labelStyle}>
              {cancelling
                ? "Cancelling operation"
                : currentStageLabel}
            </strong>
          )}

          <div
            style={{
              display: "flex",
              alignItems: "center",
              flexWrap: "wrap",
              gap: 8,
            }}
          >
            {showPercentage && (
              <span style={secondaryStyle}>
                {progressText}
              </span>
            )}

            {cancellable && onCancel && (
              <button
                type="button"
                style={{
                  ...buttonStyle,
                  opacity: canCancel ? 1 : 0.55,
                  cursor: canCancel
                    ? "pointer"
                    : "not-allowed",
                }}
                disabled={!canCancel}
                onClick={handleCancel}
                aria-label="Cancel current operation"
              >
                {cancelling
                  ? "Cancelling…"
                  : "Cancel"}
              </button>
            )}
          </div>
        </div>
      )}

      <div
        style={{
          ...trackStyle,
          height,
        }}
        role="progressbar"
        aria-label={currentStageLabel}
        aria-valuemin={0}
        aria-valuemax={PROGRESS_BAR_MAX}
        aria-valuenow={
          indeterminate
            ? undefined
            : normalizedProgress ?? 0
        }
        aria-valuetext={
          indeterminate
            ? "In progress"
            : progressText
        }
      >
        {indeterminate ? (
          <div
            className="sinus-viewer-progress-indeterminate"
            style={{
              backgroundColor: color,
              borderRadius: 999,
            }}
          />
        ) : (
          <div
            className="sinus-viewer-progress-determinate"
            style={{
              ...fillStyle,
              width: `${
                normalizedProgress ?? 0
              }%`,
              backgroundColor: color,
            }}
          />
        )}
      </div>

      {visibleStages.length > 0 && (
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            flexWrap: "wrap",
            gap: 6,
            paddingTop: 3,
          }}
          aria-label="Operation stages"
        >
          {visibleStages.map(
            (item, index) => (
              <StageIndicator
                key={`${item}-${index}`}
                stage={item}
                state={getProgressStageState(
                  item,
                  stage,
                  visibleStages,
                )}
                color={color}
              />
            ),
          )}
        </div>
      )}

      <span
        role="status"
        aria-live="polite"
        style={{
          position: "absolute",
          width: 1,
          height: 1,
          padding: 0,
          margin: -1,
          overflow: "hidden",
          clip: "rect(0, 0, 0, 0)",
          whiteSpace: "nowrap",
          border: 0,
        }}
      >
        {accessibleStatus}
      </span>
    </section>
  );
}


// ============================================================
// 13 — COMPONENT CAPABILITIES
// ============================================================

export function getProgressBarCapabilities() {
  return {
    determinateProgress: true,
    indeterminateProgress: true,
    progressValueClamping: true,
    stageLabels: true,
    stageSequence: true,
    compactLayout: true,
    completedState: true,
    cancelledState: true,
    errorState: true,
    reducedMotionSupport: true,
    accessibleProgressReporting: true,
    cancellationCallback: true,
    parentOwnedProgress: true,
    artificialProgressGeneration: false,
    directBackendRequests: false,
    browserPersistence: false,
    sourceDatasetModification: false,
  } as const;
}


// ============================================================
// END OF SINUS VIEWER PROGRESS BAR
// ============================================================
