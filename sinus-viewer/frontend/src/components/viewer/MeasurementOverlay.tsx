
/**
 * SINUS VIEWER — MEASUREMENT OVERLAY
 * ==================================
 *
 * Transparent SVG layer for CT / CBCT MPR views.
 *
 * Supports:
 * - 2-point distance lines.
 * - 3-point angle arms.
 * - Multi-point polyline paths.
 * - Closed planar polygon outlines.
 * - Vertex / point markers.
 * - Calculated measurement labels.
 * - Selected measurement highlighting.
 * - In-progress measurement drawings.
 * - DICOM LPS world-to-screen projection.
 * - Anatomical slice visibility filtering.
 *
 * Coordinate contract:
 *   World coordinates = DICOM LPS millimetres.
 *   Screen coordinates = MPR raster pixel centres.
 *
 * IMPORTANT:
 * - SVG is display-only and receives no pointer input.
 * - Mouse routing remains with the parent MPR canvas.
 * - Off-slice annotations are hidden by default.
 * - All display geometry follows the current viewport.
 * - No persistent storage, network or DICOM writes.
 *
 * Measurements are not clinically validated.
 */

import {
  useMemo,
  type CSSProperties,
} from "react";

import type {
  PreviewPlane,
} from "../../types/api";

import type {
  WorldPointLPS,
} from "../../utils/geometry";

import {
  getMPRPlaneAxes,
  mprWorldToScreen,
  type MPRScreenPoint,
  type MPRViewportState,
} from "../../utils/mpr";

import type {
  MeasurementDraft,
  StoredMeasurement,
} from "../../hooks/useMeasurements";


// ============================================================
// 01 — CONSTANTS
// ============================================================

export const MEASUREMENT_OVERLAY_MAX_ITEMS = 1000;

export const MEASUREMENT_OVERLAY_MAX_POINTS = 10000;

export const DEFAULT_MEASUREMENT_SLICE_TOLERANCE_MM = 0.5;

export const DEFAULT_MEASUREMENT_LINE_WIDTH = 2;

export const DEFAULT_MEASUREMENT_POINT_RADIUS = 4;

export const DEFAULT_MEASUREMENT_FONT_SIZE = 12;


// ============================================================
// 02 — PUBLIC TYPES
// ============================================================

export interface MeasurementOverlayProps {
  readonly viewport: MPRViewportState;

  readonly measurements: readonly StoredMeasurement[];

  readonly draft?: MeasurementDraft | null;

  readonly selectedId?: string | null;

  readonly visible?: boolean;

  readonly showLabels?: boolean;

  readonly showPoints?: boolean;

  readonly sliceToleranceMm?: number;

  readonly className?: string;
}

export interface ProjectedMeasurementPoint
  extends MPRScreenPoint {
  readonly planeDistanceMm: number;
}

export interface MeasurementOverlayCapabilities {
  readonly distanceLines: boolean;
  readonly angleArms: boolean;
  readonly polylines: boolean;
  readonly polygonOutlines: boolean;
  readonly draftPreview: boolean;
  readonly selectedHighlighting: boolean;
  readonly worldToScreenProjection: boolean;
  readonly sliceVisibilityFiltering: boolean;
  readonly interactivePointEditing: boolean;
  readonly modifiesSourceDICOM: boolean;
}


// ============================================================
// 03 — INTERNAL TYPES
// ============================================================

interface DrawableMeasurement {
  readonly measurement: StoredMeasurement;
  readonly points: readonly ProjectedMeasurementPoint[];
  readonly selected: boolean;
}

interface DrawableDraft {
  readonly draft: MeasurementDraft;
  readonly points: readonly ProjectedMeasurementPoint[];
}


// ============================================================
// 04 — DISPLAY COLORS
// ============================================================

const COLORS = {
  distance: "#38bdf8",
  angle: "#a78bfa",
  polyline: "#34d399",
  polygon: "#fbbf24",
  selected: "#ffffff",
  draft: "#f472b6",
  pointFill: "#0f172a",
  labelText: "#f8fafc",
  labelBackground: "#0b1220",
} as const;


// ============================================================
// 05 — VALIDATION AND GEOMETRY
// ============================================================

function finite(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value)
  );
}

function validWorldPoint(
  point: WorldPointLPS,
): boolean {
  return (
    point !== null &&
    typeof point === "object" &&
    finite(point.x) &&
    finite(point.y) &&
    finite(point.z)
  );
}

function validateTolerance(
  tolerance: number,
): void {
  if (
    !finite(tolerance) ||
    tolerance < 0 ||
    tolerance > 1000
  ) {
    throw new Error(
      "Invalid measurement overlay tolerance.",
    );
  }
}

function planeDistanceMm(
  viewport: MPRViewportState,
  world: WorldPointLPS,
): number {
  const normal = getMPRPlaneAxes(
    viewport.plane,
  ).normal;

  const center = viewport.centerLPS;

  return (
    (world.x - center.x) * normal[0] +
    (world.y - center.y) * normal[1] +
    (world.z - center.z) * normal[2]
  );
}

/**
 * Project a world point to a viewport raster coordinate.
 *
 * Projection does not clamp the point to the viewport.
 * SVG clipping handles geometry outside the screen.
 */
export function projectMeasurementPoint(
  viewport: MPRViewportState,
  world: WorldPointLPS,
): ProjectedMeasurementPoint {
  if (!validWorldPoint(world)) {
    throw new Error(
      "Invalid measurement world position.",
    );
  }

  const screen = mprWorldToScreen(
    viewport,
    world,
  );

  const distance = planeDistanceMm(
    viewport,
    world,
  );

  if (
    !finite(screen.x) ||
    !finite(screen.y) ||
    !finite(distance)
  ) {
    throw new Error(
      "Measurement projection is invalid.",
    );
  }

  return {
    x: screen.x,
    y: screen.y,
    planeDistanceMm: distance,
  };
}


// ============================================================
// 06 — SLICE VISIBILITY
// ============================================================

/**
 * A drawing belongs to its original plane type.
 *
 * It is displayed only when all its vertices are near
 * the current anatomical slice. This prevents a 2D
 * polygon from being shown on the wrong slice.
 */
export function measurementVisibleOnSlice(
  viewport: MPRViewportState,
  plane: PreviewPlane,
  points: readonly WorldPointLPS[],
  toleranceMm = DEFAULT_MEASUREMENT_SLICE_TOLERANCE_MM,
): boolean {
  validateTolerance(toleranceMm);

  if (
    plane !== viewport.plane ||
    !Array.isArray(points) ||
    points.length === 0 ||
    points.length > MEASUREMENT_OVERLAY_MAX_POINTS
  ) {
    return false;
  }

  for (const point of points) {
    if (!validWorldPoint(point)) {
      return false;
    }

    const distance = planeDistanceMm(
      viewport,
      point,
    );

    if (
      !finite(distance) ||
      Math.abs(distance) > toleranceMm
    ) {
      return false;
    }
  }

  return true;
}


// ============================================================
// 07 — SVG GEOMETRY HELPERS
// ============================================================

function buildPath(
  points: readonly MPRScreenPoint[],
  closed: boolean,
): string {
  if (points.length === 0) {
    return "";
  }

  const segments = points.map(
    (point, index) =>
      `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`,
  );

  return (
    segments.join(" ") +
    (closed && points.length >= 3 ? " Z" : "")
  );
}

function formatMeasurementValue(
  measurement: StoredMeasurement,
): string {
  switch (measurement.kind) {
    case "distance":
      return `${measurement.distanceMm.toFixed(2)} mm`;

    case "angle":
      return `${measurement.angleDegrees.toFixed(1)}°`;

    case "polyline":
      return `${measurement.lengthMm.toFixed(2)} mm`;

    case "polygon":
      return `${measurement.areaMm2.toFixed(2)} mm²`;
  }
}

function pathColor(
  measurement: StoredMeasurement,
): string {
  return COLORS[measurement.kind];
}

function labelAnchor(
  points: readonly MPRScreenPoint[],
  kind: StoredMeasurement["kind"],
): MPRScreenPoint {
  if (points.length === 0) {
    return { x: 0, y: 0 };
  }

  if (kind === "angle" && points.length >= 3) {
    return {
      x: points[1].x,
      y: points[1].y,
    };
  }

  if (kind === "distance" && points.length >= 2) {
    return {
      x: (points[0].x + points[1].x) / 2,
      y: (points[0].y + points[1].y) / 2,
    };
  }

  return {
    x: points.reduce(
      (sum, point) => sum + point.x,
      0,
    ) / points.length,

    y: points.reduce(
      (sum, point) => sum + point.y,
      0,
    ) / points.length,
  };
}


// ============================================================
// 08 — DRAW A MEASUREMENT LABEL
// ============================================================

interface MeasurementLabelProps {
  readonly x: number;
  readonly y: number;
  readonly text: string;
  readonly color: string;
}

function MeasurementLabel({
  x,
  y,
  text,
  color,
}: MeasurementLabelProps) {
  /**
   * Rect width is an approximate fit for a short
   * numerical label. SVG text remains authoritative.
   */
  const labelWidth = Math.max(
    48,
    text.length * 7 + 14,
  );

  const labelX = x - labelWidth / 2;
  const labelY = y - 28;

  return (
    <g
      aria-hidden="true"
      pointerEvents="none"
    >
      <rect
        x={labelX}
        y={labelY}
        width={labelWidth}
        height={22}
        rx={4}
        fill={COLORS.labelBackground}
        fillOpacity={0.9}
        stroke={color}
        strokeWidth={1}
      />

      <text
        x={x}
        y={labelY + 14}
        textAnchor="middle"
        fontSize={DEFAULT_MEASUREMENT_FONT_SIZE}
        fontFamily="system-ui, sans-serif"
        fontWeight={600}
        fill={COLORS.labelText}
      >
        {text}
      </text>
    </g>
  );
}


// ============================================================
// 09 — DRAW POINT MARKERS
// ============================================================

interface MeasurementPointsProps {
  readonly points: readonly MPRScreenPoint[];
  readonly color: string;
  readonly selected: boolean;
}

function MeasurementPoints({
  points,
  color,
  selected,
}: MeasurementPointsProps) {
  return (
    <g pointerEvents="none">
      {points.map((point, index) => (
        <circle
          key={index}
          cx={point.x}
          cy={point.y}
          r={
            selected
              ? DEFAULT_MEASUREMENT_POINT_RADIUS + 1
              : DEFAULT_MEASUREMENT_POINT_RADIUS
          }
          fill={COLORS.pointFill}
          stroke={
            selected
              ? COLORS.selected
              : color
          }
          strokeWidth={selected ? 2.5 : 2}
        />
      ))}
    </g>
  );
}


// ============================================================
// 10 — DRAW COMPLETED MEASUREMENT
// ============================================================

interface MeasurementDrawingProps {
  readonly drawing: DrawableMeasurement;
  readonly showLabels: boolean;
  readonly showPoints: boolean;
}

function MeasurementDrawing({
  drawing,
  showLabels,
  showPoints,
}: MeasurementDrawingProps) {
  const { measurement, points, selected } = drawing;

  const color = pathColor(measurement);

  const closed = measurement.kind === "polygon";

  const path = buildPath(points, closed);

  const anchor = labelAnchor(
    points,
    measurement.kind,
  );

  return (
    <g
      data-measurement-kind={measurement.kind}
      data-selected={selected ? "true" : "false"}
      pointerEvents="none"
    >
      {selected && (
        <path
          d={path}
          fill="none"
          stroke={COLORS.selected}
          strokeOpacity={0.65}
          strokeWidth={DEFAULT_MEASUREMENT_LINE_WIDTH + 4}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      )}

      <path
        d={path}
        fill={
          closed
            ? color
            : "none"
        }
        fillOpacity={closed ? 0.12 : 0}
        stroke={color}
        strokeWidth={
          selected
            ? DEFAULT_MEASUREMENT_LINE_WIDTH + 1
            : DEFAULT_MEASUREMENT_LINE_WIDTH
        }
        strokeLinejoin="round"
        strokeLinecap="round"
      />

      {showPoints && (
        <MeasurementPoints
          points={points}
          color={color}
          selected={selected}
        />
      )}

      {showLabels && (
        <MeasurementLabel
          x={anchor.x}
          y={anchor.y}
          text={formatMeasurementValue(measurement)}
          color={color}
        />
      )}
    </g>
  );
}


// ============================================================
// 11 — DRAW IN-PROGRESS MEASUREMENT
// ============================================================

interface DraftDrawingProps {
  readonly drawing: DrawableDraft;
  readonly showPoints: boolean;
}

function DraftDrawing({
  drawing,
  showPoints,
}: DraftDrawingProps) {
  const points = drawing.points;

  if (points.length === 0) {
    return null;
  }

  return (
    <g
      data-measurement-draft={drawing.draft.tool}
      pointerEvents="none"
    >
      <path
        d={buildPath(points, false)}
        fill="none"
        stroke={COLORS.draft}
        strokeWidth={DEFAULT_MEASUREMENT_LINE_WIDTH}
        strokeDasharray="6 4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />

      {showPoints && (
        <MeasurementPoints
          points={points}
          color={COLORS.draft}
          selected={false}
        />
      )}
    </g>
  );
}


// ============================================================
// 12 — MAIN OVERLAY COMPONENT
// ============================================================

export function MeasurementOverlay({
  viewport,
  measurements,
  draft = null,
  selectedId = null,
  visible = true,
  showLabels = true,
  showPoints = true,
  sliceToleranceMm =
    DEFAULT_MEASUREMENT_SLICE_TOLERANCE_MM,
  className = "",
}: MeasurementOverlayProps) {
  validateTolerance(sliceToleranceMm);

  const { width, height } = viewport.size;

  const drawings = useMemo(
    (): readonly DrawableMeasurement[] => {
      if (!visible) {
        return [];
      }

      const result: DrawableMeasurement[] = [];

      for (const measurement of measurements) {
        if (
          result.length >=
          MEASUREMENT_OVERLAY_MAX_ITEMS
        ) {
          break;
        }

        if (
          !measurement.visible ||
          !measurementVisibleOnSlice(
            viewport,
            measurement.plane,
            measurement.points,
            sliceToleranceMm,
          )
        ) {
          continue;
        }

        const points = measurement.points.map(
          (point) =>
            projectMeasurementPoint(
              viewport,
              point,
            ),
        );

        result.push({
          measurement,
          points,
          selected: measurement.id === selectedId,
        });
      }

      return result;
    },
    [
      measurements,
      viewport,
      selectedId,
      visible,
      sliceToleranceMm,
    ],
  );

  const draftDrawing = useMemo(
    (): DrawableDraft | null => {
      if (
        !visible ||
        draft === null ||
        !measurementVisibleOnSlice(
          viewport,
          draft.plane,
          draft.points,
          sliceToleranceMm,
        )
      ) {
        return null;
      }

      return {
        draft,
        points: draft.points.map(
          (point) =>
            projectMeasurementPoint(
              viewport,
              point,
            ),
        ),
      };
    },
    [draft, viewport, visible, sliceToleranceMm],
  );

  const overlayStyle: CSSProperties = {
    position: "absolute",
    inset: 0,
    width: "100%",
    height: "100%",
    display: "block",
    overflow: "hidden",
    pointerEvents: "none",
    userSelect: "none",
  };

  return (
    <svg
      className={className}
      style={overlayStyle}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
      data-measurement-overlay={viewport.plane}
      data-measurement-count={drawings.length}
    >
      {drawings.map((drawing) => (
        <MeasurementDrawing
          key={drawing.measurement.id}
          drawing={drawing}
          showLabels={showLabels}
          showPoints={showPoints}
        />
      ))}

      {draftDrawing && (
        <DraftDrawing
          drawing={draftDrawing}
          showPoints={showPoints}
        />
      )}
    </svg>
  );
}


// ============================================================
// 13 — CAPABILITIES
// ============================================================

export function getMeasurementOverlayCapabilities():
  MeasurementOverlayCapabilities {
  return {
    distanceLines: true,
    angleArms: true,
    polylines: true,
    polygonOutlines: true,
    draftPreview: true,
    selectedHighlighting: true,
    worldToScreenProjection: true,
    sliceVisibilityFiltering: true,
    interactivePointEditing: false,
    modifiesSourceDICOM: false,
  };
}


// ============================================================
// END OF SINUS VIEWER MEASUREMENT OVERLAY
// ============================================================
