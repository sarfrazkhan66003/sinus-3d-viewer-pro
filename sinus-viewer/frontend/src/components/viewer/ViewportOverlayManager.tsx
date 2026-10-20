
/**
 * SINUS VIEWER — VIEWPORT OVERLAY MANAGER
 * =======================================
 *
 * Coordinates visual overlays for one MPR viewport.
 *
 * Supported slots:
 * - Orientation labels
 * - Coordinate readout
 * - Intensity readout
 * - Scale bar
 * - Viewport legend
 * - General information panel
 * - Custom status overlay
 * - Loading skeleton
 *
 * Design:
 * - Explicit parent-owned slots.
 * - No direct dependency on older component props.
 * - Fixed corner stacks to reduce collisions.
 * - Dedicated scale-bar rail.
 * - Orientation is a centered, separate overlay.
 * - Status/loading overlays take precedence.
 * - No patient metadata is accepted.
 *
 * IMPORTANT:
 * - Visibility does not prove clinical validity.
 * - Parent must validate geometry before creating
 *   orientation, coordinate and scale elements.
 * - Loading must not expose stale image pixels.
 * - This component never reads DICOM files.
 */

import {
  useMemo,
  type CSSProperties,
  type ReactNode,
} from "react";

// ============================================================
// 01 — PUBLIC TYPES
// ============================================================

export type OverlayManagerPlane =
  | "axial"
  | "coronal"
  | "sagittal";

export type OverlayManagerMode =
  | "ready"
  | "loading"
  | "unavailable"
  | "error";

export type OverlayManagerCorner =
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right";

export interface ViewportOverlaySlots {
  readonly orientation?: ReactNode;
  readonly coordinates?: ReactNode;
  readonly intensity?: ReactNode;
  readonly scaleBar?: ReactNode;
  readonly legend?: ReactNode;
  readonly information?: ReactNode;
  readonly status?: ReactNode;
  readonly loading?: ReactNode;
}

export interface ViewportOverlayVisibility {
  readonly orientation?: boolean;
  readonly coordinates?: boolean;
  readonly intensity?: boolean;
  readonly scaleBar?: boolean;
  readonly legend?: boolean;
  readonly information?: boolean;
}

export interface ViewportOverlayManagerProps {
  readonly plane: OverlayManagerPlane;
  readonly mode: OverlayManagerMode;
  readonly slots: ViewportOverlaySlots;

  readonly visibility?: ViewportOverlayVisibility;

  readonly visible?: boolean;
  readonly compact?: boolean;

  /**
   * If true, this component is positioned over
   * its nearest positioned viewport ancestor.
   */
  readonly overlay?: boolean;

  readonly className?: string;
}

export type ManagedOverlayKey =
  | "orientation"
  | "coordinates"
  | "intensity"
  | "scaleBar"
  | "legend"
  | "information";

export interface ViewportOverlayLayout {
  readonly showLoading: boolean;
  readonly showStatus: boolean;
  readonly showRegularOverlays: boolean;
  readonly topLeft: readonly ManagedOverlayKey[];
  readonly topRight: readonly ManagedOverlayKey[];
  readonly bottomLeft: readonly ManagedOverlayKey[];
  readonly bottomRight: readonly ManagedOverlayKey[];
  readonly orientation: boolean;
  readonly scaleBar: boolean;
}

// ============================================================
// 02 — CONSTANTS
// ============================================================

export const VIEWPORT_OVERLAY_Z_INDEX = 18;
export const VIEWPORT_OVERLAY_STATUS_Z_INDEX = 35;
export const VIEWPORT_OVERLAY_EDGE_GAP_PX = 10;
export const VIEWPORT_OVERLAY_STACK_GAP_PX = 6;

const DEFAULT_VISIBILITY: Readonly<
  Required<ViewportOverlayVisibility>
> = Object.freeze({
  orientation: true,
  coordinates: true,
  intensity: true,
  scaleBar: true,
  legend: true,
  information: true,
});

// ============================================================
// 03 — PUBLIC PURE HELPERS
// ============================================================

export function overlayManagerPlaneLabel(
  plane: OverlayManagerPlane,
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
 * Strict layout model.
 *
 * Loading mode never renders regular overlays.
 * Error / unavailable show status only.
 *
 * Ready mode renders regular overlays and excludes
 * loading and status slots.
 */
export function buildViewportOverlayLayout(
  mode: OverlayManagerMode,
  visibility: ViewportOverlayVisibility = {},
): ViewportOverlayLayout {
  const active =
    mode === "ready";

  const showLoading =
    mode === "loading";

  const showStatus =
    mode === "unavailable" ||
    mode === "error";

  const enabled = (
    key: ManagedOverlayKey,
  ): boolean => {
    return (
      active &&
      (visibility[key] ??
        DEFAULT_VISIBILITY[key])
    );
  };

  const topLeft: ManagedOverlayKey[] = [];
  const topRight: ManagedOverlayKey[] = [];
  const bottomLeft: ManagedOverlayKey[] = [];
  const bottomRight: ManagedOverlayKey[] = [];

  if (enabled("information")) {
    topLeft.push("information");
  }

  if (enabled("coordinates")) {
    topRight.push("coordinates");
  }

  if (enabled("intensity")) {
    topRight.push("intensity");
  }

  if (enabled("legend")) {
    bottomRight.push("legend");
  }

  return {
    showLoading,
    showStatus,
    showRegularOverlays: active,
    topLeft,
    topRight,
    bottomLeft,
    bottomRight,
    orientation: enabled("orientation"),
    scaleBar: enabled("scaleBar"),
  };
}

// ============================================================
// 04 — SLOT SAFETY
// ============================================================

/**
 * Nullish and false ReactNode values are treated
 * as empty. Zero and non-empty strings are valid
 * React nodes and are preserved.
 *
 * Parents should pass trusted React elements
 * rather than unsanitized metadata strings.
 */
export function hasViewportOverlayContent(
  value: ReactNode | undefined,
): boolean {
  return (
    value !== null &&
    value !== undefined &&
    value !== false &&
    value !== true
  );
}

function getManagedSlot(
  slots: ViewportOverlaySlots,
  key: ManagedOverlayKey,
): ReactNode {
  return slots[key];
}

// ============================================================
// 05 — STYLE HELPERS
// ============================================================

const rootStyle: CSSProperties = {
  position: "absolute",
  inset: 0,
  zIndex: VIEWPORT_OVERLAY_Z_INDEX,
  display: "block",
  overflow: "hidden",
  pointerEvents: "none",
  boxSizing: "border-box",
  isolation: "isolate",
};

const railBaseStyle: CSSProperties = {
  position: "absolute",
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-start",
  gap: VIEWPORT_OVERLAY_STACK_GAP_PX,
  maxWidth: "calc(50% - 12px)",
  maxHeight: "calc(50% - 12px)",
  minWidth: 0,
  pointerEvents: "none",
};

function cornerRailStyle(
  corner: OverlayManagerCorner,
  compact: boolean,
): CSSProperties {
  const offset = compact
    ? 5
    : VIEWPORT_OVERLAY_EDGE_GAP_PX;

  switch (corner) {
    case "top-left":
      return {
        ...railBaseStyle,
        top: offset,
        left: offset,
      };

    case "top-right":
      return {
        ...railBaseStyle,
        top: offset,
        right: offset,
        alignItems: "flex-end",
      };

    case "bottom-left":
      return {
        ...railBaseStyle,
        bottom: offset,
        left: offset,
      };

    case "bottom-right":
      return {
        ...railBaseStyle,
        bottom: offset,
        right: offset,
        alignItems: "flex-end",
      };
  }
}

const slotContainerStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "inherit",
  position: "relative",
  maxWidth: "100%",
  minWidth: 0,
  pointerEvents: "none",
};

const orientationRailStyle: CSSProperties = {
  position: "absolute",
  inset: 0,
  zIndex: 2,
  pointerEvents: "none",
};

const scaleRailStyle: CSSProperties = {
  position: "absolute",
  left: "50%",
  bottom: 8,
  transform: "translateX(-50%)",
  display: "flex",
  justifyContent: "center",
  alignItems: "flex-end",
  maxWidth: "calc(100% - 32px)",
  pointerEvents: "none",
};

const fullStatusStyle: CSSProperties = {
  position: "absolute",
  inset: 0,
  zIndex: VIEWPORT_OVERLAY_STATUS_Z_INDEX,
  display: "flex",
  alignItems: "stretch",
  justifyContent: "stretch",
  backgroundColor: "#090f1b",
  pointerEvents: "auto",
};

// ============================================================
// 06 — CORNER RAIL
// ============================================================

interface OverlayCornerRailProps {
  readonly corner: OverlayManagerCorner;
  readonly compact: boolean;
  readonly keys: readonly ManagedOverlayKey[];
  readonly slots: ViewportOverlaySlots;
}

function OverlayCornerRail({
  corner,
  compact,
  keys,
  slots,
}: OverlayCornerRailProps) {
  const populatedKeys = keys.filter(
    (key) =>
      hasViewportOverlayContent(
        getManagedSlot(slots, key),
      ),
  );

  if (populatedKeys.length === 0) {
    return null;
  }

  return (
    <div
      style={cornerRailStyle(corner, compact)}
      data-overlay-corner={corner}
    >
      {populatedKeys.map((key) => (
        <div
          key={key}
          style={slotContainerStyle}
          data-overlay-slot={key}
        >
          {getManagedSlot(slots, key)}
        </div>
      ))}
    </div>
  );
}

// ============================================================
// 07 — MAIN COMPONENT
// ============================================================

export function ViewportOverlayManager({
  plane,
  mode,
  slots,
  visibility = {},
  visible = true,
  compact = false,
  overlay = true,
  className = "",
}: ViewportOverlayManagerProps) {
  const layout = useMemo(
    () =>
      buildViewportOverlayLayout(
        mode,
        visibility,
      ),
    [
      mode,
      visibility.orientation,
      visibility.coordinates,
      visibility.intensity,
      visibility.scaleBar,
      visibility.legend,
      visibility.information,
    ],
  );

  if (!visible) {
    return null;
  }

  const planeLabel =
    overlayManagerPlaneLabel(plane);

  const loadingContent =
    layout.showLoading &&
    hasViewportOverlayContent(slots.loading);

  const statusContent =
    layout.showStatus &&
    hasViewportOverlayContent(slots.status);

  const blocksImage =
    layout.showLoading || layout.showStatus;

  return (
    <div
      className={className}
      style={{
        ...rootStyle,
        position: overlay
          ? "absolute"
          : "relative",
        width: overlay ? undefined : "100%",
        height: overlay ? undefined : "100%",
        backgroundColor: blocksImage
          ? "#090f1b"
          : "transparent",
      }}
      aria-label={`${planeLabel} viewport overlays`}
      data-viewport-overlay-manager="true"
      data-overlay-plane={plane}
      data-overlay-mode={mode}
      data-overlay-blocks-image={
        blocksImage ? "true" : "false"
      }
    >
      {layout.showRegularOverlays && (
        <>
          <OverlayCornerRail
            corner="top-left"
            compact={compact}
            keys={layout.topLeft}
            slots={slots}
          />

          <OverlayCornerRail
            corner="top-right"
            compact={compact}
            keys={layout.topRight}
            slots={slots}
          />

          <OverlayCornerRail
            corner="bottom-left"
            compact={compact}
            keys={layout.bottomLeft}
            slots={slots}
          />

          <OverlayCornerRail
            corner="bottom-right"
            compact={compact}
            keys={layout.bottomRight}
            slots={slots}
          />

          {layout.orientation &&
            hasViewportOverlayContent(
              slots.orientation,
            ) && (
              <div
                style={orientationRailStyle}
                data-overlay-slot="orientation"
              >
                {slots.orientation}
              </div>
            )}

          {layout.scaleBar &&
            hasViewportOverlayContent(
              slots.scaleBar,
            ) && (
              <div
                style={scaleRailStyle}
                data-overlay-slot="scaleBar"
              >
                {slots.scaleBar}
              </div>
            )}
        </>
      )}

      {loadingContent && (
        <div
          style={fullStatusStyle}
          data-overlay-loading="true"
        >
          {slots.loading}
        </div>
      )}

      {statusContent && (
        <div
          style={fullStatusStyle}
          data-overlay-status="true"
        >
          {slots.status}
        </div>
      )}

      {blocksImage &&
        !loadingContent &&
        !statusContent && (
          <div
            style={{
              ...fullStatusStyle,
              alignItems: "center",
              justifyContent: "center",
              color: "#94a3b8",
              fontSize: 12,
            }}
            role="status"
            data-overlay-safe-placeholder="true"
          >
            Image unavailable
          </div>
        )}
    </div>
  );
}

// ============================================================
// 08 — CAPABILITIES
// ============================================================

export function getViewportOverlayManagerCapabilities() {
  return {
    axialSupport: true,
    coronalSupport: true,
    sagittalSupport: true,
    orientationSlot: true,
    coordinateSlot: true,
    intensitySlot: true,
    scaleBarSlot: true,
    legendSlot: true,
    informationSlot: true,
    loadingSlot: true,
    statusSlot: true,
    fixedCornerRails: true,
    dedicatedScaleRail: true,
    loadingPrecedence: true,
    errorPrecedence: true,
    unavailableMode: true,
    parentOwnedVisibility: true,
    parentOwnedSlotComponents: true,
    staleImageBlockingBackground: true,
    automaticClinicalGeometryValidation: false,
    independentCollisionDetection: false,
    directDICOMAccess: false,
    directNetworkRequests: false,
    browserPersistence: false,
    sourceDatasetModification: false,
    clinicalValidationComplete: false,
  } as const;
}

// ============================================================
// END OF SINUS VIEWER VIEWPORT OVERLAY MANAGER
// ============================================================
