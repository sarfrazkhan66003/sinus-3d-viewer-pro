
/**
 * SINUS VIEWER — VOLUME SAMPLING UTILITIES
 * ========================================
 *
 * Pure TypeScript utilities for:
 * - Nearest-neighbor sampling.
 * - Trilinear interpolation.
 * - Fractional voxel coordinates.
 * - DICOM LPS world-coordinate sampling.
 * - True patient-aligned MPR sampling grids.
 * - Out-of-bounds fill or clamp behavior.
 * - Non-finite intensity handling.
 * - Bounded image-buffer allocation.
 *
 * ARRAY CONTRACT
 * --------------
 * shapeZYX = [depth, height, width]
 *
 * Linear index:
 *   z * height * width + y * width + x
 *
 * Coordinate contract:
 *   voxel = [x, y, z]
 *   world = DICOM LPS millimetres
 *
 * This code samples the already decoded float32 volume.
 * No original DICOM files are accessed or modified.
 *
 * Rendering and diagnostic validation remain separate.
 */

import {
  assertVolumeGeometry,
  invertMat3,
  type Mat3,
  type Vec3,
  type VoxelPoint,
  type WorldPointLPS,
} from "./geometry";

import type {
  PreviewPlane,
  Shape3,
  VolumeGeometry,
} from "../types/api";


// ============================================================
// 01 — CONSTANTS
// ============================================================

export const DEFAULT_OUTSIDE_VALUE = 0;

export const MAX_SAMPLING_IMAGE_WIDTH = 2048;

export const MAX_SAMPLING_IMAGE_HEIGHT = 2048;

export const MAX_SAMPLING_PIXELS = 4 * 1024 * 1024;

const AXIS_TOLERANCE = 1e-4;


// ============================================================
// 02 — PUBLIC TYPES
// ============================================================

export type InterpolationMode =
  | "nearest"
  | "linear";

export type BoundaryMode =
  | "fill"
  | "clamp";

export interface SamplingOptions {
  readonly interpolation?: InterpolationMode;
  readonly boundary?: BoundaryMode;
  readonly outsideValue?: number;
}

export interface SamplingVolume {
  readonly voxels: Float32Array;
  readonly shapeZYX: Shape3;
  readonly geometry: VolumeGeometry;
}

export interface MPRPlane {
  readonly originLPS: WorldPointLPS;
  readonly uDirectionLPS: Vec3;
  readonly vDirectionLPS: Vec3;
  readonly pixelSpacingUMm: number;
  readonly pixelSpacingVMm: number;
  readonly width: number;
  readonly height: number;
}

export interface SampledMPRImage {
  readonly width: number;
  readonly height: number;
  readonly intensities: Float32Array;
  readonly plane: MPRPlane;
}

export interface VolumeSampler {
  readonly volume: SamplingVolume;

  sampleVoxel(
    x: number,
    y: number,
    z: number,
    options?: SamplingOptions,
  ): number;

  sampleWorld(
    point: WorldPointLPS,
    options?: SamplingOptions,
  ): number;

  samplePlane(
    plane: MPRPlane,
    options?: SamplingOptions,
  ): SampledMPRImage;
}

export class VolumeSamplingError extends Error {
  constructor(
    message = "Invalid volume sampling request.",
  ) {
    super(message);
    this.name = "VolumeSamplingError";
  }
}


// ============================================================
// 03 — NUMERIC VALIDATION
// ============================================================

function finite(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value)
  );
}

function positiveSafeInteger(
  value: unknown,
): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0
  );
}

function finiteVec3(
  value: unknown,
): value is Vec3 {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    value.every(finite)
  );
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

function vectorLength(vector: Vec3): number {
  return Math.hypot(
    vector[0],
    vector[1],
    vector[2],
  );
}

function vectorDot(a: Vec3, b: Vec3): number {
  return (
    a[0] * b[0] +
    a[1] * b[1] +
    a[2] * b[2]
  );
}

function validateOptions(
  options: SamplingOptions,
): Required<SamplingOptions> {
  const interpolation =
    options.interpolation ?? "linear";

  const boundary =
    options.boundary ?? "fill";

  const outsideValue =
    options.outsideValue ?? DEFAULT_OUTSIDE_VALUE;

  if (
    (interpolation !== "nearest" &&
      interpolation !== "linear") ||
    (boundary !== "fill" &&
      boundary !== "clamp") ||
    !finite(outsideValue)
  ) {
    throw new VolumeSamplingError(
      "Invalid interpolation or boundary settings.",
    );
  }

  return {
    interpolation,
    boundary,
    outsideValue,
  };
}


// ============================================================
// 04 — VOLUME VALIDATION
// ============================================================

export function validateSamplingVolume(
  volume: SamplingVolume,
): void {
  if (
    !volume ||
    !(volume.voxels instanceof Float32Array) ||
    !Array.isArray(volume.shapeZYX) ||
    volume.shapeZYX.length !== 3 ||
    !volume.shapeZYX.every(positiveSafeInteger)
  ) {
    throw new VolumeSamplingError(
      "Invalid volume buffer or dimensions.",
    );
  }

  assertVolumeGeometry(volume.geometry);

  const [depth, height, width] = volume.shapeZYX;

  const count = depth * height * width;

  if (
    !Number.isSafeInteger(count) ||
    count !== volume.voxels.length
  ) {
    throw new VolumeSamplingError(
      "Volume dimensions do not match voxel data.",
    );
  }

  const geometryShape = volume.geometry.shape_zyx;

  if (
    geometryShape[0] !== depth ||
    geometryShape[1] !== height ||
    geometryShape[2] !== width
  ) {
    throw new VolumeSamplingError(
      "Volume geometry dimensions do not match.",
    );
  }
}


// ============================================================
// 05 — BOUNDARY COORDINATES
// ============================================================

function resolveCoordinates(
  shape: Shape3,
  x: number,
  y: number,
  z: number,
  boundary: BoundaryMode,
): VoxelPoint | null {
  if (
    !finite(x) ||
    !finite(y) ||
    !finite(z)
  ) {
    return null;
  }

  const [depth, height, width] = shape;

  if (boundary === "clamp") {
    return {
      x: clamp(x, 0, width - 1),
      y: clamp(y, 0, height - 1),
      z: clamp(z, 0, depth - 1),
    };
  }

  if (
    x < 0 ||
    y < 0 ||
    z < 0 ||
    x > width - 1 ||
    y > height - 1 ||
    z > depth - 1
  ) {
    return null;
  }

  return { x, y, z };
}


// ============================================================
// 06 — VOXEL ARRAY ACCESS
// ============================================================

function voxelValue(
  volume: SamplingVolume,
  x: number,
  y: number,
  z: number,
): number {
  const [, height, width] = volume.shapeZYX;

  return volume.voxels[
    (z * height + y) * width + x
  ];
}


// ============================================================
// 07 — NEAREST-NEIGHBOR SAMPLING
// ============================================================

function sampleNearestUnchecked(
  volume: SamplingVolume,
  x: number,
  y: number,
  z: number,
  options: Required<SamplingOptions>,
): number {
  const point = resolveCoordinates(
    volume.shapeZYX,
    x,
    y,
    z,
    options.boundary,
  );

  if (!point) {
    return options.outsideValue;
  }

  const [depth, height, width] =
    volume.shapeZYX;

  const ix = clamp(
    Math.round(point.x),
    0,
    width - 1,
  );

  const iy = clamp(
    Math.round(point.y),
    0,
    height - 1,
  );

  const iz = clamp(
    Math.round(point.z),
    0,
    depth - 1,
  );

  const value = voxelValue(
    volume,
    ix,
    iy,
    iz,
  );

  return finite(value)
    ? value
    : options.outsideValue;
}

export function sampleNearest(
  volume: SamplingVolume,
  x: number,
  y: number,
  z: number,
  options: SamplingOptions = {},
): number {
  validateSamplingVolume(volume);

  return sampleNearestUnchecked(
    volume,
    x,
    y,
    z,
    validateOptions(options),
  );
}


// ============================================================
// 08 — TRILINEAR INTERPOLATION
// ============================================================

function sampleTrilinearUnchecked(
  volume: SamplingVolume,
  x: number,
  y: number,
  z: number,
  options: Required<SamplingOptions>,
): number {
  const point = resolveCoordinates(
    volume.shapeZYX,
    x,
    y,
    z,
    options.boundary,
  );

  if (!point) {
    return options.outsideValue;
  }

  const [depth, height, width] =
    volume.shapeZYX;

  const x0 = Math.floor(point.x);
  const y0 = Math.floor(point.y);
  const z0 = Math.floor(point.z);

  const x1 = Math.min(x0 + 1, width - 1);
  const y1 = Math.min(y0 + 1, height - 1);
  const z1 = Math.min(z0 + 1, depth - 1);

  const fx = point.x - x0;
  const fy = point.y - y0;
  const fz = point.z - z0;

  const wx = [1 - fx, fx];
  const wy = [1 - fy, fy];
  const wz = [1 - fz, fz];

  const xs = [x0, x1];
  const ys = [y0, y1];
  const zs = [z0, z1];

  let result = 0;

  for (let iz = 0; iz < 2; iz++) {
    for (let iy = 0; iy < 2; iy++) {
      for (let ix = 0; ix < 2; ix++) {
        const weight =
          wx[ix] * wy[iy] * wz[iz];

        // A zero-weight neighbor must not contaminate
        // an exact voxel-center sample with NaN.
        if (weight === 0) {
          continue;
        }

        const value = voxelValue(
          volume,
          xs[ix],
          ys[iy],
          zs[iz],
        );

        if (!finite(value)) {
          return options.outsideValue;
        }

        result += weight * value;
      }
    }
  }

  return finite(result)
    ? result
    : options.outsideValue;
}

export function sampleTrilinear(
  volume: SamplingVolume,
  x: number,
  y: number,
  z: number,
  options: SamplingOptions = {},
): number {
  validateSamplingVolume(volume);

  return sampleTrilinearUnchecked(
    volume,
    x,
    y,
    z,
    validateOptions(options),
  );
}


// ============================================================
// 09 — GENERIC VOXEL SAMPLING
// ============================================================

function samplePreparedVoxel(
  volume: SamplingVolume,
  x: number,
  y: number,
  z: number,
  options: Required<SamplingOptions>,
): number {
  if (options.interpolation === "nearest") {
    return sampleNearestUnchecked(
      volume,
      x,
      y,
      z,
      options,
    );
  }

  return sampleTrilinearUnchecked(
    volume,
    x,
    y,
    z,
    options,
  );
}

export function sampleVoxel(
  volume: SamplingVolume,
  point: VoxelPoint,
  options: SamplingOptions = {},
): number {
  validateSamplingVolume(volume);

  return samplePreparedVoxel(
    volume,
    point.x,
    point.y,
    point.z,
    validateOptions(options),
  );
}


// ============================================================
// 10 — CACHED LPS TO VOXEL TRANSFORM
// ============================================================

interface WorldTransform {
  readonly origin: Vec3;
  readonly inverseDirection: Mat3;
  readonly spacing: Vec3;
}

function prepareWorldTransform(
  geometry: VolumeGeometry,
): WorldTransform {
  assertVolumeGeometry(geometry);

  return {
    origin: geometry.origin_lps,
    inverseDirection: invertMat3(
      geometry.direction_lps,
    ),
    spacing: geometry.spacing_xyz_mm,
  };
}

function worldToVoxelPrepared(
  transform: WorldTransform,
  world: WorldPointLPS,
): VoxelPoint {
  if (
    !finite(world.x) ||
    !finite(world.y) ||
    !finite(world.z)
  ) {
    throw new VolumeSamplingError(
      "Invalid world coordinate.",
    );
  }

  const dx = world.x - transform.origin[0];
  const dy = world.y - transform.origin[1];
  const dz = world.z - transform.origin[2];

  const m = transform.inverseDirection;
  const spacing = transform.spacing;

  return {
    x: (
      m[0] * dx +
      m[1] * dy +
      m[2] * dz
    ) / spacing[0],

    y: (
      m[3] * dx +
      m[4] * dy +
      m[5] * dz
    ) / spacing[1],

    z: (
      m[6] * dx +
      m[7] * dy +
      m[8] * dz
    ) / spacing[2],
  };
}


// ============================================================
// 11 — WORLD-COORDINATE SAMPLING
// ============================================================

export function sampleWorldLPS(
  volume: SamplingVolume,
  world: WorldPointLPS,
  options: SamplingOptions = {},
): number {
  validateSamplingVolume(volume);

  const transform = prepareWorldTransform(
    volume.geometry,
  );

  const voxel = worldToVoxelPrepared(
    transform,
    world,
  );

  return samplePreparedVoxel(
    volume,
    voxel.x,
    voxel.y,
    voxel.z,
    validateOptions(options),
  );
}


// ============================================================
// 12 — MPR PLANE VALIDATION
// ============================================================

export function validateMPRPlane(
  plane: MPRPlane,
): void {
  if (
    !plane ||
    !finiteVec3(plane.uDirectionLPS) ||
    !finiteVec3(plane.vDirectionLPS) ||
    !plane.originLPS ||
    !finite(plane.originLPS.x) ||
    !finite(plane.originLPS.y) ||
    !finite(plane.originLPS.z) ||
    !positiveSafeInteger(plane.width) ||
    !positiveSafeInteger(plane.height) ||
    plane.width > MAX_SAMPLING_IMAGE_WIDTH ||
    plane.height > MAX_SAMPLING_IMAGE_HEIGHT ||
    plane.width * plane.height > MAX_SAMPLING_PIXELS ||
    !finite(plane.pixelSpacingUMm) ||
    !finite(plane.pixelSpacingVMm) ||
    plane.pixelSpacingUMm <= 0 ||
    plane.pixelSpacingVMm <= 0
  ) {
    throw new VolumeSamplingError(
      "Invalid MPR plane dimensions or geometry.",
    );
  }

  const uLength = vectorLength(
    plane.uDirectionLPS,
  );

  const vLength = vectorLength(
    plane.vDirectionLPS,
  );

  const dot = vectorDot(
    plane.uDirectionLPS,
    plane.vDirectionLPS,
  );

  if (
    Math.abs(uLength - 1) > AXIS_TOLERANCE ||
    Math.abs(vLength - 1) > AXIS_TOLERANCE ||
    Math.abs(dot) > AXIS_TOLERANCE
  ) {
    throw new VolumeSamplingError(
      "MPR plane axes must be orthonormal.",
    );
  }
}


// ============================================================
// 13 — PATIENT-ALIGNED MPR PLANES
// ============================================================

/**
 * Patient-aligned LPS plane axes.
 *
 * These are mathematical sampling directions.
 * Radiological / neurological screen flips are
 * presentation concerns and handled separately.
 *
 * axial:    LPS X / Y
 * coronal:  LPS X / Z
 * sagittal: LPS Y / Z
 */
function anatomicalAxes(
  plane: PreviewPlane,
): {
  u: Vec3;
  v: Vec3;
} {
  switch (plane) {
    case "axial":
      return {
        u: [1, 0, 0],
        v: [0, 1, 0],
      };

    case "coronal":
      return {
        u: [1, 0, 0],
        v: [0, 0, 1],
      };

    case "sagittal":
      return {
        u: [0, 1, 0],
        v: [0, 0, 1],
      };
  }
}

export function makePatientAlignedMPRPlane(
  plane: PreviewPlane,
  centerLPS: WorldPointLPS,
  width: number,
  height: number,
  pixelSpacingUMm: number,
  pixelSpacingVMm: number,
): MPRPlane {
  const axes = anatomicalAxes(plane);

  const halfU =
    (width - 1) * pixelSpacingUMm / 2;

  const halfV =
    (height - 1) * pixelSpacingVMm / 2;

  const result: MPRPlane = {
    originLPS: {
      x: centerLPS.x -
        axes.u[0] * halfU -
        axes.v[0] * halfV,

      y: centerLPS.y -
        axes.u[1] * halfU -
        axes.v[1] * halfV,

      z: centerLPS.z -
        axes.u[2] * halfU -
        axes.v[2] * halfV,
    },

    uDirectionLPS: axes.u,
    vDirectionLPS: axes.v,

    pixelSpacingUMm,
    pixelSpacingVMm,

    width,
    height,
  };

  validateMPRPlane(result);
  return result;
}


// ============================================================
// 14 — MPR PIXEL TO WORLD POSITION
// ============================================================

export function mprPixelToWorldLPS(
  plane: MPRPlane,
  u: number,
  v: number,
): WorldPointLPS {
  validateMPRPlane(plane);

  if (!finite(u) || !finite(v)) {
    throw new VolumeSamplingError(
      "Invalid MPR pixel coordinates.",
    );
  }

  const du = u * plane.pixelSpacingUMm;
  const dv = v * plane.pixelSpacingVMm;

  return {
    x: plane.originLPS.x +
      plane.uDirectionLPS[0] * du +
      plane.vDirectionLPS[0] * dv,

    y: plane.originLPS.y +
      plane.uDirectionLPS[1] * du +
      plane.vDirectionLPS[1] * dv,

    z: plane.originLPS.z +
      plane.uDirectionLPS[2] * du +
      plane.vDirectionLPS[2] * dv,
  };
}


// ============================================================
// 15 — TRUE WORLD-SPACE MPR SAMPLING
// ============================================================

function sampleMPRPrepared(
  volume: SamplingVolume,
  transform: WorldTransform,
  plane: MPRPlane,
  options: Required<SamplingOptions>,
): SampledMPRImage {
  validateMPRPlane(plane);

  const intensities = new Float32Array(
    plane.width * plane.height,
  );

  const origin = plane.originLPS;

  const ux =
    plane.uDirectionLPS[0] *
    plane.pixelSpacingUMm;

  const uy =
    plane.uDirectionLPS[1] *
    plane.pixelSpacingUMm;

  const uz =
    plane.uDirectionLPS[2] *
    plane.pixelSpacingUMm;

  const vx =
    plane.vDirectionLPS[0] *
    plane.pixelSpacingVMm;

  const vy =
    plane.vDirectionLPS[1] *
    plane.pixelSpacingVMm;

  const vz =
    plane.vDirectionLPS[2] *
    plane.pixelSpacingVMm;

  let index = 0;

  for (let row = 0; row < plane.height; row++) {
    for (let col = 0; col < plane.width; col++) {
      const world: WorldPointLPS = {
        x: origin.x + col * ux + row * vx,
        y: origin.y + col * uy + row * vy,
        z: origin.z + col * uz + row * vz,
      };

      const voxel = worldToVoxelPrepared(
        transform,
        world,
      );

      intensities[index++] = samplePreparedVoxel(
        volume,
        voxel.x,
        voxel.y,
        voxel.z,
        options,
      );
    }
  }

  return {
    width: plane.width,
    height: plane.height,
    intensities,
    plane,
  };
}

export function sampleMPRPlane(
  volume: SamplingVolume,
  plane: MPRPlane,
  options: SamplingOptions = {},
): SampledMPRImage {
  validateSamplingVolume(volume);

  const transform = prepareWorldTransform(
    volume.geometry,
  );

  return sampleMPRPrepared(
    volume,
    transform,
    plane,
    validateOptions(options),
  );
}


// ============================================================
// 16 — PREPARED VOLUME SAMPLER
// ============================================================

/**
 * Reuse the validated geometry and inverse direction
 * matrix across many sampling requests.
 *
 * The caller must treat the input voxel buffer and
 * geometry as immutable while the sampler is active.
 */
export function createVolumeSampler(
  volume: SamplingVolume,
): VolumeSampler {
  validateSamplingVolume(volume);

  const transform = prepareWorldTransform(
    volume.geometry,
  );

  return {
    volume,

    sampleVoxel(
      x: number,
      y: number,
      z: number,
      options: SamplingOptions = {},
    ): number {
      return samplePreparedVoxel(
        volume,
        x,
        y,
        z,
        validateOptions(options),
      );
    },

    sampleWorld(
      world: WorldPointLPS,
      options: SamplingOptions = {},
    ): number {
      const voxel = worldToVoxelPrepared(
        transform,
        world,
      );

      return samplePreparedVoxel(
        volume,
        voxel.x,
        voxel.y,
        voxel.z,
        validateOptions(options),
      );
    },

    samplePlane(
      plane: MPRPlane,
      options: SamplingOptions = {},
    ): SampledMPRImage {
      return sampleMPRPrepared(
        volume,
        transform,
        plane,
        validateOptions(options),
      );
    },
  };
}


// ============================================================
// END OF SINUS VIEWER VOLUME SAMPLING
// ============================================================
