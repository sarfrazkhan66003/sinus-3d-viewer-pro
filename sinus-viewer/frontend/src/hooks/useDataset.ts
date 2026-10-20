
/**
 * SINUS VIEWER — REACT DATASET HOOK
 * =================================
 *
 * React 18 integration for FrontendDatasetService.
 *
 * Features:
 * - useSyncExternalStore for consistent subscriptions.
 * - One stable service instance per hook owner.
 * - Dataset selection and refresh actions.
 * - Patient and series browser actions.
 * - Series validation and viewer-ready selection.
 * - Safe state reset and logical cancellation.
 * - Cleanup on component unmount.
 * - Explicit authentication-session reset support.
 *
 * SECURITY:
 * - No original DICOM file operations.
 * - No browser persistent storage.
 * - No logging of patient names, paths or UIDs.
 * - Backend remains authoritative for authorization.
 * - Only opaque handles are retained in service state.
 *
 * IMPORTANT:
 * File 46 currently implements logical cancellation.
 * Pending HTTP requests may complete, but their
 * responses cannot update state after invalidation.
 *
 * The returned actions are intended for user-driven
 * controls; do not call them during React render.
 */

import {
  useCallback,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react";

import {
  createDatasetService,
  DatasetBrowserError,
  FrontendDatasetService,
  type DatasetBrowserState,
} from "../services/datasetService";


// ============================================================
// 01 — PUBLIC TYPES
// ============================================================

export interface DatasetViewerSelection {
  readonly datasetSessionId: string;
  readonly seriesHandle: string;
}

export interface DatasetActions {
  readonly listDatasets: () => Promise<void>;

  readonly selectDataset: (
    datasetPath: string,
  ) => Promise<void>;

  readonly selectExistingDataset: (
    datasetSessionId: string,
  ) => void;

  readonly reloadSelectedDataset: () => Promise<void>;

  readonly refreshDataset: () => Promise<void>;

  readonly closeDataset: (
    datasetSessionId?: string,
  ) => Promise<void>;

  readonly loadPatients: () => Promise<void>;

  readonly selectPatient: (
    patientHandle: string,
  ) => Promise<void>;

  readonly selectSeries: (
    seriesHandle: string,
  ) => Promise<void>;

  readonly cancelPending: () => void;

  readonly reset: () => void;

  readonly getViewerSelection: (
  ) => DatasetViewerSelection | null;
}

export interface UseDatasetResult {
  readonly state: DatasetBrowserState;
  readonly actions: DatasetActions;
  readonly service: FrontendDatasetService;

  readonly isLoading: boolean;
  readonly isReady: boolean;
  readonly requiresAuthentication: boolean;

  readonly hasSelectedDataset: boolean;
  readonly hasSelectedPatient: boolean;
  readonly hasSelectedSeries: boolean;

  readonly viewerSelection: DatasetViewerSelection | null;
}


// ============================================================
// 02 — SERVICE OWNERSHIP
// ============================================================

/**
 * Create a stable dataset service for this hook instance.
 *
 * useState initializer is evaluated once for a committed
 * React hook instance. React StrictMode may perform
 * development checks; constructing a service has no
 * network or filesystem side effects.
 */
function useOwnedDatasetService(): FrontendDatasetService {
  const [service] = useState<FrontendDatasetService>(
    () => createDatasetService(),
  );

  useEffect(() => {
    return () => {
      /**
       * Invalidate pending responses and clear dataset
       * state when the owner unmounts.
       *
       * We intentionally avoid dispose() in this cleanup:
       * React 18 StrictMode replays effect setup/cleanup
       * during development. Disposing here would leave
       * the same service permanently unusable after replay.
       *
       * Reset is idempotent, so StrictMode replay is safe.
       *
       * When this hook owner is actually removed, React
       * releases its reference to the service. Any still
       * running request may retain it temporarily until
       * that request settles.
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
 * Subscribe to an existing service.
 *
 * Use this when a parent component or context owns the
 * service lifetime, so multiple child components can
 * observe exactly the same dataset browser state.
 *
 * This hook does not reset or dispose external services.
 */
export function useDatasetSnapshot(
  service: FrontendDatasetService,
): DatasetBrowserState {
  return useSyncExternalStore(
    service.subscribe,
    service.getSnapshot,
    service.getSnapshot,
  );
}


// ============================================================
// 04 — SERVICE ACTION ADAPTER
// ============================================================

/**
 * Stable React action wrappers around the service methods.
 *
 * Promise rejections remain observable to the caller for
 * action-specific UI feedback. Synchronous invalid input
 * errors also propagate to the caller.
 */
export function useDatasetActions(
  service: FrontendDatasetService,
): DatasetActions {
  const listDatasets = useCallback(
    (): Promise<void> => service.listDatasets(),
    [service],
  );

  const selectDataset = useCallback(
    (datasetPath: string): Promise<void> =>
      service.selectDataset(datasetPath),
    [service],
  );

  const selectExistingDataset = useCallback(
    (datasetSessionId: string): void => {
      service.selectExistingDataset(datasetSessionId);
    },
    [service],
  );

  const reloadSelectedDataset = useCallback(
    (): Promise<void> =>
      service.reloadSelectedDataset(),
    [service],
  );

  const refreshDataset = useCallback(
    (): Promise<void> => service.refreshDataset(),
    [service],
  );

  const closeDataset = useCallback(
    (datasetSessionId?: string): Promise<void> =>
      service.closeDataset(datasetSessionId),
    [service],
  );

  const loadPatients = useCallback(
    (): Promise<void> => service.loadPatients(),
    [service],
  );

  const selectPatient = useCallback(
    (patientHandle: string): Promise<void> =>
      service.selectPatient(patientHandle),
    [service],
  );

  const selectSeries = useCallback(
    (seriesHandle: string): Promise<void> =>
      service.selectSeries(seriesHandle),
    [service],
  );

  const cancelPending = useCallback(
    (): void => service.cancelPending(),
    [service],
  );

  const reset = useCallback(
    (): void => service.reset(),
    [service],
  );

  const getViewerSelection = useCallback(
    (): DatasetViewerSelection | null =>
      service.getViewerSelection(),
    [service],
  );

  return {
    listDatasets,
    selectDataset,
    selectExistingDataset,
    reloadSelectedDataset,
    refreshDataset,
    closeDataset,
    loadPatients,
    selectPatient,
    selectSeries,
    cancelPending,
    reset,
    getViewerSelection,
  };
}


// ============================================================
// 05 — MAIN REACT DATASET HOOK
// ============================================================

/**
 * Self-contained dataset browser hook.
 *
 * Each invocation owns a separate service.
 * Use it once at the dataset-browser container level,
 * not independently in every row or child component.
 *
 * If multiple components must share dataset state,
 * create the service in their common owner and pass
 * it to useDatasetSnapshot() and useDatasetActions().
 */
export function useDataset(): UseDatasetResult {
  const service = useOwnedDatasetService();

  const state = useDatasetSnapshot(service);
  const actions = useDatasetActions(service);

  const isLoading = state.status === "loading";

  const isReady = state.status === "ready";

  const requiresAuthentication =
    state.status === "authentication-required";

  const hasSelectedDataset =
    state.selectedDataset !== null;

  const hasSelectedPatient =
    state.selectedPatientHandle !== null;

  const hasSelectedSeries =
    state.selectedSeriesHandle !== null;

  /**
   * Determine viewer readiness from the current
   * subscribed snapshot, not from a cached stale
   * selection object.
   */
  const selectedSeries = state.selectedSeriesHandle;
  const selectedDataset = state.selectedDataset;
  const validation = state.validation;

  const viewerSelection: DatasetViewerSelection | null =
    selectedDataset &&
    selectedSeries &&
    validation &&
    validation.series_handle === selectedSeries &&
    validation.volume_ready
      ? {
          datasetSessionId:
            selectedDataset.dataset_session_id,
          seriesHandle: selectedSeries,
        }
      : null;

  return {
    state,
    actions,
    service,
    isLoading,
    isReady,
    requiresAuthentication,
    hasSelectedDataset,
    hasSelectedPatient,
    hasSelectedSeries,
    viewerSelection,
  };
}


// ============================================================
// 06 — SAFE ACTION ERROR CLASSIFICATION
// ============================================================

/**
 * Optional helper for UI handlers.
 *
 * Does not display raw API errors or internal file paths.
 * Errors already sanitized by DatasetBrowserError
 * retain their safe human-readable message.
 */
export function getDatasetActionError(
  error: unknown,
): string {
  if (error instanceof DatasetBrowserError) {
    return error.message;
  }

  return "The dataset operation could not be completed.";
}


// ============================================================
// 07 — HOOK CAPABILITIES
// ============================================================

export function getDatasetHookCapabilities() {
  return {
    reactExternalStore: true,
    stablePerOwnerService: true,
    snapshotSubscriptions: true,
    datasetSelection: true,
    patientBrowsing: true,
    seriesBrowsing: true,
    seriesValidation: true,
    staleResponseProtection: true,
    logicalCancellation: true,
    transportCancellation: false,
    persistentBrowserStorage: false,
    modifiesSourceDataset: false,
  } as const;
}


// ============================================================
// END OF SINUS VIEWER REACT DATASET HOOK
// ============================================================
