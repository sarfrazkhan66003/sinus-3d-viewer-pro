
/**
 * SINUS VIEWER — MAIN VIEWER WORKSPACE
 * ====================================
 *
 * Coordinates:
 * - File 55: useVolume
 * - File 57: useMPR
 * - File 58: useWindowLevel
 * - File 59: useMeasurements
 * - File 62: MPRGrid
 * - File 63: WindowLevelPanel
 * - File 64: MeasurementToolbar
 * - File 65: MeasurementOverlay
 *
 * Volume decoding and authorization are delegated
 * to the existing FrontendVolumeService.
 *
 * LoadedVolume -> SamplingVolume conversion MUST
 * be supplied by the integration layer.
 *
 * Security:
 * - No original DICOM file access.
 * - No persistent browser storage.
 * - No patient identifiers in logs.
 * - Volume and annotations reset on selection changes.
 * - No automatic upload or export.
 *
 * Clinical validation remains pending.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";

import type {
  PreviewPlane,
  VolumeGeometry,
} from "../../types/api";

import {
  useVolume,
  getVolumeActionError,
  type VolumeSelection,
} from "../../hooks/useVolume";

import {
  useMPR,
} from "../../hooks/useMPR";

import {
  useWindowLevel,
} from "../../hooks/useWindowLevel";

import {
  useMeasurements,
} from "../../hooks/useMeasurements";

import {
  MPRGrid,
} from "./MPRGrid";

import {
  MPRCanvas,
} from "./MPRCanvas";

import {
  WindowLevelPanel,
} from "./WindowLevelPanel";

import {
  MeasurementToolbar,
} from "./MeasurementToolbar";

import {
  MeasurementOverlay,
} from "./MeasurementOverlay";

import type {
  SamplingVolume,
} from "../../utils/volumeSampling";


// ============================================================
// 01 — PUBLIC TYPES
// ============================================================

type LoadedVolume = NonNullable<
  ReturnType<typeof useVolume>["volume"]
>;

export interface ViewerWorkspaceProps {
  readonly selection: VolumeSelection | null;

  /**
   * Explicit adapter between File 47 decoded volume
   * and File 51's SamplingVolume contract.
   *
   * Must preserve:
   * - Z/Y/X voxel memory ordering
   * - original intensity values
   * - LPS origin, spacing and direction
   *
   * Must not mutate the source buffer.
   */
  readonly adaptVolume: (
    loaded: LoadedVolume,
  ) => SamplingVolume;

  readonly className?: string;
  readonly showSidebarInitially?: boolean;

  readonly onError?: (message: string) => void;
  readonly onAuthenticationRequired?: () => void;
}


// ============================================================
// 02 — STYLES
// ============================================================

const workspaceStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  width: "100%",
  height: "100%",
  minWidth: 0,
  minHeight: 0,
  overflow: "hidden",
  color: "#e2e8f0",
  backgroundColor: "#080d16",
};

const headerStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  flexWrap: "wrap",
  gap: 8,
  padding: "9px 12px",
  backgroundColor: "#101827",
  borderBottom: "1px solid #263244",
};

const buttonStyle: CSSProperties = {
  padding: "6px 10px",
  border: "1px solid #344258",
  borderRadius: 5,
  backgroundColor: "#192437",
  color: "#f8fafc",
  cursor: "pointer",
  fontSize: 12,
};

const sidebarStyle: CSSProperties = {
  width: 320,
  maxWidth: "100%",
  minWidth: 0,
  flexShrink: 0,
  display: "flex",
  flexDirection: "column",
  overflowY: "auto",
  borderLeft: "1px solid #263244",
  backgroundColor: "#101827",
};

const noticeStyle: CSSProperties = {
  padding: "8px 12px",
  fontSize: 12,
  backgroundColor: "#172033",
  color: "#cbd5e1",
  borderBottom: "1px solid #263244",
};

const errorStyle: CSSProperties = {
  ...noticeStyle,
  backgroundColor: "#450a0a",
  color: "#fecaca",
};

const drawingSurfaceStyle: CSSProperties = {
  position: "relative",
  width: "100%",
  height: 260,
  overflow: "hidden",
  backgroundColor: "#000000",
};


// ============================================================
// 03 — HELPERS
// ============================================================

function selectionKey(
  selection: VolumeSelection | null,
): string | null {
  if (!selection) {
    return null;
  }

  return JSON.stringify([
    selection.datasetSessionId,
    selection.seriesHandle,
  ]);
}

function safeWorkspaceMessage(): string {
  return "The selected volume could not be displayed.";
}

function safeVolumeGeometry(
  volume: SamplingVolume,
): VolumeGeometry {
  return volume.geometry;
}


// ============================================================
// 04 — LOADED VIEWER CONTENT
// ============================================================

/**
 * Mounted only for a successfully adapted volume.
 *
 * This guarantees that useMPR always receives valid
 * geometry instead of undefined/null.
 *
 * React key at the call site isolates the measurements
 * and MPR state of one volume from another.
 */
interface LoadedViewerProps {
  readonly volume: SamplingVolume;
  readonly showSidebarInitially: boolean;
  readonly onError?: (message: string) => void;
}

function LoadedViewer({
  volume,
  showSidebarInitially,
  onError,
}: LoadedViewerProps) {
  const geometry = safeVolumeGeometry(volume);

  const mpr = useMPR(geometry);
  const display = useWindowLevel();
  const measurements = useMeasurements();

  const [sidebarVisible, setSidebarVisible] =
    useState(showSidebarInitially);

  const [drawingVisible, setDrawingVisible] =
    useState(false);

  const activePlane = mpr.activePlane;
  const activeViewport =
    mpr.state.viewports[activePlane];

  // ==========================================================
  // 05 — MEASUREMENT INPUT ROUTING
  // ==========================================================

  /**
   * File 62's MPRGrid currently routes image clicks
   * to crosshair placement.
   *
   * For measurement input, the workspace supplies
   * a dedicated drawing surface using MPRCanvas and
   * MeasurementOverlay, both sharing the exact same
   * active viewport coordinates.
   *
   * Direct measurement routing within every MPRGrid
   * panel requires a later MPRGrid interface extension.
   */
  const handleDrawingClick = useCallback(
    (
      plane: PreviewPlane,
      point: { x: number; y: number },
    ): void => {
      if (
        measurements.activeTool === "none"
      ) {
        mpr.actions.setCrosshairFromScreen(
          plane,
          point,
        );
        return;
      }

      try {
        measurements.actions.addScreenPoint(
          mpr.state.viewports[plane],
          point,
        );
      } catch {
        onError?.(
          "Unable to place the measurement point.",
        );
      }
    },
    [
      measurements.activeTool,
      measurements.actions,
      mpr.actions,
      mpr.state.viewports,
      onError,
    ],
  );

  const toggleSidebar = useCallback(() => {
    setSidebarVisible((value) => !value);
  }, []);

  const toggleDrawing = useCallback(() => {
    setDrawingVisible((value) => !value);
  }, []);

  const showDrawingSurface =
    sidebarVisible && drawingVisible;

  // ==========================================================
  // 06 — RENDER
  // ==========================================================

  return (
    <>
      <div style={headerStyle}>
        <strong style={{ fontSize: 13 }}>
          CT / CBCT Multiplanar Viewer
        </strong>

        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 6,
          }}
        >
          <button
            type="button"
            style={buttonStyle}
            onClick={() => mpr.actions.fit()}
          >
            Fit All
          </button>

          <button
            type="button"
            style={buttonStyle}
            onClick={() =>
              mpr.actions.centerOnCrosshair()
            }
          >
            Centre Crosshair
          </button>

          <button
            type="button"
            style={buttonStyle}
            onClick={toggleSidebar}
            aria-expanded={sidebarVisible}
          >
            {sidebarVisible
              ? "Hide Controls"
              : "Show Controls"}
          </button>
        </div>
      </div>

      <div
        style={{
          display: "flex",
          flex: 1,
          minWidth: 0,
          minHeight: 0,
          overflow: "hidden",
        }}
      >
        <main
          style={{
            flex: 1,
            minWidth: 0,
            minHeight: 0,
          }}
          aria-label="Three-plane medical image viewer"
        >
          <MPRGrid
            volume={volume}
            viewports={mpr.state.viewports}
            renderOptions={display.renderOptions}
            crosshairWorld={mpr.crosshairWorld}
            activePlane={mpr.activePlane}
            actions={mpr.actions}
            onRenderError={onError}
          />
        </main>

        {sidebarVisible && (
          <aside
            style={sidebarStyle}
            aria-label="Medical image display tools"
          >
            <WindowLevelPanel
              state={display.state}
              actions={display.actions}
              intensities={volume.voxels}
              onError={onError}
            />

            <div
              style={{
                borderTop: "1px solid #263244",
              }}
            >
              <MeasurementToolbar
                state={measurements.state}
                actions={measurements.actions}
                onError={onError}
              />
            </div>

            <div
              style={{
                padding: 12,
                borderTop: "1px solid #263244",
              }}
            >
              <button
                type="button"
                style={{
                  ...buttonStyle,
                  width: "100%",
                }}
                onClick={toggleDrawing}
                aria-expanded={drawingVisible}
              >
                {drawingVisible
                  ? "Close Measurement Drawing"
                  : "Open Measurement Drawing"}
              </button>

              <p
                style={{
                  color: "#94a3b8",
                  fontSize: 11,
                  lineHeight: 1.5,
                }}
              >
                Measurement points are placed in the
                dedicated drawing view below. It uses
                the active anatomical plane and the
                same physical viewport coordinates.
              </p>
            </div>

            {showDrawingSurface && (
              <div
                style={{
                  padding: "0 12px 12px",
                }}
              >
                <div style={drawingSurfaceStyle}>
                  <MPRCanvas
                    volume={volume}
                    viewport={activeViewport}
                    renderOptions={display.renderOptions}
                    crosshairWorld={mpr.crosshairWorld}
                    onPan={mpr.actions.pan}
                    onZoom={mpr.actions.zoom}
                    onScrollSlice={
                      mpr.actions.scrollSlice
                    }
                    onCrosshairPlace={
                      handleDrawingClick
                    }
                    onRenderError={onError}
                  />

                  <MeasurementOverlay
                    viewport={activeViewport}
                    measurements={
                      measurements.state.measurements
                    }
                    draft={measurements.state.draft}
                    selectedId={
                      measurements.state.selectedId
                    }
                  />
                </div>

                <div
                  style={{
                    color: "#94a3b8",
                    fontSize: 11,
                    marginTop: 7,
                  }}
                >
                  Drawing plane: {activePlane}.
                  Use the main viewer to select a
                  different anatomical plane.
                </div>
              </div>
            )}
          </aside>
        )}
      </div>

      <div style={noticeStyle}>
        Navigation and research visualization only.
        Intensity calibration, orientation and
        measurement accuracy require validation.
      </div>
    </>
  );
}


// ============================================================
// 07 — MAIN WORKSPACE CONTROLLER
// ============================================================

export function ViewerWorkspace({
  selection,
  adaptVolume,
  className = "",
  showSidebarInitially = true,
  onError,
  onAuthenticationRequired,
}: ViewerWorkspaceProps) {
  const volumeController = useVolume();

  const {
    volume,
    progress,
    actions,
    isLoading,
    requiresAuthentication,
  } = volumeController;

  const key = selectionKey(selection);

  const generationRef = useRef(0);
  const [requestError, setRequestError] =
    useState<string | null>(null);

  /**
   * Track the request generation that completed.
   *
   * We do not display the old volume simply because
   * a newly selected series is still loading.
   */
  const [loadedKey, setLoadedKey] =
    useState<string | null>(null);

  // ==========================================================
  // 08 — AUTHORIZED VOLUME LOADING
  // ==========================================================

  useEffect(() => {
    generationRef.current += 1;

    const generation = generationRef.current;

    setRequestError(null);
    setLoadedKey(null);

    actions.reset();

    if (!selection || key === null) {
      return;
    }

    let active = true;

    void actions.load(selection).then(
      () => {
        if (
          active &&
          generation === generationRef.current
        ) {
          setLoadedKey(key);
        }
      },
      (error: unknown) => {
        if (
          !active ||
          generation !== generationRef.current
        ) {
          return;
        }

        setRequestError(
          getVolumeActionError(error),
        );
      },
    );

    return () => {
      active = false;
      actions.cancel();
    };
  }, [
    actions,
    key,
    selection?.datasetSessionId,
    selection?.seriesHandle,
  ]);

  // ==========================================================
  // 09 — AUTHENTICATION EXPIRY
  // ==========================================================

  useEffect(() => {
    if (requiresAuthentication) {
      onAuthenticationRequired?.();
    }
  }, [
    requiresAuthentication,
    onAuthenticationRequired,
  ]);

  // ==========================================================
  // 10 — EXPLICIT VOLUME ADAPTATION
  // ==========================================================

  const adaptation = useMemo(() => {
    if (
      !volume ||
      key === null ||
      loadedKey !== key
    ) {
      return {
        samplingVolume: null as SamplingVolume | null,
        error: null as string | null,
      };
    }

    try {
      const samplingVolume = adaptVolume(volume);

      if (
        !samplingVolume ||
        !(samplingVolume.voxels instanceof Float32Array) ||
        !samplingVolume.geometry
      ) {
        throw new Error(
          "Invalid sampling volume.",
        );
      }

      return {
        samplingVolume,
        error: null,
      };
    } catch {
      return {
        samplingVolume: null,
        error: safeWorkspaceMessage(),
      };
    }
  }, [
    volume,
    key,
    loadedKey,
    adaptVolume,
  ]);

  const displayedError =
    adaptation.error ?? requestError;

  const loading =
    selection !== null &&
    (isLoading ||
      (loadedKey !== key &&
        displayedError === null &&
        !requiresAuthentication));

  const hasVolume =
    adaptation.samplingVolume !== null;

  // ==========================================================
  // 11 — WORKSPACE OUTPUT
  // ==========================================================

  return (
    <section
      className={className}
      style={workspaceStyle}
      data-viewer-workspace="true"
      aria-label="Sinus Viewer workspace"
    >
      {selection === null && (
        <div style={noticeStyle}>
          Select an authorized CT/CBCT series
          to open the multiplanar viewer.
        </div>
      )}

      {loading && (
        <div
          style={noticeStyle}
          role="status"
          aria-live="polite"
        >
          Loading volume…
          {Number.isFinite(progress.percentage)
            ? ` ${Math.round(progress.percentage)}%`
            : ""}
        </div>
      )}

      {requiresAuthentication && (
        <div
          style={errorStyle}
          role="alert"
        >
          Your session requires authentication
          before this volume can be opened.
        </div>
      )}

      {displayedError && (
        <div
          style={errorStyle}
          role="alert"
        >
          {displayedError}
        </div>
      )}

      {hasVolume && key !== null && (
        <LoadedViewer
          key={key}
          volume={adaptation.samplingVolume!}
          showSidebarInitially={
            showSidebarInitially
          }
          onError={onError}
        />
      )}

      {!hasVolume &&
        !loading &&
        !requiresAuthentication && (
          <div
            style={{
              flex: 1,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: 24,
              textAlign: "center",
              color: "#94a3b8",
              fontSize: 13,
            }}
          >
            {displayedError
              ? "The viewer could not open this volume."
              : "No volume currently displayed."}
          </div>
        )}
    </section>
  );
}


// ============================================================
// 12 — WORKSPACE CAPABILITIES
// ============================================================

export function getViewerWorkspaceCapabilities() {
  return {
    authorizedVolumeLoading: true,
    explicitVolumeAdapter: true,
    threePlaneMPR: true,
    sharedCrosshairNavigation: true,
    sharedWindowLevel: true,
    measurementController: true,
    measurementToolbar: true,
    dedicatedMeasurementDrawingSurface: true,
    measurementOverlay: true,
    directMeasurementClicksInMainGrid: false,
    requestCancellation: true,
    staleSelectionProtection: true,
    selectionScopedMeasurementState: true,
    authenticationExpiryHandling: true,
    browserPersistence: false,
    sourceDICOMModification: false,
    clinicalValidationComplete: false,
  } as const;
}


// ============================================================
// END OF SINUS VIEWER WORKSPACE
// ============================================================
