
/**
 * SINUS VIEWER — FULLSCREEN VIEWPORT
 * ==================================
 *
 * Browser Fullscreen API wrapper for a single
 * axial, coronal or sagittal MPR viewport.
 *
 * Features:
 * - Enter / exit native browser fullscreen.
 * - Escape handled by the browser Fullscreen API.
 * - Keyboard-accessible fullscreen toggle.
 * - Current MPR children remain mounted.
 * - Native fullscreen state synchronization.
 * - Safe error categories and parent callbacks.
 * - Loading / disabled guards.
 * - No direct modification of image state.
 *
 * IMPORTANT:
 * Fullscreen changes display dimensions only.
 * Parent MPR canvas must respond to container
 * resize and recompute its display transform.
 *
 * Security:
 * - No DICOM file operations.
 * - No patient identifiers or source paths.
 * - No network requests or browser persistence.
 * - No raw exception messages rendered.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

// ============================================================
// 01 — PUBLIC TYPES
// ============================================================

export type FullscreenViewportPlane =
  | "axial"
  | "coronal"
  | "sagittal";

export type FullscreenFailureReason =
  | "unsupported"
  | "request-failed"
  | "exit-failed"
  | "browser-error";

export interface FullscreenViewportProps {
  readonly plane: FullscreenViewportPlane;
  readonly children: ReactNode;

  readonly enabled?: boolean;
  readonly loading?: boolean;
  readonly showButton?: boolean;
  readonly compact?: boolean;

  readonly className?: string;

  /**
   * Native fullscreen transitions are reported here.
   * This is not a request to modify MPR slice state.
   */
  readonly onFullscreenChange?: (
    fullscreen: boolean,
    plane: FullscreenViewportPlane,
  ) => void;

  /**
   * Error category only; never raw browser
   * exception messages or stack traces.
   */
  readonly onFullscreenError?: (
    reason: FullscreenFailureReason,
    plane: FullscreenViewportPlane,
  ) => void;
}

// ============================================================
// 02 — CONSTANTS
// ============================================================

export const FULLSCREEN_VIEWPORT_Z_INDEX = 70;

export const FULLSCREEN_BUTTON_MIN_SIZE = 34;

export const FULLSCREEN_BUTTON_COMPACT_SIZE = 29;

// ============================================================
// 03 — PURE HELPERS
// ============================================================

export function fullscreenPlaneLabel(
  plane: FullscreenViewportPlane,
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

export function isFullscreenSupported(): boolean {
  return (
    typeof document !== "undefined" &&
    typeof document.fullscreenEnabled === "boolean" &&
    document.fullscreenEnabled &&
    typeof document.exitFullscreen === "function"
  );
}

export function isElementFullscreen(
  element: Element | null,
): boolean {
  return (
    element !== null &&
    typeof document !== "undefined" &&
    document.fullscreenElement === element
  );
}

// ============================================================
// 04 — STYLES
// ============================================================

const rootStyle: CSSProperties = {
  position: "relative",
  display: "flex",
  flexDirection: "column",
  width: "100%",
  height: "100%",
  minWidth: 0,
  minHeight: 0,
  overflow: "hidden",
  backgroundColor: "#050b14",
  boxSizing: "border-box",
};

const nativeFullscreenStyle: CSSProperties = {
  width: "100vw",
  height: "100vh",
  maxWidth: "none",
  maxHeight: "none",
  backgroundColor: "#050b14",
};

const contentStyle: CSSProperties = {
  position: "relative",
  width: "100%",
  height: "100%",
  minWidth: 0,
  minHeight: 0,
  flex: 1,
  overflow: "hidden",
};

const buttonStyle: CSSProperties = {
  position: "absolute",
  top: 10,
  right: 10,
  zIndex: FULLSCREEN_VIEWPORT_Z_INDEX,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 6,
  minWidth: FULLSCREEN_BUTTON_MIN_SIZE,
  minHeight: FULLSCREEN_BUTTON_MIN_SIZE,
  padding: "7px 9px",
  border: "1px solid rgba(148,163,184,0.5)",
  borderRadius: 6,
  backgroundColor: "rgba(15,23,42,0.90)",
  color: "#f8fafc",
  fontSize: 11,
  fontWeight: 600,
  cursor: "pointer",
};

// ============================================================
// 05 — BUTTON ICON
// ============================================================

interface FullscreenIconProps {
  readonly expanded: boolean;
}

function FullscreenIcon({
  expanded,
}: FullscreenIconProps) {
  return (
    <svg
      width={17}
      height={17}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {expanded ? (
        <>
          <path d="M8 3v5H3" />
          <path d="M16 3v5h5" />
          <path d="M3 16h5v5" />
          <path d="M21 16h-5v5" />
        </>
      ) : (
        <>
          <path d="M3 9V3h6" />
          <path d="M15 3h6v6" />
          <path d="M21 15v6h-6" />
          <path d="M9 21H3v-6" />
        </>
      )}
    </svg>
  );
}

// ============================================================
// 06 — MAIN COMPONENT
// ============================================================

export function FullscreenViewport({
  plane,
  children,
  enabled = true,
  loading = false,
  showButton = true,
  compact = false,
  className = "",
  onFullscreenChange,
  onFullscreenError,
}: FullscreenViewportProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);

  const [fullscreen, setFullscreen] = useState(false);
  const [pending, setPending] = useState(false);
  const [supported, setSupported] = useState(false);

  const lastFullscreenRef = useRef(false);
  const requestPendingRef = useRef(false);

  const onChangeRef = useRef(onFullscreenChange);
  const onErrorRef = useRef(onFullscreenError);

  // Keep callbacks current without requiring event
  // listeners to be installed on every render.
  useEffect(() => {
    onChangeRef.current = onFullscreenChange;
    onErrorRef.current = onFullscreenError;
  }, [onFullscreenChange, onFullscreenError]);

  // ==========================================================
  // 07 — NATIVE STATE SYNCHRONIZATION
  // ==========================================================

  useEffect(() => {
    setSupported(isFullscreenSupported());

    const synchronize = (): void => {
      const next = isElementFullscreen(
        rootRef.current,
      );

      setFullscreen(next);

      if (lastFullscreenRef.current !== next) {
        lastFullscreenRef.current = next;
        onChangeRef.current?.(next, plane);
      }
    };

    const handleFullscreenError = (): void => {
      onErrorRef.current?.("browser-error", plane);
      synchronize();
    };

    document.addEventListener(
      "fullscreenchange",
      synchronize,
    );

    document.addEventListener(
      "fullscreenerror",
      handleFullscreenError,
    );

    synchronize();

    return () => {
      document.removeEventListener(
        "fullscreenchange",
        synchronize,
      );

      document.removeEventListener(
        "fullscreenerror",
        handleFullscreenError,
      );
    };
  }, [plane]);

  // ==========================================================
  // 08 — ENTER FULLSCREEN
  // ==========================================================

  const enterFullscreen = useCallback(
    async (): Promise<void> => {
      const element = rootRef.current;

      if (
        !enabled ||
        loading ||
        requestPendingRef.current
      ) {
        return;
      }

      if (
        !element ||
        !isFullscreenSupported() ||
        typeof element.requestFullscreen !== "function"
      ) {
        onErrorRef.current?.("unsupported", plane);
        return;
      }

      if (isElementFullscreen(element)) {
        return;
      }

      requestPendingRef.current = true;
      setPending(true);

      try {
        await element.requestFullscreen();
      } catch {
        onErrorRef.current?.("request-failed", plane);
      } finally {
        requestPendingRef.current = false;
        setPending(false);
      }
    },
    [enabled, loading, plane],
  );

  // ==========================================================
  // 09 — EXIT FULLSCREEN
  // ==========================================================

  const exitFullscreen = useCallback(
    async (): Promise<void> => {
      const element = rootRef.current;

      if (
        !element ||
        requestPendingRef.current ||
        !isElementFullscreen(element)
      ) {
        return;
      }

      if (
        typeof document.exitFullscreen !== "function"
      ) {
        onErrorRef.current?.("unsupported", plane);
        return;
      }

      requestPendingRef.current = true;
      setPending(true);

      try {
        await document.exitFullscreen();
      } catch {
        onErrorRef.current?.("exit-failed", plane);
      } finally {
        requestPendingRef.current = false;
        setPending(false);
      }
    },
    [plane],
  );

  // ==========================================================
  // 10 — TOGGLE
  // ==========================================================

  const toggleFullscreen = useCallback(
    (): void => {
      if (pending || requestPendingRef.current) {
        return;
      }

      if (isElementFullscreen(rootRef.current)) {
        void exitFullscreen();
      } else {
        void enterFullscreen();
      }
    },
    [pending, enterFullscreen, exitFullscreen],
  );

  const planeName = fullscreenPlaneLabel(plane);

  const canToggle =
    supported &&
    !pending &&
    (fullscreen || (enabled && !loading));

  const buttonLabel = fullscreen
    ? `Exit ${planeName} fullscreen`
    : `Enter ${planeName} fullscreen`;

  // ==========================================================
  // 11 — JSX
  // ==========================================================

  return (
    <div
      ref={rootRef}
      className={className}
      style={{
        ...rootStyle,
        ...(fullscreen ? nativeFullscreenStyle : {}),
      }}
      data-fullscreen-viewport="true"
      data-fullscreen-plane={plane}
      data-fullscreen-active={
        fullscreen ? "true" : "false"
      }
      data-fullscreen-supported={
        supported ? "true" : "false"
      }
      aria-label={`${planeName} viewport container`}
    >
      <div
        style={contentStyle}
        data-fullscreen-content="true"
      >
        {children}
      </div>

      {showButton && (
        <button
          type="button"
          style={{
            ...buttonStyle,
            minWidth: compact
              ? FULLSCREEN_BUTTON_COMPACT_SIZE
              : FULLSCREEN_BUTTON_MIN_SIZE,
            minHeight: compact
              ? FULLSCREEN_BUTTON_COMPACT_SIZE
              : FULLSCREEN_BUTTON_MIN_SIZE,
            padding: compact ? 5 : "7px 9px",
            opacity: canToggle ? 1 : 0.45,
            cursor: canToggle
              ? "pointer"
              : "not-allowed",
          }}
          disabled={!canToggle}
          onClick={toggleFullscreen}
          aria-label={buttonLabel}
          aria-pressed={fullscreen}
          title={buttonLabel}
          data-fullscreen-toggle="true"
        >
          <FullscreenIcon expanded={fullscreen} />

          {!compact && (
            <span>
              {fullscreen ? "Exit" : "Fullscreen"}
            </span>
          )}
        </button>
      )}
    </div>
  );
}

// ============================================================
// 12 — CAPABILITIES
// ============================================================

export function getFullscreenViewportCapabilities() {
  return {
    axialSupport: true,
    coronalSupport: true,
    sagittalSupport: true,
    nativeFullscreenAPI: true,
    browserEscapeHandling: true,
    fullscreenStateSynchronization: true,
    accessibleToggleButton: true,
    doubleRequestGuard: true,
    safeFailureCategories: true,
    parentStateCallbacks: true,
    preserveMountedChildren: true,
    disabledEntryProtection: true,
    loadingEntryProtection: true,
    compactLayout: true,
    automaticImageResampling: false,
    automaticCanvasResize: false,
    browserWindowMaximization: false,
    directDICOMModification: false,
    directNetworkRequests: false,
    browserPersistence: false,
    clinicalValidationComplete: false,
  } as const;
}

// ============================================================
// END OF SINUS VIEWER FULLSCREEN VIEWPORT
// ============================================================
