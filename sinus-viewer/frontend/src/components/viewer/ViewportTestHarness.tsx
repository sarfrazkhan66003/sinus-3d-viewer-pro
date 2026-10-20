
/**
 * SINUS VIEWER — VIEWPORT TEST HARNESS
 * =====================================
 *
 * FILE 117
 *
 * Deterministic, synthetic test scenarios for
 * the File 116 ViewportIntegrationGuard evaluator.
 *
 * No patient data.
 * No DICOM files.
 * No browser storage.
 * No network calls.
 * No source dataset modifications.
 *
 * This harness evaluates pure decision logic.
 * It does NOT test real browser rendering,
 * actual GPU resources, clinical geometry,
 * backend authorization or image decoding.
 *
 * Keep this developer-only UI disconnected from
 * production patient-viewing routes unless
 * explicitly needed for authorized testing.
 */

import {
  useMemo,
  useState,
  type CSSProperties,
} from "react";

import {
  evaluateViewportIntegration,
  type IntegrationBlockReason,
  type ViewportIntegrationEvaluation,
  type ViewportIntegrationState,
} from "./ViewportIntegrationGuard";

// ============================================================
// 01 — PUBLIC TYPES
// ============================================================

export type ViewportHarnessExpectedGate =
  | "image"
  | "physicalOverlays"
  | "synchronizedOverlays";

export interface ViewportHarnessExpectedDecision {
  readonly allowed: boolean;
  readonly reason: IntegrationBlockReason | null;
}

export interface ViewportHarnessScenario {
  readonly id: string;
  readonly title: string;
  readonly explanation: string;
  readonly input: ViewportIntegrationState;

  readonly expected: Readonly<
    Record<
      ViewportHarnessExpectedGate,
      ViewportHarnessExpectedDecision
    >
  >;
}

export interface ViewportHarnessGateResult {
  readonly gate: ViewportHarnessExpectedGate;
  readonly passed: boolean;
  readonly expected: ViewportHarnessExpectedDecision;
  readonly actual: ViewportHarnessExpectedDecision;
}

export interface ViewportHarnessScenarioResult {
  readonly id: string;
  readonly title: string;
  readonly passed: boolean;
  readonly gateResults: readonly ViewportHarnessGateResult[];
}

export interface ViewportHarnessSummary {
  readonly totalScenarios: number;
  readonly passedScenarios: number;
  readonly failedScenarios: number;
  readonly totalGateChecks: number;
  readonly passedGateChecks: number;
  readonly failedGateChecks: number;
  readonly results: readonly ViewportHarnessScenarioResult[];
}

export interface ViewportTestHarnessProps {
  readonly visible?: boolean;
  readonly compact?: boolean;
  readonly className?: string;
}

// ============================================================
// 02 — SYNTHETIC BASE STATE
// ============================================================

/**
 * Generation and revision values are arbitrary
 * non-identifying numbers.
 *
 * This is deliberately NOT a DICOM fixture.
 */
export const VIEWPORT_HARNESS_READY_STATE:
  Readonly<ViewportIntegrationState> = {
    authorized: true,
    phase: "ready",

    generation: 7,
    presentedGeneration: 7,

    renderRevision: 12,
    acceptedRenderRevision: 12,

    frameConfirmed: true,
    staleRenderProtectionConfirmed: true,

    cleanupInProgress: false,
    recoveryPhase: "idle",

    geometryVerified: true,
    geometryGeneration: 7,

    navigationRevision: 5,
    syncConfirmed: true,
    syncGeneration: 7,
    syncRevision: 5,
  };

// ============================================================
// 03 — TEST SCENARIOS
// ============================================================

function expectedDecision(
  allowed: boolean,
  reason: IntegrationBlockReason | null = null,
): ViewportHarnessExpectedDecision {
  return { allowed, reason };
}

function scenario(
  id: string,
  title: string,
  explanation: string,
  changes: Partial<ViewportIntegrationState>,
  image: ViewportHarnessExpectedDecision,
  physicalOverlays: ViewportHarnessExpectedDecision,
  synchronizedOverlays: ViewportHarnessExpectedDecision,
): ViewportHarnessScenario {
  return {
    id,
    title,
    explanation,
    input: {
      ...VIEWPORT_HARNESS_READY_STATE,
      ...changes,
    },
    expected: {
      image,
      physicalOverlays,
      synchronizedOverlays,
    },
  };
}

const ALLOW = expectedDecision(true);

export const VIEWPORT_HARNESS_SCENARIOS:
  readonly ViewportHarnessScenario[] = [
    scenario(
      "fully-confirmed",
      "Fully confirmed current viewport",
      "All three gates should allow current content.",
      {},
      ALLOW,
      ALLOW,
      ALLOW,
    ),

    scenario(
      "unauthorized",
      "Unauthorized viewport",
      "All gates should block without authorization.",
      { authorized: false },
      expectedDecision(false, "unauthorized"),
      expectedDecision(false, "unauthorized"),
      expectedDecision(false, "unauthorized"),
    ),

    scenario(
      "invalid-generation",
      "Invalid volume generation",
      "Reject an invalid current volume identity.",
      { generation: -1 },
      expectedDecision(false, "invalid-generation"),
      expectedDecision(false, "invalid-generation"),
      expectedDecision(false, "invalid-generation"),
    ),

    scenario(
      "invalid-render-revision",
      "Invalid render revision",
      "Reject a non-valid current render revision.",
      { renderRevision: -1 },
      expectedDecision(false, "invalid-revision"),
      expectedDecision(false, "invalid-revision"),
      expectedDecision(false, "invalid-revision"),
    ),

    scenario(
      "cleanup-running",
      "Resource cleanup in progress",
      "Do not mount image content during cleanup.",
      { cleanupInProgress: true },
      expectedDecision(false, "cleanup-in-progress"),
      expectedDecision(false, "cleanup-in-progress"),
      expectedDecision(false, "cleanup-in-progress"),
    ),

    scenario(
      "recovery-running",
      "Render recovery in progress",
      "Block image display while retrying.",
      { recoveryPhase: "retrying" },
      expectedDecision(false, "recovery-in-progress"),
      expectedDecision(false, "recovery-in-progress"),
      expectedDecision(false, "recovery-in-progress"),
    ),

    scenario(
      "loading",
      "Image still loading",
      "Render readiness has not been confirmed.",
      { phase: "loading" },
      expectedDecision(false, "not-ready"),
      expectedDecision(false, "not-ready"),
      expectedDecision(false, "not-ready"),
    ),

    scenario(
      "frame-unconfirmed",
      "Unconfirmed frame",
      "Ready phase alone cannot enable display.",
      { frameConfirmed: false },
      expectedDecision(false, "frame-unconfirmed"),
      expectedDecision(false, "frame-unconfirmed"),
      expectedDecision(false, "frame-unconfirmed"),
    ),

    scenario(
      "stale-volume-frame",
      "Stale frame from previous volume",
      "Reject pixels accepted for another generation.",
      { presentedGeneration: 6 },
      expectedDecision(false, "stale-frame"),
      expectedDecision(false, "stale-frame"),
      expectedDecision(false, "stale-frame"),
    ),

    scenario(
      "stale-render-revision",
      "Stale render revision",
      "Reject an earlier render revision.",
      { acceptedRenderRevision: 11 },
      expectedDecision(false, "render-revision-mismatch"),
      expectedDecision(false, "render-revision-mismatch"),
      expectedDecision(false, "render-revision-mismatch"),
    ),

    scenario(
      "render-protection-missing",
      "Unconfirmed stale-render protection",
      "Fail closed without scheduler protection.",
      { staleRenderProtectionConfirmed: false },
      expectedDecision(false, "stale-protection-unconfirmed"),
      expectedDecision(false, "stale-protection-unconfirmed"),
      expectedDecision(false, "stale-protection-unconfirmed"),
    ),

    scenario(
      "geometry-unverified",
      "Unverified spatial geometry",
      "Image may display, but physical overlays cannot.",
      { geometryVerified: false },
      ALLOW,
      expectedDecision(false, "geometry-unverified"),
      expectedDecision(false, "geometry-unverified"),
    ),

    scenario(
      "stale-geometry",
      "Geometry from another volume",
      "Reject old physical geometry and synchronization.",
      { geometryGeneration: 6 },
      ALLOW,
      expectedDecision(false, "geometry-generation-mismatch"),
      expectedDecision(false, "geometry-generation-mismatch"),
    ),

    scenario(
      "sync-unconfirmed",
      "Unconfirmed synchronization",
      "Image and geometry may display independently.",
      { syncConfirmed: false },
      ALLOW,
      ALLOW,
      expectedDecision(false, "sync-unconfirmed"),
    ),

    scenario(
      "stale-sync-volume",
      "Sync acknowledgement from previous volume",
      "Reject synchronization for another generation.",
      { syncGeneration: 6 },
      ALLOW,
      ALLOW,
      expectedDecision(false, "sync-generation-mismatch"),
    ),

    scenario(
      "stale-navigation-revision",
      "Outdated navigation acknowledgement",
      "Reject synchronization until revision is current.",
      { syncRevision: 4 },
      ALLOW,
      ALLOW,
      expectedDecision(false, "sync-revision-mismatch"),
    ),

    scenario(
      "invalid-navigation-revision",
      "Invalid navigation revision",
      "Invalid navigation identity cannot be confirmed.",
      { navigationRevision: -1 },
      ALLOW,
      ALLOW,
      expectedDecision(false, "sync-revision-mismatch"),
    ),
  ];

// ============================================================
// 04 — PURE SCENARIO RUNNER
// ============================================================

const GATE_NAMES:
  readonly ViewportHarnessExpectedGate[] = [
    "image",
    "physicalOverlays",
    "synchronizedOverlays",
  ];

export function runViewportHarnessScenario(
  test: ViewportHarnessScenario,
): ViewportHarnessScenarioResult {
  const evaluation:
    ViewportIntegrationEvaluation =
      evaluateViewportIntegration(test.input);

  const gateResults = GATE_NAMES.map(
    (gate): ViewportHarnessGateResult => {
      const actual = evaluation[gate];
      const expected = test.expected[gate];

      return {
        gate,
        passed:
          actual.allowed === expected.allowed &&
          actual.reason === expected.reason,
        expected,
        actual: {
          allowed: actual.allowed,
          reason: actual.reason,
        },
      };
    },
  );

  return {
    id: test.id,
    title: test.title,
    passed: gateResults.every(
      (result) => result.passed,
    ),
    gateResults,
  };
}

export function runViewportHarnessSuite(
  scenarios:
    readonly ViewportHarnessScenario[] =
      VIEWPORT_HARNESS_SCENARIOS,
): ViewportHarnessSummary {
  const results = scenarios.map(
    runViewportHarnessScenario,
  );

  const passedScenarios = results.filter(
    (result) => result.passed,
  ).length;

  const totalGateChecks = results.reduce(
    (total, result) =>
      total + result.gateResults.length,
    0,
  );

  const passedGateChecks = results.reduce(
    (total, result) =>
      total +
      result.gateResults.filter(
        (gate) => gate.passed,
      ).length,
    0,
  );

  return {
    totalScenarios: results.length,
    passedScenarios,
    failedScenarios:
      results.length - passedScenarios,
    totalGateChecks,
    passedGateChecks,
    failedGateChecks:
      totalGateChecks - passedGateChecks,
    results,
  };
}

// ============================================================
// 05 — PRESENTATION HELPERS
// ============================================================

export function viewportHarnessGateLabel(
  gate: ViewportHarnessExpectedGate,
): string {
  switch (gate) {
    case "image":
      return "Image";
    case "physicalOverlays":
      return "Geometry";
    case "synchronizedOverlays":
      return "MPR Sync";
  }
}

export function formatViewportHarnessDecision(
  decision: ViewportHarnessExpectedDecision,
): string {
  if (decision.allowed) {
    return "ALLOW";
  }

  // Only an allowlisted reason, never a raw error.
  return decision.reason
    ? `BLOCK: ${decision.reason}`
    : "BLOCK";
}

// ============================================================
// 06 — STYLES
// ============================================================

const rootStyle: CSSProperties = {
  width: 580,
  maxWidth: "100%",
  padding: 14,
  boxSizing: "border-box",
  backgroundColor: "#0f172a",
  color: "#e2e8f0",
  border: "1px solid #475569",
  borderRadius: 8,
};

const summaryStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: 12,
  marginTop: 10,
  marginBottom: 12,
  fontSize: 12,
};

const scenarioStyle: CSSProperties = {
  padding: 10,
  border: "1px solid #334155",
  borderRadius: 6,
  marginBottom: 8,
  backgroundColor: "#111c2e",
};

const tableStyle: CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: 10,
  marginTop: 8,
};

// ============================================================
// 07 — OPTIONAL DEVELOPER COMPONENT
// ============================================================

export function ViewportTestHarness({
  visible = false,
  compact = false,
  className = "",
}: ViewportTestHarnessProps) {
  const [showFailuresOnly, setShowFailuresOnly] =
    useState(false);

  const summary = useMemo(
    () => runViewportHarnessSuite(),
    [],
  );

  if (!visible) {
    return null;
  }

  const displayedResults = showFailuresOnly
    ? summary.results.filter(
        (result) => !result.passed,
      )
    : summary.results;

  const allPassed =
    summary.failedScenarios === 0 &&
    summary.failedGateChecks === 0;

  return (
    <section
      className={className}
      style={{
        ...rootStyle,
        padding: compact ? 8 : 14,
      }}
      role="region"
      aria-label="Viewport integration test harness"
      data-viewport-test-harness="true"
      data-harness-result={
        allPassed ? "pass" : "fail"
      }
    >
      <h3
        style={{
          margin: 0,
          fontSize: compact ? 12 : 15,
        }}
      >
        MPR Integration Test Harness
      </h3>

      <p
        style={{
          color: "#94a3b8",
          fontSize: 11,
          lineHeight: 1.5,
        }}
      >
        Synthetic decision tests only.
        No patient datasets or DICOM files loaded.
      </p>

      <div style={summaryStyle}>
        <strong>
          Scenarios: {summary.passedScenarios}
          {" / "}
          {summary.totalScenarios}
        </strong>

        <strong>
          Gate checks: {summary.passedGateChecks}
          {" / "}
          {summary.totalGateChecks}
        </strong>

        <span
          style={{
            color: allPassed
              ? "#86efac"
              : "#fca5a5",
            fontWeight: 700,
          }}
        >
          {allPassed ? "PASS" : "FAIL"}
        </span>
      </div>

      <label
        style={{
          display: "flex",
          alignItems: "center",
          gap: 7,
          fontSize: 11,
          marginBottom: 12,
        }}
      >
        <input
          type="checkbox"
          checked={showFailuresOnly}
          onChange={(event) => {
            setShowFailuresOnly(
              event.currentTarget.checked,
            );
          }}
        />
        Show failed scenarios only
      </label>

      {displayedResults.length === 0 && (
        <p
          style={{
            color: "#86efac",
            fontSize: 11,
          }}
        >
          No failed scenarios in this suite.
        </p>
      )}

      {displayedResults.map((result) => (
        <article
          key={result.id}
          style={scenarioStyle}
          data-harness-scenario={result.id}
          data-harness-scenario-status={
            result.passed ? "pass" : "fail"
          }
        >
          <strong
            style={{
              fontSize: compact ? 10 : 12,
            }}
          >
            {result.title}
          </strong>

          <span
            style={{
              marginLeft: 8,
              fontSize: 10,
              color: result.passed
                ? "#86efac"
                : "#fca5a5",
            }}
          >
            {result.passed ? "PASS" : "FAIL"}
          </span>

          {!compact && (
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={{ textAlign: "left" }}>
                    Gate
                  </th>
                  <th style={{ textAlign: "left" }}>
                    Expected
                  </th>
                  <th style={{ textAlign: "left" }}>
                    Actual
                  </th>
                  <th style={{ textAlign: "left" }}>
                    Test
                  </th>
                </tr>
              </thead>

              <tbody>
                {result.gateResults.map((gate) => (
                  <tr key={gate.gate}>
                    <td>
                      {viewportHarnessGateLabel(
                        gate.gate,
                      )}
                    </td>
                    <td>
                      {formatViewportHarnessDecision(
                        gate.expected,
                      )}
                    </td>
                    <td>
                      {formatViewportHarnessDecision(
                        gate.actual,
                      )}
                    </td>
                    <td
                      style={{
                        color: gate.passed
                          ? "#86efac"
                          : "#fca5a5",
                      }}
                    >
                      {gate.passed
                        ? "PASS"
                        : "FAIL"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </article>
      ))}

      <p
        style={{
          margin: "12px 0 0",
          fontSize: 10,
          lineHeight: 1.5,
          color: "#64748b",
        }}
      >
        Test results validate pure integration
        decisions only. Actual image rendering,
        backend authorization, asynchronous resource
        cleanup and clinical geometry require
        independent testing.
      </p>
    </section>
  );
}

// ============================================================
// 08 — CAPABILITIES
// ============================================================

export function getViewportTestHarnessCapabilities() {
  return {
    deterministicSyntheticScenarios: true,
    pureIntegrationEvaluatorTests: true,
    authorizationScenario: true,
    invalidIdentityScenarios: true,
    cleanupScenario: true,
    recoveryScenario: true,
    frameReadinessScenario: true,
    staleVolumeScenario: true,
    renderRevisionScenario: true,
    staleProtectionScenario: true,
    geometryScenarios: true,
    synchronizationScenarios: true,
    gateLevelComparison: true,
    scenarioLevelSummary: true,
    failuresOnlyFilter: true,
    hiddenByDefault: true,
    noPatientFixtures: true,
    noDICOMLoading: true,
    directNetworkRequests: false,
    browserPersistence: false,
    originalDatasetModification: false,
    realRendererTesting: false,
    independentGeometryValidation: false,
    backendAuthorizationTesting: false,
    clinicalValidationComplete: false,
  } as const;
}

// ============================================================
// END OF SINUS VIEWER VIEWPORT TEST HARNESS — FILE 117
// ============================================================
