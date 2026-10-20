
/**
 * SINUS VIEWER — VIEWPORT STATE COORDINATOR
 * =========================================
 *
 * File 107
 *
 * Central, parent-owned state coordination
 * for axial, coronal and sagittal MPR viewports.
 *
 * Features:
 * - Controlled active plane.
 * - Explicit authorization state.
 * - Per-plane rendering lifecycle.
 * - Volume revision tracking.
 * - Stale completion rejection.
 * - Safe interaction availability decisions.
 * - Geometry verification tracking.
 * - Synchronization acknowledgment tracking.
 * - React reducer-based state management.
 *
 * This file DOES NOT:
 * - Load DICOM files.
 * - Modify dataset files.
 * - Render or decode image pixels.
 * - Calculate clinical coordinates.
 * - Perform backend authorization.
 * - Persist patient identifiers.
 *
 * A backend authorization boundary is required
 * independently of these UI state checks.
 */

import {
  useCallback,
  useMemo,
  useReducer,
  type ReactNode,
} from "react";

// ============================================================
// 01 — PUBLIC TYPES
// ============================================================

export type CoordinatedViewportPlane =
  | "axial"
  | "coronal"
  | "sagittal";

export type CoordinatedViewportPhase =
  | "idle"
  | "loading"
  | "decoding"
  | "preparing"
  | "rendering"
  | "ready"
  | "unavailable"
  | "error";

export interface CoordinatedPlaneState {
  readonly phase: CoordinatedViewportPhase;
  readonly renderRevision: number;
  readonly completedRevision: number | null;
  readonly geometryVerified: boolean;
  readonly syncConfirmed: boolean;
}

export interface ViewportCoordinatorState {
  readonly authorized: boolean;
  readonly volumeRevision: number;
  readonly activePlane: CoordinatedViewportPlane;
  readonly planes: Readonly<
    Record<
      CoordinatedViewportPlane,
      CoordinatedPlaneState
    >
  >;
}

export interface ViewportCoordinatorAvailability {
  readonly plane: CoordinatedViewportPlane;
  readonly phase: CoordinatedViewportPhase;
  readonly authorized: boolean;
  readonly canInteract: boolean;
  readonly canFocus: boolean;
  readonly canScheduleRender: boolean;
  readonly geometryVerified: boolean;
  readonly currentRenderConfirmed: boolean;
  readonly syncConfirmed: boolean;
}

export type ViewportCoordinatorAction =
  | {
      readonly type: "SET_AUTHORIZED";
      readonly authorized: boolean;
    }
  | {
      readonly type: "RESET_VOLUME";
    }
  | {
      readonly type: "SET_ACTIVE_PLANE";
      readonly plane: CoordinatedViewportPlane;
    }
  | {
      readonly type: "SET_PHASE";
      readonly plane: CoordinatedViewportPlane;
      readonly phase: CoordinatedViewportPhase;
      readonly revision: number;
    }
  | {
      readonly type: "REQUEST_RENDER";
      readonly plane: CoordinatedViewportPlane;
    }
  | {
      readonly type: "CONFIRM_RENDER";
      readonly plane: CoordinatedViewportPlane;
      readonly revision: number;
    }
  | {
      readonly type: "FAIL_RENDER";
      readonly plane: CoordinatedViewportPlane;
      readonly revision: number;
    }
  | {
      readonly type: "SET_GEOMETRY_VERIFIED";
      readonly plane: CoordinatedViewportPlane;
      readonly verified: boolean;
    }
  | {
      readonly type: "SET_SYNC_CONFIRMED";
      readonly plane: CoordinatedViewportPlane;
      readonly confirmed: boolean;
    };

export interface UseViewportStateCoordinatorOptions {
  readonly initialPlane?: CoordinatedViewportPlane;
  readonly initiallyAuthorized?: boolean;
}

export interface ViewportStateCoordinatorProps
  extends UseViewportStateCoordinatorOptions {
  readonly children: (
    coordinator: ReturnType<
      typeof useViewportStateCoordinator
    >,
  ) => ReactNode;
}

// ============================================================
// 02 — CONSTANTS
// ============================================================

export const COORDINATED_VIEWPORT_PLANES:
  readonly CoordinatedViewportPlane[] = [
    "axial",
    "coronal",
    "sagittal",
  ];

const MAX_SAFE_REVISION =
  Number.MAX_SAFE_INTEGER;

// ============================================================
// 03 — VALIDATION HELPERS
// ============================================================

export function isCoordinatedViewportPlane(
  value: unknown,
): value is CoordinatedViewportPlane {
  return (
    value === "axial" ||
    value === "coronal" ||
    value === "sagittal"
  );
}

export function isCoordinatedViewportPhase(
  value: unknown,
): value is CoordinatedViewportPhase {
  return (
    value === "idle" ||
    value === "loading" ||
    value === "decoding" ||
    value === "preparing" ||
    value === "rendering" ||
    value === "ready" ||
    value === "unavailable" ||
    value === "error"
  );
}

export function isValidCoordinatorRevision(
  revision: number,
): boolean {
  return (
    Number.isSafeInteger(revision) &&
    revision >= 0
  );
}

function nextCoordinatorRevision(
  revision: number,
): number {
  if (
    !isValidCoordinatorRevision(revision) ||
    revision >= MAX_SAFE_REVISION
  ) {
    // Fail closed: reset state instead of using
    // an unsafe revision number.
    return 0;
  }

  return revision + 1;
}

// ============================================================
// 04 — DEFAULT STATE
// ============================================================

export function createCoordinatedPlaneState():
  CoordinatedPlaneState {
  return {
    phase: "idle",
    renderRevision: 0,
    completedRevision: null,
    geometryVerified: false,
    syncConfirmed: false,
  };
}

export function createViewportCoordinatorState(
  options: UseViewportStateCoordinatorOptions = {},
): ViewportCoordinatorState {
  const initialPlane =
    options.initialPlane &&
    isCoordinatedViewportPlane(
      options.initialPlane,
    )
      ? options.initialPlane
      : "axial";

  return {
    authorized:
      options.initiallyAuthorized === true,
    volumeRevision: 0,
    activePlane: initialPlane,
    planes: {
      axial: createCoordinatedPlaneState(),
      coronal: createCoordinatedPlaneState(),
      sagittal: createCoordinatedPlaneState(),
    },
  };
}

// ============================================================
// 05 — IMMUTABLE PLANE UPDATE
// ============================================================

function replacePlaneState(
  state: ViewportCoordinatorState,
  plane: CoordinatedViewportPlane,
  updated: CoordinatedPlaneState,
): ViewportCoordinatorState {
  return {
    ...state,
    planes: {
      ...state.planes,
      [plane]: updated,
    },
  };
}

// ============================================================
// 06 — PURE REDUCER
// ============================================================

/**
 * Each render completion carries its revision.
 * An outdated completion is never allowed to
 * change the current plane to ready.
 *
 * Parent also must invalidate the underlying
 * scheduler when volume/authorization changes.
 */
export function viewportCoordinatorReducer(
  state: ViewportCoordinatorState,
  action: ViewportCoordinatorAction,
): ViewportCoordinatorState {
  switch (action.type) {
    case "SET_AUTHORIZED": {
      if (action.authorized !== true) {
        return {
          ...createViewportCoordinatorState({
            initialPlane: state.activePlane,
          }),
          volumeRevision:
            nextCoordinatorRevision(
              state.volumeRevision,
            ),
        };
      }

      if (state.authorized) {
        return state;
      }

      return {
        ...state,
        authorized: true,
      };
    }

    case "RESET_VOLUME": {
      return {
        ...createViewportCoordinatorState({
          initialPlane: state.activePlane,
          initiallyAuthorized: state.authorized,
        }),
        volumeRevision:
          nextCoordinatorRevision(
            state.volumeRevision,
          ),
      };
    }

    case "SET_ACTIVE_PLANE": {
      if (
        !state.authorized ||
        !isCoordinatedViewportPlane(
          action.plane,
        )
      ) {
        return state;
      }

      const target = state.planes[action.plane];

      if (target.phase !== "ready") {
        return state;
      }

      if (state.activePlane === action.plane) {
        return state;
      }

      return {
        ...state,
        activePlane: action.plane,
      };
    }

    case "SET_PHASE": {
      if (
        !state.authorized ||
        !isCoordinatedViewportPlane(
          action.plane,
        ) ||
        !isCoordinatedViewportPhase(
          action.phase,
        )
      ) {
        return state;
      }

      const current = state.planes[action.plane];

      if (
        !isValidCoordinatorRevision(
          action.revision,
        ) ||
        action.revision !==
          current.renderRevision
      ) {
        return state;
      }

      // A ready state is created only through
      // CONFIRM_RENDER, never SET_PHASE.
      if (action.phase === "ready") {
        return state;
      }

      return replacePlaneState(
        state,
        action.plane,
        {
          ...current,
          phase: action.phase,
          completedRevision: null,
          syncConfirmed: false,
        },
      );
    }

    case "REQUEST_RENDER": {
      if (
        !state.authorized ||
        !isCoordinatedViewportPlane(
          action.plane,
        )
      ) {
        return state;
      }

      const current = state.planes[action.plane];

      const nextRevision =
        nextCoordinatorRevision(
          current.renderRevision,
        );

      // Wrapping to zero cannot preserve identity
      // across outstanding async work. Refuse
      // further requests until a new session
      // coordinator is initialized.
      if (
        nextRevision <=
        current.renderRevision
      ) {
        return state;
      }

      return replacePlaneState(
        state,
        action.plane,
        {
          ...current,
          phase: "rendering",
          renderRevision: nextRevision,
          completedRevision: null,
          syncConfirmed: false,
        },
      );
    }

    case "CONFIRM_RENDER": {
      if (
        !state.authorized ||
        !isCoordinatedViewportPlane(
          action.plane,
        )
      ) {
        return state;
      }

      const current = state.planes[action.plane];

      if (
        !isValidCoordinatorRevision(
          action.revision,
        ) ||
        current.phase === "idle" ||
        current.phase === "unavailable" ||
        current.phase === "error" ||
        action.revision !==
          current.renderRevision
      ) {
        return state;
      }

      return replacePlaneState(
        state,
        action.plane,
        {
          ...current,
          phase: "ready",
          completedRevision: action.revision,
          syncConfirmed: false,
        },
      );
    }

    case "FAIL_RENDER": {
      if (
        !state.authorized ||
        !isCoordinatedViewportPlane(
          action.plane,
        )
      ) {
        return state;
      }

      const current = state.planes[action.plane];

      if (
        !isValidCoordinatorRevision(
          action.revision,
        ) ||
        action.revision !==
          current.renderRevision
      ) {
        return state;
      }

      return replacePlaneState(
        state,
        action.plane,
        {
          ...current,
          phase: "error",
          completedRevision: null,
          syncConfirmed: false,
        },
      );
    }

    case "SET_GEOMETRY_VERIFIED": {
      if (
        !state.authorized ||
        !isCoordinatedViewportPlane(
          action.plane,
        )
      ) {
        return state;
      }

      const current = state.planes[action.plane];

      const verified =
        action.verified === true;

      if (
        current.geometryVerified === verified
      ) {
        return state;
      }

      return replacePlaneState(
        state,
        action.plane,
        {
          ...current,
          geometryVerified: verified,
          syncConfirmed: false,
        },
      );
    }

    case "SET_SYNC_CONFIRMED": {
      if (
        !state.authorized ||
        !isCoordinatedViewportPlane(
          action.plane,
        )
      ) {
        return state;
      }

      const current = state.planes[action.plane];

      const ready =
        current.phase === "ready" &&
        current.geometryVerified &&
        current.completedRevision ===
          current.renderRevision;

      const confirmed =
        action.confirmed === true && ready;

      if (
        current.syncConfirmed === confirmed
      ) {
        return state;
      }

      return replacePlaneState(
        state,
        action.plane,
        {
          ...current,
          syncConfirmed: confirmed,
        },
      );
    }

    default: {
      return state;
    }
  }
}

// ============================================================
// 07 — AVAILABILITY MODEL
// ============================================================

export function getViewportCoordinatorAvailability(
  state: ViewportCoordinatorState,
  plane: CoordinatedViewportPlane,
): ViewportCoordinatorAvailability {
  const planeState = state.planes[plane];

  const confirmed =
    planeState.phase === "ready" &&
    planeState.completedRevision ===
      planeState.renderRevision;

  const canInteract =
    state.authorized === true &&
    confirmed;

  const canScheduleRender =
    state.authorized === true &&
    planeState.phase !== "unavailable" &&
    planeState.phase !== "error";

  return {
    plane,
    phase: planeState.phase,
    authorized: state.authorized,
    canInteract,
    canFocus: canInteract,
    canScheduleRender,
    geometryVerified:
      state.authorized &&
      planeState.geometryVerified,
    currentRenderConfirmed: confirmed,
    syncConfirmed:
      canInteract &&
      planeState.geometryVerified &&
      planeState.syncConfirmed,
  };
}

// ============================================================
// 08 — REACT HOOK
// ============================================================

export function useViewportStateCoordinator(
  options: UseViewportStateCoordinatorOptions = {},
) {
  const [state, dispatch] = useReducer(
    viewportCoordinatorReducer,
    options,
    createViewportCoordinatorState,
  );

  const setAuthorized = useCallback(
    (authorized: boolean): void => {
      dispatch({
        type: "SET_AUTHORIZED",
        authorized,
      });
    },
    [],
  );

  const resetVolume = useCallback((): void => {
    dispatch({
      type: "RESET_VOLUME",
    });
  }, []);

  const setActivePlane = useCallback(
    (plane: CoordinatedViewportPlane): void => {
      dispatch({
        type: "SET_ACTIVE_PLANE",
        plane,
      });
    },
    [],
  );

  const requestRender = useCallback(
    (plane: CoordinatedViewportPlane): void => {
      dispatch({
        type: "REQUEST_RENDER",
        plane,
      });
    },
    [],
  );

  const setPhase = useCallback(
    (
      plane: CoordinatedViewportPlane,
      phase: CoordinatedViewportPhase,
      revision: number,
    ): void => {
      dispatch({
        type: "SET_PHASE",
        plane,
        phase,
        revision,
      });
    },
    [],
  );

  const confirmRender = useCallback(
    (
      plane: CoordinatedViewportPlane,
      revision: number,
    ): void => {
      dispatch({
        type: "CONFIRM_RENDER",
        plane,
        revision,
      });
    },
    [],
  );

  const failRender = useCallback(
    (
      plane: CoordinatedViewportPlane,
      revision: number,
    ): void => {
      dispatch({
        type: "FAIL_RENDER",
        plane,
        revision,
      });
    },
    [],
  );

  const setGeometryVerified = useCallback(
    (
      plane: CoordinatedViewportPlane,
      verified: boolean,
    ): void => {
      dispatch({
        type: "SET_GEOMETRY_VERIFIED",
        plane,
        verified,
      });
    },
    [],
  );

  const setSyncConfirmed = useCallback(
    (
      plane: CoordinatedViewportPlane,
      confirmed: boolean,
    ): void => {
      dispatch({
        type: "SET_SYNC_CONFIRMED",
        plane,
        confirmed,
      });
    },
    [],
  );

  const availability = useMemo(
    () => ({
      axial: getViewportCoordinatorAvailability(
        state,
        "axial",
      ),
      coronal: getViewportCoordinatorAvailability(
        state,
        "coronal",
      ),
      sagittal: getViewportCoordinatorAvailability(
        state,
        "sagittal",
      ),
    }),
    [state],
  );

  return {
    state,
    availability,
    dispatch,
    setAuthorized,
    resetVolume,
    setActivePlane,
    requestRender,
    setPhase,
    confirmRender,
    failRender,
    setGeometryVerified,
    setSyncConfirmed,
  };
}

// ============================================================
// 09 — OPTIONAL RENDER-PROP CONTROLLER
// ============================================================

export function ViewportStateCoordinator({
  children,
  initialPlane = "axial",
  initiallyAuthorized = false,
}: ViewportStateCoordinatorProps) {
  const coordinator = useViewportStateCoordinator({
    initialPlane,
    initiallyAuthorized,
  });

  return <>{children(coordinator)}</>;
}

// ============================================================
// 10 — CAPABILITIES
// ============================================================

export function getViewportStateCoordinatorCapabilities() {
  return {
    axialSupport: true,
    coronalSupport: true,
    sagittalSupport: true,
    controlledActivePlane: true,
    parentOwnedAuthorization: true,
    volumeRevisionTracking: true,
    perPlaneRenderRevisions: true,
    staleCompletionRejection: true,
    readyConfirmationRequired: true,
    geometryVerificationState: true,
    synchronizationConfirmationState: true,
    interactionAvailabilityModel: true,
    focusAvailabilityModel: true,
    ReactReducerState: true,
    stableActionCallbacks: true,
    renderPropController: true,
    actualDICOMRendering: false,
    backendAuthorizationEnforcement: false,
    imageCoordinateValidation: false,
    globalKeyboardControl: false,
    directNetworkRequests: false,
    browserPersistence: false,
    sourceDatasetModification: false,
    clinicalValidationComplete: false,
  } as const;
}

// ============================================================
// END OF SINUS VIEWER VIEWPORT STATE COORDINATOR — FILE 107
// ============================================================
