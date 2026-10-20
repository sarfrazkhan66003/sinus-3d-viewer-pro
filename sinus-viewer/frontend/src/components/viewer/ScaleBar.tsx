
/**
 * SINUS VIEWER — PHYSICAL SCALE BAR
 * ==================================
 *
 * Display-only calibrated ruler for MPR viewports.
 *
 * Features:
 * - Axial, coronal and sagittal support.
 * - Verified millimeters-per-CSS-pixel contract.
 * - Automatically selected 1 / 2 / 5 scale lengths.
 * - Physical scale labels in mm or cm.
 * - Responsive width, configurable alignment.
 * - Safe behavior for invalid geometry.
 * - Optional calibration-status message.
 * - No source dataset mutation.
 *
 * IMPORTANT:
 *
 * "mmPerCssPixel" MUST represent the final displayed
 * image, not raw voxel spacing.
 *
 * It must account for:
 * - DICOM patient-space geometry.
 * - MPR resampling geometry.
 * - Canvas image fitting.
 * - Current zoom and screen transforms.
 * - CSS dimensions / device pixel ratio.
 *
 * Valid only if the represented physical scale is
 * uniform along the horizontal ruler.
 *
 * If the transform is not uniform or verified,
 * the parent must set geometryVerified=false.
 *
 * Clinical accuracy needs independent validation.
 */

import {
  useMemo,
  type CSSProperties,
} from "react";


// ============================================================
// 01 — PUBLIC TYPES
// ============================================================

export type ScaleBarPlane =
  | "axial"
  | "coronal"
  | "sagittal";

export type ScaleBarPlacement =
  | "bottom-left"
  | "bottom-right"
  | "top-left"
  | "top-right";

export interface ScaleBarCalibration {
  /**
   * Physical length represented by one horizontal
   * screen CSS pixel, in millimeters.
   *
   * This is the length along the DISPLAYED ruler.
   */
  readonly mmPerCssPixel: number;

  /**
   * Only true when the parent has independently
   * verified the entire relevant display transform.
   */
  readonly geometryVerified: boolean;
}

export interface ScaleBarModel {
  readonly physicalLengthMm: number;
  readonly widthCssPx: number;
  readonly label: string;
}

export interface ScaleBarProps {
  readonly plane: ScaleBarPlane;

  /**
   * The final display calibration from the parent.
   * Null or unverified values hide the ruler.
   */
  readonly calibration: ScaleBarCalibration | null;

  /**
   * Available overlay width in CSS pixels.
   * Must match the actual scale-bar container width.
   */
  readonly viewportWidthCssPx: number;

  readonly visible?: boolean;
  readonly compact?: boolean;

  readonly placement?: ScaleBarPlacement;

  readonly maxWidthFraction?: number;
  readonly minBarWidthCssPx?: number;
  readonly maxBarWidthCssPx?: number;

  readonly showUnavailableMessage?: boolean;
  readonly className?: string;
}


// ============================================================
// 02 — CONSTANTS
// ============================================================

export const SCALE_BAR_DEFAULT_MAX_FRACTION = 0.25;

export const SCALE_BAR_DEFAULT_MIN_WIDTH_PX = 35;

export const SCALE_BAR_DEFAULT_MAX_WIDTH_PX = 180;

export const SCALE_BAR_MIN_VIEWPORT_WIDTH_PX = 20;

export const SCALE_BAR_MAX_VIEWPORT_WIDTH_PX = 100000;

export const SCALE_BAR_MAX_MM_PER_CSS_PIXEL = 1000000;

export const SCALE_BAR_NICE_MANTISSAS = [
  1,
  2,
  5,
] as const;


// ============================================================
// 03 — PURE VALIDATION HELPERS
// ============================================================

export function isValidScaleBarCalibration(
  value: ScaleBarCalibration | null | undefined,
): value is ScaleBarCalibration {
  return (
    value !== null &&
    value !== undefined &&
    value.geometryVerified === true &&
    Number.isFinite(value.mmPerCssPixel) &&
    value.mmPerCssPixel > 0 &&
    value.mmPerCssPixel <=
      SCALE_BAR_MAX_MM_PER_CSS_PIXEL
  );
}

export function isValidScaleViewportWidth(
  value: number,
): boolean {
  return (
    Number.isFinite(value) &&
    value >= SCALE_BAR_MIN_VIEWPORT_WIDTH_PX &&
    value <= SCALE_BAR_MAX_VIEWPORT_WIDTH_PX
  );
}

/**
 * Select the largest conventional ruler length
 * not exceeding the available physical distance.
 *
 * Convention: 1, 2, 5 multiplied by a power of ten.
 */
export function chooseNiceScaleLengthMm(
  maximumLengthMm: number,
): number | null {
  if (
    !Number.isFinite(maximumLengthMm) ||
    maximumLengthMm <= 0
  ) {
    return null;
  }

  const exponent = Math.floor(
    Math.log10(maximumLengthMm),
  );

  const power = 10 ** exponent;

  if (
    !Number.isFinite(power) ||
    power <= 0
  ) {
    return null;
  }

  const normalized = maximumLengthMm / power;

  let mantissa = 1;

  for (const candidate of SCALE_BAR_NICE_MANTISSAS) {
    if (candidate <= normalized) {
      mantissa = candidate;
    }
  }

  const result = mantissa * power;

  return Number.isFinite(result) &&
    result > 0 &&
    result <= maximumLengthMm * (1 + 1e-12)
    ? result
    : null;
}


// ============================================================
// 04 — PHYSICAL LENGTH FORMATTING
// ============================================================

function formatScaleNumber(value: number): string {
  if (!Number.isFinite(value)) {
    return "";
  }

  if (value >= 100) {
    return value.toFixed(0);
  }

  if (value >= 10) {
    return Number(value.toFixed(1)).toString();
  }

  return Number(value.toPrecision(3)).toString();
}

export function formatScaleBarLabel(
  physicalLengthMm: number,
): string {
  if (
    !Number.isFinite(physicalLengthMm) ||
    physicalLengthMm <= 0
  ) {
    return "Unavailable";
  }

  if (physicalLengthMm >= 10) {
    return `${formatScaleNumber(
      physicalLengthMm / 10,
    )} cm`;
  }

  return `${formatScaleNumber(
    physicalLengthMm,
  )} mm`;
}


// ============================================================
// 05 — SCALE COMPUTATION
// ============================================================

export interface ScaleBarCalculationOptions {
  readonly maxWidthFraction?: number;
  readonly minBarWidthCssPx?: number;
  readonly maxBarWidthCssPx?: number;
}

/**
 * Pure calculation. Returns null if a reliable
 * scale cannot fit inside the available viewport.
 *
 * Does not convert raw image pixels to patient
 * coordinates. That is the parent's responsibility.
 */
export function calculateScaleBar(
  calibration: ScaleBarCalibration | null,
  viewportWidthCssPx: number,
  options: ScaleBarCalculationOptions = {},
): ScaleBarModel | null {
  if (
    !isValidScaleBarCalibration(calibration) ||
    !isValidScaleViewportWidth(viewportWidthCssPx)
  ) {
    return null;
  }

  const fraction =
    options.maxWidthFraction ??
    SCALE_BAR_DEFAULT_MAX_FRACTION;

  const minWidth =
    options.minBarWidthCssPx ??
    SCALE_BAR_DEFAULT_MIN_WIDTH_PX;

  const maxWidth =
    options.maxBarWidthCssPx ??
    SCALE_BAR_DEFAULT_MAX_WIDTH_PX;

  if (
    !Number.isFinite(fraction) ||
    fraction <= 0 ||
    fraction > 0.8 ||
    !Number.isFinite(minWidth) ||
    !Number.isFinite(maxWidth) ||
    minWidth <= 0 ||
    maxWidth < minWidth
  ) {
    return null;
  }

  const allowedWidth = Math.min(
    viewportWidthCssPx * fraction,
    maxWidth,
    viewportWidthCssPx - 16,
  );

  if (
    !Number.isFinite(allowedWidth) ||
    allowedWidth < minWidth
  ) {
    return null;
  }

  const maximumLengthMm =
    allowedWidth * calibration.mmPerCssPixel;

  const physicalLengthMm =
    chooseNiceScaleLengthMm(maximumLengthMm);

  if (physicalLengthMm === null) {
    return null;
  }

  const widthCssPx =
    physicalLengthMm / calibration.mmPerCssPixel;

  if (
    !Number.isFinite(widthCssPx) ||
    widthCssPx < minWidth ||
    widthCssPx > allowedWidth * (1 + 1e-10)
  ) {
    return null;
  }

  return {
    physicalLengthMm,
    widthCssPx,
    label: formatScaleBarLabel(physicalLengthMm),
  };
}


// ============================================================
// 06 — PLACEMENT HELPERS
// ============================================================

function placementStyle(
  placement: ScaleBarPlacement,
): CSSProperties {
  switch (placement) {
    case "bottom-left":
      return {
        bottom: 12,
        left: 12,
      };

    case "bottom-right":
      return {
        bottom: 12,
        right: 12,
      };

    case "top-left":
      return {
        top: 12,
        left: 12,
      };

    case "top-right":
      return {
        top: 12,
        right: 12,
      };
  }
}

function scalePlaneLabel(
  plane: ScaleBarPlane,
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
// 07 — STYLES
// ============================================================

const rootStyle: CSSProperties = {
  position: "absolute",
  zIndex: 14,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 4,
  maxWidth: "calc(100% - 24px)",
  padding: "5px 7px",
  borderRadius: 5,
  backgroundColor: "rgba(9, 17, 30, 0.82)",
  color: "#ffffff",
  pointerEvents: "none",
  userSelect: "none",
  boxSizing: "border-box",
};

const labelStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  fontVariantNumeric: "tabular-nums",
  lineHeight: 1.2,
  whiteSpace: "nowrap",
  textShadow: "0 1px 2px rgba(0, 0, 0, 0.9)",
};

const rulerStyle: CSSProperties = {
  position: "relative",
  height: 9,
  borderLeft: "2px solid #ffffff",
  borderRight: "2px solid #ffffff",
  borderBottom: "2px solid #ffffff",
  boxSizing: "border-box",
  filter: "drop-shadow(0 1px 1px #000000)",
};


// ============================================================
// 08 — MAIN COMPONENT
// ============================================================

export function ScaleBar({
  plane,
  calibration,
  viewportWidthCssPx,
  visible = true,
  compact = false,
  placement = "bottom-left",
  maxWidthFraction = SCALE_BAR_DEFAULT_MAX_FRACTION,
  minBarWidthCssPx = SCALE_BAR_DEFAULT_MIN_WIDTH_PX,
  maxBarWidthCssPx = SCALE_BAR_DEFAULT_MAX_WIDTH_PX,
  showUnavailableMessage = false,
  className = "",
}: ScaleBarProps) {
  const model = useMemo(
    () =>
      calculateScaleBar(
        calibration,
        viewportWidthCssPx,
        {
          maxWidthFraction,
          minBarWidthCssPx,
          maxBarWidthCssPx,
        },
      ),
    [
      calibration?.mmPerCssPixel,
      calibration?.geometryVerified,
      viewportWidthCssPx,
      maxWidthFraction,
      minBarWidthCssPx,
      maxBarWidthCssPx,
    ],
  );

  if (!visible) {
    return null;
  }

  if (model === null) {
    if (!showUnavailableMessage) {
      return null;
    }

    return (
      <div
        className={className}
        style={{
          ...rootStyle,
          ...placementStyle(placement),
          alignItems: "flex-start",
          fontSize: 10,
          color: "#fbbf24",
        }}
        role="status"
        data-scale-bar-unavailable="true"
      >
        Physical scale unavailable
      </div>
    );
  }

  return (
    <div
      className={className}
      style={{
        ...rootStyle,
        ...placementStyle(placement),
        padding: compact ? "3px 5px" : "5px 7px",
      }}
      role="img"
      aria-label={
        `${scalePlaneLabel(plane)} physical scale: ` +
        `${model.label}`
      }
      data-scale-bar="true"
      data-scale-plane={plane}
      data-scale-calibrated="true"
    >
      <span
        style={{
          ...labelStyle,
          fontSize: compact ? 10 : 11,
        }}
      >
        {model.label}
      </span>

      <div
        style={{
          ...rulerStyle,
          width: model.widthCssPx,
        }}
        aria-hidden="true"
        data-scale-ruler="true"
      />
    </div>
  );
}


// ============================================================
// 09 — CAPABILITIES
// ============================================================

export function getScaleBarCapabilities() {
  return {
    axialSupport: true,
    coronalSupport: true,
    sagittalSupport: true,
    millimeterCalibration: true,
    centimeterLabels: true,
    cssPixelWidthCalculation: true,
    niceScaleLengthSelection: true,
    verifiedGeometryRequired: true,
    invalidCalibrationRejection: true,
    limitedViewportWidth: true,
    configurablePlacement: true,
    compactLayout: true,
    unavailableState: true,
    parentOwnedDisplayGeometry: true,
    automaticDICOMGeometryInference: false,
    physicalMeasurementEditing: false,
    directNetworkRequests: false,
    browserPersistence: false,
    sourceDatasetModification: false,
    clinicalValidationComplete: false,
  } as const;
}


// ============================================================
// END OF SINUS VIEWER PHYSICAL SCALE BAR
// ============================================================
