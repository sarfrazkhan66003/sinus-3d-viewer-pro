
/**
 * SINUS VIEWER — VIEWPORT RECOVERY CONTROLLER
 * ===========================================
 *
 * File 109 — Manual retry and safe recovery.
 *
 * Features:
 * - Explicit manual retry only.
 * - No automatic repeated retry loops.
 * - Maximum retry attempt policy.
 * - Current-generation validation.
 * - Cooperative AbortSignal cancellation.
 * - Old asynchronous completion rejection.
 * - Fixed, privacy-safe error descriptions.
 * - Accessible retry button.
 * - React hook and ready-to-use component.
 *
 * Important:
 * - Parent must clear old visible image content.
 * - Parent must invalidate File 106 scheduler.
 * - Parent must enforce authorization.
 * - Parent controls actual recovery operation.
 * - No patient names, UIDs or file paths here.
 * - Original DICOM dataset remains READ ONLY.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";

// ============================================================
// 01 — PUBLIC TYPES
// ============================================================

export type RecoveryViewportPlane =
  | "axial"
  | "coronal"
  | "sagittal";

export type ViewportRecoveryPhase =
  | "idle"
  | "loading"
  | "ready"
  | "unavailable"
  | "error";

export type ViewportRecoveryStatus =
  | "idle"
  | "retrying"
  | "succeeded"
  | "failed"
  | "exhausted";

export type ViewportRecoveryFailureReason =
  | "load-failed"
  | "decode-failed"
  | "render-failed"
  | "resource-unavailable"
  | "unknown";

export interface ViewportRecoveryRequest {
  readonly plane: RecoveryViewportPlane;
  readonly generation: number;
  readonly attempt: number;
  readonly signal: AbortSignal;
}

export type ViewportRecoveryWorker = (
  request: ViewportRecoveryRequest,
) => Promise<void>;

export interface ViewportRecoveryOptions {
  readonly plane: RecoveryViewportPlane;

  /**
   * Opaque, non-identifying generation.
   * Increment whenever session/volume changes.
   */
  readonly generation: number;

  readonly authorized: boolean;
  readonly phase: ViewportRecoveryPhase;

  readonly onRetry: ViewportRecoveryWorker;

  readonly maxAttempts?: number;
  readonly failureReason?: ViewportRecoveryFailureReason;
}

export interface ViewportRecoveryControllerProps
  extends ViewportRecoveryOptions {
  readonly visible?: boolean;
  readonly compact?: boolean;
  readonly className?: string;
}

export interface ViewportRecoveryDecision {
  readonly allowed: boolean;
  readonly reason:
    | "unauthorized"
    | "invalid-generation"
    | "not-recoverable"
    | "busy"
    | "attempts-exhausted"
    | null;
}

export interface ViewportRecoverySnapshot {
  readonly status: ViewportRecoveryStatus;
  readonly attempts: number;
}

// ============================================================
// 02 — CONSTANTS
// ============================================================

export const VIEWPORT_RECOVERY_DEFAULT_MAX_ATTEMPTS = 3;
export const VIEWPORT_RECOVERY_HARD_MAX_ATTEMPTS = 5;

const RECOVERY_MESSAGES: Readonly<
  Record<ViewportRecoveryFailureReason, string>
> = {
  "load-failed":
    "The image could not be loaded.",
  "decode-failed":
    "The image frames could not be decoded.",
  "render-failed":
    "The image view could not be rendered.",
  "resource-unavailable":
    "Resources are temporarily unavailable.",
  unknown:
    "The image view is currently unavailable.",
};

// ============================================================
// 03 — PURE HELPERS
// ============================================================

export function isValidRecoveryGeneration(
  value: unknown,
): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
  );
}

export function normalizeRecoveryMaxAttempts(
  value: number | undefined,
): number {
  if (
    value === undefined ||
    !Number.isSafeInteger(value)
  ) {
    return VIEWPORT_RECOVERY_DEFAULT_MAX_ATTEMPTS;
  }

  return Math.max(
    1,
    Math.min(
      VIEWPORT_RECOVERY_HARD_MAX_ATTEMPTS,
      value,
    ),
  );
}

export function recoveryViewportPlaneLabel(
  plane: RecoveryViewportPlane,
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

export function safeRecoveryFailureMessage(
  reason: ViewportRecoveryFailureReason = "unknown",
): string {
  return Object.prototype.hasOwnProperty.call(
    RECOVERY_MESSAGES,
    reason,
  )
    ? RECOVERY_MESSAGES[reason]
    : RECOVERY_MESSAGES.unknown;
}

export function decideViewportRecovery(
  authorized: boolean,
  generation: number,
  phase: ViewportRecoveryPhase,
  status: ViewportRecoveryStatus,
  attempts: number,
  maxAttempts: number,
): ViewportRecoveryDecision {
  if (authorized !== true) {
    return {
      allowed: false,
      reason: "unauthorized",
    };
  }

  if (!isValidRecoveryGeneration(generation)) {
    return {
      allowed: false,
      reason: "invalid-generation",
    };
  }

  if (
    phase !== "error" &&
    phase !== "unavailable"
  ) {
    return {
      allowed: false,
      reason: "not-recoverable",
    };
  }

  if (status === "retrying") {
    return {
      allowed: false,
      reason: "busy",
    };
  }

  if (
    !Number.isSafeInteger(attempts) ||
    attempts < 0 ||
    attempts >= normalizeRecoveryMaxAttempts(
      maxAttempts,
    )
  ) {
    return {
      allowed: false,
      reason: "attempts-exhausted",
    };
  }

  return {
    allowed: true,
    reason: null,
  };
}

// ============================================================
// 04 — REACT HOOK
// ============================================================

export function useViewportRecoveryController(
  options: ViewportRecoveryOptions,
) {
  const [snapshot, setSnapshot] =
    useState<ViewportRecoverySnapshot>({
      status: "idle",
      attempts: 0,
    });

  const workerRef = useRef(options.onRetry);
  workerRef.current = options.onRetry;

  const identityRef = useRef({
    plane: options.plane,
    generation: options.generation,
    authorized: options.authorized,
  });

  const activeControllerRef =
    useRef<AbortController | null>(null);

  const activeOperationRef = useRef(false);
  const attemptCountRef = useRef(0);
  const operationTokenRef = useRef(0);

  const maximum = normalizeRecoveryMaxAttempts(
    options.maxAttempts,
  );

  /**
   * Immediately invalidate earlier operations
   * if identity changes between React renders.
   */
  const previousIdentity =
    identityRef.current;

  if (
    previousIdentity.plane !== options.plane ||
    previousIdentity.generation !== options.generation ||
    previousIdentity.authorized !== options.authorized
  ) {
    ++operationTokenRef.current;
    activeControllerRef.current?.abort();
    activeControllerRef.current = null;
    activeOperationRef.current = false;
    attemptCountRef.current = 0;

    identityRef.current = {
      plane: options.plane,
      generation: options.generation,
      authorized: options.authorized,
    };
  }

  /**
   * Reset the displayed recovery state for a
   * new session, generation or authorization.
   */
  useEffect(() => {
    setSnapshot({
      status: "idle",
      attempts: 0,
    });

    return () => {
      ++operationTokenRef.current;
      activeControllerRef.current?.abort();
      activeControllerRef.current = null;
      activeOperationRef.current = false;
    };
  }, [
    options.plane,
    options.generation,
    options.authorized,
  ]);

  /**
   * A success does not mean image pixels are ready.
   * Parent must independently move its viewport
   * lifecycle to the correctly confirmed state.
   */
  const retry = useCallback(async (): Promise<boolean> => {
    const identity = identityRef.current;

    const decision = decideViewportRecovery(
      identity.authorized,
      identity.generation,
      options.phase,
      activeOperationRef.current
        ? "retrying"
        : snapshot.status,
      attemptCountRef.current,
      maximum,
    );

    if (!decision.allowed) {
      return false;
    }

    const controller = new AbortController();

    activeControllerRef.current = controller;
    activeOperationRef.current = true;

    const token = ++operationTokenRef.current;
    const attempt = ++attemptCountRef.current;

    setSnapshot({
      status: "retrying",
      attempts: attempt,
    });

    const isCurrent = (): boolean => {
      const current = identityRef.current;

      return (
        operationTokenRef.current === token &&
        current.plane === identity.plane &&
        current.generation === identity.generation &&
        current.authorized === true &&
        !controller.signal.aborted
      );
    };

    try {
      await workerRef.current({
        plane: identity.plane,
        generation: identity.generation,
        attempt,
        signal: controller.signal,
      });

      if (!isCurrent()) {
        return false;
      }

      setSnapshot({
        status: "succeeded",
        attempts: attempt,
      });

      return true;
    } catch {
      if (!isCurrent()) {
        return false;
      }

      setSnapshot({
        status:
          attempt >= maximum
            ? "exhausted"
            : "failed",
        attempts: attempt,
      });

      return false;
    } finally {
      if (
        activeControllerRef.current === controller
      ) {
        activeControllerRef.current = null;
      }

      if (operationTokenRef.current === token) {
        activeOperationRef.current = false;
      }
    }
  }, [
    maximum,
    options.phase,
    snapshot.status,
  ]);

  const cancel = useCallback((): void => {
    ++operationTokenRef.current;
    activeControllerRef.current?.abort();
    activeControllerRef.current = null;
    activeOperationRef.current = false;

    setSnapshot({
      status: "idle",
      attempts: attemptCountRef.current,
    });
  }, []);

  const decision = decideViewportRecovery(
    options.authorized,
    options.generation,
    options.phase,
    activeOperationRef.current
      ? "retrying"
      : snapshot.status,
    attemptCountRef.current,
    maximum,
  );

  return {
    snapshot,
    canRetry: decision.allowed,
    blockedReason: decision.reason,
    maxAttempts: maximum,
    retry,
    cancel,
  };
}

// ============================================================
// 05 — STYLES
// ============================================================

const rootStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 9,
  maxWidth: 340,
  padding: 12,
  border: "1px solid #475569",
  borderRadius: 8,
  backgroundColor: "#101827",
  color: "#e2e8f0",
  boxSizing: "border-box",
};

const buttonStyle: CSSProperties = {
  alignSelf: "center",
  minHeight: 34,
  padding: "6px 14px",
  border: "1px solid #64748b",
  borderRadius: 6,
  backgroundColor: "#1e293b",
  color: "#f8fafc",
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
};

const descriptionStyle: CSSProperties = {
  margin: 0,
  color: "#94a3b8",
  fontSize: 12,
  lineHeight: 1.5,
  textAlign: "center",
};

// ============================================================
// 06 — UI COMPONENT
// ============================================================

export function ViewportRecoveryController({
  plane,
  generation,
  authorized,
  phase,
  onRetry,
  maxAttempts,
  failureReason = "unknown",
  visible = true,
  compact = false,
  className = "",
}: ViewportRecoveryControllerProps) {
  const recovery = useViewportRecoveryController({
    plane,
    generation,
    authorized,
    phase,
    onRetry,
    maxAttempts,
    failureReason,
  });

  if (!visible) {
    return null;
  }

  const planeLabel =
    recoveryViewportPlaneLabel(plane);

  const message =
    safeRecoveryFailureMessage(
      failureReason,
    );

  const busy =
    recovery.snapshot.status === "retrying";

  const exhausted =
    recovery.blockedReason ===
    "attempts-exhausted";

  return (
    <section
      className={className}
      style={{
        ...rootStyle,
        padding: compact ? 8 : 12,
        gap: compact ? 6 : 9,
      }}
      role="group"
      aria-label={`${planeLabel} recovery controls`}
      aria-busy={busy}
      data-viewport-recovery="true"
      data-recovery-plane={plane}
      data-recovery-status={
        recovery.snapshot.status
      }
    >
      <strong
        style={{
          textAlign: "center",
          fontSize: compact ? 11 : 13,
        }}
      >
        {planeLabel} Viewport Recovery
      </strong>

      <p style={descriptionStyle}>
        {authorized
          ? message
          : "Viewport access unavailable."}
      </p>

      {busy && (
        <p
          style={descriptionStyle}
          role="status"
          aria-live="polite"
        >
          Retrying image preparation...
        </p>
      )}

      {exhausted && (
        <p style={descriptionStyle}>
          Retry limit reached for this image session.
        </p>
      )}

      {recovery.snapshot.status ===
        "succeeded" && (
        <p
          style={descriptionStyle}
          role="status"
        >
          Recovery request completed.
          Waiting for image readiness confirmation.
        </p>
      )}

      {authorized && (
        <button
          type="button"
          style={{
            ...buttonStyle,
            opacity: recovery.canRetry ? 1 : 0.55,
            cursor: recovery.canRetry
              ? "pointer"
              : "not-allowed",
          }}
          disabled={!recovery.canRetry}
          onClick={() => {
            void recovery.retry();
          }}
          data-recovery-retry-button="true"
        >
          {busy ? "Retrying..." : "Retry image"}
        </button>
      )}

      {authorized &&
        recovery.snapshot.attempts > 0 && (
        <span
          style={{
            color: "#64748b",
            textAlign: "center",
            fontSize: 10,
          }}
        >
          Attempts: {recovery.snapshot.attempts}
          {" / "}
          {recovery.maxAttempts}
        </span>
      )}
    </section>
  );
}

// ============================================================
// 07 — CAPABILITIES
// ============================================================

export function getViewportRecoveryControllerCapabilities() {
  return {
    axialSupport: true,
    coronalSupport: true,
    sagittalSupport: true,
    manualRetryOnly: true,
    maximumAttemptLimit: true,
    generationValidation: true,
    authorizationGate: true,
    recoverablePhaseGate: true,
    duplicateRetryProtection: true,
    abortSignalSupport: true,
    staleCompletionRejection: true,
    safeFailureMessages: true,
    accessibleRetryButton: true,
    retryStateFeedback: true,
    ReactHookSupport: true,
    parentOwnedRecoveryWorker: true,
    automaticRetryLoops: false,
    rawBackendErrorDisplay: false,
    directDICOMAccess: false,
    networkRequests: false,
    browserPersistence: false,
    sourceDatasetModification: false,
    clinicalValidationComplete: false,
  } as const;
}

// ============================================================
// END OF SINUS VIEWER VIEWPORT RECOVERY CONTROLLER — FILE 109
// ============================================================
