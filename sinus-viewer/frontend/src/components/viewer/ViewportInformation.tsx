
/**
 * SINUS VIEWER — VIEWPORT INFORMATION
 * ====================================
 *
 * Read-only information overlay for a single MPR view.
 *
 * Displays only allowlisted, non-identifying fields:
 * - Anatomical plane
 * - Current slice / total slices
 * - Relative zoom percentage
 * - Rendered image dimensions
 * - Verified in-plane physical pixel spacing
 * - Loading / ready / error states
 *
 * IMPORTANT:
 * - Slice indices are zero-based internally.
 * - Displayed slice numbers are one-based.
 * - Zoom is relative; not a physical scale.
 * - Display dimensions are pixel counts.
 * - Pixel spacing is shown only with explicit
 *   upstream geometry verification.
 * - No DICOM tags or arbitrary metadata objects.
 * - No patient identifiers, paths or UIDs.
 *
 * Original CT/CBCT data is never modified.
 */

import {
  useMemo,
  type CSSProperties,
} from "react";

// ============================================================
// 01 — PUBLIC TYPES
// ============================================================

export type ViewportInformationPlane =
  | "axial"
  | "coronal"
  | "sagittal";

export type ViewportInformationStatus =
  | "idle"
  | "loading"
  | "ready"
  | "unavailable"
  | "error";

export type ViewportInformationPlacement =
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right";

export interface ViewportImageDimensions {
  readonly width: number;
  readonly height: number;
}

export interface ViewportPhysicalSpacing {
  /**
   * Final MPR image grid spacing along its
   * horizontal and vertical pixel axes.
   *
   * These are not CSS pixel measurements.
   */
  readonly horizontalMm: number;
  readonly verticalMm: number;

  /**
   * Parent must validate the resliced image affine.
   * A flag alone does not prove clinical accuracy.
   */
  readonly geometryVerified: boolean;
}

export interface ViewportInformationData {
  readonly status: ViewportInformationStatus;
  readonly sliceIndex: number;
  readonly sliceCount: number;
  readonly zoom: number;

  readonly imageDimensions?:
    ViewportImageDimensions | null;

  readonly physicalSpacing?:
    ViewportPhysicalSpacing | null;
}

export interface ViewportInformationProps {
  readonly plane: ViewportInformationPlane;
  readonly data: ViewportInformationData | null;

  readonly visible?: boolean;
  readonly compact?: boolean;
  readonly placement?: ViewportInformationPlacement;

  readonly showSlice?: boolean;
  readonly showZoom?: boolean;
  readonly showDimensions?: boolean;
  readonly showSpacing?: boolean;
  readonly showUnavailableFields?: boolean;

  readonly className?: string;
}

// ============================================================
// 02 — CONSTANTS
// ============================================================

export const VIEWPORT_INFO_MAX_DIMENSION = 1000000;
export const VIEWPORT_INFO_MAX_SLICE_COUNT = 10000000;
export const VIEWPORT_INFO_MAX_ZOOM = 1000;
export const VIEWPORT_INFO_MAX_SPACING_MM = 100000;

// ============================================================
// 03 — VALIDATION HELPERS
// ============================================================

export function validViewportDimensions(
  value: ViewportImageDimensions | null | undefined,
): value is ViewportImageDimensions {
  return (
    value != null &&
    Number.isSafeInteger(value.width) &&
    Number.isSafeInteger(value.height) &&
    value.width > 0 &&
    value.height > 0 &&
    value.width <= VIEWPORT_INFO_MAX_DIMENSION &&
    value.height <= VIEWPORT_INFO_MAX_DIMENSION
  );
}

export function validViewportSpacing(
  value: ViewportPhysicalSpacing | null | undefined,
): value is ViewportPhysicalSpacing {
  return (
    value != null &&
    value.geometryVerified === true &&
    Number.isFinite(value.horizontalMm) &&
    Number.isFinite(value.verticalMm) &&
    value.horizontalMm > 0 &&
    value.verticalMm > 0 &&
    value.horizontalMm <= VIEWPORT_INFO_MAX_SPACING_MM &&
    value.verticalMm <= VIEWPORT_INFO_MAX_SPACING_MM
  );
}

export function validViewportSlice(
  index: number,
  count: number,
): boolean {
  return (
    Number.isSafeInteger(count) &&
    count >= 1 &&
    count <= VIEWPORT_INFO_MAX_SLICE_COUNT &&
    Number.isSafeInteger(index) &&
    index >= 0 &&
    index < count
  );
}

export function validViewportZoom(
  zoom: number,
): boolean {
  return (
    Number.isFinite(zoom) &&
    zoom > 0 &&
    zoom <= VIEWPORT_INFO_MAX_ZOOM
  );
}

// ============================================================
// 04 — FORMATTING HELPERS
// ============================================================

export function formatViewportSlice(
  index: number,
  count: number,
): string {
  if (!validViewportSlice(index, count)) {
    return "Unavailable";
  }

  return `${index + 1} / ${count}`;
}

export function formatViewportZoom(
  zoom: number,
): string {
  if (!validViewportZoom(zoom)) {
    return "Unavailable";
  }

  const percentage = zoom * 100;

  return `${Number(percentage.toFixed(1))}%`;
}

export function formatViewportDimensions(
  dimensions: ViewportImageDimensions | null | undefined,
): string {
  if (!validViewportDimensions(dimensions)) {
    return "Unavailable";
  }

  return `${dimensions.width} × ${dimensions.height} px`;
}

export function formatViewportSpacing(
  spacing: ViewportPhysicalSpacing | null | undefined,
): string {
  if (!validViewportSpacing(spacing)) {
    return "Unverified";
  }

  return (
    `${spacing.horizontalMm.toFixed(3)} × ` +
    `${spacing.verticalMm.toFixed(3)} mm/pixel`
  );
}

export function viewportInformationPlaneLabel(
  plane: ViewportInformationPlane,
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

export function viewportInformationStatusLabel(
  status: ViewportInformationStatus,
): string {
  switch (status) {
    case "idle":
      return "Awaiting image";
    case "loading":
      return "Loading image…";
    case "ready":
      return "Ready";
    case "unavailable":
      return "Image unavailable";
    case "error":
      return "Display unavailable";
  }
}

// ============================================================
// 05 — ALLOWLISTED DISPLAY MODEL
// ============================================================

export interface ViewportInformationField {
  readonly key: "slice" | "zoom" | "dimensions" | "spacing";
  readonly label: string;
  readonly value: string;
}

export interface ViewportInformationModel {
  readonly status: ViewportInformationStatus;
  readonly fields: readonly ViewportInformationField[];
}

export function buildViewportInformationModel(
  data: ViewportInformationData | null,
  options: {
    readonly showSlice?: boolean;
    readonly showZoom?: boolean;
    readonly showDimensions?: boolean;
    readonly showSpacing?: boolean;
    readonly showUnavailableFields?: boolean;
  } = {},
): ViewportInformationModel {
  const status = data?.status ?? "idle";
  const fields: ViewportInformationField[] = [];

  if (!data || status !== "ready") {
    return { status, fields };
  }

  const includeUnavailable =
    options.showUnavailableFields ?? false;

  const add = (
    key: ViewportInformationField["key"],
    label: string,
    value: string,
  ): void => {
    if (
      includeUnavailable ||
      (value !== "Unavailable" && value !== "Unverified")
    ) {
      fields.push({ key, label, value });
    }
  };

  if (options.showSlice !== false) {
    add(
      "slice",
      "Slice",
      formatViewportSlice(data.sliceIndex, data.sliceCount),
    );
  }

  if (options.showZoom !== false) {
    add(
      "zoom",
      "Relative zoom",
      formatViewportZoom(data.zoom),
    );
  }

  if (options.showDimensions !== false) {
    add(
      "dimensions",
      "Image grid",
      formatViewportDimensions(data.imageDimensions),
    );
  }

  if (options.showSpacing !== false) {
    add(
      "spacing",
      "In-plane spacing",
      formatViewportSpacing(data.physicalSpacing),
    );
  }

  return { status, fields };
}

// ============================================================
// 06 — STYLES
// ============================================================

const rootStyle: CSSProperties = {
  position: "absolute",
  zIndex: 13,
  pointerEvents: "none",
  userSelect: "none",
  display: "flex",
  flexDirection: "column",
  gap: 5,
  maxWidth: "calc(100% - 24px)",
  padding: "8px 10px",
  boxSizing: "border-box",
  backgroundColor: "rgba(8, 17, 30, 0.82)",
  border: "1px solid rgba(148, 163, 184, 0.2)",
  borderRadius: 6,
  color: "#e2e8f0",
  fontSize: 11,
  fontVariantNumeric: "tabular-nums",
};

const fieldRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  justifyContent: "space-between",
  gap: 12,
};

const fieldLabelStyle: CSSProperties = {
  color: "#94a3b8",
  fontSize: 10,
};

const fieldValueStyle: CSSProperties = {
  color: "#f8fafc",
  textAlign: "right",
  overflowWrap: "anywhere",
};

function informationPlacementStyle(
  placement: ViewportInformationPlacement,
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
// 07 — MAIN COMPONENT
// ============================================================

export function ViewportInformation({
  plane,
  data,
  visible = true,
  compact = false,
  placement = "top-left",
  showSlice = true,
  showZoom = true,
  showDimensions = true,
  showSpacing = true,
  showUnavailableFields = false,
  className = "",
}: ViewportInformationProps) {
  const model = useMemo(
    () =>
      buildViewportInformationModel(data, {
        showSlice,
        showZoom,
        showDimensions,
        showSpacing,
        showUnavailableFields,
      }),
    [
      data,
      showSlice,
      showZoom,
      showDimensions,
      showSpacing,
      showUnavailableFields,
    ],
  );

  if (!visible) {
    return null;
  }

  const planeLabel =
    viewportInformationPlaneLabel(plane);

  const statusText =
    viewportInformationStatusLabel(model.status);

  return (
    <aside
      className={className}
      style={{
        ...rootStyle,
        ...informationPlacementStyle(placement),
        padding: compact ? "5px 7px" : "8px 10px",
      }}
      aria-label={`${planeLabel} viewport information`}
      data-viewport-information="true"
      data-viewport-info-plane={plane}
      data-viewport-info-status={model.status}
    >
      <strong
        style={{
          fontSize: compact ? 11 : 12,
          color: "#e0f2fe",
        }}
      >
        {planeLabel}
      </strong>

      {model.status !== "ready" ? (
        <span
          style={fieldLabelStyle}
          role="status"
        >
          {statusText}
        </span>
      ) : model.fields.length === 0 ? (
        <span style={fieldLabelStyle}>
          No verified display information
        </span>
      ) : (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: compact ? 3 : 5,
          }}
        >
          {model.fields.map((field) => (
            <div
              key={field.key}
              style={fieldRowStyle}
              data-viewport-info-field={field.key}
            >
              <span style={fieldLabelStyle}>
                {field.label}
              </span>

              <span style={fieldValueStyle}>
                {field.value}
              </span>
            </div>
          ))}
        </div>
      )}
    </aside>
  );
}

// ============================================================
// 08 — CAPABILITIES
// ============================================================

export function getViewportInformationCapabilities() {
  return {
    axialSupport: true,
    coronalSupport: true,
    sagittalSupport: true,
    zeroBasedSliceInput: true,
    oneBasedSliceDisplay: true,
    relativeZoomDisplay: true,
    imageGridDimensions: true,
    verifiedPixelSpacingOnly: true,
    explicitStatusHandling: true,
    allowlistedMetadataFields: true,
    compactLayout: true,
    configurablePlacement: true,
    unavailableFieldFiltering: true,
    parentOwnedDisplayState: true,
    patientIdentifiersDisplayed: false,
    arbitraryDICOMTagsDisplayed: false,
    directDICOMAccess: false,
    directNetworkRequests: false,
    browserPersistence: false,
    sourceDatasetModification: false,
    clinicalValidationComplete: false,
  } as const;
}

// ============================================================
// END OF SINUS VIEWER VIEWPORT INFORMATION
// ============================================================
