
/**
 * SINUS VIEWER — VIEWPORT SESSION ISOLATION
 * =========================================
 *
 * File 108
 *
 * Prevents an old session or volume generation
 * from remaining mounted in the current viewport.
 *
 * Features:
 * - Explicit session/volume generation token.
 * - Fail-closed authorization checks.
 * - Ready-state mount protection.
 * - React remount on generation change.
 * - Generation-aware async result validation.
 * - Optional generation-scoped AbortSignal.
 * - Cleanup of generation-scoped async work.
 * - Generic, non-identifying fallback messages.
 *
 * SECURITY LIMITATIONS:
 * - This is a frontend lifecycle guard.
 * - Backend must authorize every data request.
 * - Parent must increment generation before
 *   switching sessions or volumes.
 * - Parent must invalidate external render
 *   schedulers, caches and old measurements.
 * - Workers must respect cancellation signals.
 *
 * Never use patient names, paths or DICOM UIDs
 * as generation tokens.
 *
 * Original DICOM files remain strictly READ ONLY.
 */

import {
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
  type CSSProperties,
} from "react";

// ============================================================
// 01 — TYPES
// ============================================================

export type SessionIsolationPlane =
  | "axial"
  | "coronal"
  | "sagittal";

export type SessionIsolationReason =
  | "unauthorized"
  | "not-ready"
  | "invalid-generation";

export interface ViewportSessionIdentity {
  /**
   * Opaque, non-identifying integer.
   *
   * Parent increments this whenever:
   * - User/session changes.
   * - Selected volume changes.
   * - Authorization is revoked and restored.
   * - Previous content must be invalidated.
   *
   * A generation value must never be reused for
   * a different sensitive content lifecycle.
   */
  readonly generation: number;
  readonly authorized: boolean;
  readonly ready: boolean;
}

export interface ViewportIsolationDecision {
  readonly allowed: boolean;
  readonly generation: number | null;
  readonly reason: SessionIsolationReason | null;
  readonly message: string;
}

export interface ViewportSessionIsolationProps
  extends ViewportSessionIdentity {
  readonly plane: SessionIsolationPlane;
  readonly children: ReactNode;

  readonly showFallback?: boolean;
  readonly compact?: boolean;
  readonly className?: string;
}

export interface SessionBoundResult<TResult> {
  readonly generation: number;
  readonly value: TResult;
}

// ============================================================
// 02 — CONSTANTS
// ============================================================

export const SESSION_ISOLATION_MIN_GENERATION = 0;

export const SESSION_ISOLATION_MESSAGES: Readonly<
  Record<SessionIsolationReason, string>
> = {
  unauthorized: "Viewport access unavailable.",
  "not-ready": "Preparing selected image volume.",
  "invalid-generation":
    "Image session is unavailable.",
};

// ============================================================
// 03 — VALIDATION
// ============================================================

export function isValidSessionGeneration(
  value: unknown,
): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= SESSION_ISOLATION_MIN_GENERATION
  );
}

export function sessionIsolationPlaneLabel(
  plane: SessionIsolationPlane,
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

export function decideViewportSessionIsolation(
  identity: ViewportSessionIdentity,
): ViewportIsolationDecision {
  if (identity.authorized !== true) {
    return {
      allowed: false,
      generation: null,
      reason: "unauthorized",
      message: SESSION_ISOLATION_MESSAGES.unauthorized,
    };
  }

  if (!isValidSessionGeneration(
    identity.generation,
  )) {
    return {
      allowed: false,
      generation: null,
      reason: "invalid-generation",
      message:
        SESSION_ISOLATION_MESSAGES[
          "invalid-generation"
        ],
    };
  }

  if (identity.ready !== true) {
    return {
      allowed: false,
      generation: identity.generation,
      reason: "not-ready",
      message: SESSION_ISOLATION_MESSAGES[
        "not-ready"
      ],
    };
  }

  return {
    allowed: true,
    generation: identity.generation,
    reason: null,
    message: "",
  };
}

// ============================================================
// 04 — ASYNC RESULT VALIDATION
// ============================================================

/**
 * Parent must compare an async result's captured
 * generation to the CURRENT generation.
 *
 * This validation cannot check which DICOM volume
 * was used unless parent increments the generation
 * for every volume change.
 */
export function isCurrentSessionResult<TResult>(
  result: SessionBoundResult<TResult>,
  identity: ViewportSessionIdentity,
): boolean {
  const decision =
    decideViewportSessionIsolation(identity);

  return (
    decision.allowed &&
    result.generation === decision.generation
  );
}

// ============================================================
// 05 — GENERATION-SCOPED ABORT SIGNAL
// ============================================================

/**
 * Returns an AbortSignal for current generation.
 *
 * Signal is aborted on:
 * - generation change
 * - authorization change
 * - readiness loss
 * - component unmount
 *
 * This hook does not start network requests.
 */
export function useSessionIsolationSignal(
  identity: ViewportSessionIdentity,
): AbortSignal | null {
  const decision = decideViewportSessionIsolation(
    identity,
  );

  const controller = useMemo(() => {
    if (!decision.allowed) {
      return null;
    }

    return new AbortController();
  }, [
    decision.allowed,
    decision.generation,
  ]);

  useEffect(() => {
    return () => {
      controller?.abort();
    };
  }, [controller]);

  // Do not expose a usable signal for blocked states.
  return decision.allowed
    ? controller?.signal ?? null
    : null;
}

// ============================================================
// 06 — STYLES
// ============================================================

const rootStyle: CSSProperties = {
  position: "relative",
  width: "100%",
  height: "100%",
  minWidth: 0,
  minHeight: 0,
  overflow: "hidden",
  boxSizing: "border-box",
  backgroundColor: "#080f1b",
};

const fallbackStyle: CSSProperties = {
  position: "absolute",
  inset: 0,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 14,
  boxSizing: "border-box",
  color: "#94a3b8",
  backgroundColor: "#080f1b",
  fontSize: 12,
  textAlign: "center",
  lineHeight: 1.5,
};

// ============================================================
// 07 — ISOLATED VIEWPORT CONTENT
// ============================================================

interface IsolatedContentProps {
  readonly children: ReactNode;
  readonly plane: SessionIsolationPlane;
}

function IsolatedViewportContent({
  children,
  plane,
}: IsolatedContentProps) {
  const mountedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;
    };
  }, []);

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        minWidth: 0,
        minHeight: 0,
        position: "relative",
      }}
      data-isolated-viewport-content="true"
      data-isolation-plane={plane}
    >
      {children}
    </div>
  );
}

// ============================================================
// 08 — MAIN COMPONENT
// ============================================================

export function ViewportSessionIsolation({
  plane,
  generation,
  authorized,
  ready,
  children,
  showFallback = true,
  compact = false,
  className = "",
}: ViewportSessionIsolationProps) {
  const decision =
    decideViewportSessionIsolation({
      generation,
      authorized,
      ready,
    });

  const planeLabel =
    sessionIsolationPlaneLabel(plane);

  /**
   * A changed generation produces a different key,
   * remounting the React subtree instead of reusing
   * component-local image/measurement state.
   *
   * The key is numeric and contains no patient ID.
   */
  const contentKey =
    `${plane}:${generation}`;

  return (
    <div
      className={className}
      style={rootStyle}
      data-viewport-session-isolation="true"
      data-isolation-plane={plane}
      data-isolation-allowed={
        decision.allowed ? "true" : "false"
      }
      data-isolation-reason={
        decision.reason ?? "none"
      }
    >
      {decision.allowed ? (
        <IsolatedViewportContent
          key={contentKey}
          plane={plane}
        >
          {children}
        </IsolatedViewportContent>
      ) : (
        <div
          style={{
            ...fallbackStyle,
            fontSize: compact ? 11 : 12,
          }}
          role="status"
          aria-live="polite"
          aria-label={`${planeLabel} viewport status`}
          data-isolation-fallback="true"
        >
          {showFallback
            ? decision.message
            : null}
        </div>
      )}
    </div>
  );
}

// ============================================================
// 09 — CAPABILITIES
// ============================================================

export function getViewportSessionIsolationCapabilities() {
  return {
    axialSupport: true,
    coronalSupport: true,
    sagittalSupport: true,
    generationValidation: true,
    authorizationGate: true,
    readinessGate: true,
    failClosedDefaults: true,
    generationKeyedRemount: true,
    staleResultValidation: true,
    generationAbortSignal: true,
    asyncCleanupOnUnmount: true,
    genericFallbackMessages: true,
    sensitiveChildrenUnmountedWhenBlocked: true,
    noPatientIdentifiersInKeys: true,
    externalCacheInvalidation: false,
    externalRenderSchedulerInvalidation: false,
    backendAuthorizationEnforcement: false,
    directDICOMAccess: false,
    directNetworkRequests: false,
    browserPersistence: false,
    sourceDatasetModification: false,
    clinicalValidationComplete: false,
  } as const;
}

// ============================================================
// END OF SINUS VIEWER SESSION ISOLATION — FILE 108
// ============================================================
