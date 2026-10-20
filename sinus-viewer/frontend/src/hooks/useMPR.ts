
/**
 * SINUS VIEWER — REACT MPR CONTROLLER
 * ===================================
 *
 * React state management for three patient-aligned
 * multiplanar reconstruction viewports.
 *
 * Features:
 * - Axial, coronal and sagittal viewport state.
 * - Shared crosshair in DICOM LPS millimetres.
 * - Zoom around a screen-space anchor.
 * - Physical panning.
 * - Slice navigation and scrolling.
 * - Screen-to-world crosshair placement.
 * - Synchronized slice positions.
 * - Viewport resizing and fit-to-volume.
 * - Sampling-plane generation for File 51.
 *
 * IMPORTANT:
 * The current functions manage geometry and state.
 * Actual image resampling and canvas rendering
 * are performed by later components.
 *
 * SECURITY:
 * - No patient metadata or source paths are stored.
 * - No network requests or persistent storage.
 * - No original DICOM files are accessed or modified.
 *
 * CLINICAL LIMITATION:
 * Rendering orientation and image measurement accuracy
 * require separate validation using reference datasets.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";

import type {
  PreviewPlane,
  VolumeGeometry,
} from "../types/api";

import {
  assertVolumeGeometry,
  clampVoxelToVolume,
  voxelToWorldLPS,
  worldLPSToVoxel,
  type VoxelPoint,
  type WorldPointLPS,
} from "../utils/geometry";

import {
  alignMPRSliceToWorld,
  buildMPRSamplingPlane,
  centreMPRAtWorld,
  createMPRViewport,
  getMPRSliceStepMm,
  mprScreenToWorldLPS,
  moveMPRSliceMm,
  panMPRViewport,
  projectMPRCrosshair,
  resizeMPRViewport,
  resetMPRViewport,
  zoomMPRViewport,
  type MPRCrosshairProjection,
  type MPRScreenPoint,
  type MPRViewportSize,
  type MPRViewportState,
} from "../utils/mpr";

import type {
  MPRPlane,
} from "../utils/volumeSampling";


// ============================================================
// 01 — CONSTANTS
// ============================================================

export const MPR_PLANES = [
  "axial",
  "coronal",
  "sagittal",
] as const;

export const DEFAULT_MPR_VIEWPORT_SIZE = {
  width: 512,
  height: 512,
} as const satisfies MPRViewportSize;

export const DEFAULT_MPR_ZOOM_FACTOR = 1.2;


// ============================================================
// 02 — PUBLIC TYPES
// ============================================================

export type MPRViewportMap = Readonly<
  Record<PreviewPlane, MPRViewportState>
>;

export type MPRSamplingPlaneMap = Readonly<
  Record<PreviewPlane, MPRPlane>
>;

export type MPRCrosshairProjectionMap = Readonly<
  Record<PreviewPlane, MPRCrosshairProjection>
>;

export interface MPRInitialSizes {
  readonly axial?: MPRViewportSize;
  readonly coronal?: MPRViewportSize;
  readonly sagittal?: MPRViewportSize;
}

export interface MPRControllerState {
  readonly viewports: MPRViewportMap;
  readonly crosshairWorld: WorldPointLPS;
  readonly activePlane: PreviewPlane;
  readonly revision: number;
}

export interface MPRControllerActions {
  readonly setActivePlane: (
    plane: PreviewPlane,
  ) => void;

  readonly setCrosshairWorld: (
    world: WorldPointLPS,
  ) => void;

  readonly setCrosshairVoxel: (
    voxel: VoxelPoint,
  ) => void;

  readonly setCrosshairFromScreen: (
    plane: PreviewPlane,
    point: MPRScreenPoint,
  ) => void;

  readonly scrollSlice: (
    plane: PreviewPlane,
    steps: number,
  ) => void;

  readonly moveSliceMm: (
    plane: PreviewPlane,
    distanceMm: number,
  ) => void;

  readonly pan: (
    plane: PreviewPlane,
    deltaX: number,
    deltaY: number,
  ) => void;

  readonly zoom: (
    plane: PreviewPlane,
    factor: number,
    anchor?: MPRScreenPoint,
  ) => void;

  readonly resize: (
    plane: PreviewPlane,
    size: MPRViewportSize,
  ) => void;

  readonly fit: (
    plane?: PreviewPlane,
  ) => void;

  readonly centerOnCrosshair: (
    plane?: PreviewPlane,
  ) => void;

  readonly reset: () => void;
}

export interface UseMPRResult {
  readonly state: MPRControllerState;
  readonly actions: MPRControllerActions;

  readonly axial: MPRViewportState;
  readonly coronal: MPRViewportState;
  readonly sagittal: MPRViewportState;

  readonly samplingPlanes: MPRSamplingPlaneMap;
  readonly crosshairProjections: MPRCrosshairProjectionMap;

  readonly crosshairWorld: WorldPointLPS;
  readonly crosshairVoxel: VoxelPoint;
  readonly activePlane: PreviewPlane;

  readonly ready: true;
}


// ============================================================
// 03 — VALIDATION
// ============================================================

function assertPlane(
  plane: PreviewPlane,
): void {
  if (
    plane !== "axial" &&
    plane !== "coronal" &&
    plane !== "sagittal"
  ) {
    throw new Error(
      "Invalid MPR plane selection.",
    );
  }
}

function assertWorld(
  world: WorldPointLPS,
): void {
  if (
    !world ||
    !Number.isFinite(world.x) ||
    !Number.isFinite(world.y) ||
    !Number.isFinite(world.z)
  ) {
    throw new Error(
      "Invalid physical crosshair position.",
    );
  }
}

function assertFiniteNumber(
  value: number,
): void {
  if (!Number.isFinite(value)) {
    throw new Error(
      "Invalid MPR navigation value.",
    );
  }
}

function isViewportSize(
  value: MPRViewportSize,
): boolean {
  return (
    Number.isSafeInteger(value.width) &&
    Number.isSafeInteger(value.height) &&
    value.width > 0 &&
    value.height > 0 &&
    value.width <= 2048 &&
    value.height <= 2048 &&
    value.width * value.height <= 4194304
  );
}


// ============================================================
// 04 — INITIALIZATION
// ============================================================

function resolveSize(
  sizes: MPRInitialSizes,
  plane: PreviewPlane,
): MPRViewportSize {
  const size =
    sizes[plane] ?? DEFAULT_MPR_VIEWPORT_SIZE;

  if (!isViewportSize(size)) {
    throw new Error(
      "Invalid initial MPR viewport size.",
    );
  }

  return {
    width: size.width,
    height: size.height,
  };
}

function createInitialState(
  geometry: VolumeGeometry,
  sizes: MPRInitialSizes,
): MPRControllerState {
  assertVolumeGeometry(geometry);

  const axial = createMPRViewport(
    geometry,
    "axial",
    resolveSize(sizes, "axial"),
  );

  const coronal = createMPRViewport(
    geometry,
    "coronal",
    resolveSize(sizes, "coronal"),
  );

  const sagittal = createMPRViewport(
    geometry,
    "sagittal",
    resolveSize(sizes, "sagittal"),
  );

  return {
    viewports: {
      axial,
      coronal,
      sagittal,
    },
    crosshairWorld: {
      ...axial.centerLPS,
    },
    activePlane: "axial",
    revision: 0,
  };
}


// ============================================================
// 05 — CROSSHAIR BOUNDS
// ============================================================

function boundWorldToVolume(
  geometry: VolumeGeometry,
  world: WorldPointLPS,
): WorldPointLPS {
  assertWorld(world);

  const voxel = worldLPSToVoxel(
    geometry,
    world,
  );

  const bounded = clampVoxelToVolume(
    geometry,
    voxel,
  );

  return voxelToWorldLPS(
    geometry,
    bounded,
  );
}


// ============================================================
// 06 — SYNCHRONIZE THREE SLICES
// ============================================================

/**
 * Shift each viewport only along its anatomical normal,
 * retaining its in-plane pan and zoom.
 *
 * This preserves independent camera navigation while
 * synchronizing slice depth to one 3D crosshair.
 */
function synchronizeSlices(
  viewports: MPRViewportMap,
  crosshairWorld: WorldPointLPS,
): MPRViewportMap {
  return {
    axial: alignMPRSliceToWorld(
      viewports.axial,
      crosshairWorld,
    ),
    coronal: alignMPRSliceToWorld(
      viewports.coronal,
      crosshairWorld,
    ),
    sagittal: alignMPRSliceToWorld(
      viewports.sagittal,
      crosshairWorld,
    ),
  };
}

function updateCrosshair(
  geometry: VolumeGeometry,
  previous: MPRControllerState,
  world: WorldPointLPS,
  activePlane?: PreviewPlane,
): MPRControllerState {
  const crosshairWorld = boundWorldToVolume(
    geometry,
    world,
  );

  return {
    ...previous,
    crosshairWorld,
    viewports: synchronizeSlices(
      previous.viewports,
      crosshairWorld,
    ),
    activePlane:
      activePlane ?? previous.activePlane,
    revision: previous.revision + 1,
  };
}


// ============================================================
// 07 — HOOK
// ============================================================

/**
 * Use one instance for all three MPR views.
 *
 * Pass the corresponding viewport and sampling plane
 * to child rendering components.
 *
 * A changed geometry reference reinitializes the
 * controller. Keep the geometry object stable while
 * navigating a single loaded volume.
 */
export function useMPR(
  geometry: VolumeGeometry,
  initialSizes: MPRInitialSizes = {},
): UseMPRResult {
  const [state, setState] =
    useState<MPRControllerState>(
      () => createInitialState(
        geometry,
        initialSizes,
      ),
    );

  /**
   * Preserve latest viewport dimensions when changing
   * volumes, but initialize the new volume's physical
   * centre, scale and crosshair.
   *
   * The effect intentionally does not depend on
   * initialSizes: sizes are initial defaults only.
   */
  useEffect(() => {
    setState((previous) => {
      const sizes: MPRInitialSizes = {
        axial: previous.viewports.axial.size,
        coronal: previous.viewports.coronal.size,
        sagittal: previous.viewports.sagittal.size,
      };

      const fresh = createInitialState(
        geometry,
        sizes,
      );

      return {
        ...fresh,
        revision: previous.revision + 1,
      };
    });
  }, [geometry]);

  // ==========================================================
  // 08 — ACTIVE VIEW
  // ==========================================================

  const setActivePlane = useCallback(
    (plane: PreviewPlane): void => {
      assertPlane(plane);

      setState((previous) => (
        previous.activePlane === plane
          ? previous
          : {
              ...previous,
              activePlane: plane,
              revision: previous.revision + 1,
            }
      ));
    },
    [],
  );

  // ==========================================================
  // 09 — CROSSHAIR WORLD POSITION
  // ==========================================================

  const setCrosshairWorld = useCallback(
    (world: WorldPointLPS): void => {
      const bounded = boundWorldToVolume(
        geometry,
        world,
      );

      setState((previous) =>
        updateCrosshair(
          geometry,
          previous,
          bounded,
        ),
      );
    },
    [geometry],
  );

  const setCrosshairVoxel = useCallback(
    (voxel: VoxelPoint): void => {
      const bounded = clampVoxelToVolume(
        geometry,
        voxel,
      );

      setCrosshairWorld(
        voxelToWorldLPS(
          geometry,
          bounded,
        ),
      );
    },
    [geometry, setCrosshairWorld],
  );

  // ==========================================================
  // 10 — CROSSHAIR FROM MOUSE POSITION
  // ==========================================================

  const setCrosshairFromScreen = useCallback(
    (
      plane: PreviewPlane,
      point: MPRScreenPoint,
    ): void => {
      assertPlane(plane);

      setState((previous) => {
        const viewport =
          previous.viewports[plane];

        const world = mprScreenToWorldLPS(
          viewport,
          point,
        );

        return updateCrosshair(
          geometry,
          previous,
          world,
          plane,
        );
      });
    },
    [geometry],
  );

  // ==========================================================
  // 11 — SLICE SCROLLING
  // ==========================================================

  const moveSliceMm = useCallback(
    (
      plane: PreviewPlane,
      distanceMm: number,
    ): void => {
      assertPlane(plane);
      assertFiniteNumber(distanceMm);

      setState((previous) => {
        const moved = moveMPRSliceMm(
          previous.viewports[plane],
          distanceMm,
        );

        /**
         * Move the 3D crosshair along the same plane
         * normal by the requested physical distance.
         * The final point is bounded by volume geometry.
         */
        const currentCrosshair =
          previous.crosshairWorld;

        const original = mprScreenToWorldLPS(
          previous.viewports[plane],
          {
            x: (
              previous.viewports[plane].size.width - 1
            ) / 2,
            y: (
              previous.viewports[plane].size.height - 1
            ) / 2,
          },
        );

        const shifted = mprScreenToWorldLPS(
          moved,
          {
            x: (
              moved.size.width - 1
            ) / 2,
            y: (
              moved.size.height - 1
            ) / 2,
          },
        );

        const world: WorldPointLPS = {
          x: currentCrosshair.x +
            shifted.x - original.x,
          y: currentCrosshair.y +
            shifted.y - original.y,
          z: currentCrosshair.z +
            shifted.z - original.z,
        };

        return updateCrosshair(
          geometry,
          previous,
          world,
          plane,
        );
      });
    },
    [geometry],
  );

  const scrollSlice = useCallback(
    (
      plane: PreviewPlane,
      steps: number,
    ): void => {
      assertPlane(plane);

      if (!Number.isSafeInteger(steps)) {
        throw new Error(
          "Slice steps must be integers.",
        );
      }

      const spacing = getMPRSliceStepMm(
        geometry,
        plane,
      );

      moveSliceMm(
        plane,
        steps * spacing,
      );
    },
    [geometry, moveSliceMm],
  );

  // ==========================================================
  // 12 — PAN
  // ==========================================================

  const pan = useCallback(
    (
      plane: PreviewPlane,
      deltaX: number,
      deltaY: number,
    ): void => {
      assertPlane(plane);
      assertFiniteNumber(deltaX);
      assertFiniteNumber(deltaY);

      setState((previous) => ({
        ...previous,
        viewports: {
          ...previous.viewports,
          [plane]: panMPRViewport(
            previous.viewports[plane],
            deltaX,
            deltaY,
          ),
        },
        activePlane: plane,
        revision: previous.revision + 1,
      }));
    },
    [],
  );

  // ==========================================================
  // 13 — ZOOM
  // ==========================================================

  const zoom = useCallback(
    (
      plane: PreviewPlane,
      factor: number,
      anchor?: MPRScreenPoint,
    ): void => {
      assertPlane(plane);
      assertFiniteNumber(factor);

      setState((previous) => ({
        ...previous,
        viewports: {
          ...previous.viewports,
          [plane]: zoomMPRViewport(
            previous.viewports[plane],
            factor,
            anchor,
          ),
        },
        activePlane: plane,
        revision: previous.revision + 1,
      }));
    },
    [],
  );

  // ==========================================================
  // 14 — RESIZE
  // ==========================================================

  const resize = useCallback(
    (
      plane: PreviewPlane,
      size: MPRViewportSize,
    ): void => {
      assertPlane(plane);

      if (!isViewportSize(size)) {
        throw new Error(
          "Invalid MPR viewport size.",
        );
      }

      setState((previous) => {
        const current =
          previous.viewports[plane];

        if (
          current.size.width === size.width &&
          current.size.height === size.height
        ) {
          return previous;
        }

        return {
          ...previous,
          viewports: {
            ...previous.viewports,
            [plane]: resizeMPRViewport(
              current,
              size,
            ),
          },
          revision: previous.revision + 1,
        };
      });
    },
    [],
  );

  // ==========================================================
  // 15 — FIT TO VOLUME
  // ==========================================================

  const fit = useCallback(
    (plane?: PreviewPlane): void => {
      if (plane !== undefined) {
        assertPlane(plane);
      }

      setState((previous) => {
        const next: Record<
          PreviewPlane,
          MPRViewportState
        > = {
          ...previous.viewports,
        };

        for (const target of MPR_PLANES) {
          if (
            plane !== undefined &&
            target !== plane
          ) {
            continue;
          }

          const reset = resetMPRViewport(
            geometry,
            previous.viewports[target],
          );

          next[target] = alignMPRSliceToWorld(
            reset,
            previous.crosshairWorld,
          );
        }

        return {
          ...previous,
          viewports: next,
          revision: previous.revision + 1,
        };
      });
    },
    [geometry],
  );

  // ==========================================================
  // 16 — CENTRE ON CROSSHAIR
  // ==========================================================

  const centerOnCrosshair = useCallback(
    (plane?: PreviewPlane): void => {
      if (plane !== undefined) {
        assertPlane(plane);
      }

      setState((previous) => {
        const next: Record<
          PreviewPlane,
          MPRViewportState
        > = {
          ...previous.viewports,
        };

        for (const target of MPR_PLANES) {
          if (
            plane !== undefined &&
            target !== plane
          ) {
            continue;
          }

          next[target] = centreMPRAtWorld(
            previous.viewports[target],
            previous.crosshairWorld,
          );
        }

        return {
          ...previous,
          viewports: next,
          revision: previous.revision + 1,
        };
      });
    },
    [],
  );

  // ==========================================================
  // 17 — RESET ALL MPR VIEWS
  // ==========================================================

  const reset = useCallback(
    (): void => {
      setState((previous) => {
        const sizes: MPRInitialSizes = {
          axial: previous.viewports.axial.size,
          coronal: previous.viewports.coronal.size,
          sagittal: previous.viewports.sagittal.size,
        };

        const fresh = createInitialState(
          geometry,
          sizes,
        );

        return {
          ...fresh,
          revision: previous.revision + 1,
        };
      });
    },
    [geometry],
  );

  // ==========================================================
  // 18 — RESAMPLING PLANE DESCRIPTORS
  // ==========================================================

  const samplingPlanes = useMemo(
    (): MPRSamplingPlaneMap => ({
      axial: buildMPRSamplingPlane(
        state.viewports.axial,
      ),
      coronal: buildMPRSamplingPlane(
        state.viewports.coronal,
      ),
      sagittal: buildMPRSamplingPlane(
        state.viewports.sagittal,
      ),
    }),
    [state.viewports],
  );

  // ==========================================================
  // 19 — CROSSHAIR PROJECTIONS
  // ==========================================================

  const crosshairProjections = useMemo(
    (): MPRCrosshairProjectionMap => ({
      axial: projectMPRCrosshair(
        state.viewports.axial,
        state.crosshairWorld,
      ),
      coronal: projectMPRCrosshair(
        state.viewports.coronal,
        state.crosshairWorld,
      ),
      sagittal: projectMPRCrosshair(
        state.viewports.sagittal,
        state.crosshairWorld,
      ),
    }),
    [state.viewports, state.crosshairWorld],
  );

  const crosshairVoxel = useMemo(
    (): VoxelPoint => worldLPSToVoxel(
      geometry,
      state.crosshairWorld,
    ),
    [geometry, state.crosshairWorld],
  );

  // ==========================================================
  // 20 — ACTION BUNDLE
  // ==========================================================

  const actions = useMemo(
    (): MPRControllerActions => ({
      setActivePlane,
      setCrosshairWorld,
      setCrosshairVoxel,
      setCrosshairFromScreen,
      scrollSlice,
      moveSliceMm,
      pan,
      zoom,
      resize,
      fit,
      centerOnCrosshair,
      reset,
    }),
    [
      setActivePlane,
      setCrosshairWorld,
      setCrosshairVoxel,
      setCrosshairFromScreen,
      scrollSlice,
      moveSliceMm,
      pan,
      zoom,
      resize,
      fit,
      centerOnCrosshair,
      reset,
    ],
  );

  return {
    state,
    actions,

    axial: state.viewports.axial,
    coronal: state.viewports.coronal,
    sagittal: state.viewports.sagittal,

    samplingPlanes,
    crosshairProjections,

    crosshairWorld: state.crosshairWorld,
    crosshairVoxel,
    activePlane: state.activePlane,

    ready: true,
  };
}


// ============================================================
// 21 — HOOK CAPABILITIES
// ============================================================

export function getMPRHookCapabilities() {
  return {
    synchronizedThreePlaneNavigation: true,
    dicomLPSCoordinates: true,
    obliqueVolumeCompatibility: true,
    physicalSliceNavigation: true,
    independentPanAndZoom: true,
    anchoredZoom: true,
    crosshairWorldSynchronization: true,
    resamplingPlaneDescriptors: true,
    actualImageRendering: false,
    automaticVolumeLoading: false,
    modifiesSourceData: false,
    diagnosticValidationComplete: false,
  } as const;
}


// ============================================================
// END OF SINUS VIEWER REACT MPR CONTROLLER
// ============================================================
