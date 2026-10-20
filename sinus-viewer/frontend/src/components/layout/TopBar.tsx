
/**
 * SINUS VIEWER — REUSABLE TOP BAR
 * ===============================
 *
 * Application header and navigation component.
 *
 * Features:
 * - Application branding.
 * - Dataset Browser navigation.
 * - MPR Viewer navigation.
 * - Preview panel toggle.
 * - Authenticated / expired session indicator.
 * - Viewer-ready status.
 * - Parent-controlled sign out.
 * - Compact layout support.
 * - Accessible buttons and status announcements.
 *
 * Security:
 * - Receives status and callbacks from parent.
 * - Never reads authentication cookies or tokens.
 * - Never renders patient names, UIDs or paths.
 * - No network requests or browser persistence.
 * - Does not access or modify DICOM data.
 *
 * Auth decisions must be enforced by the backend.
 */

import {
  useCallback,
  type CSSProperties,
} from "react";

import type {
  AppShellPage,
  AppShellSessionStatus,
} from "./AppShell";


// ============================================================
// 01 — PUBLIC TYPES
// ============================================================

export interface TopBarProps {
  readonly page: AppShellPage;
  readonly sessionStatus: AppShellSessionStatus;

  readonly viewerAvailable: boolean;
  readonly previewsVisible: boolean;

  readonly signingOut?: boolean;
  readonly compact?: boolean;
  readonly className?: string;

  readonly title?: string;
  readonly subtitle?: string;

  readonly onNavigateDatasets: () => void;
  readonly onNavigateViewer: () => void;
  readonly onTogglePreviews: () => void;
  readonly onSignOut: () => void;
}


// ============================================================
// 02 — CONSTANTS
// ============================================================

export const TOP_BAR_DEFAULT_TITLE =
  "Sinus Viewer";

export const TOP_BAR_DEFAULT_SUBTITLE =
  "DICOM CT / CBCT Imaging Workspace";

export const TOP_BAR_MIN_BUTTON_HEIGHT = 32;


// ============================================================
// 03 — HELPERS
// ============================================================

function sessionLabel(
  status: AppShellSessionStatus,
): string {
  return status === "authenticated"
    ? "Authenticated"
    : "Authentication required";
}

function sessionColor(
  status: AppShellSessionStatus,
): string {
  return status === "authenticated"
    ? "#86efac"
    : "#fca5a5";
}


// ============================================================
// 04 — STYLES
// ============================================================

const rootStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  flexWrap: "wrap",
  gap: 12,
  width: "100%",
  minWidth: 0,
  boxSizing: "border-box",
  padding: "10px 14px",
  backgroundColor: "#101827",
  borderBottom: "1px solid #263244",
  color: "#e2e8f0",
};

const brandStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 3,
  minWidth: 0,
};

const navigationStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  flexWrap: "wrap",
  gap: 6,
};

const buttonStyle: CSSProperties = {
  minHeight: TOP_BAR_MIN_BUTTON_HEIGHT,
  padding: "7px 10px",
  backgroundColor: "#192437",
  color: "#f8fafc",
  border: "1px solid #344258",
  borderRadius: 5,
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
};

const activeButtonStyle: CSSProperties = {
  ...buttonStyle,
  backgroundColor: "#164e63",
  borderColor: "#38bdf8",
  color: "#e0f2fe",
};

const dangerButtonStyle: CSSProperties = {
  ...buttonStyle,
  borderColor: "#7f1d1d",
  color: "#fecaca",
};

const disabledButtonStyle: CSSProperties = {
  opacity: 0.5,
  cursor: "not-allowed",
};

const statusStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "5px 8px",
  backgroundColor: "#0b1220",
  border: "1px solid #344258",
  borderRadius: 5,
  fontSize: 11,
};


// ============================================================
// 05 — MAIN COMPONENT
// ============================================================

export function TopBar({
  page,
  sessionStatus,
  viewerAvailable,
  previewsVisible,
  signingOut = false,
  compact = false,
  className = "",
  title = TOP_BAR_DEFAULT_TITLE,
  subtitle = TOP_BAR_DEFAULT_SUBTITLE,
  onNavigateDatasets,
  onNavigateViewer,
  onTogglePreviews,
  onSignOut,
}: TopBarProps) {
  const authenticated =
    sessionStatus === "authenticated";

  const navigationDisabled =
    !authenticated || signingOut;

  const canOpenViewer =
    !navigationDisabled && viewerAvailable;

  const canTogglePreviews =
    !navigationDisabled &&
    viewerAvailable &&
    page === "datasets";

  // ==========================================================
  // 06 — NAVIGATION CALLBACKS
  // ==========================================================

  const goToDatasets = useCallback((): void => {
    if (!navigationDisabled) {
      onNavigateDatasets();
    }
  }, [navigationDisabled, onNavigateDatasets]);

  const goToViewer = useCallback((): void => {
    if (canOpenViewer) {
      onNavigateViewer();
    }
  }, [canOpenViewer, onNavigateViewer]);

  const togglePreviews = useCallback((): void => {
    if (canTogglePreviews) {
      onTogglePreviews();
    }
  }, [canTogglePreviews, onTogglePreviews]);

  const signOut = useCallback((): void => {
    if (!navigationDisabled) {
      onSignOut();
    }
  }, [navigationDisabled, onSignOut]);

  // ==========================================================
  // 07 — STATUS PRESENTATION
  // ==========================================================

  const statusText = sessionLabel(
    sessionStatus,
  );

  const statusTint = sessionColor(
    sessionStatus,
  );

  const viewerStatus = viewerAvailable
    ? "Series selected"
    : "No series selected";

  // ==========================================================
  // 08 — JSX OUTPUT
  // ==========================================================

  return (
    <header
      className={className}
      style={{
        ...rootStyle,
        padding: compact ? "8px 10px" : "10px 14px",
      }}
      data-top-bar="true"
      data-current-page={page}
      aria-label="Sinus Viewer application header"
    >
      <div style={brandStyle}>
        <strong
          style={{
            fontSize: compact ? 14 : 16,
            color: "#f8fafc",
          }}
        >
          {title}
        </strong>

        {!compact && (
          <span
            style={{
              fontSize: 11,
              color: "#94a3b8",
            }}
          >
            {subtitle}
          </span>
        )}
      </div>

      <nav
        style={navigationStyle}
        aria-label="Main application navigation"
      >
        <button
          type="button"
          style={{
            ...(page === "datasets"
              ? activeButtonStyle
              : buttonStyle),
            ...(navigationDisabled
              ? disabledButtonStyle
              : {}),
          }}
          disabled={navigationDisabled}
          onClick={goToDatasets}
          aria-current={
            page === "datasets"
              ? "page"
              : undefined
          }
        >
          Datasets
        </button>

        <button
          type="button"
          style={{
            ...(page === "viewer"
              ? activeButtonStyle
              : buttonStyle),
            ...(!canOpenViewer
              ? disabledButtonStyle
              : {}),
          }}
          disabled={!canOpenViewer}
          onClick={goToViewer}
          aria-current={
            page === "viewer"
              ? "page"
              : undefined
          }
        >
          MPR Viewer
        </button>

        <button
          type="button"
          style={{
            ...buttonStyle,
            ...(!canTogglePreviews
              ? disabledButtonStyle
              : {}),
          }}
          disabled={!canTogglePreviews}
          onClick={togglePreviews}
          aria-pressed={previewsVisible}
        >
          {previewsVisible
            ? "Hide Previews"
            : "Show Previews"}
        </button>
      </nav>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 7,
        }}
      >
        <span
          style={statusStyle}
          role="status"
          aria-live="polite"
        >
          <span
            aria-hidden="true"
            style={{
              display: "inline-block",
              width: 7,
              height: 7,
              borderRadius: "50%",
              backgroundColor: statusTint,
            }}
          />

          <span style={{ color: statusTint }}>
            {statusText}
          </span>
        </span>

        {!compact && authenticated && (
          <span
            style={statusStyle}
            aria-label={viewerStatus}
          >
            {viewerStatus}
          </span>
        )}

        <button
          type="button"
          style={{
            ...dangerButtonStyle,
            ...(navigationDisabled
              ? disabledButtonStyle
              : {}),
          }}
          disabled={navigationDisabled}
          onClick={signOut}
          aria-label="Sign out of Sinus Viewer"
        >
          {signingOut
            ? "Signing Out…"
            : "Sign Out"}
        </button>
      </div>
    </header>
  );
}


// ============================================================
// 09 — COMPONENT CAPABILITIES
// ============================================================

export function getTopBarCapabilities() {
  return {
    branding: true,
    datasetsNavigation: true,
    viewerNavigation: true,
    previewToggle: true,
    authenticationIndicator: true,
    viewerSelectionIndicator: true,
    signOutControl: true,
    compactLayout: true,
    accessibleNavigation: true,
    authenticationOwnedByParent: true,
    persistentBrowserStorage: false,
    directBackendRequests: false,
    patientIdentifiersDisplayed: false,
    originalDICOMAccess: false,
    modifiesSourceDataset: false,
  } as const;
}


// ============================================================
// END OF SINUS VIEWER TOP BAR
// ============================================================
