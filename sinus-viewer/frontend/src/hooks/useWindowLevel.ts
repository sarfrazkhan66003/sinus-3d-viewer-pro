
/**
 * SINUS VIEWER — REACT WINDOW / LEVEL HOOK
 * ========================================
 *
 * React 18 state management for CT/CBCT display:
 * - Window centre and width.
 * - Brightness and contrast.
 * - Grayscale inversion.
 * - Built-in and custom display presets.
 * - Percentile-based automatic window estimation.
 * - Mouse-drag window adjustment.
 * - Display reset.
 * - Rendering configuration for File 50.
 *
 * Important:
 * - Original voxel intensities are never modified.
 * - CBCT intensities are not assumed to be calibrated HU.
 * - This is a display controller, not HU calibration.
 * - No API, storage, or filesystem operations.
 */

import {
  useCallback,
  useMemo,
  useState,
} from "react";

import {
  DEFAULT_WINDOW_CENTER,
  DEFAULT_WINDOW_WIDTH,
  WINDOW_PRESETS,
  adjustBrightness,
  adjustContrast,
  createWindowLevel,
  estimateAutoWindow,
  normalizeAdjustments,
  scaleWindowWidth,
  shiftWindowCenter,
  validateWindowLevel,
  type AutoWindowOptions,
  type DisplayAdjustments,
  type RenderOptions,
  type WindowLevel,
} from "../utils/windowLevel";


// ============================================================
// 01 — PUBLIC CONSTANTS
// ============================================================

export const DEFAULT_WINDOW_DRAG_SENSITIVITY = 1;

export const DEFAULT_WIDTH_DRAG_SENSITIVITY = 1;

export const DEFAULT_WINDOW_LEVEL_SETTINGS = {
  window: {
    center: DEFAULT_WINDOW_CENTER,
    width: DEFAULT_WINDOW_WIDTH,
  },
  adjustments: {
    brightness: 0,
    contrast: 1,
    invert: false,
  },
} as const;


// ============================================================
// 02 — PUBLIC TYPES
// ============================================================

export type WindowPresetName =
  keyof typeof WINDOW_PRESETS;

export interface WindowLevelState {
  readonly window: WindowLevel;
  readonly adjustments: DisplayAdjustments;
  readonly selectedPreset: WindowPresetName | null;
  readonly revision: number;
}

export interface WindowLevelInitialOptions {
  readonly window?: WindowLevel;
  readonly adjustments?: Partial<DisplayAdjustments>;
}

export interface WindowDragOptions {
  readonly centerSensitivity?: number;
  readonly widthSensitivity?: number;
}

export interface WindowLevelActions {
  readonly setWindow: (
    window: WindowLevel,
  ) => void;

  readonly setCenter: (
    center: number,
  ) => void;

  readonly setWidth: (
    width: number,
  ) => void;

  readonly shiftCenter: (
    delta: number,
  ) => void;

  readonly scaleWidth: (
    factor: number,
  ) => void;

  readonly dragWindow: (
    deltaX: number,
    deltaY: number,
    options?: WindowDragOptions,
  ) => void;

  readonly setBrightness: (
    brightness: number,
  ) => void;

  readonly setContrast: (
    contrast: number,
  ) => void;

  readonly setInverted: (
    inverted: boolean,
  ) => void;

  readonly toggleInvert: () => void;

  readonly setAdjustments: (
    adjustments: Partial<DisplayAdjustments>,
  ) => void;

  readonly applyPreset: (
    name: WindowPresetName,
  ) => void;

  readonly autoWindow: (
    intensities: Float32Array | Float64Array,
    options?: AutoWindowOptions,
  ) => void;

  readonly reset: () => void;
}

export interface UseWindowLevelResult {
  readonly state: WindowLevelState;
  readonly actions: WindowLevelActions;

  readonly window: WindowLevel;
  readonly center: number;
  readonly width: number;

  readonly brightness: number;
  readonly contrast: number;
  readonly inverted: boolean;

  readonly selectedPreset: WindowPresetName | null;
  readonly renderOptions: RenderOptions;
  readonly revision: number;
}


// ============================================================
// 03 — INTERNAL HELPERS
// ============================================================

function assertFinite(
  value: number,
): void {
  if (!Number.isFinite(value)) {
    throw new Error(
      "Invalid display adjustment value.",
    );
  }
}

function assertPreset(
  name: WindowPresetName,
): void {
  if (
    !Object.prototype.hasOwnProperty.call(
      WINDOW_PRESETS,
      name,
    )
  ) {
    throw new Error(
      "Unknown window/level preset.",
    );
  }
}

function makeInitialState(
  options: WindowLevelInitialOptions,
): WindowLevelState {
  const window = options.window
    ? createWindowLevel(
        options.window.center,
        options.window.width,
      )
    : createWindowLevel(
        DEFAULT_WINDOW_CENTER,
        DEFAULT_WINDOW_WIDTH,
      );

  const adjustments = normalizeAdjustments(
    options.adjustments,
  );

  return {
    window,
    adjustments,
    selectedPreset: null,
    revision: 0,
  };
}

function withWindow(
  previous: WindowLevelState,
  window: WindowLevel,
  preset: WindowPresetName | null = null,
): WindowLevelState {
  validateWindowLevel(window);

  if (
    previous.window.center === window.center &&
    previous.window.width === window.width &&
    previous.selectedPreset === preset
  ) {
    return previous;
  }

  return {
    ...previous,
    window: {
      center: window.center,
      width: window.width,
    },
    selectedPreset: preset,
    revision: previous.revision + 1,
  };
}

function withAdjustments(
  previous: WindowLevelState,
  adjustments: DisplayAdjustments,
): WindowLevelState {
  if (
    previous.adjustments.brightness ===
      adjustments.brightness &&
    previous.adjustments.contrast ===
      adjustments.contrast &&
    previous.adjustments.invert ===
      adjustments.invert
  ) {
    return previous;
  }

  return {
    ...previous,
    adjustments,
    revision: previous.revision + 1,
  };
}


// ============================================================
// 04 — MAIN REACT HOOK
// ============================================================

/**
 * Each hook invocation owns independent display settings.
 *
 * Call once at the viewer container level when three MPR
 * planes should use one shared window/level configuration.
 *
 * Initial options are captured on mount. To restore new
 * volume-specific defaults, remount with a new React key
 * or invoke reset().
 */
export function useWindowLevel(
  initialOptions: WindowLevelInitialOptions = {},
): UseWindowLevelResult {
  const [state, setState] = useState<WindowLevelState>(
    () => makeInitialState(initialOptions),
  );

  // ==========================================================
  // 05 — WINDOW CENTRE / WIDTH
  // ==========================================================

  const setWindow = useCallback(
    (window: WindowLevel): void => {
      const checked = createWindowLevel(
        window.center,
        window.width,
      );

      setState((previous) =>
        withWindow(previous, checked),
      );
    },
    [],
  );

  const setCenter = useCallback(
    (center: number): void => {
      assertFinite(center);

      setState((previous) =>
        withWindow(
          previous,
          createWindowLevel(
            center,
            previous.window.width,
          ),
        ),
      );
    },
    [],
  );

  const setWidth = useCallback(
    (width: number): void => {
      assertFinite(width);

      setState((previous) =>
        withWindow(
          previous,
          createWindowLevel(
            previous.window.center,
            width,
          ),
        ),
      );
    },
    [],
  );

  const shiftCenter = useCallback(
    (delta: number): void => {
      assertFinite(delta);

      setState((previous) =>
        withWindow(
          previous,
          shiftWindowCenter(
            previous.window,
            delta,
          ),
        ),
      );
    },
    [],
  );

  const scaleWidth = useCallback(
    (factor: number): void => {
      assertFinite(factor);

      setState((previous) =>
        withWindow(
          previous,
          scaleWindowWidth(
            previous.window,
            factor,
          ),
        ),
      );
    },
    [],
  );

  // ==========================================================
  // 06 — MOUSE DRAG WINDOW ADJUSTMENT
  // ==========================================================

  /**
   * Horizontal drag changes width.
   * Vertical drag changes centre.
   *
   * Sensitivities are source-intensity units per
   * screen pixel, not necessarily HU per pixel.
   */
  const dragWindow = useCallback(
    (
      deltaX: number,
      deltaY: number,
      options: WindowDragOptions = {},
    ): void => {
      assertFinite(deltaX);
      assertFinite(deltaY);

      const centerSensitivity =
        options.centerSensitivity ??
        DEFAULT_WINDOW_DRAG_SENSITIVITY;

      const widthSensitivity =
        options.widthSensitivity ??
        DEFAULT_WIDTH_DRAG_SENSITIVITY;

      if (
        !Number.isFinite(centerSensitivity) ||
        !Number.isFinite(widthSensitivity) ||
        centerSensitivity <= 0 ||
        widthSensitivity <= 0
      ) {
        throw new Error(
          "Invalid window drag sensitivity.",
        );
      }

      setState((previous) => {
        const nextCenter =
          previous.window.center +
          deltaY * centerSensitivity;

        const nextWidth = Math.max(
          1,
          previous.window.width +
          deltaX * widthSensitivity,
        );

        return withWindow(
          previous,
          createWindowLevel(
            nextCenter,
            nextWidth,
          ),
        );
      });
    },
    [],
  );

  // ==========================================================
  // 07 — BRIGHTNESS / CONTRAST
  // ==========================================================

  const setBrightness = useCallback(
    (brightness: number): void => {
      setState((previous) =>
        withAdjustments(
          previous,
          adjustBrightness(
            previous.adjustments,
            brightness,
          ),
        ),
      );
    },
    [],
  );

  const setContrast = useCallback(
    (contrast: number): void => {
      setState((previous) =>
        withAdjustments(
          previous,
          adjustContrast(
            previous.adjustments,
            contrast,
          ),
        ),
      );
    },
    [],
  );

  // ==========================================================
  // 08 — GRAYSCALE INVERSION
  // ==========================================================

  const setInverted = useCallback(
    (inverted: boolean): void => {
      const checked = normalizeAdjustments({
        invert: inverted,
      });

      setState((previous) =>
        withAdjustments(
          previous,
          {
            ...previous.adjustments,
            invert: checked.invert,
          },
        ),
      );
    },
    [],
  );

  const toggleInvert = useCallback(
    (): void => {
      setState((previous) =>
        withAdjustments(
          previous,
          normalizeAdjustments({
            ...previous.adjustments,
            invert: !previous.adjustments.invert,
          }),
        ),
      );
    },
    [],
  );

  // ==========================================================
  // 09 — MULTIPLE DISPLAY ADJUSTMENTS
  // ==========================================================

  const setAdjustments = useCallback(
    (
      adjustments: Partial<DisplayAdjustments>,
    ): void => {
      setState((previous) =>
        withAdjustments(
          previous,
          normalizeAdjustments({
            ...previous.adjustments,
            ...adjustments,
          }),
        ),
      );
    },
    [],
  );

  // ==========================================================
  // 10 — BUILT-IN PRESETS
  // ==========================================================

  const applyPreset = useCallback(
    (name: WindowPresetName): void => {
      assertPreset(name);

      const preset = WINDOW_PRESETS[name];

      setState((previous) =>
        withWindow(
          previous,
          createWindowLevel(
            preset.center,
            preset.width,
          ),
          name,
        ),
      );
    },
    [],
  );

  // ==========================================================
  // 11 — AUTOMATIC INTENSITY WINDOW
  // ==========================================================

  /**
   * This operation samples bounded source intensities
   * and estimates a useful visual display range.
   *
   * No source buffer mutation occurs.
   * This does NOT determine clinically calibrated HU.
   */
  const autoWindow = useCallback(
    (
      intensities: Float32Array | Float64Array,
      options: AutoWindowOptions = {},
    ): void => {
      const estimated = estimateAutoWindow(
        intensities,
        options,
      );

      setState((previous) =>
        withWindow(previous, estimated),
      );
    },
    [],
  );

  // ==========================================================
  // 12 — RESET
  // ==========================================================

  const reset = useCallback(
    (): void => {
      const initial = makeInitialState(initialOptions);

      setState((previous) => ({
        ...initial,
        revision: previous.revision + 1,
      }));
    },
    // Initial options are mount-time configuration.
    // Prefer a stable options object in the owning component.
    [initialOptions],
  );

  // ==========================================================
  // 13 — CANVAS RENDERING OPTIONS
  // ==========================================================

  const renderOptions = useMemo<RenderOptions>(
    () => ({
      window: state.window,
      adjustments: state.adjustments,
      invalidPixelValue: 0,
    }),
    [state.window, state.adjustments],
  );

  // ==========================================================
  // 14 — STABLE ACTION BUNDLE
  // ==========================================================

  const actions = useMemo<WindowLevelActions>(
    () => ({
      setWindow,
      setCenter,
      setWidth,
      shiftCenter,
      scaleWidth,
      dragWindow,
      setBrightness,
      setContrast,
      setInverted,
      toggleInvert,
      setAdjustments,
      applyPreset,
      autoWindow,
      reset,
    }),
    [
      setWindow,
      setCenter,
      setWidth,
      shiftCenter,
      scaleWidth,
      dragWindow,
      setBrightness,
      setContrast,
      setInverted,
      toggleInvert,
      setAdjustments,
      applyPreset,
      autoWindow,
      reset,
    ],
  );

  return {
    state,
    actions,

    window: state.window,
    center: state.window.center,
    width: state.window.width,

    brightness: state.adjustments.brightness,
    contrast: state.adjustments.contrast,
    inverted: state.adjustments.invert,

    selectedPreset: state.selectedPreset,
    renderOptions,
    revision: state.revision,
  };
}


// ============================================================
// 15 — DISPLAY PRESET DISCOVERY
// ============================================================

export function getWindowPresetNames():
  readonly WindowPresetName[] {
  return Object.keys(
    WINDOW_PRESETS,
  ) as WindowPresetName[];
}


// ============================================================
// 16 — HOOK CAPABILITIES
// ============================================================

export function getWindowLevelHookCapabilities() {
  return {
    reactStateController: true,
    windowCenterAndWidth: true,
    brightnessAndContrast: true,
    grayscaleInversion: true,
    builtinPresets: true,
    percentileAutoWindow: true,
    mouseDragAdjustment: true,
    canvasRenderOptions: true,
    assumesCalibratedHU: false,
    modifiesSourceVoxels: false,
    persistentBrowserStorage: false,
    diagnosticValidationComplete: false,
  } as const;
}


// ============================================================
// END OF SINUS VIEWER REACT WINDOW / LEVEL HOOK
// ============================================================
