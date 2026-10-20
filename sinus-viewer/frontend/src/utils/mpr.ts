
/**
 * SINUS VIEWER — MPR VIEWPORT MATHEMATICS
 * ======================================
 *
 * Pure TypeScript utilities for:
 * - Anatomical axial / coronal / sagittal views.
 * - Viewport sizing and fit-to-volume.
 * - Zoom around a screen anchor.
 * - Physical-millimetre panning.
 * - Slice movement along anatomical plane normals.
 * - Screen pixel <-> DICOM LPS world coordinates.
 * - Synchronized crosshair projections.
 * - MPR resampling-plane construction.
 *
 * Conventions:
 *   DICOM world coordinates: LPS millimetres.
 *   Viewport coordinates: left-to-right X, top-to-bottom Y.
 *   Image pixel coordinates refer to pixel centres.
 *
 * This module does not render or access source DICOM data.
 * Patient-aligned MPR resampling is performed by
 * volumeSampling.ts using the planes built here.
 *
 * The resulting view orientation is mathematical;
 * clinical radiological screen conventions need explicit
 * validation during viewer integration.
 */

import type {
  PreviewPlane,
  VolumeGeometry,
} from "../types/api";

import {
  assertVolumeGeometry,
  voxelToWorldLPS,
  type Vec3,
  type VoxelPoint,
  type WorldPointLPS,
} from "./geometry";

import {
  makePatientAlignedMPRPlane,
  type MPRPlane,
} from "./volumeSampling";


// ============================================================
// 01 — CONSTANTS
// ============================================================

export const MIN_MPR_ZOOM = 0.1;
export const MAX_MPR_ZOOM = 20;

export const DEFAULT_MPR_ZOOM = 1;
export const DEFAULT_MPR_FIT_PADDING = 0.92;

export const MAX_MPR_VIEWPORT_DIMENSION = 2048;
export const MAX_MPR_VIEWPORT_PIXELS = 4194304;

const FLOAT_TOLERANCE = 1e-8;


// ============================================================
// 02 — PUBLIC TYPES
// ============================================================

export interface MPRViewportSize {
  readonly width: number;
  readonly height: number;
}

export interface MPRScreenPoint {
  readonly x: number;
  readonly y: number;
}

export interface MPRViewportState {
  readonly plane: PreviewPlane;
  readonly size: MPRViewportSize;

  /**
   * World coordinate at the viewport centre.
   * Panning and slice navigation update this point.
   */
  readonly centerLPS: WorldPointLPS;

  /**
   * Physical millimetres per display pixel at zoom = 1.
   */
  readonly baseMmPerPixel: number;

  /**
   * Larger zoom makes anatomy appear larger.
   */
  readonly zoom: number;
}

export interface MPRCrosshairProjection {
  readonly screen: MPRScreenPoint;
  readonly visible: boolean;
  readonly planeDistanceMm: number;
}

export interface MPRPlaneAxes {
  readonly u: Vec3;
  readonly v: Vec3;
  readonly normal: Vec3;
}

export interface MPRFitOptions {
  readonly padding?: number;
  readonly minimumMmPerPixel?: number;
}

export class MPRError extends Error {
  constructor(
    message = "Invalid MPR viewport geometry.",
  ) {
    super(message);
    this.name = "MPRError";
  }
}


// ============================================================
// 03 — NUMERIC AND VECTOR HELPERS
// ============================================================

function finite(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value)
  );
}

function positive(value: unknown): value is number {
  return finite(value) && value > 0;
}

function validDimension(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= MAX_MPR_VIEWPORT_DIMENSION
  );
}

function assertWorldPoint(point: WorldPointLPS): void {
  if (
    !point ||
    !finite(point.x) ||
    !finite(point.y) ||
    !finite(point.z)
  ) {
    throw new MPRError(
      "Invalid DICOM LPS coordinate.",
    );
  }
}

function assertScreenPoint(point: MPRScreenPoint): void {
  if (
    !point ||
    !finite(point.x) ||
    !finite(point.y)
  ) {
    throw new MPRError(
      "Invalid viewport pixel coordinate.",
    );
  }
}

function dot(a: Vec3, b: Vec3): number {
  return (
    a[0] * b[0] +
    a[1] * b[1] +
    a[2] * b[2]
  );
}

function subtract(
  a: WorldPointLPS,
  b: WorldPointLPS,
): Vec3 {
  return [
    a.x - b.x,
    a.y - b.y,
    a.z - b.z,
  ];
}

function translate(
  point: WorldPointLPS,
  axis: Vec3,
  distanceMm: number,
): WorldPointLPS {
  return {
    x: point.x + axis[0] * distanceMm,
    y: point.y + axis[1] * distanceMm,
    z: point.z + axis[2] * distanceMm,
  };
}

function clamp(
  value: number,
  minimum: number,
  maximum: number,
): number {
  return Math.min(
    maximum,
    Math.max(minimum, value),
  );
}


// ============================================================
// 04 — ANATOMICAL PLANE AXES
// ============================================================

/**
 * Axis mapping is deliberately consistent with
 * makePatientAlignedMPRPlane() in volumeSampling.ts.
 *
 * Axial:
 *   U = +L, V = +P, normal = +S
 *
 * Coronal:
 *   U = +L, V = +S, normal = -P
 *
 * Sagittal:
 *   U = +P, V = +S, normal = +L
 *
 * Coronal normal is -P because U cross V = -P.
 * Anatomical slice steps use these signed normals.
 */
export function getMPRPlaneAxes(
  plane: PreviewPlane,
): MPRPlaneAxes {
  switch (plane) {
    case "axial":
      return {
        u: [1, 0, 0],
        v: [0, 1, 0],
        normal: [0, 0, 1],
      };

    case "coronal":
      return {
        u: [1, 0, 0],
        v: [0, 0, 1],
        normal: [0, -1, 0],
      };

    case "sagittal":
      return {
        u: [0, 1, 0],
        v: [0, 0, 1],
        normal: [1, 0, 0],
      };

    default:
      throw new MPRError("Unsupported MPR plane.");
  }
}


// ============================================================
// 05 — VIEWPORT VALIDATION
// ============================================================

export function validateMPRViewportSize(
  size: MPRViewportSize,
): void {
  if (
    !size ||
    !validDimension(size.width) ||
    !validDimension(size.height) ||
    size.width * size.height >
      MAX_MPR_VIEWPORT_PIXELS
  ) {
    throw new MPRError(
      "Invalid or oversized MPR viewport.",
    );
  }
}

export function validateMPRViewport(
  state: MPRViewportState,
): void {
  if (!state) {
    throw new MPRError();
  }

  getMPRPlaneAxes(state.plane);
  validateMPRViewportSize(state.size);
  assertWorldPoint(state.centerLPS);

  if (
    !positive(state.baseMmPerPixel) ||
    !positive(state.zoom) ||
    state.zoom < MIN_MPR_ZOOM ||
    state.zoom > MAX_MPR_ZOOM
  ) {
    throw new MPRError(
      "Invalid MPR scale or zoom.",
    );
  }

  const effective = (
    state.baseMmPerPixel / state.zoom
  );

  if (!positive(effective)) {
    throw new MPRError(
      "Invalid MPR effective pixel spacing.",
    );
  }
}


// ============================================================
// 06 — WORLD-SPACE VOLUME CORNERS
// ============================================================

/**
 * Bounding positions refer to voxel centres.
 * We inspect all eight corners because datasets may
 * have an oblique direction matrix.
 */
export function getMPRVolumeCorners(
  geometry: VolumeGeometry,
): readonly WorldPointLPS[] {
  assertVolumeGeometry(geometry);

  const [depth, height, width] =
    geometry.shape_zyx;

  const result: WorldPointLPS[] = [];

  for (const z of [0, depth - 1]) {
    for (const y of [0, height - 1]) {
      for (const x of [0, width - 1]) {
        result.push(
          voxelToWorldLPS(
            geometry,
            { x, y, z },
          ),
        );
      }
    }
  }

  return result;
}


// ============================================================
// 07 — PROJECTED ANATOMICAL EXTENTS
// ============================================================

export interface MPRProjectedBounds {
  readonly minimumU: number;
  readonly maximumU: number;
  readonly minimumV: number;
  readonly maximumV: number;
  readonly minimumNormal: number;
  readonly maximumNormal: number;
}

export function getMPRProjectedBounds(
  geometry: VolumeGeometry,
  plane: PreviewPlane,
): MPRProjectedBounds {
  const axes = getMPRPlaneAxes(plane);
  const corners = getMPRVolumeCorners(geometry);

  let minimumU = Infinity;
  let maximumU = -Infinity;
  let minimumV = Infinity;
  let maximumV = -Infinity;
  let minimumNormal = Infinity;
  let maximumNormal = -Infinity;

  for (const point of corners) {
    const world: Vec3 = [
      point.x,
      point.y,
      point.z,
    ];

    const u = dot(world, axes.u);
    const v = dot(world, axes.v);
    const normal = dot(world, axes.normal);

    minimumU = Math.min(minimumU, u);
    maximumU = Math.max(maximumU, u);

    minimumV = Math.min(minimumV, v);
    maximumV = Math.max(maximumV, v);

    minimumNormal = Math.min(
      minimumNormal,
      normal,
    );

    maximumNormal = Math.max(
      maximumNormal,
      normal,
    );
  }

  return {
    minimumU,
    maximumU,
    minimumV,
    maximumV,
    minimumNormal,
    maximumNormal,
  };
}


// ============================================================
// 08 — FIT-TO-VOLUME SCALE
// ============================================================

/**
 * Returns physical millimetres per display pixel.
 * The entire projected voxel-centre bounding box
 * fits inside the viewport, with configurable padding.
 *
 * Degenerate single-slice dimensions get a fallback
 * physical extent from minimum source spacing.
 */
export function computeMPRFitScale(
  geometry: VolumeGeometry,
  plane: PreviewPlane,
  size: MPRViewportSize,
  options: MPRFitOptions = {},
): number {
  assertVolumeGeometry(geometry);
  validateMPRViewportSize(size);

  const padding = options.padding ??
    DEFAULT_MPR_FIT_PADDING;

  const minimumMmPerPixel =
    options.minimumMmPerPixel ??
    Math.min(...geometry.spacing_xyz_mm) / 8;

  if (
    !finite(padding) ||
    padding <= 0 ||
    padding > 1 ||
    !positive(minimumMmPerPixel)
  ) {
    throw new MPRError(
      "Invalid MPR fit configuration.",
    );
  }

  const bounds = getMPRProjectedBounds(
    geometry,
    plane,
  );

  const fallbackExtent =
    Math.min(...geometry.spacing_xyz_mm);

  const extentU = Math.max(
    bounds.maximumU - bounds.minimumU,
    fallbackExtent,
  );

  const extentV = Math.max(
    bounds.maximumV - bounds.minimumV,
    fallbackExtent,
  );

  const availableWidth = Math.max(
    1,
    (size.width - 1) * padding,
  );

  const availableHeight = Math.max(
    1,
    (size.height - 1) * padding,
  );

  const scale = Math.max(
    extentU / availableWidth,
    extentV / availableHeight,
    minimumMmPerPixel,
  );

  if (!positive(scale)) {
    throw new MPRError(
      "Unable to fit MPR volume.",
    );
  }

  return scale;
}


// ============================================================
// 09 — VOLUME WORLD CENTRE
// ============================================================

export function getMPRVolumeCenter(
  geometry: VolumeGeometry,
): WorldPointLPS {
  assertVolumeGeometry(geometry);

  const [depth, height, width] =
    geometry.shape_zyx;

  const voxel: VoxelPoint = {
    x: (width - 1) / 2,
    y: (height - 1) / 2,
    z: (depth - 1) / 2,
  };

  return voxelToWorldLPS(
    geometry,
    voxel,
  );
}


// ============================================================
// 10 — CREATE / RESET VIEWPORT
// ============================================================

export function createMPRViewport(
  geometry: VolumeGeometry,
  plane: PreviewPlane,
  size: MPRViewportSize,
  options: MPRFitOptions = {},
): MPRViewportState {
  const state: MPRViewportState = {
    plane,
    size,
    centerLPS: getMPRVolumeCenter(geometry),
    baseMmPerPixel: computeMPRFitScale(
      geometry,
      plane,
      size,
      options,
    ),
    zoom: DEFAULT_MPR_ZOOM,
  };

  validateMPRViewport(state);
  return state;
}

export function resetMPRViewport(
  geometry: VolumeGeometry,
  state: MPRViewportState,
): MPRViewportState {
  validateMPRViewport(state);

  return createMPRViewport(
    geometry,
    state.plane,
    state.size,
  );
}


// ============================================================
// 11 — EFFECTIVE DISPLAY SPACING
// ============================================================

export function getMPRMmPerPixel(
  state: MPRViewportState,
): number {
  validateMPRViewport(state);

  return state.baseMmPerPixel / state.zoom;
}


// ============================================================
// 12 — SCREEN TO WORLD
// ============================================================

/**
 * Pixel origin is top-left.
 * For odd viewport sizes, the centre lands on a pixel.
 * For even viewport sizes, the centre is between pixels.
 *
 * The returned world coordinate lies on the current
 * MPR plane, with no image-bound clamping.
 */
export function mprScreenToWorldLPS(
  state: MPRViewportState,
  screen: MPRScreenPoint,
): WorldPointLPS {
  validateMPRViewport(state);
  assertScreenPoint(screen);

  const axes = getMPRPlaneAxes(state.plane);
  const mmPerPixel = getMPRMmPerPixel(state);

  const centerX = (state.size.width - 1) / 2;
  const centerY = (state.size.height - 1) / 2;

  const du = (screen.x - centerX) * mmPerPixel;
  const dv = (screen.y - centerY) * mmPerPixel;

  const movedU = translate(
    state.centerLPS,
    axes.u,
    du,
  );

  return translate(movedU, axes.v, dv);
}


// ============================================================
// 13 — WORLD TO SCREEN
// ============================================================

export function mprWorldToScreen(
  state: MPRViewportState,
  world: WorldPointLPS,
): MPRScreenPoint {
  validateMPRViewport(state);
  assertWorldPoint(world);

  const axes = getMPRPlaneAxes(state.plane);
  const delta = subtract(world, state.centerLPS);
  const mmPerPixel = getMPRMmPerPixel(state);

  return {
    x: (state.size.width - 1) / 2 +
      dot(delta, axes.u) / mmPerPixel,

    y: (state.size.height - 1) / 2 +
      dot(delta, axes.v) / mmPerPixel,
  };
}


// ============================================================
// 14 — PAN THE VIEW
// ============================================================

/**
 * Dragging the image towards positive screen X
 * moves the displayed anatomy rightward.
 *
 * Therefore the world-space viewport centre shifts
 * in the opposite direction.
 */
export function panMPRViewport(
  state: MPRViewportState,
  deltaScreenX: number,
  deltaScreenY: number,
): MPRViewportState {
  validateMPRViewport(state);

  if (
    !finite(deltaScreenX) ||
    !finite(deltaScreenY)
  ) {
    throw new MPRError(
      "Invalid MPR pan distance.",
    );
  }

  const axes = getMPRPlaneAxes(state.plane);
  const spacing = getMPRMmPerPixel(state);

  const movedU = translate(
    state.centerLPS,
    axes.u,
    -deltaScreenX * spacing,
  );

  const centerLPS = translate(
    movedU,
    axes.v,
    -deltaScreenY * spacing,
  );

  const next: MPRViewportState = {
    ...state,
    centerLPS,
  };

  validateMPRViewport(next);
  return next;
}


// ============================================================
// 15 — ZOOM AROUND AN ANCHOR
// ============================================================

/**
 * Preserve the DICOM world position beneath the
 * zoom anchor (usually the pointer).
 */
export function zoomMPRViewport(
  state: MPRViewportState,
  scaleFactor: number,
  anchor?: MPRScreenPoint,
): MPRViewportState {
  validateMPRViewport(state);

  if (
    !positive(scaleFactor)
  ) {
    throw new MPRError(
      "Invalid MPR zoom factor.",
    );
  }

  const actualAnchor = anchor ?? {
    x: (state.size.width - 1) / 2,
    y: (state.size.height - 1) / 2,
  };

  assertScreenPoint(actualAnchor);

  const worldBefore = mprScreenToWorldLPS(
    state,
    actualAnchor,
  );

  const desiredZoom = state.zoom * scaleFactor;

  const zoom = clamp(
    desiredZoom,
    MIN_MPR_ZOOM,
    MAX_MPR_ZOOM,
  );

  const axes = getMPRPlaneAxes(state.plane);
  const nextMmPerPixel =
    state.baseMmPerPixel / zoom;

  const du = (
    actualAnchor.x -
    (state.size.width - 1) / 2
  ) * nextMmPerPixel;

  const dv = (
    actualAnchor.y -
    (state.size.height - 1) / 2
  ) * nextMmPerPixel;

  const shifted = translate(
    worldBefore,
    axes.u,
    -du,
  );

  const centerLPS = translate(
    shifted,
    axes.v,
    -dv,
  );

  const next: MPRViewportState = {
    ...state,
    zoom,
    centerLPS,
  };

  validateMPRViewport(next);
  return next;
}


// ============================================================
// 16 — RESIZE VIEWPORT
// ============================================================

/**
 * Preserve the physical scale and world centre
 * when the viewport dimensions change.
 */
export function resizeMPRViewport(
  state: MPRViewportState,
  size: MPRViewportSize,
): MPRViewportState {
  validateMPRViewport(state);
  validateMPRViewportSize(size);

  const next: MPRViewportState = {
    ...state,
    size,
  };

  validateMPRViewport(next);
  return next;
}


// ============================================================
// 17 — ANATOMICAL SLICE NAVIGATION
// ============================================================

/**
 * Slice navigation is measured in physical millimetres,
 * along the plane's signed normal.
 */
export function moveMPRSliceMm(
  state: MPRViewportState,
  distanceMm: number,
): MPRViewportState {
  validateMPRViewport(state);

  if (!finite(distanceMm)) {
    throw new MPRError(
      "Invalid slice movement.",
    );
  }

  const normal = getMPRPlaneAxes(
    state.plane,
  ).normal;

  const next: MPRViewportState = {
    ...state,
    centerLPS: translate(
      state.centerLPS,
      normal,
      distanceMm,
    ),
  };

  validateMPRViewport(next);
  return next;
}


// ============================================================
// 18 — ANATOMICAL SLICE STEP ESTIMATION
// ============================================================

/**
 * Estimate source-grid sampling spacing in the
 * anatomical plane-normal direction.
 *
 * For a rotated affine volume, the physical step
 * along a patient axis is determined by the inverse
 * voxel-to-world affine mapping.
 *
 * This is a navigation increment, not a statement
 * that the acquisition contains slices at that step.
 */
export function getMPRSliceStepMm(
  geometry: VolumeGeometry,
  plane: PreviewPlane,
): number {
  assertVolumeGeometry(geometry);

  const normal = getMPRPlaneAxes(plane).normal;
  const direction = geometry.direction_lps;
  const spacing = geometry.spacing_xyz_mm;

  // Direction is orthonormal, so its inverse is its
  // transpose for this step-length calculation.
  const rx = (
    direction[0] * normal[0] +
    direction[3] * normal[1] +
    direction[6] * normal[2]
  ) / spacing[0];

  const ry = (
    direction[1] * normal[0] +
    direction[4] * normal[1] +
    direction[7] * normal[2]
  ) / spacing[1];

  const rz = (
    direction[2] * normal[0] +
    direction[5] * normal[1] +
    direction[8] * normal[2]
  ) / spacing[2];

  const voxelDisplacementPerMm = Math.hypot(
    rx,
    ry,
    rz,
  );

  if (
    !positive(voxelDisplacementPerMm) ||
    voxelDisplacementPerMm < FLOAT_TOLERANCE
  ) {
    throw new MPRError(
      "Unable to estimate MPR slice step.",
    );
  }

  return 1 / voxelDisplacementPerMm;
}

export function stepMPRSlice(
  geometry: VolumeGeometry,
  state: MPRViewportState,
  steps: number,
): MPRViewportState {
  if (
    !Number.isSafeInteger(steps)
  ) {
    throw new MPRError(
      "Slice step count must be an integer.",
    );
  }

  return moveMPRSliceMm(
    state,
    steps * getMPRSliceStepMm(
      geometry,
      state.plane,
    ),
  );
}


// ============================================================
// 19 — CROSSHAIR PROJECTION
// ============================================================

/**
 * Crosshair is visible only if:
 * - projected pixel lies within the viewport, and
 * - its world point is sufficiently close to the
 *   current anatomical slice plane.
 *
 * The plane-distance tolerance is caller-controlled.
 */
export function projectMPRCrosshair(
  state: MPRViewportState,
  crosshairWorld: WorldPointLPS,
  planeToleranceMm = 0.5,
): MPRCrosshairProjection {
  validateMPRViewport(state);
  assertWorldPoint(crosshairWorld);

  if (
    !finite(planeToleranceMm) ||
    planeToleranceMm < 0
  ) {
    throw new MPRError(
      "Invalid crosshair tolerance.",
    );
  }

  const axes = getMPRPlaneAxes(state.plane);

  const difference = subtract(
    crosshairWorld,
    state.centerLPS,
  );

  const screen = mprWorldToScreen(
    state,
    crosshairWorld,
  );

  const planeDistanceMm = dot(
    difference,
    axes.normal,
  );

  const insideViewport = (
    screen.x >= 0 &&
    screen.y >= 0 &&
    screen.x <= state.size.width - 1 &&
    screen.y <= state.size.height - 1
  );

  return {
    screen,
    visible:
      insideViewport &&
      Math.abs(planeDistanceMm) <=
        planeToleranceMm,
    planeDistanceMm,
  };
}


// ============================================================
// 20 — MOVE VIEW TO CROSSHAIR
// ============================================================

/**
 * Synchronize the slice coordinate to a crosshair,
 * retaining current in-plane pan and zoom.
 *
 * To centre the crosshair fully, use centreMPRAtWorld().
 */
export function alignMPRSliceToWorld(
  state: MPRViewportState,
  crosshairWorld: WorldPointLPS,
): MPRViewportState {
  validateMPRViewport(state);
  assertWorldPoint(crosshairWorld);

  const normal = getMPRPlaneAxes(
    state.plane,
  ).normal;

  const distanceMm = dot(
    subtract(
      crosshairWorld,
      state.centerLPS,
    ),
    normal,
  );

  return moveMPRSliceMm(
    state,
    distanceMm,
  );
}

export function centreMPRAtWorld(
  state: MPRViewportState,
  world: WorldPointLPS,
): MPRViewportState {
  validateMPRViewport(state);
  assertWorldPoint(world);

  const next: MPRViewportState = {
    ...state,
    centerLPS: { ...world },
  };

  validateMPRViewport(next);
  return next;
}


// ============================================================
// 21 — CONSTRUCT RESAMPLING PLANE
// ============================================================

/**
 * Creates the exact plane passed to
 * sampleMPRPlane() in volumeSampling.ts.
 *
 * Every output pixel represents the same physical
 * position as mprScreenToWorldLPS().
 */
export function buildMPRSamplingPlane(
  state: MPRViewportState,
): MPRPlane {
  validateMPRViewport(state);

  const mmPerPixel = getMPRMmPerPixel(state);

  return makePatientAlignedMPRPlane(
    state.plane,
    state.centerLPS,
    state.size.width,
    state.size.height,
    mmPerPixel,
    mmPerPixel,
  );
}


// ============================================================
// 22 — VIEWPORT GEOMETRY CAPABILITIES
// ============================================================

export function getMPRCapabilities() {
  return {
    coordinateSystem: "LPS",
    patientAlignedResampling: true,
    obliqueVolumeSupport: true,
    zoomAroundAnchor: true,
    physicalMillimetrePan: true,
    sliceNavigation: true,
    crosshairProjection: true,
    modifiesSourceVolume: false,
    diagnosticValidationComplete: false,
  } as const;
}


// ============================================================
// END OF SINUS VIEWER MPR VIEWPORT UTILITIES
// ============================================================
