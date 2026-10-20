
/**
 * SINUS VIEWER — VIEWPORT LEGEND
 * ==============================
 *
 * Controlled visual legend for a single MPR viewport.
 *
 * Features:
 * - Axial / coronal / sagittal support.
 * - Crosshair legend.
 * - Measurement annotation legend.
 * - Verified orientation legend.
 * - Coordinate readout legend.
 * - Intensity readout legend.
 * - Allowlisted active-state presentation.
 * - Optional color swatches.
 * - Compact / expanded presentation.
 * - Multiple viewport placements.
 * - No patient identifiers or DICOM metadata.
 *
 * Important:
 * - Visibility flags are parent supplied.
 * - The parent must derive them from the actual
 *   rendered viewport, not just saved preferences.
 * - Orientation entry requires verified geometry.
 * - Legend colors must match actual overlay colors.
 * - The legend never modifies image data.
 *
 * This component makes no network requests and
 * does not persist any browser information.
 */

import {
  useMemo,
  type CSSProperties,
} from "react";

// ============================================================
// 01 — PUBLIC TYPES
// ============================================================

export type ViewportLegendPlane =
  | "axial"
  | "coronal"
  | "sagittal";

export type ViewportLegendPlacement =
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right";

export type ViewportLegendItemKey =
  | "crosshair"
  | "measurements"
  | "orientation"
  | "coordinates"
  | "intensity";

export interface ViewportLegendState {
  readonly crosshairVisible: boolean;
  readonly measurementsVisible: boolean;
  readonly orientationLabelsVisible: boolean;
  readonly orientationGeometryVerified: boolean;
  readonly coordinateReadoutVisible: boolean;
  readonly intensityReadoutVisible: boolean;
}

export interface ViewportLegendColors {
  readonly crosshair?: string;
  readonly measurements?: string;
  readonly orientation?: string;
  readonly coordinates?: string;
  readonly intensity?: string;
}

export interface ViewportLegendItem {
  readonly key: ViewportLegendItemKey;
  readonly label: string;
  readonly description: string;
  readonly color: string;
}

export interface ViewportLegendProps {
  readonly plane: ViewportLegendPlane;
  readonly state: ViewportLegendState;

  readonly colors?: ViewportLegendColors;

  readonly visible?: boolean;
  readonly compact?: boolean;
  readonly showDescriptions?: boolean;
  readonly showColorSwatches?: boolean;

  readonly placement?: ViewportLegendPlacement;
  readonly className?: string;
}

// ============================================================
// 02 — DEFAULTS
// ============================================================

export const VIEWPORT_LEGEND_DEFAULT_COLORS:
  Readonly<Required<ViewportLegendColors>> = Object.freeze({
    crosshair: "#38bdf8",
    measurements: "#fbbf24",
    orientation: "#e2e8f0",
    coordinates: "#a78bfa",
    intensity: "#34d399",
});

export const VIEWPORT_LEGEND_MAX_ITEMS = 5;

// ============================================================
// 03 — COLOR VALIDATION
// ============================================================

/**
 * Accept only explicit hex colors.
 * This avoids arbitrary CSS strings entering styles.
 *
 * Supports #RGB, #RRGGBB and #RRGGBBAA.
 */
export function isSafeLegendColor(
  value: unknown,
): value is string {
  return (
    typeof value === "string" &&
    /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(
      value,
    )
  );
}

export function resolveViewportLegendColor(
  key: ViewportLegendItemKey,
  colors?: ViewportLegendColors,
): string {
  const candidate = colors?.[key];

  if (isSafeLegendColor(candidate)) {
    return candidate;
  }

  return VIEWPORT_LEGEND_DEFAULT_COLORS[key];
}

// ============================================================
// 04 — ALLOWLISTED LEGEND DESCRIPTIONS
// ============================================================

const LEGEND_DEFINITIONS: Readonly<
  Record<
    ViewportLegendItemKey,
    {
      readonly label: string;
      readonly description: string;
    }
  >
> = {
  crosshair: {
    label: "Crosshair",
    description:
      "Synchronized MPR navigation lines.",
  },
  measurements: {
    label: "Measurements",
    description:
      "Visible measurement annotations.",
  },
  orientation: {
    label: "Orientation",
    description:
      "Anatomical labels from verified display geometry.",
  },
  coordinates: {
    label: "Coordinates",
    description:
      "Voxel and verified patient-space position readout.",
  },
  intensity: {
    label: "Intensity",
    description:
      "Sample values with calibration-aware units.",
  },
};

// ============================================================
// 05 — PURE LEGEND BUILDER
// ============================================================

export function buildViewportLegendItems(
  state: ViewportLegendState,
  colors?: ViewportLegendColors,
): readonly ViewportLegendItem[] {
  const items: ViewportLegendItem[] = [];

  const add = (key: ViewportLegendItemKey): void => {
    if (items.length >= VIEWPORT_LEGEND_MAX_ITEMS) {
      return;
    }

    const definition = LEGEND_DEFINITIONS[key];

    items.push({
      key,
      label: definition.label,
      description: definition.description,
      color: resolveViewportLegendColor(
        key,
        colors,
      ),
    });
  };

  if (state.crosshairVisible) {
    add("crosshair");
  }

  if (state.measurementsVisible) {
    add("measurements");
  }

  if (
    state.orientationLabelsVisible &&
    state.orientationGeometryVerified
  ) {
    add("orientation");
  }

  if (state.coordinateReadoutVisible) {
    add("coordinates");
  }

  if (state.intensityReadoutVisible) {
    add("intensity");
  }

  return items;
}

// ============================================================
// 06 — PLANE / PLACEMENT HELPERS
// ============================================================

export function viewportLegendPlaneLabel(
  plane: ViewportLegendPlane,
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

function viewportLegendPlacementStyle(
  placement: ViewportLegendPlacement,
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
// 07 — STYLES
// ============================================================

const rootStyle: CSSProperties = {
  position: "absolute",
  zIndex: 15,
  display: "flex",
  flexDirection: "column",
  gap: 7,
  maxWidth: "calc(100% - 24px)",
  padding: "9px 11px",
  border: "1px solid rgba(148,163,184,0.24)",
  borderRadius: 7,
  backgroundColor: "rgba(8,17,30,0.86)",
  color: "#e2e8f0",
  boxSizing: "border-box",
  pointerEvents: "none",
  userSelect: "none",
};

const itemStyle: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 8,
  minWidth: 0,
};

const swatchStyle: CSSProperties = {
  width: 14,
  height: 5,
  marginTop: 6,
  flexShrink: 0,
  borderRadius: 2,
  boxShadow: "0 0 0 1px rgba(255,255,255,0.2)",
};

const descriptionStyle: CSSProperties = {
  color: "#94a3b8",
  fontSize: 10,
  lineHeight: 1.4,
};

// ============================================================
// 08 — MAIN COMPONENT
// ============================================================

export function ViewportLegend({
  plane,
  state,
  colors,
  visible = true,
  compact = false,
  showDescriptions = true,
  showColorSwatches = true,
  placement = "bottom-right",
  className = "",
}: ViewportLegendProps) {
  const items = useMemo(
    () => buildViewportLegendItems(state, colors),
    [
      state.crosshairVisible,
      state.measurementsVisible,
      state.orientationLabelsVisible,
      state.orientationGeometryVerified,
      state.coordinateReadoutVisible,
      state.intensityReadoutVisible,
      colors?.crosshair,
      colors?.measurements,
      colors?.orientation,
      colors?.coordinates,
      colors?.intensity,
    ],
  );

  if (!visible || items.length === 0) {
    return null;
  }

  const planeName = viewportLegendPlaneLabel(plane);

  return (
    <aside
      className={className}
      style={{
        ...rootStyle,
        ...viewportLegendPlacementStyle(placement),
        gap: compact ? 5 : 7,
        padding: compact ? "6px 8px" : "9px 11px",
      }}
      role="note"
      aria-label={`${planeName} viewport legend`}
      data-viewport-legend="true"
      data-viewport-legend-plane={plane}
      data-viewport-legend-count={items.length}
    >
      <strong
        style={{
          fontSize: compact ? 10 : 12,
          color: "#f8fafc",
        }}
      >
        {planeName} Legend
      </strong>

      {items.map((item) => (
        <div
          key={item.key}
          style={itemStyle}
          data-viewport-legend-item={item.key}
        >
          {showColorSwatches && (
            <span
              aria-hidden="true"
              style={{
                ...swatchStyle,
                backgroundColor: item.color,
              }}
            />
          )}

          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 2,
              minWidth: 0,
            }}
          >
            <span
              style={{
                fontSize: compact ? 10 : 11,
                fontWeight: 600,
              }}
            >
              {item.label}
            </span>

            {!compact && showDescriptions && (
              <span style={descriptionStyle}>
                {item.description}
              </span>
            )}
          </div>
        </div>
      ))}
    </aside>
  );
}

// ============================================================
// 09 — CAPABILITIES
// ============================================================

export function getViewportLegendCapabilities() {
  return {
    axialSupport: true,
    coronalSupport: true,
    sagittalSupport: true,
    crosshairLegend: true,
    measurementLegend: true,
    verifiedOrientationLegend: true,
    coordinateReadoutLegend: true,
    intensityReadoutLegend: true,
    parentOwnedVisibility: true,
    safeColorValidation: true,
    configurableColors: true,
    compactLayout: true,
    multiplePlacements: true,
    noLegendWhenEmpty: true,
    allowlistedDescriptions: true,
    patientIdentifierDisplay: false,
    directImageSampling: false,
    directNetworkRequests: false,
    browserPersistence: false,
    sourceDatasetModification: false,
    clinicalValidationComplete: false,
  } as const;
}

// ============================================================
// END OF SINUS VIEWER VIEWPORT LEGEND
// ============================================================
