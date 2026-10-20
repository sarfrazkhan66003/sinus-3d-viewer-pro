
/**
 * SINUS VIEWER — DICOM SERIES CARD
 * =================================
 *
 * Reusable presentation-only component for one
 * backend-authorized CT / CBCT imaging series.
 *
 * Features:
 * - Generic non-identifying series label.
 * - CT / CBCT modality indication.
 * - Slice count and pixel dimensions.
 * - Optional physical spacing information.
 * - Validation and preparation status.
 * - Selected / disabled / busy states.
 * - Explicit selection and viewer-opening callbacks.
 * - Responsive card layout.
 *
 * Privacy:
 * - Does not render patient names.
 * - Does not render DICOM Study / Series UIDs.
 * - Does not render original filesystem paths.
 * - Does not render arbitrary backend metadata.
 * - Does not store data in localStorage/sessionStorage.
 *
 * The parent dataset service owns authorization,
 * selection and server-side validation.
 *
 * This card does not fetch, decode, copy, modify
 * or write original DICOM files.
 */

import {
  useCallback,
  useMemo,
  type CSSProperties,
  type KeyboardEvent,
} from "react";

import {
  isOpaqueHandle,
} from "../../types/api";


// ============================================================
// 01 — PUBLIC TYPES
// ============================================================

export type SeriesValidationStatus =
  | "unknown"
  | "pending"
  | "valid"
  | "warning"
  | "invalid"
  | "unsupported";

export type SeriesProcessingStatus =
  | "idle"
  | "queued"
  | "processing"
  | "ready"
  | "failed";

export interface SeriesCardData {
  /**
   * Backend-issued opaque handle.
   *
   * Never substitute a DICOM UID or filesystem path.
   */
  readonly seriesHandle: string;

  /**
   * Public non-identifying ordinal, starting at 1.
   */
  readonly displayIndex: number;

  readonly modality?: "CT" | "CBCT" | "OTHER";

  readonly sliceCount?: number | null;
  readonly rows?: number | null;
  readonly columns?: number | null;

  readonly spacingXmm?: number | null;
  readonly spacingYmm?: number | null;
  readonly spacingZmm?: number | null;

  readonly validationStatus?: SeriesValidationStatus;
  readonly processingStatus?: SeriesProcessingStatus;

  /**
   * Set true only after backend approval.
   *
   * UI validation alone never grants authorization.
   */
  readonly serverApproved?: boolean;
}

export interface SeriesCardProps {
  readonly series: SeriesCardData;

  readonly selected?: boolean;
  readonly disabled?: boolean;
  readonly busy?: boolean;
  readonly compact?: boolean;

  readonly className?: string;

  readonly onSelect?: (
    seriesHandle: string,
  ) => void;

  readonly onOpen?: (
    seriesHandle: string,
  ) => void;
}

export interface SeriesReadiness {
  readonly handleValid: boolean;
  readonly metadataValid: boolean;
  readonly validationPassed: boolean;
  readonly processingReady: boolean;
  readonly serverApproved: boolean;
  readonly canOpen: boolean;
}


// ============================================================
// 02 — LIMITS AND CONSTANTS
// ============================================================

export const SERIES_CARD_MAX_DISPLAY_INDEX = 100000;

export const SERIES_CARD_MAX_DIMENSION = 100000;

export const SERIES_CARD_MAX_SLICE_COUNT = 10000000;

export const SERIES_CARD_MAX_SPACING_MM = 10000;


// ============================================================
// 03 — SAFE METADATA VALIDATION
// ============================================================

function isPositiveInteger(
  value: unknown,
  maximum: number,
): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= maximum
  );
}

function isPositiveFinite(
  value: unknown,
  maximum: number,
): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value > 0 &&
    value <= maximum
  );
}

function formatCount(
  value: number | null | undefined,
  maximum: number,
): string {
  return isPositiveInteger(value, maximum)
    ? value.toLocaleString()
    : "—";
}

function formatDimension(
  value: number | null | undefined,
): string {
  return isPositiveInteger(
    value,
    SERIES_CARD_MAX_DIMENSION,
  )
    ? String(value)
    : "—";
}

function formatSpacing(
  value: number | null | undefined,
): string {
  return isPositiveFinite(
    value,
    SERIES_CARD_MAX_SPACING_MM,
  )
    ? `${value.toFixed(3)} mm`
    : "—";
}

function safeModality(
  modality: SeriesCardData["modality"],
): string {
  if (modality === "CT") {
    return "CT";
  }

  if (modality === "CBCT") {
    return "CBCT";
  }

  return "Medical imaging";
}

function safeDisplayIndex(
  value: number,
): string {
  return isPositiveInteger(
    value,
    SERIES_CARD_MAX_DISPLAY_INDEX,
  )
    ? `Series ${value}`
    : "Imaging Series";
}


// ============================================================
// 04 — STATUS LABELS
// ============================================================

function validationLabel(
  status: SeriesValidationStatus,
): string {
  switch (status) {
    case "valid":
      return "Validated";

    case "warning":
      return "Review required";

    case "invalid":
      return "Invalid series";

    case "unsupported":
      return "Unsupported";

    case "pending":
      return "Validation pending";

    case "unknown":
      return "Not validated";
  }
}

function processingLabel(
  status: SeriesProcessingStatus,
): string {
  switch (status) {
    case "ready":
      return "Prepared";

    case "processing":
      return "Processing";

    case "queued":
      return "Queued";

    case "failed":
      return "Preparation failed";

    case "idle":
      return "Not prepared";
  }
}

function statusColor(
  status: SeriesValidationStatus,
): string {
  switch (status) {
    case "valid":
      return "#86efac";

    case "warning":
    case "pending":
      return "#fcd34d";

    case "invalid":
    case "unsupported":
      return "#fca5a5";

    default:
      return "#94a3b8";
  }
}


// ============================================================
// 05 — READINESS POLICY
// ============================================================

/**
 * Conservative display-level readiness checks.
 *
 * This does not perform authentication or backend
 * validation. Only server-issued status may grant
 * readiness.
 *
 * Missing dimensions do not automatically make an
 * authorized series invalid because preparation
 * metadata can arrive after discovery.
 */
export function evaluateSeriesReadiness(
  series: SeriesCardData,
): SeriesReadiness {
  const handleValid = isOpaqueHandle(
    series.seriesHandle,
  );

  const hasRows = isPositiveInteger(
    series.rows,
    SERIES_CARD_MAX_DIMENSION,
  );

  const hasColumns = isPositiveInteger(
    series.columns,
    SERIES_CARD_MAX_DIMENSION,
  );

  const hasSlices = isPositiveInteger(
    series.sliceCount,
    SERIES_CARD_MAX_SLICE_COUNT,
  );

  const metadataValid =
    hasRows &&
    hasColumns &&
    hasSlices;

  const validationPassed =
    series.validationStatus === "valid";

  const processingReady =
    series.processingStatus === "ready";

  const serverApproved =
    series.serverApproved === true;

  return {
    handleValid,
    metadataValid,
    validationPassed,
    processingReady,
    serverApproved,

    canOpen:
      handleValid &&
      metadataValid &&
      validationPassed &&
      processingReady &&
      serverApproved,
  };
}


// ============================================================
// 06 — PRESENTATION STYLES
// ============================================================

const cardStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 10,
  width: "100%",
  minWidth: 0,
  boxSizing: "border-box",
  borderRadius: 8,
  border: "1px solid #344258",
  backgroundColor: "#101827",
  color: "#e2e8f0",
  padding: 12,
};

const headingStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  flexWrap: "wrap",
  gap: 8,
};

const modalityStyle: CSSProperties = {
  border: "1px solid #344258",
  backgroundColor: "#192437",
  color: "#cbd5e1",
  borderRadius: 4,
  padding: "3px 7px",
  fontSize: 11,
  fontWeight: 600,
};

const detailsStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
  gap: 8,
};

const detailItemStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 3,
  minWidth: 0,
};

const detailLabelStyle: CSSProperties = {
  color: "#94a3b8",
  fontSize: 11,
};

const detailValueStyle: CSSProperties = {
  color: "#f1f5f9",
  fontSize: 12,
  fontVariantNumeric: "tabular-nums",
};

const actionRowStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 7,
};

const actionButtonStyle: CSSProperties = {
  padding: "7px 10px",
  border: "1px solid #344258",
  borderRadius: 5,
  backgroundColor: "#192437",
  color: "#f8fafc",
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
  minHeight: 32,
};

const mutedStyle: CSSProperties = {
  fontSize: 11,
  color: "#94a3b8",
  lineHeight: 1.5,
};


// ============================================================
// 07 — SMALL PRESENTATION COMPONENT
// ============================================================

interface SeriesDetailProps {
  readonly label: string;
  readonly value: string;
}

function SeriesDetail({
  label,
  value,
}: SeriesDetailProps) {
  return (
    <div style={detailItemStyle}>
      <span style={detailLabelStyle}>
        {label}
      </span>

      <span style={detailValueStyle}>
        {value}
      </span>
    </div>
  );
}


// ============================================================
// 08 — MAIN CARD
// ============================================================

export function SeriesCard({
  series,
  selected = false,
  disabled = false,
  busy = false,
  compact = false,
  className = "",
  onSelect,
  onOpen,
}: SeriesCardProps) {
  const readiness = useMemo(
    () => evaluateSeriesReadiness(series),
    [series],
  );

  const validationStatus =
    series.validationStatus ?? "unknown";

  const processingStatus =
    series.processingStatus ?? "idle";

  const canSelect =
    !disabled &&
    !busy &&
    readiness.handleValid &&
    typeof onSelect === "function";

  const canOpen =
    !disabled &&
    !busy &&
    readiness.canOpen &&
    typeof onOpen === "function";

  // ==========================================================
  // 09 — ACTIONS
  // ==========================================================

  const selectSeries = useCallback((): void => {
    if (!canSelect) {
      return;
    }

    onSelect?.(series.seriesHandle);
  }, [
    canSelect,
    onSelect,
    series.seriesHandle,
  ]);

  const openSeries = useCallback((): void => {
    if (!canOpen) {
      return;
    }

    onOpen?.(series.seriesHandle);
  }, [
    canOpen,
    onOpen,
    series.seriesHandle,
  ]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>): void => {
      if (
        event.defaultPrevented ||
        event.target !== event.currentTarget ||
        !canSelect
      ) {
        return;
      }

      if (
        event.key === "Enter" ||
        event.key === " "
      ) {
        event.preventDefault();
        selectSeries();
      }
    },
    [canSelect, selectSeries],
  );

  // ==========================================================
  // 10 — DERIVED DETAILS
  // ==========================================================

  const dimensions = [
    formatDimension(series.columns),
    formatDimension(series.rows),
  ].join(" × ");

  const spacingXY =
    `${formatSpacing(series.spacingXmm)} × ` +
    `${formatSpacing(series.spacingYmm)}`;

  const cardLabel = safeDisplayIndex(
    series.displayIndex,
  );

  const statusMessage = readiness.canOpen
    ? "Ready for authorized viewer opening."
    : !readiness.handleValid
      ? "Series handle unavailable."
      : !readiness.validationPassed
        ? "Backend validation is not complete."
        : !readiness.processingReady
          ? "Series preparation is not complete."
          : !readiness.metadataValid
            ? "Required image dimensions are unavailable."
            : !readiness.serverApproved
              ? "Viewer access has not been approved."
              : "Series is not ready.";

  // ==========================================================
  // 11 — JSX
  // ==========================================================

  return (
    <article
      className={className}
      style={{
        ...cardStyle,
        padding: compact ? 9 : 12,
        borderColor: selected
          ? "#38bdf8"
          : "#344258",
        opacity: disabled ? 0.7 : 1,
      }}
      tabIndex={canSelect ? 0 : -1}
      onKeyDown={handleKeyDown}
      aria-label={cardLabel}
      aria-selected={selected}
      data-series-card="true"
      data-selected={selected ? "true" : "false"}
      data-validation-status={validationStatus}
      data-processing-status={processingStatus}
    >
      <header style={headingStyle}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <strong style={{ fontSize: 13 }}>
            {cardLabel}
          </strong>

          {selected && (
            <span
              style={{
                color: "#7dd3fc",
                fontSize: 11,
              }}
            >
              Selected
            </span>
          )}
        </div>

        <span style={modalityStyle}>
          {safeModality(series.modality)}
        </span>
      </header>

      <div style={detailsStyle}>
        <SeriesDetail
          label="Images / slices"
          value={formatCount(
            series.sliceCount,
            SERIES_CARD_MAX_SLICE_COUNT,
          )}
        />

        <SeriesDetail
          label="Pixel dimensions"
          value={dimensions}
        />

        <SeriesDetail
          label="In-plane spacing"
          value={spacingXY}
        />

        <SeriesDetail
          label="Slice spacing"
          value={formatSpacing(
            series.spacingZmm,
          )}
        />
      </div>

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 6,
          borderTop: "1px solid #263244",
          paddingTop: 9,
        }}
      >
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: 7,
          }}
        >
          <span
            style={{
              color: statusColor(
                validationStatus,
              ),
              fontSize: 11,
              fontWeight: 600,
            }}
          >
            {validationLabel(validationStatus)}
          </span>

          <span style={mutedStyle}>
            •
          </span>

          <span style={mutedStyle}>
            {processingLabel(processingStatus)}
          </span>
        </div>

        <span
          style={mutedStyle}
          role="status"
          aria-live="polite"
        >
          {statusMessage}
        </span>
      </div>

      <div style={actionRowStyle}>
        <button
          type="button"
          style={{
            ...actionButtonStyle,
            borderColor: selected
              ? "#38bdf8"
              : "#344258",
          }}
          disabled={!canSelect}
          onClick={selectSeries}
          aria-label={`Select ${cardLabel}`}
          aria-pressed={selected}
        >
          {selected ? "Selected" : "Select"}
        </button>

        <button
          type="button"
          style={{
            ...actionButtonStyle,
            backgroundColor: canOpen
              ? "#0f766e"
              : "#192437",
          }}
          disabled={!canOpen}
          onClick={openSeries}
          aria-label={`Open ${cardLabel} in viewer`}
          title={
            canOpen
              ? "Open approved imaging series"
              : "Backend validation and preparation required"
          }
        >
          {busy ? "Working…" : "Open Viewer"}
        </button>
      </div>

      <div style={mutedStyle}>
        Series details are for navigation only.
        Intensity calibration and diagnostic image
        quality require separate validation.
      </div>
    </article>
  );
}


// ============================================================
// 12 — COMPONENT CAPABILITIES
// ============================================================

export function getSeriesCardCapabilities() {
  return {
    genericSeriesLabels: true,
    modalityDisplay: true,
    sliceCountDisplay: true,
    imageDimensionDisplay: true,
    physicalSpacingDisplay: true,
    backendValidationStatus: true,
    processingStatusDisplay: true,
    selectedState: true,
    keyboardSelection: true,
    authorizedOpenGate: true,
    directDICOMAccess: false,
    displaysPatientNames: false,
    displaysSourcePaths: false,
    displaysDICOMUIDs: false,
    persistentBrowserStorage: false,
    modifiesSourceDICOM: false,
    clinicalValidationComplete: false,
  } as const;
}


// ============================================================
// END OF SINUS VIEWER SERIES CARD
// ============================================================
