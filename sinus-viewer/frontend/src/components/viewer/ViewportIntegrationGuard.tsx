
/**
 * SINUS VIEWER — VIEWPORT INTEGRATION GUARD
 * =========================================
 *
 * FILE 116
 *
 * Central, parent-controlled MPR integration gate.
 *
 * Evaluates:
 * - Authorization and current volume identity
 * - Current render revision acceptance
 * - Stale-frame protection
 * - Geometry verification for current generation
 * - Synchronization for current navigation revision
 * - Recovery/cleanup operational state
 *
 * This is a presentation and integration layer.
 *
 * It does not independently:
 * - Authenticate users
 * - Decode or modify DICOM files
 * - Verify clinical geometry
 * - Cancel external render tasks
 * - Dispose GPU/worker resources
 *
 * Parent must invalidate stale work and release
 * temporary resources on lifecycle changes.
 *
 * Original DICOM dataset remains READ ONLY.
 */

import {
  useMemo,
  type CSSProperties,
  type ReactNode,
} from "react";

// ============================================================
// 01 — TYPES
// ============================================================

export type IntegrationViewportPlane =
  | "axial"
  | "coronal"
  | "sagittal";

export type IntegrationViewportPhase =
  | "idle"
  | "loading"
  | "decoding"
  | "preparing"
  | "rendering"
  | "ready"
  | "unavailable"
  | "error";

export type IntegrationRecoveryPhase =
  | "idle"
  | "retrying"
  | "succeeded"
  | "failed"
  | "exhausted";

export type IntegrationBlockReason =
  | "unauthorized"
  | "invalid-generation"
  | "invalid-revision"
  | "cleanup-in-progress"
  | "recovery-in-progress"
  | "not-ready"
  | "frame-unconfirmed"
  | "stale-frame"
  | "render-revision-mismatch"
  | "stale-protection-unconfirmed"
  | "geometry-unverified"
  | "geometry-generation-mismatch"
  | "sync-unconfirmed"
  | "sync-generation-mismatch"
  | "sync-revision-mismatch";

export interface ViewportIntegrationState {
  readonly authorized: boolean;
  readonly phase: IntegrationViewportPhase;

  /**
   * Opaque, non-identifying integer.
   * Never use patient names, DICOM UIDs or paths.
   */
  readonly generation: number;

  readonly presentedGeneration: number | null;

  /**
   * Current and accepted render identities.
   */
  readonly renderRevision: number;
  readonly acceptedRenderRevision: number | null;

  readonly frameConfirmed: boolean;
  readonly staleRenderProtectionConfirmed: boolean;

  /**
   * External resource cleanup must be requested
   * and handled by the parent.
   */
  readonly cleanupInProgress: boolean;

  readonly recoveryPhase: IntegrationRecoveryPhase;

  /**
   * Verified spatial geometry belongs to this
   * volume generation.
   */
  readonly geometryVerified: boolean;
  readonly geometryGeneration: number | null;

  /**
   * Current navigation update must be acknowledged.
   */
  readonly navigationRevision: number;
  readonly syncConfirmed: boolean;
  readonly syncGeneration: number | null;
  readonly syncRevision: number | null;
}

export interface IntegrationGateDecision {
  readonly allowed: boolean;
  readonly reason: IntegrationBlockReason | null;
}

export interface ViewportIntegrationEvaluation {
  readonly image: IntegrationGateDecision;
  readonly physicalOverlays: IntegrationGateDecision;
  readonly synchronizedOverlays: IntegrationGateDecision;
}

export interface ViewportIntegrationGuardProps {
  readonly plane: IntegrationViewportPlane;
  readonly state: ViewportIntegrationState;

  /**
   * Render only while matching gate is allowed.
   * Sensitive children are not mounted when blocked.
   */
  readonly imageContent?: ReactNode;
  readonly physicalOverlayContent?: ReactNode;
  readonly synchronizedOverlayContent?: ReactNode;

  readonly showStatus?: boolean;
  readonly compact?: boolean;
  readonly className?: string;
}

// ============================================================
// 02 — FIXED LABELS
// ============================================================

const INTEGRATION_MESSAGES: Readonly<
  Record<IntegrationBlockReason, string>
> = {
  unauthorized: "Viewport access unavailable.",
  "invalid-generation": "Current volume identity unavailable.",
  "invalid-revision": "Current render identity unavailable.",
  "cleanup-in-progress": "Releasing previous viewport resources.",
  "recovery-in-progress": "Recovering current viewport.",
  "not-ready": "Current image is not ready.",
  "frame-unconfirmed": "Current frame has not been confirmed.",
  "stale-frame": "Frame belongs to an earlier volume.",
  "render-revision-mismatch": "Current rendering update is pending.",
  "stale-protection-unconfirmed": "Render isolation is not confirmed.",
  "geometry-unverified": "Spatial geometry is not verified.",
  "geometry-generation-mismatch": "Geometry is from another volume.",
  "sync-unconfirmed": "MPR synchronization is not confirmed.",
  "sync-generation-mismatch": "Synchronization is from another volume.",
  "sync-revision-mismatch": "Navigation update is not confirmed.",
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

export function isValidIntegrationIdentity(
  value: unknown,
): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
  );
}

export function isIntegrationViewportPhase(
  value: unknown,
): value is IntegrationViewportPhase {
  return (
    typeof value === "string" &&
    VALID_PHASES.has(value)
  );
}

export function integrationPlaneLabel(
  plane: IntegrationViewportPlane,
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

function allowIntegration(): IntegrationGateDecision {
  return { allowed: true, reason: null };
}

function blockIntegration(
  reason: IntegrationBlockReason,
): IntegrationGateDecision {
  return { allowed: false, reason };
}

// ============================================================
// 04 — INTEGRATION EVALUATOR
// ============================================================

/**
 * Fail-closed decision model.
 *
 * Image presentation is independent of geometry,
 * but physical overlays require verified geometry.
 * Synchronized overlays additionally require an
 * acknowledged navigation revision.
 *
 * Input flags MUST originate from current parent
 * services; the UI does not establish their truth.
 */
export function evaluateViewportIntegration(
  state: ViewportIntegrationState,
): ViewportIntegrationEvaluation {
  let image: IntegrationGateDecision;

  if (state.authorized !== true) {
    image = blockIntegration("unauthorized");
  } else if (!isValidIntegrationIdentity(state.generation)) {
    image = blockIntegration("invalid-generation");
  } else if (
    !isValidIntegrationIdentity(state.renderRevision)
  ) {
    image = blockIntegration("invalid-revision");
  } else if (state.cleanupInProgress !== false) {
    image = blockIntegration("cleanup-in-progress");
  } else if (state.recoveryPhase === "retrying") {
    image = blockIntegration("recovery-in-progress");
  } else if (
    !isIntegrationViewportPhase(state.phase) ||
    state.phase !== "ready"
  ) {
    image = blockIntegration("not-ready");
  } else if (state.frameConfirmed !== true) {
    image = blockIntegration("frame-unconfirmed");
  } else if (
    !isValidIntegrationIdentity(state.presentedGeneration) ||
    state.presentedGeneration !== state.generation
  ) {
    image = blockIntegration("stale-frame");
  } else if (
    !isValidIntegrationIdentity(state.acceptedRenderRevision) ||
    state.acceptedRenderRevision !== state.renderRevision
  ) {
    image = blockIntegration("render-revision-mismatch");
  } else if (
    state.staleRenderProtectionConfirmed !== true
  ) {
    image = blockIntegration("stale-protection-unconfirmed");
  } else {
    image = allowIntegration();
  }

  let physicalOverlays: IntegrationGateDecision;

  if (!image.allowed) {
    physicalOverlays = { ...image };
  } else if (state.geometryVerified !== true) {
    physicalOverlays = blockIntegration("geometry-unverified");
  } else if (
    !isValidIntegrationIdentity(state.geometryGeneration) ||
    state.geometryGeneration !== state.generation
  ) {
    physicalOverlays = blockIntegration(
      "geometry-generation-mismatch",
    );
  } else {
    physicalOverlays = allowIntegration();
  }

  let synchronizedOverlays: IntegrationGateDecision;

  if (!physicalOverlays.allowed) {
    synchronizedOverlays = { ...physicalOverlays };
  } else if (state.syncConfirmed !== true) {
    synchronizedOverlays = blockIntegration("sync-unconfirmed");
  } else if (
    !isValidIntegrationIdentity(state.syncGeneration) ||
    state.syncGeneration !== state.generation
  ) {
    synchronizedOverlays = blockIntegration(
      "sync-generation-mismatch",
    );
  } else if (
    !isValidIntegrationIdentity(state.navigationRevision) ||
    !isValidIntegrationIdentity(state.syncRevision) ||
    state.syncRevision !== state.navigationRevision
  ) {
    synchronizedOverlays = blockIntegration(
      "sync-revision-mismatch",
    );
  } else {
    synchronizedOverlays = allowIntegration();
  }

  return {
    image,
    physicalOverlays,
    synchronizedOverlays,
  };
}

// ============================================================
// 05 — STYLES
// ============================================================

const statusStyle: CSSProperties = {
  padding: 10,
  borderRadius: 7,
  border: "1px solid #475569",
  backgroundColor: "#101827",
  color: "#e2e8f0",
  boxSizing: "border-box",
  maxWidth: 320,
};

const statusMessageStyle: CSSProperties = {
  color: "#94a3b8",
  fontSize: 11,
  lineHeight: 1.5,
  margin: "6px 0 0",
};

// ============================================================
// 06 — REACT COMPONENT
// ============================================================

export function ViewportIntegrationGuard({
  plane,
  state,
  imageContent,
  physicalOverlayContent,
  synchronizedOverlayContent,
  showStatus = false,
  compact = false,
  className = "",
}: ViewportIntegrationGuardProps) {
  const evaluation = useMemo(
    () => evaluateViewportIntegration(state),
    [
      state.authorized,
      state.phase,
      state.generation,
      state.presentedGeneration,
      state.renderRevision,
      state.acceptedRenderRevision,
      state.frameConfirmed,
      state.staleRenderProtectionConfirmed,
      state.cleanupInProgress,
      state.recoveryPhase,
      state.geometryVerified,
      state.geometryGeneration,
      state.navigationRevision,
      state.syncConfirmed,
      state.syncGeneration,
      state.syncRevision,
    ],
  );

  const planeLabel = integrationPlaneLabel(plane);

  /**
   * React remounts the image subtree whenever
   * the opaque volume or render identity changes.
   * External resources require separate cleanup.
   */
  const imageKey = `${plane}:${state.generation}:${state.renderRevision}`;

  const blockedReason =
    evaluation.image.reason ??
    evaluation.physicalOverlays.reason ??
    evaluation.synchronizedOverlays.reason;

  return (
    <>
      {evaluation.image.allowed && (
        <div
          key={imageKey}
          data-integration-image="true"
        >
          {imageContent}

          {evaluation.physicalOverlays.allowed &&
            physicalOverlayContent}

          {evaluation.synchronizedOverlays.allowed &&
            synchronizedOverlayContent}
        </div>
      )}

      {showStatus && (
        <section
          className={className}
          style={{
            ...statusStyle,
            padding: compact ? 7 : 10,
          }}
          role="region"
          aria-label={`${planeLabel} integration status`}
          data-viewport-integration-guard="true"
          data-integration-image-allowed={
            evaluation.image.allowed ? "true" : "false"
          }
          data-integration-geometry-allowed={
            evaluation.physicalOverlays.allowed
              ? "true"
              : "false"
          }
          data-integration-sync-allowed={
            evaluation.synchronizedOverlays.allowed
              ? "true"
              : "false"
          }
        >
          <strong
            style={{
              fontSize: compact ? 11 : 12,
            }}
          >
            {planeLabel} Integration
          </strong>

          <p style={statusMessageStyle}>
            Image: {evaluation.image.allowed
              ? "Allowed"
              : "Blocked"}
            {" | "}
            Geometry: {evaluation.physicalOverlays.allowed
              ? "Allowed"
              : "Blocked"}
            {" | "}
            Sync: {evaluation.synchronizedOverlays.allowed
              ? "Allowed"
              : "Blocked"}
          </p>

          {!compact && blockedReason !== null && (
            <p style={statusMessageStyle}>
              {INTEGRATION_MESSAGES[blockedReason]}
            </p>
          )}
        </section>
      )}
    </>
  );
}

// ============================================================
// 07 — CAPABILITIES
// ============================================================

export function getViewportIntegrationGuardCapabilities() {
  return {
    axialSupport: true,
    coronalSupport: true,
    sagittalSupport: true,
    authorizationGate: true,
    generationGate: true,
    renderRevisionGate: true,
    currentFrameConfirmation: true,
    staleRenderProtection: true,
    cleanupBusyGate: true,
    recoveryBusyGate: true,
    geometryGenerationGate: true,
    navigationRevisionGate: true,
    synchronizationAcknowledgementGate: true,
    imageContentUnmountOnBlock: true,
    physicalOverlayUnmountOnBlock: true,
    synchronizedOverlayUnmountOnBlock: true,
    opaqueGenerationKeyedRemount: true,
    fixedSafeStatusMessages: true,
    statusHiddenByDefault: true,
    independentClinicalGeometryValidation: false,
    backendAuthorizationEnforcement: false,
    actualResourceDisposal: false,
    directDICOMAccess: false,
    directNetworkRequests: false,
    browserPersistence: false,
    originalDatasetModification: false,
    clinicalValidationComplete: false,
  } as const;
}

// ============================================================
// END OF SINUS VIEWER VIEWPORT INTEGRATION GUARD — FILE 116
// ============================================================
