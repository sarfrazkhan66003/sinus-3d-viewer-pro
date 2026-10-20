
/**
 * SINUS VIEWER — REACT ERROR BOUNDARY
 * ===================================
 *
 * Safely isolates unexpected React rendering errors.
 *
 * Features:
 * - React class-based error boundary.
 * - Catch render and component lifecycle failures.
 * - Generic, non-sensitive error messages.
 * - Retry through child subtree remounting.
 * - External reset using resetKeys.
 * - Optional parent-controlled reset and navigation.
 * - Recovery attempt counter.
 * - Compact and full-panel presentations.
 * - Accessible error and recovery controls.
 *
 * SECURITY:
 * - Never display Error.message or Error.stack.
 * - Never log component stacks or error objects.
 * - Never display patient identifiers or file paths.
 * - No HTTP requests or persistent browser storage.
 * - No access to original CT/CBCT DICOM files.
 *
 * LIMITATION:
 * React error boundaries do not catch errors in
 * event handlers, asynchronous operations, SSR,
 * or errors thrown by the boundary itself.
 *
 * Those failures must be handled at their source.
 */

import {
  Component,
  type CSSProperties,
  type ErrorInfo,
  type ReactNode,
} from "react";


// ============================================================
// 01 — PUBLIC TYPES
// ============================================================

export type ErrorBoundaryScope =
  | "application"
  | "dataset"
  | "viewer"
  | "preview"
  | "component";

export type ErrorBoundaryResetValue =
  | string
  | number
  | boolean
  | null;

export type ErrorBoundaryResetReason =
  | "retry"
  | "reset-keys"
  | "parent-reset";

export interface ErrorBoundaryProps {
  readonly children: ReactNode;

  readonly scope?: ErrorBoundaryScope;

  /**
   * Change these primitive values to reset the
   * boundary after an external selection change.
   *
   * Example: [datasetSessionId, seriesHandle].
   *
   * These values are never rendered or logged.
   */
  readonly resetKeys?: readonly ErrorBoundaryResetValue[];

  readonly compact?: boolean;
  readonly className?: string;

  readonly onReset?: (
    reason: ErrorBoundaryResetReason,
  ) => void;

  readonly onBack?: () => void;

  /**
   * Notification contains generic scope only,
   * never the thrown error or component stack.
   */
  readonly onError?: (
    scope: ErrorBoundaryScope,
  ) => void;
}

export interface ErrorBoundaryState {
  readonly hasError: boolean;
  readonly recoveryAttempts: number;
  readonly subtreeVersion: number;
}


// ============================================================
// 02 — CONSTANTS
// ============================================================

export const ERROR_BOUNDARY_MAX_ATTEMPTS = 5;

export const ERROR_BOUNDARY_DEFAULT_SCOPE:
  ErrorBoundaryScope = "component";


// ============================================================
// 03 — SAFE PRESENTATION LABELS
// ============================================================

function scopeTitle(
  scope: ErrorBoundaryScope,
): string {
  switch (scope) {
    case "application":
      return "Application unavailable";

    case "dataset":
      return "Dataset browser unavailable";

    case "viewer":
      return "Image viewer unavailable";

    case "preview":
      return "Preview display unavailable";

    case "component":
      return "Component unavailable";
  }
}

function scopeMessage(
  scope: ErrorBoundaryScope,
): string {
  switch (scope) {
    case "application":
      return (
        "The application encountered an unexpected " +
        "display error."
      );

    case "dataset":
      return (
        "The dataset browser could not be displayed."
      );

    case "viewer":
      return (
        "The medical image viewer could not be displayed."
      );

    case "preview":
      return (
        "The image preview panel could not be displayed."
      );

    case "component":
      return (
        "This section could not be displayed."
      );
  }
}


// ============================================================
// 04 — RESET KEY COMPARISON
// ============================================================

/**
 * Compare primitive reset keys without serialization.
 *
 * This avoids placing session handles or other values
 * into error strings, logs or JSON snapshots.
 */
export function errorBoundaryKeysChanged(
  previous: readonly ErrorBoundaryResetValue[],
  current: readonly ErrorBoundaryResetValue[],
): boolean {
  if (previous.length !== current.length) {
    return true;
  }

  for (let index = 0; index < current.length; index++) {
    if (!Object.is(previous[index], current[index])) {
      return true;
    }
  }

  return false;
}


// ============================================================
// 05 — STYLES
// ============================================================

const rootStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  width: "100%",
  minWidth: 0,
  minHeight: 220,
  boxSizing: "border-box",
  padding: 24,
  gap: 14,
  backgroundColor: "#101827",
  color: "#e2e8f0",
  border: "1px solid #344258",
  borderRadius: 8,
  textAlign: "center",
};

const iconContainerStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  width: 44,
  height: 44,
  borderRadius: "50%",
  border: "1px solid #854d0e",
  backgroundColor: "#422006",
  color: "#fde68a",
  fontSize: 22,
  fontWeight: 700,
};

const actionsStyle: CSSProperties = {
  display: "flex",
  justifyContent: "center",
  alignItems: "center",
  flexWrap: "wrap",
  gap: 8,
};

const buttonStyle: CSSProperties = {
  minHeight: 34,
  padding: "8px 12px",
  backgroundColor: "#192437",
  color: "#f8fafc",
  border: "1px solid #344258",
  borderRadius: 5,
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
};

const primaryButtonStyle: CSSProperties = {
  ...buttonStyle,
  backgroundColor: "#164e63",
  borderColor: "#38bdf8",
  color: "#e0f2fe",
};

const mutedStyle: CSSProperties = {
  color: "#94a3b8",
  fontSize: 12,
  lineHeight: 1.6,
  maxWidth: 480,
};


// ============================================================
// 06 — ERROR FALLBACK
// ============================================================

interface ErrorFallbackProps {
  readonly scope: ErrorBoundaryScope;
  readonly compact: boolean;
  readonly canRetry: boolean;
  readonly recoveryAttempts: number;
  readonly canGoBack: boolean;
  readonly onRetry: () => void;
  readonly onReset: () => void;
  readonly onBack: () => void;
  readonly className: string;
}

function ErrorFallback({
  scope,
  compact,
  canRetry,
  recoveryAttempts,
  canGoBack,
  onRetry,
  onReset,
  onBack,
  className,
}: ErrorFallbackProps) {
  return (
    <section
      className={className}
      style={{
        ...rootStyle,
        padding: compact ? 12 : 24,
        minHeight: compact ? 150 : 220,
        gap: compact ? 9 : 14,
      }}
      role="alert"
      aria-label={scopeTitle(scope)}
      data-error-boundary="fallback"
      data-error-scope={scope}
    >
      <div
        style={{
          ...iconContainerStyle,
          width: compact ? 32 : 44,
          height: compact ? 32 : 44,
          fontSize: compact ? 17 : 22,
        }}
        aria-hidden="true"
      >
        !
      </div>

      <strong
        style={{
          fontSize: compact ? 14 : 17,
          color: "#f8fafc",
        }}
      >
        {scopeTitle(scope)}
      </strong>

      <p style={{ ...mutedStyle, margin: 0 }}>
        {scopeMessage(scope)}
      </p>

      <div style={actionsStyle}>
        <button
          type="button"
          style={primaryButtonStyle}
          disabled={!canRetry}
          onClick={onRetry}
          title={
            canRetry
              ? "Retry rendering this section"
              : "Recovery attempts exhausted"
          }
        >
          Retry
        </button>

        <button
          type="button"
          style={buttonStyle}
          onClick={onReset}
        >
          Reset Section
        </button>

        {canGoBack && (
          <button
            type="button"
            style={buttonStyle}
            onClick={onBack}
          >
            Go Back
          </button>
        )}
      </div>

      {!canRetry && (
        <p style={{ ...mutedStyle, margin: 0 }}>
          Automatic retry limit reached.
          Use Reset Section or return to the
          previous application page.
        </p>
      )}

      {!compact && (
        <p style={{ ...mutedStyle, margin: 0 }}>
          Recovery attempts: {recoveryAttempts}
          {" / "}
          {ERROR_BOUNDARY_MAX_ATTEMPTS}
        </p>
      )}

      <p
        style={{
          ...mutedStyle,
          margin: 0,
          fontSize: 11,
        }}
      >
        Source medical images are unchanged.
        Diagnostic use requires separate validation.
      </p>
    </section>
  );
}


// ============================================================
// 07 — MAIN ERROR BOUNDARY
// ============================================================

export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  public static displayName = "ErrorBoundary";

  public state: ErrorBoundaryState = {
    hasError: false,
    recoveryAttempts: 0,
    subtreeVersion: 0,
  };

  // ==========================================================
  // 08 — REACT ERROR CAPTURE
  // ==========================================================

  public static getDerivedStateFromError(
    _error: Error,
  ): Partial<ErrorBoundaryState> {
    return {
      hasError: true,
    };
  }

  public componentDidCatch(
    _error: Error,
    _errorInfo: ErrorInfo,
  ): void {
    /**
     * Intentionally never log or forward the raw
     * exception or its React component stack.
     *
     * The hosting environment may independently
     * collect uncaught runtime diagnostics; do
     * not place patient information in component
     * props or error messages.
     */
    const scope =
      this.props.scope ??
      ERROR_BOUNDARY_DEFAULT_SCOPE;

    this.props.onError?.(scope);
  }

  // ==========================================================
  // 09 — EXTERNAL RESET KEYS
  // ==========================================================

  public componentDidUpdate(
    previousProps: Readonly<ErrorBoundaryProps>,
  ): void {
    const previousKeys =
      previousProps.resetKeys ?? [];

    const currentKeys =
      this.props.resetKeys ?? [];

    if (
      this.state.hasError &&
      errorBoundaryKeysChanged(
        previousKeys,
        currentKeys,
      )
    ) {
      this.resetBoundary(
        "reset-keys",
        false,
      );
    }
  }

  // ==========================================================
  // 10 — CONTROLLED RECOVERY
  // ==========================================================

  private resetBoundary = (
    reason: ErrorBoundaryResetReason,
    countAttempt: boolean,
  ): void => {
    const nextAttemptCount = countAttempt
      ? this.state.recoveryAttempts + 1
      : 0;

    this.setState(
      (previous) => ({
        hasError: false,
        recoveryAttempts: nextAttemptCount,
        subtreeVersion: previous.subtreeVersion + 1,
      }),
      () => {
        this.props.onReset?.(reason);
      },
    );
  };

  // ==========================================================
  // 11 — RETRY
  // ==========================================================

  private handleRetry = (): void => {
    if (
      this.state.recoveryAttempts >=
      ERROR_BOUNDARY_MAX_ATTEMPTS
    ) {
      return;
    }

    this.resetBoundary(
      "retry",
      true,
    );
  };

  // ==========================================================
  // 12 — EXPLICIT RESET
  // ==========================================================

  private handleReset = (): void => {
    /**
     * Explicit Reset Section starts a fresh recovery
     * sequence. A repeatedly failing child may throw
     * again; this boundary will catch the new failure.
     */
    this.resetBoundary(
      "parent-reset",
      false,
    );
  };

  // ==========================================================
  // 13 — NAVIGATE BACK
  // ==========================================================

  private handleBack = (): void => {
    this.props.onBack?.();
  };

  // ==========================================================
  // 14 — RENDER
  // ==========================================================

  public render(): ReactNode {
    if (!this.state.hasError) {
      /**
       * Remount the complete protected subtree after
       * a recovery attempt. This avoids retaining
       * partially initialized component state.
       */
      return (
        <div
          key={this.state.subtreeVersion}
          style={{
            display: "contents",
          }}
        >
          {this.props.children}
        </div>
      );
    }

    const scope =
      this.props.scope ??
      ERROR_BOUNDARY_DEFAULT_SCOPE;

    return (
      <ErrorFallback
        scope={scope}
        compact={this.props.compact ?? false}
        className={this.props.className ?? ""}
        canRetry={
          this.state.recoveryAttempts <
          ERROR_BOUNDARY_MAX_ATTEMPTS
        }
        recoveryAttempts={
          this.state.recoveryAttempts
        }
        canGoBack={
          typeof this.props.onBack === "function"
        }
        onRetry={this.handleRetry}
        onReset={this.handleReset}
        onBack={this.handleBack}
      />
    );
  }
}


// ============================================================
// 15 — COMPONENT CAPABILITIES
// ============================================================

export function getErrorBoundaryCapabilities() {
  return {
    renderErrorCapture: true,
    lifecycleErrorCapture: true,
    safeFallbackUI: true,
    retry: true,
    explicitReset: true,
    resetOnKeyChanges: true,
    parentNavigationCallback: true,
    subtreeRemount: true,
    recoveryAttemptLimit: true,
    genericErrorPresentation: true,
    rawExceptionLogging: false,
    rawStackRendering: false,
    asyncErrorCapture: false,
    eventHandlerErrorCapture: false,
    browserPersistence: false,
    directBackendRequests: false,
    originalDICOMAccess: false,
    modifiesSourceDataset: false,
    clinicalValidationComplete: false,
  } as const;
}


// ============================================================
// END OF SINUS VIEWER ERROR BOUNDARY
// ============================================================
