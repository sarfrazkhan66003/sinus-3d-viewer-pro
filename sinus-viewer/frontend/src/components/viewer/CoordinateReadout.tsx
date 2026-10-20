
/**
 * SINUS VIEWER — COORDINATE READOUT
 * =================================
 *
 * Presentation-only MPR coordinate readout.
 *
 * Features:
 * - Zero-based voxel indices (i, j, k).
 * - Verified DICOM LPS patient coordinates.
 * - Optional converted RAS coordinates.
 * - Anatomical direction labels.
 * - Adjustable decimal precision.
 * - Finite-value and index validation.
 * - Invalid/missing geometry fallback.
 * - Compact and normal presentation.
 * - Parent-controlled visibility.
 *
 * DICOM LPS:
 * +X = Left, +Y = Posterior, +Z = Superior
 *
 * RAS:
 * +X = Right, +Y = Anterior, +Z = Superior
 *
 * Conversion:
 * R = -L
 * A = -P
 * S =  S
 *
 * IMPORTANT:
 * LPS coordinates must be supplied by the parent
 * after validating the DICOM image geometry.
 *
 * Converting an unverified position to RAS does
 * not make the original position accurate.
 *
 * This component does not:
 * - Read original DICOM files.
 * - Modify or write image data.
 * - Access network services.
 * - Persist patient-related information.
 * - Compute a voxel-to-patient affine.
 */

import {
  useMemo,
  type CSSProperties,
} from "react";


// ============================================================
// 01 — PUBLIC TYPES
// ============================================================

export type CoordinateReadoutPlane =
  | "axial"
  | "coronal"
  | "sagittal";

export type CoordinateConvention =
  | "LPS"
  | "RAS";

export type CoordinateReadoutStatus =
  | "idle"
  | "loading"
  | "valid"
  | "outside-volume"
  | "unavailable"
  | "error";

export interface CoordinateVoxelIndex {
  readonly i: number;
  readonly j: number;
  readonly k: number;
}

export interface CoordinatePoint3D {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface CoordinateReadoutSample {
  readonly status: CoordinateReadoutStatus;

  readonly voxelIndex?: CoordinateVoxelIndex | null;

  /**
   * This flag is asserted only by a trusted parent
   * after DICOM geometry validation.
   *
   * A boolean claim alone is not proof of accuracy.
   */
  readonly geometryVerified: boolean;

  readonly patientLPS?: CoordinatePoint3D | null;
}

export interface CoordinateReadoutProps {
  readonly plane: CoordinateReadoutPlane;

  readonly sample: CoordinateReadoutSample | null;

  readonly primaryConvention?: CoordinateConvention;

  readonly showSecondaryConvention?: boolean;

  readonly showVoxelIndices?: boolean;

  readonly showAnatomicalDirections?: boolean;

  readonly precision?: number;

  readonly visible?: boolean;

  readonly compact?: boolean;

  readonly className?: string;
}


// ============================================================
// 02 — CONSTANTS
// ============================================================

export const COORDINATE_DEFAULT_PRECISION = 2;

export const COORDINATE_MAX_PRECISION = 4;

export const COORDINATE_MAX_ABS_MM = 1e8;

export const COORDINATE_UNAVAILABLE = "Unavailable";


// ============================================================
// 03 — VALIDATION HELPERS
// ============================================================

export function validCoordinateVoxelIndex(
  value: unknown,
): value is CoordinateVoxelIndex {
  if (
    value === null ||
    typeof value !== "object"
  ) {
    return false;
  }

  const candidate = value as Partial<CoordinateVoxelIndex>;

  return (
    Number.isSafeInteger(candidate.i) &&
    Number.isSafeInteger(candidate.j) &&
    Number.isSafeInteger(candidate.k) &&
    typeof candidate.i === "number" &&
    typeof candidate.j === "number" &&
    typeof candidate.k === "number" &&
    candidate.i >= 0 &&
    candidate.j >= 0 &&
    candidate.k >= 0
  );
}

export function validCoordinatePoint(
  value: unknown,
): value is CoordinatePoint3D {
  if (
    value === null ||
    typeof value !== "object"
  ) {
    return false;
  }

  const candidate = value as Partial<CoordinatePoint3D>;

  return (
    typeof candidate.x === "number" &&
    typeof candidate.y === "number" &&
    typeof candidate.z === "number" &&
    [candidate.x, candidate.y, candidate.z].every(
      (coordinate) =>
        Number.isFinite(coordinate) &&
        Math.abs(coordinate) <= COORDINATE_MAX_ABS_MM,
    )
  );
}

export function normalizeCoordinatePrecision(
  precision: number,
): number {
  if (!Number.isFinite(precision)) {
    return COORDINATE_DEFAULT_PRECISION;
  }

  return Math.max(
    0,
    Math.min(
      COORDINATE_MAX_PRECISION,
      Math.trunc(precision),
    ),
  );
}


// ============================================================
// 04 — LPS / RAS CONVERSION
// ============================================================

/**
 * Convert DICOM LPS coordinates to RAS coordinates.
 *
 * LPS -> RAS:
 *   xRAS = -xLPS
 *   yRAS = -yLPS
 *   zRAS =  zLPS
 *
 * The inverse is the same sign-flip operation.
 *
 * This does not account for affine errors or
 * independently validate DICOM geometry.
 */
export function convertLPSToRAS(
  lps: CoordinatePoint3D,
): CoordinatePoint3D | null {
  if (!validCoordinatePoint(lps)) {
    return null;
  }

  return {
    x: -lps.x,
    y: -lps.y,
    z: lps.z,
  };
}

export function convertRASToLPS(
  ras: CoordinatePoint3D,
): CoordinatePoint3D | null {
  return convertLPSToRAS(ras);
}


// ============================================================
// 05 — FORMATTING HELPERS
// ============================================================

function formatComponent(
  value: number,
  precision: number,
): string {
  if (!Number.isFinite(value)) {
    return COORDINATE_UNAVAILABLE;
  }

  const rounded = Number(
    value.toFixed(precision),
  );

  return rounded.toFixed(precision);
}

export function formatCoordinatePoint(
  point: CoordinatePoint3D | null | undefined,
  precision = COORDINATE_DEFAULT_PRECISION,
): string {
  if (!validCoordinatePoint(point)) {
    return COORDINATE_UNAVAILABLE;
  }

  const safePrecision =
    normalizeCoordinatePrecision(precision);

  return [
    formatComponent(point.x, safePrecision),
    formatComponent(point.y, safePrecision),
    formatComponent(point.z, safePrecision),
  ].join(", ");
}

export function formatCoordinateVoxelIndex(
  value: CoordinateVoxelIndex | null | undefined,
): string {
  if (!validCoordinateVoxelIndex(value)) {
    return COORDINATE_UNAVAILABLE;
  }

  return `(${value.i}, ${value.j}, ${value.k})`;
}


// ============================================================
// 06 — ANATOMICAL DIRECTION HELPERS
// ============================================================

function anatomicalAxisLabel(
  value: number,
  positive: string,
  negative: string,
): string {
  if (value > 0) {
    return positive;
  }

  if (value < 0) {
    return negative;
  }

  return "Origin";
}

export function getCoordinateAnatomicalDirections(
  point: CoordinatePoint3D,
  convention: CoordinateConvention,
): readonly [string, string, string] | null {
  if (!validCoordinatePoint(point)) {
    return null;
  }

  if (convention === "LPS") {
    return [
      anatomicalAxisLabel(point.x, "L", "R"),
      anatomicalAxisLabel(point.y, "P", "A"),
      anatomicalAxisLabel(point.z, "S", "I"),
    ];
  }

  return [
    anatomicalAxisLabel(point.x, "R", "L"),
    anatomicalAxisLabel(point.y, "A", "P"),
    anatomicalAxisLabel(point.z, "S", "I"),
  ];
}


// ============================================================
// 07 — NON-SENSITIVE STATUS LABELS
// ============================================================

function planeLabel(
  plane: CoordinateReadoutPlane,
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

function coordinateStatusLabel(
  status: CoordinateReadoutStatus,
): string {
  switch (status) {
    case "idle":
      return "Move the cursor over an image.";

    case "loading":
      return "Preparing coordinate display…";

    case "valid":
      return "Coordinate sample available.";

    case "outside-volume":
      return "Cursor is outside the image volume.";

    case "unavailable":
      return "Coordinates are unavailable.";

    case "error":
      return "Coordinate display is unavailable.";
  }
}


// ============================================================
// 08 — DISPLAY DATA RESOLUTION
// ============================================================

export interface CoordinateDisplayData {
  readonly voxelIndexText: string;

  readonly primaryConvention: CoordinateConvention;
  readonly primaryText: string;

  readonly secondaryConvention: CoordinateConvention;
  readonly secondaryText: string;

  readonly primaryDirections: string;
  readonly secondaryDirections: string;

  readonly geometryAvailable: boolean;
}

export function resolveCoordinateDisplay(
  sample: CoordinateReadoutSample | null,
  primaryConvention: CoordinateConvention,
  precision: number,
): CoordinateDisplayData {
  const voxelIndexText =
    sample?.status === "valid"
      ? formatCoordinateVoxelIndex(
          sample.voxelIndex,
        )
      : COORDINATE_UNAVAILABLE;

  const geometryAvailable =
    sample?.status === "valid" &&
    sample.geometryVerified === true &&
    validCoordinatePoint(sample.patientLPS);

  const secondaryConvention:
    CoordinateConvention =
    primaryConvention === "LPS"
      ? "RAS"
      : "LPS";

  if (
    !geometryAvailable ||
    !sample ||
    !validCoordinatePoint(sample.patientLPS)
  ) {
    return {
      voxelIndexText,
      primaryConvention,
      primaryText: COORDINATE_UNAVAILABLE,
      secondaryConvention,
      secondaryText: COORDINATE_UNAVAILABLE,
      primaryDirections: "",
      secondaryDirections: "",
      geometryAvailable: false,
    };
  }

  const lps = sample.patientLPS;
  const ras = convertLPSToRAS(lps);

  if (ras === null) {
    return {
      voxelIndexText,
      primaryConvention,
      primaryText: COORDINATE_UNAVAILABLE,
      secondaryConvention,
      secondaryText: COORDINATE_UNAVAILABLE,
      primaryDirections: "",
      secondaryDirections: "",
      geometryAvailable: false,
    };
  }

  const primary =
    primaryConvention === "LPS"
      ? lps
      : ras;

  const secondary =
    primaryConvention === "LPS"
      ? ras
      : lps;

  const primaryLabels =
    getCoordinateAnatomicalDirections(
      primary,
      primaryConvention,
    );

  const secondaryLabels =
    getCoordinateAnatomicalDirections(
      secondary,
      secondaryConvention,
    );

  return {
    voxelIndexText,
    primaryConvention,
    primaryText: formatCoordinatePoint(
      primary,
      precision,
    ),
    secondaryConvention,
    secondaryText: formatCoordinatePoint(
      secondary,
      precision,
    ),
    primaryDirections:
      primaryLabels?.join(" / ") ?? "",
    secondaryDirections:
      secondaryLabels?.join(" / ") ?? "",
    geometryAvailable: true,
  };
}


// ============================================================
// 09 — COMPONENT STYLES
// ============================================================

const rootStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  width: "100%",
  minWidth: 0,
  boxSizing: "border-box",
  gap: 9,
  padding: 11,
  backgroundColor: "#101827",
  color: "#e2e8f0",
  border: "1px solid #263244",
  borderRadius: 7,
};

const headerStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  flexWrap: "wrap",
  gap: 8,
};

const gridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns:
    "repeat(auto-fit, minmax(160px, 1fr))",
  gap: 8,
};

const fieldStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 5,
  minWidth: 0,
  padding: 9,
  backgroundColor: "#0b1220",
  border: "1px solid #263244",
  borderRadius: 5,
};

const labelStyle: CSSProperties = {
  fontSize: 10,
  fontWeight: 600,
  color: "#94a3b8",
};

const valueStyle: CSSProperties = {
  color: "#e2e8f0",
  fontSize: 12,
  fontWeight: 600,
  lineHeight: 1.5,
  fontFamily:
    "ui-monospace, SFMono-Regular, Menlo, monospace",
  fontVariantNumeric: "tabular-nums",
  overflowWrap: "anywhere",
};

const noteStyle: CSSProperties = {
  fontSize: 11,
  lineHeight: 1.5,
  color: "#94a3b8",
};

const warningStyle: CSSProperties = {
  ...noteStyle,
  color: "#fbbf24",
};


// ============================================================
// 10 — REUSABLE DISPLAY FIELD
// ============================================================

interface CoordinateFieldProps {
  readonly title: string;
  readonly value: string;
  readonly note?: string;
}

function CoordinateField({
  title,
  value,
  note,
}: CoordinateFieldProps) {
  return (
    <div style={fieldStyle}>
      <span style={labelStyle}>
        {title}
      </span>

      <span style={valueStyle}>
        {value}
      </span>

      {note && (
        <span style={noteStyle}>
          {note}
        </span>
      )}
    </div>
  );
}


// ============================================================
// 11 — MAIN COMPONENT
// ============================================================

export function CoordinateReadout({
  plane,
  sample,
  primaryConvention = "LPS",
  showSecondaryConvention = false,
  showVoxelIndices = true,
  showAnatomicalDirections = true,
  precision = COORDINATE_DEFAULT_PRECISION,
  visible = true,
  compact = false,
  className = "",
}: CoordinateReadoutProps) {
  const status =
    sample?.status ?? "idle";

  const safePrecision =
    normalizeCoordinatePrecision(precision);

  const display = useMemo(
    () => resolveCoordinateDisplay(
      sample,
      primaryConvention,
      safePrecision,
    ),
    [
      sample,
      primaryConvention,
      safePrecision,
    ],
  );

  if (!visible) {
    return null;
  }

  const hasValidSample =
    status === "valid";

  const geometryVerified =
    hasValidSample &&
    display.geometryAvailable;

  // ==========================================================
  // 12 — JSX
  // ==========================================================

  return (
    <section
      className={className}
      style={{
        ...rootStyle,
        padding: compact ? 8 : 11,
        gap: compact ? 6 : 9,
      }}
      aria-label={`${planeLabel(plane)} coordinate readout`}
      data-coordinate-readout="true"
      data-coordinate-plane={plane}
      data-coordinate-status={status}
      data-geometry-verified={
        geometryVerified ? "true" : "false"
      }
    >
      <div style={headerStyle}>
        <strong
          style={{
            fontSize: compact ? 11 : 13,
            color: "#f8fafc",
          }}
        >
          {planeLabel(plane)} Coordinates
        </strong>

        <span style={noteStyle}>
          {geometryVerified
            ? "LPS geometry verified upstream"
            : "Geometry unavailable / unverified"}
        </span>
      </div>

      {!hasValidSample ? (
        <span
          style={noteStyle}
          role="status"
          aria-live="polite"
        >
          {coordinateStatusLabel(status)}
        </span>
      ) : (
        <>
          <div style={gridStyle}>
            {showVoxelIndices && (
              <CoordinateField
                title="Voxel indices (i, j, k)"
                value={display.voxelIndexText}
                note="Zero-based index coordinates"
              />
            )}

            <CoordinateField
              title={`Patient ${display.primaryConvention} (x, y, z)`}
              value={display.primaryText}
              note={
                geometryVerified
                  ? "Millimeters"
                  : "Unverified physical coordinates"
              }
            />

            {showSecondaryConvention && (
              <CoordinateField
                title={`Patient ${display.secondaryConvention} (x, y, z)`}
                value={display.secondaryText}
                note={
                  geometryVerified
                    ? "Millimeters"
                    : "Unverified physical coordinates"
                }
              />
            )}
          </div>

          {geometryVerified &&
            showAnatomicalDirections && (
              <div style={noteStyle}>
                {display.primaryConvention}
                {" axis directions: "}
                {display.primaryDirections}

                {showSecondaryConvention && (
                  <>
                    {" | "}
                    {display.secondaryConvention}
                    {" axis directions: "}
                    {display.secondaryDirections}
                  </>
                )}
              </div>
            )}

          {!geometryVerified && (
            <div
              role="status"
              style={warningStyle}
            >
              Patient-space coordinates are hidden
              until geometry is verified.
            </div>
          )}
        </>
      )}

      {!compact && (
        <div style={noteStyle}>
          DICOM LPS: +X Left, +Y Posterior,
          +Z Superior. RAS: +X Right,
          +Y Anterior, +Z Superior.
        </div>
      )}

      <div
        style={{
          ...noteStyle,
          fontSize: 10,
        }}
      >
        Research visualization only.
        Anatomical geometry requires independent
        validation.
      </div>
    </section>
  );
}


// ============================================================
// 13 — CAPABILITIES
// ============================================================

export function getCoordinateReadoutCapabilities() {
  return {
    axialSupport: true,
    coronalSupport: true,
    sagittalSupport: true,
    zeroBasedVoxelIndexDisplay: true,
    patientLPSCoordinates: true,
    optionalRASCoordinates: true,
    lpsToRasConversion: true,
    rasToLpsConversion: true,
    finiteCoordinateValidation: true,
    safeIntegerVoxelIndices: true,
    configurablePrecision: true,
    anatomicalAxisDescriptions: true,
    missingGeometryFallback: true,
    outsideVolumeStatus: true,
    compactLayout: true,
    upstreamGeometryVerificationRequired: true,
    automaticAffineCalculation: false,
    automaticDICOMMetadataExtraction: false,
    patientIdentifierDisplay: false,
    directNetworkRequests: false,
    browserPersistence: false,
    sourceDatasetModification: false,
    clinicalValidationComplete: false,
  } as const;
}


// ============================================================
// END OF SINUS VIEWER COORDINATE READOUT
// ============================================================
