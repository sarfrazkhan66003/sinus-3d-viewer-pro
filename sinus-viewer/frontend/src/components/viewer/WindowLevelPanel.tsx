
/**
 * SINUS VIEWER — WINDOW / LEVEL CONTROL PANEL
 * ===========================================
 *
 * React UI for CT/CBCT grayscale display settings.
 *
 * Features:
 * - Window centre slider and numeric input.
 * - Window width slider and numeric input.
 * - Brightness and contrast controls.
 * - Grayscale inversion.
 * - Built-in display presets.
 * - Percentile-based auto window.
 * - Reset all display settings.
 * - Controlled settings owned by useWindowLevel().
 *
 * IMPORTANT:
 * - Input voxel values are NOT assumed to be HU.
 * - Auto-window uses an already loaded intensity array.
 * - Original DICOM data is never modified.
 * - This component makes no network requests.
 * - Display settings are not saved to browser storage.
 *
 * The panel must be connected to a single parent-owned
 * window/level hook, shared with all MPR viewports.
 */

import {
  useCallback,
  useMemo,
  type CSSProperties,
  type ChangeEvent,
} from "react";

import type {
  WindowLevelActions,
  WindowLevelState,
  WindowPresetName,
} from "../../hooks/useWindowLevel";

import {
  getWindowPresetNames,
} from "../../hooks/useWindowLevel";

import {
  MAX_WINDOW_WIDTH,
  MIN_WINDOW_WIDTH,
  MAX_BRIGHTNESS,
  MIN_BRIGHTNESS,
  MAX_CONTRAST,
  MIN_CONTRAST,
} from "../../utils/windowLevel";


// ============================================================
// 01 — CONSTANTS
// ============================================================

export const WINDOW_PANEL_CENTER_RANGE = 10000;
export const WINDOW_PANEL_WIDTH_SLIDER_MAX = 10000;

export const WINDOW_PANEL_CENTER_STEP = 1;
export const WINDOW_PANEL_WIDTH_STEP = 1;

export const WINDOW_PANEL_BRIGHTNESS_STEP = 0.05;
export const WINDOW_PANEL_CONTRAST_STEP = 0.1;


// ============================================================
// 02 — PUBLIC TYPES
// ============================================================

export interface WindowLevelPanelProps {
  readonly state: WindowLevelState;
  readonly actions: WindowLevelActions;

  readonly intensities?: Float32Array | Float64Array | null;

  readonly disabled?: boolean;
  readonly compact?: boolean;
  readonly className?: string;

  readonly onError?: (message: string) => void;
}


// ============================================================
// 03 — DISPLAY HELPERS
// ============================================================

function displayNumber(
  value: number,
  digits = 2,
): string {
  return Number.isFinite(value)
    ? value.toFixed(digits)
    : "--";
}

function safeNumber(
  value: string,
): number | null {
  if (value.trim() === "") {
    return null;
  }

  const parsed = Number(value);

  return Number.isFinite(parsed)
    ? parsed
    : null;
}

function clamp(
  value: number,
  minimum: number,
  maximum: number,
): number {
  return Math.min(
    maximum,
    Math.max(minimum, value),
  );
}

function presetLabel(
  name: WindowPresetName,
): string {
  switch (name) {
    case "default":
      return "Default";

    case "narrow":
      return "Narrow";

    case "wide":
      return "Wide";

    default:
      return name;
  }
}


// ============================================================
// 04 — STYLES
// ============================================================

const panelStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 14,
  width: "100%",
  minWidth: 0,
  padding: 14,
  backgroundColor: "#101827",
  color: "#e2e8f0",
  fontSize: 12,
};

const sectionStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 7,
};

const sectionHeaderStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 10,
};

const controlRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  minWidth: 0,
};

const sliderStyle: CSSProperties = {
  width: "100%",
  minWidth: 0,
  flex: 1,
  cursor: "pointer",
  accentColor: "#38bdf8",
};

const numberStyle: CSSProperties = {
  width: 90,
  minWidth: 70,
  padding: "6px 7px",
  backgroundColor: "#192437",
  color: "#f8fafc",
  border: "1px solid #344258",
  borderRadius: 5,
  fontSize: 12,
  fontVariantNumeric: "tabular-nums",
};

const buttonStyle: CSSProperties = {
  backgroundColor: "#192437",
  color: "#f8fafc",
  border: "1px solid #344258",
  borderRadius: 5,
  padding: "7px 10px",
  fontSize: 12,
  cursor: "pointer",
  minHeight: 32,
};

const activeButtonStyle: CSSProperties = {
  ...buttonStyle,
  backgroundColor: "#164e63",
  borderColor: "#38bdf8",
  color: "#e0f2fe",
};

const informationStyle: CSSProperties = {
  color: "#94a3b8",
  fontSize: 11,
  lineHeight: 1.5,
};


// ============================================================
// 05 — MAIN COMPONENT
// ============================================================

export function WindowLevelPanel({
  state,
  actions,
  intensities = null,
  disabled = false,
  compact = false,
  className = "",
  onError,
}: WindowLevelPanelProps) {
  const centre = state.window.center;
  const width = state.window.width;

  const brightness = state.adjustments.brightness;
  const contrast = state.adjustments.contrast;
  const inverted = state.adjustments.invert;

  const presets = useMemo(
    () => getWindowPresetNames(),
    [],
  );

  const hasIntensities =
    intensities instanceof Float32Array ||
    intensities instanceof Float64Array;

  const canAutoWindow =
    !disabled &&
    hasIntensities &&
    intensities.length > 0;

  // ==========================================================
  // 06 — SAFE ACTION DISPATCH
  // ==========================================================

  /**
   * Window-level utility validation can reject malformed
   * numeric inputs. Convert these failures into a generic
   * UI error without displaying internal exception data.
   */
  const runAction = useCallback(
    (action: () => void): void => {
      try {
        action();
      } catch {
        onError?.(
          "Unable to apply the display adjustment.",
        );
      }
    },
    [onError],
  );

  // ==========================================================
  // 07 — WINDOW CENTRE
  // ==========================================================

  const centreMinimum = Math.min(
    -WINDOW_PANEL_CENTER_RANGE,
    Math.floor(centre),
  );

  const centreMaximum = Math.max(
    WINDOW_PANEL_CENTER_RANGE,
    Math.ceil(centre),
  );

  const changeCentre = useCallback(
    (value: number): void => {
      if (disabled || !Number.isFinite(value)) {
        return;
      }

      runAction(() => actions.setCenter(value));
    },
    [actions, disabled, runAction],
  );

  // ==========================================================
  // 08 — WINDOW WIDTH
  // ==========================================================

  const widthSliderMax = Math.max(
    WINDOW_PANEL_WIDTH_SLIDER_MAX,
    Math.ceil(Math.min(width, MAX_WINDOW_WIDTH)),
  );

  const changeWidth = useCallback(
    (value: number): void => {
      if (disabled || !Number.isFinite(value)) {
        return;
      }

      runAction(() =>
        actions.setWidth(
          clamp(
            value,
            MIN_WINDOW_WIDTH,
            MAX_WINDOW_WIDTH,
          ),
        ),
      );
    },
    [actions, disabled, runAction],
  );

  // ==========================================================
  // 09 — BRIGHTNESS / CONTRAST
  // ==========================================================

  const changeBrightness = useCallback(
    (value: number): void => {
      if (disabled || !Number.isFinite(value)) {
        return;
      }

      runAction(() =>
        actions.setBrightness(
          clamp(
            value,
            MIN_BRIGHTNESS,
            MAX_BRIGHTNESS,
          ),
        ),
      );
    },
    [actions, disabled, runAction],
  );

  const changeContrast = useCallback(
    (value: number): void => {
      if (disabled || !Number.isFinite(value)) {
        return;
      }

      runAction(() =>
        actions.setContrast(
          clamp(
            value,
            MIN_CONTRAST,
            MAX_CONTRAST,
          ),
        ),
      );
    },
    [actions, disabled, runAction],
  );

  // ==========================================================
  // 10 — NUMERIC INPUT HELPER
  // ==========================================================

  const handleNumber = useCallback(
    (
      event: ChangeEvent<HTMLInputElement>,
      callback: (value: number) => void,
    ): void => {
      const value = safeNumber(
        event.currentTarget.value,
      );

      if (value !== null) {
        callback(value);
      }
    },
    [],
  );

  // ==========================================================
  // 11 — AUTO WINDOW / RESET
  // ==========================================================

  const handleAutoWindow = useCallback(
    (): void => {
      if (
        disabled ||
        !intensities ||
        intensities.length === 0
      ) {
        return;
      }

      runAction(() =>
        actions.autoWindow(intensities),
      );
    },
    [actions, disabled, intensities, runAction],
  );

  const handleReset = useCallback(
    (): void => {
      if (!disabled) {
        runAction(() => actions.reset());
      }
    },
    [actions, disabled, runAction],
  );

  // ==========================================================
  // 12 — RENDER
  // ==========================================================

  return (
    <section
      className={className}
      style={{
        ...panelStyle,
        padding: compact ? 10 : 14,
      }}
      aria-label="Window and level controls"
      data-window-level-panel="true"
    >
      <header style={sectionHeaderStyle}>
        <div>
          <strong
            style={{
              fontSize: 14,
              color: "#f8fafc",
            }}
          >
            Window / Level
          </strong>

          <div style={informationStyle}>
            Grayscale display controls
          </div>
        </div>

        <button
          type="button"
          style={buttonStyle}
          disabled={disabled}
          onClick={handleReset}
          title="Restore initial display settings"
        >
          Reset
        </button>
      </header>

      {/* WINDOW CENTRE */}

      <div style={sectionStyle}>
        <div style={sectionHeaderStyle}>
          <label htmlFor="wl-centre-slider">
            Window Centre
          </label>

          <span style={informationStyle}>
            {displayNumber(centre)}
          </span>
        </div>

        <div style={controlRowStyle}>
          <input
            id="wl-centre-slider"
            type="range"
            min={centreMinimum}
            max={centreMaximum}
            step={WINDOW_PANEL_CENTER_STEP}
            value={centre}
            disabled={disabled}
            style={sliderStyle}
            onChange={(event) =>
              changeCentre(
                Number(event.currentTarget.value),
              )
            }
            aria-label="Window centre slider"
          />

          <input
            type="number"
            value={centre}
            step={WINDOW_PANEL_CENTER_STEP}
            disabled={disabled}
            style={numberStyle}
            onChange={(event) =>
              handleNumber(event, changeCentre)
            }
            aria-label="Window centre value"
          />
        </div>
      </div>

      {/* WINDOW WIDTH */}

      <div style={sectionStyle}>
        <div style={sectionHeaderStyle}>
          <label htmlFor="wl-width-slider">
            Window Width
          </label>

          <span style={informationStyle}>
            {displayNumber(width)}
          </span>
        </div>

        <div style={controlRowStyle}>
          <input
            id="wl-width-slider"
            type="range"
            min={MIN_WINDOW_WIDTH}
            max={widthSliderMax}
            step={WINDOW_PANEL_WIDTH_STEP}
            value={width}
            disabled={disabled}
            style={sliderStyle}
            onChange={(event) =>
              changeWidth(
                Number(event.currentTarget.value),
              )
            }
            aria-label="Window width slider"
          />

          <input
            type="number"
            min={MIN_WINDOW_WIDTH}
            max={MAX_WINDOW_WIDTH}
            value={width}
            step={WINDOW_PANEL_WIDTH_STEP}
            disabled={disabled}
            style={numberStyle}
            onChange={(event) =>
              handleNumber(event, changeWidth)
            }
            aria-label="Window width value"
          />
        </div>
      </div>

      {/* BRIGHTNESS */}

      <div style={sectionStyle}>
        <div style={sectionHeaderStyle}>
          <label htmlFor="wl-brightness">
            Brightness
          </label>

          <span style={informationStyle}>
            {displayNumber(brightness)}
          </span>
        </div>

        <div style={controlRowStyle}>
          <input
            id="wl-brightness"
            type="range"
            min={MIN_BRIGHTNESS}
            max={MAX_BRIGHTNESS}
            step={WINDOW_PANEL_BRIGHTNESS_STEP}
            value={brightness}
            disabled={disabled}
            style={sliderStyle}
            onChange={(event) =>
              changeBrightness(
                Number(event.currentTarget.value),
              )
            }
          />

          <input
            type="number"
            min={MIN_BRIGHTNESS}
            max={MAX_BRIGHTNESS}
            step={WINDOW_PANEL_BRIGHTNESS_STEP}
            value={brightness}
            disabled={disabled}
            style={numberStyle}
            onChange={(event) =>
              handleNumber(
                event,
                changeBrightness,
              )
            }
            aria-label="Brightness value"
          />
        </div>
      </div>

      {/* CONTRAST */}

      <div style={sectionStyle}>
        <div style={sectionHeaderStyle}>
          <label htmlFor="wl-contrast">
            Contrast
          </label>

          <span style={informationStyle}>
            {displayNumber(contrast)}
          </span>
        </div>

        <div style={controlRowStyle}>
          <input
            id="wl-contrast"
            type="range"
            min={MIN_CONTRAST}
            max={MAX_CONTRAST}
            step={WINDOW_PANEL_CONTRAST_STEP}
            value={contrast}
            disabled={disabled}
            style={sliderStyle}
            onChange={(event) =>
              changeContrast(
                Number(event.currentTarget.value),
              )
            }
          />

          <input
            type="number"
            min={MIN_CONTRAST}
            max={MAX_CONTRAST}
            step={WINDOW_PANEL_CONTRAST_STEP}
            value={contrast}
            disabled={disabled}
            style={numberStyle}
            onChange={(event) =>
              handleNumber(
                event,
                changeContrast,
              )
            }
            aria-label="Contrast value"
          />
        </div>
      </div>

      {/* INVERT */}

      <label
        style={{
          ...controlRowStyle,
          justifyContent: "space-between",
          padding: "8px 0",
          borderTop: "1px solid #263244",
        }}
      >
        <span>Invert grayscale</span>

        <input
          type="checkbox"
          checked={inverted}
          disabled={disabled}
          onChange={(event) =>
            runAction(() =>
              actions.setInverted(
                event.currentTarget.checked,
              ),
            )
          }
          aria-label="Invert grayscale"
        />
      </label>

      {/* PRESETS */}

      <div style={sectionStyle}>
        <strong>Display Presets</strong>

        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 6,
          }}
        >
          {presets.map((name) => (
            <button
              key={name}
              type="button"
              disabled={disabled}
              style={
                state.selectedPreset === name
                  ? activeButtonStyle
                  : buttonStyle
              }
              aria-pressed={
                state.selectedPreset === name
              }
              onClick={() =>
                runAction(() =>
                  actions.applyPreset(name),
                )
              }
            >
              {presetLabel(name)}
            </button>
          ))}
        </div>
      </div>

      {/* AUTO WINDOW */}

      <div
        style={{
          ...sectionStyle,
          borderTop: "1px solid #263244",
          paddingTop: 12,
        }}
      >
        <button
          type="button"
          style={{
            ...buttonStyle,
            width: "100%",
          }}
          disabled={!canAutoWindow}
          onClick={handleAutoWindow}
          title="Estimate display range from loaded voxel intensities"
        >
          Auto Window
        </button>

        <div style={informationStyle}>
          Uses a bounded intensity sample and percentile
          estimation. Values are not assumed to be
          calibrated Hounsfield Units.
        </div>
      </div>

      {/* CURRENT SETTINGS */}

      <div
        style={{
          padding: 9,
          backgroundColor: "#0b1220",
          border: "1px solid #263244",
          borderRadius: 5,
        }}
      >
        <strong>Current Display</strong>

        <div
          style={{
            ...informationStyle,
            marginTop: 6,
          }}
        >
          Centre: {displayNumber(centre)}
          {" | "}
          Width: {displayNumber(width)}
        </div>

        <div style={informationStyle}>
          Brightness: {displayNumber(brightness)}
          {" | "}
          Contrast: {displayNumber(contrast)}
        </div>

        <div style={informationStyle}>
          Inverted: {inverted ? "Yes" : "No"}
          {" | "}
          Preset: {state.selectedPreset ?? "Custom"}
        </div>
      </div>

      <div style={informationStyle}>
        For image navigation and visualization.
        Diagnostic display accuracy requires
        separate validation.
      </div>
    </section>
  );
}


// ============================================================
// 13 — COMPONENT CAPABILITIES
// ============================================================

export function getWindowLevelPanelCapabilities() {
  return {
    windowCenterSlider: true,
    windowWidthSlider: true,
    numericInputs: true,
    brightnessSlider: true,
    contrastSlider: true,
    invertGrayscale: true,
    presetButtons: true,
    automaticWindow: true,
    resetButton: true,
    parentOwnedWindowState: true,
    assumesCalibratedHU: false,
    browserPersistence: false,
    modifiesSourceVoxelData: false,
    clinicalValidationComplete: false,
  } as const;
}


// ============================================================
// END OF SINUS VIEWER WINDOW / LEVEL PANEL
// ============================================================
