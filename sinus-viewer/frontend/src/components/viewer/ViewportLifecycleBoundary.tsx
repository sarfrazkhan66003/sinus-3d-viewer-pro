
/**
 * SINUS VIEWER — VIEWPORT LIFECYCLE BOUNDARY
 * ==========================================
 *
 * File 111
 *
 * Controls mounting of sensitive MPR content.
 *
 * The image subtree is mounted only when:
 * - Session access is authorized.
 * - The lifecycle phase is ready.
 * - Current frame is confirmed.
 * - Current and presented generations match.
 * - Generation values are valid.
 *
 * Safety:
 * - Old content is unmounted in blocked states.
 * - Session/volume generation changes remount
 *   the sensitive React subtree.
 * - No raw backend errors are displayed.
 * - No DICOM metadata or patient IDs are used.
 * - No network, storage or file operations.
 *
 * IMPORTANT:
 * This is a React display boundary.
 * Parent must also invalidate async render work,
 * clear external image caches, release resources,
 * and enforce backend authorization.
 *
 * Original DICOM dataset remains READ ONLY.
 */

import {
  type CSSProperties,
  type ReactNode,
} from "react";

// ============================================================
// 01 — PUBLIC TYPES
// ============================================================

export type LifecycleViewportPlane =
  | "axial"
  | "coronal"
  | "sagittal";

export type ViewportLifecyclePhase =
  | "idle"
  | "loading"
  | "decoding"
  | "preparing"
  | "rendering"
  | "ready"
  | "unavailable"
  | "error";

export type ViewportLifecycleBlockReason =
  | "unauthorized"
  | "invalid-generation"
  | "idle"
  | "loading"
  | "decoding"
  | "preparing"
  | "rendering"
  | "unavailable"
  | "error"
  | "frame-not-confirmed"
  | "generation-mismatch";

export interface ViewportLifecycleState {
  readonly phase: ViewportLifecyclePhase;

  /**
   * Must reflect current authorized session.
   * This is NOT a substitute for backend auth.
   */
  readonly authorized: boolean;

  /**
   * Opaque monotonically changing generation.
   * Never use DICOM UID or patient identifiers.
   */
  readonly currentGeneration: number;

  /**
   * Generation that produced the displayed frame.
   * Null means no accepted frame is available.
   */
  readonly presentedGeneration: number | null;

  /**
   * Parent confirms the current frame was accepted.
   * Must reset on new volume/render lifecycle.
   */
  readonly frameConfirmed: boolean;
}

export interface ViewportLifecycleDecision {
  readonly canShowImage: boolean;
  readonly reason: ViewportLifecycleBlockReason | null;
  readonly message: string;
}

export interface ViewportLifecycleBoundaryProps
  extends ViewportLifecycleState {
  readonly plane: LifecycleViewportPlane;

  /**
   * Sensitive image/canvas/measurement subtree.
   * Unmounted whenever display is not permitted.
   */
  readonly children: ReactNode;

  /**
   * Additional safe status UI for authorized users.
   * Never pass old pixels or raw backend errors.
   */
  readonly statusContent?: ReactNode;

  readonly showDefaultStatus?: boolean;
  readonly compact?: boolean;
  readonly className?: string;
}

// ============================================================
// 02 — SAFE STATUS CATALOG
// ============================================================

const LIFECYCLE_MESSAGES: Readonly<
  Record<ViewportLifecycleBlockReason, string>
> = {
  unauthorized: "Viewport access unavailable.",
  "invalid-generation": "Image session unavailable.",
  idle: "Select an image series.",
  loading: "Loading selected image volume.",
  decoding: "Decoding image frames.",
  preparing: "Preparing multiplanar views.",
  rendering: "Rendering current image.",
  unavailable: "Image view unavailable.",
  error: "Unable to display image.",
  "frame-not-confirmed":
    "Waiting for current image confirmation.",
  "generation-mismatch":
    "Waiting for current image volume.",
};

const VALID_PHASES: ReadonlySet<string> = new Set([
  "idle",
  "loading",
  "decoding",
  "preparing",
  "rendering",
  "ready",
  "unavailable",
  "error",
]);

// ============================================================
// 03 — PURE VALIDATION
// ============================================================

export function isValidLifecycleGeneration(
  value: unknown,
): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
  );
}

export function isViewportLifecyclePhase(
  value: unknown,
): value is ViewportLifecyclePhase {
  return (
    typeof value === "string" &&
    VALID_PHASES.has(value)
  );
}

export function lifecycleViewportPlaneLabel(
  plane: LifecycleViewportPlane,
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
// 04 — PURE LIFECYCLE DECISION
// ============================================================

/**
 * Fail closed.
 *
 * Ready alone is not sufficient. Parent must
 * confirm the current image frame and generation.
 *
 * Geometry validation remains independent;
 * it must gate physical scales, orientation
 * labels and anatomical coordinates separately.
 */
export function decideViewportLifecycle(
  state: ViewportLifecycleState,
): ViewportLifecycleDecision {
  if (state.authorized !== true) {
    return {
      canShowImage: false,
      reason: "unauthorized",
      message: LIFECYCLE_MESSAGES.unauthorized,
    };
  }

  if (
    !isValidLifecycleGeneration(
      state.currentGeneration,
    )
  ) {
    return {
      canShowImage: false,
      reason: "invalid-generation",
      message:
        LIFECYCLE_MESSAGES["invalid-generation"],
    };
  }

  if (!isViewportLifecyclePhase(state.phase)) {
    return {
      canShowImage: false,
      reason: "unavailable",
      message: LIFECYCLE_MESSAGES.unavailable,
    };
  }

  if (state.phase !== "ready") {
    return {
      canShowImage: false,
      reason: state.phase,
      message: LIFECYCLE_MESSAGES[state.phase],
    };
  }

  if (state.frameConfirmed !== true) {
    return {
      canShowImage: false,
      reason: "frame-not-confirmed",
      message:
        LIFECYCLE_MESSAGES["frame-not-confirmed"],
    };
  }

  if (
    !isValidLifecycleGeneration(
      state.presentedGeneration,
    ) ||
    state.presentedGeneration !==
      state.currentGeneration
  ) {
    return {
      canShowImage: false,
      reason: "generation-mismatch",
      message:
        LIFECYCLE_MESSAGES["generation-mismatch"],
    };
  }

  return {
    canShowImage: true,
    reason: null,
    message: "",
  };
}

// ============================================================
// 05 — STYLES
// ============================================================

const rootStyle: CSSProperties = {
  position: "relative",
  display: "block",
  width: "100%",
  height: "100%",
  minWidth: 0,
  minHeight: 0,
  overflow: "hidden",
  boxSizing: "border-box",
  backgroundColor: "#080f1b",
};

const contentStyle: CSSProperties = {
  position: "relative",
  width: "100%",
  height: "100%",
  minWidth: 0,
  minHeight: 0,
};

const fallbackStyle: CSSProperties = {
  position: "absolute",
  inset: 0,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: 8,
  padding: 16,
  overflow: "auto",
  boxSizing: "border-box",
  backgroundColor: "#080f1b",
  color: "#cbd5e1",
  textAlign: "center",
};

const headingStyle: CSSProperties = {
  margin: 0,
  fontSize: 13,
  fontWeight: 600,
  color: "#e2e8f0",
};

const messageStyle: CSSProperties = {
  margin: 0,
  maxWidth: 340,
  fontSize: 12,
  lineHeight: 1.6,
  color: "#94a3b8",
};

// ============================================================
// 06 — MAIN COMPONENT
// ============================================================

export function ViewportLifecycleBoundary({
  plane,
  phase,
  authorized,
  currentGeneration,
  presentedGeneration,
  frameConfirmed,
  children,
  statusContent,
  showDefaultStatus = true,
  compact = false,
  className = "",
}: ViewportLifecycleBoundaryProps) {
  const decision = decideViewportLifecycle({
    phase,
    authorized,
    currentGeneration,
    presentedGeneration,
    frameConfirmed,
  });

  const planeLabel =
    lifecycleViewportPlaneLabel(plane);

  /**
   * The key is opaque and non-identifying.
   * Changing volume generation remounts image
   * components and clears component-local state.
   *
   * External caches and GPU resources still
   * require cleanup by their owners.
   */
  const contentKey =
    `${plane}:${currentGeneration}`;

  const canShowCustomStatus =
    authorized === true &&
    statusContent !== null &&
    statusContent !== undefined &&
    statusContent !== false;

  return (
    <div
      className={className}
      style={rootStyle}
      data-viewport-lifecycle-boundary="true"
      data-lifecycle-plane={plane}
      data-lifecycle-phase={
        isViewportLifecyclePhase(phase)
          ? phase
          : "unavailable"
      }
      data-lifecycle-image-visible={
        decision.canShowImage ? "true" : "false"
      }
      data-lifecycle-reason={
        decision.reason ?? "none"
      }
    >
      {decision.canShowImage ? (
        <div
          key={contentKey}
          style={contentStyle}
          data-lifecycle-content="true"
        >
          {children}
        </div>
      ) : (
        <div
          style={{
            ...fallbackStyle,
            padding: compact ? 10 : 16,
            gap: compact ? 5 : 8,
          }}
          role="status"
          aria-live="polite"
          aria-label={`${planeLabel} viewport status`}
          data-lifecycle-fallback="true"
        >
          {canShowCustomStatus ? (
            statusContent
          ) : (
            showDefaultStatus ||
            authorized !== true ? (
              <>
                <h3
                  style={{
                    ...headingStyle,
                    fontSize: compact ? 11 : 13,
                  }}
                >
                  {planeLabel} Viewport
                </h3>

                <p
                  style={{
                    ...messageStyle,
                    fontSize: compact ? 11 : 12,
                  }}
                >
                  {decision.message}
                </p>
              </>
            ) : null
          )}
        </div>
      )}
    </div>
  );
}

// ============================================================
// 07 — CAPABILITIES
// ============================================================

export function getViewportLifecycleBoundaryCapabilities() {
  return {
    axialSupport: true,
    coronalSupport: true,
    sagittalSupport: true,
    authorizationGate: true,
    validatedLifecyclePhase: true,
    readyPhaseRequired: true,
    currentFrameConfirmationRequired: true,
    validGenerationRequired: true,
    matchingPresentedGenerationRequired: true,
    staleFrameDisplayBlocked: true,
    generationKeyedReactRemount: true,
    interactiveChildrenUnmountedWhenBlocked: true,
    fixedSafeFallbackMessages: true,
    optionalAuthorizedStatusContent: true,
    unauthorizedCustomStatusBlocked: true,
    compactLayout: true,
    directDICOMAccess: false,
    directNetworkRequests: false,
    browserPersistence: false,
    externalCacheCleanup: false,
    backendAuthorizationEnforcement: false,
    clinicalGeometryVerification: false,
    sourceDatasetModification: false,
    clinicalValidationComplete: false,
  } as const;
}

// ============================================================
// END OF SINUS VIEWER VIEWPORT LIFECYCLE BOUNDARY — FILE 111
// ============================================================
