
/**
 * SINUS VIEWER — FRONTEND DATASET SERVICE
 * =======================================
 *
 * Coordinates:
 * - Dataset selection, listing, refresh and close.
 * - Authorized patient and series discovery.
 * - Series validation.
 * - React-compatible state subscriptions.
 * - Stale response suppression using request versions.
 * - Safe errors and authentication-expiry handling.
 *
 * Security:
 * - Only opaque handles are retained in browser state.
 * - The selected filesystem path is never retained.
 * - Authentication remains enforced by FastAPI.
 * - No credential, patient metadata or image bytes are logged.
 * - No localStorage/sessionStorage persistence.
 * - No original DICOM dataset operations.
 *
 * Note:
 * File 45's JSON API functions do not yet accept AbortSignal.
 * Therefore cancellation here is logical cancellation:
 * outdated results are ignored, but HTTP requests may finish.
 */

import {
  apiCloseDataset,
  apiGetDataset,
  apiListDatasets,
  apiListPatients,
  apiListSeries,
  apiRefreshDataset,
  apiSelectDataset,
  apiValidateSeries,
  getPublicErrorText,
  isAuthenticationFailure,
} from "./apiClient";

import {
  isOpaqueHandle,
  type DatasetSummary,
  type PatientSummary,
  type SeriesSummary,
  type SeriesValidationResponse,
} from "../types/api";


// ============================================================
// 01 — PUBLIC STATE TYPES
// ============================================================

export type DatasetOperation =
  | "idle"
  | "listing"
  | "selecting"
  | "refreshing"
  | "closing"
  | "loading-patients"
  | "loading-series"
  | "validating-series";

export type DatasetServiceStatus =
  | "idle"
  | "loading"
  | "ready"
  | "error"
  | "authentication-required";

export interface DatasetBrowserState {
  readonly status: DatasetServiceStatus;
  readonly operation: DatasetOperation;
  readonly error: string | null;

  readonly datasets: readonly DatasetSummary[];
  readonly selectedDataset: DatasetSummary | null;

  readonly patients: readonly PatientSummary[];
  readonly selectedPatientHandle: string | null;

  readonly series: readonly SeriesSummary[];
  readonly selectedSeriesHandle: string | null;

  readonly validation: SeriesValidationResponse | null;
}

export type DatasetStateListener = (
  state: DatasetBrowserState,
) => void;


// ============================================================
// 02 — INITIAL STATE
// ============================================================

function initialState(): DatasetBrowserState {
  return {
    status: "idle",
    operation: "idle",
    error: null,

    datasets: [],
    selectedDataset: null,

    patients: [],
    selectedPatientHandle: null,

    series: [],
    selectedSeriesHandle: null,

    validation: null,
  };
}

function clearSelection(): Pick<
  DatasetBrowserState,
  | "selectedDataset"
  | "patients"
  | "selectedPatientHandle"
  | "series"
  | "selectedSeriesHandle"
  | "validation"
> {
  return {
    selectedDataset: null,
    patients: [],
    selectedPatientHandle: null,
    series: [],
    selectedSeriesHandle: null,
    validation: null,
  };
}


// ============================================================
// 03 — CONTROLLED SERVICE ERRORS
// ============================================================

export class DatasetBrowserError extends Error {
  readonly authenticationRequired: boolean;

  constructor(
    message: string,
    authenticationRequired = false,
  ) {
    super(message);
    this.name = "DatasetBrowserError";
    this.authenticationRequired = authenticationRequired;
  }
}

function publicError(error: unknown): DatasetBrowserError {
  const authFailure = isAuthenticationFailure(error);

  return new DatasetBrowserError(
    authFailure
      ? "Your session has expired. Sign in again."
      : getPublicErrorText(error),
    authFailure,
  );
}


// ============================================================
// 04 — STATE MANAGEMENT
// ============================================================

export class FrontendDatasetService {
  private currentState: DatasetBrowserState = initialState();

  private readonly listeners =
    new Set<DatasetStateListener>();

  /**
   * Each new operation invalidates previous operations.
   * A response may update state only if its request ID
   * still matches the current request generation.
   */
  private requestVersion = 0;

  /**
   * Changing dataset selection also invalidates dependent
   * patient / series / validation response data.
   */
  private selectionVersion = 0;

  private disposed = false;

  getSnapshot = (): DatasetBrowserState => {
    return this.currentState;
  };

  subscribe = (
    listener: DatasetStateListener,
  ): (() => void) => {
    if (this.disposed) {
      return () => undefined;
    }

    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  };

  private publish(
    next: DatasetBrowserState,
  ): void {
    if (this.disposed) {
      return;
    }

    this.currentState = next;

    for (const listener of this.listeners) {
      try {
        listener(next);
      } catch {
        // A listener cannot prevent other subscribers
        // from receiving state updates.
      }
    }
  }

  private patch(
    change: Partial<DatasetBrowserState>,
  ): void {
    this.publish({
      ...this.currentState,
      ...change,
    });
  }

  private start(
    operation: DatasetOperation,
  ): number {
    const version = ++this.requestVersion;

    this.patch({
      status: "loading",
      operation,
      error: null,
    });

    return version;
  }

  private current(version: number): boolean {
    return (
      !this.disposed &&
      version === this.requestVersion
    );
  }

  private finishError(
    error: unknown,
    version: number,
  ): void {
    if (!this.current(version)) {
      return;
    }

    const failure = publicError(error);

    if (failure.authenticationRequired) {
      this.selectionVersion++;

      this.patch({
        ...clearSelection(),
        datasets: [],
        status: "authentication-required",
        operation: "idle",
        error: failure.message,
      });

      return;
    }

    this.patch({
      status: "error",
      operation: "idle",
      error: failure.message,
    });
  }

  private requireHandle(value: string): void {
    if (!isOpaqueHandle(value)) {
      throw new DatasetBrowserError(
        "The selected resource is invalid.",
      );
    }
  }

  private ensureActive(): void {
    if (this.disposed) {
      throw new DatasetBrowserError(
        "The dataset browser is unavailable.",
      );
    }
  }

  /**
   * Explicitly invalidate pending updates.
   *
   * This does not abort network requests in File 45.
   * It prevents completed stale responses from being used.
   */
  cancelPending(): void {
    if (this.disposed) {
      return;
    }

    this.requestVersion++;
    this.selectionVersion++;

    this.patch({
      status: this.currentState.selectedDataset
        ? "ready"
        : "idle",
      operation: "idle",
      error: null,
    });
  }

  /**
   * Called during sign-out or session invalidation.
   * Clears patient-linked browser state immediately.
   */
  reset(): void {
    if (this.disposed) {
      return;
    }

    this.requestVersion++;
    this.selectionVersion++;

    this.publish(initialState());
  }

  /**
   * Dispose per-component service instances.
   * No request, file or backend session deletion occurs.
   */
  dispose(): void {
    if (this.disposed) {
      return;
    }

    this.requestVersion++;
    this.selectionVersion++;
    this.disposed = true;

    this.listeners.clear();
    this.currentState = initialState();
  }

  // ==========================================================
  // 05 — LIST DATASETS
  // ==========================================================

  async listDatasets(): Promise<void> {
    this.ensureActive();

    const version = this.start("listing");

    try {
      const response = await apiListDatasets();

      if (!this.current(version)) {
        return;
      }

      const selectedId =
        this.currentState.selectedDataset
          ?.dataset_session_id;

      const selected = selectedId
        ? response.datasets.find(
            (item) => item.dataset_session_id === selectedId,
          ) ?? null
        : null;

      const selectionChanged =
        Boolean(selectedId) && selected === null;

      if (selectionChanged) {
        this.selectionVersion++;
      }

      this.patch({
        ...(selectionChanged ? clearSelection() : {}),
        datasets: [...response.datasets],
        selectedDataset: selected,
        status: "ready",
        operation: "idle",
        error: null,
      });
    } catch (error: unknown) {
      this.finishError(error, version);
    }
  }

  // ==========================================================
  // 06 — SELECT DATASET
  // ==========================================================

  async selectDataset(datasetPath: string): Promise<void> {
    this.ensureActive();

    if (
      typeof datasetPath !== "string" ||
      datasetPath.length < 1 ||
      datasetPath.length > 2048
    ) {
      throw new DatasetBrowserError(
        "Enter a valid dataset location.",
      );
    }

    const version = this.start("selecting");

    // Never retain the original selection path in state.
    this.selectionVersion++;

    this.patch(clearSelection());

    try {
      const response = await apiSelectDataset({
        dataset_path: datasetPath,
      });

      if (!this.current(version)) {
        return;
      }

      const dataset = response.dataset;

      const others = this.currentState.datasets.filter(
        (item) =>
          item.dataset_session_id !==
          dataset.dataset_session_id,
      );

      this.patch({
        ...clearSelection(),
        datasets: [...others, dataset],
        selectedDataset: dataset,
        status: "ready",
        operation: "idle",
        error: null,
      });
    } catch (error: unknown) {
      this.finishError(error, version);
    }
  }

  // ==========================================================
  // 07 — SWITCH SELECTED DATASET
  // ==========================================================

  selectExistingDataset(
    datasetSessionId: string,
  ): void {
    this.ensureActive();
    this.requireHandle(datasetSessionId);

    const dataset = this.currentState.datasets.find(
      (item) =>
        item.dataset_session_id === datasetSessionId,
    );

    if (!dataset) {
      throw new DatasetBrowserError(
        "The dataset is not available.",
      );
    }

    this.requestVersion++;
    this.selectionVersion++;

    this.patch({
      ...clearSelection(),
      selectedDataset: dataset,
      status: "ready",
      operation: "idle",
      error: null,
    });
  }

  // ==========================================================
  // 08 — RELOAD SELECTED DATASET STATUS
  // ==========================================================

  async reloadSelectedDataset(): Promise<void> {
    this.ensureActive();

    const selected =
      this.currentState.selectedDataset;

    if (!selected) {
      throw new DatasetBrowserError(
        "Select a dataset first.",
      );
    }

    const id = selected.dataset_session_id;
    const version = this.start("listing");
    const selectionVersion = this.selectionVersion;

    try {
      const response = await apiGetDataset(id);

      if (
        !this.current(version) ||
        selectionVersion !== this.selectionVersion
      ) {
        return;
      }

      const updated = response.dataset;

      const generationChanged =
        updated.generation !== selected.generation;

      if (generationChanged) {
        this.selectionVersion++;
      }

      this.patch({
        ...(generationChanged
          ? {
              patients: [],
              selectedPatientHandle: null,
              series: [],
              selectedSeriesHandle: null,
              validation: null,
            }
          : {}),
        datasets: this.currentState.datasets.map(
          (item) =>
            item.dataset_session_id === id
              ? updated
              : item,
        ),
        selectedDataset: updated,
        status: "ready",
        operation: "idle",
        error: null,
      });
    } catch (error: unknown) {
      this.finishError(error, version);
    }
  }

  // ==========================================================
  // 09 — REFRESH DATASET
  // ==========================================================

  async refreshDataset(): Promise<void> {
    this.ensureActive();

    const selected =
      this.currentState.selectedDataset;

    if (!selected) {
      throw new DatasetBrowserError(
        "Select a dataset first.",
      );
    }

    const version = this.start("refreshing");
    const id = selected.dataset_session_id;

    this.selectionVersion++;

    this.patch({
      patients: [],
      selectedPatientHandle: null,
      series: [],
      selectedSeriesHandle: null,
      validation: null,
    });

    try {
      const response = await apiRefreshDataset(id);

      if (!this.current(version)) {
        return;
      }

      const updated = response.dataset;

      this.patch({
        datasets: this.currentState.datasets.map(
          (item) =>
            item.dataset_session_id === id
              ? updated
              : item,
        ),
        selectedDataset: updated,
        status: "ready",
        operation: "idle",
        error: null,
      });
    } catch (error: unknown) {
      this.finishError(error, version);
    }
  }

  // ==========================================================
  // 10 — CLOSE DATASET
  // ==========================================================

  async closeDataset(
    datasetSessionId?: string,
  ): Promise<void> {
    this.ensureActive();

    const id = datasetSessionId ??
      this.currentState.selectedDataset
        ?.dataset_session_id;

    if (!id) {
      throw new DatasetBrowserError(
        "Select a dataset first.",
      );
    }

    this.requireHandle(id);

    const version = this.start("closing");

    try {
      await apiCloseDataset(id);

      if (!this.current(version)) {
        return;
      }

      const selectedClosed =
        this.currentState.selectedDataset
          ?.dataset_session_id === id;

      if (selectedClosed) {
        this.selectionVersion++;
      }

      this.patch({
        ...(selectedClosed ? clearSelection() : {}),
        datasets: this.currentState.datasets.filter(
          (item) =>
            item.dataset_session_id !== id,
        ),
        status: "ready",
        operation: "idle",
        error: null,
      });
    } catch (error: unknown) {
      this.finishError(error, version);
    }
  }

  // ==========================================================
  // 11 — LOAD PATIENTS
  // ==========================================================

  async loadPatients(): Promise<void> {
    this.ensureActive();

    const dataset =
      this.currentState.selectedDataset;

    if (!dataset) {
      throw new DatasetBrowserError(
        "Select a dataset first.",
      );
    }

    const datasetId = dataset.dataset_session_id;
    const version = this.start("loading-patients");
    const selectionVersion = this.selectionVersion;

    this.patch({
      patients: [],
      selectedPatientHandle: null,
      series: [],
      selectedSeriesHandle: null,
      validation: null,
    });

    try {
      const response = await apiListPatients(datasetId);

      if (
        !this.current(version) ||
        selectionVersion !== this.selectionVersion ||
        response.dataset_session_id !== datasetId
      ) {
        return;
      }

      this.patch({
        patients: [...response.patients],
        status: "ready",
        operation: "idle",
        error: null,
      });
    } catch (error: unknown) {
      this.finishError(error, version);
    }
  }

  // ==========================================================
  // 12 — SELECT PATIENT AND LOAD SERIES
  // ==========================================================

  async selectPatient(
    patientHandle: string,
  ): Promise<void> {
    this.ensureActive();
    this.requireHandle(patientHandle);

    const dataset =
      this.currentState.selectedDataset;

    const patient = this.currentState.patients.find(
      (item) =>
        item.patient_handle === patientHandle,
    );

    if (!dataset || !patient) {
      throw new DatasetBrowserError(
        "The patient selection is unavailable.",
      );
    }

    const version = this.start("loading-series");
    const selectionVersion = ++this.selectionVersion;
    const datasetId = dataset.dataset_session_id;

    this.patch({
      selectedPatientHandle: patientHandle,
      series: [],
      selectedSeriesHandle: null,
      validation: null,
    });

    try {
      const response = await apiListSeries(
        datasetId,
        patientHandle,
      );

      if (
        !this.current(version) ||
        selectionVersion !== this.selectionVersion ||
        response.dataset_session_id !== datasetId ||
        response.patient_handle !== patientHandle
      ) {
        return;
      }

      this.patch({
        series: [...response.series],
        status: "ready",
        operation: "idle",
        error: null,
      });
    } catch (error: unknown) {
      this.finishError(error, version);
    }
  }

  // ==========================================================
  // 13 — SELECT AND VALIDATE SERIES
  // ==========================================================

  async selectSeries(
    seriesHandle: string,
  ): Promise<void> {
    this.ensureActive();
    this.requireHandle(seriesHandle);

    const dataset =
      this.currentState.selectedDataset;

    const series = this.currentState.series.find(
      (item) =>
        item.series_handle === seriesHandle,
    );

    if (!dataset || !series) {
      throw new DatasetBrowserError(
        "The series selection is unavailable.",
      );
    }

    const version = this.start("validating-series");
    const selectionVersion = ++this.selectionVersion;
    const datasetId = dataset.dataset_session_id;

    this.patch({
      selectedSeriesHandle: seriesHandle,
      validation: null,
    });

    try {
      const result = await apiValidateSeries(
        datasetId,
        seriesHandle,
      );

      if (
        !this.current(version) ||
        selectionVersion !== this.selectionVersion ||
        result.series_handle !== seriesHandle
      ) {
        return;
      }

      this.patch({
        validation: result,
        status: "ready",
        operation: "idle",
        error: null,
      });
    } catch (error: unknown) {
      this.finishError(error, version);
    }
  }

  // ==========================================================
  // 14 — VIEWER SELECTION
  // ==========================================================

  getViewerSelection(): {
    datasetSessionId: string;
    seriesHandle: string;
  } | null {
    const dataset = this.currentState.selectedDataset;
    const seriesHandle =
      this.currentState.selectedSeriesHandle;
    const validation = this.currentState.validation;

    if (
      !dataset ||
      !seriesHandle ||
      !validation ||
      validation.series_handle !== seriesHandle ||
      !validation.volume_ready
    ) {
      return null;
    }

    return {
      datasetSessionId: dataset.dataset_session_id,
      seriesHandle,
    };
  }
}


// ============================================================
// 15 — FACTORY
// ============================================================

export function createDatasetService():
  FrontendDatasetService {
  return new FrontendDatasetService();
}


// ============================================================
// END OF FRONTEND DATASET SERVICE
// ============================================================
