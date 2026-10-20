
/**
 * SINUS VIEWER — VIEWPORT COMPATIBILITY AUDIT
 * ============================================
 *
 * FILE 118
 *
 * Developer-only audit of integration contracts.
 *
 * All evidence must be provided explicitly by
 * the parent integration and test systems.
 *
 * A "PASS" means a specific Boolean contract
 * confirmation was supplied. It does NOT prove
 * that a module was imported, compiled, tested
 * or medically validated.
 *
 * IMPORTANT:
 * - No patient identifiers.
 * - No DICOM source paths or raw errors.
 * - No direct network or file operations.
 * - No automatic discovery of mounted resources.
 * - No automatic changing of source code.
 * - Original DICOM dataset remains READ ONLY.
 */

import {
  useMemo,
  type CSSProperties,
} from "react";

// ============================================================
// 01 — PUBLIC TYPES
// ============================================================

export type CompatibilityAuditStatus =
  | "pass"
  | "pending"
  | "fail";

export type CompatibilityAuditCategory =
  | "session"
  | "render"
  | "lifecycle"
  | "cleanup"
  | "geometry"
  | "synchronization"
  | "recovery"
  | "testing";

export type CompatibilityAuditCheckId =
  | "generation-owned"
  | "session-invalidates-work"
  | "authorization-enforced"
  | "render-revision-owned"
  | "accepted-frame-current"
  | "stale-result-rejected"
  | "lifecycle-content-gated"
  | "resources-registered"
  | "cleanup-on-volume-switch"
  | "cleanup-on-unmount"
  | "geometry-generation-verified"
  | "physical-overlays-gated"
  | "sync-revision-acknowledged"
  | "sync-overlays-gated"
  | "retry-bounded"
  | "recovery-cancelable"
  | "synthetic-tests-executed";

export interface ViewportCompatibilityEvidence {
  readonly generationOwned: boolean | null;
  readonly sessionInvalidatesWork: boolean | null;
  readonly authorizationEnforced: boolean | null;

  readonly renderRevisionOwned: boolean | null;
  readonly acceptedFrameCurrent: boolean | null;
  readonly staleResultRejected: boolean | null;

  readonly lifecycleContentGated: boolean | null;

  readonly resourcesRegistered: boolean | null;
  readonly cleanupOnVolumeSwitch: boolean | null;
  readonly cleanupOnUnmount: boolean | null;

  readonly geometryGenerationVerified: boolean | null;
  readonly physicalOverlaysGated: boolean | null;

  readonly syncRevisionAcknowledged: boolean | null;
  readonly syncOverlaysGated: boolean | null;

  readonly retryBounded: boolean | null;
  readonly recoveryCancelable: boolean | null;

  readonly syntheticTestsExecuted: boolean | null;
}

export interface ViewportCompatibilityCheck {
  readonly id: CompatibilityAuditCheckId;
  readonly category: CompatibilityAuditCategory;
  readonly label: string;
  readonly status: CompatibilityAuditStatus;
  readonly required: boolean;
}

export interface ViewportCompatibilityAuditResult {
  readonly checks: readonly ViewportCompatibilityCheck[];
  readonly passed: number;
  readonly pending: number;
  readonly failed: number;
  readonly total: number;
  readonly readyForIntegrationReview: boolean;
}

export interface ViewportCompatibilityAuditProps {
  readonly evidence: ViewportCompatibilityEvidence;
  readonly visible?: boolean;
  readonly compact?: boolean;
  readonly className?: string;
}

// ============================================================
// 02 — EVIDENCE DEFAULTS
// ============================================================

/**
 * Unknown until confirmed by relevant tests.
 *
 * Never default a contract to PASS.
 */
export const EMPTY_VIEWPORT_COMPATIBILITY_EVIDENCE:
  Readonly<ViewportCompatibilityEvidence> = {
    generationOwned: null,
    sessionInvalidatesWork: null,
    authorizationEnforced: null,

    renderRevisionOwned: null,
    acceptedFrameCurrent: null,
    staleResultRejected: null,

    lifecycleContentGated: null,

    resourcesRegistered: null,
    cleanupOnVolumeSwitch: null,
    cleanupOnUnmount: null,

    geometryGenerationVerified: null,
    physicalOverlaysGated: null,

    syncRevisionAcknowledged: null,
    syncOverlaysGated: null,

    retryBounded: null,
    recoveryCancelable: null,

    syntheticTestsExecuted: null,
  };

// ============================================================
// 03 — EVIDENCE CHECK DESCRIPTORS
// ============================================================

interface CompatibilityAuditDescriptor {
  readonly id: CompatibilityAuditCheckId;
  readonly category: CompatibilityAuditCategory;
  readonly label: string;
  readonly evidenceKey: keyof ViewportCompatibilityEvidence;
  readonly required: boolean;
}

/**
 * Descriptors contain only fixed labels.
 *
 * No raw evidence values are displayed.
 */
const COMPATIBILITY_AUDIT_DESCRIPTORS:
  readonly CompatibilityAuditDescriptor[] = [
    {
      id: "generation-owned",
      category: "session",
      label: "Current volume generation owned",
      evidenceKey: "generationOwned",
      required: true,
    },
    {
      id: "session-invalidates-work",
      category: "session",
      label: "Session changes invalidate render work",
      evidenceKey: "sessionInvalidatesWork",
      required: true,
    },
    {
      id: "authorization-enforced",
      category: "session",
      label: "Backend authorization independently enforced",
      evidenceKey: "authorizationEnforced",
      required: true,
    },
    {
      id: "render-revision-owned",
      category: "render",
      label: "Current render revision owned",
      evidenceKey: "renderRevisionOwned",
      required: true,
    },
    {
      id: "accepted-frame-current",
      category: "render",
      label: "Accepted frame identity verified",
      evidenceKey: "acceptedFrameCurrent",
      required: true,
    },
    {
      id: "stale-result-rejected",
      category: "render",
      label: "Stale asynchronous results rejected",
      evidenceKey: "staleResultRejected",
      required: true,
    },
    {
      id: "lifecycle-content-gated",
      category: "lifecycle",
      label: "Sensitive viewport content lifecycle-gated",
      evidenceKey: "lifecycleContentGated",
      required: true,
    },
    {
      id: "resources-registered",
      category: "cleanup",
      label: "Renderer-owned resources registered",
      evidenceKey: "resourcesRegistered",
      required: true,
    },
    {
      id: "cleanup-on-volume-switch",
      category: "cleanup",
      label: "Old resources disposed on volume switch",
      evidenceKey: "cleanupOnVolumeSwitch",
      required: true,
    },
    {
      id: "cleanup-on-unmount",
      category: "cleanup",
      label: "Resources disposed on viewport unmount",
      evidenceKey: "cleanupOnUnmount",
      required: true,
    },
    {
      id: "geometry-generation-verified",
      category: "geometry",
      label: "Geometry verified for current generation",
      evidenceKey: "geometryGenerationVerified",
      required: true,
    },
    {
      id: "physical-overlays-gated",
      category: "geometry",
      label: "Physical overlays require verified geometry",
      evidenceKey: "physicalOverlaysGated",
      required: true,
    },
    {
      id: "sync-revision-acknowledged",
      category: "synchronization",
      label: "Navigation revision acknowledged",
      evidenceKey: "syncRevisionAcknowledged",
      required: true,
    },
    {
      id: "sync-overlays-gated",
      category: "synchronization",
      label: "MPR sync overlays gated",
      evidenceKey: "syncOverlaysGated",
      required: true,
    },
    {
      id: "retry-bounded",
      category: "recovery",
      label: "Recovery retry attempts bounded",
      evidenceKey: "retryBounded",
      required: true,
    },
    {
      id: "recovery-cancelable",
      category: "recovery",
      label: "Recovery can be canceled for old sessions",
      evidenceKey: "recoveryCancelable",
      required: true,
    },
    {
      id: "synthetic-tests-executed",
      category: "testing",
      label: "Synthetic decision tests executed successfully",
      evidenceKey: "syntheticTestsExecuted",
      required: true,
    },
  ];

// ============================================================
// 04 — PURE AUDIT HELPERS
// ============================================================

export function normalizeCompatibilityAuditStatus(
  value: boolean | null | undefined,
): CompatibilityAuditStatus {
  if (value === true) {
    return "pass";
  }

  if (value === false) {
    return "fail";
  }

  return "pending";
}

export function isCompatibilityAuditComplete(
  result: ViewportCompatibilityAuditResult,
): boolean {
  return (
    result.total > 0 &&
    result.passed === result.total &&
    result.pending === 0 &&
    result.failed === 0
  );
}

// ============================================================
// 05 — PURE AUDIT EVALUATOR
// ============================================================

export function evaluateViewportCompatibility(
  evidence: ViewportCompatibilityEvidence,
): ViewportCompatibilityAuditResult {
  const checks = COMPATIBILITY_AUDIT_DESCRIPTORS.map(
    (descriptor): ViewportCompatibilityCheck => ({
      id: descriptor.id,
      category: descriptor.category,
      label: descriptor.label,
      status: normalizeCompatibilityAuditStatus(
        evidence[descriptor.evidenceKey],
      ),
      required: descriptor.required,
    }),
  );

  const requiredChecks = checks.filter(
    (check) => check.required,
  );

  const passed = requiredChecks.filter(
    (check) => check.status === "pass",
  ).length;

  const pending = requiredChecks.filter(
    (check) => check.status === "pending",
  ).length;

  const failed = requiredChecks.filter(
    (check) => check.status === "fail",
  ).length;

  const total = requiredChecks.length;

  return {
    checks,
    passed,
    pending,
    failed,
    total,
    readyForIntegrationReview:
      total > 0 &&
      passed === total &&
      pending === 0 &&
      failed === 0,
  };
}

// ============================================================
// 06 — FIXED DISPLAY LABELS
// ============================================================

const STATUS_LABELS: Readonly<
  Record<CompatibilityAuditStatus, string>
> = {
  pass: "PASS",
  pending: "PENDING",
  fail: "FAIL",
};

const STATUS_COLORS: Readonly<
  Record<CompatibilityAuditStatus, string>
> = {
  pass: "#86efac",
  pending: "#fbbf24",
  fail: "#fca5a5",
};

const CATEGORY_LABELS: Readonly<
  Record<CompatibilityAuditCategory, string>
> = {
  session: "Session",
  render: "Rendering",
  lifecycle: "Lifecycle",
  cleanup: "Cleanup",
  geometry: "Geometry",
  synchronization: "MPR Synchronization",
  recovery: "Recovery",
  testing: "Testing",
};

// ============================================================
// 07 — STYLES
// ============================================================

const rootStyle: CSSProperties = {
  width: 540,
  maxWidth: "100%",
  padding: 14,
  boxSizing: "border-box",
  backgroundColor: "#0f172a",
  color: "#e2e8f0",
  border: "1px solid #475569",
  borderRadius: 8,
};

const rowStyle: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "space-between",
  gap: 12,
  padding: "7px 0",
  borderBottom: "1px solid #1e293b",
};

const labelStyle: CSSProperties = {
  fontSize: 11,
  color: "#cbd5e1",
  lineHeight: 1.5,
};

const statusStyle: CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
};

// ============================================================
// 08 — REACT COMPONENT
// ============================================================

export function ViewportCompatibilityAudit({
  evidence,
  visible = false,
  compact = false,
  className = "",
}: ViewportCompatibilityAuditProps) {
  const audit = useMemo(
    () => evaluateViewportCompatibility(evidence),
    [
      evidence.generationOwned,
      evidence.sessionInvalidatesWork,
      evidence.authorizationEnforced,
      evidence.renderRevisionOwned,
      evidence.acceptedFrameCurrent,
      evidence.staleResultRejected,
      evidence.lifecycleContentGated,
      evidence.resourcesRegistered,
      evidence.cleanupOnVolumeSwitch,
      evidence.cleanupOnUnmount,
      evidence.geometryGenerationVerified,
      evidence.physicalOverlaysGated,
      evidence.syncRevisionAcknowledged,
      evidence.syncOverlaysGated,
      evidence.retryBounded,
      evidence.recoveryCancelable,
      evidence.syntheticTestsExecuted,
    ],
  );

  if (!visible) {
    return null;
  }

  return (
    <section
      className={className}
      style={{
        ...rootStyle,
        padding: compact ? 8 : 14,
      }}
      role="region"
      aria-label="Viewport integration compatibility audit"
      data-viewport-compatibility-audit="true"
      data-audit-result={
        audit.readyForIntegrationReview
          ? "ready-for-review"
          : "requires-review"
      }
    >
      <h3
        style={{
          margin: 0,
          fontSize: compact ? 12 : 15,
        }}
      >
        Viewport Compatibility Audit
      </h3>

      <p
        style={{
          margin: "8px 0 12px",
          color: "#94a3b8",
          fontSize: 11,
          lineHeight: 1.5,
        }}
      >
        Explicit integration evidence only.
        This is not automatic source inspection
        or clinical certification.
      </p>

      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 12,
          fontSize: 12,
          marginBottom: 12,
        }}
      >
        <strong>
          Passed: {audit.passed}
        </strong>

        <strong>
          Pending: {audit.pending}
        </strong>

        <strong>
          Failed: {audit.failed}
        </strong>

        <strong>
          Total: {audit.total}
        </strong>
      </div>

      <div>
        {audit.checks.map((check) => (
          <div
            key={check.id}
            style={rowStyle}
            data-audit-check={check.id}
            data-audit-check-status={check.status}
          >
            <div>
              <span
                style={{
                  fontSize: 9,
                  color: "#64748b",
                  display: "block",
                  marginBottom: 2,
                }}
              >
                {CATEGORY_LABELS[check.category]}
              </span>

              <span style={labelStyle}>
                {check.label}
              </span>
            </div>

            <span
              style={{
                ...statusStyle,
                color: STATUS_COLORS[check.status],
              }}
            >
              {STATUS_LABELS[check.status]}
            </span>
          </div>
        ))}
      </div>

      <p
        style={{
          margin: "12px 0 0",
          fontSize: 10,
          lineHeight: 1.5,
          color: "#64748b",
        }}
      >
        Review readiness is not production
        readiness. TypeScript build, runtime
        cleanup, authorization and geometry
        validation are independently required.
      </p>
    </section>
  );
}

// ============================================================
// 09 — CAPABILITIES
// ============================================================

export function getViewportCompatibilityAuditCapabilities() {
  return {
    explicitEvidenceOnly: true,
    unknownEvidencePending: true,
    falseEvidenceFails: true,
    allRequiredChecksMustPass: true,
    generationContract: true,
    renderRevisionContract: true,
    staleResultContract: true,
    lifecycleContract: true,
    resourceCleanupContract: true,
    geometryContract: true,
    synchronizationContract: true,
    boundedRecoveryContract: true,
    syntheticTestContract: true,
    fixedLabels: true,
    hiddenByDefault: true,
    directSourceInspection: false,
    automaticTypeScriptCompilation: false,
    actualGpuTesting: false,
    backendAuthorizationVerification: false,
    independentGeometryValidation: false,
    directDICOMAccess: false,
    directNetworkRequests: false,
    browserPersistence: false,
    sourceDatasetModification: false,
    clinicalValidationComplete: false,
  } as const;
}

// ============================================================
// END OF SINUS VIEWER VIEWPORT COMPATIBILITY AUDIT — FILE 118
// ============================================================
