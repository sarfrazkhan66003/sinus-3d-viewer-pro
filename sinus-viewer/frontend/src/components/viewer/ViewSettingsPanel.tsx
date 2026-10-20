
/**
 * SINUS VIEWER — VIEW SETTINGS PANEL
 * ==================================
 *
 * Controlled presentation settings for one MPR viewport.
 *
 * Features:
 * - Axial / coronal / sagittal plane support.
 * - Nearest-neighbor / linear interpolation selection.
 * - Display-only grayscale inversion.
 * - Crosshair overlay visibility.
 * - Measurement overlay visibility.
 * - Anatomical orientation label visibility.
 * - Coordinate readout visibility.
 * - Intensity readout visibility.
 * - Reset-to-defaults command.
 * - Compact layout and accessibility.
 * - Loading / disabled state protection.
 *
 * IMPORTANT:
 * - The parent owns the settings state.
 * - Changes apply only to display rendering.
 * - No raw voxel modification occurs here.
 * - Orientation must never be guessed or redefined
 *   by a UI visibility toggle.
 * - Interpolation describes display sampling only.
 * - No direct DICOM/network/storage operations.
 */

import {
  useCallback,
  useId,
  type CSSProperties,
  type ChangeEvent,
} from "react";

// ============================================================
// 01 — PUBLIC TYPES
// ============================================================

export type ViewSettingsPlane =
  | "axial"
  | "coronal"
  | "sagittal";

export type ViewInterpolationMode =
  | "nearest"
  | "linear";

export type ViewSettingsBooleanKey =
  | "invertGrayscale"
  | "showCrosshair"
  | "showMeasurements"
  | "showOrientationLabels"
  | "showCoordinateReadout"
  | "showIntensityReadout";

export interface ViewDisplaySettings {
  readonly interpolation: ViewInterpolationMode;
  readonly invertGrayscale: boolean;
  readonly showCrosshair: boolean;
  readonly showMeasurements: boolean;
  readonly showOrientationLabels: boolean;
  readonly showCoordinateReadout: boolean;
  readonly showIntensityReadout: boolean;
}

export type ViewSettingsChange =
  | {
      readonly kind: "update";
      readonly plane: ViewSettingsPlane;
      readonly settings: ViewDisplaySettings;
    }
  | {
      readonly kind: "reset";
      readonly plane: ViewSettingsPlane;
    };

export interface ViewSettingsPanelProps {
  readonly plane: ViewSettingsPlane;
  readonly settings: ViewDisplaySettings;

  readonly onChange: (
    change: ViewSettingsChange,
  ) => void;

  readonly disabled?: boolean;
  readonly loading?: boolean;
  readonly compact?: boolean;

  /**
   * When false, interpolation selection cannot be
   * changed, even if other settings are available.
   */
  readonly interpolationAvailable?: boolean;

  /**
   * Supplied by the parent after verified display
   * geometry is available.
   */
  readonly orientationAvailable?: boolean;

  readonly showResetButton?: boolean;
  readonly className?: string;
}

// ============================================================
// 02 — DEFAULTS AND OPTIONS
// ============================================================

export const DEFAULT_VIEW_DISPLAY_SETTINGS:
  Readonly<ViewDisplaySettings> = Object.freeze({
    interpolation: "linear",
    invertGrayscale: false,
    showCrosshair: true,
    showMeasurements: true,
    showOrientationLabels: true,
    showCoordinateReadout: false,
    showIntensityReadout: false,
});

export const VIEW_INTERPOLATION_OPTIONS:
  readonly ViewInterpolationMode[] = [
    "nearest",
    "linear",
  ];

const BOOLEAN_SETTING_OPTIONS: readonly {
  readonly key: ViewSettingsBooleanKey;
  readonly label: string;
  readonly description: string;
}[] = [
  {
    key: "invertGrayscale",
    label: "Invert grayscale",
    description:
      "Invert the displayed grayscale without changing source pixels.",
  },
  {
    key: "showCrosshair",
    label: "Show crosshair",
    description:
      "Show synchronized MPR crosshair lines.",
  },
  {
    key: "showMeasurements",
    label: "Show measurements",
    description:
      "Show measurement annotations in the viewport.",
  },
  {
    key: "showOrientationLabels",
    label: "Show orientation labels",
    description:
      "Show labels derived from verified display geometry.",
  },
  {
    key: "showCoordinateReadout",
    label: "Show coordinates",
    description:
      "Show verified voxel and patient coordinate readouts.",
  },
  {
    key: "showIntensityReadout",
    label: "Show intensity",
    description:
      "Show cursor intensity with calibration-aware units.",
  },
];

// ============================================================
// 03 — VALIDATION HELPERS
// ============================================================

export function isViewInterpolationMode(
  value: unknown,
): value is ViewInterpolationMode {
  return value === "nearest" || value === "linear";
}

export function isViewDisplaySettings(
  value: unknown,
): value is ViewDisplaySettings {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return false;
  }

  const input = value as Partial<ViewDisplaySettings>;

  return (
    isViewInterpolationMode(input.interpolation) &&
    typeof input.invertGrayscale === "boolean" &&
    typeof input.showCrosshair === "boolean" &&
    typeof input.showMeasurements === "boolean" &&
    typeof input.showOrientationLabels === "boolean" &&
    typeof input.showCoordinateReadout === "boolean" &&
    typeof input.showIntensityReadout === "boolean"
  );
}

export function normalizeViewDisplaySettings(
  input: unknown,
): ViewDisplaySettings {
  if (!isViewDisplaySettings(input)) {
    return {
      ...DEFAULT_VIEW_DISPLAY_SETTINGS,
    };
  }

  return {
    interpolation: input.interpolation,
    invertGrayscale: input.invertGrayscale,
    showCrosshair: input.showCrosshair,
    showMeasurements: input.showMeasurements,
    showOrientationLabels: input.showOrientationLabels,
    showCoordinateReadout: input.showCoordinateReadout,
    showIntensityReadout: input.showIntensityReadout,
  };
}

export function updateViewBooleanSetting(
  settings: ViewDisplaySettings,
  key: ViewSettingsBooleanKey,
  value: boolean,
): ViewDisplaySettings {
  const current = normalizeViewDisplaySettings(settings);

  return {
    ...current,
    [key]: value,
  };
}

export function equalViewDisplaySettings(
  a: ViewDisplaySettings,
  b: ViewDisplaySettings,
): boolean {
  return (
    a.interpolation === b.interpolation &&
    a.invertGrayscale === b.invertGrayscale &&
    a.showCrosshair === b.showCrosshair &&
    a.showMeasurements === b.showMeasurements &&
    a.showOrientationLabels === b.showOrientationLabels &&
    a.showCoordinateReadout === b.showCoordinateReadout &&
    a.showIntensityReadout === b.showIntensityReadout
  );
}

// ============================================================
// 04 — LABEL HELPERS
// ============================================================

export function viewSettingsPlaneLabel(
  plane: ViewSettingsPlane,
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

function interpolationLabel(
  mode: ViewInterpolationMode,
): string {
  switch (mode) {
    case "nearest":
      return "Nearest neighbor";

    case "linear":
      return "Linear";
  }
}

// ============================================================
// 05 — STYLES
// ============================================================

const rootStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  width: "100%",
  minWidth: 0,
  boxSizing: "border-box",
  padding: 12,
  gap: 12,
  backgroundColor: "#101827",
  border: "1px solid #263244",
  borderRadius: 8,
  color: "#e2e8f0",
};

const headerStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  flexWrap: "wrap",
  gap: 8,
};

const labelStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  color: "#f8fafc",
};

const descriptionStyle: CSSProperties = {
  fontSize: 11,
  lineHeight: 1.5,
  color: "#94a3b8",
};

const sectionStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 7,
  width: "100%",
};

const toggleRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 9,
  padding: "7px 0",
  borderBottom: "1px solid #263244",
  cursor: "pointer",
};

const checkboxStyle: CSSProperties = {
  width: 16,
  height: 16,
  margin: "2px 0 0",
  accentColor: "#38bdf8",
  flexShrink: 0,
};

const selectStyle: CSSProperties = {
  boxSizing: "border-box",
  width: "100%",
  minHeight: 35,
  padding: "6px 9px",
  border: "1px solid #344258",
  borderRadius: 5,
  backgroundColor: "#192437",
  color: "#e2e8f0",
  fontSize: 12,
};

const resetButtonStyle: CSSProperties = {
  padding: "7px 11px",
  minHeight: 32,
  backgroundColor: "#192437",
  color: "#e2e8f0",
  border: "1px solid #344258",
  borderRadius: 5,
  fontSize: 12,
  cursor: "pointer",
};

// ============================================================
// 06 — MAIN COMPONENT
// ============================================================

export function ViewSettingsPanel({
  plane,
  settings,
  onChange,
  disabled = false,
  loading = false,
  compact = false,
  interpolationAvailable = true,
  orientationAvailable = false,
  showResetButton = true,
  className = "",
}: ViewSettingsPanelProps) {
  const selectId = useId();

  const current = normalizeViewDisplaySettings(settings);

  const canInteract = !disabled && !loading;

  const atDefaults = equalViewDisplaySettings(
    current,
    DEFAULT_VIEW_DISPLAY_SETTINGS,
  );

  // ==========================================================
  // 07 — CONTROLLED CHANGE DISPATCH
  // ==========================================================

  const dispatchUpdate = useCallback(
    (next: ViewDisplaySettings): void => {
      if (
        !canInteract ||
        equalViewDisplaySettings(current, next)
      ) {
        return;
      }

      onChange({
        kind: "update",
        plane,
        settings: next,
      });
    },
    [
      canInteract,
      current,
      onChange,
      plane,
    ],
  );

  // ==========================================================
  // 08 — INTERPOLATION CONTROL
  // ==========================================================

  const handleInterpolationChange = useCallback(
    (event: ChangeEvent<HTMLSelectElement>): void => {
      if (!canInteract || !interpolationAvailable) {
        return;
      }

      const mode = event.currentTarget.value;

      if (!isViewInterpolationMode(mode)) {
        return;
      }

      dispatchUpdate({
        ...current,
        interpolation: mode,
      });
    },
    [
      canInteract,
      interpolationAvailable,
      current,
      dispatchUpdate,
    ],
  );

  // ==========================================================
  // 09 — BOOLEAN SETTING CONTROL
  // ==========================================================

  const handleToggle = useCallback(
    (
      key: ViewSettingsBooleanKey,
      value: boolean,
    ): void => {
      if (!canInteract) {
        return;
      }

      if (
        key === "showOrientationLabels" &&
        !orientationAvailable
      ) {
        return;
      }

      dispatchUpdate(
        updateViewBooleanSetting(
          current,
          key,
          value,
        ),
      );
    },
    [
      canInteract,
      current,
      dispatchUpdate,
      orientationAvailable,
    ],
  );

  // ==========================================================
  // 10 — RESET COMMAND
  // ==========================================================

  const handleReset = useCallback((): void => {
    if (!canInteract || atDefaults) {
      return;
    }

    // The parent decides the effective reset state.
    onChange({
      kind: "reset",
      plane,
    });
  }, [
    canInteract,
    atDefaults,
    onChange,
    plane,
  ]);

  // ==========================================================
  // 11 — RENDER
  // ==========================================================

  return (
    <section
      className={className}
      style={{
        ...rootStyle,
        padding: compact ? 8 : 12,
        gap: compact ? 8 : 12,
      }}
      aria-label={`${viewSettingsPlaneLabel(plane)} view settings`}
      aria-busy={loading}
      data-view-settings-panel="true"
      data-view-settings-plane={plane}
      data-view-settings-ready={
        canInteract ? "true" : "false"
      }
    >
      <div style={headerStyle}>
        <strong style={labelStyle}>
          {viewSettingsPlaneLabel(plane)} View Settings
        </strong>

        {showResetButton && (
          <button
            type="button"
            style={{
              ...resetButtonStyle,
              opacity:
                canInteract && !atDefaults
                  ? 1
                  : 0.45,
              cursor:
                canInteract && !atDefaults
                  ? "pointer"
                  : "not-allowed",
            }}
            disabled={!canInteract || atDefaults}
            onClick={handleReset}
            aria-label={`Reset ${plane} view settings`}
          >
            Reset
          </button>
        )}
      </div>

      <div style={sectionStyle}>
        <label
          htmlFor={selectId}
          style={labelStyle}
        >
          Image interpolation
        </label>

        <select
          id={selectId}
          style={{
            ...selectStyle,
            opacity:
              canInteract && interpolationAvailable
                ? 1
                : 0.5,
          }}
          value={current.interpolation}
          disabled={
            !canInteract || !interpolationAvailable
          }
          onChange={handleInterpolationChange}
          data-view-interpolation="true"
        >
          {VIEW_INTERPOLATION_OPTIONS.map(
            (mode) => (
              <option
                key={mode}
                value={mode}
              >
                {interpolationLabel(mode)}
              </option>
            ),
          )}
        </select>

        {!compact && (
          <span style={descriptionStyle}>
            Nearest neighbor preserves distinct
            displayed sample blocks. Linear blends
            adjacent display samples. Neither mode
            changes the source DICOM pixel data.
          </span>
        )}
      </div>

      <div
        style={sectionStyle}
        role="group"
        aria-label="Viewport display overlays"
      >
        {BOOLEAN_SETTING_OPTIONS.map((option) => {
          const orientationBlocked =
            option.key ===
              "showOrientationLabels" &&
            !orientationAvailable;

          const optionDisabled =
            !canInteract || orientationBlocked;

          const checked = current[option.key];

          return (
            <label
              key={option.key}
              style={{
                ...toggleRowStyle,
                opacity: optionDisabled ? 0.5 : 1,
                cursor: optionDisabled
                  ? "not-allowed"
                  : "pointer",
              }}
            >
              <input
                type="checkbox"
                checked={checked}
                disabled={optionDisabled}
                onChange={(event) => {
                  handleToggle(
                    option.key,
                    event.currentTarget.checked,
                  );
                }}
                style={checkboxStyle}
                data-view-setting={option.key}
              />

              <span
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 3,
                }}
              >
                <span
                  style={{
                    fontSize: 12,
                    fontWeight: 600,
                  }}
                >
                  {option.label}
                </span>

                {!compact && (
                  <span style={descriptionStyle}>
                    {option.description}
                  </span>
                )}
              </span>
            </label>
          );
        })}
      </div>

      {!orientationAvailable && (
        <span
          style={{
            ...descriptionStyle,
            color: "#fbbf24",
          }}
          role="status"
        >
          Anatomical orientation labels require
          verified display geometry.
        </span>
      )}

      {loading && (
        <span
          role="status"
          aria-live="polite"
          style={descriptionStyle}
        >
          Preparing display settings…
        </span>
      )}

      {!compact && (
        <span style={descriptionStyle}>
          Settings affect visualization only.
          Original CT/CBCT data and measurements
          remain unchanged.
        </span>
      )}
    </section>
  );
}

// ============================================================
// 12 — CAPABILITIES
// ============================================================

export function getViewSettingsPanelCapabilities() {
  return {
    axialSupport: true,
    coronalSupport: true,
    sagittalSupport: true,
    controlledSettings: true,
    nearestInterpolation: true,
    linearInterpolation: true,
    grayscaleDisplayInversion: true,
    crosshairVisibility: true,
    measurementVisibility: true,
    anatomicalOrientationVisibility: true,
    coordinateReadoutVisibility: true,
    intensityReadoutVisibility: true,
    resetCommand: true,
    finiteSettingSchemaValidation: true,
    disabledState: true,
    loadingState: true,
    compactLayout: true,
    verifiedOrientationRequired: true,
    parentOwnedRendering: true,
    directImageResampling: false,
    directDICOMMutation: false,
    directNetworkRequests: false,
    browserPersistence: false,
    clinicalValidationComplete: false,
  } as const;
}

// ============================================================
// END OF SINUS VIEWER VIEW SETTINGS PANEL
// ============================================================
