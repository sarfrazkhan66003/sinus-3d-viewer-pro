
/**
 * SINUS VIEWER — VIEWPORT SYNC INDICATOR
 * ======================================
 *
 * Controlled synchronization status presentation
 * for one MPR viewport.
 *
 * States:
 * - unavailable
 * - disabled
 * - paused
 * - syncing
 * - synced
 * - error
 *
 * Safeguards:
 * - Synced status requires verified geometry.
 * - Synced status also requires confirmation
 *   of the current synchronized update.
 * - Unknown/invalid state fails closed.
 * - No coordinate or DICOM metadata exposure.
 * - No synchronization operations performed here.
 * - No network calls, persistence or file writes.
 *
 * Parent MPR controller remains authoritative
 * for patient-space geometry and crosshair state.
 */

import {
  useMemo,
  type CSSProperties,
} from "react";

// ============================================================
// 01 — TYPES
// ============================================================

export type SyncIndicatorPlane =
  | "axial"
  | "coronal"
  | "sagittal";

export type ViewportSyncStatus =
  | "unavailable"
  | "disabled"
  | "paused"
  | "syncing"
  | "synced"
  | "error";

export type SyncIndicatorPlacement =
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right";

export interface ViewportSyncState {
  readonly status: ViewportSyncStatus;

  /**
   * True only when the parent validates the current
   * volume's patient-space MPR display transforms.
   */
  readonly geometryVerified: boolean;

  /**
   * True only if the current sync operation was
   * completed and acknowledged by the controller.
   *
   * Must be invalidated when plane, volume,
   * crosshair target or geometry revision changes.
   */
  readonly currentUpdateConfirmed: boolean;
}

export interface ViewportSyncIndicatorProps {
  readonly plane: SyncIndicatorPlane;
  readonly state: ViewportSyncState | null;

  readonly visible?: boolean;
  readonly compact?: boolean;
  readonly showDescription?: boolean;

  readonly placement?: SyncIndicatorPlacement;
  readonly className?: string;
}

export interface ViewportSyncDisplay {
  readonly status: ViewportSyncStatus;
  readonly label: string;
  readonly description: string;
  readonly color: string;
  readonly isVerifiedSynced: boolean;
}

// ============================================================
// 02 — STATUS CATALOG
// ============================================================

interface SyncStatusDefinition {
  readonly label: string;
  readonly description: string;
  readonly color: string;
}

const SYNC_STATUS_CATALOG: Readonly<
  Record<ViewportSyncStatus, SyncStatusDefinition>
> = {
  unavailable: {
    label: "Sync unavailable",
    description:
      "Synchronized navigation is not available.",
    color: "#94a3b8",
  },
  disabled: {
    label: "Sync off",
    description:
      "Synchronized navigation is disabled.",
    color: "#94a3b8",
  },
  paused: {
    label: "Sync paused",
    description:
      "Synchronized navigation is temporarily paused.",
    color: "#fbbf24",
  },
  syncing: {
    label: "Sync updating",
    description:
      "Applying synchronized viewport navigation.",
    color: "#38bdf8",
  },
  synced: {
    label: "Synced",
    description:
      "Current navigation update confirmed with verified geometry.",
    color: "#34d399",
  },
  error: {
    label: "Sync unavailable",
    description:
      "Synchronized navigation could not be completed.",
    color: "#fb7185",
  },
};

// ============================================================
// 03 — VALIDATION
// ============================================================

export function isViewportSyncStatus(
  value: unknown,
): value is ViewportSyncStatus {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(
      SYNC_STATUS_CATALOG,
      value,
    )
  );
}

export function syncIndicatorPlaneLabel(
  plane: SyncIndicatorPlane,
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
// 04 — SAFE DISPLAY MODEL
// ============================================================

export function buildViewportSyncDisplay(
  state: ViewportSyncState | null,
): ViewportSyncDisplay {
  if (!state || !isViewportSyncStatus(state.status)) {
    const fallback =
      SYNC_STATUS_CATALOG.unavailable;

    return {
      status: "unavailable",
      ...fallback,
      isVerifiedSynced: false,
    };
  }

  const canReportSynced =
    state.status === "synced" &&
    state.geometryVerified === true &&
    state.currentUpdateConfirmed === true;

  /**
   * Fail closed:
   *
   * If upstream declares "synced" without
   * valid evidence, do not show a green state.
   */
  const safeStatus: ViewportSyncStatus =
    state.status === "synced" && !canReportSynced
      ? "unavailable"
      : state.status;

  const definition =
    SYNC_STATUS_CATALOG[safeStatus];

  return {
    status: safeStatus,
    label: definition.label,
    description: definition.description,
    color: definition.color,
    isVerifiedSynced: canReportSynced,
  };
}

// ============================================================
// 05 — PLACEMENT
// ============================================================

function syncIndicatorPlacementStyle(
  placement: SyncIndicatorPlacement,
): CSSProperties {
  switch (placement) {
    case "top-left":
      return { top: 10, left: 10 };
    case "top-right":
      return { top: 10, right: 10 };
    case "bottom-left":
      return { bottom: 10, left: 10 };
    case "bottom-right":
      return { bottom: 10, right: 10 };
  }
}

// ============================================================
// 06 — STYLES
// ============================================================

const rootStyle: CSSProperties = {
  position: "absolute",
  zIndex: 16,
  display: "flex",
  alignItems: "flex-start",
  gap: 7,
  boxSizing: "border-box",
  maxWidth: "calc(100% - 20px)",
  padding: "7px 9px",
  border: "1px solid rgba(148,163,184,0.25)",
  borderRadius: 6,
  backgroundColor: "rgba(8,17,30,0.9)",
  color: "#e2e8f0",
  pointerEvents: "none",
  userSelect: "none",
};

const dotBaseStyle: CSSProperties = {
  width: 8,
  height: 8,
  borderRadius: "50%",
  flexShrink: 0,
  marginTop: 4,
};

const textGroupStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 3,
  minWidth: 0,
};

// ============================================================
// 07 — MAIN COMPONENT
// ============================================================

export function ViewportSyncIndicator({
  plane,
  state,
  visible = true,
  compact = false,
  showDescription = true,
  placement = "bottom-left",
  className = "",
}: ViewportSyncIndicatorProps) {
  const display = useMemo(
    () => buildViewportSyncDisplay(state),
    [
      state?.status,
      state?.geometryVerified,
      state?.currentUpdateConfirmed,
    ],
  );

  if (!visible) {
    return null;
  }

  const planeLabel =
    syncIndicatorPlaneLabel(plane);

  return (
    <aside
      className={className}
      style={{
        ...rootStyle,
        ...syncIndicatorPlacementStyle(placement),
        padding: compact ? "5px 7px" : "7px 9px",
        gap: compact ? 5 : 7,
      }}
      role="status"
      aria-label={`${planeLabel} synchronization status`}
      aria-live="polite"
      data-viewport-sync-indicator="true"
      data-sync-plane={plane}
      data-sync-status={display.status}
      data-sync-verified={
        display.isVerifiedSynced ? "true" : "false"
      }
    >
      <span
        style={{
          ...dotBaseStyle,
          backgroundColor: display.color,
        }}
        aria-hidden="true"
      />

      <div style={textGroupStyle}>
        <strong
          style={{
            color: "#f8fafc",
            fontSize: compact ? 10 : 11,
            fontWeight: 600,
          }}
        >
          {display.label}
        </strong>

        {!compact && showDescription && (
          <span
            style={{
              color: "#94a3b8",
              fontSize: 10,
              lineHeight: 1.5,
            }}
          >
            {display.description}
          </span>
        )}
      </div>
    </aside>
  );
}

// ============================================================
// 08 — CAPABILITIES
// ============================================================

export function getViewportSyncIndicatorCapabilities() {
  return {
    axialSupport: true,
    coronalSupport: true,
    sagittalSupport: true,
    unavailableState: true,
    disabledState: true,
    pausedState: true,
    syncingState: true,
    syncedState: true,
    errorState: true,
    geometryVerificationRequiredForSynced: true,
    currentUpdateConfirmationRequired: true,
    invalidSyncedStateFailsClosed: true,
    fixedStatusMessages: true,
    accessibleStatusDisplay: true,
    compactLayout: true,
    configurablePlacement: true,
    parentOwnedSynchronization: true,
    directCoordinateExposure: false,
    patientIdentifierDisplay: false,
    synchronizationOperations: false,
    directNetworkRequests: false,
    browserPersistence: false,
    sourceDatasetModification: false,
    clinicalValidationComplete: false,
  } as const;
}

// ============================================================
// END OF SINUS VIEWER SYNC INDICATOR
// ============================================================
