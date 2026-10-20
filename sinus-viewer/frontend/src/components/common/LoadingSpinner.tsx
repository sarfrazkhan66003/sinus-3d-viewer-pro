
/**
 * SINUS VIEWER — REUSABLE LOADING SPINNER
 * =======================================
 *
 * Presentation-only component for application loading.
 *
 * Features:
 * - Animated circular spinner.
 * - Determinate percentage progress.
 * - Indeterminate progress.
 * - Inline, panel and overlay layouts.
 * - Small, medium and large sizes.
 * - Optional cancellation button.
 * - Accessible screen-reader announcements.
 * - Reduced-motion accessibility support.
 * - Safe, predefined status messages.
 *
 * SECURITY:
 * - No network requests.
 * - No filesystem operations.
 * - No localStorage/sessionStorage.
 * - No patient names or DICOM identifiers.
 * - No raw backend error messages.
 * - No modification of medical image data.
 *
 * This component does not manage asynchronous tasks.
 * The parent controls loading and cancellation.
 */

import {
  useCallback,
  useId,
  type CSSProperties,
} from "react";


// ============================================================
// 01 — PUBLIC TYPES
// ============================================================

export type LoadingSpinnerSize =
  | "small"
  | "medium"
  | "large";

export type LoadingSpinnerMode =
  | "inline"
  | "panel"
  | "overlay";

export type LoadingSpinnerTask =
  | "generic"
  | "datasets"
  | "series"
  | "previews"
  | "volume"
  | "rendering";

export interface LoadingSpinnerProps {
  readonly task?: LoadingSpinnerTask;

  readonly size?: LoadingSpinnerSize;

  readonly mode?: LoadingSpinnerMode;

  /**
   * Null or undefined means indeterminate.
   * Other finite values are clamped to 0..100.
   */
  readonly progress?: number | null;

  readonly visible?: boolean;

  readonly cancellable?: boolean;

  readonly cancelling?: boolean;

  readonly onCancel?: () => void;

  readonly compact?: boolean;

  readonly className?: string;

  /**
   * Static presentation only.
   * Not tied to the real operation's lifecycle.
   */
  readonly showProgressText?: boolean;
}


// ============================================================
// 02 — CONSTANTS
// ============================================================

export const LOADING_SPINNER_PROGRESS_MAX = 100;

export const LOADING_SPINNER_SIZES = {
  small: 18,
  medium: 32,
  large: 48,
} as const;

export const LOADING_SPINNER_STROKE_WIDTH = 3;


// ============================================================
// 03 — TASK LABELS
// ============================================================

function loadingTaskLabel(
  task: LoadingSpinnerTask,
): string {
  switch (task) {
    case "datasets":
      return "Loading authorized datasets";

    case "series":
      return "Preparing imaging series";

    case "previews":
      return "Loading image previews";

    case "volume":
      return "Loading CT/CBCT volume";

    case "rendering":
      return "Rendering multiplanar images";

    case "generic":
    default:
      return "Loading";
  }
}


// ============================================================
// 04 — PROGRESS VALIDATION
// ============================================================

export function normalizeLoadingProgress(
  progress: number | null | undefined,
): number | null {
  if (
    typeof progress !== "number" ||
    !Number.isFinite(progress)
  ) {
    return null;
  }

  return Math.min(
    LOADING_SPINNER_PROGRESS_MAX,
    Math.max(0, progress),
  );
}

function progressLabel(
  progress: number | null,
): string {
  if (progress === null) {
    return "In progress";
  }

  return `${Math.round(progress)}%`;
}


// ============================================================
// 05 — PRESENTATION STYLES
// ============================================================

const baseStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 12,
  minWidth: 0,
  boxSizing: "border-box",
  color: "#e2e8f0",
};

const panelStyle: CSSProperties = {
  ...baseStyle,
  flexDirection: "column",
  padding: 20,
  minHeight: 150,
  width: "100%",
  backgroundColor: "#101827",
  border: "1px solid #263244",
  borderRadius: 8,
};

const overlayStyle: CSSProperties = {
  ...baseStyle,
  position: "absolute",
  inset: 0,
  zIndex: 30,
  flexDirection: "column",
  padding: 20,
  backgroundColor: "rgba(8, 13, 22, 0.92)",
};

const inlineStyle: CSSProperties = {
  ...baseStyle,
  justifyContent: "flex-start",
};

const labelStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  lineHeight: 1.5,
  textAlign: "center",
};

const secondaryStyle: CSSProperties = {
  fontSize: 11,
  color: "#94a3b8",
  fontVariantNumeric: "tabular-nums",
  textAlign: "center",
};

const cancelButtonStyle: CSSProperties = {
  padding: "7px 12px",
  minHeight: 32,
  borderRadius: 5,
  border: "1px solid #344258",
  backgroundColor: "#192437",
  color: "#f8fafc",
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
};


// ============================================================
// 06 — STATIC ANIMATION STYLES
// ============================================================

/**
 * Reduced-motion support is handled by CSS.
 * The spinner stays visible without rotation when
 * the operating system requests reduced motion.
 *
 * Styles contain only static application-owned CSS.
 */
const ANIMATION_CSS = `
  @keyframes sinus-viewer-spinner-rotate {
    from { transform: rotate(0deg); }
    to   { transform: rotate(360deg); }
  }

  .sinus-viewer-loading-rotor {
    transform-origin: center;
    animation: sinus-viewer-spinner-rotate 1s linear infinite;
  }

  @media (prefers-reduced-motion: reduce) {
    .sinus-viewer-loading-rotor {
      animation: none !important;
    }
  }
`;


// ============================================================
// 07 — SPINNER SVG
// ============================================================

interface SpinnerGraphicProps {
  readonly size: LoadingSpinnerSize;
}

function SpinnerGraphic({
  size,
}: SpinnerGraphicProps) {
  const diameter = LOADING_SPINNER_SIZES[size];

  return (
    <svg
      className="sinus-viewer-loading-rotor"
      width={diameter}
      height={diameter}
      viewBox="0 0 48 48"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      focusable="false"
      style={{
        display: "block",
        flexShrink: 0,
      }}
    >
      <circle
        cx="24"
        cy="24"
        r="19"
        stroke="#334155"
        strokeWidth={LOADING_SPINNER_STROKE_WIDTH}
      />

      <path
        d="M 24 5 A 19 19 0 0 1 43 24"
        stroke="#38bdf8"
        strokeWidth={LOADING_SPINNER_STROKE_WIDTH}
        strokeLinecap="round"
      />
    </svg>
  );
}


// ============================================================
// 08 — MAIN COMPONENT
// ============================================================

export function LoadingSpinner({
  task = "generic",
  size = "medium",
  mode = "inline",
  progress = null,
  visible = true,
  cancellable = false,
  cancelling = false,
  onCancel,
  compact = false,
  className = "",
  showProgressText = true,
}: LoadingSpinnerProps) {
  const id = useId();

  const normalizedProgress =
    normalizeLoadingProgress(progress);

  const taskLabel = loadingTaskLabel(task);

  const progressText =
    progressLabel(normalizedProgress);

  const canCancel =
    cancellable &&
    typeof onCancel === "function" &&
    !cancelling;

  // ==========================================================
  // 09 — CANCEL ACTION
  // ==========================================================

  const handleCancel = useCallback((): void => {
    if (canCancel) {
      onCancel?.();
    }
  }, [canCancel, onCancel]);

  // ==========================================================
  // 10 — VISIBILITY
  // ==========================================================

  if (!visible) {
    return null;
  }

  // ==========================================================
  // 11 — LAYOUT
  // ==========================================================

  const layoutStyle: CSSProperties =
    mode === "overlay"
      ? overlayStyle
      : mode === "panel"
        ? panelStyle
        : inlineStyle;

  const isInline = mode === "inline";

  const description =
    cancelling
      ? "Cancelling operation"
      : normalizedProgress === null
        ? `${taskLabel}. In progress.`
        : `${taskLabel}. ${progressText} complete.`;

  // ==========================================================
  // 12 — JSX
  // ==========================================================

  return (
    <div
      className={className}
      style={{
        ...layoutStyle,
        padding: compact
          ? isInline
            ? 0
            : 10
          : layoutStyle.padding,
        gap: compact ? 7 : 12,
      }}
      role="status"
      aria-live="polite"
      aria-busy="true"
      aria-label={description}
      data-loading-spinner="true"
      data-loading-task={task}
      data-loading-mode={mode}
      data-loading-indeterminate={
        normalizedProgress === null
          ? "true"
          : "false"
      }
    >
      <style>{ANIMATION_CSS}</style>

      <SpinnerGraphic
        size={size}
      />

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: isInline
            ? "flex-start"
            : "center",
          gap: 5,
          minWidth: 0,
        }}
      >
        <strong
          id={`${id}-label`}
          style={{
            ...labelStyle,
            textAlign: isInline
              ? "left"
              : "center",
          }}
        >
          {cancelling
            ? "Cancelling…"
            : taskLabel}
        </strong>

        {showProgressText && (
          <span style={secondaryStyle}>
            {progressText}
          </span>
        )}
      </div>

      {normalizedProgress !== null && (
        <progress
          max={LOADING_SPINNER_PROGRESS_MAX}
          value={normalizedProgress}
          aria-label={`${taskLabel} progress`}
          aria-describedby={`${id}-label`}
          style={{
            width: compact ? 75 : 110,
            height: 9,
            accentColor: "#38bdf8",
            flexShrink: 0,
          }}
        />
      )}

      {cancellable && onCancel && (
        <button
          type="button"
          disabled={!canCancel}
          onClick={handleCancel}
          style={{
            ...cancelButtonStyle,
            opacity: canCancel ? 1 : 0.55,
            cursor: canCancel
              ? "pointer"
              : "not-allowed",
          }}
          aria-label={
            cancelling
              ? "Cancellation in progress"
              : "Cancel loading operation"
          }
        >
          {cancelling
            ? "Cancelling…"
            : "Cancel"}
        </button>
      )}
    </div>
  );
}


// ============================================================
// 13 — COMPONENT CAPABILITIES
// ============================================================

export function getLoadingSpinnerCapabilities() {
  return {
    circularSpinner: true,
    determinateProgress: true,
    indeterminateProgress: true,
    inlineLayout: true,
    panelLayout: true,
    overlayLayout: true,
    compactLayout: true,
    reducedMotionSupport: true,
    accessibleStatus: true,
    cancellationCallback: true,
    parentOwnedLoadingState: true,
    backendPolling: false,
    networkRequests: false,
    browserPersistence: false,
    displaysPatientMetadata: false,
    modifiesSourceDICOM: false,
  } as const;
}


// ============================================================
// END OF SINUS VIEWER LOADING SPINNER
// ============================================================
