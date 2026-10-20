
/**
 * SINUS VIEWER — FINAL INTEGRATION REPORT
 * =======================================
 *
 * FILE 120 OF 120
 *
 * Final developer-facing integration and
 * validation evidence report.
 *
 * Reports:
 * - Declared source-file inventory
 * - Structural verification outcomes
 * - Full TypeScript build evidence
 * - Browser/MPR integration evidence
 * - Session and authorization testing
 * - Render cancellation and cleanup tests
 * - DICOM spatial geometry validation
 * - Dataset read-only compliance
 * - Remaining release blockers
 *
 * IMPORTANT:
 * This component NEVER assumes that delivered
 * source files have compiled or passed tests.
 *
 * All verification evidence must be supplied
 * by independent tools or authorized reviewers.
 *
 * No patient data, DICOM UID, original image
 * content, raw backend errors, or paths are
 * included in this reporting model.
 *
 * Original DICOM dataset remains READ ONLY.
 */

import {
  useMemo,
  type CSSProperties,
} from "react";

// ============================================================
// 01 — PUBLIC TYPES
// ============================================================

export type FinalReportStatus =
  | "pass"
  | "pending"
  | "fail";

export type FinalReportCategory =
  | "source"
  | "build"
  | "runtime"
  | "security"
  | "geometry"
  | "dataset"
  | "accessibility";

export type FinalReportCheckId =
  | "source-inventory"
  | "source-structure"
  | "typescript-build"
  | "dependency-resolution"
  | "synthetic-suite"
  | "browser-rendering"
  | "mpr-navigation"
  | "session-isolation"
  | "backend-authorization"
  | "stale-render-rejection"
  | "resource-cleanup"
  | "recovery-cancellation"
  | "spatial-geometry"
  | "physical-overlays"
  | "read-only-dataset"
  | "privacy-redaction"
  | "keyboard-accessibility"
  | "failure-and-recovery-ux";

export interface FinalReportEvidence {
  readonly sourceInventory: boolean | null;
  readonly sourceStructure: boolean | null;
  readonly typescriptBuild: boolean | null;
  readonly dependencyResolution: boolean | null;

  readonly syntheticSuite: boolean | null;
  readonly browserRendering: boolean | null;
  readonly mprNavigation: boolean | null;

  readonly sessionIsolation: boolean | null;
  readonly backendAuthorization: boolean | null;
  readonly staleRenderRejection: boolean | null;
  readonly resourceCleanup: boolean | null;
  readonly recoveryCancellation: boolean | null;

  readonly spatialGeometry: boolean | null;
  readonly physicalOverlays: boolean | null;

  readonly readOnlyDataset: boolean | null;
  readonly privacyRedaction: boolean | null;

  readonly keyboardAccessibility: boolean | null;
  readonly failureAndRecoveryUX: boolean | null;
}

export interface FinalReportCheck {
  readonly id: FinalReportCheckId;
  readonly category: FinalReportCategory;
  readonly label: string;
  readonly status: FinalReportStatus;
  readonly required: boolean;
}

export interface FinalReportSummary {
  readonly expectedSourceFiles: number;
  readonly declaredSourceFiles: number;
  readonly sourceInventoryComplete: boolean;

  readonly checks: readonly FinalReportCheck[];
  readonly totalChecks: number;
  readonly passedChecks: number;
  readonly pendingChecks: number;
  readonly failedChecks: number;

  /**
   * Evidence completeness only.
   *
   * Does not automatically authorize production
   * deployment or clinical use.
   */
  readonly allEvidencePassed: boolean;
  readonly blockers: readonly FinalReportCheck[];
}

export interface ViewportFinalIntegrationReportProps {
  readonly evidence: FinalReportEvidence;

  /**
   * Parent-supplied number of existing files.
   *
   * This component does not inspect the
   * filesystem or automatically count files.
   */
  readonly declaredSourceFiles: number;

  readonly visible?: boolean;
  readonly compact?: boolean;
  readonly className?: string;
}

// ============================================================
// 02 — SOURCE INVENTORY CONTRACT
// ============================================================

export const SINUS_VIEWER_EXPECTED_SOURCE_FILES = 120;

/**
 * This value is the planned source-code sequence
 * size, not a count of compiled project files.
 */
export function isFinalSourceInventoryComplete(
  count: number,
): boolean {
  return (
    Number.isSafeInteger(count) &&
    count === SINUS_VIEWER_EXPECTED_SOURCE_FILES
  );
}

// ============================================================
// 03 — EMPTY EVIDENCE
// ============================================================

/**
 * Unknown until independently verified.
 */
export const EMPTY_FINAL_REPORT_EVIDENCE:
  Readonly<FinalReportEvidence> = {
    sourceInventory: null,
    sourceStructure: null,
    typescriptBuild: null,
    dependencyResolution: null,

    syntheticSuite: null,
    browserRendering: null,
    mprNavigation: null,

    sessionIsolation: null,
    backendAuthorization: null,
    staleRenderRejection: null,
    resourceCleanup: null,
    recoveryCancellation: null,

    spatialGeometry: null,
    physicalOverlays: null,

    readOnlyDataset: null,
    privacyRedaction: null,

    keyboardAccessibility: null,
    failureAndRecoveryUX: null,
  };

// ============================================================
// 04 — AUDIT CHECK DESCRIPTORS
// ============================================================

interface FinalReportDescriptor {
  readonly id: FinalReportCheckId;
  readonly category: FinalReportCategory;
  readonly label: string;
  readonly evidenceKey: keyof FinalReportEvidence;
  readonly required: boolean;
}

const FINAL_REPORT_DESCRIPTORS:
  readonly FinalReportDescriptor[] = [
    {
      id: "source-inventory",
      category: "source",
      label: "120 planned source files accounted for",
      evidenceKey: "sourceInventory",
      required: true,
    },
    {
      id: "source-structure",
      category: "source",
      label: "Source structure independently checked",
      evidenceKey: "sourceStructure",
      required: true,
    },
    {
      id: "typescript-build",
      category: "build",
      label: "Full frontend TypeScript build passed",
      evidenceKey: "typescriptBuild",
      required: true,
    },
    {
      id: "dependency-resolution",
      category: "build",
      label: "Frontend dependencies resolved",
      evidenceKey: "dependencyResolution",
      required: true,
    },
    {
      id: "synthetic-suite",
      category: "runtime",
      label: "Synthetic integration suite passed",
      evidenceKey: "syntheticSuite",
      required: true,
    },
    {
      id: "browser-rendering",
      category: "runtime",
      label: "Browser viewport rendering passed",
      evidenceKey: "browserRendering",
      required: true,
    },
    {
      id: "mpr-navigation",
      category: "runtime",
      label: "Cross-plane navigation passed",
      evidenceKey: "mprNavigation",
      required: true,
    },
    {
      id: "session-isolation",
      category: "security",
      label: "Volume and session isolation passed",
      evidenceKey: "sessionIsolation",
      required: true,
    },
    {
      id: "backend-authorization",
      category: "security",
      label: "Backend authorization tests passed",
      evidenceKey: "backendAuthorization",
      required: true,
    },
    {
      id: "stale-render-rejection",
      category: "runtime",
      label: "Stale asynchronous frames rejected",
      evidenceKey: "staleRenderRejection",
      required: true,
    },
    {
      id: "resource-cleanup",
      category: "runtime",
      label: "Unmount and volume cleanup passed",
      evidenceKey: "resourceCleanup",
      required: true,
    },
    {
      id: "recovery-cancellation",
      category: "runtime",
      label: "Recovery cancellation tests passed",
      evidenceKey: "recoveryCancellation",
      required: true,
    },
    {
      id: "spatial-geometry",
      category: "geometry",
      label: "DICOM patient-space geometry verified",
      evidenceKey: "spatialGeometry",
      required: true,
    },
    {
      id: "physical-overlays",
      category: "geometry",
      label: "Scale and coordinate overlays validated",
      evidenceKey: "physicalOverlays",
      required: true,
    },
    {
      id: "read-only-dataset",
      category: "dataset",
      label: "Original dataset remained read-only",
      evidenceKey: "readOnlyDataset",
      required: true,
    },
    {
      id: "privacy-redaction",
      category: "security",
      label: "Sensitive data and error redaction passed",
      evidenceKey: "privacyRedaction",
      required: true,
    },
    {
      id: "keyboard-accessibility",
      category: "accessibility",
      label: "Keyboard and focus testing passed",
      evidenceKey: "keyboardAccessibility",
      required: true,
    },
    {
      id: "failure-and-recovery-ux",
      category: "accessibility",
      label: "Failure and recovery UX passed",
      evidenceKey: "failureAndRecoveryUX",
      required: true,
    },
  ];

// ============================================================
// 05 — PURE HELPERS
// ============================================================

export function normalizeFinalReportStatus(
  value: boolean | null | undefined,
): FinalReportStatus {
  if (value === true) {
    return "pass";
  }

  if (value === false) {
    return "fail";
  }

  return "pending";
}

export function finalReportCategoryLabel(
  category: FinalReportCategory,
): string {
  switch (category) {
    case "source":
      return "Source";
    case "build":
      return "Build";
    case "runtime":
      return "Runtime";
    case "security":
      return "Security";
    case "geometry":
      return "Geometry";
    case "dataset":
      return "Dataset";
    case "accessibility":
      return "Accessibility";
  }
}

// ============================================================
// 06 — PURE REPORT EVALUATOR
// ============================================================

export function evaluateFinalIntegrationReport(
  evidence: FinalReportEvidence,
  declaredSourceFiles: number,
): FinalReportSummary {
  const sourceInventoryComplete =
    isFinalSourceInventoryComplete(
      declaredSourceFiles,
    );

  const checks = FINAL_REPORT_DESCRIPTORS.map(
    (descriptor): FinalReportCheck => {
      /**
       * Inventory requires BOTH explicit evidence
       * and a valid parent-supplied file count.
       *
       * Count alone never establishes verification.
       */
      const evidenceValue =
        evidence[descriptor.evidenceKey];

      const status =
        descriptor.id === "source-inventory"
          ? evidenceValue === false ||
            (
              Number.isSafeInteger(declaredSourceFiles) &&
              declaredSourceFiles !==
                SINUS_VIEWER_EXPECTED_SOURCE_FILES
            )
            ? "fail"
            : evidenceValue === true &&
                sourceInventoryComplete
              ? "pass"
              : "pending"
          : normalizeFinalReportStatus(
              evidenceValue,
            );

      return {
        id: descriptor.id,
        category: descriptor.category,
        label: descriptor.label,
        status,
        required: descriptor.required,
      };
    },
  );

  const requiredChecks = checks.filter(
    (check) => check.required,
  );

  const passedChecks = requiredChecks.filter(
    (check) => check.status === "pass",
  ).length;

  const pendingChecks = requiredChecks.filter(
    (check) => check.status === "pending",
  ).length;

  const failedChecks = requiredChecks.filter(
    (check) => check.status === "fail",
  ).length;

  const blockers = requiredChecks.filter(
    (check) => check.status !== "pass",
  );

  const totalChecks = requiredChecks.length;

  const allEvidencePassed =
    sourceInventoryComplete &&
    totalChecks > 0 &&
    passedChecks === totalChecks &&
    pendingChecks === 0 &&
    failedChecks === 0;

  return {
    expectedSourceFiles:
      SINUS_VIEWER_EXPECTED_SOURCE_FILES,
    declaredSourceFiles,
    sourceInventoryComplete,

    checks,
    totalChecks,
    passedChecks,
    pendingChecks,
    failedChecks,
    allEvidencePassed,
    blockers,
  };
}

// ============================================================
// 07 — STATUS LABELS
// ============================================================

const FINAL_STATUS_LABELS: Readonly<
  Record<FinalReportStatus, string>
> = {
  pass: "PASS",
  pending: "PENDING",
  fail: "FAIL",
};

const FINAL_STATUS_COLORS: Readonly<
  Record<FinalReportStatus, string>
> = {
  pass: "#86efac",
  pending: "#fbbf24",
  fail: "#fca5a5",
};

// ============================================================
// 08 — DISPLAY STYLES
// ============================================================

const rootStyle: CSSProperties = {
  width: 620,
  maxWidth: "100%",
  padding: 14,
  boxSizing: "border-box",
  border: "1px solid #475569",
  borderRadius: 8,
  backgroundColor: "#0f172a",
  color: "#e2e8f0",
};

const metricStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 14,
  marginTop: 12,
  marginBottom: 12,
  fontSize: 12,
};

const rowStyle: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "space-between",
  gap: 12,
  padding: "7px 0",
  borderBottom: "1px solid #1e293b",
};

const checkLabelStyle: CSSProperties = {
  color: "#cbd5e1",
  fontSize: 11,
  lineHeight: 1.5,
};

// ============================================================
// 09 — REACT COMPONENT
// ============================================================

export function ViewportFinalIntegrationReport({
  evidence,
  declaredSourceFiles,
  visible = false,
  compact = false,
  className = "",
}: ViewportFinalIntegrationReportProps) {
  const report = useMemo(
    () =>
      evaluateFinalIntegrationReport(
        evidence,
        declaredSourceFiles,
      ),
    [
      declaredSourceFiles,
      evidence.sourceInventory,
      evidence.sourceStructure,
      evidence.typescriptBuild,
      evidence.dependencyResolution,
      evidence.syntheticSuite,
      evidence.browserRendering,
      evidence.mprNavigation,
      evidence.sessionIsolation,
      evidence.backendAuthorization,
      evidence.staleRenderRejection,
      evidence.resourceCleanup,
      evidence.recoveryCancellation,
      evidence.spatialGeometry,
      evidence.physicalOverlays,
      evidence.readOnlyDataset,
      evidence.privacyRedaction,
      evidence.keyboardAccessibility,
      evidence.failureAndRecoveryUX,
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
      aria-label="Sinus Viewer final integration report"
      data-viewport-final-integration-report="true"
      data-final-report-evidence-complete={
        report.allEvidencePassed
          ? "true"
          : "false"
      }
    >
      <h3
        style={{
          margin: 0,
          fontSize: compact ? 13 : 16,
        }}
      >
        Sinus Viewer — Final Integration Report
      </h3>

      <p
        style={{
          margin: "8px 0 0",
          color: "#94a3b8",
          fontSize: 11,
          lineHeight: 1.5,
        }}
      >
        Planned source-file inventory:
        {" "}
        {report.declaredSourceFiles}
        {" / "}
        {report.expectedSourceFiles}
      </p>

      <div style={metricStyle}>
        <strong>
          Passed: {report.passedChecks}
        </strong>

        <strong>
          Pending: {report.pendingChecks}
        </strong>

        <strong>
          Failed: {report.failedChecks}
        </strong>

        <strong>
          Total: {report.totalChecks}
        </strong>
      </div>

      <p
        style={{
          margin: "0 0 12px",
          color: report.allEvidencePassed
            ? "#86efac"
            : "#fbbf24",
          fontSize: 11,
          fontWeight: 700,
        }}
      >
        {report.allEvidencePassed
          ? "All declared evidence passed — review required"
          : "Integration evidence incomplete"}
      </p>

      <div>
        {report.checks.map((check) => (
          <div
            key={check.id}
            style={rowStyle}
            data-final-report-check={check.id}
            data-final-report-check-status={
              check.status
            }
          >
            <div>
              <span
                style={{
                  display: "block",
                  marginBottom: 2,
                  color: "#64748b",
                  fontSize: 9,
                }}
              >
                {finalReportCategoryLabel(
                  check.category,
                )}
              </span>

              <span style={checkLabelStyle}>
                {check.label}
              </span>
            </div>

            <span
              style={{
                fontSize: 10,
                fontWeight: 700,
                color:
                  FINAL_STATUS_COLORS[
                    check.status
                  ],
              }}
            >
              {
                FINAL_STATUS_LABELS[
                  check.status
                ]
              }
            </span>
          </div>
        ))}
      </div>

      {!compact && report.blockers.length > 0 && (
        <p
          style={{
            margin: "12px 0 0",
            color: "#fbbf24",
            fontSize: 11,
          }}
        >
          Outstanding checks:
          {" "}
          {report.blockers.length}
        </p>
      )}

      <p
        style={{
          margin: "12px 0 0",
          color: "#64748b",
          fontSize: 10,
          lineHeight: 1.5,
        }}
      >
        This report summarizes parent-supplied
        validation evidence. It does not compile
        the application, validate DICOM geometry,
        enforce authorization, or certify
        clinical use.
      </p>
    </section>
  );
}

// ============================================================
// 10 — CAPABILITIES
// ============================================================

export function getViewportFinalIntegrationReportCapabilities() {
  return {
    plannedSourceCount: 120,
    sourceInventoryValidation: true,
    explicitEvidenceRequired: true,
    unknownEvidencePending: true,
    falseEvidenceFails: true,
    requiredEvidenceAccounting: true,
    outstandingBlockerReporting: true,
    sourceStructureEvidence: true,
    TypeScriptBuildEvidence: true,
    browserIntegrationEvidence: true,
    sessionIsolationEvidence: true,
    backendAuthorizationEvidence: true,
    staleRenderEvidence: true,
    resourceCleanupEvidence: true,
    recoveryEvidence: true,
    geometryEvidence: true,
    datasetReadOnlyEvidence: true,
    privacyEvidence: true,
    accessibilityEvidence: true,
    hiddenByDefault: true,
    automaticSourceDiscovery: false,
    automaticCompilation: false,
    clinicalCertification: false,
    backendAuthorizationEnforcement: false,
    directDICOMAccess: false,
    directNetworkRequests: false,
    browserPersistence: false,
    sourceDatasetModification: false,
  } as const;
}

// ============================================================
// END OF SINUS VIEWER VIEWPORT FINAL INTEGRATION REPORT — FILE 120
// ============================================================
