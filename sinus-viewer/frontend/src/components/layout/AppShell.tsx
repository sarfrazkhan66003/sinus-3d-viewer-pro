
/**
 * SINUS VIEWER — APPLICATION SHELL
 * ================================
 *
 * Main navigation and layout coordinator.
 *
 * Existing components:
 * - File 67: DatasetBrowser
 * - File 69: PreviewPanel
 * - File 66: ViewerWorkspace
 *
 * Responsibilities:
 * - Browser / viewer navigation.
 * - Authorized series selection.
 * - Responsive application layout.
 * - Session-expiry presentation.
 * - Parent-controlled sign-out.
 * - In-memory viewer cleanup on navigation.
 * - Non-identifying application status.
 *
 * Security:
 * - Authentication is owned by the parent/backend.
 * - No credentials or tokens stored here.
 * - No patient names, UIDs or paths displayed.
 * - No localStorage or sessionStorage.
 * - No original DICOM filesystem operations.
 *
 * The volume adapter must be verified separately
 * against the actual decoding and sampling contracts.
 */

import {
  useCallback,
  useEffect,
  useState,
  type CSSProperties,
} from "react";

import {
  DatasetBrowser,
} from "../dataset/DatasetBrowser";

import {
  PreviewPanel,
} from "../dataset/PreviewPanel";

import {
  ViewerWorkspace,
  type ViewerWorkspaceProps,
} from "../viewer/ViewerWorkspace";

import type {
  DatasetViewerSelection,
} from "../../hooks/useDataset";


// ============================================================
// 01 — PUBLIC TYPES
// ============================================================

export type AppShellPage =
  | "datasets"
  | "viewer";

export type AppShellSessionStatus =
  | "authenticated"
  | "authentication-required";

export interface AppShellProps {
  /**
   * The parent auth controller must unmount this shell
   * when its session is no longer authenticated.
   */
  readonly sessionStatus: AppShellSessionStatus;

  /**
   * Required explicit volume adapter.
   * The shell does not guess decoded volume layout.
   */
  readonly adaptVolume:
    ViewerWorkspaceProps["adaptVolume"];

  readonly onSignOut: () => void | Promise<void>;

  readonly onAuthenticationRequired?: () => void;

  readonly className?: string;

  readonly applicationTitle?: string;
}


// ============================================================
// 02 — CONSTANTS
// ============================================================

export const APP_SHELL_DEFAULT_TITLE =
  "Sinus Viewer";

export const APP_SHELL_MIN_CONTENT_HEIGHT = 320;

export const APP_SHELL_MOBILE_BREAKPOINT = 760;


// ============================================================
// 03 — SAFE PRESENTATION HELPERS
// ============================================================

function pageTitle(
  page: AppShellPage,
): string {
  return page === "viewer"
    ? "MPR Viewer"
    : "Dataset Browser";
}

function publicErrorMessage(): string {
  return "The requested operation could not be completed.";
}


// ============================================================
// 04 — STYLES
// ============================================================

const rootStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  width: "100%",
  height: "100%",
  minHeight: APP_SHELL_MIN_CONTENT_HEIGHT,
  minWidth: 0,
  overflow: "hidden",
  backgroundColor: "#080d16",
  color: "#e2e8f0",
};

const headerStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 10,
  padding: "10px 14px",
  backgroundColor: "#101827",
  borderBottom: "1px solid #263244",
};

const navigationStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: 6,
};

const buttonStyle: CSSProperties = {
  padding: "7px 11px",
  border: "1px solid #344258",
  borderRadius: 5,
  backgroundColor: "#192437",
  color: "#e2e8f0",
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

const contentStyle: CSSProperties = {
  display: "flex",
  flex: 1,
  minWidth: 0,
  minHeight: 0,
  overflow: "hidden",
};

const footerStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  justifyContent: "space-between",
  alignItems: "center",
  gap: 8,
  padding: "7px 12px",
  backgroundColor: "#101827",
  borderTop: "1px solid #263244",
  fontSize: 11,
  color: "#94a3b8",
};

const noticeStyle: CSSProperties = {
  padding: "10px 14px",
  borderBottom: "1px solid #263244",
  backgroundColor: "#172033",
  color: "#cbd5e1",
  fontSize: 12,
};

const errorStyle: CSSProperties = {
  ...noticeStyle,
  backgroundColor: "#450a0a",
  color: "#fecaca",
};


// ============================================================
// 05 — MAIN APPLICATION SHELL
// ============================================================

export function AppShell({
  sessionStatus,
  adaptVolume,
  onSignOut,
  onAuthenticationRequired,
  className = "",
  applicationTitle = APP_SHELL_DEFAULT_TITLE,
}: AppShellProps) {
  const [page, setPage] =
    useState<AppShellPage>("datasets");

  const [selection, setSelection] =
    useState<DatasetViewerSelection | null>(
      null,
    );

  const [showPreviews, setShowPreviews] =
    useState(false);

  const [signingOut, setSigningOut] =
    useState(false);

  const [notice, setNotice] =
    useState<string | null>(null);

  const [error, setError] =
    useState<string | null>(null);

  const authenticated =
    sessionStatus === "authenticated";

  // ==========================================================
  // 06 — SESSION EXPIRY
  // ==========================================================

  /**
   * Session expiry immediately hides browser and viewer
   * content. Child services are unmounted.
   *
   * The owning auth controller is responsible for
   * clearing backend session state and access.
   */
  useEffect(() => {
    if (authenticated) {
      return;
    }

    setPage("datasets");
    setSelection(null);
    setShowPreviews(false);
    setNotice(null);
    setError(null);
  }, [authenticated]);

  // ==========================================================
  // 07 — AUTHENTICATION REQUIRED CALLBACK
  // ==========================================================

  const handleAuthenticationRequired =
    useCallback((): void => {
      setPage("datasets");
      setSelection(null);
      setShowPreviews(false);
      setError(null);
      setNotice(
        "Session authentication is required.",
      );

      onAuthenticationRequired?.();
    }, [onAuthenticationRequired]);

  // ==========================================================
  // 08 — SAFE ERROR PRESENTATION
  // ==========================================================

  const handleError = useCallback(
    (_message: string): void => {
      /**
       * Do not forward raw server exceptions, source
       * paths or patient-related information.
       */
      setError(publicErrorMessage());
    },
    [],
  );

  // ==========================================================
  // 09 — OPEN AUTHORIZED SERIES
  // ==========================================================

  const handleOpenSeries = useCallback(
    (next: DatasetViewerSelection): void => {
      if (!authenticated || signingOut) {
        return;
      }

      setSelection({
        datasetSessionId:
          next.datasetSessionId,
        seriesHandle:
          next.seriesHandle,
      });

      setError(null);
      setNotice(null);
      setShowPreviews(false);
      setPage("viewer");
    },
    [authenticated, signingOut],
  );

  // ==========================================================
  // 10 — NAVIGATE BACK TO BROWSER
  // ==========================================================

  /**
   * Returning to the browser unmounts ViewerWorkspace.
   * Its owned volume service is reset on cleanup.
   *
   * Preserve opaque selection for optional previews,
   * but never keep decoded voxels in AppShell state.
   */
  const openDatasets = useCallback((): void => {
    if (!authenticated || signingOut) {
      return;
    }

    setPage("datasets");
    setError(null);
  }, [authenticated, signingOut]);

  const openViewer = useCallback((): void => {
    if (
      !authenticated ||
      signingOut ||
      selection === null
    ) {
      return;
    }

    setPage("viewer");
    setError(null);
  }, [authenticated, signingOut, selection]);

  // ==========================================================
  // 11 — PREVIEW TOGGLE
  // ==========================================================

  const togglePreviews = useCallback((): void => {
    if (
      !authenticated ||
      signingOut ||
      selection === null
    ) {
      return;
    }

    setShowPreviews((previous) => !previous);
  }, [authenticated, signingOut, selection]);

  // ==========================================================
  // 12 — SIGN OUT
  // ==========================================================

  const handleSignOut = useCallback(
    async (): Promise<void> => {
      if (signingOut) {
        return;
      }

      /**
       * Remove sensitive imaging views immediately.
       * A failed backend sign-out must not restore
       * the old volume automatically.
       */
      setSigningOut(true);
      setPage("datasets");
      setSelection(null);
      setShowPreviews(false);
      setError(null);
      setNotice("Closing the current session.");

      try {
        await onSignOut();
      } catch {
        setError(
          "Unable to complete sign-out. " +
          "Please retry before leaving this device.",
        );
      } finally {
        setSigningOut(false);
      }
    },
    [onSignOut, signingOut],
  );

  // ==========================================================
  // 13 — PAGE AND ACCESS CONTROL
  // ==========================================================

  const viewerAvailable =
    selection !== null && authenticated;

  const showViewer =
    authenticated &&
    !signingOut &&
    page === "viewer" &&
    viewerAvailable;

  const showBrowser =
    authenticated &&
    !signingOut &&
    page === "datasets";

  const showPreviewPanel =
    showBrowser &&
    showPreviews &&
    selection !== null;

  // ==========================================================
  // 14 — JSX
  // ==========================================================

  return (
    <div
      className={className}
      style={rootStyle}
      data-app-shell="true"
      data-current-page={page}
      aria-label="Sinus Viewer application"
    >
      <header style={headerStyle}>
        <div>
          <strong
            style={{
              display: "block",
              fontSize: 16,
              color: "#f8fafc",
            }}
          >
            {applicationTitle}
          </strong>

          <span
            style={{
              fontSize: 11,
              color: "#94a3b8",
            }}
          >
            DICOM CT / CBCT Imaging Workspace
          </span>
        </div>

        <nav
          style={navigationStyle}
          aria-label="Application navigation"
        >
          <button
            type="button"
            style={
              page === "datasets"
                ? activeButtonStyle
                : buttonStyle
            }
            disabled={!authenticated || signingOut}
            onClick={openDatasets}
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
            style={
              page === "viewer"
                ? activeButtonStyle
                : buttonStyle
            }
            disabled={
              !viewerAvailable || signingOut
            }
            onClick={openViewer}
            aria-current={
              page === "viewer"
                ? "page"
                : undefined
            }
          >
            Viewer
          </button>

          <button
            type="button"
            style={buttonStyle}
            disabled={
              !viewerAvailable ||
              signingOut ||
              page !== "datasets"
            }
            onClick={togglePreviews}
            aria-pressed={showPreviews}
          >
            {showPreviews
              ? "Hide Previews"
              : "Show Previews"}
          </button>

          <button
            type="button"
            style={dangerButtonStyle}
            disabled={
              !authenticated || signingOut
            }
            onClick={() => {
              void handleSignOut();
            }}
          >
            {signingOut
              ? "Signing Out…"
              : "Sign Out"}
          </button>
        </nav>
      </header>

      {!authenticated && (
        <div
          style={errorStyle}
          role="alert"
        >
          Authentication is required to access
          the medical imaging workspace.
        </div>
      )}

      {notice && (
        <div
          style={noticeStyle}
          role="status"
          aria-live="polite"
        >
          {notice}
        </div>
      )}

      {error && (
        <div
          style={errorStyle}
          role="alert"
        >
          {error}
        </div>
      )}

      <div style={contentStyle}>
        {showBrowser && (
          <div
            style={{
              display: "flex",
              flex: 1,
              flexDirection: "column",
              minWidth: 0,
              minHeight: 0,
              overflowY: "auto",
            }}
          >
            <div
              style={{
                minHeight: 300,
                flex: showPreviewPanel ? "0 0 auto" : 1,
              }}
            >
              <DatasetBrowser
                onOpenSeries={handleOpenSeries}
                onAuthenticationRequired={
                  handleAuthenticationRequired
                }
                onError={handleError}
              />
            </div>

            {showPreviewPanel && (
              <PreviewPanel
                selection={selection}
                onAuthenticationRequired={
                  handleAuthenticationRequired
                }
                onError={handleError}
              />
            )}
          </div>
        )}

        {showViewer && (
          <div
            style={{
              flex: 1,
              minWidth: 0,
              minHeight: 0,
            }}
          >
            <ViewerWorkspace
              selection={selection}
              adaptVolume={adaptVolume}
              onAuthenticationRequired={
                handleAuthenticationRequired
              }
              onError={handleError}
            />
          </div>
        )}

        {authenticated &&
          !signingOut &&
          page === "viewer" &&
          !viewerAvailable && (
            <div
              style={{
                flex: 1,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                padding: 24,
                textAlign: "center",
                color: "#94a3b8",
              }}
            >
              Select an authorized imaging series
              from the dataset browser.
            </div>
          )}
      </div>

      <footer style={footerStyle}>
        <span>
          {pageTitle(page)}
          {" • "}
          {authenticated
            ? "Authenticated session"
            : "Authentication required"}
        </span>

        <span>
          Research visualization •
          Diagnostic validation pending
        </span>
      </footer>
    </div>
  );
}


// ============================================================
// 15 — APP SHELL CAPABILITIES
// ============================================================

export function getAppShellCapabilities() {
  return {
    datasetBrowserNavigation: true,
    viewerNavigation: true,
    optionalPreviewPanel: true,
    authorizedSeriesSelection: true,
    parentOwnedAuthentication: true,
    authenticationRequiredHandling: true,
    signOutCallback: true,
    viewerUnmountOnNavigation: true,
    selectionCleanupOnLogout: true,
    responsiveFlexLayout: true,
    patientIdentifiersDisplayed: false,
    browserPersistence: false,
    originalDICOMAccess: false,
    sourceDatasetModification: false,
    clinicalValidationComplete: false,
  } as const;
}


// ============================================================
// END OF SINUS VIEWER APPLICATION SHELL
// ============================================================
