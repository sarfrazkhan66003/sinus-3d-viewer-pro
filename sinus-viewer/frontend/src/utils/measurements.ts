
/**
 * SINUS VIEWER — MEASUREMENT UTILITIES
 * ====================================
 *
 * Pure mathematical measurements for CT / CBCT:
 * - 3D physical distance in millimetres.
 * - Voxel-to-world physical distance.
 * - Three-point angle in degrees.
 * - Polyline perimeter / length.
 * - Planar polygon area in square millimetres.
 * - Circle / ellipse / polygon ROI sampling.
 * - ROI intensity statistics on MPR images.
 * - Finite value and boundary validation.
 *
 * COORDINATES:
 *   DICOM LPS world positions are in millimetres.
 *   MPR pixel coordinates refer to pixel centres.
 *
 * IMPORTANT:
 *   These functions do not establish calibrated HU.
 *   Input intensities retain their original units.
 *   2D areas are geometric projected plane areas,
 *   not anatomical volumes.
 *
 * SECURITY:
 *   No HTTP, filesystem, browser storage or DICOM writes.
 *   No patient identifiers or image content are logged.
 *
 * Clinical measurement accuracy must be validated
 * against known-geometry reference datasets.
 */

import type {
  VolumeGeometry,
} from "../types/api";

import {
  voxelToWorldLPS,
  type VoxelPoint,
  type WorldPointLPS,
} from "./geometry";

import {
  mprPixelToWorldLPS,
  validateMPRPlane,
  type MPRPlane,
  type SampledMPRImage,
} from "./volumeSampling";


// ============================================================
// 01 — CONSTANTS
// ============================================================

export const MAX_MEASUREMENT_POINTS = 10000;
export const MAX_ROI_PIXELS = 4194304;
export const MAX_ROI_VERTICES = 10000;

const MIN_GEOMETRIC_TOLERANCE = 1e-9;
const MAX_GEOMETRIC_TOLERANCE = 1;


// ============================================================
// 02 — PUBLIC TYPES
// ============================================================

export interface Point2D {
  readonly x: number;
  readonly y: number;
}

export interface DistanceMeasurement {
  readonly distanceMm: number;
}

export interface AngleMeasurement {
  readonly angleDegrees: number;
}

export interface PolylineMeasurement {
  readonly lengthMm: number;
  readonly segmentCount: number;
}

export interface PolygonAreaMeasurement {
  readonly areaMm2: number;
  readonly perimeterMm: number;
  readonly vertexCount: number;
}

export interface IntensityStatistics {
  readonly count: number;
  readonly minimum: number | null;
  readonly maximum: number | null;
  readonly mean: number | null;
  readonly standardDeviation: number | null;
  readonly sum: number;
}

export interface ROIMeasurement {
  readonly areaMm2: number;
  readonly includedPixelCount: number;
  readonly invalidPixelCount: number;
  readonly statistics: IntensityStatistics;
}

export interface CircleROI {
  readonly center: Point2D;
  readonly radiusPixels: number;
}

export interface EllipseROI {
  readonly center: Point2D;
  readonly radiusXPixels: number;
  readonly radiusYPixels: number;
}

export interface PolygonROI {
  readonly points: readonly Point2D[];
}

export type ROIShape =
  | { readonly kind: "circle"; readonly roi: CircleROI }
  | { readonly kind: "ellipse"; readonly roi: EllipseROI }
  | { readonly kind: "polygon"; readonly roi: PolygonROI };

export class MeasurementError extends Error {
  constructor(
    message = "Invalid medical imaging measurement.",
  ) {
    super(message);
    this.name = "MeasurementError";
  }
}


// ============================================================
// 03 — VALIDATION
// ============================================================

function finite(value: unknown): value is number {
  return typeof value === "number" &&
    Number.isFinite(value);
}

function assertWorld(point: WorldPointLPS): void {
  if (
    !point ||
    !finite(point.x) ||
    !finite(point.y) ||
    !finite(point.z)
  ) {
    throw new MeasurementError(
      "Invalid physical coordinate.",
    );
  }
}

function assertPoint2D(point: Point2D): void {
  if (
    !point ||
    !finite(point.x) ||
    !finite(point.y)
  ) {
    throw new MeasurementError(
      "Invalid ROI pixel coordinate.",
    );
  }
}

function assertPointCollection<T>(
  points: readonly T[],
  minimum: number,
): void {
  if (
    !Array.isArray(points) ||
    points.length < minimum ||
    points.length > MAX_MEASUREMENT_POINTS
  ) {
    throw new MeasurementError(
      "Invalid number of measurement points.",
    );
  }
}

function assertImage(image: SampledMPRImage): void {
  if (!image) {
    throw new MeasurementError("Image is unavailable.");
  }

  validateMPRPlane(image.plane);

  const { width, height, intensities } = image;
  const count = width * height;

  if (
    width !== image.plane.width ||
    height !== image.plane.height ||
    count > MAX_ROI_PIXELS ||
    !(intensities instanceof Float32Array) ||
    intensities.length !== count
  ) {
    throw new MeasurementError(
      "Invalid image dimensions or intensity buffer.",
    );
  }
}


// ============================================================
// 04 — VECTOR MATHEMATICS
// ============================================================

function difference(
  first: WorldPointLPS,
  second: WorldPointLPS,
): readonly [number, number, number] {
  return [
    first.x - second.x,
    first.y - second.y,
    first.z - second.z,
  ];
}

function dot(
  first: readonly number[],
  second: readonly number[],
): number {
  return (
    first[0] * second[0] +
    first[1] * second[1] +
    first[2] * second[2]
  );
}

function norm(vector: readonly number[]): number {
  return Math.hypot(
    vector[0],
    vector[1],
    vector[2],
  );
}

function cross(
  a: readonly number[],
  b: readonly number[],
): readonly [number, number, number] {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function clamp(value: number): number {
  return Math.min(1, Math.max(-1, value));
}


// ============================================================
// 05 — PHYSICAL DISTANCE
// ============================================================

export function measureDistanceMm(
  first: WorldPointLPS,
  second: WorldPointLPS,
): DistanceMeasurement {
  assertWorld(first);
  assertWorld(second);

  const distanceMm = norm(
    difference(first, second),
  );

  if (!finite(distanceMm)) {
    throw new MeasurementError(
      "Physical distance exceeds numeric limits.",
    );
  }

  return { distanceMm };
}

export function measureVoxelDistanceMm(
  geometry: VolumeGeometry,
  first: VoxelPoint,
  second: VoxelPoint,
): DistanceMeasurement {
  const worldA = voxelToWorldLPS(
    geometry,
    first,
  );

  const worldB = voxelToWorldLPS(
    geometry,
    second,
  );

  return measureDistanceMm(worldA, worldB);
}


// ============================================================
// 06 — THREE-POINT ANGLE
// ============================================================

/**
 * Angle A-B-C, with the vertex at B.
 * Returns a value between 0 and 180 degrees.
 */
export function measureAngleDegrees(
  a: WorldPointLPS,
  vertex: WorldPointLPS,
  c: WorldPointLPS,
): AngleMeasurement {
  assertWorld(a);
  assertWorld(vertex);
  assertWorld(c);

  const first = difference(a, vertex);
  const second = difference(c, vertex);

  const lengthA = norm(first);
  const lengthB = norm(second);

  if (
    lengthA <= 0 ||
    lengthB <= 0 ||
    !finite(lengthA) ||
    !finite(lengthB)
  ) {
    throw new MeasurementError(
      "Angle arms must have nonzero length.",
    );
  }

  const cosine = dot(
    first.map((value) => value / lengthA),
    second.map((value) => value / lengthB),
  );

  const angleDegrees =
    Math.acos(clamp(cosine)) * 180 / Math.PI;

  if (!finite(angleDegrees)) {
    throw new MeasurementError(
      "Unable to calculate angle.",
    );
  }

  return { angleDegrees };
}


// ============================================================
// 07 — POLYLINE LENGTH
// ============================================================

export function measurePolylineMm(
  points: readonly WorldPointLPS[],
  closed = false,
): PolylineMeasurement {
  assertPointCollection(points, 2);

  for (const point of points) {
    assertWorld(point);
  }

  let lengthMm = 0;

  for (let index = 1; index < points.length; index++) {
    lengthMm += measureDistanceMm(
      points[index - 1],
      points[index],
    ).distanceMm;
  }

  if (closed && points.length > 2) {
    lengthMm += measureDistanceMm(
      points[points.length - 1],
      points[0],
    ).distanceMm;
  }

  if (!finite(lengthMm)) {
    throw new MeasurementError(
      "Polyline length exceeds numeric limits.",
    );
  }

  return {
    lengthMm,
    segmentCount:
      points.length - 1 +
      (closed && points.length > 2 ? 1 : 0),
  };
}


// ============================================================
// 08 — PLANAR WORLD-SPACE POLYGON AREA
// ============================================================

/**
 * Computes 3D planar polygon area using an area vector.
 *
 * Vertices must describe one simple, planar polygon
 * in their boundary order.
 *
 * Self-intersections are not supported.
 */
export function measurePolygonAreaMm2(
  points: readonly WorldPointLPS[],
  toleranceMm = 0.01,
): PolygonAreaMeasurement {
  assertPointCollection(points, 3);

  if (
    !finite(toleranceMm) ||
    toleranceMm < MIN_GEOMETRIC_TOLERANCE ||
    toleranceMm > MAX_GEOMETRIC_TOLERANCE
  ) {
    throw new MeasurementError(
      "Invalid polygon planarity tolerance.",
    );
  }

  for (const point of points) {
    assertWorld(point);
  }

  const origin = points[0];
  let areaX = 0;
  let areaY = 0;
  let areaZ = 0;

  for (let index = 1; index < points.length - 1; index++) {
    const a = difference(points[index], origin);
    const b = difference(points[index + 1], origin);
    const triangle = cross(a, b);

    areaX += triangle[0];
    areaY += triangle[1];
    areaZ += triangle[2];
  }

  const magnitude = Math.hypot(
    areaX,
    areaY,
    areaZ,
  );

  if (!finite(magnitude) || magnitude <= 0) {
    throw new MeasurementError(
      "Polygon has zero or invalid area.",
    );
  }

  const normal = [
    areaX / magnitude,
    areaY / magnitude,
    areaZ / magnitude,
  ];

  for (const point of points) {
    const displacement = difference(point, origin);
    const signedDistance = dot(
      normal,
      displacement,
    );

    if (Math.abs(signedDistance) > toleranceMm) {
      throw new MeasurementError(
        "Polygon points are not coplanar.",
      );
    }
  }

  return {
    areaMm2: magnitude / 2,
    perimeterMm: measurePolylineMm(
      points,
      true,
    ).lengthMm,
    vertexCount: points.length,
  };
}


// ============================================================
// 09 — PIXEL-TO-WORLD MEASUREMENTS
// ============================================================

export function measureMPRDistanceMm(
  plane: MPRPlane,
  a: Point2D,
  b: Point2D,
): DistanceMeasurement {
  assertPoint2D(a);
  assertPoint2D(b);

  const worldA = mprPixelToWorldLPS(
    plane,
    a.x,
    a.y,
  );

  const worldB = mprPixelToWorldLPS(
    plane,
    b.x,
    b.y,
  );

  return measureDistanceMm(worldA, worldB);
}

export function measureMPRPolygonAreaMm2(
  plane: MPRPlane,
  points: readonly Point2D[],
): PolygonAreaMeasurement {
  assertPointCollection(points, 3);
  validateMPRPlane(plane);

  const worldPoints = points.map((point) => {
    assertPoint2D(point);

    return mprPixelToWorldLPS(
      plane,
      point.x,
      point.y,
    );
  });

  return measurePolygonAreaMm2(
    worldPoints,
  );
}


// ============================================================
// 10 — POLYGON PIXEL CONTAINMENT
// ============================================================

/**
 * Even-odd ray casting at pixel-centre coordinates.
 * Polygon vertices must form a simple boundary.
 */
export function pointInsidePolygon(
  point: Point2D,
  vertices: readonly Point2D[],
): boolean {
  assertPoint2D(point);
  assertPointCollection(vertices, 3);

  if (vertices.length > MAX_ROI_VERTICES) {
    throw new MeasurementError(
      "ROI polygon contains too many vertices.",
    );
  }

  let inside = false;

  for (
    let i = 0, j = vertices.length - 1;
    i < vertices.length;
    j = i++
  ) {
    const a = vertices[i];
    const b = vertices[j];

    assertPoint2D(a);
    assertPoint2D(b);

    if (
      (a.y > point.y) !== (b.y > point.y)
    ) {
      const intersectionX =
        (b.x - a.x) *
        (point.y - a.y) /
        (b.y - a.y) +
        a.x;

      if (point.x < intersectionX) {
        inside = !inside;
      }
    }
  }

  return inside;
}


// ============================================================
// 11 — ROI SHAPE VALIDATION
// ============================================================

export function validateROIShape(
  shape: ROIShape,
): void {
  if (!shape || typeof shape !== "object") {
    throw new MeasurementError("Invalid ROI shape.");
  }

  switch (shape.kind) {
    case "circle": {
      assertPoint2D(shape.roi.center);

      if (
        !finite(shape.roi.radiusPixels) ||
        shape.roi.radiusPixels <= 0
      ) {
        throw new MeasurementError(
          "Invalid circular ROI radius.",
        );
      }

      return;
    }

    case "ellipse": {
      assertPoint2D(shape.roi.center);

      if (
        !finite(shape.roi.radiusXPixels) ||
        !finite(shape.roi.radiusYPixels) ||
        shape.roi.radiusXPixels <= 0 ||
        shape.roi.radiusYPixels <= 0
      ) {
        throw new MeasurementError(
          "Invalid elliptical ROI radii.",
        );
      }

      return;
    }

    case "polygon": {
      assertPointCollection(shape.roi.points, 3);

      if (shape.roi.points.length > MAX_ROI_VERTICES) {
        throw new MeasurementError(
          "ROI polygon contains too many vertices.",
        );
      }

      for (const vertex of shape.roi.points) {
        assertPoint2D(vertex);
      }

      return;
    }

    default:
      throw new MeasurementError(
        "Unsupported ROI shape.",
      );
  }
}


// ============================================================
// 12 — PIXEL MEMBERSHIP
// ============================================================

function roiContains(
  shape: ROIShape,
  x: number,
  y: number,
): boolean {
  switch (shape.kind) {
    case "circle": {
      const dx = x - shape.roi.center.x;
      const dy = y - shape.roi.center.y;

      return (
        dx * dx + dy * dy <=
        shape.roi.radiusPixels ** 2
      );
    }

    case "ellipse": {
      const dx = (
        x - shape.roi.center.x
      ) / shape.roi.radiusXPixels;

      const dy = (
        y - shape.roi.center.y
      ) / shape.roi.radiusYPixels;

      return dx * dx + dy * dy <= 1;
    }

    case "polygon":
      return pointInsidePolygon(
        { x, y },
        shape.roi.points,
      );
  }
}


// ============================================================
// 13 — INTENSITY STATISTICS
// ============================================================

/**
 * Uses Welford's online algorithm.
 *
 * Standard deviation is population SD (division by N).
 * Non-finite input values are excluded.
 */
export function calculateIntensityStatistics(
  values: readonly number[] | Float32Array | Float64Array,
): IntensityStatistics {
  let count = 0;
  let mean = 0;
  let m2 = 0;
  let minimum = Infinity;
  let maximum = -Infinity;
  let sum = 0;

  for (const value of values) {
    if (!finite(value)) {
      continue;
    }

    count++;
    sum += value;

    const delta = value - mean;
    mean += delta / count;

    const delta2 = value - mean;
    m2 += delta * delta2;

    minimum = Math.min(minimum, value);
    maximum = Math.max(maximum, value);
  }

  if (count === 0) {
    return {
      count: 0,
      minimum: null,
      maximum: null,
      mean: null,
      standardDeviation: null,
      sum: 0,
    };
  }

  if (
    !finite(sum) ||
    !finite(mean) ||
    !finite(m2)
  ) {
    throw new MeasurementError(
      "Intensity statistics exceed numeric limits.",
    );
  }

  return {
    count,
    minimum,
    maximum,
    mean,
    standardDeviation: Math.sqrt(
      Math.max(0, m2 / count),
    ),
    sum,
  };
}


// ============================================================
// 14 — ROI INTENSITY MEASUREMENTS
// ============================================================

/**
 * Pixel-centre inclusion mask.
 *
 * Physical area is included pixel count multiplied by
 * pixelSpacingU * pixelSpacingV. This is a rasterized
 * area approximation, not exact analytic boundary area.
 *
 * Invalid voxels contribute to geometry / area but are
 * excluded from intensity statistics.
 */
export function measureROI(
  image: SampledMPRImage,
  shape: ROIShape,
): ROIMeasurement {
  assertImage(image);
  validateROIShape(shape);

  const { width, height, intensities, plane } = image;
  const selected: number[] = [];

  let includedPixelCount = 0;
  let invalidPixelCount = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!roiContains(shape, x, y)) {
        continue;
      }

      includedPixelCount++;

      const value = intensities[
        y * width + x
      ];

      if (finite(value)) {
        selected.push(value);
      } else {
        invalidPixelCount++;
      }
    }
  }

  const areaMm2 = (
    includedPixelCount *
    plane.pixelSpacingUMm *
    plane.pixelSpacingVMm
  );

  if (!finite(areaMm2)) {
    throw new MeasurementError(
      "ROI area exceeds numeric limits.",
    );
  }

  return {
    areaMm2,
    includedPixelCount,
    invalidPixelCount,
    statistics: calculateIntensityStatistics(selected),
  };
}


// ============================================================
// 15 — MEASUREMENT CAPABILITIES
// ============================================================

export function getMeasurementCapabilities() {
  return {
    coordinateSystem: "LPS",
    distanceUnit: "mm",
    areaUnit: "mm2",
    angleUnit: "degrees",
    distance3D: true,
    angle3D: true,
    polyline3D: true,
    planarPolygonArea: true,
    circularROI: true,
    ellipticalROI: true,
    polygonROI: true,
    intensityStatistics: true,
    assumesCalibratedHU: false,
    modifiesSourceData: false,
    diagnosticValidationComplete: false,
  } as const;
}


// ============================================================
// END OF SINUS VIEWER MEASUREMENT UTILITIES
// ============================================================
