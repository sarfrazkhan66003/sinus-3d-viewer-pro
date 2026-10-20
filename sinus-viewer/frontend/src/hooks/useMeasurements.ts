
/**
 * SINUS VIEWER — REACT MEASUREMENT CONTROLLER
 * ==========================================
 *
 * React 18 measurement state for CT / CBCT MPR:
 * - Physical distance (2 points)
 * - Three-point angle (3 points)
 * - Polyline length (2+ points)
 * - Planar polygon area (3+ points)
 * - Screen-pixel to DICOM LPS point placement
 * - Draft undo, finish, cancel and clear
 * - Measurement visibility and selection
 * - In-memory measurement history
 *
 * Measurement mathematics: File 53
 * MPR coordinate transforms: File 52
 *
 * IMPORTANT:
 * - All measurement points use DICOM LPS millimetres.
 * - Polygon boundaries must be simple and planar.
 * - ROI intensity measurement is handled by File 53;
 *   this hook manages geometric drawing annotations.
 * - Measurements are NOT persisted automatically.
 * - No original DICOM files are accessed or modified.
 *
 * Measurements require numerical and clinical validation.
 */

import {
  useCallback,
  useMemo,
  useRef,
  useState,
} from "react";

import type { PreviewPlane } from "../types/api";

import type { WorldPointLPS } from "../utils/geometry";

import {
  mprScreenToWorldLPS,
  type MPRScreenPoint,
  type MPRViewportState,
} from "../utils/mpr";

import {
  measureAngleDegrees,
  measureDistanceMm,
  measurePolygonAreaMm2,
  measurePolylineMm,
} from "../utils/measurements";


// ============================================================
// 01 — PUBLIC CONSTANTS
// ============================================================

export const MAX_STORED_MEASUREMENTS = 1000;
export const MAX_MEASUREMENT_DRAWING_POINTS = 10000;

export const MEASUREMENT_TOOLS = [
  "distance",
  "angle",
  "polyline",
  "polygon",
] as const;


// ============================================================
// 02 — PUBLIC TYPES
// ============================================================

export type MeasurementTool =
  (typeof MEASUREMENT_TOOLS)[number];

export type MeasurementMode =
  | MeasurementTool
  | "none";

export interface MeasurementDraft {
  readonly tool: MeasurementTool;
  readonly plane: PreviewPlane;
  readonly points: readonly WorldPointLPS[];
}

export interface MeasurementBase {
  readonly id: string;
  readonly plane: PreviewPlane;
  readonly points: readonly WorldPointLPS[];
  readonly visible: boolean;
}

export interface StoredDistanceMeasurement
  extends MeasurementBase {
  readonly kind: "distance";
  readonly distanceMm: number;
}

export interface StoredAngleMeasurement
  extends MeasurementBase {
  readonly kind: "angle";
  readonly angleDegrees: number;
}

export interface StoredPolylineMeasurement
  extends MeasurementBase {
  readonly kind: "polyline";
  readonly lengthMm: number;
}

export interface StoredPolygonMeasurement
  extends MeasurementBase {
  readonly kind: "polygon";
  readonly areaMm2: number;
  readonly perimeterMm: number;
}

export type StoredMeasurement =
  | StoredDistanceMeasurement
  | StoredAngleMeasurement
  | StoredPolylineMeasurement
  | StoredPolygonMeasurement;

export interface MeasurementControllerState {
  readonly activeTool: MeasurementMode;
  readonly draft: MeasurementDraft | null;
  readonly measurements: readonly StoredMeasurement[];
  readonly selectedId: string | null;
  readonly revision: number;
}

export interface MeasurementActions {
  readonly setTool: (tool: MeasurementMode) => void;

  readonly addWorldPoint: (
    plane: PreviewPlane,
    point: WorldPointLPS,
  ) => void;

  readonly addScreenPoint: (
    viewport: MPRViewportState,
    screen: MPRScreenPoint,
  ) => void;

  readonly finishDraft: () => void;
  readonly undoDraftPoint: () => void;
  readonly cancelDraft: () => void;

  readonly removeMeasurement: (id: string) => void;
  readonly undoLastMeasurement: () => void;
  readonly clearMeasurements: () => void;

  readonly selectMeasurement: (
    id: string | null,
  ) => void;

  readonly setMeasurementVisible: (
    id: string,
    visible: boolean,
  ) => void;

  readonly reset: () => void;
}

export interface UseMeasurementsResult {
  readonly state: MeasurementControllerState;
  readonly actions: MeasurementActions;
  readonly activeTool: MeasurementMode;
  readonly draft: MeasurementDraft | null;
  readonly measurements: readonly StoredMeasurement[];
  readonly selectedMeasurement: StoredMeasurement | null;
  readonly canFinishDraft: boolean;
  readonly canUndoDraft: boolean;
  readonly hasMeasurements: boolean;
  readonly measurementCount: number;
}


// ============================================================
// 03 — CONTROLLED ERRORS
// ============================================================

export class MeasurementControllerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MeasurementControllerError";
  }
}


// ============================================================
// 04 — VALIDATION
// ============================================================

function assertTool(tool: MeasurementMode): void {
  if (
    tool !== "none" &&
    !MEASUREMENT_TOOLS.includes(
      tool as MeasurementTool,
    )
  ) {
    throw new MeasurementControllerError(
      "Unsupported measurement tool.",
    );
  }
}

function assertPlane(plane: PreviewPlane): void {
  if (
    plane !== "axial" &&
    plane !== "coronal" &&
    plane !== "sagittal"
  ) {
    throw new MeasurementControllerError(
      "Invalid measurement plane.",
    );
  }
}

function copyWorldPoint(
  point: WorldPointLPS,
): WorldPointLPS {
  if (
    !point ||
    !Number.isFinite(point.x) ||
    !Number.isFinite(point.y) ||
    !Number.isFinite(point.z)
  ) {
    throw new MeasurementControllerError(
      "Invalid physical measurement position.",
    );
  }

  return {
    x: point.x,
    y: point.y,
    z: point.z,
  };
}

function assertMeasurementId(id: string): void {
  if (
    typeof id !== "string" ||
    id.length === 0 ||
    id.length > 128
  ) {
    throw new MeasurementControllerError(
      "Invalid measurement identifier.",
    );
  }
}

function minimumPointCount(
  tool: MeasurementTool,
): number {
  switch (tool) {
    case "distance":
      return 2;
    case "angle":
      return 3;
    case "polyline":
      return 2;
    case "polygon":
      return 3;
  }
}

function maximumPointCount(
  tool: MeasurementTool,
): number {
  switch (tool) {
    case "distance":
      return 2;
    case "angle":
      return 3;
    case "polyline":
    case "polygon":
      return MAX_MEASUREMENT_DRAWING_POINTS;
  }
}

function canFinish(
  draft: MeasurementDraft | null,
): boolean {
  return (
    draft !== null &&
    draft.points.length >=
      minimumPointCount(draft.tool)
  );
}


// ============================================================
// 05 — INITIAL STATE
// ============================================================

function initialState(): MeasurementControllerState {
  return {
    activeTool: "none",
    draft: null,
    measurements: [],
    selectedId: null,
    revision: 0,
  };
}


// ============================================================
// 06 — MEASUREMENT CONSTRUCTION
// ============================================================

/**
 * All geometry measurements use the original
 * unrounded world-space positions.
 *
 * Display formatting is left to the UI; no
 * rounding is performed in stored results.
 */
function buildMeasurement(
  id: string,
  draft: MeasurementDraft,
): StoredMeasurement {
  const points = draft.points.map(copyWorldPoint);

  const base: MeasurementBase = {
    id,
    plane: draft.plane,
    points,
    visible: true,
  };

  switch (draft.tool) {
    case "distance":
      return {
        ...base,
        kind: "distance",
        distanceMm: measureDistanceMm(
          points[0],
          points[1],
        ).distanceMm,
      };

    case "angle":
      return {
        ...base,
        kind: "angle",
        angleDegrees: measureAngleDegrees(
          points[0],
          points[1],
          points[2],
        ).angleDegrees,
      };

    case "polyline":
      return {
        ...base,
        kind: "polyline",
        lengthMm: measurePolylineMm(
          points,
        ).lengthMm,
      };

    case "polygon": {
      const result = measurePolygonAreaMm2(
        points,
      );

      return {
        ...base,
        kind: "polygon",
        areaMm2: result.areaMm2,
        perimeterMm: result.perimeterMm,
      };
    }
  }
}


// ============================================================
// 07 — MAIN REACT HOOK
// ============================================================

/**
 * Create one hook instance for one loaded volume.
 *
 * Mount this controller in the viewer container,
 * not independently in all three MPR panels.
 *
 * Remount the owning component with a new key or
 * invoke actions.reset() when the selected volume
 * changes or the authenticated session ends.
 */
export function useMeasurements():
  UseMeasurementsResult {
  const [state, setState] =
    useState<MeasurementControllerState>(
      initialState,
    );

  /**
   * Local monotonically increasing identifiers.
   * These are UI IDs, not DICOM identifiers.
   */
  const nextId = useRef(0);

  // ==========================================================
  // 08 — SELECT TOOL
  // ==========================================================

  const setTool = useCallback(
    (tool: MeasurementMode): void => {
      assertTool(tool);

      setState((previous) => {
        if (
          previous.activeTool === tool &&
          previous.draft === null
        ) {
          return previous;
        }

        return {
          ...previous,
          activeTool: tool,
          draft: null,
          revision: previous.revision + 1,
        };
      });
    },
    [],
  );

  // ==========================================================
  // 09 — COMMIT COMPLETED DRAFT
  // ==========================================================

  const commitDraft = useCallback(
    (
      previous: MeasurementControllerState,
      draft: MeasurementDraft,
    ): MeasurementControllerState => {
      if (
        previous.measurements.length >=
        MAX_STORED_MEASUREMENTS
      ) {
        throw new MeasurementControllerError(
          "Measurement history limit reached.",
        );
      }

      const id = `measurement-${++nextId.current}`;

      const measurement = buildMeasurement(
        id,
        draft,
      );

      return {
        ...previous,
        draft: null,
        measurements: [
          ...previous.measurements,
          measurement,
        ],
        selectedId: id,
        revision: previous.revision + 1,
      };
    },
    [],
  );

  // ==========================================================
  // 10 — ADD WORLD POINT
  // ==========================================================

  const addWorldPoint = useCallback(
    (
      plane: PreviewPlane,
      point: WorldPointLPS,
    ): void => {
      assertPlane(plane);
      const safePoint = copyWorldPoint(point);

      setState((previous) => {
        const tool = previous.activeTool;

        if (tool === "none") {
          return previous;
        }

        /**
         * Keep every geometric drawing associated
         * with a single MPR plane.
         *
         * Switching planes starts a new draft.
         * This prevents accidental mixing of points
         * captured in unrelated anatomical slices.
         */
        const existing =
          previous.draft?.tool === tool &&
          previous.draft.plane === plane
            ? previous.draft.points
            : [];

        if (
          existing.length >=
          maximumPointCount(tool)
        ) {
          throw new MeasurementControllerError(
            "Too many measurement points.",
          );
        }

        const draft: MeasurementDraft = {
          tool,
          plane,
          points: [...existing, safePoint],
        };

        /**
         * Distance and angle automatically complete
         * at their required fixed number of points.
         */
        if (
          (tool === "distance" || tool === "angle") &&
          draft.points.length ===
            maximumPointCount(tool)
        ) {
          return commitDraft(previous, draft);
        }

        return {
          ...previous,
          draft,
          selectedId: null,
          revision: previous.revision + 1,
        };
      });
    },
    [commitDraft],
  );

  // ==========================================================
  // 11 — ADD POINT FROM AN MPR SCREEN
  // ==========================================================

  const addScreenPoint = useCallback(
    (
      viewport: MPRViewportState,
      screen: MPRScreenPoint,
    ): void => {
      const world = mprScreenToWorldLPS(
        viewport,
        screen,
      );

      addWorldPoint(
        viewport.plane,
        world,
      );
    },
    [addWorldPoint],
  );

  // ==========================================================
  // 12 — FINISH POLYLINE OR POLYGON
  // ==========================================================

  const finishDraft = useCallback(
    (): void => {
      setState((previous) => {
        const draft = previous.draft;

        if (!draft) {
          return previous;
        }

        if (!canFinish(draft)) {
          throw new MeasurementControllerError(
            "More points are required.",
          );
        }

        return commitDraft(
          previous,
          draft,
        );
      });
    },
    [commitDraft],
  );

  // ==========================================================
  // 13 — UNDO ONE DRAFT POINT
  // ==========================================================

  const undoDraftPoint = useCallback(
    (): void => {
      setState((previous) => {
        if (!previous.draft) {
          return previous;
        }

        const remaining = previous.draft.points.slice(
          0,
          -1,
        );

        return {
          ...previous,
          draft:
            remaining.length > 0
              ? {
                  ...previous.draft,
                  points: remaining,
                }
              : null,
          revision: previous.revision + 1,
        };
      });
    },
    [],
  );

  // ==========================================================
  // 14 — CANCEL UNFINISHED DRAWING
  // ==========================================================

  const cancelDraft = useCallback(
    (): void => {
      setState((previous) => (
        previous.draft === null
          ? previous
          : {
              ...previous,
              draft: null,
              revision: previous.revision + 1,
            }
      ));
    },
    [],
  );

  // ==========================================================
  // 15 — REMOVE ONE MEASUREMENT
  // ==========================================================

  const removeMeasurement = useCallback(
    (id: string): void => {
      assertMeasurementId(id);

      setState((previous) => {
        if (
          !previous.measurements.some(
            (item) => item.id === id,
          )
        ) {
          return previous;
        }

        return {
          ...previous,
          measurements:
            previous.measurements.filter(
              (item) => item.id !== id,
            ),
          selectedId:
            previous.selectedId === id
              ? null
              : previous.selectedId,
          revision: previous.revision + 1,
        };
      });
    },
    [],
  );

  // ==========================================================
  // 16 — UNDO MOST RECENT COMPLETED MEASUREMENT
  // ==========================================================

  const undoLastMeasurement = useCallback(
    (): void => {
      setState((previous) => {
        if (previous.measurements.length === 0) {
          return previous;
        }

        const remaining =
          previous.measurements.slice(0, -1);

        const selectionStillExists =
          remaining.some(
            (item) => item.id === previous.selectedId,
          );

        return {
          ...previous,
          measurements: remaining,
          selectedId: selectionStillExists
            ? previous.selectedId
            : null,
          revision: previous.revision + 1,
        };
      });
    },
    [],
  );

  // ==========================================================
  // 17 — CLEAR MEASUREMENT HISTORY
  // ==========================================================

  const clearMeasurements = useCallback(
    (): void => {
      setState((previous) => {
        if (
          previous.measurements.length === 0 &&
          previous.selectedId === null &&
          previous.draft === null
        ) {
          return previous;
        }

        return {
          ...previous,
          measurements: [],
          selectedId: null,
          draft: null,
          revision: previous.revision + 1,
        };
      });
    },
    [],
  );

  // ==========================================================
  // 18 — SELECT EXISTING MEASUREMENT
  // ==========================================================

  const selectMeasurement = useCallback(
    (id: string | null): void => {
      if (id !== null) {
        assertMeasurementId(id);
      }

      setState((previous) => {
        if (
          id !== null &&
          !previous.measurements.some(
            (item) => item.id === id,
          )
        ) {
          return previous;
        }

        if (previous.selectedId === id) {
          return previous;
        }

        return {
          ...previous,
          selectedId: id,
          revision: previous.revision + 1,
        };
      });
    },
    [],
  );

  // ==========================================================
  // 19 — MEASUREMENT VISIBILITY
  // ==========================================================

  const setMeasurementVisible = useCallback(
    (
      id: string,
      visible: boolean,
    ): void => {
      assertMeasurementId(id);

      if (typeof visible !== "boolean") {
        throw new MeasurementControllerError(
          "Invalid visibility setting.",
        );
      }

      setState((previous) => {
        const target = previous.measurements.find(
          (item) => item.id === id,
        );

        if (!target || target.visible === visible) {
          return previous;
        }

        return {
          ...previous,
          measurements: previous.measurements.map(
            (item) =>
              item.id === id
                ? { ...item, visible }
                : item,
          ),
          revision: previous.revision + 1,
        };
      });
    },
    [],
  );

  // ==========================================================
  // 20 — RESET
  // ==========================================================

  const reset = useCallback(
    (): void => {
      setState((previous) => ({
        ...initialState(),
        revision: previous.revision + 1,
      }));
    },
    [],
  );

  // ==========================================================
  // 21 — DERIVED STATE
  // ==========================================================

  const selectedMeasurement = useMemo(
    (): StoredMeasurement | null =>
      state.measurements.find(
        (item) => item.id === state.selectedId,
      ) ?? null,
    [state.measurements, state.selectedId],
  );

  const canFinishDraft = canFinish(
    state.draft,
  );

  const canUndoDraft =
    state.draft !== null &&
    state.draft.points.length > 0;

  // ==========================================================
  // 22 — STABLE ACTION BUNDLE
  // ==========================================================

  const actions = useMemo<MeasurementActions>(
    () => ({
      setTool,
      addWorldPoint,
      addScreenPoint,
      finishDraft,
      undoDraftPoint,
      cancelDraft,
      removeMeasurement,
      undoLastMeasurement,
      clearMeasurements,
      selectMeasurement,
      setMeasurementVisible,
      reset,
    }),
    [
      setTool,
      addWorldPoint,
      addScreenPoint,
      finishDraft,
      undoDraftPoint,
      cancelDraft,
      removeMeasurement,
      undoLastMeasurement,
      clearMeasurements,
      selectMeasurement,
      setMeasurementVisible,
      reset,
    ],
  );

  return {
    state,
    actions,
    activeTool: state.activeTool,
    draft: state.draft,
    measurements: state.measurements,
    selectedMeasurement,
    canFinishDraft,
    canUndoDraft,
    hasMeasurements: state.measurements.length > 0,
    measurementCount: state.measurements.length,
  };
}


// ============================================================
// 23 — USER-FACING ERROR ADAPTER
// ============================================================

export function getMeasurementControllerError(
  error: unknown,
): string {
  if (
    error instanceof MeasurementControllerError ||
    (error instanceof Error &&
      error.name === "MeasurementError") ||
    (error instanceof Error &&
      error.name === "MPRError")
  ) {
    return error.message;
  }

  return "The measurement could not be completed.";
}


// ============================================================
// 24 — CAPABILITIES
// ============================================================

export function getMeasurementsHookCapabilities() {
  return {
    coordinateSystem: "DICOM_LPS",
    physicalDistance: true,
    threePointAngle: true,
    polylineLength: true,
    polygonArea: true,
    screenPointPlacement: true,
    draftUndo: true,
    historyRemoval: true,
    measurementVisibility: true,
    measurementSelection: true,
    automaticPersistence: false,
    originalDatasetModification: false,
    clinicalValidationComplete: false,
  } as const;
}


// ============================================================
// END OF SINUS VIEWER REACT MEASUREMENT CONTROLLER
// ============================================================
