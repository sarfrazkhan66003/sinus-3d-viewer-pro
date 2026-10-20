
/**
 * SINUS VIEWER — DATASET BROWSER
 * ==============================
 *
 * React UI for the existing authorized dataset service.
 *
 * Integrates:
 * - File 46: FrontendDatasetService
 * - File 54: useDataset
 * - File 44: Opaque dataset/series handles
 *
 * Features:
 * - Discover backend-authorized datasets.
 * - Select an approved dataset.
 * - List and select patient records.
 * - List and select CT/CBCT series.
 * - Show non-identifying series information.
 * - Display loading, errors and validation state.
 * - Open a validated series in the viewer.
 * - Cancel pending browsing operations.
 * - Reset browser state.
 *
 * Privacy:
 * - Never display patient names or source paths.
 * - Never print DICOM UIDs.
 * - Never log raw service responses.
 * - Never persist dataset details in browser storage.
 * - Do not directly access original DICOM files.
 *
 * Backend authorization is authoritative.
 * This component performs no filesystem writes.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";

import {
  useDataset,
  type DatasetViewerSelection,
} from "../../hooks/useDataset";


// ============================================================
// 01 — PUBLIC TYPES
// ============================================================

export interface DatasetBrowserProps {
  readonly className?: string;
  readonly disabled?: boolean;
  readonly automaticallyDiscover?: boolean;

  /**
   * Called only with the validated opaque selection
   * provided by useDataset().
   */
  readonly onOpenSeries?: (
    selection: DatasetViewerSelection,
  ) => void;

  readonly onAuthenticationRequired?: () => void;

  /**
   * UI-safe generic errors only.
   * Raw backend error details are not forwarded.
   */
  readonly onError?: (message: string) => void;
}


// ============================================================
// 02 — CONSTANTS
// ============================================================

export const DATASET_BROWSER_MAX_ITEMS = 5000;

export const DATASET_BROWSER_MAX_LABEL_LENGTH = 80;

const PUBLIC_ERROR_MESSAGE =
  "The dataset operation could not be completed.";

const DATASET_LABEL = "Authorized dataset";
const PATIENT_LABEL = "Patient record";
const SERIES_LABEL = "Imaging series";


// ============================================================
// 03 — SAFE DATA ACCESS
// ============================================================

/**
 * The browsing services own their response contracts.
 *
 * These helpers only read public, expected attributes.
 * They intentionally avoid arbitrary object rendering,
 * patient names, original paths and DICOM identifiers.
 *
 * Unknown values are treated as unavailable rather
 * than displayed through String(object).
 */

type UnknownRecord = Readonly<Record<string, unknown>>;

function asRecord(value: unknown): UnknownRecord | null {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return null;
  }

  return value as UnknownRecord;
}

function safeArray(value: unknown): readonly unknown[] {
  return Array.isArray(value)
    ? value.slice(0, DATASET_BROWSER_MAX_ITEMS)
    : [];
}

function safeString(
  value: unknown,
): string | null {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 2048
  ) {
    return null;
  }

  return value;
}

/**
 * Source path is used only as an argument to the
 * existing backend-authorized selection operation.
 *
 * It is never displayed, logged, copied or stored
 * in browser persistence.
 */
function getDatasetSelectionPath(
  value: unknown,
): string | null {
  const record = asRecord(value);

  if (!record) {
    return null;
  }

  return (
    safeString(record.dataset_path) ??
    safeString(record.path) ??
    safeString(record.source_path)
  );
}

/**
 * These must be opaque backend-issued handles.
 *
 * A handle is not a filesystem path, patient name
 * or DICOM identifier.
 */
function isOpaqueHandle(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 128
  ) {
    return false;
  }

  for (const character of value) {
    const allowed =
      (character >= "A" && character <= "Z") ||
      (character >= "a" && character <= "z") ||
      (character >= "0" && character <= "9") ||
      character === "_" ||
      character === "-";

    if (!allowed) {
      return false;
    }
  }

  return true;
}

function getPatientHandle(
  value: unknown,
): string | null {
  const record = asRecord(value);

  const candidate =
    record?.patient_handle ??
    record?.handle;

  return isOpaqueHandle(candidate)
    ? candidate
    : null;
}

function getSeriesHandle(
  value: unknown,
): string | null {
  const record = asRecord(value);

  const candidate =
    record?.series_handle ??
    record?.handle;

  return isOpaqueHandle(candidate)
    ? candidate
    : null;
}


// ============================================================
// 04 — NON-IDENTIFYING DISPLAY HELPERS
// ============================================================

function numberedLabel(
  prefix: string,
  index: number,
): string {
  return `${prefix} ${index + 1}`;
}

function safeCount(value: unknown): string {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    return "—";
  }

  return value.toLocaleString();
}

function safeDimension(value: unknown): string {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > 100000
  ) {
    return "—";
  }

  return String(value);
}

function modalityLabel(
  value: unknown,
): string {
  if (value === "CT") {
    return "CT";
  }

  if (value === "CBCT") {
    return "CBCT";
  }

  return "Imaging";
}

function getSeriesModality(
  value: unknown,
): string {
  const record = asRecord(value);

  return modalityLabel(record?.modality);
}

function getSeriesDetails(
  value: unknown,
): string {
  const record = asRecord(value);

  if (!record) {
    return "Series details unavailable";
  }

  const slices = safeCount(
    record.slice_count ?? record.instance_count,
  );

  const rows = safeDimension(record.rows);
  const columns = safeDimension(record.columns);

  return (
    `${getSeriesModality(value)} • ` +
    `${slices} slices • ` +
    `${rows} × ${columns}`
  );
}


// ============================================================
// 05 — STYLES
// ============================================================

const rootStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  width: "100%",
  minWidth: 0,
  minHeight: 0,
  overflow: "hidden",
  backgroundColor: "#0b1220",
  color: "#e2e8f0",
  border: "1px solid #263244",
  borderRadius: 8,
};

const headerStyle: CSSProperties = {
  padding: 14,
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 10,
  borderBottom: "1px solid #263244",
  backgroundColor: "#101827",
};

const contentStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))",
  flex: 1,
  minWidth: 0,
  minHeight: 0,
  overflowY: "auto",
  gap: 10,
  padding: 10,
  alignContent: "start",
};

const panelStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  minWidth: 0,
  minHeight: 180,
  maxHeight: 520,
  border: "1px solid #263244",
  borderRadius: 6,
  overflow: "hidden",
  backgroundColor: "#101827",
};

const panelHeaderStyle: CSSProperties = {
  padding: "10px 12px",
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: 8,
  borderBottom: "1px solid #263244",
};

const listStyle: CSSProperties = {
  flex: 1,
  overflowY: "auto",
  padding: 7,
  display: "flex",
  flexDirection: "column",
  gap: 5,
};

const buttonStyle: CSSProperties = {
  padding: "7px 10px",
  border: "1px solid #344258",
  borderRadius: 5,
  backgroundColor: "#192437",
  color: "#f8fafc",
  fontSize: 12,
  cursor: "pointer",
};

const rowButtonStyle: CSSProperties = {
  ...buttonStyle,
  textAlign: "left",
  width: "100%",
  padding: "10px",
  display: "flex",
  flexDirection: "column",
  gap: 5,
};

const selectedRowStyle: CSSProperties = {
  ...rowButtonStyle,
  backgroundColor: "#164e63",
  borderColor: "#38bdf8",
};

const mutedStyle: CSSProperties = {
  fontSize: 11,
  color: "#94a3b8",
  lineHeight: 1.5,
};

const notificationStyle: CSSProperties = {
  padding: "9px 12px",
  backgroundColor: "#172033",
  color: "#cbd5e1",
  fontSize: 12,
  borderBottom: "1px solid #263244",
};

const errorStyle: CSSProperties = {
  ...notificationStyle,
  backgroundColor: "#450a0a",
  color: "#fecaca",
};


// ============================================================
// 06 — MAIN COMPONENT
// ============================================================

export function DatasetBrowser({
  className = "",
  disabled = false,
  automaticallyDiscover = true,
  onOpenSeries,
  onAuthenticationRequired,
  onError,
}: DatasetBrowserProps) {
  const dataset = useDataset();

  const {
    state,
    actions,
    isLoading,
    requiresAuthentication,
    viewerSelection,
  } = dataset;

  const [localError, setLocalError] =
    useState<string | null>(null);

  const [hasDiscovered, setHasDiscovered] =
    useState(false);

  const [opening, setOpening] =
    useState(false);

  /**
   * Prevent automatic discovery from running again
   * during React StrictMode effect replay.
   */
  const initialDiscoveryStarted = useRef(false);

  const datasets = useMemo(
    () => safeArray(state.datasets),
    [state.datasets],
  );

  const patients = useMemo(
    () => safeArray(state.patients),
    [state.patients],
  );

  const series = useMemo(
    () => safeArray(state.series),
    [state.series],
  );

  const hasSelectedDataset =
    state.selectedDataset !== null;

  const hasSelectedPatient =
    state.selectedPatientHandle !== null;

  const hasSelectedSeries =
    state.selectedSeriesHandle !== null;

  const busy = disabled || isLoading;

  // ==========================================================
  // 07 — SAFE OPERATION HANDLER
  // ==========================================================

  const execute = useCallback(
    async (
      operation: () => Promise<void>,
    ): Promise<void> => {
      if (disabled) {
        return;
      }

      setLocalError(null);

      try {
        await operation();
      } catch {
        const message = PUBLIC_ERROR_MESSAGE;

        setLocalError(message);
        onError?.(message);
      }
    },
    [disabled, onError],
  );

  // ==========================================================
  // 08 — AUTOMATIC DISCOVERY
  // ==========================================================

  useEffect(() => {
    if (
      !automaticallyDiscover ||
      disabled ||
      initialDiscoveryStarted.current
    ) {
      return;
    }

    initialDiscoveryStarted.current = true;

    void execute(() => actions.listDatasets()).finally(
      () => setHasDiscovered(true),
    );
  }, [
    automaticallyDiscover,
    disabled,
    actions,
    execute,
  ]);

  // ==========================================================
  // 09 — AUTHENTICATION HANDLING
  // ==========================================================

  useEffect(() => {
    if (requiresAuthentication) {
      onAuthenticationRequired?.();
    }
  }, [
    requiresAuthentication,
    onAuthenticationRequired,
  ]);

  // ==========================================================
  // 10 — MANUAL REFRESH
  // ==========================================================

  const refreshDatasets = useCallback(
    (): void => {
      if (busy) {
        return;
      }

      setHasDiscovered(true);

      void execute(() => actions.listDatasets());
    },
    [busy, execute, actions],
  );

  // ==========================================================
  // 11 — DATASET SELECTION
  // ==========================================================

  const selectDataset = useCallback(
    (datasetRecord: unknown): void => {
      if (busy) {
        return;
      }

      const path = getDatasetSelectionPath(
        datasetRecord,
      );

      if (path === null) {
        setLocalError(
          "This dataset cannot be selected.",
        );
        return;
      }

      void execute(() =>
        actions.selectDataset(path),
      );
    },
    [busy, execute, actions],
  );

  // ==========================================================
  // 12 — PATIENT SELECTION
  // ==========================================================

  const selectPatient = useCallback(
    (patientRecord: unknown): void => {
      if (busy || !hasSelectedDataset) {
        return;
      }

      const handle = getPatientHandle(
        patientRecord,
      );

      if (!handle) {
        setLocalError(
          "This patient record is unavailable.",
        );
        return;
      }

      void execute(() =>
        actions.selectPatient(handle),
      );
    },
    [
      busy,
      hasSelectedDataset,
      execute,
      actions,
    ],
  );

  // ==========================================================
  // 13 — SERIES SELECTION AND VALIDATION
  // ==========================================================

  /**
   * File 54's selectSeries action delegates
   * validation to the dataset service.
   *
   * The viewer-opening button relies exclusively
   * on the validated viewerSelection returned
   * by the hook, not a manually constructed handle.
   */
  const selectSeries = useCallback(
    (seriesRecord: unknown): void => {
      if (busy || !hasSelectedPatient) {
        return;
      }

      const handle = getSeriesHandle(
        seriesRecord,
      );

      if (!handle) {
        setLocalError(
          "This imaging series is unavailable.",
        );
        return;
      }

      void execute(() =>
        actions.selectSeries(handle),
      );
    },
    [
      busy,
      hasSelectedPatient,
      execute,
      actions,
    ],
  );

  // ==========================================================
  // 14 — OPEN VALIDATED VIEWER
  // ==========================================================

  const canOpen =
    !busy &&
    viewerSelection !== null &&
    typeof onOpenSeries === "function";

  const openSeries = useCallback((): void => {
    if (!canOpen || viewerSelection === null) {
      return;
    }

    setOpening(true);

    try {
      onOpenSeries?.({
        datasetSessionId:
          viewerSelection.datasetSessionId,
        seriesHandle:
          viewerSelection.seriesHandle,
      });
    } catch {
      const message =
        "Unable to open the selected series.";

      setLocalError(message);
      onError?.(message);
    } finally {
      setOpening(false);
    }
  }, [
    canOpen,
    viewerSelection,
    onOpenSeries,
    onError,
  ]);

  // ==========================================================
  // 15 — CANCEL AND RESET
  // ==========================================================

  const cancelPending = useCallback((): void => {
    actions.cancelPending();
  }, [actions]);

  const resetBrowser = useCallback((): void => {
    actions.reset();
    setLocalError(null);
    setHasDiscovered(false);
    initialDiscoveryStarted.current = true;
  }, [actions]);

  // ==========================================================
  // 16 — VALIDATION PRESENTATION
  // ==========================================================

  const validationAvailable =
    viewerSelection !== null;

  const validationStatus =
    validationAvailable
      ? "Series validated for viewer loading"
      : hasSelectedSeries
        ? "Series not yet ready for viewer loading"
        : "Select a series to check readiness";

  // ==========================================================
  // 17 — JSX OUTPUT
  // ==========================================================

  return (
    <section
      className={className}
      style={rootStyle}
      data-dataset-browser="true"
      aria-label="Authorized medical imaging dataset browser"
    >
      <header style={headerStyle}>
        <div>
          <strong style={{ fontSize: 15 }}>
            DICOM Dataset Browser
          </strong>

          <div style={mutedStyle}>
            Authorized datasets and imaging series
          </div>
        </div>

        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 6,
          }}
        >
          <button
            type="button"
            style={buttonStyle}
            disabled={busy}
            onClick={refreshDatasets}
          >
            Refresh
          </button>

          <button
            type="button"
            style={buttonStyle}
            disabled={disabled || !isLoading}
            onClick={cancelPending}
          >
            Cancel
          </button>

          <button
            type="button"
            style={buttonStyle}
            disabled={disabled}
            onClick={resetBrowser}
          >
            Reset
          </button>
        </div>
      </header>

      {isLoading && (
        <div
          style={notificationStyle}
          role="status"
          aria-live="polite"
        >
          Processing authorized dataset request…
        </div>
      )}

      {requiresAuthentication && (
        <div
          style={errorStyle}
          role="alert"
        >
          Your session requires authentication.
          Sign in again before accessing datasets.
        </div>
      )}

      {(localError || state.error) && (
        <div
          style={errorStyle}
          role="alert"
        >
          {localError ??
            "The dataset request was unsuccessful."}
        </div>
      )}

      <div style={contentStyle}>
        {/* ================================================= */}
        {/* DATASET LIST */}
        {/* ================================================= */}

        <section
          style={panelStyle}
          aria-label="Available datasets"
        >
          <header style={panelHeaderStyle}>
            <strong>Datasets</strong>
            <span style={mutedStyle}>
              {datasets.length}
            </span>
          </header>

          <div
            style={listStyle}
            role="list"
          >
            {datasets.length === 0 && (
              <p style={mutedStyle}>
                {hasDiscovered
                  ? "No selectable datasets found."
                  : "Use Refresh to discover datasets."}
              </p>
            )}

            {datasets.map((item, index) => {
              const path =
                getDatasetSelectionPath(item);

              return (
                <div
                  key={`dataset-${index}`}
                  role="listitem"
                >
                  <button
                    type="button"
                    style={rowButtonStyle}
                    disabled={busy || path === null}
                    onClick={() =>
                      selectDataset(item)
                    }
                    aria-label={
                      `Select ${numberedLabel(
                        DATASET_LABEL,
                        index,
                      )}`
                    }
                  >
                    <strong>
                      {numberedLabel(
                        DATASET_LABEL,
                        index,
                      )}
                    </strong>

                    <span style={mutedStyle}>
                      {path !== null
                        ? "Available for authorized selection"
                        : "Selection unavailable"}
                    </span>
                  </button>
                </div>
              );
            })}
          </div>
        </section>

        {/* ================================================= */}
        {/* PATIENT LIST */}
        {/* ================================================= */}

        <section
          style={panelStyle}
          aria-label="Dataset patient records"
        >
          <header style={panelHeaderStyle}>
            <strong>Patient Records</strong>
            <span style={mutedStyle}>
              {patients.length}
            </span>
          </header>

          <div
            style={listStyle}
            role="list"
          >
            {!hasSelectedDataset && (
              <p style={mutedStyle}>
                Select a dataset first.
              </p>
            )}

            {hasSelectedDataset &&
              patients.length === 0 && (
                <p style={mutedStyle}>
                  No patient records available.
                </p>
              )}

            {patients.map((item, index) => {
              const handle =
                getPatientHandle(item);

              const selected =
                handle !== null &&
                state.selectedPatientHandle === handle;

              return (
                <div
                  key={`patient-${index}`}
                  role="listitem"
                >
                  <button
                    type="button"
                    style={
                      selected
                        ? selectedRowStyle
                        : rowButtonStyle
                    }
                    disabled={
                      busy ||
                      !hasSelectedDataset ||
                      handle === null
                    }
                    aria-pressed={selected}
                    onClick={() =>
                      selectPatient(item)
                    }
                  >
                    <strong>
                      {numberedLabel(
                        PATIENT_LABEL,
                        index,
                      )}
                    </strong>

                    <span style={mutedStyle}>
                      {selected
                        ? "Selected"
                        : handle
                          ? "Select to view imaging series"
                          : "Record unavailable"}
                    </span>
                  </button>
                </div>
              );
            })}
          </div>
        </section>

        {/* ================================================= */}
        {/* SERIES LIST */}
        {/* ================================================= */}

        <section
          style={panelStyle}
          aria-label="Available imaging series"
        >
          <header style={panelHeaderStyle}>
            <strong>Imaging Series</strong>
            <span style={mutedStyle}>
              {series.length}
            </span>
          </header>

          <div
            style={listStyle}
            role="list"
          >
            {!hasSelectedPatient && (
              <p style={mutedStyle}>
                Select a patient record first.
              </p>
            )}

            {hasSelectedPatient &&
              series.length === 0 && (
                <p style={mutedStyle}>
                  No imaging series available.
                </p>
              )}

            {series.map((item, index) => {
              const handle =
                getSeriesHandle(item);

              const selected =
                handle !== null &&
                state.selectedSeriesHandle === handle;

              return (
                <div
                  key={`series-${index}`}
                  role="listitem"
                >
                  <button
                    type="button"
                    style={
                      selected
                        ? selectedRowStyle
                        : rowButtonStyle
                    }
                    disabled={
                      busy ||
                      !hasSelectedPatient ||
                      handle === null
                    }
                    aria-pressed={selected}
                    onClick={() =>
                      selectSeries(item)
                    }
                  >
                    <strong>
                      {numberedLabel(
                        SERIES_LABEL,
                        index,
                      )}
                    </strong>

                    <span style={mutedStyle}>
                      {getSeriesDetails(item)}
                    </span>

                    <span style={mutedStyle}>
                      {selected
                        ? "Selected for validation"
                        : "Select this imaging series"}
                    </span>
                  </button>
                </div>
              );
            })}
          </div>
        </section>
      </div>

      {/* =================================================== */}
      {/* VIEWER OPENING */}
      {/* =================================================== */}

      <footer
        style={{
          ...headerStyle,
          borderTop: "1px solid #263244",
          borderBottom: "none",
        }}
      >
        <div>
          <strong style={{ fontSize: 12 }}>
            Viewer Readiness
          </strong>

          <div
            style={mutedStyle}
            role="status"
            aria-live="polite"
          >
            {validationStatus}
          </div>
        </div>

        <button
          type="button"
          style={{
            ...buttonStyle,
            backgroundColor: canOpen
              ? "#0f766e"
              : "#192437",
            fontWeight: 700,
          }}
          disabled={!canOpen || opening}
          onClick={openSeries}
          aria-label="Open validated imaging series"
        >
          {opening
            ? "Opening…"
            : "Open in Viewer"}
        </button>
      </footer>

      <div
        style={{
          padding: "8px 12px",
          borderTop: "1px solid #263244",
          ...mutedStyle,
        }}
      >
        Dataset access is backend-authorized.
        Original CT/CBCT DICOM files remain read-only.
        This browser does not expose patient identifiers
        or raw source paths.
      </div>
    </section>
  );
}


// ============================================================
// 18 — COMPONENT CAPABILITIES
// ============================================================

export function getDatasetBrowserCapabilities() {
  return {
    authorizedDatasetDiscovery: true,
    datasetSelection: true,
    patientRecordListing: true,
    patientSelection: true,
    seriesListing: true,
    seriesSelection: true,
    nonIdentifyingSeriesMetadata: true,
    validatedViewerOpening: true,
    requestCancellation: true,
    resetState: true,
    loadingAndErrorStates: true,
    authenticationHandling: true,
    displaysPatientNames: false,
    displaysSourcePaths: false,
    browserPersistence: false,
    modifiesOriginalDICOM: false,
    clinicalValidationComplete: false,
  } as const;
}


// ============================================================
// END OF SINUS VIEWER DATASET BROWSER
// ============================================================
