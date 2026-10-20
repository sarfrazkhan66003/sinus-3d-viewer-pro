
/**
 * SINUS VIEWER — THREE-PLANE PREVIEW PANEL
 * ========================================
 *
 * Integrates:
 *   File 48 — FrontendPreviewService
 *   File 56 — usePreviews
 *
 * Features:
 * - Authorized axial / coronal / sagittal PNG previews.
 * - Explicit dataset-session and series-handle selection.
 * - Loading progress and cancellation.
 * - Retry after failures.
 * - Safe missing-image placeholders.
 * - Image decoding failure indicators.
 * - Authentication-required UI.
 * - Selection-aware stale-resource prevention.
 * - Service-owned Blob URL lifecycle.
 *
 * SECURITY:
 * - No original DICOM filesystem access.
 * - No arbitrary external image URLs.
 * - No patient metadata in UI or console.
 * - No browser storage of medical image data.
 * - No original dataset modifications.
 *
 * PREVIEWS ARE NOT DIAGNOSTIC IMAGES.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";

import type {
  PreviewPlane,
} from "../../types/api";

import {
  usePreviews,
  previewsMatchSelection,
  type PreviewSelection,
} from "../../hooks/usePreviews";


// ============================================================
// 01 — CONSTANTS
// ============================================================

export const PREVIEW_PANEL_PLANES = [
  "axial",
  "coronal",
  "sagittal",
] as const;

export const PREVIEW_PANEL_MIN_HEIGHT = 180;

export type PreviewPanelStatus =
  | "empty"
  | "loading"
  | "ready"
  | "cancelled"
  | "error"
  | "authentication-required";


// ============================================================
// 02 — PUBLIC TYPES
// ============================================================

export interface PreviewPanelProps {
  readonly selection: PreviewSelection | null;

  readonly className?: string;
  readonly compact?: boolean;
  readonly disabled?: boolean;

  /**
   * When true, automatically load previews after a
   * valid authorized selection is provided.
   */
  readonly autoLoad?: boolean;

  readonly onAuthenticationRequired?: () => void;

  /**
   * Only generic, UI-safe error messages are forwarded.
   */
  readonly onError?: (message: string) => void;
}

interface PreviewTileProps {
  readonly plane: PreviewPlane;
  readonly url: string | null;
  readonly loading: boolean;
  readonly unavailable: boolean;
  readonly selectionVersion: number;
}


// ============================================================
// 03 — SAFE PRESENTATION HELPERS
// ============================================================

function planeTitle(
  plane: PreviewPlane,
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

function planeDescription(
  plane: PreviewPlane,
): string {
  switch (plane) {
    case "axial":
      return "Transverse preview";

    case "coronal":
      return "Frontal preview";

    case "sagittal":
      return "Side-plane preview";
  }
}

/**
 * PreviewService owns the generated Blob URLs.
 *
 * Reject http(s), data:, file: and arbitrary strings.
 * The component must never fetch external image URLs.
 */
function safePreviewURL(
  value: unknown,
): string | null {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 4096
  ) {
    return null;
  }

  return value.startsWith("blob:")
    ? value
    : null;
}

function safePercentage(
  value: number,
): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(
    0,
    Math.min(100, Math.round(value)),
  );
}

function controlledErrorText(): string {
  return "Preview images could not be loaded.";
}


// ============================================================
// 04 — STYLES
// ============================================================

const rootStyle: CSSProperties = {
  width: "100%",
  minWidth: 0,
  display: "flex",
  flexDirection: "column",
  gap: 12,
  padding: 12,
  boxSizing: "border-box",
  backgroundColor: "#101827",
  color: "#e2e8f0",
};

const headerStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  flexWrap: "wrap",
  gap: 8,
};

const actionsStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  flexWrap: "wrap",
  gap: 6,
};

const buttonStyle: CSSProperties = {
  padding: "7px 10px",
  minHeight: 32,
  borderRadius: 5,
  border: "1px solid #344258",
  backgroundColor: "#192437",
  color: "#e2e8f0",
  fontSize: 12,
  cursor: "pointer",
};

const tileStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  minWidth: 0,
  overflow: "hidden",
  border: "1px solid #263244",
  borderRadius: 7,
  backgroundColor: "#080d16",
};

const imageAreaStyle: CSSProperties = {
  position: "relative",
  width: "100%",
  minHeight: PREVIEW_PANEL_MIN_HEIGHT,
  aspectRatio: "1 / 1",
  backgroundColor: "#000000",
  overflow: "hidden",
};

const placeholderStyle: CSSProperties = {
  position: "absolute",
  inset: 0,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 12,
  boxSizing: "border-box",
  textAlign: "center",
  color: "#94a3b8",
  fontSize: 12,
};

const mutedStyle: CSSProperties = {
  fontSize: 11,
  color: "#94a3b8",
  lineHeight: 1.5,
};

const errorStyle: CSSProperties = {
  padding: 10,
  backgroundColor: "#450a0a",
  color: "#fecaca",
  fontSize: 12,
  borderRadius: 5,
};


// ============================================================
// 05 — PREVIEW TILE
// ============================================================

function PreviewTile({
  plane,
  url,
  loading,
  unavailable,
  selectionVersion,
}: PreviewTileProps) {
  const [imageFailed, setImageFailed] =
    useState(false);

  /**
   * Reset decode errors when the preview URL changes.
   * A newly selected series must not inherit a previous
   * image's error state.
   */
  useEffect(() => {
    setImageFailed(false);
  }, [url, selectionVersion]);

  const safeURL = safePreviewURL(url);

  const showImage =
    safeURL !== null &&
    !loading &&
    !unavailable &&
    !imageFailed;

  let placeholder = "No preview available.";

  if (loading) {
    placeholder = "Loading preview…";
  } else if (imageFailed) {
    placeholder = "Unable to display preview image.";
  } else if (unavailable) {
    placeholder = "Preview unavailable.";
  }

  return (
    <section
      style={tileStyle}
      aria-label={`${planeTitle(plane)} preview`}
      data-preview-plane={plane}
    >
      <header
        style={{
          padding: "8px 10px",
          borderBottom: "1px solid #263244",
        }}
      >
        <strong style={{ fontSize: 12 }}>
          {planeTitle(plane)}
        </strong>

        <div style={mutedStyle}>
          {planeDescription(plane)}
        </div>
      </header>

      <div style={imageAreaStyle}>
        {showImage && (
          <img
            src={safeURL}
            alt={`${planeTitle(plane)} CT/CBCT navigation preview`}
            draggable={false}
            onError={() => setImageFailed(true)}
            style={{
              display: "block",
              width: "100%",
              height: "100%",
              objectFit: "contain",
              position: "absolute",
              inset: 0,
              userSelect: "none",
            }}
          />
        )}

        {!showImage && (
          <div
            style={placeholderStyle}
            role="status"
          >
            {placeholder}
          </div>
        )}
      </div>

      <footer
        style={{
          padding: "6px 10px",
          ...mutedStyle,
        }}
      >
        Non-diagnostic preview
      </footer>
    </section>
  );
}


// ============================================================
// 06 — MAIN PANEL
// ============================================================

export function PreviewPanel({
  selection,
  className = "",
  compact = false,
  disabled = false,
  autoLoad = true,
  onAuthenticationRequired,
  onError,
}: PreviewPanelProps) {
  const {
    state,
    actions,
    progress,
    requiresAuthentication,
  } = usePreviews();

  const [requestError, setRequestError] =
    useState<string | null>(null);

  const [loadRequested, setLoadRequested] =
    useState(false);

  /**
   * Incremented when an operation is superseded.
   * Late success/failure callbacks cannot overwrite
   * the newest selection's UI state.
   */
  const generationRef = useRef(0);

  const sessionId =
    selection?.datasetSessionId ?? null;

  const seriesHandle =
    selection?.seriesHandle ?? null;

  const selectionVersion = generationRef.current;

  const selectionMatches =
    selection !== null &&
    previewsMatchSelection(state, selection);

  /**
   * Never display a ready image from a previous
   * dataset or series during selection transitions.
   */
  const readyImages =
    selectionMatches ? state.images : null;

  const axialURL = safePreviewURL(
    readyImages?.axial?.url,
  );

  const coronalURL = safePreviewURL(
    readyImages?.coronal?.url,
  );

  const sagittalURL = safePreviewURL(
    readyImages?.sagittal?.url,
  );

  // ==========================================================
  // 07 — LOAD FUNCTION
  // ==========================================================

  const load = useCallback(
    async (
      selectedSessionId: string,
      selectedSeriesHandle: string,
      generation: number,
    ): Promise<void> => {
      try {
        await actions.load({
          datasetSessionId: selectedSessionId,
          seriesHandle: selectedSeriesHandle,
        });

        if (generation === generationRef.current) {
          setRequestError(null);
        }
      } catch {
        if (generation === generationRef.current) {
          setRequestError(controlledErrorText());
          onError?.(controlledErrorText());
        }
      }
    },
    [actions, onError],
  );

  // ==========================================================
  // 08 — SELECTION LIFECYCLE
  // ==========================================================

  useEffect(() => {
    generationRef.current += 1;

    const generation = generationRef.current;

    setRequestError(null);
    setLoadRequested(false);

    actions.reset();

    if (
      !autoLoad ||
      disabled ||
      sessionId === null ||
      seriesHandle === null
    ) {
      return;
    }

    setLoadRequested(true);

    void load(
      sessionId,
      seriesHandle,
      generation,
    );

    return () => {
      generationRef.current += 1;
      actions.cancel();
    };
  }, [
    sessionId,
    seriesHandle,
    autoLoad,
    disabled,
    actions,
    load,
  ]);

  // ==========================================================
  // 09 — AUTHENTICATION HANDLING
  // ==========================================================

  useEffect(() => {
    if (requiresAuthentication) {
      onAuthenticationRequired?.();
    }
  }, [
    requiresAuthentication,
    onAuthenticationRequired,
  ]);

  // ==========================================================
  // 10 — MANUAL RETRY
  // ==========================================================

  const retry = useCallback((): void => {
    if (
      disabled ||
      sessionId === null ||
      seriesHandle === null ||
      progress.status === "loading"
    ) {
      return;
    }

    generationRef.current += 1;

    const generation = generationRef.current;

    actions.reset();

    setRequestError(null);
    setLoadRequested(true);

    void load(
      sessionId,
      seriesHandle,
      generation,
    );
  }, [
    disabled,
    sessionId,
    seriesHandle,
    progress.status,
    actions,
    load,
  ]);

  // ==========================================================
  // 11 — CANCEL
  // ==========================================================

  const cancel = useCallback((): void => {
    generationRef.current += 1;

    actions.cancel();
    setLoadRequested(false);
    setRequestError(null);
  }, [actions]);

  // ==========================================================
  // 12 — DERIVED STATUS
  // ==========================================================

  const hasSelection =
    sessionId !== null &&
    seriesHandle !== null;

  const isLoading =
    loadRequested &&
    hasSelection &&
    !disabled &&
    progress.status === "loading";

  const isReady =
    !disabled &&
    selectionMatches &&
    state.progress.status === "ready";

  const isCancelled =
    progress.status === "cancelled";

  const hasError =
    requestError !== null ||
    progress.status === "error";

  const status: PreviewPanelStatus =
    !hasSelection
      ? "empty"
      : requiresAuthentication
        ? "authentication-required"
        : hasError
          ? "error"
          : isLoading
            ? "loading"
            : isReady
              ? "ready"
              : isCancelled
                ? "cancelled"
                : "empty";

  const percentage = safePercentage(
    progress.percentage,
  );

  // ==========================================================
  // 13 — JSX
  // ==========================================================

  return (
    <section
      className={className}
      style={{
        ...rootStyle,
        padding: compact ? 8 : 12,
      }}
      data-preview-panel="true"
      data-preview-status={status}
      aria-label="Three-plane medical image previews"
    >
      <header style={headerStyle}>
        <div>
          <strong style={{ fontSize: 14 }}>
            CT / CBCT Previews
          </strong>

          <div style={mutedStyle}>
            Axial • Coronal • Sagittal
          </div>
        </div>

        <div style={actionsStyle}>
          <button
            type="button"
            style={buttonStyle}
            disabled={
              disabled ||
              !hasSelection ||
              isLoading
            }
            onClick={retry}
          >
            {status === "error" ||
            status === "cancelled"
              ? "Retry"
              : "Reload"}
          </button>

          <button
            type="button"
            style={buttonStyle}
            disabled={disabled || !isLoading}
            onClick={cancel}
          >
            Cancel
          </button>
        </div>
      </header>

      {status === "loading" && (
        <div
          role="status"
          aria-live="polite"
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 6,
          }}
        >
          <span style={mutedStyle}>
            Loading image previews: {percentage}%
          </span>

          <progress
            max={100}
            value={percentage}
            style={{ width: "100%" }}
            aria-label="Preview download progress"
          />
        </div>
      )}

      {status === "authentication-required" && (
        <div
          style={errorStyle}
          role="alert"
        >
          Your session requires authentication before
          these previews can be displayed.
        </div>
      )}

      {status === "error" && (
        <div
          style={errorStyle}
          role="alert"
        >
          {requestError ??
            controlledErrorText()}
        </div>
      )}

      {status === "cancelled" && (
        <div
          style={mutedStyle}
          role="status"
        >
          Preview loading was cancelled.
        </div>
      )}

      {status === "empty" && (
        <div
          style={mutedStyle}
          role="status"
        >
          {hasSelection
            ? "Preview images have not been loaded."
            : "Select an authorized imaging series to display previews."}
        </div>
      )}

      <div
        style={{
          display: "grid",
          gridTemplateColumns:
            compact
              ? "minmax(0, 1fr)"
              : "repeat(auto-fit, minmax(180px, 1fr))",
          gap: 10,
          minWidth: 0,
        }}
      >
        <PreviewTile
          plane="axial"
          url={isReady ? axialURL : null}
          loading={isLoading}
          unavailable={status !== "ready"}
          selectionVersion={selectionVersion}
        />

        <PreviewTile
          plane="coronal"
          url={isReady ? coronalURL : null}
          loading={isLoading}
          unavailable={status !== "ready"}
          selectionVersion={selectionVersion}
        />

        <PreviewTile
          plane="sagittal"
          url={isReady ? sagittalURL : null}
          loading={isLoading}
          unavailable={status !== "ready"}
          selectionVersion={selectionVersion}
        />
      </div>

      <footer style={mutedStyle}>
        Preview images are navigation aids only.
        They are not validated for diagnosis.
        The original DICOM dataset is never modified.
      </footer>
    </section>
  );
}


// ============================================================
// 14 — COMPONENT CAPABILITIES
// ============================================================

export function getPreviewPanelCapabilities() {
  return {
    axialPreview: true,
    coronalPreview: true,
    sagittalPreview: true,
    authorizedLoading: true,
    progressIndicator: true,
    cancellation: true,
    manualRetry: true,
    selectionChangeProtection: true,
    missingImagePlaceholder: true,
    imageDecodeErrorHandling: true,
    authenticationRequiredState: true,
    serviceOwnedBlobURLs: true,
    directOriginalDICOMAccess: false,
    externalImageURLs: false,
    browserPersistence: false,
    diagnosticQuality: false,
    sourceDatasetModification: false,
  } as const;
}


// ============================================================
// END OF SINUS VIEWER PREVIEW PANEL
// ============================================================
