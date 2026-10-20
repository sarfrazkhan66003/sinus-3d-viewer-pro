
/**
 * SINUS VIEWER — MPR VIEWPORT PANEL
 * =================================
 *
 * One reusable axial, coronal or sagittal viewer panel.
 *
 * Features:
 * - MPRCanvas integration.
 * - Patient-aligned world-space rendering.
 * - Slice backward / forward controls.
 * - Zoom in / zoom out.
 * - Reset-to-fit action.
 * - Centre-on-crosshair action.
 * - Crosshair and orientation toggles.
 * - Slice coordinate and zoom information.
 * - Busy, empty and rendering error states.
 * - Accessible buttons and keyboard shortcuts.
 *
 * The parent viewer owns:
 * - Decoded volume.
 * - Shared crosshair.
 * - Synchronized MPR state.
 * - Window / level state.
 *
 * This component never reads or writes DICOM files.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";

import type {
  PreviewPlane,
} from "../../types/api";

import type {
  WorldPointLPS,
} from "../../utils/geometry";

import {
  getMPRMmPerPixel,
  getMPRPlaneAxes,
  type MPRScreenPoint,
  type MPRViewportSize,
  type MPRViewportState,
} from "../../utils/mpr";

import type {
  InterpolationMode,
  SamplingVolume,
} from "../../utils/volumeSampling";

import type {
  RenderOptions,
} from "../../utils/windowLevel";

import {
  MPRCanvas,
  type MPRWheelMode,
} from "./MPRCanvas";


// ============================================================
// 01 — TYPES
// ============================================================

export interface MPRViewportProps {
  readonly volume: SamplingVolume | null;
  readonly viewport: MPRViewportState;
  readonly renderOptions: RenderOptions;

  readonly crosshairWorld?: WorldPointLPS | null;

  readonly interpolation?: InterpolationMode;
  readonly outsideValue?: number;

  readonly loading?: boolean;
  readonly active?: boolean;
  readonly interactive?: boolean;

  readonly className?: string;

  readonly onActivate?: (
    plane: PreviewPlane,
  ) => void;

  readonly onPan?: (
    plane: PreviewPlane,
    deltaX: number,
    deltaY: number,
  ) => void;

  readonly onZoom?: (
    plane: PreviewPlane,
    factor: number,
    anchor: MPRScreenPoint,
  ) => void;

  readonly onScrollSlice?: (
    plane: PreviewPlane,
    steps: number,
  ) => void;

  readonly onCrosshairPlace?: (
    plane: PreviewPlane,
    point: MPRScreenPoint,
  ) => void;

  readonly onResize?: (
    plane: PreviewPlane,
    size: MPRViewportSize,
  ) => void;

  readonly onFit?: (
    plane: PreviewPlane,
  ) => void;

  readonly onCenterCrosshair?: (
    plane: PreviewPlane,
  ) => void;

  readonly onRenderError?: (
    message: string,
  ) => void;
}

interface PlanePresentation {
  readonly title: string;
  readonly abbreviation: string;
  readonly accent: string;
}


// ============================================================
// 02 — CONSTANTS
// ============================================================

export const MPR_VIEWPORT_MIN_SIZE = 64;
export const MPR_VIEWPORT_MAX_SIZE = 2048;
export const MPR_PANEL_ZOOM_FACTOR = 1.2;

const INITIAL_WHEEL_MODE: MPRWheelMode = "slice";

const NO_VOLUME_TEXT = "Select a CT/CBCT series";


// ============================================================
// 03 — PLANE PRESENTATION
// ============================================================

function getPlanePresentation(
  plane: PreviewPlane,
): PlanePresentation {
  switch (plane) {
    case "axial":
      return {
        title: "Axial",
        abbreviation: "AX",
        accent: "#38bdf8",
      };

    case "coronal":
      return {
        title: "Coronal",
        abbreviation: "COR",
        accent: "#34d399",
      };

    case "sagittal":
      return {
        title: "Sagittal",
        abbreviation: "SAG",
        accent: "#fbbf24",
      };

    default:
      throw new Error("Unsupported MPR plane.");
  }
}


// ============================================================
// 04 — SAFE DISPLAY FORMATTERS
// ============================================================

function formatNumber(
  value: number,
  digits = 2,
): string {
  if (!Number.isFinite(value)) {
    return "--";
  }

  return value.toFixed(digits);
}

function getSliceCoordinateMm(
  viewport: MPRViewportState,
): number {
  const axes = getMPRPlaneAxes(
    viewport.plane,
  );

  const world = viewport.centerLPS;

  return (
    world.x * axes.normal[0] +
    world.y * axes.normal[1] +
    world.z * axes.normal[2]
  );
}

function getViewportCenter(
  viewport: MPRViewportState,
): MPRScreenPoint {
  return {
    x: (viewport.size.width - 1) / 2,
    y: (viewport.size.height - 1) / 2,
  };
}

function validViewportDimension(
  value: number,
): boolean {
  return (
    Number.isSafeInteger(value) &&
    value >= MPR_VIEWPORT_MIN_SIZE &&
    value <= MPR_VIEWPORT_MAX_SIZE
  );
}


// ============================================================
// 05 — STYLING
// ============================================================

const panelStyle: CSSProperties = {
  position: "relative",
  display: "flex",
  flexDirection: "column",
  minWidth: 0,
  minHeight: 0,
  width: "100%",
  height: "100%",
  overflow: "hidden",
  backgroundColor: "#080d16",
  color: "#e5e7eb",
  border: "1px solid #263244",
  borderRadius: 8,
};

const toolbarStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  flexWrap: "wrap",
  gap: 8,
  padding: "7px 9px",
  backgroundColor: "#101827",
  borderBottom: "1px solid #263244",
};

const controlsStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  flexWrap: "wrap",
  gap: 4,
};

const buttonStyle: CSSProperties = {
  border: "1px solid #344258",
  backgroundColor: "#192437",
  color: "#f1f5f9",
  borderRadius: 5,
  padding: "5px 8px",
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
  minHeight: 28,
};

const disabledButtonStyle: CSSProperties = {
  ...buttonStyle,
  opacity: 0.45,
  cursor: "not-allowed",
};

const footerStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  flexWrap: "wrap",
  alignItems: "center",
  gap: 6,
  padding: "5px 9px",
  backgroundColor: "#101827",
  borderTop: "1px solid #263244",
  fontSize: 11,
  color: "#aebdd0",
};

const overlayMessageStyle: CSSProperties = {
  position: "absolute",
  inset: 0,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 16,
  backgroundColor: "rgba(5, 9, 16, 0.86)",
  color: "#cbd5e1",
  textAlign: "center",
  fontSize: 13,
  pointerEvents: "none",
};


// ============================================================
// 06 — MAIN VIEWPORT COMPONENT
// ============================================================

export function MPRViewport({
  volume,
  viewport,
  renderOptions,
  crosshairWorld = null,
  interpolation = "linear",
  outsideValue = 0,
  loading = false,
  active = false,
  interactive = true,
  className = "",
  onActivate,
  onPan,
  onZoom,
  onScrollSlice,
  onCrosshairPlace,
  onResize,
  onFit,
  onCenterCrosshair,
  onRenderError,
}: MPRViewportProps) {
  const containerRef = useRef<HTMLDivElement | null>(
    null,
  );

  const [showCrosshair, setShowCrosshair] =
    useState(true);

  const [showOrientation, setShowOrientation] =
    useState(true);

  const [wheelMode, setWheelMode] =
    useState<MPRWheelMode>(INITIAL_WHEEL_MODE);

  const [localError, setLocalError] =
    useState<string | null>(null);

  const presentation = useMemo(
    () => getPlanePresentation(viewport.plane),
    [viewport.plane],
  );

  const hasVolume = volume !== null;
  const canNavigate =
    hasVolume && !loading && interactive;

  // ==========================================================
  // 07 — RESIZE OBSERVATION
  // ==========================================================

  /**
   * Track actual panel dimensions using ResizeObserver.
   *
   * Clamp the raster size to the supported MPR limit.
   * This avoids an uncontrolled large allocation when
   * a parent layout reports extreme dimensions.
   *
   * ResizeObserver is only attached when an onResize
   * callback is supplied.
   */
  useEffect(() => {
    const element = containerRef.current;

    if (
      !element ||
      !onResize ||
      typeof ResizeObserver === "undefined"
    ) {
      return;
    }

    let lastWidth = viewport.size.width;
    let lastHeight = viewport.size.height;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];

      if (!entry) {
        return;
      }

      const bounds = entry.contentRect;

      const width = Math.min(
        MPR_VIEWPORT_MAX_SIZE,
        Math.max(
          MPR_VIEWPORT_MIN_SIZE,
          Math.round(bounds.width),
        ),
      );

      const height = Math.min(
        MPR_VIEWPORT_MAX_SIZE,
        Math.max(
          MPR_VIEWPORT_MIN_SIZE,
          Math.round(bounds.height),
        ),
      );

      if (
        !validViewportDimension(width) ||
        !validViewportDimension(height)
      ) {
        return;
      }

      if (
        width === lastWidth &&
        height === lastHeight
      ) {
        return;
      }

      lastWidth = width;
      lastHeight = height;

      onResize(viewport.plane, {
        width,
        height,
      });
    });

    observer.observe(element);

    return () => {
      observer.disconnect();
    };
  }, [
    onResize,
    viewport.plane,
    viewport.size.width,
    viewport.size.height,
  ]);

  // ==========================================================
  // 08 — ACTIVATION
  // ==========================================================

  const activate = useCallback((): void => {
    onActivate?.(viewport.plane);
  }, [onActivate, viewport.plane]);

  // ==========================================================
  // 09 — SLICE CONTROLS
  // ==========================================================

  const previousSlice = useCallback((): void => {
    if (!canNavigate) {
      return;
    }

    onScrollSlice?.(
      viewport.plane,
      -1,
    );
  }, [
    canNavigate,
    onScrollSlice,
    viewport.plane,
  ]);

  const nextSlice = useCallback((): void => {
    if (!canNavigate) {
      return;
    }

    onScrollSlice?.(
      viewport.plane,
      1,
    );
  }, [
    canNavigate,
    onScrollSlice,
    viewport.plane,
  ]);

  // ==========================================================
  // 10 — ZOOM CONTROLS
  // ==========================================================

  const zoomIn = useCallback((): void => {
    if (!canNavigate) {
      return;
    }

    onZoom?.(
      viewport.plane,
      MPR_PANEL_ZOOM_FACTOR,
      getViewportCenter(viewport),
    );
  }, [canNavigate, onZoom, viewport]);

  const zoomOut = useCallback((): void => {
    if (!canNavigate) {
      return;
    }

    onZoom?.(
      viewport.plane,
      1 / MPR_PANEL_ZOOM_FACTOR,
      getViewportCenter(viewport),
    );
  }, [canNavigate, onZoom, viewport]);

  // ==========================================================
  // 11 — VIEW CONTROL ACTIONS
  // ==========================================================

  const fitToVolume = useCallback((): void => {
    if (!canNavigate) {
      return;
    }

    onFit?.(viewport.plane);
  }, [canNavigate, onFit, viewport.plane]);

  const centerOnCrosshair = useCallback((): void => {
    if (!canNavigate || !crosshairWorld) {
      return;
    }

    onCenterCrosshair?.(
      viewport.plane,
    );
  }, [
    canNavigate,
    crosshairWorld,
    onCenterCrosshair,
    viewport.plane,
  ]);

  // ==========================================================
  // 12 — RENDER ERROR HANDLING
  // ==========================================================

  const handleRenderError = useCallback(
    (message: string): void => {
      setLocalError(
        "MPR image rendering failed.",
      );

      onRenderError?.(message);
    },
    [onRenderError],
  );

  useEffect(() => {
    setLocalError(null);
  }, [volume, viewport, renderOptions]);

  // ==========================================================
  // 13 — KEYBOARD NAVIGATION
  // ==========================================================

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>): void => {
      if (!canNavigate) {
        return;
      }

      if (
        event.target instanceof HTMLElement &&
        (
          event.target.tagName === "BUTTON" ||
          event.target.tagName === "INPUT" ||
          event.target.tagName === "SELECT" ||
          event.target.tagName === "TEXTAREA"
        )
      ) {
        return;
      }

      switch (event.key) {
        case "ArrowUp":
        case "PageUp":
          event.preventDefault();
          previousSlice();
          return;

        case "ArrowDown":
        case "PageDown":
          event.preventDefault();
          nextSlice();
          return;

        case "+":
        case "=":
          event.preventDefault();
          zoomIn();
          return;

        case "-":
          event.preventDefault();
          zoomOut();
          return;

        case "0":
          event.preventDefault();
          fitToVolume();
          return;

        case "c":
        case "C":
          event.preventDefault();
          centerOnCrosshair();
          return;

        default:
          return;
      }
    },
    [
      canNavigate,
      previousSlice,
      nextSlice,
      zoomIn,
      zoomOut,
      fitToVolume,
      centerOnCrosshair,
    ],
  );

  // ==========================================================
  // 14 — PHYSICAL VIEW INFORMATION
  // ==========================================================

  const sliceCoordinate = getSliceCoordinateMm(
    viewport,
  );

  const mmPerPixel = getMPRMmPerPixel(
    viewport,
  );

  const zoomPercentage = viewport.zoom * 100;

  const panelBorderColor = active
    ? presentation.accent
    : "#263244";

  const enabledButton = canNavigate
    ? buttonStyle
    : disabledButtonStyle;

  // ==========================================================
  // 15 — JSX
  // ==========================================================

  return (
    <section
      className={className}
      style={{
        ...panelStyle,
        borderColor: panelBorderColor,
      }}
      data-plane={viewport.plane}
      data-active={active ? "true" : "false"}
      aria-label={`${presentation.title} MPR panel`}
      onPointerDownCapture={activate}
      onFocusCapture={activate}
    >
      <header style={toolbarStyle}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <span
            style={{
              borderRadius: 4,
              backgroundColor: presentation.accent,
              color: "#08121d",
              fontSize: 10,
              fontWeight: 800,
              padding: "3px 5px",
            }}
          >
            {presentation.abbreviation}
          </span>

          <strong style={{ fontSize: 13 }}>
            {presentation.title}
          </strong>

          {active && (
            <span
              style={{
                fontSize: 10,
                color: presentation.accent,
              }}
            >
              Active
            </span>
          )}
        </div>

        <div
          style={controlsStyle}
          aria-label={`${presentation.title} controls`}
        >
          <button
            type="button"
            style={enabledButton}
            disabled={!canNavigate || !onScrollSlice}
            onClick={previousSlice}
            title="Previous slice"
            aria-label="Previous slice"
          >
            ◀
          </button>

          <button
            type="button"
            style={enabledButton}
            disabled={!canNavigate || !onScrollSlice}
            onClick={nextSlice}
            title="Next slice"
            aria-label="Next slice"
          >
            ▶
          </button>

          <button
            type="button"
            style={enabledButton}
            disabled={!canNavigate || !onZoom}
            onClick={zoomOut}
            title="Zoom out"
            aria-label="Zoom out"
          >
            −
          </button>

          <button
            type="button"
            style={enabledButton}
            disabled={!canNavigate || !onZoom}
            onClick={zoomIn}
            title="Zoom in"
            aria-label="Zoom in"
          >
            +
          </button>

          <button
            type="button"
            style={enabledButton}
            disabled={!canNavigate || !onFit}
            onClick={fitToVolume}
            title="Fit volume"
          >
            Fit
          </button>

          <button
            type="button"
            style={enabledButton}
            disabled={
              !canNavigate ||
              !crosshairWorld ||
              !onCenterCrosshair
            }
            onClick={centerOnCrosshair}
            title="Centre on crosshair"
          >
            Centre
          </button>
        </div>
      </header>

      <div
        ref={containerRef}
        style={{
          position: "relative",
          flex: 1,
          minWidth: 0,
          minHeight: 0,
          backgroundColor: "#000000",
        }}
        tabIndex={0}
        role="group"
        aria-label={`${presentation.title} image viewport`}
        onKeyDown={handleKeyDown}
      >
        <MPRCanvas
          volume={volume}
          viewport={viewport}
          renderOptions={renderOptions}
          crosshairWorld={crosshairWorld}
          interpolation={interpolation}
          outsideValue={outsideValue}
          showCrosshair={showCrosshair}
          showOrientationLabels={showOrientation}
          wheelMode={wheelMode}
          interactive={canNavigate}
          onPan={onPan}
          onZoom={onZoom}
          onScrollSlice={onScrollSlice}
          onCrosshairPlace={onCrosshairPlace}
          onRenderError={handleRenderError}
        />

        {loading && (
          <div
            style={overlayMessageStyle}
            role="status"
            aria-live="polite"
          >
            Loading volume…
          </div>
        )}

        {!loading && !hasVolume && (
          <div
            style={{
              ...overlayMessageStyle,
              backgroundColor: "transparent",
            }}
          >
            {NO_VOLUME_TEXT}
          </div>
        )}

        {localError && !loading && (
          <div
            style={{
              position: "absolute",
              left: 8,
              right: 8,
              bottom: 8,
              padding: 8,
              borderRadius: 4,
              backgroundColor: "rgba(127,29,29,0.92)",
              color: "#fee2e2",
              fontSize: 12,
              textAlign: "center",
              pointerEvents: "none",
            }}
            role="alert"
          >
            {localError}
          </div>
        )}
      </div>

      <footer style={footerStyle}>
        <span
          title="Signed position along the anatomical plane normal"
        >
          Position: {formatNumber(sliceCoordinate)} mm
        </span>

        <span title="Physical display pixel size">
          {formatNumber(mmPerPixel, 3)} mm/px
        </span>

        <span title="Display zoom">
          Zoom: {formatNumber(zoomPercentage, 0)}%
        </span>

        <label
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
          }}
        >
          <input
            type="checkbox"
            checked={showCrosshair}
            onChange={(event) =>
              setShowCrosshair(event.target.checked)
            }
          />
          Crosshair
        </label>

        <label
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
          }}
        >
          <input
            type="checkbox"
            checked={showOrientation}
            onChange={(event) =>
              setShowOrientation(event.target.checked)
            }
          />
          Labels
        </label>

        <label
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
          }}
        >
          Wheel
          <select
            value={wheelMode}
            onChange={(event) =>
              setWheelMode(
                event.target.value as MPRWheelMode,
              )
            }
            style={{
              backgroundColor: "#192437",
              color: "#f1f5f9",
              border: "1px solid #344258",
              borderRadius: 4,
              padding: 3,
              fontSize: 11,
            }}
            aria-label="Mouse wheel action"
          >
            <option value="slice">Slice</option>
            <option value="zoom">Zoom</option>
          </select>
        </label>
      </footer>
    </section>
  );
}


// ============================================================
// 16 — COMPONENT CAPABILITIES
// ============================================================

export function getMPRViewportCapabilities() {
  return {
    canvasIntegration: true,
    axialCoronalSagittal: true,
    viewportResizeObservation: true,
    sliceNavigation: true,
    zoomControls: true,
    fitToVolume: true,
    centreOnCrosshair: true,
    pointerPan: true,
    wheelNavigation: true,
    keyboardNavigation: true,
    crosshairToggle: true,
    orientationLabelToggle: true,
    volumeLoadingOverlay: true,
    persistentStorage: false,
    modifiesSourceDICOM: false,
    clinicalValidationComplete: false,
  } as const;
}


// ============================================================
// END OF SINUS VIEWER MPR VIEWPORT
// ============================================================
