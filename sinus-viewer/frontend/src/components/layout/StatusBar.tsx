
/**
 * SINUS VIEWER — APPLICATION STATUS BAR
 * =====================================
 *
 * Reusable, presentation-only status footer.
 *
 * Features:
 * - Backend connectivity indicator.
 * - Authentication state indicator.
 * - Active application page.
 * - Selected MPR plane.
 * - Volume loading progress.
 * - Viewer readiness indicator.
 * - Non-identifying status messages.
 * - Compact / responsive layout.
 * - Accessible progress announcements.
 *
 * Architecture:
 * - Parent owns backend health checks.
 * - Parent owns authentication.
 * - Parent owns volume loading.
 * - Parent owns MPR navigation.
 * - This component never starts requests.
 *
 * Privacy:
 * - No patient names, paths or DICOM UIDs.
 * - No arbitrary server error text.
 * - No browser persistence.
 * - No original DICOM dataset modification.
 *
 * Medical-image visualization requires validation.
 */

import {
  useMemo,
  type CSSProperties,
} from "react";

import type {
  PreviewPlane,
} from "../../types/api";

import type {
  AppShellPage,
  AppShellSessionStatus,
} from "./AppShell";


// ============================================================
// 01 — PUBLIC STATUS TYPES
// ============================================================

export type BackendConnectionStatus =
  | "unknown"
  | "checking"
  | "online"
  | "degraded"
  | "offline";

export type ViewerReadinessStatus =
  | "empty"
  | "loading"
  | "ready"
  | "error";

export type ApplicationActivityStatus =
  | "idle"
  | "loading-datasets"
  | "validating-series"
  | "loading-volume"
  | "rendering"
  | "ready"
  | "error";

export interface StatusBarProps {
  readonly page: AppShellPage;

  readonly sessionStatus: AppShellSessionStatus;

  readonly backendStatus?: BackendConnectionStatus;

  readonly viewerStatus?: ViewerReadinessStatus;

  readonly activity?: ApplicationActivityStatus;

  readonly activePlane?: PreviewPlane | null;

  /**
   * Loading percentage in the range 0..100.
   *
   * Null means indeterminate progress.
   * The parent must provide actual progress values;
   * this component never invents completion amounts.
   */
  readonly progressPercentage?: number | null;

  /**
   * Optional generic, predefined application message.
   *
   * Raw server errors and patient metadata must never
   * be supplied to this property.
   */
  readonly message?: string | null;

  readonly compact?: boolean;

  readonly className?: string;
}


// ============================================================
// 02 — CONSTANTS
// ============================================================

export const STATUS_BAR_MIN_HEIGHT = 34;

export const STATUS_BAR_MAX_MESSAGE_LENGTH = 160;

export const STATUS_BAR_PROGRESS_MAX = 100;


// ============================================================
// 03 — SAFE STATUS LABELS
// ============================================================

function pageLabel(
  page: AppShellPage,
): string {
  switch (page) {
    case "datasets":
      return "Dataset Browser";

    case "viewer":
      return "MPR Viewer";

    default:
      return "Workspace";
  }
}

function backendLabel(
  status: BackendConnectionStatus,
): string {
  switch (status) {
    case "online":
      return "Backend connected";

    case "degraded":
      return "Backend degraded";

    case "offline":
      return "Backend unavailable";

    case "checking":
      return "Checking backend";

    default:
      return "Backend status unknown";
  }
}

function backendColor(
  status: BackendConnectionStatus,
): string {
  switch (status) {
    case "online":
      return "#86efac";

    case "degraded":
      return "#fcd34d";

    case "offline":
      return "#fca5a5";

    case "checking":
      return "#93c5fd";

    default:
      return "#94a3b8";
  }
}

function sessionLabel(
  status: AppShellSessionStatus,
): string {
  return status === "authenticated"
    ? "Authenticated"
    : "Authentication required";
}

function planeLabel(
  plane: PreviewPlane | null,
): string {
  switch (plane) {
    case "axial":
      return "Axial";

    case "coronal":
      return "Coronal";

    case "sagittal":
      return "Sagittal";

    default:
      return "No active plane";
  }
}

function viewerLabel(
  status: ViewerReadinessStatus,
): string {
  switch (status) {
    case "empty":
      return "No volume loaded";

    case "loading":
      return "Loading volume";

    case "ready":
      return "Volume ready";

    case "error":
      return "Viewer unavailable";
  }
}

function activityLabel(
  status: ApplicationActivityStatus,
): string {
  switch (status) {
    case "loading-datasets":
      return "Loading datasets";

    case "validating-series":
      return "Validating series";

    case "loading-volume":
      return "Loading volume";

    case "rendering":
      return "Rendering image";

    case "ready":
      return "Ready";

    case "error":
      return "Operation unsuccessful";

    default:
      return "Idle";
  }
}


// ============================================================
// 04 — PROGRESS VALIDATION
// ============================================================

function normalizeProgress(
  value: number | null | undefined,
): number | null {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value)
  ) {
    return null;
  }

  return Math.min(
    STATUS_BAR_PROGRESS_MAX,
    Math.max(0, value),
  );
}


// ============================================================
// 05 — SAFE OPTIONAL MESSAGE
// ============================================================

/**
 * Deliberately allow only fixed, predefined messages.
 *
 * The parent should not pass raw backend exception
 * objects, original paths or untrusted metadata.
 *
 * Unsupported strings are not displayed.
 */
const ALLOWED_MESSAGES = [
  "Select an authorized imaging series.",
  "Preparing imaging series.",
  "Loading volume data.",
  "Rendering multiplanar images.",
  "Volume loaded successfully.",
  "Operation cancelled.",
  "Authentication is required.",
  "The requested operation was unsuccessful.",
  "Backend connection is unavailable.",
] as const;

function safeStatusMessage(
  value: string | null | undefined,
): string | null {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > STATUS_BAR_MAX_MESSAGE_LENGTH
  ) {
    return null;
  }

  return ALLOWED_MESSAGES.some(
    (allowed) => allowed === value,
  )
    ? value
    : null;
}


// ============================================================
// 06 — STYLES
// ============================================================

const rootStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  flexWrap: "wrap",
  gap: 9,
  minHeight: STATUS_BAR_MIN_HEIGHT,
  width: "100%",
  minWidth: 0,
  boxSizing: "border-box",
  padding: "7px 12px",
  backgroundColor: "#101827",
  borderTop: "1px solid #263244",
  color: "#cbd5e1",
  fontSize: 11,
};

const groupStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  flexWrap: "wrap",
  gap: 10,
  minWidth: 0,
};

const indicatorStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
};

const dividerStyle: CSSProperties = {
  color: "#475569",
  userSelect: "none",
};

const mutedStyle: CSSProperties = {
  color: "#94a3b8",
  fontSize: 11,
};

const progressStyle: CSSProperties = {
  width: 90,
  height: 8,
  accentColor: "#38bdf8",
};

const disclaimerStyle: CSSProperties = {
  ...mutedStyle,
  textAlign: "right",
};


// ============================================================
// 07 — STATUS INDICATOR
// ============================================================

interface StatusIndicatorProps {
  readonly text: string;
  readonly color: string;
}

function StatusIndicator({
  text,
  color,
}: StatusIndicatorProps) {
  return (
    <span style={indicatorStyle}>
      <span
        aria-hidden="true"
        style={{
          width: 7,
          height: 7,
          flexShrink: 0,
          borderRadius: "50%",
          backgroundColor: color,
        }}
      />

      <span>{text}</span>
    </span>
  );
}


// ============================================================
// 08 — MAIN STATUS BAR
// ============================================================

export function StatusBar({
  page,
  sessionStatus,
  backendStatus = "unknown",
  viewerStatus = "empty",
  activity = "idle",
  activePlane = null,
  progressPercentage = null,
  message = null,
  compact = false,
  className = "",
}: StatusBarProps) {
  const progress = normalizeProgress(
    progressPercentage,
  );

  const safeMessage = useMemo(
    () => safeStatusMessage(message),
    [message],
  );

  const authenticated =
    sessionStatus === "authenticated";

  /**
   * Progress can represent volume loading or another
   * explicit parent-supplied long-running operation.
   *
   * Never show a loading meter while status is idle.
   */
  const progressActive =
    activity === "loading-volume" ||
    activity === "loading-datasets" ||
    activity === "validating-series" ||
    activity === "rendering" ||
    viewerStatus === "loading";

  const progressText =
    progress === null
      ? "In progress"
      : `${Math.round(progress)}%`;

  const sessionColor = authenticated
    ? "#86efac"
    : "#fca5a5";

  const viewerColor =
    viewerStatus === "ready"
      ? "#86efac"
      : viewerStatus === "error"
        ? "#fca5a5"
        : viewerStatus === "loading"
          ? "#93c5fd"
          : "#94a3b8";

  // ==========================================================
  // 09 — JSX
  // ==========================================================

  return (
    <footer
      className={className}
      style={{
        ...rootStyle,
        padding: compact
          ? "6px 9px"
          : "7px 12px",
      }}
      data-status-bar="true"
      data-backend-status={backendStatus}
      data-viewer-status={viewerStatus}
      aria-label="Sinus Viewer application status"
    >
      <div style={groupStyle}>
        <strong style={{ color: "#f8fafc" }}>
          {pageLabel(page)}
        </strong>

        <span
          aria-hidden="true"
          style={dividerStyle}
        >
          |
        </span>

        <StatusIndicator
          text={backendLabel(backendStatus)}
          color={backendColor(backendStatus)}
        />

        {!compact && (
          <>
            <span
              aria-hidden="true"
              style={dividerStyle}
            >
              |
            </span>

            <StatusIndicator
              text={sessionLabel(sessionStatus)}
              color={sessionColor}
            />
          </>
        )}

        {page === "viewer" && (
          <>
            <span
              aria-hidden="true"
              style={dividerStyle}
            >
              |
            </span>

            <StatusIndicator
              text={viewerLabel(viewerStatus)}
              color={viewerColor}
            />

            {!compact && (
              <span style={mutedStyle}>
                {planeLabel(activePlane)}
              </span>
            )}
          </>
        )}

        {progressActive && (
          <span
            style={indicatorStyle}
            role="status"
            aria-live="polite"
            aria-label={
              `${activityLabel(activity)}: ${progressText}`
            }
          >
            <span style={mutedStyle}>
              {activityLabel(activity)}
            </span>

            {progress === null ? (
              <progress
                style={progressStyle}
                aria-label="Indeterminate operation progress"
              />
            ) : (
              <progress
                max={STATUS_BAR_PROGRESS_MAX}
                value={progress}
                style={progressStyle}
                aria-label="Operation progress"
              />
            )}

            <span
              style={{
                ...mutedStyle,
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {progressText}
            </span>
          </span>
        )}

        {safeMessage && (
          <span
            style={mutedStyle}
            role="status"
            aria-live="polite"
          >
            {safeMessage}
          </span>
        )}
      </div>

      <div style={disclaimerStyle}>
        Research visualization
        {!compact &&
          " • Clinical validation pending"}
      </div>
    </footer>
  );
}


// ============================================================
// 10 — CAPABILITIES
// ============================================================

export function getStatusBarCapabilities() {
  return {
    activePageDisplay: true,
    backendConnectionStatus: true,
    authenticationStatus: true,
    viewerReadinessStatus: true,
    activeMPRPlane: true,
    determinateProgress: true,
    indeterminateProgress: true,
    statusMessageAllowlist: true,
    compactLayout: true,
    accessibleStatusAnnouncements: true,
    backendPolling: false,
    directAuthenticationRequests: false,
    directVolumeRequests: false,
    browserPersistence: false,
    patientIdentifiersDisplayed: false,
    sourceDatasetModification: false,
    clinicalValidationComplete: false,
  } as const;
}


// ============================================================
// END OF SINUS VIEWER STATUS BAR
// ============================================================
