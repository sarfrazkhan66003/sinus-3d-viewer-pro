
/**
 * SINUS VIEWER — DICOM GEOMETRY UTILITIES
 * ======================================
 *
 * Pure TypeScript mathematical operations for:
 * - Voxel XYZ <-> DICOM LPS world coordinates.
 * - Affine transforms with physical voxel spacing.
 * - Direction matrix validation and inversion.
 * - Volume indexing in ZYX memory order.
 * - Orthogonal image-plane navigation.
 * - Crosshair positioning and synchronization.
 * - Physical bounds and slice spacing.
 *
 * COORDINATE CONVENTIONS
 * ----------------------
 *
 * Voxel:
 *   x = column index
 *   y = row index
 *   z = slice index
 *
 * Array:
 *   shape_zyx = [depth, height, width]
 *   index = z * height * width + y * width + x
 *
 * World:
 *   DICOM LPS coordinates, measured in millimetres.
 *   +X = Left, +Y = Posterior, +Z = Superior.
 *
 * Direction matrix:
 *   Row-major 3x3 matrix D, applied as:
 *
 *   world = origin + D * diag(spacingXYZ) * voxelXYZ
 *
 * Matrix row-major storage:
 *   [d00, d01, d02,
 *    d10, d11, d12,
 *    d20, d21, d22]
 *
 * IMPORTANT:
 * Oblique acquisitions are supported by the affine math.
 * Constant-index planes are NOT necessarily true anatomical
 * axial, coronal or sagittal planes in oblique datasets.
 *
 * No filesystem access, HTTP calls or dataset modification.
 */

import {
  isVolumeGeometry,
  type PreviewPlane,
  type Shape3,
  type Vector3,
  type VolumeGeometry,
} from "../types/api";


// ============================================================
// 01 — PUBLIC TYPES
// ============================================================

export type Vec3 = readonly [
  number,
  number,
  number,
];

export type Mat3 = readonly [
  number, number, number,
  number, number, number,
  number, number, number,
];

export interface VoxelPoint {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface WorldPointLPS {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface VoxelBounds {
  readonly min: Vec3;
  readonly max: Vec3;
}

export interface WorldBoundsLPS {
  readonly min: Vec3;
  readonly max: Vec3;
}

export interface SlicePlaneInfo {
  readonly axis: 0 | 1 | 2;
  readonly count: number;
  readonly spacingMm: number;
}

export interface CrosshairState {
  readonly voxel: VoxelPoint;
  readonly worldLPS: WorldPointLPS;
  readonly axialIndex: number;
  readonly coronalIndex: number;
  readonly sagittalIndex: number;
}

export interface PlaneVoxelCoordinates {
  readonly u: number;
  readonly v: number;
  readonly slice: number;
}

export class GeometryError extends Error {
  constructor(message = "Invalid image geometry.") {
    super(message);
    this.name = "GeometryError";
  }
}


// ============================================================
// 02 — NUMERIC HELPERS
// ============================================================

const EPSILON = 1e-8;
const ORTHOGONAL_TOLERANCE = 1e-3;

function isFiniteNumber(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value)
  );
}

function assertFiniteVec3(value: Vec3): void {
  if (
    value.length !== 3 ||
    !value.every(isFiniteNumber)
  ) {
    throw new GeometryError();
  }
}

function assertFiniteMat3(value: Mat3): void {
  if (
    value.length !== 9 ||
    !value.every(isFiniteNumber)
  ) {
    throw new GeometryError();
  }
}

export function clamp(
  value: number,
  minimum: number,
  maximum: number,
): number {
  if (
    !isFiniteNumber(value) ||
    !isFiniteNumber(minimum) ||
    !isFiniteNumber(maximum) ||
    minimum > maximum
  ) {
    throw new GeometryError("Invalid numeric bounds.");
  }

  return Math.min(maximum, Math.max(minimum, value));
}

export function dot3(a: Vec3, b: Vec3): number {
  assertFiniteVec3(a);
  assertFiniteVec3(b);

  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function length3(value: Vec3): number {
  return Math.hypot(value[0], value[1], value[2]);
}

export function subtract3(a: Vec3, b: Vec3): Vec3 {
  assertFiniteVec3(a);
  assertFiniteVec3(b);

  return [
    a[0] - b[0],
    a[1] - b[1],
    a[2] - b[2],
  ];
}

export function add3(a: Vec3, b: Vec3): Vec3 {
  assertFiniteVec3(a);
  assertFiniteVec3(b);

  return [
    a[0] + b[0],
    a[1] + b[1],
    a[2] + b[2],
  ];
}


// ============================================================
// 03 — MATRIX OPERATIONS
// ============================================================

export function multiplyMat3Vec3(
  matrix: Mat3,
  vector: Vec3,
): Vec3 {
  assertFiniteMat3(matrix);
  assertFiniteVec3(vector);

  return [
    matrix[0] * vector[0] +
      matrix[1] * vector[1] +
      matrix[2] * vector[2],

    matrix[3] * vector[0] +
      matrix[4] * vector[1] +
      matrix[5] * vector[2],

    matrix[6] * vector[0] +
      matrix[7] * vector[1] +
      matrix[8] * vector[2],
  ];
}

export function determinantMat3(
  matrix: Mat3,
): number {
  assertFiniteMat3(matrix);

  const [
    a, b, c,
    d, e, f,
    g, h, i,
  ] = matrix;

  return (
    a * (e * i - f * h) -
    b * (d * i - f * g) +
    c * (d * h - e * g)
  );
}

export function invertMat3(matrix: Mat3): Mat3 {
  assertFiniteMat3(matrix);

  const [
    a, b, c,
    d, e, f,
    g, h, i,
  ] = matrix;

  const det = determinantMat3(matrix);

  if (
    !Number.isFinite(det) ||
    Math.abs(det) < EPSILON
  ) {
    throw new GeometryError(
      "The image direction matrix is singular.",
    );
  }

  const inverse: Mat3 = [
    (e * i - f * h) / det,
    (c * h - b * i) / det,
    (b * f - c * e) / det,

    (f * g - d * i) / det,
    (a * i - c * g) / det,
    (c * d - a * f) / det,

    (d * h - e * g) / det,
    (b * g - a * h) / det,
    (a * e - b * d) / det,
  ];

  if (!inverse.every(Number.isFinite)) {
    throw new GeometryError(
      "The inverse direction matrix is invalid.",
    );
  }

  return inverse;
}


// ============================================================
// 04 — DIRECTION VALIDATION
// ============================================================

function matrixColumn(
  matrix: Mat3,
  index: 0 | 1 | 2,
): Vec3 {
  return [
    matrix[index],
    matrix[3 + index],
    matrix[6 + index],
  ];
}

export function isOrthonormalDirection(
  matrix: Mat3,
  tolerance = ORTHOGONAL_TOLERANCE,
): boolean {
  if (
    !Number.isFinite(tolerance) ||
    tolerance <= 0 ||
    tolerance > 0.1 ||
    !Array.isArray(matrix) ||
    matrix.length !== 9 ||
    !matrix.every(isFiniteNumber)
  ) {
    return false;
  }

  const x = matrixColumn(matrix, 0);
  const y = matrixColumn(matrix, 1);
  const z = matrixColumn(matrix, 2);

  const unitLengths = [x, y, z].every(
    (axis) => Math.abs(length3(axis) - 1) <= tolerance,
  );

  const perpendicular =
    Math.abs(dot3(x, y)) <= tolerance &&
    Math.abs(dot3(x, z)) <= tolerance &&
    Math.abs(dot3(y, z)) <= tolerance;

  const determinant = Math.abs(
    determinantMat3(matrix),
  );

  return (
    unitLengths &&
    perpendicular &&
    Math.abs(determinant - 1) <=
      3 * tolerance
  );
}

export function assertVolumeGeometry(
  geometry: VolumeGeometry,
): void {
  if (!isVolumeGeometry(geometry)) {
    throw new GeometryError();
  }

  if (
    !isOrthonormalDirection(
      geometry.direction_lps as Mat3,
    )
  ) {
    throw new GeometryError(
      "Invalid volume orientation matrix.",
    );
  }
}


// ============================================================
// 05 — COORDINATE CONVERSIONS
// ============================================================

function asVec3(point: VoxelPoint | WorldPointLPS): Vec3 {
  const vector: Vec3 = [
    point.x,
    point.y,
    point.z,
  ];

  assertFiniteVec3(vector);
  return vector;
}

/**
 * Convert continuous voxel XYZ coordinates to world LPS.
 *
 * Indices refer to voxel centres, not voxel boundaries.
 */
export function voxelToWorldLPS(
  geometry: VolumeGeometry,
  voxel: VoxelPoint,
): WorldPointLPS {
  assertVolumeGeometry(geometry);

  const point = asVec3(voxel);
  const spacing = geometry.spacing_xyz_mm;

  const scaled: Vec3 = [
    point[0] * spacing[0],
    point[1] * spacing[1],
    point[2] * spacing[2],
  ];

  const rotated = multiplyMat3Vec3(
    geometry.direction_lps as Mat3,
    scaled,
  );

  const world = add3(
    geometry.origin_lps as Vec3,
    rotated,
  );

  return {
    x: world[0],
    y: world[1],
    z: world[2],
  };
}

/**
 * Convert DICOM LPS millimetres to continuous voxel XYZ.
 *
 * No automatic clamping is performed, so callers can
 * detect world positions outside the volume.
 */
export function worldLPSToVoxel(
  geometry: VolumeGeometry,
  world: WorldPointLPS,
): VoxelPoint {
  assertVolumeGeometry(geometry);

  const delta = subtract3(
    asVec3(world),
    geometry.origin_lps as Vec3,
  );

  const inverse = invertMat3(
    geometry.direction_lps as Mat3,
  );

  const local = multiplyMat3Vec3(
    inverse,
    delta,
  );

  const spacing = geometry.spacing_xyz_mm;

  return {
    x: local[0] / spacing[0],
    y: local[1] / spacing[1],
    z: local[2] / spacing[2],
  };
}


// ============================================================
// 06 — VOLUME BOUNDS
// ============================================================

export function getVoxelBounds(
  shapeZYX: Shape3,
): VoxelBounds {
  const [depth, height, width] = shapeZYX;

  if (
    !Number.isSafeInteger(depth) ||
    !Number.isSafeInteger(height) ||
    !Number.isSafeInteger(width) ||
    depth < 1 ||
    height < 1 ||
    width < 1
  ) {
    throw new GeometryError("Invalid volume shape.");
  }

  return {
    min: [0, 0, 0],
    max: [
      width - 1,
      height - 1,
      depth - 1,
    ],
  };
}

export function isVoxelInsideVolume(
  geometry: VolumeGeometry,
  voxel: VoxelPoint,
): boolean {
  assertVolumeGeometry(geometry);

  const bounds = getVoxelBounds(
    geometry.shape_zyx,
  );

  const point = asVec3(voxel);

  return point.every(
    (value, index) =>
      value >= bounds.min[index] &&
      value <= bounds.max[index],
  );
}

export function clampVoxelToVolume(
  geometry: VolumeGeometry,
  voxel: VoxelPoint,
): VoxelPoint {
  assertVolumeGeometry(geometry);

  const bounds = getVoxelBounds(
    geometry.shape_zyx,
  );

  return {
    x: clamp(voxel.x, bounds.min[0], bounds.max[0]),
    y: clamp(voxel.y, bounds.min[1], bounds.max[1]),
    z: clamp(voxel.z, bounds.min[2], bounds.max[2]),
  };
}

export function getWorldBoundsLPS(
  geometry: VolumeGeometry,
): WorldBoundsLPS {
  assertVolumeGeometry(geometry);

  const { max } = getVoxelBounds(
    geometry.shape_zyx,
  );

  const corners: Vec3[] = [];

  for (const z of [0, max[2]]) {
    for (const y of [0, max[1]]) {
      for (const x of [0, max[0]]) {
        const world = voxelToWorldLPS(
          geometry,
          { x, y, z },
        );

        corners.push([
          world.x,
          world.y,
          world.z,
        ]);
      }
    }
  }

  return {
    min: [
      Math.min(...corners.map((p) => p[0])),
      Math.min(...corners.map((p) => p[1])),
      Math.min(...corners.map((p) => p[2])),
    ],
    max: [
      Math.max(...corners.map((p) => p[0])),
      Math.max(...corners.map((p) => p[1])),
      Math.max(...corners.map((p) => p[2])),
    ],
  };
}


// ============================================================
// 07 — VOXEL BUFFER INDEXING
// ============================================================

export function voxelLinearIndex(
  shapeZYX: Shape3,
  x: number,
  y: number,
  z: number,
): number | null {
  const [depth, height, width] = shapeZYX;

  if (
    !Number.isSafeInteger(depth) ||
    !Number.isSafeInteger(height) ||
    !Number.isSafeInteger(width) ||
    depth <= 0 ||
    height <= 0 ||
    width <= 0 ||
    !Number.isSafeInteger(x) ||
    !Number.isSafeInteger(y) ||
    !Number.isSafeInteger(z) ||
    x < 0 ||
    y < 0 ||
    z < 0 ||
    x >= width ||
    y >= height ||
    z >= depth
  ) {
    return null;
  }

  const index =
    z * height * width +
    y * width +
    x;

  return Number.isSafeInteger(index)
    ? index
    : null;
}

export function linearIndexToVoxel(
  shapeZYX: Shape3,
  index: number,
): VoxelPoint | null {
  const [depth, height, width] = shapeZYX;
  const voxelCount = depth * height * width;

  if (
    !Number.isSafeInteger(depth) ||
    !Number.isSafeInteger(height) ||
    !Number.isSafeInteger(width) ||
    depth <= 0 ||
    height <= 0 ||
    width <= 0 ||
    !Number.isSafeInteger(voxelCount) ||
    !Number.isSafeInteger(index) ||
    index < 0 ||
    index >= voxelCount
  ) {
    return null;
  }

  const planeSize = height * width;

  const z = Math.floor(index / planeSize);
  const remainder = index - z * planeSize;
  const y = Math.floor(remainder / width);
  const x = remainder - y * width;

  return { x, y, z };
}


// ============================================================
// 08 — CONSTANT-INDEX SLICE NAVIGATION
// ============================================================

/**
 * These names identify voxel-axis slices.
 *
 * For oblique acquisitions, a constant Z slice is an
 * acquisition-plane slice, not necessarily a true axial
 * anatomical plane. True patient-aligned MPR requires
 * world-space resampling.
 */
export function getSlicePlaneInfo(
  geometry: VolumeGeometry,
  plane: PreviewPlane,
): SlicePlaneInfo {
  assertVolumeGeometry(geometry);

  const [depth, height, width] =
    geometry.shape_zyx;

  const [sx, sy, sz] =
    geometry.spacing_xyz_mm;

  switch (plane) {
    case "axial":
      return {
        axis: 2,
        count: depth,
        spacingMm: sz,
      };

    case "coronal":
      return {
        axis: 1,
        count: height,
        spacingMm: sy,
      };

    case "sagittal":
      return {
        axis: 0,
        count: width,
        spacingMm: sx,
      };
  }
}

export function clampSliceIndex(
  geometry: VolumeGeometry,
  plane: PreviewPlane,
  index: number,
): number {
  const info = getSlicePlaneInfo(
    geometry,
    plane,
  );

  return Math.round(
    clamp(index, 0, info.count - 1),
  );
}

/**
 * Pixel axes are defined in voxel space:
 *
 * axial:    u=X, v=Y, slice=Z
 * coronal:  u=X, v=Z, slice=Y
 * sagittal: u=Y, v=Z, slice=X
 *
 * Screen flips and radiological orientation are separate
 * presentation transforms, not performed here.
 */
export function planeToVoxel(
  plane: PreviewPlane,
  point: PlaneVoxelCoordinates,
): VoxelPoint {
  const { u, v, slice } = point;

  if (![u, v, slice].every(isFiniteNumber)) {
    throw new GeometryError();
  }

  switch (plane) {
    case "axial":
      return {
        x: u,
        y: v,
        z: slice,
      };

    case "coronal":
      return {
        x: u,
        y: slice,
        z: v,
      };

    case "sagittal":
      return {
        x: slice,
        y: u,
        z: v,
      };
  }
}

export function voxelToPlane(
  plane: PreviewPlane,
  voxel: VoxelPoint,
): PlaneVoxelCoordinates {
  const { x, y, z } = voxel;

  if (![x, y, z].every(isFiniteNumber)) {
    throw new GeometryError();
  }

  switch (plane) {
    case "axial":
      return {
        u: x,
        v: y,
        slice: z,
      };

    case "coronal":
      return {
        u: x,
        v: z,
        slice: y,
      };

    case "sagittal":
      return {
        u: y,
        v: z,
        slice: x,
      };
  }
}


// ============================================================
// 09 — CROSSHAIR SYNCHRONIZATION
// ============================================================

export function makeCrosshairFromVoxel(
  geometry: VolumeGeometry,
  voxel: VoxelPoint,
): CrosshairState {
  const bounded = clampVoxelToVolume(
    geometry,
    voxel,
  );

  const rounded: VoxelPoint = {
    x: Math.round(bounded.x),
    y: Math.round(bounded.y),
    z: Math.round(bounded.z),
  };

  return {
    voxel: rounded,
    worldLPS: voxelToWorldLPS(
      geometry,
      rounded,
    ),
    axialIndex: rounded.z,
    coronalIndex: rounded.y,
    sagittalIndex: rounded.x,
  };
}

export function makeCrosshairFromWorldLPS(
  geometry: VolumeGeometry,
  world: WorldPointLPS,
): CrosshairState {
  const voxel = worldLPSToVoxel(
    geometry,
    world,
  );

  return makeCrosshairFromVoxel(
    geometry,
    voxel,
  );
}

export function makeCenteredCrosshair(
  geometry: VolumeGeometry,
): CrosshairState {
  assertVolumeGeometry(geometry);

  const [depth, height, width] =
    geometry.shape_zyx;

  return makeCrosshairFromVoxel(
    geometry,
    {
      x: (width - 1) / 2,
      y: (height - 1) / 2,
      z: (depth - 1) / 2,
    },
  );
}

export function moveCrosshairSlice(
  geometry: VolumeGeometry,
  crosshair: CrosshairState,
  plane: PreviewPlane,
  newIndex: number,
): CrosshairState {
  const index = clampSliceIndex(
    geometry,
    plane,
    newIndex,
  );

  const previous = crosshair.voxel;

  switch (plane) {
    case "axial":
      return makeCrosshairFromVoxel(
        geometry,
        {
          ...previous,
          z: index,
        },
      );

    case "coronal":
      return makeCrosshairFromVoxel(
        geometry,
        {
          ...previous,
          y: index,
        },
      );

    case "sagittal":
      return makeCrosshairFromVoxel(
        geometry,
        {
          ...previous,
          x: index,
        },
      );
  }
}


// ============================================================
// 10 — PHYSICAL DISTANCE
// ============================================================

export function distanceWorldMm(
  a: WorldPointLPS,
  b: WorldPointLPS,
): number {
  const delta = subtract3(
    asVec3(a),
    asVec3(b),
  );

  return length3(delta);
}

export function distanceVoxelMm(
  geometry: VolumeGeometry,
  a: VoxelPoint,
  b: VoxelPoint,
): number {
  const first = voxelToWorldLPS(
    geometry,
    a,
  );

  const second = voxelToWorldLPS(
    geometry,
    b,
  );

  return distanceWorldMm(first, second);
}


// ============================================================
// 11 — LPS / RAS CONVERSION
// ============================================================

/**
 * DICOM LPS and RAS differ by X and Y axis signs.
 * These functions do not change voxel indices.
 */
export function lpsToRAS(
  lps: Vector3,
): Vec3 {
  assertFiniteVec3(lps);

  return [
    -lps[0],
    -lps[1],
    lps[2],
  ];
}

export function rasToLPS(
  ras: Vector3,
): Vec3 {
  assertFiniteVec3(ras);

  return [
    -ras[0],
    -ras[1],
    ras[2],
  ];
}


// ============================================================
// END OF SINUS VIEWER GEOMETRY UTILITIES
// ============================================================
