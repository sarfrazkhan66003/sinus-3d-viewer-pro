
/**
 * SINUS VIEWER — VIEWPORT ERROR FALLBACK
 * ======================================
 *
 * React Error Boundary for a single MPR viewport.
 *
 * Features:
 * - Isolate errors to one viewport subtree.
 * - Fixed, non-identifying fallback messages.
 * - Controlled recovery / retry.
 * - Retry lifecycle state.
 * - Optional parent-owned reset action.
 * - Reset when a safe, parent-provided identity
 *   token changes.
 * - Accessible error and recovery interface.
 *
 * IMPORTANT:
 * React error boundaries catch render and
 * lifecycle errors in descendants.
 *
 * They do NOT catch:
 * - Event-handler exceptions.
 * - Rejected promises.
 * - Errors thrown by the boundary itself.
 * - Errors outside its React subtree.
 *
 * Parent services must handle those separately.
 *
 * PRIVACY:
 * - Never display error.message or stack.
 * - Never print error objects to the console.
 * - Never display patient metadata or source paths.
 * - No DICOM file or network operations.
 */

import {
  Component,
  useCallback,
  useState,
  type CSSProperties,
  type ErrorInfo,
  type ReactNode,
} from "react";

// ============================================================
// 01 — PUBLIC TYPES
// ============================================================

export type ViewportErrorPlane =
  | "axial"
  | "coronal"
  | "sagittal";

export type ViewportRecoveryStatus =
  | "idle"
  | "recovering"
  | "failed";

export type ViewportBoundaryFailure =
  | "render-error"
  | "recovery-error";

export interface ViewportErrorBoundaryProps {
  readonly plane: ViewportErrorPlane;
  readonly children: ReactNode;

  /**
   * Parent-controlled reset identity.
   *
   * Use a non-sensitive revision counter or token.
   * Do not pass patient IDs, DICOM UIDs or paths.
   */
  readonly resetKey?: string | number;

  readonly onFailure?: (
    category: ViewportBoundaryFailure,
    plane: ViewportErrorPlane,
  ) => void;

  /**
   * Optional parent-controlled async preparation.
   * If absent, retry remounts the boundary subtree.
   */
  readonly onRetry?: (
    plane: ViewportErrorPlane,
  ) => void | Promise<void>;

  readonly onReset?: (
    plane: ViewportErrorPlane,
  ) => void;

  readonly compact?: boolean;
  readonly allowRetry?: boolean;
}

export interface ViewportErrorBoundaryState {
  readonly hasError: boolean;
  readonly revision: number;
  readonly resetKey?: string | number;
}

export interface ViewportErrorFallbackProps {
  readonly plane: ViewportErrorPlane;
  readonly compact?: boolean;
  readonly allowRetry?: boolean;

  readonly recoveryStatus?: ViewportRecoveryStatus;
  readonly onRetry?: () => void;
  readonly onReset?: () => void;
  readonly className?: string;
}

// ============================================================
// 02 — SAFE LABEL HELPERS
// ============================================================

export function viewportErrorPlaneLabel(
  plane: ViewportErrorPlane,
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

export const VIEWPORT_ERROR_FALLBACK_MESSAGES = {
  title: "Viewport unavailable",
  description:
    "This image view could not be displayed.",
  retry: "Retry Viewport",
  retrying: "Preparing viewport…",
  reset: "Reset View",
  recoveryFailed:
    "The viewport could not be recovered.",
  help:
    "If the problem continues, reload the viewing session.",
} as const;

// ============================================================
// 03 — STYLES
// ============================================================

const rootStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  width: "100%",
  height: "100%",
  minHeight: 180,
  gap: 11,
  padding: 18,
  boxSizing: "border-box",
  border: "1px solid #7c2d12",
  borderRadius: 7,
  backgroundColor: "#101827",
  color: "#e2e8f0",
  textAlign: "center",
};

const descriptionStyle: CSSProperties = {
  fontSize: 12,
  color: "#94a3b8",
  lineHeight: 1.6,
  maxWidth: 320,
};

const buttonRowStyle: CSSProperties = {
  display: "flex",
  justifyContent: "center",
  alignItems: "center",
  flexWrap: "wrap",
  gap: 8,
};

const buttonStyle: CSSProperties = {
  minHeight: 34,
  padding: "7px 12px",
  border: "1px solid #0e7490",
  borderRadius: 5,
  backgroundColor: "#164e63",
  color: "#f0f9ff",
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
};

const secondaryButtonStyle: CSSProperties = {
  ...buttonStyle,
  backgroundColor: "#192437",
  borderColor: "#475569",
};

// ============================================================
// 04 — ICON
// ============================================================

function ViewportErrorIcon() {
  return (
    <svg
      width={36}
      height={36}
      viewBox="0 0 24 24"
      fill="none"
      stroke="#fbbf24"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="m12 3 10 18H2L12 3Z" />
      <path d="M12 9v5" />
      <path d="M12 18h.01" />
    </svg>
  );
}

// ============================================================
// 05 — PURE FALLBACK PRESENTATION
// ============================================================

export function ViewportErrorFallback({
  plane,
  compact = false,
  allowRetry = true,
  recoveryStatus = "idle",
  onRetry,
  onReset,
  className = "",
}: ViewportErrorFallbackProps) {
  const planeName = viewportErrorPlaneLabel(plane);

  const recovering =
    recoveryStatus === "recovering";

  const canRetry =
    allowRetry &&
    !recovering &&
    typeof onRetry === "function";

  return (
    <section
      className={className}
      style={{
        ...rootStyle,
        padding: compact ? 12 : 18,
        gap: compact ? 7 : 11,
      }}
      role="alert"
      aria-label={`${planeName} viewport error`}
      aria-busy={recovering}
      data-viewport-error-fallback="true"
      data-viewport-error-plane={plane}
      data-viewport-recovery-status={recoveryStatus}
    >
      <ViewportErrorIcon />

      <strong
        style={{
          fontSize: compact ? 13 : 15,
          color: "#f8fafc",
        }}
      >
        {planeName}: {VIEWPORT_ERROR_FALLBACK_MESSAGES.title}
      </strong>

      <span style={descriptionStyle}>
        {VIEWPORT_ERROR_FALLBACK_MESSAGES.description}
      </span>

      <div style={buttonRowStyle}>
        {allowRetry && (
          <button
            type="button"
            style={{
              ...buttonStyle,
              opacity: canRetry ? 1 : 0.5,
            }}
            disabled={!canRetry}
            onClick={onRetry}
            aria-label={`Retry ${planeName} viewport`}
            data-viewport-error-retry="true"
          >
            {recovering
              ? VIEWPORT_ERROR_FALLBACK_MESSAGES.retrying
              : VIEWPORT_ERROR_FALLBACK_MESSAGES.retry}
          </button>
        )}

        {onReset && (
          <button
            type="button"
            style={secondaryButtonStyle}
            disabled={recovering}
            onClick={onReset}
            aria-label={`Reset ${planeName} view`}
            data-viewport-error-reset="true"
          >
            {VIEWPORT_ERROR_FALLBACK_MESSAGES.reset}
          </button>
        )}
      </div>

      {recoveryStatus === "failed" && (
        <span
          role="status"
          style={{
            ...descriptionStyle,
            color: "#fbbf24",
          }}
        >
          {VIEWPORT_ERROR_FALLBACK_MESSAGES.recoveryFailed}
        </span>
      )}

      {!compact && (
        <span style={descriptionStyle}>
          {VIEWPORT_ERROR_FALLBACK_MESSAGES.help}
        </span>
      )}
    </section>
  );
}

// ============================================================
// 06 — INTERNAL RECOVERY BRIDGE
// ============================================================

interface RecoveryBridgeProps {
  readonly plane: ViewportErrorPlane;
  readonly compact: boolean;
  readonly allowRetry: boolean;
  readonly onRetry?: (
    plane: ViewportErrorPlane,
  ) => void | Promise<void>;
  readonly onReset?: (
    plane: ViewportErrorPlane,
  ) => void;
  readonly onRecovered: () => void;
  readonly onFailure?: (
    category: ViewportBoundaryFailure,
    plane: ViewportErrorPlane,
  ) => void;
}

function RecoveryBridge({
  plane,
  compact,
  allowRetry,
  onRetry,
  onReset,
  onRecovered,
  onFailure,
}: RecoveryBridgeProps) {
  const [status, setStatus] =
    useState<ViewportRecoveryStatus>("idle");

  const handleRetry = useCallback(async (): Promise<void> => {
    if (status === "recovering") {
      return;
    }

    setStatus("recovering");

    try {
      await onRetry?.(plane);
      onRecovered();
    } catch {
      setStatus("failed");
      onFailure?.("recovery-error", plane);
    }
  }, [
    status,
    onRetry,
    onRecovered,
    onFailure,
    plane,
  ]);

  return (
    <ViewportErrorFallback
      plane={plane}
      compact={compact}
      allowRetry={allowRetry}
      recoveryStatus={status}
      onRetry={() => {
        void handleRetry();
      }}
      onReset={
        onReset
          ? () => onReset(plane)
          : undefined
      }
    />
  );
}

// ============================================================
// 07 — CLASS ERROR BOUNDARY
// ============================================================

export class ViewportErrorBoundary extends Component<
  ViewportErrorBoundaryProps,
  ViewportErrorBoundaryState
> {
  constructor(props: ViewportErrorBoundaryProps) {
    super(props);

    this.state = {
      hasError: false,
      revision: 0,
      resetKey: props.resetKey,
    };
  }

  static getDerivedStateFromError(
    _error: Error,
  ): Partial<ViewportErrorBoundaryState> {
    return {
      hasError: true,
    };
  }

  /**
   * Respond to a parent-provided identity revision.
   * Do not use PHI or DICOM UIDs as reset keys.
   */
  static getDerivedStateFromProps(
    props: ViewportErrorBoundaryProps,
    state: ViewportErrorBoundaryState,
  ): Partial<ViewportErrorBoundaryState> | null {
    if (props.resetKey !== state.resetKey) {
      return {
        resetKey: props.resetKey,
        hasError: false,
        revision: state.revision + 1,
      };
    }

    return null;
  }

  componentDidCatch(
    _error: Error,
    _info: ErrorInfo,
  ): void {
    // Deliberately do not log error objects.
    // Error messages/stacks may contain sensitive
    // source paths or other metadata.
    this.props.onFailure?.(
      "render-error",
      this.props.plane,
    );
  }

  private recover = (): void => {
    this.setState((previous) => ({
      hasError: false,
      revision: previous.revision + 1,
    }));
  };

  render(): ReactNode {
    const {
      plane,
      children,
      compact = false,
      allowRetry = true,
      onRetry,
      onReset,
      onFailure,
    } = this.props;

    if (this.state.hasError) {
      return (
        <RecoveryBridge
          plane={plane}
          compact={compact}
          allowRetry={allowRetry}
          onRetry={onRetry}
          onReset={onReset}
          onRecovered={this.recover}
          onFailure={onFailure}
        />
      );
    }

    return (
      <div
        key={this.state.revision}
        style={{
          position: "relative",
          width: "100%",
          height: "100%",
          minWidth: 0,
          minHeight: 0,
        }}
        data-viewport-error-boundary="true"
        data-viewport-error-plane={plane}
      >
        {children}
      </div>
    );
  }
}

// ============================================================
// 08 — CAPABILITIES
// ============================================================

export function getViewportErrorFallbackCapabilities() {
  return {
    axialSupport: true,
    coronalSupport: true,
    sagittalSupport: true,
    viewportScopedErrorBoundary: true,
    reactRenderErrorCapture: true,
    lifecycleErrorCapture: true,
    rawErrorMessagesDisplayed: false,
    rawErrorObjectsLogged: false,
    fixedFallbackMessages: true,
    controlledAsyncRetry: true,
    parentControlledReset: true,
    parentResetKeySupport: true,
    retryFailureHandling: true,
    compactLayout: true,
    accessibleFallback: true,
    eventHandlerErrorCapture: false,
    rejectedPromiseCapture: false,
    directNetworkRequests: false,
    browserPersistence: false,
    originalDICOMModification: false,
    clinicalValidationComplete: false,
  } as const;
}

// ============================================================
// END OF SINUS VIEWER VIEWPORT ERROR FALLBACK
// ============================================================
