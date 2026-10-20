
/**
 * SINUS VIEWER — REUSABLE ZOOM CONTROLS
 * ====================================
 *
 * Controlled zoom interface for a single MPR viewport.
 *
 * Features:
 * - Axial, coronal and sagittal viewport support.
 * - Controlled zoom factor (1 = 100%).
 * - Native keyboard-accessible zoom slider.
 * - Zoom-in / zoom-out with multiplicative stepping.
 * - Quick zoom presets.
 * - Fit-to-view and reset commands.
 * - Finite-value validation and clamping.
 * - Loading and disabled state protection.
 * - Compact and normal layouts.
 * - Accessible control descriptions.
 *
 * IMPORTANT:
 * The parent owns zoom state, pan, image fitting,
 * display transformations and canvas rendering.
 *
 * Zoom 100% means factor 1, not necessarily one
 * source image pixel per screen CSS pixel.
 *
 * This file does not:
 * - Access DICOM files.
 * - Modify medical images.
 * - Make HTTP requests.
 * - Persist application state.
 * - Display patient metadata.
 */

import {
  useCallback,
  useId,
  type CSSProperties,
  type ChangeEvent,
} from "react";


// ============================================================
// 01 — PUBLIC TYPES
// ============================================================

export type ZoomControlsPlane =
  | "axial"
  | "coronal"
  | "sagittal";

export type ZoomControlsSize =
  | "compact"
  | "normal";

export type ZoomChangeSource =
  | "slider"
  | "zoom-in"
  | "zoom-out"
  | "preset";

export type ZoomViewCommand =
  | "fit"
  | "reset";

export interface ZoomChangePayload {
  readonly plane: ZoomControlsPlane;
  readonly zoom: number;
  readonly source: ZoomChangeSource;
}

export interface ZoomControlsProps {
  readonly plane: ZoomControlsPlane;

  /**
   * Controlled zoom multiplier.
   *
   * 1.0 = 100% relative zoom
   * 2.0 = 200% relative zoom
   * 0.5 = 50% relative zoom
   */
  readonly zoom: number;

  readonly onZoomChange: (
    payload: ZoomChangePayload,
  ) => void;

  /**
   * Fit and Reset are parent-owned commands.
   * Their resulting zoom levels may differ.
   */
  readonly onViewCommand?: (
    command: ZoomViewCommand,
    plane: ZoomControlsPlane,
  ) => void;

  readonly minZoom?: number;
  readonly maxZoom?: number;

  readonly disabled?: boolean;
  readonly loading?: boolean;

  readonly size?: ZoomControlsSize;

  readonly showPresets?: boolean;
  readonly showFitButton?: boolean;
  readonly showResetButton?: boolean;

  readonly className?: string;
}


// ============================================================
// 02 — CONSTANTS
// ============================================================

export const ZOOM_DEFAULT_VALUE = 1;

export const ZOOM_DEFAULT_MIN = 0.25;

export const ZOOM_DEFAULT_MAX = 8;

export const ZOOM_STEP_MULTIPLIER = 1.2;

export const ZOOM_SLIDER_STEPS = 200;

export const ZOOM_PRESETS = [
  0.5,
  1,
  2,
  4,
] as const;

export const ZOOM_NUMERIC_EPSILON = 1e-9;


// ============================================================
// 03 — VALIDATION HELPERS
// ============================================================

export interface ZoomBounds {
  readonly min: number;
  readonly max: number;
}

export function getSafeZoomBounds(
  minZoom: number,
  maxZoom: number,
): ZoomBounds {
  if (
    !Number.isFinite(minZoom) ||
    !Number.isFinite(maxZoom) ||
    minZoom <= 0 ||
    maxZoom <= minZoom
  ) {
    return {
      min: ZOOM_DEFAULT_MIN,
      max: ZOOM_DEFAULT_MAX,
    };
  }

  return {
    min: minZoom,
    max: maxZoom,
  };
}

export function clampZoom(
  zoom: number,
  bounds: ZoomBounds,
): number {
  if (!Number.isFinite(zoom)) {
    return Math.min(
      bounds.max,
      Math.max(bounds.min, ZOOM_DEFAULT_VALUE),
    );
  }

  return Math.min(
    bounds.max,
    Math.max(bounds.min, zoom),
  );
}

export function formatZoomPercentage(
  zoom: number,
): string {
  if (!Number.isFinite(zoom) || zoom <= 0) {
    return "Unavailable";
  }

  return `${Math.round(zoom * 100)}%`;
}


// ============================================================
// 04 — LOGARITHMIC SLIDER CONVERSION
// ============================================================

/**
 * A logarithmic slider provides reasonably balanced
 * control around low and high magnifications.
 *
 * The slider still exposes a native 0..200 range
 * for keyboard and assistive-technology navigation.
 */
export function zoomToSliderValue(
  zoom: number,
  bounds: ZoomBounds,
): number {
  const safeZoom = clampZoom(zoom, bounds);

  const denominator = Math.log(
    bounds.max / bounds.min,
  );

  if (
    !Number.isFinite(denominator) ||
    denominator <= 0
  ) {
    return 0;
  }

  const fraction =
    Math.log(safeZoom / bounds.min) /
    denominator;

  return Math.min(
    ZOOM_SLIDER_STEPS,
    Math.max(
      0,
      Math.round(fraction * ZOOM_SLIDER_STEPS),
    ),
  );
}

export function sliderValueToZoom(
  value: number,
  bounds: ZoomBounds,
): number {
  if (!Number.isFinite(value)) {
    return clampZoom(
      ZOOM_DEFAULT_VALUE,
      bounds,
    );
  }

  const fraction = Math.min(
    1,
    Math.max(0, value / ZOOM_SLIDER_STEPS),
  );

  return clampZoom(
    bounds.min *
      Math.pow(bounds.max / bounds.min, fraction),
    bounds,
  );
}


// ============================================================
// 05 — PLANE LABEL
// ============================================================

function zoomPlaneLabel(
  plane: ZoomControlsPlane,
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
// 06 — STYLES
// ============================================================

const rootStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  width: "100%",
  minWidth: 0,
  boxSizing: "border-box",
  gap: 10,
  padding: 11,
  border: "1px solid #263244",
  borderRadius: 7,
  backgroundColor: "#101827",
  color: "#e2e8f0",
};

const headerStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  flexWrap: "wrap",
  gap: 8,
};

const rowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 7,
  width: "100%",
  minWidth: 0,
};

const actionsStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  flexWrap: "wrap",
  gap: 6,
};

const buttonStyle: CSSProperties = {
  minHeight: 32,
  minWidth: 34,
  padding: "6px 9px",
  border: "1px solid #344258",
  borderRadius: 5,
  backgroundColor: "#192437",
  color: "#e2e8f0",
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
};

const selectedButtonStyle: CSSProperties = {
  ...buttonStyle,
  backgroundColor: "#164e63",
  borderColor: "#38bdf8",
  color: "#e0f2fe",
};

const sliderStyle: CSSProperties = {
  width: "100%",
  minWidth: 60,
  flex: 1,
  accentColor: "#38bdf8",
  cursor: "pointer",
};

const secondaryStyle: CSSProperties = {
  color: "#94a3b8",
  fontSize: 11,
  fontVariantNumeric: "tabular-nums",
};


// ============================================================
// 07 — MAIN COMPONENT
// ============================================================

export function ZoomControls({
  plane,
  zoom,
  onZoomChange,
  onViewCommand,
  minZoom = ZOOM_DEFAULT_MIN,
  maxZoom = ZOOM_DEFAULT_MAX,
  disabled = false,
  loading = false,
  size = "normal",
  showPresets = true,
  showFitButton = true,
  showResetButton = true,
  className = "",
}: ZoomControlsProps) {
  const sliderId = useId();
  const valueId = useId();

  const bounds = getSafeZoomBounds(
    minZoom,
    maxZoom,
  );

  const safeZoom = clampZoom(
    zoom,
    bounds,
  );

  const sliderValue = zoomToSliderValue(
    safeZoom,
    bounds,
  );

  const displayPercent =
    formatZoomPercentage(safeZoom);

  const ready = !disabled && !loading;
  const compact = size === "compact";

  const atMinimum =
    safeZoom <=
    bounds.min + ZOOM_NUMERIC_EPSILON;

  const atMaximum =
    safeZoom >=
    bounds.max - ZOOM_NUMERIC_EPSILON;

  // ==========================================================
  // 08 — CONTROLLED ZOOM CHANGE
  // ==========================================================

  const updateZoom = useCallback(
    (
      proposedZoom: number,
      source: ZoomChangeSource,
    ): void => {
      if (
        !ready ||
        !Number.isFinite(proposedZoom)
      ) {
        return;
      }

      const nextZoom = clampZoom(
        proposedZoom,
        bounds,
      );

      if (
        Math.abs(nextZoom - safeZoom) <=
        ZOOM_NUMERIC_EPSILON
      ) {
        return;
      }

      onZoomChange({
        plane,
        zoom: nextZoom,
        source,
      });
    },
    [
      ready,
      bounds.min,
      bounds.max,
      safeZoom,
      onZoomChange,
      plane,
    ],
  );

  // ==========================================================
  // 09 — SLIDER HANDLER
  // ==========================================================

  const handleSliderChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>): void => {
      const value = Number(
        event.currentTarget.value,
      );

      if (!Number.isFinite(value)) {
        return;
      }

      updateZoom(
        sliderValueToZoom(value, bounds),
        "slider",
      );
    },
    [
      updateZoom,
      bounds.min,
      bounds.max,
    ],
  );

  // ==========================================================
  // 10 — INCREMENTAL ZOOM
  // ==========================================================

  const zoomIn = useCallback((): void => {
    updateZoom(
      safeZoom * ZOOM_STEP_MULTIPLIER,
      "zoom-in",
    );
  }, [safeZoom, updateZoom]);

  const zoomOut = useCallback((): void => {
    updateZoom(
      safeZoom / ZOOM_STEP_MULTIPLIER,
      "zoom-out",
    );
  }, [safeZoom, updateZoom]);

  // ==========================================================
  // 11 — PRESET SELECTION
  // ==========================================================

  const applyPreset = useCallback(
    (preset: number): void => {
      updateZoom(preset, "preset");
    },
    [updateZoom],
  );

  const availablePresets =
    ZOOM_PRESETS.filter(
      (preset) =>
        preset >= bounds.min &&
        preset <= bounds.max,
    );

  // ==========================================================
  // 12 — VIEW COMMANDS
  // ==========================================================

  const fitView = useCallback((): void => {
    if (ready) {
      onViewCommand?.("fit", plane);
    }
  }, [ready, onViewCommand, plane]);

  const resetView = useCallback((): void => {
    if (ready) {
      onViewCommand?.("reset", plane);
    }
  }, [ready, onViewCommand, plane]);

  // ==========================================================
  // 13 — JSX
  // ==========================================================

  return (
    <section
      className={className}
      style={{
        ...rootStyle,
        padding: compact ? 8 : 11,
        gap: compact ? 7 : 10,
      }}
      aria-label={`${zoomPlaneLabel(plane)} zoom controls`}
      data-zoom-controls="true"
      data-zoom-plane={plane}
      data-zoom-ready={
        ready ? "true" : "false"
      }
    >
      <div style={headerStyle}>
        <label
          htmlFor={sliderId}
          style={{
            color: "#f8fafc",
            fontWeight: 700,
            fontSize: compact ? 11 : 12,
          }}
        >
          {zoomPlaneLabel(plane)} Zoom
        </label>

        <strong
          id={valueId}
          style={{
            ...secondaryStyle,
            color: "#e0f2fe",
          }}
        >
          {loading
            ? "Loading…"
            : displayPercent}
        </strong>
      </div>

      <div style={rowStyle}>
        <button
          type="button"
          style={{
            ...buttonStyle,
            opacity:
              ready && !atMinimum ? 1 : 0.45,
          }}
          disabled={!ready || atMinimum}
          onClick={zoomOut}
          aria-label={`Zoom out ${plane} view`}
          title="Zoom out"
        >
          −
        </button>

        <input
          id={sliderId}
          type="range"
          min={0}
          max={ZOOM_SLIDER_STEPS}
          step={1}
          value={sliderValue}
          disabled={!ready}
          onChange={handleSliderChange}
          style={{
            ...sliderStyle,
            cursor: ready
              ? "pointer"
              : "not-allowed",
          }}
          aria-label={`${zoomPlaneLabel(plane)} magnification`}
          aria-valuetext={displayPercent}
          aria-describedby={valueId}
          data-zoom-slider="true"
        />

        <button
          type="button"
          style={{
            ...buttonStyle,
            opacity:
              ready && !atMaximum ? 1 : 0.45,
          }}
          disabled={!ready || atMaximum}
          onClick={zoomIn}
          aria-label={`Zoom in ${plane} view`}
          title="Zoom in"
        >
          +
        </button>
      </div>

      {showPresets && availablePresets.length > 0 && (
        <div
          style={actionsStyle}
          role="group"
          aria-label="Zoom presets"
        >
          {availablePresets.map((preset) => {
            const selected =
              Math.abs(safeZoom - preset) <=
              ZOOM_NUMERIC_EPSILON;

            return (
              <button
                key={preset}
                type="button"
                style={
                  selected
                    ? selectedButtonStyle
                    : buttonStyle
                }
                disabled={!ready}
                onClick={() => applyPreset(preset)}
                aria-pressed={selected}
                aria-label={`Set zoom to ${formatZoomPercentage(preset)}`}
              >
                {formatZoomPercentage(preset)}
              </button>
            );
          })}
        </div>
      )}

      {(showFitButton || showResetButton) && (
        <div
          style={actionsStyle}
          role="group"
          aria-label="Zoom view commands"
        >
          {showFitButton && (
            <button
              type="button"
              style={buttonStyle}
              disabled={
                !ready || !onViewCommand
              }
              onClick={fitView}
              title="Fit image to viewport"
            >
              Fit to View
            </button>
          )}

          {showResetButton && (
            <button
              type="button"
              style={buttonStyle}
              disabled={
                !ready || !onViewCommand
              }
              onClick={resetView}
              title="Reset viewport zoom"
            >
              Reset Zoom
            </button>
          )}
        </div>
      )}

      {!compact && (
        <span style={secondaryStyle}>
          Range: {formatZoomPercentage(bounds.min)}
          {" – "}
          {formatZoomPercentage(bounds.max)}
        </span>
      )}

      {loading && (
        <span
          role="status"
          aria-live="polite"
          style={secondaryStyle}
        >
          Preparing image display…
        </span>
      )}
    </section>
  );
}


// ============================================================
// 14 — COMPONENT CAPABILITIES
// ============================================================

export function getZoomControlsCapabilities() {
  return {
    axialSupport: true,
    coronalSupport: true,
    sagittalSupport: true,
    controlledZoomFactor: true,
    percentageDisplay: true,
    nativeRangeInput: true,
    logarithmicSliderMapping: true,
    multiplicativeZoomStep: true,
    zoomIn: true,
    zoomOut: true,
    presetMagnifications: true,
    fitToViewCommand: true,
    resetZoomCommand: true,
    finiteValueValidation: true,
    zoomBoundsClamping: true,
    compactLayout: true,
    loadingState: true,
    disabledState: true,
    parentOwnedTransform: true,
    directCanvasTransform: false,
    directNetworkRequests: false,
    browserPersistence: false,
    sourceDatasetModification: false,
    clinicalValidationComplete: false,
  } as const;
}


// ============================================================
// END OF SINUS VIEWER ZOOM CONTROLS
// ============================================================
