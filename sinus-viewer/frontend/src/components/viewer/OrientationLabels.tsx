
/**
 * SINUS VIEWER — ANATOMICAL ORIENTATION LABELS
 * ============================================
 *
 * Displays orientation labels using DICOM LPS
 * patient-coordinate direction vectors.
 *
 * DICOM LPS coordinate convention:
 *
 * +X = Left       -X = Right
 * +Y = Posterior  -Y = Anterior
 * +Z = Superior   -Z = Inferior
 *
 * Screen axes:
 *
 * screenRightLPS = direction toward right screen edge
 * screenDownLPS  = direction toward bottom screen edge
 *
 * Labels are calculated from those vectors.
 * They are NOT assumed from the viewport plane name.
 *
 * Supports:
 * - Axial, coronal and sagittal MPR.
 * - Oblique image orientations.
 * - Multi-letter anatomical labels.
 * - Rotated/flipped view transformations, provided
 *   that input vectors represent the final image.
 * - Invalid geometry rejection.
 * - Compact presentation.
 * - Non-interactive edge overlays.
 *
 * CRITICAL:
 * The parent must derive vectors from VERIFIED volume
 * geometry and the ACTUAL image display transform.
 * Never feed hard-coded anatomical directions here
 * solely based on plane name.
 *
 * This is a presentation component, not a clinical
 * orientation or diagnostic validation system.
 */

import {
  useMemo,
  type CSSProperties,
} from "react";


// ============================================================
// 01 — TYPES
// ============================================================

export type LPSVector3 = readonly [
  number,
  number,
  number,
];

export type OrientationEdge =
  | "left"
  | "right"
  | "top"
  | "bottom";

export type OrientationPlane =
  | "axial"
  | "coronal"
  | "sagittal"
  | "oblique";

export interface OrientationGeometry {
  /**
   * LPS patient-space direction of increasing
   * horizontal display coordinate.
   */
  readonly screenRightLPS: LPSVector3;

  /**
   * LPS patient-space direction of increasing
   * vertical display coordinate.
   *
   * Browser display Y increases downward.
   */
  readonly screenDownLPS: LPSVector3;
}

export interface OrientationEdgeLabels {
  readonly left: string;
  readonly right: string;
  readonly top: string;
  readonly bottom: string;
}

export interface OrientationResult {
  readonly valid: boolean;
  readonly labels: OrientationEdgeLabels;
  readonly reason:
    | "valid"
    | "missing"
    | "non-finite"
    | "degenerate"
    | "non-orthogonal";
}

export interface OrientationLabelsProps {
  /**
   * Must describe the final on-screen orientation.
   */
  readonly geometry?: OrientationGeometry | null;

  /**
   * Informational only; does not drive labeling.
   */
  readonly plane?: OrientationPlane;

  readonly visible?: boolean;
  readonly compact?: boolean;
  readonly showUnavailable?: boolean;

  readonly className?: string;
}


// ============================================================
// 02 — CONSTANTS
// ============================================================

export const ORIENTATION_VECTOR_EPSILON = 1e-8;

/**
 * Maximum allowed absolute dot product between
 * normalized screen basis vectors.
 *
 * A markedly nonorthogonal basis is rejected
 * rather than presenting untrustworthy labels.
 */
export const ORIENTATION_ORTHOGONAL_TOLERANCE = 0.02;

/**
 * Secondary components contributing at least 20%
 * of the dominant component are included in an
 * oblique anatomical direction label.
 *
 * This threshold is a presentation policy, not a
 * substitute for clinical orientation validation.
 */
export const ORIENTATION_COMPONENT_THRESHOLD = 0.2;

const EMPTY_LABELS: OrientationEdgeLabels = {
  left: "",
  right: "",
  top: "",
  bottom: "",
};


// ============================================================
// 03 — VECTOR HELPERS
// ============================================================

function isFiniteVector(
  vector: LPSVector3,
): boolean {
  return (
    vector.length === 3 &&
    vector.every((value) => Number.isFinite(value))
  );
}

function vectorNorm(
  vector: LPSVector3,
): number {
  return Math.hypot(
    vector[0],
    vector[1],
    vector[2],
  );
}

function normalizeVector(
  vector: LPSVector3,
): LPSVector3 | null {
  const norm = vectorNorm(vector);

  if (
    !Number.isFinite(norm) ||
    norm <= ORIENTATION_VECTOR_EPSILON
  ) {
    return null;
  }

  return [
    vector[0] / norm,
    vector[1] / norm,
    vector[2] / norm,
  ];
}

function dotProduct(
  a: LPSVector3,
  b: LPSVector3,
): number {
  return (
    a[0] * b[0] +
    a[1] * b[1] +
    a[2] * b[2]
  );
}

function negateVector(
  vector: LPSVector3,
): LPSVector3 {
  return [
    -vector[0],
    -vector[1],
    -vector[2],
  ];
}


// ============================================================
// 04 — ANATOMICAL DIRECTION MAPPING
// ============================================================

interface DirectionComponent {
  readonly magnitude: number;
  readonly index: number;
  readonly letter: string;
}

/**
 * Convert a normalized LPS direction into
 * anatomical direction letters.
 *
 * Examples:
 *
 * [ 1,  0,  0] => L
 * [-1,  0,  0] => R
 * [ 0,  1,  0] => P
 * [ 0, -1,  0] => A
 * [ 0,  0,  1] => S
 * [ 0,  0, -1] => I
 *
 * Oblique examples may produce LP, AS or RPI.
 * Letters are sorted by contribution magnitude.
 */
export function lpsVectorToAnatomicalLabel(
  vector: LPSVector3,
): string {
  if (!isFiniteVector(vector)) {
    return "";
  }

  const normalized = normalizeVector(vector);

  if (normalized === null) {
    return "";
  }

  const components: DirectionComponent[] = [
    {
      magnitude: Math.abs(normalized[0]),
      index: 0,
      letter: normalized[0] >= 0 ? "L" : "R",
    },
    {
      magnitude: Math.abs(normalized[1]),
      index: 1,
      letter: normalized[1] >= 0 ? "P" : "A",
    },
    {
      magnitude: Math.abs(normalized[2]),
      index: 2,
      letter: normalized[2] >= 0 ? "S" : "I",
    },
  ];

  components.sort(
    (a, b) =>
      b.magnitude - a.magnitude ||
      a.index - b.index,
  );

  const dominant = components[0].magnitude;

  return components
    .filter(
      (component) =>
        component.magnitude >
          ORIENTATION_VECTOR_EPSILON &&
        component.magnitude >=
          dominant * ORIENTATION_COMPONENT_THRESHOLD,
    )
    .map((component) => component.letter)
    .join("");
}


// ============================================================
// 05 — GEOMETRY VALIDATION & EDGE LABELS
// ============================================================

export function calculateOrientationLabels(
  geometry: OrientationGeometry | null | undefined,
): OrientationResult {
  if (!geometry) {
    return {
      valid: false,
      labels: EMPTY_LABELS,
      reason: "missing",
    };
  }

  const right = geometry.screenRightLPS;
  const down = geometry.screenDownLPS;

  if (
    !Array.isArray(right) ||
    !Array.isArray(down) ||
    !isFiniteVector(right) ||
    !isFiniteVector(down)
  ) {
    return {
      valid: false,
      labels: EMPTY_LABELS,
      reason: "non-finite",
    };
  }

  const unitRight = normalizeVector(right);
  const unitDown = normalizeVector(down);

  if (unitRight === null || unitDown === null) {
    return {
      valid: false,
      labels: EMPTY_LABELS,
      reason: "degenerate",
    };
  }

  const orthogonality = Math.abs(
    dotProduct(unitRight, unitDown),
  );

  if (
    !Number.isFinite(orthogonality) ||
    orthogonality >
      ORIENTATION_ORTHOGONAL_TOLERANCE
  ) {
    return {
      valid: false,
      labels: EMPTY_LABELS,
      reason: "non-orthogonal",
    };
  }

  const labels: OrientationEdgeLabels = {
    left: lpsVectorToAnatomicalLabel(
      negateVector(unitRight),
    ),
    right: lpsVectorToAnatomicalLabel(
      unitRight,
    ),
    top: lpsVectorToAnatomicalLabel(
      negateVector(unitDown),
    ),
    bottom: lpsVectorToAnatomicalLabel(
      unitDown,
    ),
  };

  if (
    !labels.left ||
    !labels.right ||
    !labels.top ||
    !labels.bottom
  ) {
    return {
      valid: false,
      labels: EMPTY_LABELS,
      reason: "degenerate",
    };
  }

  return {
    valid: true,
    labels,
    reason: "valid",
  };
}


// ============================================================
// 06 — STYLES
// ============================================================

const rootStyle: CSSProperties = {
  position: "absolute",
  inset: 0,
  pointerEvents: "none",
  zIndex: 8,
  overflow: "hidden",
};

const markerStyle: CSSProperties = {
  position: "absolute",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  minWidth: 22,
  minHeight: 22,
  padding: "3px 5px",
  borderRadius: 4,
  boxSizing: "border-box",
  border: "1px solid rgba(125, 211, 252, 0.35)",
  backgroundColor: "rgba(2, 6, 23, 0.78)",
  color: "#e0f2fe",
  fontWeight: 700,
  fontFamily:
    "ui-monospace, SFMono-Regular, Menlo, monospace",
  textShadow: "0 1px 2px #000",
  userSelect: "none",
  whiteSpace: "nowrap",
};

const unavailableStyle: CSSProperties = {
  position: "absolute",
  bottom: 7,
  left: "50%",
  transform: "translateX(-50%)",
  padding: "4px 7px",
  borderRadius: 4,
  backgroundColor: "rgba(69, 10, 10, 0.9)",
  border: "1px solid rgba(248, 113, 113, 0.6)",
  color: "#fecaca",
  fontSize: 10,
  fontWeight: 600,
  textAlign: "center",
};


// ============================================================
// 07 — EDGE MARKER
// ============================================================

interface EdgeMarkerProps {
  readonly edge: OrientationEdge;
  readonly label: string;
  readonly compact: boolean;
}

function EdgeMarker({
  edge,
  label,
  compact,
}: EdgeMarkerProps) {
  const inset = compact ? 4 : 8;

  const placement: CSSProperties =
    edge === "left"
      ? {
          left: inset,
          top: "50%",
          transform: "translateY(-50%)",
        }
      : edge === "right"
        ? {
            right: inset,
            top: "50%",
            transform: "translateY(-50%)",
          }
        : edge === "top"
          ? {
              top: inset,
              left: "50%",
              transform: "translateX(-50%)",
            }
          : {
              bottom: inset,
              left: "50%",
              transform: "translateX(-50%)",
            };

  return (
    <span
      style={{
        ...markerStyle,
        ...placement,
        fontSize: compact ? 10 : 13,
      }}
      aria-hidden="true"
      data-orientation-edge={edge}
      data-orientation-label={label}
    >
      {label}
    </span>
  );
}


// ============================================================
// 08 — MAIN COMPONENT
// ============================================================

export function OrientationLabels({
  geometry = null,
  plane,
  visible = true,
  compact = false,
  showUnavailable = true,
  className = "",
}: OrientationLabelsProps) {
  const result = useMemo(
    () => calculateOrientationLabels(geometry),
    [geometry],
  );

  if (!visible) {
    return null;
  }

  return (
    <div
      className={className}
      style={rootStyle}
      data-orientation-overlay="true"
      data-orientation-valid={
        result.valid ? "true" : "false"
      }
      data-orientation-plane={plane ?? "unspecified"}
      aria-label={
        result.valid
          ? [
              `Image orientation.`,
              `Top ${result.labels.top}.`,
              `Bottom ${result.labels.bottom}.`,
              `Left ${result.labels.left}.`,
              `Right ${result.labels.right}.`,
            ].join(" ")
          : "Anatomical orientation unavailable"
      }
      role="group"
    >
      {result.valid ? (
        <>
          <EdgeMarker
            edge="top"
            label={result.labels.top}
            compact={compact}
          />

          <EdgeMarker
            edge="bottom"
            label={result.labels.bottom}
            compact={compact}
          />

          <EdgeMarker
            edge="left"
            label={result.labels.left}
            compact={compact}
          />

          <EdgeMarker
            edge="right"
            label={result.labels.right}
            compact={compact}
          />
        </>
      ) : (
        showUnavailable && (
          <span
            style={unavailableStyle}
            role="status"
          >
            Orientation unavailable
          </span>
        )
      )}
    </div>
  );
}


// ============================================================
// 09 — CAPABILITIES
// ============================================================

export function getOrientationLabelsCapabilities() {
  return {
    dicomLPSConvention: true,
    anatomyFromDisplayVectors: true,
    axialSupport: true,
    coronalSupport: true,
    sagittalSupport: true,
    obliqueDirectionLabels: true,
    dominantComponentSorting: true,
    vectorNormalization: true,
    orthogonalityValidation: true,
    nonFiniteRejection: true,
    missingGeometryFallback: true,
    compactLayout: true,
    pointerEventsDisabled: true,
    displayTransformInputRequired: true,
    planeNameBasedGuessing: false,
    automaticDICOMGeometryExtraction: false,
    directNetworkRequests: false,
    browserPersistence: false,
    sourceDatasetModification: false,
    clinicalValidationComplete: false,
  } as const;
}


// ============================================================
// END OF SINUS VIEWER ORIENTATION LABELS
// ============================================================
