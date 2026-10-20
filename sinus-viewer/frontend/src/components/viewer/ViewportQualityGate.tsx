
/**
 * SINUS VIEWER — VIEWPORT QUALITY GATE
 * =====================================
 *
 * File 115
 *
 * Parent-controlled, fail-closed quality gating
 * for the current axial/coronal/sagittal viewport.
 *
 * Independently evaluates:
 *
 * 1. Current-frame display eligibility.
 * 2. Physical overlay eligibility.
 * 3. Confirmed MPR synchronization.
 *
 * All claims are limited to parent-supplied
 * validation state and current revision identity.
 *
 * IMPORTANT:
 * - This file does not decode DICOM.
 * - It does not validate geometry independently.
 * - It does not perform image-quality analysis.
 * - It does not enforce backend authorization.
 * - It does not retain patient identifiers.
 * - It does not access source dataset files.
 *
 * Parent must revoke stale render output and
 * invalidate external resources on session switch.
 */

import {
  useMemo,
  type CSSProperties,
  type ReactNode,
} from "react";

// ============================================================
// 01 — TYPES
// ============================================================

export type QualityGatePlane =
  | "axial"
  | "coronal"
  | "sagittal";

export type QualityGatePhase =
  | "idle"
  | "loading"
  | "decoding"
  | "preparing"
  | "rendering"
  | "ready"
  | "unavailable"
  | "error";

export type QualityGateDecisionKind =
  | "display"
  | "physical-overlays"
  | "synchronization";

export type QualityGateBlockReason =
  | "unauthorized"
  | "invalid-generation"
  | "not-ready"
  | "frame-not-confirmed"
  | "stale-frame"
  | "render-protection-unconfirmed"
  | "geometry-not-verified"
  | "geometry-generation-mismatch"
  | "sync-not-confirmed"
  | "sync-generation-mismatch"
  | "sync-revision-mismatch";

export interface ViewportQualityState {
  readonly authorized: boolean;
  readonly phase: QualityGatePhase;

  /**
   * All generations are opaque, non-identifying
   * safe integers issued by the parent.
   */
  readonly currentGeneration: number;
  readonly presentedGeneration: number | null;

  /**
   * Render scheduler must confirm the accepted
   * frame and stale-result protection.
   */
  readonly frameConfirmed: boolean;
  readonly staleRenderProtectionConfirmed: boolean;

  /**
   * Geometry must be independently validated
   * for the current generation.
   */
  readonly geometryVerified: boolean;
  readonly geometryGeneration: number | null;

  /**
   * Sync requires an acknowledged update for
   * the current generation and navigation revision.
   */
  readonly syncConfirmed: boolean;
  readonly syncGeneration: number | null;
  readonly currentNavigationRevision: number;
  readonly confirmedNavigationRevision: number | null;
}

export interface QualityGateDecision {
  readonly allowed: boolean;
  readonly reason: QualityGateBlockReason | null;
}

export interface ViewportQualityEvaluation {
  readonly display: QualityGateDecision;
  readonly physicalOverlays: QualityGateDecision;
  readonly synchronization: QualityGateDecision;
}

export interface ViewportQualityGateProps {
  readonly plane: QualityGatePlane;
  readonly state: ViewportQualityState;

  /**
   * Display-only report by default.
   */
  readonly visible?: boolean;
  readonly compact?: boolean;
  readonly className?: string;

  /**
   * Optional gated children.
   *
   * These slots are unmounted when their
   * matching decision is not allowed.
   *
   * For primary canvas isolation also retain
   * File 111 ViewportLifecycleBoundary.
   */
  readonly displayContent?: ReactNode;
  readonly physicalOverlayContent?: ReactNode;
  readonly synchronizedContent?: ReactNode;
}

// ============================================================
// 02 — SAFE LABELS
// ============================================================

const REASON_MESSAGES: Readonly<
  Record<QualityGateBlockReason, string>
> = {
  unauthorized: "Viewport access unavailable.",
  "invalid-generation": "Volume identity unavailable.",
  "not-ready": "Current image is not ready.",
  "frame-not-confirmed":
    "Current image frame is not confirmed.",
  "stale-frame":
    "Displayed frame belongs to another generation.",
  "render-protection-unconfirmed":
    "Stale-render protection is not confirmed.",
  "geometry-not-verified":
    "Current geometry has not been verified.",
  "geometry-generation-mismatch":
    "Geometry belongs to another generation.",
  "sync-not-confirmed":
    "MPR synchronization is not confirmed.",
  "sync-generation-mismatch":
    "Synchronization belongs to another generation.",
  "sync-revision-mismatch":
    "Current navigation update is not confirmed.",
};

const DECISION_LABELS: Readonly<
  Record<QualityGateDecisionKind, string>
> = {
  display: "Current frame",
  "physical-overlays": "Physical overlays",
  synchronization: "MPR synchronization",
};

// ============================================================
// 03 — PURE HELPERS
// ============================================================

export function isValidQualityGeneration(
  value: unknown,
): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
  );
}

export function isValidQualityRevision(
  value: unknown,
): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
  );
}

export function qualityGatePlaneLabel(
  plane: QualityGatePlane,
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

function allowQualityGate(): QualityGateDecision {
  return {
    allowed: true,
    reason: null,
  };
}

function blockQualityGate(
  reason: QualityGateBlockReason,
): QualityGateDecision {
  return {
    allowed: false,
    reason,
  };
}

// ============================================================
// 04 — PURE EVALUATOR
// ============================================================

/**
 * Every gate is evaluated independently.
 *
 * Display does not require spatial geometry;
 * physical overlays and sync do.
 *
 * This is a UI decision layer and not
 * independent evidence of clinical accuracy.
 */
export function evaluateViewportQuality(
  state: ViewportQualityState,
): ViewportQualityEvaluation {
  let display: QualityGateDecision;

  if (state.authorized !== true) {
    display = blockQualityGate("unauthorized");
  } else if (
    !isValidQualityGeneration(
      state.currentGeneration,
    )
  ) {
    display = blockQualityGate(
      "invalid-generation",
    );
  } else if (state.phase !== "ready") {
    display = blockQualityGate("not-ready");
  } else if (state.frameConfirmed !== true) {
    display = blockQualityGate(
      "frame-not-confirmed",
    );
  } else if (
    !isValidQualityGeneration(
      state.presentedGeneration,
    ) ||
    state.presentedGeneration !==
      state.currentGeneration
  ) {
    display = blockQualityGate("stale-frame");
  } else if (
    state.staleRenderProtectionConfirmed !== true
  ) {
    display = blockQualityGate(
      "render-protection-unconfirmed",
    );
  } else {
    display = allowQualityGate();
  }

  let physicalOverlays: QualityGateDecision;

  if (!display.allowed) {
    physicalOverlays = { ...display };
  } else if (state.geometryVerified !== true) {
    physicalOverlays = blockQualityGate(
      "geometry-not-verified",
    );
  } else if (
    !isValidQualityGeneration(
      state.geometryGeneration,
    ) ||
    state.geometryGeneration !==
      state.currentGeneration
  ) {
    physicalOverlays = blockQualityGate(
      "geometry-generation-mismatch",
    );
  } else {
    physicalOverlays = allowQualityGate();
  }

  let synchronization: QualityGateDecision;

  if (!physicalOverlays.allowed) {
    synchronization = { ...physicalOverlays };
  } else if (state.syncConfirmed !== true) {
    synchronization = blockQualityGate(
      "sync-not-confirmed",
    );
  } else if (
    !isValidQualityGeneration(
      state.syncGeneration,
    ) ||
    state.syncGeneration !==
      state.currentGeneration
  ) {
    synchronization = blockQualityGate(
      "sync-generation-mismatch",
    );
  } else if (
    !isValidQualityRevision(
      state.currentNavigationRevision,
    ) ||
    !isValidQualityRevision(
      state.confirmedNavigationRevision,
    ) ||
    state.confirmedNavigationRevision !==
      state.currentNavigationRevision
  ) {
    synchronization = blockQualityGate(
      "sync-revision-mismatch",
    );
  } else {
    synchronization = allowQualityGate();
  }

  return {
    display,
    physicalOverlays,
    synchronization,
  };
}

// ============================================================
// 05 — STYLES
// ============================================================

const reportStyle: CSSProperties = {
  width: 290,
  maxWidth: "100%",
  padding: 12,
  boxSizing: "border-box",
  border: "1px solid #475569",
  borderRadius: 8,
  backgroundColor: "#0f172a",
  color: "#e2e8f0",
};

const rowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 10,
  padding: "7px 0",
  borderBottom: "1px solid #1e293b",
};

const labelStyle: CSSProperties = {
  color: "#cbd5e1",
  fontSize: 11,
};

const statusStyle: CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
};

const explanationStyle: CSSProperties = {
  margin: "3px 0 0",
  fontSize: 10,
  color: "#94a3b8",
  lineHeight: 1.5,
};

// ============================================================
// 06 — COMPONENT
// ============================================================

export function ViewportQualityGate({
  plane,
  state,
  visible = false,
  compact = false,
  className = "",
  displayContent,
  physicalOverlayContent,
  synchronizedContent,
}: ViewportQualityGateProps) {
  const evaluation = useMemo(
    () => evaluateViewportQuality(state),
    [
      state.authorized,
      state.phase,
      state.currentGeneration,
      state.presentedGeneration,
      state.frameConfirmed,
      state.staleRenderProtectionConfirmed,
      state.geometryVerified,
      state.geometryGeneration,
      state.syncConfirmed,
      state.syncGeneration,
      state.currentNavigationRevision,
      state.confirmedNavigationRevision,
    ],
  );

  const planeLabel = qualityGatePlaneLabel(plane);

  const items: readonly {
    id: QualityGateDecisionKind;
    decision: QualityGateDecision;
  }[] = [
    {
      id: "display",
      decision: evaluation.display,
    },
    {
      id: "physical-overlays",
      decision: evaluation.physicalOverlays,
    },
    {
      id: "synchronization",
      decision: evaluation.synchronization,
    },
  ];

  const showSlots =
    displayContent !== undefined ||
    physicalOverlayContent !== undefined ||
    synchronizedContent !== undefined;

  return (
    <>
      {showSlots && (
        <>
          {evaluation.display.allowed &&
            displayContent}

          {evaluation.physicalOverlays.allowed &&
            physicalOverlayContent}

          {evaluation.synchronization.allowed &&
            synchronizedContent}
        </>
      )}

      {visible && (
        <section
          className={className}
          style={{
            ...reportStyle,
            padding: compact ? 8 : 12,
          }}
          role="region"
          aria-label={`${planeLabel} quality gate`}
          data-viewport-quality-gate="true"
          data-quality-plane={plane}
          data-quality-display={
            evaluation.display.allowed
              ? "allowed"
              : "blocked"
          }
          data-quality-geometry={
            evaluation.physicalOverlays.allowed
              ? "allowed"
              : "blocked"
          }
          data-quality-sync={
            evaluation.synchronization.allowed
              ? "allowed"
              : "blocked"
          }
        >
          <h3
            style={{
              margin: "0 0 8px",
              fontSize: compact ? 11 : 13,
            }}
          >
            {planeLabel} Quality Gate
          </h3>

          {items.map(({ id, decision }) => (
            <div
              key={id}
              style={rowStyle}
              data-quality-check={id}
            >
              <div>
                <div style={labelStyle}>
                  {DECISION_LABELS[id]}
                </div>

                {!compact &&
                  decision.reason !== null && (
                    <p style={explanationStyle}>
                      {REASON_MESSAGES[
                        decision.reason
                      ]}
                    </p>
                  )}
              </div>

              <span
                style={{
                  ...statusStyle,
                  color: decision.allowed
                    ? "#86efac"
                    : "#fbbf24",
                }}
              >
                {decision.allowed
                  ? "PASS"
                  : "BLOCKED"}
              </span>
            </div>
          ))}

          {!compact && (
            <p
              style={{
                margin: "10px 0 0",
                color: "#64748b",
                fontSize: 9,
                lineHeight: 1.5,
              }}
            >
              Parent-supplied readiness only.
              Not independent clinical validation.
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

export function getViewportQualityGateCapabilities() {
  return {
    axialSupport: true,
    coronalSupport: true,
    sagittalSupport: true,
    failClosedDecisions: true,
    authorizationRequired: true,
    currentGenerationRequired: true,
    readyPhaseRequired: true,
    frameConfirmationRequired: true,
    matchingFrameGenerationRequired: true,
    staleRenderProtectionRequired: true,
    independentGeometryGate: true,
    geometryGenerationMatchRequired: true,
    synchronizationAcknowledgementRequired: true,
    syncGenerationMatchRequired: true,
    syncRevisionMatchRequired: true,
    separateDisplayAndPhysicalOverlays: true,
    optionalGatedContent: true,
    hiddenDiagnosticReportByDefault: true,
    fixedSafeMessages: true,
    patientMetadataDisplay: false,
    rawBackendErrorDisplay: false,
    directDICOMAccess: false,
    directNetworkRequests: false,
    browserPersistence: false,
    sourceDatasetModification: false,
    independentClinicalValidation: false,
  } as const;
}

// ============================================================
// END OF SINUS VIEWER VIEWPORT QUALITY GATE — FILE 115
// ============================================================
