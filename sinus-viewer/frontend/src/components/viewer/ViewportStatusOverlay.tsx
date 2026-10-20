
/**
 * SINUS VIEWER — VIEWPORT STATUS OVERLAY
 * ======================================
 *
 * Safe presentation of MPR viewport lifecycle states.
 *
 * Supported states:
 * - idle
 * - loading
 * - decoding
 * - preparing
 * - rendering
 * - ready
 * - empty
 * - error
 *
 * Safety rules:
 * - Never display raw backend exception messages.
 * - Never display source paths, patient IDs or UIDs.
 * - Status messages are selected from a fixed catalog.
 * - Progress is optional and clamped to 0..100.
 * - Ready state renders no overlay.
 * - No DICOM filesystem or network operations.
 * - Retry is a parent-controlled callback.
 *
 * This component is not responsible for decoding,
 * rendering, volume loading or authorization.
 */

import {
  useCallback,
  useMemo,
  type CSSProperties,
} from "react";

// ============================================================
// 01 — PUBLIC TYPES
// ============================================================

export type ViewportStatusPlane =
  | "axial"
  | "coronal"
  | "sagittal";

export type ViewportLifecycleStatus =
  | "idle"
  | "loading"
  | "decoding"
  | "preparing"
  | "rendering"
  | "ready"
  | "empty"
  | "error";

export type ViewportErrorCategory =
  | "generic"
  | "unsupported"
  | "invalid-volume"
  | "resource-limit"
  | "session-expired";

export interface ViewportStatusState {
  readonly status: ViewportLifecycleStatus;

  /**
   * Optional completion estimate in percent.
   * A caller must not invent progress measurements.
   */
  readonly progressPercent?: number | null;

  /**
   * Safe category selected by the parent.
   * Never supply raw exception descriptions.
   */
  readonly errorCategory?: ViewportErrorCategory;
}

export interface ViewportStatusOverlayProps {
  readonly plane: ViewportStatusPlane;
  readonly state: ViewportStatusState | null;

  readonly visible?: boolean;
  readonly compact?: boolean;

  /**
   * Retry only when the parent permits it.
   * Authentication and authorization remain backend-owned.
   */
  readonly onRetry?: (
    plane: ViewportStatusPlane,
  ) => void;

  readonly allowRetry?: boolean;

  /**
   * When false, no percentage is displayed even
   * when the parent supplied one.
   */
  readonly showProgress?: boolean;

  readonly className?: string;
}

export interface ViewportStatusDisplay {
  readonly title: string;
  readonly description: string;
  readonly busy: boolean;
  readonly terminal: boolean;
  readonly showOverlay: boolean;
  readonly progressPercent: number | null;
  readonly progressDeterminate: boolean;
}

// ============================================================
// 02 — FIXED STATUS MESSAGES
// ============================================================

const STATUS_MESSAGES: Readonly<
  Record<
    ViewportLifecycleStatus,
    {
      readonly title: string;
      readonly description: string;
    }
  >
> = {
  idle: {
    title: "Awaiting image",
    description: "Select an available image series.",
  },
  loading: {
    title: "Loading volume",
    description: "Preparing image data for viewing.",
  },
  decoding: {
    title: "Decoding image data",
    description: "Processing supported image frames.",
  },
  preparing: {
    title: "Preparing MPR",
    description: "Building the multiplanar display.",
  },
  rendering: {
    title: "Rendering view",
    description: "Preparing the current image plane.",
  },
  ready: {
    title: "Ready",
    description: "",
  },
  empty: {
    title: "No image available",
    description:
      "This viewport has no displayable image data.",
  },
  error: {
    title: "Unable to display image",
    description:
      "The viewport could not be prepared.",
  },
};

const ERROR_MESSAGES: Readonly<
  Record<ViewportErrorCategory, string>
> = {
  generic:
    "The viewport could not be prepared.",
  unsupported:
    "This image format is not supported.",
  "invalid-volume":
    "The image volume could not be validated.",
  "resource-limit":
    "The available resources are insufficient.",
  "session-expired":
    "The viewing session is no longer available.",
};

const BUSY_STATUSES: ReadonlySet<ViewportLifecycleStatus> =
  new Set([
    "loading",
    "decoding",
    "preparing",
    "rendering",
  ]);

// ============================================================
// 03 — VALIDATION HELPERS
// ============================================================

export function isViewportLifecycleStatus(
  value: unknown,
): value is ViewportLifecycleStatus {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(
      STATUS_MESSAGES,
      value,
    )
  );
}

export function isViewportErrorCategory(
  value: unknown,
): value is ViewportErrorCategory {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(
      ERROR_MESSAGES,
      value,
    )
  );
}

export function normalizeViewportProgress(
  value: number | null | undefined,
): number | null {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value)
  ) {
    return null;
  }

  return Math.max(
    0,
    Math.min(100, value),
  );
}

export function viewportStatusPlaneLabel(
  plane: ViewportStatusPlane,
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
// 04 — DISPLAY MODEL
// ============================================================

export function buildViewportStatusDisplay(
  state: ViewportStatusState | null,
  showProgress = true,
): ViewportStatusDisplay {
  const status =
    state && isViewportLifecycleStatus(state.status)
      ? state.status
      : "idle";

  const message = STATUS_MESSAGES[status];
  const busy = BUSY_STATUSES.has(status);
  const terminal =
    status === "error" || status === "empty";

  const description =
    status === "error" &&
    isViewportErrorCategory(state?.errorCategory)
      ? ERROR_MESSAGES[state.errorCategory]
      : message.description;

  const progressPercent =
    busy && showProgress
      ? normalizeViewportProgress(
          state?.progressPercent,
        )
      : null;

  return {
    title: message.title,
    description,
    busy,
    terminal,
    showOverlay: status !== "ready",
    progressPercent,
    progressDeterminate:
      progressPercent !== null,
  };
}

// ============================================================
// 05 — STYLE DEFINITIONS
// ============================================================

const overlayStyle: CSSProperties = {
  position: "absolute",
  inset: 0,
  zIndex: 30,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  boxSizing: "border-box",
  padding: 16,
  backgroundColor: "rgba(5, 12, 22, 0.90)",
  color: "#e2e8f0",
};

const panelStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  textAlign: "center",
  gap: 10,
  width: "100%",
  maxWidth: 310,
  padding: 18,
  border: "1px solid #334155",
  borderRadius: 9,
  backgroundColor: "#101827",
  boxSizing: "border-box",
};

const spinnerStyle: CSSProperties = {
  width: 29,
  height: 29,
  borderRadius: "50%",
  border: "3px solid #334155",
  borderTopColor: "#38bdf8",
  animation:
    "sinus-viewport-status-spin 0.9s linear infinite",
};

const progressTrackStyle: CSSProperties = {
  height: 7,
  width: "100%",
  overflow: "hidden",
  backgroundColor: "#263244",
  borderRadius: 999,
};

const progressFillStyle: CSSProperties = {
  height: "100%",
  borderRadius: 999,
  backgroundColor: "#38bdf8",
};

const retryButtonStyle: CSSProperties = {
  padding: "8px 13px",
  minHeight: 34,
  borderRadius: 5,
  border: "1px solid #0ea5e9",
  backgroundColor: "#164e63",
  color: "#f0f9ff",
  cursor: "pointer",
  fontSize: 12,
  fontWeight: 600,
};

// ============================================================
// 06 — SPINNER / STATUS ICON
// ============================================================

interface StatusSymbolProps {
  readonly busy: boolean;
  readonly terminal: boolean;
}

function StatusSymbol({
  busy,
  terminal,
}: StatusSymbolProps) {
  if (busy) {
    return (
      <span
        style={{
          ...spinnerStyle,
          // Keep animation self-contained. If the
          // host restricts inline style injection,
          // the static circular indicator remains.
          animation: "none",
          borderTopColor: "#38bdf8",
        }}
        aria-hidden="true"
        data-viewport-spinner="true"
      />
    );
  }

  return (
    <svg
      width={32}
      height={32}
      viewBox="0 0 24 24"
      fill="none"
      stroke={terminal ? "#fbbf24" : "#94a3b8"}
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {terminal ? (
        <>
          <path d="M12 3 2 21h20L12 3Z" />
          <path d="M12 9v5M12 18h.01" />
        </>
      ) : (
        <>
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="m7 15 3-3 3 2 4-5" />
        </>
      )}
    </svg>
  );
}

// ============================================================
// 07 — MAIN COMPONENT
// ============================================================

export function ViewportStatusOverlay({
  plane,
  state,
  visible = true,
  compact = false,
  onRetry,
  allowRetry = true,
  showProgress = true,
  className = "",
}: ViewportStatusOverlayProps) {
  const display = useMemo(
    () => buildViewportStatusDisplay(
      state,
      showProgress,
    ),
    [
      state?.status,
      state?.progressPercent,
      state?.errorCategory,
      showProgress,
    ],
  );

  const status =
    state && isViewportLifecycleStatus(state.status)
      ? state.status
      : "idle";

  const canRetry =
    status === "error" &&
    allowRetry &&
    typeof onRetry === "function";

  const handleRetry = useCallback((): void => {
    if (canRetry) {
      onRetry?.(plane);
    }
  }, [canRetry, onRetry, plane]);

  if (!visible || !display.showOverlay) {
    return null;
  }

  const planeName = viewportStatusPlaneLabel(
    plane,
  );

  return (
    <div
      className={className}
      style={overlayStyle}
      role="region"
      aria-label={`${planeName} viewport status`}
      aria-busy={display.busy}
      data-viewport-status-overlay="true"
      data-viewport-status={status}
      data-viewport-status-plane={plane}
    >
      <div
        style={{
          ...panelStyle,
          padding: compact ? 12 : 18,
          gap: compact ? 7 : 10,
        }}
      >
        <StatusSymbol
          busy={display.busy}
          terminal={display.terminal}
        />

        <strong
          style={{
            fontSize: compact ? 12 : 14,
            color: "#f8fafc",
          }}
        >
          {display.title}
        </strong>

        <span
          style={{
            fontSize: 11,
            lineHeight: 1.5,
            color: "#94a3b8",
          }}
        >
          {display.description}
        </span>

        {display.busy && (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              width: "100%",
              gap: 5,
            }}
          >
            {display.progressDeterminate ? (
              <>
                <div
                  role="progressbar"
                  aria-label={`${planeName} loading progress`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={
                    display.progressPercent ?? 0
                  }
                  style={progressTrackStyle}
                >
                  <div
                    style={{
                      ...progressFillStyle,
                      width:
                        `${display.progressPercent ?? 0}%`,
                    }}
                  />
                </div>

                <span
                  style={{
                    fontSize: 11,
                    color: "#cbd5e1",
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {Math.round(
                    display.progressPercent ?? 0,
                  )}%
                </span>
              </>
            ) : (
              <div
                role="progressbar"
                aria-label={`${planeName} loading`}
                style={{
                  ...progressTrackStyle,
                  background:
                    "linear-gradient(90deg, #263244, #0e7490, #263244)",
                }}
              />
            )}
          </div>
        )}

        {canRetry && (
          <button
            type="button"
            style={retryButtonStyle}
            onClick={handleRetry}
            aria-label={`Retry ${planeName} viewport`}
            data-viewport-retry="true"
          >
            Retry
          </button>
        )}

        {status === "error" && (
          <span
            style={{
              fontSize: 10,
              color: "#94a3b8",
            }}
          >
            If the problem persists, verify the
            viewing session and supported image data.
          </span>
        )}
      </div>
    </div>
  );
}

// ============================================================
// 08 — CAPABILITIES
// ============================================================

export function getViewportStatusOverlayCapabilities() {
  return {
    axialSupport: true,
    coronalSupport: true,
    sagittalSupport: true,
    idleState: true,
    loadingState: true,
    decodingState: true,
    preparingState: true,
    renderingState: true,
    readyStateHidden: true,
    emptyVolumeState: true,
    errorState: true,
    allowlistedErrorCategories: true,
    rawBackendErrorsDisplayed: false,
    optionalProgress: true,
    progressClamping: true,
    indeterminateProgress: true,
    controlledRetry: true,
    compactLayout: true,
    patientIdentifiersDisplayed: false,
    directNetworkRequests: false,
    browserPersistence: false,
    sourceDatasetModification: false,
    clinicalValidationComplete: false,
  } as const;
}

// ============================================================
// END OF SINUS VIEWER VIEWPORT STATUS OVERLAY
// ============================================================
