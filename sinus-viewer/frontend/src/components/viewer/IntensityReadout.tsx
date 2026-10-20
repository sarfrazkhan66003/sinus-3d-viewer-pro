
/**
 * SINUS VIEWER — INTENSITY READOUT
 * ================================
 *
 * Presentation-only MPR voxel sampling readout.
 *
 * Displays:
 * - Raw decoded voxel/sample value.
 * - Optional verified HU value.
 * - Optional voxel indices (i, j, k).
 * - Optional verified LPS patient-space position.
 * - Active anatomical MPR plane.
 * - Sample and calibration states.
 *
 * CLINICAL SAFETY:
 * - CT is NOT assumed to be HU-calibrated.
 * - CBCT gray values are NOT labeled HU by default.
 * - HU requires an explicit verified calibration.
 * - No raw file paths, UIDs or patient names.
 * - Coordinates must come from validated geometry.
 * - No interpolation or sampling happens here.
 *
 * Rendering and geometry interpretation are owned
 * by the parent MPR/volume sampling pipeline.
 *
 * This component performs no network, filesystem,
 * storage or DICOM write operations.
 */

import {
  useMemo,
  type CSSProperties,
} from "react";

// ============================================================
// 01 — PUBLIC TYPES
// ============================================================

export type IntensityReadoutPlane =
  | "axial"
  | "coronal"
  | "sagittal";

export type IntensityModality =
  | "CT"
  | "CBCT"
  | "unknown";

export type IntensityCalibration =
  | "unverified"
  | "raw"
  | "verified-hu";

export type IntensitySampleStatus =
  | "idle"
  | "sampling"
  | "valid"
  | "outside-volume"
  | "unavailable"
  | "error";

export interface IntensityVoxelIndex {
  readonly i: number;
  readonly j: number;
  readonly k: number;
}

export interface IntensityPatientLPS {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface IntensitySample {
  readonly status: IntensitySampleStatus;

  /**
   * Raw or decoded sample value.
   * The parent must define what decoding includes.
   */
  readonly rawValue?: number | null;

  /**
   * Optional verified HU value.
   *
   * This field alone does not authorize HU display:
   * calibration must also be "verified-hu".
   */
  readonly calibratedHU?: number | null;

  readonly voxelIndex?: IntensityVoxelIndex | null;

  /**
   * Only include if derived from verified image
   * orientation, origin and spacing geometry.
   */
  readonly patientLPS?: IntensityPatientLPS | null;
}

export interface IntensityReadoutProps {
  readonly plane: IntensityReadoutPlane;
  readonly modality?: IntensityModality;
  readonly calibration?: IntensityCalibration;

  readonly sample: IntensitySample | null;

  readonly visible?: boolean;
  readonly compact?: boolean;
  readonly loading?: boolean;

  readonly showVoxelIndex?: boolean;
  readonly showPatientPosition?: boolean;

  readonly className?: string;
}

// ============================================================
// 02 — CONSTANTS
// ============================================================

export const INTENSITY_READOUT_MAX_ABS_VALUE = 1e12;

export const INTENSITY_READOUT_MAX_ABS_COORDINATE = 1e8;

export const INTENSITY_READOUT_DECIMALS = 2;

// ============================================================
// 03 — VALIDATION HELPERS
// ============================================================

export function validIntensityNumber(
  value: unknown,
): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Math.abs(value) <=
      INTENSITY_READOUT_MAX_ABS_VALUE
  );
}

export function validVoxelIndex(
  value: IntensityVoxelIndex | null | undefined,
): value is IntensityVoxelIndex {
  if (!value) {
    return false;
  }

  return (
    Number.isSafeInteger(value.i) &&
    Number.isSafeInteger(value.j) &&
    Number.isSafeInteger(value.k) &&
    value.i >= 0 &&
    value.j >= 0 &&
    value.k >= 0
  );
}

export function validPatientLPS(
  value: IntensityPatientLPS | null | undefined,
): value is IntensityPatientLPS {
  if (!value) {
    return false;
  }

  return (
    [value.x, value.y, value.z].every(
      (coordinate) =>
        typeof coordinate === "number" &&
        Number.isFinite(coordinate) &&
        Math.abs(coordinate) <=
          INTENSITY_READOUT_MAX_ABS_COORDINATE,
    )
  );
}

// ============================================================
// 04 — FORMAT HELPERS
// ============================================================

function formatNumeric(
  value: number,
  decimals = INTENSITY_READOUT_DECIMALS,
): string {
  if (!validIntensityNumber(value)) {
    return "Unavailable";
  }

  return value.toLocaleString("en-US", {
    maximumFractionDigits: decimals,
    useGrouping: false,
  });
}

export function formatVoxelIndex(
  index: IntensityVoxelIndex | null | undefined,
): string {
  if (!validVoxelIndex(index)) {
    return "Unavailable";
  }

  return `(${index.i}, ${index.j}, ${index.k})`;
}

export function formatPatientLPS(
  position: IntensityPatientLPS | null | undefined,
): string {
  if (!validPatientLPS(position)) {
    return "Unavailable";
  }

  return [
    formatNumeric(position.x),
    formatNumeric(position.y),
    formatNumeric(position.z),
  ].join(", ");
}

// ============================================================
// 05 — VERIFIED CALIBRATION POLICY
// ============================================================

export interface IntensityDisplayValue {
  readonly label: string;
  readonly value: string;
  readonly unit: string;
  readonly verifiedHU: boolean;
}

/**
 * This function never derives HU from raw intensity.
 *
 * Calibration and modality must be explicitly verified
 * upstream. In particular, CBCT receives no HU label.
 */
export function resolveIntensityDisplay(
  sample: IntensitySample | null,
  modality: IntensityModality,
  calibration: IntensityCalibration,
): IntensityDisplayValue {
  if (!sample || sample.status !== "valid") {
    return {
      label: "Intensity",
      value: "Unavailable",
      unit: "",
      verifiedHU: false,
    };
  }

  const allowHU =
    modality === "CT" &&
    calibration === "verified-hu" &&
    validIntensityNumber(sample.calibratedHU);

  if (allowHU) {
    return {
      label: "Calibrated CT intensity",
      value: formatNumeric(sample.calibratedHU as number),
      unit: "HU",
      verifiedHU: true,
    };
  }

  const raw = sample.rawValue;

  return {
    label: "Uncalibrated intensity",
    value: validIntensityNumber(raw)
      ? formatNumeric(raw)
      : "Unavailable",
    unit: "relative / raw",
    verifiedHU: false,
  };
}

// ============================================================
// 06 — NON-SENSITIVE STATUS MESSAGES
// ============================================================

function statusLabel(
  status: IntensitySampleStatus,
): string {
  switch (status) {
    case "idle":
      return "Move the cursor over an image.";

    case "sampling":
      return "Sampling voxel…";

    case "valid":
      return "Sample available";

    case "outside-volume":
      return "Cursor is outside the image volume.";

    case "unavailable":
      return "Intensity sampling is unavailable.";

    case "error":
      return "The sample could not be displayed.";
  }
}

function planeLabel(
  plane: IntensityReadoutPlane,
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

function modalityLabel(
  modality: IntensityModality,
): string {
  switch (modality) {
    case "CT":
      return "CT";

    case "CBCT":
      return "CBCT";

    case "unknown":
      return "Modality unverified";
  }
}

// ============================================================
// 07 — STYLES
// ============================================================

const rootStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  width: "100%",
  minWidth: 0,
  boxSizing: "border-box",
  gap: 9,
  padding: 11,
  border: "1px solid #263244",
  borderRadius: 7,
  backgroundColor: "#101827",
  color: "#e2e8f0",
};

const headingStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  flexWrap: "wrap",
  gap: 7,
};

const gridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns:
    "repeat(auto-fit, minmax(135px, 1fr))",
  gap: 8,
};

const fieldStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  minWidth: 0,
  padding: 8,
  backgroundColor: "#0b1220",
  border: "1px solid #263244",
  borderRadius: 5,
};

const fieldLabelStyle: CSSProperties = {
  fontSize: 10,
  fontWeight: 600,
  color: "#94a3b8",
};

const fieldValueStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: "#e2e8f0",
  lineHeight: 1.5,
  overflowWrap: "anywhere",
  fontVariantNumeric: "tabular-nums",
};

const warningStyle: CSSProperties = {
  color: "#fbbf24",
  fontSize: 11,
  lineHeight: 1.5,
};

// ============================================================
// 08 — FIELD COMPONENT
// ============================================================

interface ReadoutFieldProps {
  readonly label: string;
  readonly value: string;
  readonly unit?: string;
}

function ReadoutField({
  label,
  value,
  unit = "",
}: ReadoutFieldProps) {
  return (
    <div style={fieldStyle}>
      <span style={fieldLabelStyle}>
        {label}
      </span>

      <span style={fieldValueStyle}>
        {value}

        {unit ? (
          <span
            style={{
              color: "#94a3b8",
              fontWeight: 400,
            }}
          >
            {" "}
            {unit}
          </span>
        ) : null}
      </span>
    </div>
  );
}

// ============================================================
// 09 — MAIN INTENSITY READOUT
// ============================================================

export function IntensityReadout({
  plane,
  modality = "unknown",
  calibration = "unverified",
  sample,
  visible = true,
  compact = false,
  loading = false,
  showVoxelIndex = true,
  showPatientPosition = true,
  className = "",
}: IntensityReadoutProps) {
  const status: IntensitySampleStatus =
    loading
      ? "sampling"
      : sample?.status ?? "idle";

  const activeSample =
    status === "valid" ? sample : null;

  const display = useMemo(
    () => resolveIntensityDisplay(
      activeSample,
      modality,
      calibration,
    ),
    [activeSample, modality, calibration],
  );

  if (!visible) {
    return null;
  }

  const indexText =
    activeSample
      ? formatVoxelIndex(
          activeSample.voxelIndex,
        )
      : "Unavailable";

  const positionText =
    activeSample
      ? formatPatientLPS(
          activeSample.patientLPS,
        )
      : "Unavailable";

  const validCoordinates =
    activeSample &&
    validPatientLPS(
      activeSample.patientLPS,
    );

  const isCalibratedHU =
    display.verifiedHU;

  // ==========================================================
  // 10 — JSX
  // ==========================================================

  return (
    <section
      className={className}
      style={{
        ...rootStyle,
        padding: compact ? 8 : 11,
        gap: compact ? 6 : 9,
      }}
      data-intensity-readout="true"
      data-intensity-plane={plane}
      data-intensity-modality={modality}
      data-intensity-hu-verified={
        isCalibratedHU ? "true" : "false"
      }
      aria-label={`${planeLabel(plane)} image intensity readout`}
    >
      <div style={headingStyle}>
        <strong
          style={{
            fontSize: compact ? 11 : 13,
            color: "#f8fafc",
          }}
        >
          {planeLabel(plane)} Intensity
        </strong>

        <span
          style={{
            color: "#94a3b8",
            fontSize: 11,
          }}
        >
          {modalityLabel(modality)}
        </span>
      </div>

      {status !== "valid" ? (
        <span
          role="status"
          aria-live="polite"
          style={{
            color: "#94a3b8",
            fontSize: 11,
            lineHeight: 1.5,
          }}
        >
          {statusLabel(status)}
        </span>
      ) : (
        <>
          <div style={gridStyle}>
            <ReadoutField
              label={display.label}
              value={display.value}
              unit={display.unit}
            />

            {showVoxelIndex && (
              <ReadoutField
                label="Voxel indices (i, j, k)"
                value={indexText}
              />
            )}

            {showPatientPosition && (
              <ReadoutField
                label="Patient LPS (x, y, z)"
                value={positionText}
                unit={
                  validCoordinates
                    ? "mm"
                    : ""
                }
              />
            )}
          </div>

          {!isCalibratedHU && (
            <span style={warningStyle}>
              Intensity is not verified as
              Hounsfield Units.
            </span>
          )}

          {modality === "CBCT" && (
            <span style={warningStyle}>
              CBCT grayscale values must not
              be interpreted as calibrated HU.
            </span>
          )}
        </>
      )}

      {!compact && (
        <span
          style={{
            color: "#94a3b8",
            fontSize: 10,
            lineHeight: 1.5,
          }}
        >
          Research display only.
          Geometry, sampling and calibration
          require independent validation.
        </span>
      )}
    </section>
  );
}

// ============================================================
// 11 — CAPABILITIES
// ============================================================

export function getIntensityReadoutCapabilities() {
  return {
    axialSupport: true,
    coronalSupport: true,
    sagittalSupport: true,
    rawIntensityReadout: true,
    verifiedCTHUReadout: true,
    cbctHUAssumption: false,
    voxelIndices: true,
    optionalPatientLPS: true,
    finiteValueChecks: true,
    invalidCoordinateRejection: true,
    calibrationStatusAwareness: true,
    emptySampleStatus: true,
    outsideVolumeStatus: true,
    samplingStatus: true,
    compactLayout: true,
    patientIdentifierDisplay: false,
    automaticHUCalibration: false,
    automaticDICOMGeometryMapping: false,
    directVoxelSampling: false,
    directNetworkRequests: false,
    browserPersistence: false,
    sourceDatasetModification: false,
    clinicalValidationComplete: false,
  } as const;
}

// ============================================================
// END OF SINUS VIEWER INTENSITY READOUT
// ============================================================
