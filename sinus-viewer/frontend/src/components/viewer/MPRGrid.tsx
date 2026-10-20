
/**
 * SINUS VIEWER — THREE-PLANE MPR GRID
 * ===================================
 *
 * Layout controller for:
 * - Axial MPR viewport.
 * - Coronal MPR viewport.
 * - Sagittal MPR viewport.
 * - Responsive three-plane layout.
 * - Single-plane maximized layout.
 * - Shared synchronized crosshair.
 * - Shared window/level and volume.
 * - Parent-owned navigation actions.
 *
 * This file does not load volumes or resample images.
 * MPRViewport and MPRCanvas handle rendering.
 *
 * Security:
 * - No DICOM filesystem access.
 * - No network calls or browser persistence.
 * - No logging of patient/image information.
 * - Source voxels are never modified.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";

import type {
  PreviewPlane,
} from "../../types/api";

import type {
  WorldPointLPS,
} from "../../utils/geometry";

import type {
  MPRControllerActions,
  MPRViewportMap,
} from "../../hooks/useMPR";

import type {
  InterpolationMode,
  SamplingVolume,
} from "../../utils/volumeSampling";

import type {
  RenderOptions,
} from "../../utils/windowLevel";

import {
  MPRViewport,
} from "./MPRViewport";


// ============================================================
// 01 — CONSTANTS
// ============================================================

export const MPR_GRID_PLANES = [
  "axial",
  "coronal",
  "sagittal",
] as const;

export const MPR_GRID_COMPACT_BREAKPOINT = 760;

export type MPRGridLayout =
  | "grid"
  | "single";


// ============================================================
// 02 — PROPS
// ============================================================

export interface MPRGridProps {
  readonly volume: SamplingVolume | null;

  readonly viewports: MPRViewportMap;

  readonly renderOptions: RenderOptions;

  readonly crosshairWorld: WorldPointLPS | null;

  readonly activePlane: PreviewPlane;

  readonly actions: MPRControllerActions;

  readonly loading?: boolean;

  readonly interactive?: boolean;

  readonly interpolation?: InterpolationMode;

  readonly outsideValue?: number;

  readonly initialLayout?: MPRGridLayout;

  readonly className?: string;

  readonly onRenderError?: (
    message: string,
  ) => void;
}


// ============================================================
// 03 — INTERNAL TYPES
// ============================================================

interface GridLayoutDefinition {
  readonly columns: string;
  readonly rows: string;
  readonly areas: string;
}


// ============================================================
// 04 — VALIDATION
// ============================================================

function isMPRPlane(
  value: unknown,
): value is PreviewPlane {
  return (
    value === "axial" ||
    value === "coronal" ||
    value === "sagittal"
  );
}

function isGridLayout(
  value: unknown,
): value is MPRGridLayout {
  return (
    value === "grid" ||
    value === "single"
  );
}

function assertGridProps(
  activePlane: PreviewPlane,
  layout: MPRGridLayout,
): void {
  if (
    !isMPRPlane(activePlane) ||
    !isGridLayout(layout)
  ) {
    throw new Error(
      "Invalid MPR grid configuration.",
    );
  }
}


// ============================================================
// 05 — PRESENTATION
// ============================================================

function planeTitle(
  plane: PreviewPlane,
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

function getGridLayout(
  compact: boolean,
): GridLayoutDefinition {
  if (compact) {
    return {
      columns: "minmax(0, 1fr)",
      rows: "repeat(3, minmax(280px, 1fr))",
      areas: `
        "axial"
        "coronal"
        "sagittal"
      `,
    };
  }

  return {
    columns: "repeat(2, minmax(0, 1fr))",
    rows: "repeat(2, minmax(0, 1fr))",
    areas: `
      "axial coronal"
      "sagittal sagittal"
    `,
  };
}


// ============================================================
// 06 — STYLES
// ============================================================

const rootStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  width: "100%",
  height: "100%",
  minWidth: 0,
  minHeight: 0,
  overflow: "hidden",
  backgroundColor: "#080d16",
  color: "#e2e8f0",
};

const headerStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  flexWrap: "wrap",
  gap: 8,
  padding: "8px 10px",
  borderBottom: "1px solid #263244",
  backgroundColor: "#101827",
};

const controlsStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: 6,
};

const buttonStyle: CSSProperties = {
  border: "1px solid #344258",
  backgroundColor: "#192437",
  color: "#e2e8f0",
  borderRadius: 5,
  padding: "6px 10px",
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
};

const activeButtonStyle: CSSProperties = {
  ...buttonStyle,
  borderColor: "#38bdf8",
  backgroundColor: "#164e63",
  color: "#e0f2fe",
};

const panelContainerStyle: CSSProperties = {
  minWidth: 0,
  minHeight: 0,
  overflow: "hidden",
};

const footerStyle: CSSProperties = {
  padding: "5px 10px",
  borderTop: "1px solid #263244",
  backgroundColor: "#101827",
  color: "#94a3b8",
  fontSize: 11,
};


// ============================================================
// 07 — MAIN COMPONENT
// ============================================================

export function MPRGrid({
  volume,
  viewports,
  renderOptions,
  crosshairWorld,
  activePlane,
  actions,
  loading = false,
  interactive = true,
  interpolation = "linear",
  outsideValue = 0,
  initialLayout = "grid",
  className = "",
  onRenderError,
}: MPRGridProps) {
  assertGridProps(activePlane, initialLayout);

  const rootRef = useRef<HTMLDivElement | null>(
    null,
  );

  const [layout, setLayout] =
    useState<MPRGridLayout>(initialLayout);

  const [compact, setCompact] = useState(false);

  // ==========================================================
  // 08 — RESPONSIVE CONTAINER WIDTH
  // ==========================================================

  useEffect(() => {
    const element = rootRef.current;

    if (!element) {
      return;
    }

    const updateWidth = (width: number): void => {
      if (
        !Number.isFinite(width) ||
        width <= 0
      ) {
        return;
      }

      const nextCompact =
        width < MPR_GRID_COMPACT_BREAKPOINT;

      setCompact((previous) =>
        previous === nextCompact
          ? previous
          : nextCompact,
      );
    };

    updateWidth(
      element.getBoundingClientRect().width,
    );

    if (typeof ResizeObserver === "undefined") {
      return;
    }

    const observer = new ResizeObserver(
      (entries) => {
        const entry = entries[0];

        if (entry) {
          updateWidth(entry.contentRect.width);
        }
      },
    );

    observer.observe(element);

    return () => observer.disconnect();
  }, []);

  // ==========================================================
  // 09 — LAYOUT ACTIONS
  // ==========================================================

  const showGrid = useCallback((): void => {
    setLayout("grid");
  }, []);

  const showSingle = useCallback((): void => {
    setLayout("single");
  }, []);

  const toggleMaximize = useCallback((): void => {
    setLayout((previous) =>
      previous === "grid"
        ? "single"
        : "grid",
    );
  }, []);

  const selectPlane = useCallback(
    (plane: PreviewPlane): void => {
      if (!isMPRPlane(plane)) {
        return;
      }

      actions.setActivePlane(plane);
    },
    [actions],
  );

  // ==========================================================
  // 10 — SHARED NAVIGATION
  // ==========================================================

  const fitAll = useCallback((): void => {
    if (!volume || loading) {
      return;
    }

    actions.fit();
  }, [actions, volume, loading]);

  const centerAll = useCallback((): void => {
    if (!volume || loading) {
      return;
    }

    actions.centerOnCrosshair();
  }, [actions, volume, loading]);

  // ==========================================================
  // 11 — RENDER ONE PANEL
  // ==========================================================

  /**
   * Rendering one panel always reads the parent-owned
   * MPR state. It never creates a new independent
   * useMPR, useVolume or window/level controller.
   */
  const renderPanel = (
    plane: PreviewPlane,
  ) => (
    <div
      key={plane}
      style={{
        ...panelContainerStyle,
        gridArea: plane,
      }}
      data-grid-plane={plane}
    >
      <MPRViewport
        volume={volume}
        viewport={viewports[plane]}
        renderOptions={renderOptions}
        crosshairWorld={crosshairWorld}
        loading={loading}
        active={activePlane === plane}
        interactive={interactive}
        interpolation={interpolation}
        outsideValue={outsideValue}
        onActivate={selectPlane}
        onPan={actions.pan}
        onZoom={actions.zoom}
        onScrollSlice={actions.scrollSlice}
        onCrosshairPlace={
          actions.setCrosshairFromScreen
        }
        onResize={actions.resize}
        onFit={actions.fit}
        onCenterCrosshair={
          actions.centerOnCrosshair
        }
        onRenderError={onRenderError}
      />
    </div>
  );

  const arrangement = getGridLayout(compact);

  const isSingle = layout === "single";

  const gridStyle: CSSProperties = {
    display: "grid",
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    overflow: isSingle ? "hidden" : "auto",
    gap: 6,
    padding: 6,

    gridTemplateColumns: isSingle
      ? "minmax(0, 1fr)"
      : arrangement.columns,

    gridTemplateRows: isSingle
      ? "minmax(0, 1fr)"
      : arrangement.rows,

    gridTemplateAreas: isSingle
      ? `"${activePlane}"`
      : arrangement.areas,
  };

  // ==========================================================
  // 12 — JSX
  // ==========================================================

  return (
    <section
      ref={rootRef}
      className={className}
      style={rootStyle}
      data-mpr-layout={layout}
      aria-label="Multiplanar reconstruction viewer"
    >
      <header style={headerStyle}>
        <div>
          <strong style={{ fontSize: 13 }}>
            Multiplanar Reconstruction
          </strong>

          <span
            style={{
              marginLeft: 8,
              fontSize: 11,
              color: "#94a3b8",
            }}
          >
            {isSingle
              ? `${planeTitle(activePlane)} maximized`
              : "Three-plane view"}
          </span>
        </div>

        <div
          style={controlsStyle}
          aria-label="MPR layout controls"
        >
          <button
            type="button"
            style={
              layout === "grid"
                ? activeButtonStyle
                : buttonStyle
            }
            onClick={showGrid}
            aria-pressed={layout === "grid"}
          >
            Grid
          </button>

          <button
            type="button"
            style={
              layout === "single"
                ? activeButtonStyle
                : buttonStyle
            }
            onClick={showSingle}
            aria-pressed={layout === "single"}
          >
            Maximize
          </button>

          <button
            type="button"
            style={buttonStyle}
            onClick={toggleMaximize}
            title="Toggle single-plane view"
            aria-label="Toggle maximized view"
          >
            {isSingle ? "Restore" : "Expand"}
          </button>

          <button
            type="button"
            style={buttonStyle}
            onClick={fitAll}
            disabled={!volume || loading}
            title="Fit all three views"
          >
            Fit All
          </button>

          <button
            type="button"
            style={buttonStyle}
            onClick={centerAll}
            disabled={!volume || loading}
            title="Centre all views on the crosshair"
          >
            Centre All
          </button>
        </div>

        <div
          style={controlsStyle}
          aria-label="Active MPR plane"
        >
          {MPR_GRID_PLANES.map((plane) => (
            <button
              key={plane}
              type="button"
              style={
                activePlane === plane
                  ? activeButtonStyle
                  : buttonStyle
              }
              onClick={() => selectPlane(plane)}
              aria-pressed={activePlane === plane}
              title={`Select ${planeTitle(plane)} viewport`}
            >
              {planeTitle(plane)}
            </button>
          ))}
        </div>
      </header>

      <div style={gridStyle}>
        {isSingle
          ? renderPanel(activePlane)
          : MPR_GRID_PLANES.map(renderPanel)}
      </div>

      <footer style={footerStyle}>
        {loading
          ? "Loading CT/CBCT volume…"
          : volume
            ? "LPS world-space MPR • Shared crosshair"
            : "No CT/CBCT volume selected"}
        {" • "}
        Display for navigation; clinical validation pending
      </footer>
    </section>
  );
}


// ============================================================
// 13 — COMPONENT CAPABILITIES
// ============================================================

export function getMPRGridCapabilities() {
  return {
    threePlaneLayout: true,
    responsiveContainerLayout: true,
    singlePlaneMaximize: true,
    activePlaneSwitching: true,
    parentOwnedMPRState: true,
    sharedCrosshair: true,
    sharedWindowLevel: true,
    sharedVolume: true,
    fitAllViews: true,
    centerAllViews: true,
    canvasRenderingDelegated: true,
    browserFullscreenAPI: false,
    browserStorage: false,
    modifiesSourceDICOM: false,
    clinicalValidationComplete: false,
  } as const;
}


// ============================================================
// END OF SINUS VIEWER MPR GRID
// ============================================================
