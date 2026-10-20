
/**
 * SINUS VIEWER — MEASUREMENT TOOLBAR
 * ==================================
 *
 * UI for the existing useMeasurements() controller.
 *
 * Features:
 * - Distance, angle, polyline and polygon selection.
 * - Finish, undo and cancel current drawing.
 * - Completed measurement history.
 * - Measurement selection and visibility.
 * - Delete selected / undo latest / clear all.
 * - Physical measurement values and units.
 * - Accessible buttons and status messages.
 *
 * Parent component owns the measurement state.
 *
 * SECURITY:
 * - No patient identifiers are logged.
 * - No persistent browser storage.
 * - No HTTP requests or original DICOM operations.
 * - All measurements remain in memory.
 *
 * Measurement accuracy requires clinical validation.
 */

import {
  useCallback,
  useMemo,
  useState,
  type CSSProperties,
} from "react";

import {
  MEASUREMENT_TOOLS,
  getMeasurementControllerError,
  type MeasurementActions,
  type MeasurementControllerState,
  type MeasurementMode,
  type MeasurementTool,
  type StoredMeasurement,
} from "../../hooks/useMeasurements";


// ============================================================
// 01 — PUBLIC TYPES
// ============================================================

export interface MeasurementToolbarProps {
  readonly state: MeasurementControllerState;
  readonly actions: MeasurementActions;

  readonly disabled?: boolean;
  readonly compact?: boolean;
  readonly className?: string;

  readonly onError?: (message: string) => void;
}

interface ToolPresentation {
  readonly title: string;
  readonly symbol: string;
  readonly instruction: string;
}


// ============================================================
// 02 — CONSTANTS
// ============================================================

export const MEASUREMENT_TOOLBAR_MAX_VISIBLE = 1000;

const TOOL_NAMES: Readonly<
  Record<MeasurementTool, ToolPresentation>
> = {
  distance: {
    title: "Distance",
    symbol: "↔",
    instruction: "Select two points to measure distance.",
  },

  angle: {
    title: "Angle",
    symbol: "∠",
    instruction: "Select three points; the second is the vertex.",
  },

  polyline: {
    title: "Polyline",
    symbol: "⌁",
    instruction: "Select two or more points, then choose Finish.",
  },

  polygon: {
    title: "Polygon",
    symbol: "⬠",
    instruction: "Trace a simple planar polygon, then choose Finish.",
  },
};


// ============================================================
// 03 — FORMAT HELPERS
// ============================================================

function formatValue(
  value: number,
  digits = 2,
): string {
  if (!Number.isFinite(value)) {
    return "Unavailable";
  }

  return value.toFixed(digits);
}

function measurementTitle(
  measurement: StoredMeasurement,
): string {
  switch (measurement.kind) {
    case "distance":
      return "Distance";

    case "angle":
      return "Angle";

    case "polyline":
      return "Polyline";

    case "polygon":
      return "Polygon";
  }
}

function measurementValue(
  measurement: StoredMeasurement,
): string {
  switch (measurement.kind) {
    case "distance":
      return `${formatValue(measurement.distanceMm)} mm`;

    case "angle":
      return `${formatValue(measurement.angleDegrees)}°`;

    case "polyline":
      return `${formatValue(measurement.lengthMm)} mm`;

    case "polygon":
      return `${formatValue(measurement.areaMm2)} mm²`;
  }
}

function planeTitle(
  plane: StoredMeasurement["plane"],
): string {
  switch (plane) {
    case "axial":
      return "Axial";

    case "coronal":
      return "Coronal";

    case "sagittal":
      return "Sagittal";
  }
}

function minimumPoints(
  tool: MeasurementTool,
): number {
  return tool === "angle" || tool === "polygon"
    ? 3
    : 2;
}

function isDrawingTool(
  mode: MeasurementMode,
): mode is MeasurementTool {
  return MEASUREMENT_TOOLS.some(
    (tool) => tool === mode,
  );
}


// ============================================================
// 04 — STYLES
// ============================================================

const panelStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 12,
  width: "100%",
  minWidth: 0,
  minHeight: 0,
  padding: 12,
  backgroundColor: "#101827",
  color: "#e2e8f0",
  fontSize: 12,
};

const sectionStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
};

const rowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  flexWrap: "wrap",
  gap: 6,
};

const buttonStyle: CSSProperties = {
  padding: "7px 10px",
  borderRadius: 5,
  border: "1px solid #344258",
  backgroundColor: "#192437",
  color: "#e2e8f0",
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
  minHeight: 32,
};

const activeButtonStyle: CSSProperties = {
  ...buttonStyle,
  backgroundColor: "#164e63",
  color: "#e0f2fe",
  borderColor: "#38bdf8",
};

const dangerButtonStyle: CSSProperties = {
  ...buttonStyle,
  borderColor: "#7f1d1d",
  color: "#fecaca",
};

const mutedStyle: CSSProperties = {
  color: "#94a3b8",
  fontSize: 11,
  lineHeight: 1.5,
};

const listStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 5,
  maxHeight: 300,
  overflowY: "auto",
};

const itemStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 7,
  border: "1px solid #344258",
  borderRadius: 5,
  padding: 7,
  backgroundColor: "#0b1220",
};


// ============================================================
// 05 — MAIN COMPONENT
// ============================================================

export function MeasurementToolbar({
  state,
  actions,
  disabled = false,
  compact = false,
  className = "",
  onError,
}: MeasurementToolbarProps) {
  const [localError, setLocalError] =
    useState<string | null>(null);

  const [showHidden, setShowHidden] =
    useState(true);

  const activeTool = state.activeTool;
  const draft = state.draft;

  const measurements = state.measurements;

  const selectedMeasurement = useMemo(
    () => measurements.find(
      (item) => item.id === state.selectedId,
    ) ?? null,
    [measurements, state.selectedId],
  );

  const visibleMeasurements = useMemo(
    () => measurements
      .filter((item) => showHidden || item.visible)
      .slice(-MEASUREMENT_TOOLBAR_MAX_VISIBLE)
      .reverse(),
    [measurements, showHidden],
  );

  const canFinishDraft =
    draft !== null &&
    draft.points.length >= minimumPoints(draft.tool);

  const hasDraftPoints =
    draft !== null &&
    draft.points.length > 0;

  const canRemoveSelected =
    selectedMeasurement !== null;

  // ==========================================================
  // 06 — CONTROLLED ACTION DISPATCH
  // ==========================================================

  const runAction = useCallback(
    (action: () => void): void => {
      if (disabled) {
        return;
      }

      try {
        action();
        setLocalError(null);
      } catch (error: unknown) {
        const message = getMeasurementControllerError(error);

        setLocalError(message);
        onError?.(message);
      }
    },
    [disabled, onError],
  );

  // ==========================================================
  // 07 — TOOL SELECTION
  // ==========================================================

  const activateTool = useCallback(
    (tool: MeasurementMode): void => {
      runAction(() => actions.setTool(tool));
    },
    [actions, runAction],
  );

  // ==========================================================
  // 08 — DRAFT ACTIONS
  // ==========================================================

  const finishDraft = useCallback(
    (): void => {
      runAction(() => actions.finishDraft());
    },
    [actions, runAction],
  );

  const undoPoint = useCallback(
    (): void => {
      runAction(() => actions.undoDraftPoint());
    },
    [actions, runAction],
  );

  const cancelDraft = useCallback(
    (): void => {
      runAction(() => actions.cancelDraft());
    },
    [actions, runAction],
  );

  // ==========================================================
  // 09 — HISTORY ACTIONS
  // ==========================================================

  const removeSelected = useCallback(
    (): void => {
      if (selectedMeasurement) {
        runAction(() =>
          actions.removeMeasurement(selectedMeasurement.id),
        );
      }
    },
    [actions, runAction, selectedMeasurement],
  );

  const undoLast = useCallback(
    (): void => {
      runAction(() => actions.undoLastMeasurement());
    },
    [actions, runAction],
  );

  const clearAll = useCallback(
    (): void => {
      runAction(() => actions.clearMeasurements());
    },
    [actions, runAction],
  );

  const resetAll = useCallback(
    (): void => {
      runAction(() => actions.reset());
    },
    [actions, runAction],
  );

  // ==========================================================
  // 10 — DRAFT INFORMATION
  // ==========================================================

  const draftDescription = draft
    ? `${TOOL_NAMES[draft.tool].title}: ` +
      `${draft.points.length} point(s) selected`
    : isDrawingTool(activeTool)
      ? TOOL_NAMES[activeTool].instruction
      : "Select a measurement tool to begin.";

  // ==========================================================
  // 11 — JSX
  // ==========================================================

  return (
    <section
      className={className}
      style={{
        ...panelStyle,
        padding: compact ? 9 : 12,
      }}
      aria-label="Medical image measurement tools"
      data-measurement-toolbar="true"
    >
      <header style={sectionStyle}>
        <strong
          style={{
            fontSize: 14,
            color: "#f8fafc",
          }}
        >
          Measurements
        </strong>

        <span style={mutedStyle}>
          Physical LPS coordinates • mm / mm² / degrees
        </span>
      </header>

      {/* TOOL SELECTION */}

      <div style={sectionStyle}>
        <strong>Drawing Tool</strong>

        <div
          style={rowStyle}
          role="group"
          aria-label="Measurement tool selection"
        >
          <button
            type="button"
            disabled={disabled}
            style={
              activeTool === "none"
                ? activeButtonStyle
                : buttonStyle
            }
            aria-pressed={activeTool === "none"}
            onClick={() => activateTool("none")}
          >
            Pointer
          </button>

          {MEASUREMENT_TOOLS.map((tool) => (
            <button
              key={tool}
              type="button"
              disabled={disabled}
              style={
                activeTool === tool
                  ? activeButtonStyle
                  : buttonStyle
              }
              title={TOOL_NAMES[tool].instruction}
              aria-pressed={activeTool === tool}
              onClick={() => activateTool(tool)}
            >
              {TOOL_NAMES[tool].symbol}
              {" "}
              {TOOL_NAMES[tool].title}
            </button>
          ))}
        </div>
      </div>

      {/* CURRENT DRAWING */}

      <div
        style={{
          ...sectionStyle,
          padding: 10,
          backgroundColor: "#0b1220",
          border: "1px solid #263244",
          borderRadius: 5,
        }}
      >
        <strong>Current Drawing</strong>

        <div
          style={mutedStyle}
          role="status"
          aria-live="polite"
        >
          {draftDescription}
        </div>

        {draft && (
          <div style={mutedStyle}>
            Plane: {planeTitle(draft.plane)}
            {" • "}
            Minimum points: {minimumPoints(draft.tool)}
          </div>
        )}

        <div style={rowStyle}>
          <button
            type="button"
            style={buttonStyle}
            disabled={disabled || !canFinishDraft}
            onClick={finishDraft}
            title="Complete the current drawing"
          >
            Finish
          </button>

          <button
            type="button"
            style={buttonStyle}
            disabled={disabled || !hasDraftPoints}
            onClick={undoPoint}
          >
            Undo Point
          </button>

          <button
            type="button"
            style={buttonStyle}
            disabled={disabled || draft === null}
            onClick={cancelDraft}
          >
            Cancel
          </button>
        </div>
      </div>

      {/* MEASUREMENT HISTORY */}

      <div style={sectionStyle}>
        <div
          style={{
            ...rowStyle,
            justifyContent: "space-between",
          }}
        >
          <strong>
            Measurement History ({measurements.length})
          </strong>

          <label
            style={{
              ...rowStyle,
              fontSize: 11,
            }}
          >
            <input
              type="checkbox"
              checked={showHidden}
              onChange={(event) =>
                setShowHidden(event.currentTarget.checked)
              }
            />
            Show hidden
          </label>
        </div>

        <div
          style={listStyle}
          role="list"
          aria-label="Completed measurements"
        >
          {visibleMeasurements.length === 0 && (
            <div
              style={{
                ...mutedStyle,
                padding: 10,
              }}
            >
              No measurements to display.
            </div>
          )}

          {visibleMeasurements.map((measurement) => {
            const selected =
              state.selectedId === measurement.id;

            return (
              <div
                key={measurement.id}
                role="listitem"
                style={{
                  ...itemStyle,
                  borderColor: selected
                    ? "#38bdf8"
                    : "#344258",
                }}
              >
                <button
                  type="button"
                  style={{
                    ...buttonStyle,
                    flex: 1,
                    textAlign: "left",
                    border: "none",
                    backgroundColor: "transparent",
                    opacity: measurement.visible ? 1 : 0.55,
                  }}
                  disabled={disabled}
                  aria-pressed={selected}
                  onClick={() =>
                    runAction(() =>
                      actions.selectMeasurement(
                        measurement.id,
                      ),
                    )
                  }
                >
                  <span
                    style={{
                      display: "block",
                      fontWeight: 700,
                    }}
                  >
                    {measurementTitle(measurement)}
                    {" — "}
                    {measurementValue(measurement)}
                  </span>

                  <span style={mutedStyle}>
                    {planeTitle(measurement.plane)}
                    {" • "}
                    {measurement.points.length} points
                  </span>
                </button>

                <button
                  type="button"
                  style={buttonStyle}
                  disabled={disabled}
                  title={
                    measurement.visible
                      ? "Hide measurement"
                      : "Show measurement"
                  }
                  aria-label={
                    measurement.visible
                      ? "Hide measurement"
                      : "Show measurement"
                  }
                  onClick={() =>
                    runAction(() =>
                      actions.setMeasurementVisible(
                        measurement.id,
                        !measurement.visible,
                      ),
                    )
                  }
                >
                  {measurement.visible ? "Hide" : "Show"}
                </button>

                <button
                  type="button"
                  style={dangerButtonStyle}
                  disabled={disabled}
                  title="Delete measurement"
                  aria-label="Delete measurement"
                  onClick={() =>
                    runAction(() =>
                      actions.removeMeasurement(
                        measurement.id,
                      ),
                    )
                  }
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
      </div>

      {/* HISTORY CONTROLS */}

      <div
        style={{
          ...sectionStyle,
          paddingTop: 10,
          borderTop: "1px solid #263244",
        }}
      >
        <div style={rowStyle}>
          <button
            type="button"
            style={dangerButtonStyle}
            disabled={disabled || !canRemoveSelected}
            onClick={removeSelected}
          >
            Delete Selected
          </button>

          <button
            type="button"
            style={buttonStyle}
            disabled={
              disabled ||
              measurements.length === 0
            }
            onClick={undoLast}
          >
            Undo Last
          </button>

          <button
            type="button"
            style={dangerButtonStyle}
            disabled={
              disabled ||
              (measurements.length === 0 &&
                draft === null)
            }
            onClick={clearAll}
          >
            Clear All
          </button>

          <button
            type="button"
            style={buttonStyle}
            disabled={disabled}
            onClick={resetAll}
          >
            Reset Tools
          </button>
        </div>
      </div>

      {/* ERROR AND SAFETY INFORMATION */}

      {localError && (
        <div
          role="alert"
          style={{
            padding: 9,
            borderRadius: 5,
            color: "#fecaca",
            backgroundColor: "#450a0a",
          }}
        >
          {localError}
        </div>
      )}

      <div style={mutedStyle}>
        Measurements are temporary and are not
        automatically saved. Source CT/CBCT images
        remain unchanged. Clinical accuracy validation
        is required before diagnostic use.
      </div>
    </section>
  );
}


// ============================================================
// 12 — COMPONENT CAPABILITIES
// ============================================================

export function getMeasurementToolbarCapabilities() {
  return {
    distanceTool: true,
    angleTool: true,
    polylineTool: true,
    polygonTool: true,
    draftCompletion: true,
    draftUndo: true,
    draftCancellation: true,
    historySelection: true,
    measurementVisibility: true,
    individualDeletion: true,
    historyUndo: true,
    clearAll: true,
    reset: true,
    parentOwnedMeasurementState: true,
    browserPersistence: false,
    modifiesSourceDICOM: false,
    clinicalValidationComplete: false,
  } as const;
}


// ============================================================
// END OF SINUS VIEWER MEASUREMENT TOOLBAR
// ============================================================
