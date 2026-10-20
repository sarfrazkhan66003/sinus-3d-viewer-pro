
"""
SINUS VIEWER — 3D GEOMETRY ENGINE
=================================

Medical image geometry, coordinate transformations and
physical measurement utilities.

Conventions:
    NumPy volume array order: (Z, Y, X)
    Voxel index order:       (X, Y, Z)
    DICOM physical space:    LPS
    Optional display space:  RAS
    Physical distance:       millimetres

DICOM:
    ImageOrientationPatient[0:3] is increasing column
    index direction (image row direction).
    ImageOrientationPatient[3:6] is increasing row
    index direction (image column direction).

    PixelSpacing[0] = row spacing (Y index)
    PixelSpacing[1] = column spacing (X index)

Limitations:
    - Affine regular grids only.
    - Nonuniform, tilted or sheared stacks require separate
      geometry handling or validated resampling.
    - No diagnostic orientation claims without testing.

No files are read, written or modified by this module.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from enum import Enum
from typing import TYPE_CHECKING, Sequence

import numpy as np

if TYPE_CHECKING:
    from .series_reader import SeriesVolume


# ============================================================
# 01 — CONSTANTS
# ============================================================

ORTHOGONAL_TOLERANCE = 1e-4
DETERMINANT_TOLERANCE = 1e-8

LPS_TO_RAS_MATRIX = np.diag(
    [-1.0, -1.0, 1.0]
).astype(np.float64)


# ============================================================
# 02 — ERRORS
# ============================================================

class GeometryError(ValueError):
    """Controlled geometry validation error."""


# ============================================================
# 03 — COORDINATE SYSTEMS
# ============================================================

class CoordinateSystem(str, Enum):
    LPS = "LPS"
    RAS = "RAS"


class AnatomicalPlane(str, Enum):
    AXIAL = "axial"
    CORONAL = "coronal"
    SAGITTAL = "sagittal"


# ============================================================
# 04 — VALIDATED VECTOR HELPERS
# ============================================================

def _vector3(
    values: Sequence[float],
) -> np.ndarray:
    try:
        result = np.asarray(
            values,
            dtype=np.float64,
        )
    except (TypeError, ValueError):
        raise GeometryError(
            "Invalid coordinate vector."
        ) from None

    if result.shape != (3,):
        raise GeometryError(
            "Expected a three-dimensional vector."
        )

    if not np.all(np.isfinite(result)):
        raise GeometryError(
            "Non-finite coordinate value."
        )

    return result


def _positive_spacing(
    values: Sequence[float],
) -> np.ndarray:
    result = _vector3(values)

    if np.any(result <= 0):
        raise GeometryError(
            "Voxel spacing must be positive."
        )

    return result


def _direction_matrix(
    values: Sequence[float],
) -> np.ndarray:
    try:
        matrix = np.asarray(
            values,
            dtype=np.float64,
        ).reshape(3, 3)
    except (TypeError, ValueError):
        raise GeometryError(
            "Invalid direction matrix."
        ) from None

    if not np.all(np.isfinite(matrix)):
        raise GeometryError(
            "Direction matrix contains invalid values."
        )

    gram = matrix.T @ matrix

    if not np.allclose(
        gram,
        np.eye(3),
        atol=ORTHOGONAL_TOLERANCE,
        rtol=0,
    ):
        raise GeometryError(
            "Direction axes are not orthonormal."
        )

    determinant = float(np.linalg.det(matrix))

    if not math.isfinite(determinant):
        raise GeometryError(
            "Invalid direction determinant."
        )

    if abs(determinant - 1.0) > ORTHOGONAL_TOLERANCE:
        raise GeometryError(
            "Direction matrix must be right-handed."
        )

    if abs(determinant) < DETERMINANT_TOLERANCE:
        raise GeometryError(
            "Singular direction matrix."
        )

    return matrix


# ============================================================
# 05 — IMMUTABLE VOLUME GEOMETRY
# ============================================================

@dataclass(frozen=True)
class VolumeGeometry:
    """
    Regular 3D grid in DICOM LPS coordinates.

    shape_zyx:
        Array shape in (Z, Y, X).

    spacing_xyz_mm:
        Physical spacing for increasing X, Y, Z voxel indices.

    direction_lps:
        Row-major 3x3 matrix.
        Its columns are X, Y and Z voxel axis directions.

    origin_lps:
        Centre of voxel (X=0, Y=0, Z=0).
    """

    shape_zyx: tuple[int, int, int]
    spacing_xyz_mm: tuple[float, float, float]
    origin_lps: tuple[float, float, float]
    direction_lps: tuple[float, ...]

    def __post_init__(self) -> None:
        if (
            len(self.shape_zyx) != 3
            or any(
                not isinstance(v, int)
                or isinstance(v, bool)
                or v <= 0
                for v in self.shape_zyx
            )
        ):
            raise GeometryError(
                "Volume dimensions must be positive integers."
            )

        _positive_spacing(self.spacing_xyz_mm)
        _vector3(self.origin_lps)
        _direction_matrix(self.direction_lps)

    @property
    def dimensions_xyz(self) -> tuple[int, int, int]:
        z, y, x = self.shape_zyx
        return (x, y, z)

    @property
    def matrix_lps(self) -> np.ndarray:
        return _direction_matrix(
            self.direction_lps
        )

    @property
    def affine_lps(self) -> np.ndarray:
        """
        Map (X, Y, Z, 1) voxel indices to LPS coordinates.
        """

        affine = np.eye(4, dtype=np.float64)

        affine[:3, :3] = (
            self.matrix_lps
            @ np.diag(self.spacing_xyz_mm)
        )

        affine[:3, 3] = _vector3(
            self.origin_lps
        )

        return affine

    @property
    def affine_ras(self) -> np.ndarray:
        transform = np.eye(4, dtype=np.float64)
        transform[:3, :3] = LPS_TO_RAS_MATRIX

        return transform @ self.affine_lps

    def safe_summary(self) -> dict:
        return {
            "shape_zyx": list(self.shape_zyx),
            "dimensions_xyz": list(self.dimensions_xyz),
            "spacing_xyz_mm": list(self.spacing_xyz_mm),
            "coordinate_system": "LPS",
            "geometry_valid": True,
        }


# ============================================================
# 06 — CREATE FROM EXISTING SERIES VOLUME
# ============================================================

def geometry_from_series_volume(
    volume: SeriesVolume,
) -> VolumeGeometry:
    """
    Convert SeriesVolume metadata to VolumeGeometry.

    SeriesVolume spacing is stored in (Z, Y, X) order.
    """

    spacing_z, spacing_y, spacing_x = (
        volume.spacing_zyx_mm
    )

    return VolumeGeometry(
        shape_zyx=volume.shape_zyx,
        spacing_xyz_mm=(
            spacing_x,
            spacing_y,
            spacing_z,
        ),
        origin_lps=volume.origin_lps,
        direction_lps=volume.direction_lps,
    )


# ============================================================
# 07 — VOXEL TO PHYSICAL SPACE
# ============================================================

def voxel_to_lps(
    geometry: VolumeGeometry,
    index_xyz: Sequence[float],
) -> tuple[float, float, float]:
    """
    Convert fractional voxel indices (X,Y,Z) to LPS mm.
    """

    index = _vector3(index_xyz)

    point = (
        geometry.matrix_lps
        @ (
            index
            * np.asarray(
                geometry.spacing_xyz_mm,
                dtype=np.float64,
            )
        )
        + _vector3(geometry.origin_lps)
    )

    return tuple(float(value) for value in point)


# ============================================================
# 08 — PHYSICAL SPACE TO VOXEL
# ============================================================

def lps_to_voxel(
    geometry: VolumeGeometry,
    point_lps: Sequence[float],
) -> tuple[float, float, float]:
    """
    Convert LPS millimetres to fractional (X,Y,Z) indices.

    Values outside the volume are returned without clipping.
    """

    displacement = (
        _vector3(point_lps)
        - _vector3(geometry.origin_lps)
    )

    projected = (
        geometry.matrix_lps.T
        @ displacement
    )

    index = projected / np.asarray(
        geometry.spacing_xyz_mm,
        dtype=np.float64,
    )

    return tuple(float(value) for value in index)


# ============================================================
# 09 — LPS AND RAS TRANSFORMATIONS
# ============================================================

def lps_to_ras(
    point_lps: Sequence[float],
) -> tuple[float, float, float]:
    point = LPS_TO_RAS_MATRIX @ _vector3(point_lps)
    return tuple(float(v) for v in point)


def ras_to_lps(
    point_ras: Sequence[float],
) -> tuple[float, float, float]:
    # The conversion is its own inverse.
    point = LPS_TO_RAS_MATRIX @ _vector3(point_ras)
    return tuple(float(v) for v in point)


def voxel_to_ras(
    geometry: VolumeGeometry,
    index_xyz: Sequence[float],
) -> tuple[float, float, float]:
    return lps_to_ras(
        voxel_to_lps(geometry, index_xyz)
    )


def ras_to_voxel(
    geometry: VolumeGeometry,
    point_ras: Sequence[float],
) -> tuple[float, float, float]:
    return lps_to_voxel(
        geometry,
        ras_to_lps(point_ras),
    )


# ============================================================
# 10 — VOXEL INDEX RANGE CHECK
# ============================================================

def is_voxel_inside(
    geometry: VolumeGeometry,
    index_xyz: Sequence[float],
    *,
    tolerance: float = 1e-6,
) -> bool:
    index = _vector3(index_xyz)

    if (
        not math.isfinite(tolerance)
        or tolerance < 0
    ):
        raise GeometryError(
            "Invalid coordinate tolerance."
        )

    return all(
        -tolerance <= index[axis] <= (
            geometry.dimensions_xyz[axis] - 1
            + tolerance
        )
        for axis in range(3)
    )


def clamp_voxel_index(
    geometry: VolumeGeometry,
    index_xyz: Sequence[float],
) -> tuple[float, float, float]:
    index = _vector3(index_xyz)
    dimensions = geometry.dimensions_xyz

    result = np.clip(
        index,
        [0.0, 0.0, 0.0],
        [
            float(dimensions[0] - 1),
            float(dimensions[1] - 1),
            float(dimensions[2] - 1),
        ],
    )

    return tuple(float(v) for v in result)


# ============================================================
# 11 — VOLUME CENTRE
# ============================================================

def volume_center_voxel(
    geometry: VolumeGeometry,
) -> tuple[float, float, float]:
    return tuple(
        (dimension - 1) / 2.0
        for dimension in geometry.dimensions_xyz
    )


def volume_center_lps(
    geometry: VolumeGeometry,
) -> tuple[float, float, float]:
    return voxel_to_lps(
        geometry,
        volume_center_voxel(geometry),
    )


# ============================================================
# 12 — PHYSICAL BOUNDS
# ============================================================

def volume_bounds_lps(
    geometry: VolumeGeometry,
) -> tuple[
    tuple[float, float],
    tuple[float, float],
    tuple[float, float],
]:
    """
    Axis-aligned LPS bounds of voxel centres.

    This is not the outer voxel-cell surface extent.
    """

    x, y, z = geometry.dimensions_xyz

    corners = np.asarray([
        voxel_to_lps(geometry, (ix, iy, iz))
        for ix in (0, x - 1)
        for iy in (0, y - 1)
        for iz in (0, z - 1)
    ])

    return tuple(
        (
            float(corners[:, axis].min()),
            float(corners[:, axis].max()),
        )
        for axis in range(3)
    )


# ============================================================
# 13 — DISTANCE MEASUREMENTS
# ============================================================

def physical_distance_mm(
    first_point: Sequence[float],
    second_point: Sequence[float],
) -> float:
    """
    Euclidean distance between two physical points in mm.
    """

    a = _vector3(first_point)
    b = _vector3(second_point)

    return float(np.linalg.norm(a - b))


def voxel_distance_mm(
    geometry: VolumeGeometry,
    first_index_xyz: Sequence[float],
    second_index_xyz: Sequence[float],
) -> float:
    return physical_distance_mm(
        voxel_to_lps(geometry, first_index_xyz),
        voxel_to_lps(geometry, second_index_xyz),
    )


# ============================================================
# 14 — ANATOMICAL PLANES
# ============================================================

@dataclass(frozen=True)
class PlaneDefinition:
    name: AnatomicalPlane
    normal_lps: tuple[float, float, float]
    horizontal_lps: tuple[float, float, float]
    vertical_lps: tuple[float, float, float]


def get_anatomical_plane(
    plane: AnatomicalPlane,
) -> PlaneDefinition:
    """
    Canonical patient-axis anatomical planes.

    These describe plane orientation, not final screen
    radiological display convention or camera flipping.
    """

    if plane == AnatomicalPlane.AXIAL:
        return PlaneDefinition(
            name=plane,
            normal_lps=(0.0, 0.0, 1.0),
            horizontal_lps=(1.0, 0.0, 0.0),
            vertical_lps=(0.0, 1.0, 0.0),
        )

    if plane == AnatomicalPlane.CORONAL:
        return PlaneDefinition(
            name=plane,
            normal_lps=(0.0, 1.0, 0.0),
            horizontal_lps=(1.0, 0.0, 0.0),
            vertical_lps=(0.0, 0.0, 1.0),
        )

    if plane == AnatomicalPlane.SAGITTAL:
        return PlaneDefinition(
            name=plane,
            normal_lps=(1.0, 0.0, 0.0),
            horizontal_lps=(0.0, 1.0, 0.0),
            vertical_lps=(0.0, 0.0, 1.0),
        )

    raise GeometryError(
        "Unsupported anatomical plane."
    )


# ============================================================
# 15 — CROSSHAIR COORDINATE HELPERS
# ============================================================

def crosshair_from_voxel(
    geometry: VolumeGeometry,
    index_xyz: Sequence[float],
) -> dict:
    """
    Shared crosshair location for synchronized viewports.

    UI may use the LPS or RAS point depending on its
    configured world-coordinate convention.
    """

    if not is_voxel_inside(geometry, index_xyz):
        raise GeometryError(
            "Crosshair position is outside the volume."
        )

    voxel = _vector3(index_xyz)
    point_lps = voxel_to_lps(geometry, voxel)

    return {
        "voxel_xyz": [float(v) for v in voxel],
        "world_lps": list(point_lps),
        "world_ras": list(lps_to_ras(point_lps)),
    }


def crosshair_from_lps(
    geometry: VolumeGeometry,
    point_lps: Sequence[float],
) -> dict:
    """
    Create synchronized crosshair state from LPS coordinates.
    """

    index = lps_to_voxel(
        geometry,
        point_lps,
    )

    return crosshair_from_voxel(
        geometry,
        index,
    )


# ============================================================
# 16 — 4x4 MATRIX SERIALIZATION
# ============================================================

def serialize_affine(
    geometry: VolumeGeometry,
    coordinate_system: CoordinateSystem = CoordinateSystem.LPS,
) -> list[list[float]]:
    """
    Serialize a 4x4 index-to-world affine as nested rows.

    Frontend must explicitly convert row-major serialized
    matrices if its library expects column-major storage.
    """

    if coordinate_system == CoordinateSystem.LPS:
        affine = geometry.affine_lps

    elif coordinate_system == CoordinateSystem.RAS:
        affine = geometry.affine_ras

    else:
        raise GeometryError(
            "Unsupported coordinate system."
        )

    return affine.astype(float).tolist()


# ============================================================
# 17 — GEOMETRY REPORT
# ============================================================

def build_geometry_report(
    geometry: VolumeGeometry,
) -> dict:
    """
    Technical geometry metadata for authenticated APIs.

    No patient names, source paths or identifiers included.
    """

    return {
        **geometry.safe_summary(),
        "origin_lps": list(geometry.origin_lps),
        "direction_lps": list(geometry.direction_lps),
        "center_lps": list(volume_center_lps(geometry)),
        "bounds_lps": [
            list(bounds)
            for bounds in volume_bounds_lps(geometry)
        ],
        "affine_lps": serialize_affine(
            geometry,
            CoordinateSystem.LPS,
        ),
        "affine_ras": serialize_affine(
            geometry,
            CoordinateSystem.RAS,
        ),
    }


# ============================================================
# END OF GEOMETRY ENGINE
# ============================================================
