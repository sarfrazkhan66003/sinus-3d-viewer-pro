
/**
 * SINUS VIEWER — VIEWPORT SAFETY CHECKLIST
 * ========================================
 *
 * File 114
 *
 * Displays parent-supplied safety prerequisites
 * for the current MPR viewport.
 *
 * Checks:
 * - Current authorization
 * - Valid volume generation
 * - Current accepted image frame
 * - Presented frame generation matches
 * - Stale-render protection confirmation
 * - Geometry validated for current generation
 * - Optional MPR sync acknowledgement
 *
 * IMPORTANT:
 * This is a diagnostic UI, not a medical
 * certification or a security enforcement layer.
 *
 * Backend must enforce authorization.
 * Render scheduler must reject stale results.
 * Geometry must be independently validated.
 *
 * No patient metadata, UID, source path,
 * DICOM file access, or filesystem writes.
 */

import {
  useMemo,
  type CSSProperties,
} from "react";

// ============================================================
// 01 — PUBLIC TYPES
// ============================================================

export type SafetyChecklistPlane =
  | "axial"
  | "coronal"
  | "sagittal";

export type SafetyCheckStatus =
  | "pass"
  | "pending"
  | "blocked";

export type SafetyCheckId =
  | "authorization"
  | "generation"
  | "frame"
  | "stale-render"
  | "geometry"
  | "synchronization";

export interface ViewportSafetyState {
  readonly authorized: boolean;

  /**
   * Opaque, non-identifying volume generation.
   */
  readonly currentGeneration: number;

  /**
   * Accepted frame must belong to the
   * current generation.
   */
  readonly presentedGeneration: number | null;

  readonly frameConfirmed: boolean;

  /**
   * Parent confirms stale asynchronous render
   * results are rejected for current generation.
   */
  readonly staleRenderProtectionConfirmed: boolean;

  /**
   * Parent confirms verified geometry.
   */
  readonly geometryVerified: boolean;

  /**
   * Generation for which geometry was verified.
   */
  readonly geometryGeneration: number | null;

  /**
   * Parent confirms an acknowledged MPR update.
   */
  readonly syncConfirmed: boolean;

  /**
   * Generation for which sync was acknowledged.
   */
  readonly syncGeneration: number | null;
}

export interface ViewportSafetyCheck {
  readonly id: SafetyCheckId;
  readonly label: string;
  readonly status: SafetyCheckStatus;
  readonly message: string;
  readonly required: boolean;
}

export interface ViewportSafetyEvaluation {
  readonly checks: readonly ViewportSafetyCheck[];

  readonly passed: number;
  readonly total: number;

  /**
   * True when every required display prerequisite
   * is satisfied except optional synchronization.
   */
  readonly imageDisplayPrerequisitesMet: boolean;

  /**
   * True when geometry is confirmed for the
   * currently accepted image generation.
   */
  readonly physicalOverlayPrerequisitesMet: boolean;

  /**
   * True when current-generation synchronization
   * is confirmed as well.
   */
  readonly synchronizationPrerequisitesMet: boolean;
}

export interface ViewportSafetyChecklistProps {
  readonly plane: SafetyChecklistPlane;
  readonly state: ViewportSafetyState;

  readonly visible?: boolean;
  readonly compact?: boolean;
  readonly requireSynchronization?: boolean;
  readonly className?: string;
}

// ============================================================
// 02 — VALIDATION
// ============================================================

export function isValidSafetyGeneration(
  value: unknown,
): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
  );
}

export function safetyChecklistPlaneLabel(
  plane: SafetyChecklistPlane,
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
// 03 — CHECK BUILDER
// ============================================================

function makeSafetyCheck(
  id: SafetyCheckId,
  label: string,
  passed: boolean,
  message: string,
  required = true,
  blocked = false,
): ViewportSafetyCheck {
  return {
    id,
    label,
    status: passed
      ? "pass"
      : blocked
        ? "blocked"
        : "pending",
    message,
    required,
  };
}

// ============================================================
// 04 — PURE SAFETY EVALUATION
// ============================================================

/**
 * This function never infers missing proof.
 *
 * Every confirmation comes from parent state.
 *
 * It is safe to call independently in tests.
 */
export function evaluateViewportSafety(
  state: ViewportSafetyState,
  requireSynchronization = false,
): ViewportSafetyEvaluation {
  const authorized =
    state.authorized === true;

  const generationValid =
    isValidSafetyGeneration(
      state.currentGeneration,
    );

  const frameGenerationMatches =
    generationValid &&
    isValidSafetyGeneration(
      state.presentedGeneration,
    ) &&
    state.presentedGeneration ===
      state.currentGeneration;

  const currentFrameConfirmed =
    authorized &&
    frameGenerationMatches &&
    state.frameConfirmed === true;

  const staleRenderProtected =
    currentFrameConfirmed &&
    state.staleRenderProtectionConfirmed === true;

  const imageDisplayPrerequisitesMet =
    authorized &&
    generationValid &&
    currentFrameConfirmed &&
    staleRenderProtected;

  const geometryMatches =
    generationValid &&
    isValidSafetyGeneration(
      state.geometryGeneration,
    ) &&
    state.geometryGeneration ===
      state.currentGeneration;

  const physicalOverlayPrerequisitesMet =
    imageDisplayPrerequisitesMet &&
    geometryMatches &&
    state.geometryVerified === true;

  const syncMatches =
    generationValid &&
    isValidSafetyGeneration(
      state.syncGeneration,
    ) &&
    state.syncGeneration ===
      state.currentGeneration;

  const synchronizationPrerequisitesMet =
    physicalOverlayPrerequisitesMet &&
    syncMatches &&
    state.syncConfirmed === true;

  const checks: ViewportSafetyCheck[] = [
    makeSafetyCheck(
      "authorization",
      "Access authorization",
      authorized,
      authorized
        ? "Access flag confirmed."
        : "Viewport access not confirmed.",
      true,
      !authorized,
    ),

    makeSafetyCheck(
      "generation",
      "Volume identity",
      authorized && generationValid,
      authorized && generationValid
        ? "Current volume identity is valid."
        : "Current volume identity unavailable.",
      true,
      !authorized,
    ),

    makeSafetyCheck(
      "frame",
      "Current image frame",
      currentFrameConfirmed,
      currentFrameConfirmed
        ? "Accepted frame matches current volume."
        : "Current frame not confirmed.",
      true,
      !authorized,
    ),

    makeSafetyCheck(
      "stale-render",
      "Stale-render protection",
      staleRenderProtected,
      staleRenderProtected
        ? "Current generation protection confirmed."
        : "Stale-render protection not confirmed.",
      true,
      !authorized,
    ),

    makeSafetyCheck(
      "geometry",
      "Spatial geometry",
      physicalOverlayPrerequisitesMet,
      physicalOverlayPrerequisitesMet
        ? "Current-generation geometry verified."
        : "Current-generation geometry not verified.",
      true,
      !authorized,
    ),

    makeSafetyCheck(
      "synchronization",
      "MPR synchronization",
      synchronizationPrerequisitesMet,
      synchronizationPrerequisitesMet
        ? "Current-generation MPR sync confirmed."
        : "MPR sync not confirmed.",
      requireSynchronization,
      !authorized,
    ),
  ];

  const requiredChecks = checks.filter(
    (check) => check.required,
  );

  const passed = requiredChecks.filter(
    (check) => check.status === "pass",
  ).length;

  return {
    checks,
    passed,
    total: requiredChecks.length,
    imageDisplayPrerequisitesMet,
    physicalOverlayPrerequisitesMet,
    synchronizationPrerequisitesMet,
  };
}

// ============================================================
// 05 — DISPLAY STYLES
// ============================================================

const rootStyle: CSSProperties = {
  width: 300,
  maxWidth: "100%",
  padding: 12,
  boxSizing: "border-box",
  border: "1px solid #475569",
  borderRadius: 8,
  backgroundColor: "#0f172a",
  color: "#e2e8f0",
};

const headingStyle: CSSProperties = {
  margin: 0,
  fontSize: 13,
  fontWeight: 700,
};

const descriptionStyle: CSSProperties = {
  margin: "5px 0 12px",
  fontSize: 11,
  lineHeight: 1.5,
  color: "#94a3b8",
};

const checkRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 8,
  padding: "7px 0",
  borderBottom: "1px solid #1e293b",
};

const checkLabelStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
};

const checkMessageStyle: CSSProperties = {
  marginTop: 2,
  fontSize: 10,
  lineHeight: 1.5,
  color: "#94a3b8",
};

const statusColors: Readonly<
  Record<SafetyCheckStatus, string>
> = {
  pass: "#86efac",
  pending: "#fbbf24",
  blocked: "#fca5a5",
};

const statusLabels: Readonly<
  Record<SafetyCheckStatus, string>
> = {
  pass: "PASS",
  pending: "PENDING",
  blocked: "BLOCKED",
};

// ============================================================
// 06 — REACT COMPONENT
// ============================================================

export function ViewportSafetyChecklist({
  plane,
  state,
  visible = false,
  compact = false,
  requireSynchronization = false,
  className = "",
}: ViewportSafetyChecklistProps) {
  const evaluation = useMemo(
    () =>
      evaluateViewportSafety(
        state,
        requireSynchronization,
      ),
    [
      state.authorized,
      state.currentGeneration,
      state.presentedGeneration,
      state.frameConfirmed,
      state.staleRenderProtectionConfirmed,
      state.geometryVerified,
      state.geometryGeneration,
      state.syncConfirmed,
      state.syncGeneration,
      requireSynchronization,
    ],
  );

  if (!visible) {
    return null;
  }

  const planeLabel =
    safetyChecklistPlaneLabel(plane);

  return (
    <section
      className={className}
      style={{
        ...rootStyle,
        padding: compact ? 8 : 12,
      }}
      role="region"
      aria-label={`${planeLabel} viewport safety checklist`}
      data-viewport-safety-checklist="true"
      data-safety-plane={plane}
      data-safety-image-ready={
        evaluation.imageDisplayPrerequisitesMet
          ? "true"
          : "false"
      }
      data-safety-geometry-ready={
        evaluation.physicalOverlayPrerequisitesMet
          ? "true"
          : "false"
      }
    >
      <h3 style={headingStyle}>
        {planeLabel} Safety Checklist
      </h3>

      <p style={descriptionStyle}>
        Required checks: {evaluation.passed}
        {" / "}
        {evaluation.total}
      </p>

      <div>
        {evaluation.checks.map((check) => (
          <div
            key={check.id}
            style={checkRowStyle}
            data-safety-check={check.id}
            data-safety-status={check.status}
          >
            <span
              aria-hidden="true"
              style={{
                color:
                  statusColors[check.status],
                fontSize: 12,
                fontWeight: 700,
              }}
            >
              {check.status === "pass"
                ? "✓"
                : check.status === "blocked"
                  ? "×"
                  : "•"}
            </span>

            <div style={{ minWidth: 0 }}>
              <div
                style={{
                  ...checkLabelStyle,
                  fontSize: compact ? 10 : 11,
                }}
              >
                {check.label}
                {check.required ? "" : " (optional)"}
              </div>

              <div style={checkMessageStyle}>
                {check.message}
              </div>
            </div>

            <span
              style={{
                marginLeft: "auto",
                color:
                  statusColors[check.status],
                fontSize: 9,
                fontWeight: 700,
              }}
            >
              {statusLabels[check.status]}
            </span>
          </div>
        ))}
      </div>

      {!compact && (
        <p
          style={{
            margin: "12px 0 0",
            fontSize: 10,
            lineHeight: 1.5,
            color: "#64748b",
          }}
        >
          Diagnostic confirmation only.
          This panel does not independently
          validate medical image geometry,
          security or clinical suitability.
        </p>
      )}
    </section>
  );
}

// ============================================================
// 07 — CAPABILITIES
// ============================================================

export function getViewportSafetyChecklistCapabilities() {
  return {
    axialSupport: true,
    coronalSupport: true,
    sagittalSupport: true,
    authorizationCheck: true,
    generationValidation: true,
    acceptedFrameCheck: true,
    presentedGenerationMatch: true,
    staleRenderProtectionCheck: true,
    currentGenerationGeometryCheck: true,
    currentGenerationSyncCheck: true,
    optionalSynchronizationRequirement: true,
    separateImageAndGeometryReadiness: true,
    fixedPrivacySafeMessages: true,
    parentOwnedSafetyProof: true,
    hiddenByDefault: true,
    compactLayout: true,
    directDICOMAccess: false,
    directNetworkRequests: false,
    browserPersistence: false,
    backendAuthorizationEnforcement: false,
    independentGeometryValidation: false,
    clinicalValidationComplete: false,
    originalDatasetModification: false,
  } as const;
}

// ============================================================
// END OF SINUS VIEWER VIEWPORT SAFETY CHECKLIST — FILE 114
// ============================================================
