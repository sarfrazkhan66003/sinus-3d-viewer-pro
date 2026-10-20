
/**
 * SINUS VIEWER — REACT VOLUME HOOK
 * =================================
 *
 * React 18 integration for FrontendVolumeService.
 *
 * Features:
 * - useSyncExternalStore subscriptions.
 * - Stable service ownership per hook instance.
 * - Authorized volume loading through File 47.
 * - Progress, error and authentication-expiry states.
 * - Explicit load cancellation.
 * - Volume reset on selection change or logout.
 * - Cleanup compatible with React StrictMode replay.
 * - Access to decoded Float32 voxel data and geometry.
 *
 * SECURITY:
 * - No patient identifiers, UIDs or source paths in logs.
 * - No persistent browser storage.
 * - No original DICOM file modifications.
 * - Backend remains responsible for authorization.
 *
 * IMPORTANT:
 * Loaded voxel buffers can contain sensitive medical data.
 * Never persist or transmit them to unrelated services.
 */

import {
  useCallback,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react";

import {
  createVolumeService,
  FrontendVolumeError,
  type FrontendVolumeService,
  type LoadedVolume,
  type VolumeLoadOptions,
  type VolumeLoadProgress,
  type VolumeServiceOptions,
  type VolumeServiceSnapshot,
} from "../services/volumeService";


// ============================================================
// 01 — PUBLIC TYPES
// ============================================================

export interface VolumeSelection {
  readonly datasetSessionId: string;
  readonly seriesHandle: string;
}

export interface VolumeActions {
  readonly load: (
    selection: VolumeSelection,
    options?: VolumeLoadOptions,
  ) => Promise<LoadedVolume>;

  readonly cancel: () => void;
  readonly reset: () => void;

  readonly getVoxel: (
    z: number,
    y: number,
    x: number,
  ) => number | null;
}

export interface UseVolumeResult {
  readonly state: VolumeServiceSnapshot;
  readonly progress: VolumeLoadProgress;
  readonly volume: LoadedVolume | null;
  readonly actions: VolumeActions;
  readonly service: FrontendVolumeService;

  readonly isLoading: boolean;
  readonly isReady: boolean;
  readonly isCancelled: boolean;
  readonly hasError: boolean;
  readonly requiresAuthentication: boolean;
  readonly hasVolume: boolean;
}


// ============================================================
// 02 — STABLE SERVICE OWNERSHIP
// ============================================================

/**
 * Creates one service for the committed hook owner.
 *
 * Configuration is captured at initialization.
 * To change the memory limit or chunk size, remount
 * the owning component with a new React key.
 *
 * No network request occurs during construction.
 */
function useOwnedVolumeService(
  options?: VolumeServiceOptions,
): FrontendVolumeService {
  const [service] = useState<FrontendVolumeService>(
    () => createVolumeService(options),
  );

  useEffect(() => {
    return () => {
      /**
       * React StrictMode can replay effect cleanup and
       * setup during development.
       *
       * reset() cancels active requests and releases
       * the current volume reference without permanently
       * disposing the service.
       *
       * dispose() is intentionally not used here because
       * that would make a replayed service unusable.
       */
      service.reset();
    };
  }, [service]);

  return service;
}


// ============================================================
// 03 — EXTERNAL STORE SUBSCRIPTION
// ============================================================

/**
 * Observe an existing FrontendVolumeService.
 *
 * Use this function when a parent/context owns the
 * service and multiple viewers share its state.
 *
 * The external service is not reset on unmount.
 */
export function useVolumeSnapshot(
  service: FrontendVolumeService,
): VolumeServiceSnapshot {
  return useSyncExternalStore(
    service.subscribe,
    service.getSnapshot,
    service.getSnapshot,
  );
}


// ============================================================
// 04 — STABLE ACTION ADAPTER
// ============================================================

export function useVolumeActions(
  service: FrontendVolumeService,
): VolumeActions {
  const load = useCallback(
    (
      selection: VolumeSelection,
      options: VolumeLoadOptions = {},
    ): Promise<LoadedVolume> => {
      return service.load(
        selection.datasetSessionId,
        selection.seriesHandle,
        options,
      );
    },
    [service],
  );

  const cancel = useCallback(
    (): void => {
      service.cancel();
    },
    [service],
  );

  const reset = useCallback(
    (): void => {
      service.reset();
    },
    [service],
  );

  const getVoxel = useCallback(
    (
      z: number,
      y: number,
      x: number,
    ): number | null => {
      return service.getVoxel(z, y, x);
    },
    [service],
  );

  return {
    load,
    cancel,
    reset,
    getVoxel,
  };
}


// ============================================================
// 05 — MAIN REACT VOLUME HOOK
// ============================================================

/**
 * Self-contained volume hook for one viewer owner.
 *
 * Call once in the viewer container and pass state/actions
 * down to axial, coronal, sagittal and 3D child views.
 *
 * Calling useVolume() independently in all four views
 * would allocate separate services and may download
 * the same medical volume multiple times.
 */
export function useVolume(
  options?: VolumeServiceOptions,
): UseVolumeResult {
  const service = useOwnedVolumeService(options);

  const state = useVolumeSnapshot(service);
  const actions = useVolumeActions(service);

  const progress = state.progress;
  const volume = state.volume;

  const isLoading =
    progress.status === "preparing" ||
    progress.status === "downloading";

  const isReady =
    progress.status === "ready" &&
    volume !== null;

  const isCancelled =
    progress.status === "cancelled";

  const hasError =
    progress.status === "error";

  const requiresAuthentication =
    progress.status === "authentication-required";

  const hasVolume = volume !== null;

  return {
    state,
    progress,
    volume,
    actions,
    service,
    isLoading,
    isReady,
    isCancelled,
    hasError,
    requiresAuthentication,
    hasVolume,
  };
}


// ============================================================
// 06 — ERROR MESSAGE ADAPTER
// ============================================================

/**
 * Returns controlled errors appropriate for the UI.
 *
 * Do not pass raw unknown error objects to React error
 * boundaries, browser analytics or application logs.
 */
export function getVolumeActionError(
  error: unknown,
): string {
  if (error instanceof FrontendVolumeError) {
    return error.message;
  }

  return "The volume operation could not be completed.";
}


// ============================================================
// 07 — SAFE VOLUME SELECTION COMPARISON
// ============================================================

/**
 * Compare server-issued opaque handles without exposing
 * original dataset paths or DICOM identifiers.
 *
 * Useful for detecting whether a React viewer selection
 * has changed and whether old loaded voxels must be reset.
 */
export function isSameVolumeSelection(
  first: VolumeSelection | null,
  second: VolumeSelection | null,
): boolean {
  if (first === null || second === null) {
    return first === second;
  }

  return (
    first.datasetSessionId === second.datasetSessionId &&
    first.seriesHandle === second.seriesHandle
  );
}


// ============================================================
// 08 — HOOK CAPABILITIES
// ============================================================

export function getVolumeHookCapabilities() {
  return {
    reactExternalStore: true,
    stablePerOwnerService: true,
    progressSubscriptions: true,
    voxelBufferAccess: true,
    geometryAccess: true,
    cancellableRangeDownloads: true,
    staleResponseProtection: true,
    memoryLimitEnforcement: true,
    automaticLoadOnMount: false,
    persistentBrowserStorage: false,
    modifiesSourceDataset: false,
    clinicalValidationComplete: false,
  } as const;
}


// ============================================================
// END OF SINUS VIEWER REACT VOLUME HOOK
// ============================================================
