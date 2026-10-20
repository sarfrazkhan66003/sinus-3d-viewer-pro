
/**
 * SINUS VIEWER — VIEWPORT DIAGNOSTICS PANEL
 * =========================================
 *
 * File 110
 *
 * A privacy-conscious, display-only diagnostics
 * panel for axial/coronal/sagittal MPR viewports.
 *
 * Displays:
 * - Rendering lifecycle and readiness
 * - Parent-verified geometry state
 * - Synchronization state
 * - Recovery state
 * - Current, parent-measured render performance
 *
 * This component:
 * - Does not load DICOM data.
 * - Does not infer anatomical accuracy.
 * - Does not read patient identifiers or paths.
 * - Does not display raw backend error strings.
 * - Does not start telemetry or polling.
 * - Does not modify the original dataset.
 *
 * All diagnostic states must be supplied by
 * the parent from the current volume/session.
 */

import {
  useMemo,
  type CSSProperties,
} from "react";

// ============================================================
// 01 — PUBLIC TYPES
// ============================================================

export type DiagnosticsViewportPlane =
  | "axial"
  | "coronal"
  | "sagittal";

export type DiagnosticsViewportPhase =
  | "idle"
  | "loading"
  | "decoding"
  | "preparing"
  | "rendering"
  | "ready"
  | "unavailable"
  | "error";

export type DiagnosticsSyncStatus =
  | "unavailable"
  | "disabled"
  | "paused"
  | "syncing"
  | "synced"
  | "error";

export type DiagnosticsRecoveryStatus =
  | "idle"
  | "retrying"
  | "succeeded"
  | "failed"
  | "exhausted";

export type DiagnosticsPlacement =
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right";

export type DiagnosticsSeverity =
  | "normal"
  | "notice"
  | "warning";

export interface ViewportDiagnosticsData {
  readonly phase: DiagnosticsViewportPhase;

  /**
   * True only when current image pixels were
   * accepted and presented by the renderer.
   */
  readonly currentFrameConfirmed: boolean;

  /**
   * True only after current patient-space
   * geometry has been independently validated.
   */
  readonly geometryVerified: boolean;

  readonly syncStatus: DiagnosticsSyncStatus;

  /**
   * A synchronized update must belong to the
   * current volume and navigation revision.
   */
  readonly syncUpdateConfirmed: boolean;

  readonly recoveryStatus: DiagnosticsRecoveryStatus;

  /**
   * Metrics come from the current render worker.
   * Samples must be invalidated when stale.
   */
  readonly performanceSamplesFresh: boolean;

  readonly fps?: number | null;
  readonly frameTimeMs?: number | null;
}

export interface ViewportDiagnosticsPanelProps {
  readonly plane: DiagnosticsViewportPlane;
  readonly data: ViewportDiagnosticsData | null;

  readonly visible?: boolean;
  readonly compact?: boolean;
  readonly placement?: DiagnosticsPlacement;

  readonly showPerformance?: boolean;
  readonly showSync?: boolean;
  readonly showRecovery?: boolean;
  readonly showGeometry?: boolean;

  readonly className?: string;
}

export interface DiagnosticsDisplayRow {
  readonly key: string;
  readonly label: string;
  readonly value: string;
  readonly severity: DiagnosticsSeverity;
}

export interface ViewportDiagnosticsDisplay {
  readonly planeLabel: string;
  readonly rows: readonly DiagnosticsDisplayRow[];
  readonly ready: boolean;
  readonly verifiedGeometry: boolean;
  readonly verifiedSync: boolean;
}

// ============================================================
// 02 — FIXED STATUS LABELS
// ============================================================

const PHASE_LABELS: Readonly<
  Record<DiagnosticsViewportPhase, string>
> = {
  idle: "Idle",
  loading: "Loading",
  decoding: "Decoding",
  preparing: "Preparing",
  rendering: "Rendering",
  ready: "Ready",
  unavailable: "Unavailable",
  error: "Error",
};

const SYNC_LABELS: Readonly<
  Record<DiagnosticsSyncStatus, string>
> = {
  unavailable: "Unavailable",
  disabled: "Off",
  paused: "Paused",
  syncing: "Updating",
  synced: "Confirmed",
  error: "Failed",
};

const RECOVERY_LABELS: Readonly<
  Record<DiagnosticsRecoveryStatus, string>
> = {
  idle: "Idle",
  retrying: "Retrying",
  succeeded: "Request completed",
  failed: "Failed",
  exhausted: "Limit reached",
};

const SEVERITY_COLORS: Readonly<
  Record<DiagnosticsSeverity, string>
> = {
  normal: "#a7f3d0",
  notice: "#cbd5e1",
  warning: "#fbbf24",
};

// ============================================================
// 03 — VALIDATION
// ============================================================

export function diagnosticsPlaneLabel(
  plane: DiagnosticsViewportPlane,
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

export function isDiagnosticsViewportPhase(
  value: unknown,
): value is DiagnosticsViewportPhase {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(
      PHASE_LABELS,
      value,
    )
  );
}

export function isDiagnosticsSyncStatus(
  value: unknown,
): value is DiagnosticsSyncStatus {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(
      SYNC_LABELS,
      value,
    )
  );
}

export function isDiagnosticsRecoveryStatus(
  value: unknown,
): value is DiagnosticsRecoveryStatus {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(
      RECOVERY_LABELS,
      value,
    )
  );
}

export function validDiagnosticsFPS(
  value: number | null | undefined,
): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value > 0 &&
    value <= 1000
  );
}

export function validDiagnosticsFrameTime(
  value: number | null | undefined,
): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 600000
  );
}

// ============================================================
// 04 — SAFE DISPLAY MODEL
// ============================================================

/**
 * This is only a diagnostic display model.
 *
 * "Verified" means the parent explicitly supplied
 * a verified flag for the current context.
 *
 * It does not independently validate DICOM
 * orientation, spacing or patient transforms.
 */
export function buildViewportDiagnosticsDisplay(
  plane: DiagnosticsViewportPlane,
  data: ViewportDiagnosticsData | null,
  options: {
    readonly showPerformance?: boolean;
    readonly showSync?: boolean;
    readonly showRecovery?: boolean;
    readonly showGeometry?: boolean;
  } = {},
): ViewportDiagnosticsDisplay {
  const planeLabel =
    diagnosticsPlaneLabel(plane);

  const phase =
    data &&
    isDiagnosticsViewportPhase(data.phase)
      ? data.phase
      : "unavailable";

  const ready =
    phase === "ready" &&
    data?.currentFrameConfirmed === true;

  const verifiedGeometry =
    ready &&
    data?.geometryVerified === true;

  const syncStatus =
    data &&
    isDiagnosticsSyncStatus(data.syncStatus)
      ? data.syncStatus
      : "unavailable";

  const recoveryStatus =
    data &&
    isDiagnosticsRecoveryStatus(
      data.recoveryStatus,
    )
      ? data.recoveryStatus
      : "idle";

  const verifiedSync =
    ready &&
    verifiedGeometry &&
    syncStatus === "synced" &&
    data?.syncUpdateConfirmed === true;

  const rows: DiagnosticsDisplayRow[] = [];

  rows.push({
    key: "lifecycle",
    label: "Lifecycle",
    value: PHASE_LABELS[phase],
    severity:
      phase === "error" ||
      phase === "unavailable"
        ? "warning"
        : "notice",
  });

  rows.push({
    key: "frame",
    label: "Current frame",
    value: ready
      ? "Confirmed"
      : "Not confirmed",
    severity: ready
      ? "normal"
      : "notice",
  });

  if (options.showGeometry !== false) {
    rows.push({
      key: "geometry",
      label: "Geometry",
      value: verifiedGeometry
        ? "Verified"
        : "Not verified",
      severity: verifiedGeometry
        ? "normal"
        : "warning",
    });
  }

  if (options.showSync !== false) {
    const syncLabel =
      syncStatus === "synced"
        ? verifiedSync
          ? "Confirmed"
          : "Not confirmed"
        : SYNC_LABELS[syncStatus];

    rows.push({
      key: "synchronization",
      label: "MPR sync",
      value: syncLabel,
      severity: verifiedSync
        ? "normal"
        : syncStatus === "error"
          ? "warning"
          : "notice",
    });
  }

  if (options.showRecovery !== false) {
    rows.push({
      key: "recovery",
      label: "Recovery",
      value: RECOVERY_LABELS[recoveryStatus],
      severity:
        recoveryStatus === "failed" ||
        recoveryStatus === "exhausted"
          ? "warning"
          : "notice",
    });
  }

  if (options.showPerformance !== false) {
    const fresh =
      ready &&
      data?.performanceSamplesFresh === true;

    const fps =
      fresh && validDiagnosticsFPS(data?.fps)
        ? data!.fps!
        : null;

    const frameTime =
      fresh &&
      validDiagnosticsFrameTime(
        data?.frameTimeMs,
      )
        ? data!.frameTimeMs!
        : null;

    rows.push({
      key: "fps",
      label: "Frame rate",
      value:
        fps === null
          ? "Not measured"
          : `${fps.toFixed(1)} FPS`,
      severity: "notice",
    });

    rows.push({
      key: "frameTime",
      label: "Frame duration",
      value:
        frameTime === null
          ? "Not measured"
          : `${frameTime.toFixed(1)} ms`,
      severity: "notice",
    });
  }

  return {
    planeLabel,
    rows,
    ready,
    verifiedGeometry,
    verifiedSync,
  };
}

// ============================================================
// 05 — PLACEMENT
// ============================================================

function diagnosticsPlacementStyle(
  placement: DiagnosticsPlacement,
): CSSProperties {
  switch (placement) {
    case "top-left":
      return { top: 12, left: 12 };
    case "top-right":
      return { top: 12, right: 12 };
    case "bottom-left":
      return { bottom: 12, left: 12 };
    case "bottom-right":
      return { bottom: 12, right: 12 };
  }
}

// ============================================================
// 06 — STYLES
// ============================================================

const rootStyle: CSSProperties = {
  position: "absolute",
  zIndex: 25,
  width: 245,
  maxWidth: "calc(100% - 24px)",
  maxHeight: "calc(100% - 24px)",
  overflowY: "auto",
  padding: 11,
  boxSizing: "border-box",
  border: "1px solid #475569",
  borderRadius: 7,
  backgroundColor: "rgba(10,17,29,0.95)",
  color: "#e2e8f0",
  boxShadow: "0 8px 24px rgba(0,0,0,0.25)",
  fontVariantNumeric: "tabular-nums",
};

const headerStyle: CSSProperties = {
  marginBottom: 10,
  paddingBottom: 8,
  borderBottom: "1px solid #334155",
  color: "#e0f2fe",
  fontSize: 12,
  fontWeight: 700,
};

const rowStyle: CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  justifyContent: "space-between",
  gap: 9,
  padding: "4px 0",
};

const labelStyle: CSSProperties = {
  fontSize: 10,
  color: "#94a3b8",
};

const valueStyle: CSSProperties = {
  fontSize: 10,
  fontWeight: 600,
  textAlign: "right",
};

// ============================================================
// 07 — COMPONENT
// ============================================================

export function ViewportDiagnosticsPanel({
  plane,
  data,
  visible = false,
  compact = false,
  placement = "bottom-right",
  showPerformance = true,
  showSync = true,
  showRecovery = true,
  showGeometry = true,
  className = "",
}: ViewportDiagnosticsPanelProps) {
  const display = useMemo(
    () =>
      buildViewportDiagnosticsDisplay(
        plane,
        data,
        {
          showPerformance,
          showSync,
          showRecovery,
          showGeometry,
        },
      ),
    [
      plane,
      data?.phase,
      data?.currentFrameConfirmed,
      data?.geometryVerified,
      data?.syncStatus,
      data?.syncUpdateConfirmed,
      data?.recoveryStatus,
      data?.performanceSamplesFresh,
      data?.fps,
      data?.frameTimeMs,
      showPerformance,
      showSync,
      showRecovery,
      showGeometry,
    ],
  );

  if (!visible) {
    return null;
  }

  return (
    <aside
      className={className}
      style={{
        ...rootStyle,
        ...diagnosticsPlacementStyle(
          placement,
        ),
        width: compact ? 200 : 245,
        padding: compact ? 7 : 11,
      }}
      role="region"
      aria-label={
        `${display.planeLabel} viewport diagnostics`
      }
      data-viewport-diagnostics="true"
      data-diagnostics-plane={plane}
      data-diagnostics-ready={
        display.ready ? "true" : "false"
      }
      data-diagnostics-geometry={
        display.verifiedGeometry
          ? "verified"
          : "unverified"
      }
    >
      <div style={headerStyle}>
        {display.planeLabel} Diagnostics
      </div>

      <div>
        {display.rows.map((row) => (
          <div
            key={row.key}
            style={rowStyle}
            data-diagnostics-field={row.key}
          >
            <span style={labelStyle}>
              {row.label}
            </span>

            <span
              style={{
                ...valueStyle,
                color:
                  SEVERITY_COLORS[row.severity],
              }}
            >
              {row.value}
            </span>
          </div>
        ))}
      </div>

      {!compact && (
        <p
          style={{
            margin: "10px 0 0",
            fontSize: 9,
            lineHeight: 1.5,
            color: "#64748b",
          }}
        >
          Diagnostic UI state only. Not a
          clinical image-validation report.
        </p>
      )}
    </aside>
  );
}

// ============================================================
// 08 — CAPABILITIES
// ============================================================

export function getViewportDiagnosticsPanelCapabilities() {
  return {
    axialSupport: true,
    coronalSupport: true,
    sagittalSupport: true,
    lifecycleDisplay: true,
    currentFrameConfirmation: true,
    parentVerifiedGeometryState: true,
    parentConfirmedSynchronization: true,
    recoveryStateDisplay: true,
    optionalFPSDisplay: true,
    optionalFrameDurationDisplay: true,
    stalePerformanceRejection: true,
    invalidMetricRejection: true,
    fixedStatusLabels: true,
    configurablePlacement: true,
    compactLayout: true,
    hiddenByDefault: true,
    parentOwnedDiagnosticState: true,
    rawBackendErrorDisplay: false,
    patientMetadataDisplay: false,
    coordinateExposure: false,
    directDICOMAccess: false,
    directNetworkRequests: false,
    browserPersistence: false,
    sourceDatasetModification: false,
    clinicalValidationComplete: false,
  } as const;
}

// ============================================================
// END OF SINUS VIEWER VIEWPORT DIAGNOSTICS PANEL — FILE 110
// ============================================================
