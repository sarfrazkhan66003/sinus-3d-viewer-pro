
/**
 * SINUS VIEWER — VIEWPORT INTERACTION GUARD
 * =========================================
 *
 * Controls whether an MPR viewport subtree may
 * be mounted and interacted with.
 *
 * Supported phases:
 * - idle
 * - loading
 * - decoding
 * - preparing
 * - rendering
 * - ready
 * - unavailable
 * - error
 *
 * Security and privacy rules:
 * - Deny by default.
 * - Explicit authorization is required.
 * - Only a ready and enabled viewport is mounted.
 * - Blocked states unmount interactive children.
 * - Stale patient pixels are not displayed here.
 * - No raw errors, patient names, UIDs or paths.
 * - No direct DICOM, clipboard or network access.
 *
 * The parent must ALSO:
 * - Enforce authorization in backend services.
 * - Invalidate old async image responses.
 * - Clear or release stale renderer resources.
 * - Disable external/global keyboard commands.
 *
 * This is a UI guard, not an authorization boundary
 * or a replacement for secure backend validation.
 */

import {
  type CSSProperties,
  type ReactNode,
} from "react";

// ============================================================
// 01 — PUBLIC TYPES
// ============================================================

export type InteractionGuardPlane =
  | "axial"
  | "coronal"
  | "sagittal";

export type InteractionGuardPhase =
  | "idle"
  | "loading"
  | "decoding"
  | "preparing"
  | "rendering"
  | "ready"
  | "unavailable"
  | "error";

export type InteractionBlockReason =
  | "unauthorized"
  | "disabled"
  | "idle"
  | "loading"
  | "decoding"
  | "preparing"
  | "rendering"
  | "unavailable"
  | "error";

export interface ViewportInteractionGuardProps {
  readonly plane: InteractionGuardPlane;

  /**
   * Parent-managed current-session permission.
   * This must not replace backend access controls.
   */
  readonly authorized: boolean;

  readonly phase: InteractionGuardPhase;

  /**
   * Enables interaction only in ready state.
   */
  readonly enabled?: boolean;

  /**
   * Existing canvas, navigation tools and overlays.
   * These are NOT mounted in blocked states.
   */
  readonly children: ReactNode;

  /**
   * Optional safe, non-identifying status element.
   *
   * Do not pass raw backend error text, patient
   * metadata, source paths or previous image pixels.
   *
   * This remains visible even when children are
   * blocked, provided the user is authorized.
   */
  readonly blockedStatus?: ReactNode;

  /**
   * If true, the default safe status message is
   * shown when blockedStatus is absent.
   */
  readonly showDefaultStatus?: boolean;

  readonly compact?: boolean;
  readonly className?: string;
}

export interface InteractionGuardDecision {
  readonly allowed: boolean;
  readonly reason: InteractionBlockReason | null;
  readonly displayMessage: string;
}

// ============================================================
// 02 — FIXED STATUS CATALOG
// ============================================================

const BLOCK_MESSAGES: Readonly<
  Record<InteractionBlockReason, string>
> = {
  unauthorized: "Viewport access unavailable.",
  disabled: "Viewport interaction disabled.",
  idle: "Select an image series.",
  loading: "Loading image volume.",
  decoding: "Decoding image frames.",
  preparing: "Preparing multiplanar views.",
  rendering: "Rendering image view.",
  unavailable: "No image available.",
  error: "Unable to display image.",
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
// 03 — PURE HELPERS
// ============================================================

export function isInteractionGuardPhase(
  value: unknown,
): value is InteractionGuardPhase {
  return (
    typeof value === "string" &&
    VALID_PHASES.has(value)
  );
}

export function interactionGuardPlaneLabel(
  plane: InteractionGuardPlane,
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

/**
 * Fail-closed interaction decision.
 *
 * Any invalid phase results in an unavailable
 * placeholder instead of mounting image controls.
 */
export function decideViewportInteraction(
  authorized: boolean,
  enabled: boolean,
  phase: unknown,
): InteractionGuardDecision {
  if (authorized !== true) {
    return {
      allowed: false,
      reason: "unauthorized",
      displayMessage: BLOCK_MESSAGES.unauthorized,
    };
  }

  if (!isInteractionGuardPhase(phase)) {
    return {
      allowed: false,
      reason: "unavailable",
      displayMessage: BLOCK_MESSAGES.unavailable,
    };
  }

  if (phase !== "ready") {
    return {
      allowed: false,
      reason: phase,
      displayMessage: BLOCK_MESSAGES[phase],
    };
  }

  if (enabled !== true) {
    return {
      allowed: false,
      reason: "disabled",
      displayMessage: BLOCK_MESSAGES.disabled,
    };
  }

  return {
    allowed: true,
    reason: null,
    displayMessage: "",
  };
}

// ============================================================
// 04 — STYLES
// ============================================================

const rootStyle: CSSProperties = {
  position: "relative",
  display: "block",
  width: "100%",
  height: "100%",
  minWidth: 0,
  minHeight: 0,
  overflow: "hidden",
  backgroundColor: "#080f1b",
  boxSizing: "border-box",
};

const blockedStyle: CSSProperties = {
  position: "absolute",
  inset: 0,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: 10,
  overflow: "auto",
  padding: 16,
  boxSizing: "border-box",
  backgroundColor: "#080f1b",
  color: "#cbd5e1",
  textAlign: "center",
};

const neutralIconStyle: CSSProperties = {
  width: 38,
  height: 38,
  color: "#64748b",
};

const descriptionStyle: CSSProperties = {
  maxWidth: 310,
  margin: 0,
  fontSize: 12,
  lineHeight: 1.6,
  color: "#94a3b8",
};

// ============================================================
// 05 — NEUTRAL STATUS ICON
// ============================================================

function BlockedViewportIcon() {
  return (
    <svg
      viewBox="0 0 40 40"
      style={neutralIconStyle}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="5" y="6" width="30" height="28" rx="4" />
      <path d="M12 20h16" />
      <path d="M20 12v16" />
    </svg>
  );
}

// ============================================================
// 06 — MAIN COMPONENT
// ============================================================

export function ViewportInteractionGuard({
  plane,
  authorized,
  phase,
  enabled = true,
  children,
  blockedStatus,
  showDefaultStatus = true,
  compact = false,
  className = "",
}: ViewportInteractionGuardProps) {
  const decision = decideViewportInteraction(
    authorized,
    enabled,
    phase,
  );

  const planeLabel =
    interactionGuardPlaneLabel(plane);

  /**
   * READY:
   *
   * Preserve existing React children exactly.
   * Their pointer and keyboard actions continue
   * to be managed by the existing viewport code.
   */
  if (decision.allowed) {
    return (
      <div
        className={className}
        style={rootStyle}
        data-viewport-interaction-guard="true"
        data-interaction-plane={plane}
        data-interaction-allowed="true"
        data-interaction-reason="none"
      >
        {children}
      </div>
    );
  }

  /**
   * BLOCKED:
   *
   * The interactive children are not rendered.
   * Therefore child canvas, mouse handlers and
   * focused keyboard controls are removed from
   * this part of the React tree.
   *
   * An unauthorized user never receives the
   * custom blockedStatus; it is replaced with
   * a fixed, generic message.
   */
  const safeCustomStatus =
    authorized === true
      ? blockedStatus
      : null;

  const hasCustomStatus =
    safeCustomStatus !== null &&
    safeCustomStatus !== undefined &&
    safeCustomStatus !== false;

  return (
    <div
      className={className}
      style={rootStyle}
      data-viewport-interaction-guard="true"
      data-interaction-plane={plane}
      data-interaction-allowed="false"
      data-interaction-reason={
        decision.reason ?? "unavailable"
      }
    >
      <div
        style={{
          ...blockedStyle,
          padding: compact ? 10 : 16,
          gap: compact ? 6 : 10,
        }}
        role="status"
        aria-label={`${planeLabel} viewport state`}
        aria-live="polite"
        data-interaction-blocked="true"
      >
        {hasCustomStatus ? (
          safeCustomStatus
        ) : showDefaultStatus ||
          authorized !== true ? (
          <>
            <BlockedViewportIcon />

            <strong
              style={{
                fontSize: compact ? 12 : 14,
                color: "#e2e8f0",
              }}
            >
              {planeLabel} Viewport
            </strong>

            <p style={descriptionStyle}>
              {decision.displayMessage}
            </p>
          </>
        ) : null}
      </div>
    </div>
  );
}

// ============================================================
// 07 — CAPABILITIES
// ============================================================

export function getViewportInteractionGuardCapabilities() {
  return {
    axialSupport: true,
    coronalSupport: true,
    sagittalSupport: true,
    denyByDefault: true,
    authorizationGate: true,
    readyStateRequired: true,
    enabledStateRequired: true,
    loadingInteractionBlocking: true,
    decodingInteractionBlocking: true,
    preparingInteractionBlocking: true,
    renderingInteractionBlocking: true,
    errorInteractionBlocking: true,
    unavailableInteractionBlocking: true,
    disabledInteractionBlocking: true,
    interactiveChildrenUnmountedWhenBlocked: true,
    safeStatusMessages: true,
    optionalParentStatusSlot: true,
    unauthorizedCustomStatusBlocked: true,
    noStaleChildImageRendering: true,
    compactLayout: true,
    directDICOMAccess: false,
    directNetworkRequests: false,
    clipboardAccess: false,
    browserPersistence: false,
    backendAuthorizationEnforcement: false,
    externalGlobalShortcutBlocking: false,
    originalDatasetModification: false,
    clinicalValidationComplete: false,
  } as const;
}

// ============================================================
// END OF SINUS VIEWER INTERACTION GUARD
// ============================================================
