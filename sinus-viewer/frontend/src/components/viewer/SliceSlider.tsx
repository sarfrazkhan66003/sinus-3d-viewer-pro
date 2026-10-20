
/**
 * SINUS VIEWER — MPR SLICE SLIDER
 * ===============================
 *
 * Controlled slice navigation for axial, coronal
 * and sagittal multiplanar reconstruction.
 *
 * Features:
 * - Zero-based slice index contract.
 * - Human-readable one-based slice position.
 * - Previous / next slice buttons.
 * - Optional jumps of 10 slices.
 * - Native keyboard-accessible range slider.
 * - Home / End and arrow-key support through
 *   native HTML range input behavior.
 * - Bounds clamping and invalid-value rejection.
 * - Optional verified physical-position label.
 * - Compact and normal presentation.
 * - Disabled, loading and empty-volume states.
 *
 * SAFETY:
 * - The parent owns the actual slice index.
 * - No DICOM file reading or writing.
 * - No direct network requests.
 * - No patient names, identifiers or paths.
 * - No physical coordinate inference.
 *
 * The parent must connect onSliceChange to the
 * verified MPR controller.
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

export type SliceSliderPlane =
  | "axial"
  | "coronal"
  | "sagittal";

export type SliceSliderSize =
  | "compact"
  | "normal";

export type SliceSliderChangeSource =
  | "slider"
  | "previous"
  | "next"
  | "jump-back"
  | "jump-forward";

export interface SliceSliderChange {
  readonly plane: SliceSliderPlane;
  readonly index: number;
  readonly source: SliceSliderChangeSource;
}

export interface SliceSliderProps {
  readonly plane: SliceSliderPlane;

  /**
   * Current zero-based index supplied by the parent.
   */
  readonly sliceIndex: number;

  /**
   * Total available slices along this MPR axis.
   * Zero means the axis has no navigable slices.
   */
  readonly sliceCount: number;

  readonly onSliceChange: (
    change: SliceSliderChange,
  ) => void;

  readonly disabled?: boolean;
  readonly loading?: boolean;
  readonly size?: SliceSliderSize;

  readonly showJumpButtons?: boolean;
  readonly showPhysicalPosition?: boolean;

  /**
   * Optional physical coordinate supplied by the
   * verified geometry controller, in millimeters.
   *
   * Never infer this value from index * spacing:
   * actual patient geometry may be oblique.
   */
  readonly physicalPositionMm?: number | null;

  readonly className?: string;
}


// ============================================================
// 02 — CONSTANTS
// ============================================================

export const SLICE_SLIDER_JUMP_STEP = 10;

export const SLICE_SLIDER_MAX_COUNT =
  Number.MAX_SAFE_INTEGER;

export const SLICE_SLIDER_DEFAULT_SIZE:
  SliceSliderSize = "normal";


// ============================================================
// 03 — PUBLIC VALIDATION HELPERS
// ============================================================

export function normalizeSliceCount(
  count: number,
): number {
  if (
    !Number.isFinite(count) ||
    !Number.isSafeInteger(count) ||
    count <= 0
  ) {
    return 0;
  }

  return Math.min(count, SLICE_SLIDER_MAX_COUNT);
}

export function clampSliceIndex(
  index: number,
  count: number,
): number {
  const safeCount = normalizeSliceCount(count);

  if (safeCount === 0) {
    return 0;
  }

  if (!Number.isFinite(index)) {
    return 0;
  }

  const integerIndex = Math.trunc(index);

  return Math.max(
    0,
    Math.min(safeCount - 1, integerIndex),
  );
}

export function getSliceNavigationState(
  index: number,
  count: number,
) {
  const safeCount = normalizeSliceCount(count);
  const current = clampSliceIndex(
    index,
    safeCount,
  );

  return {
    sliceCount: safeCount,
    index: current,
    hasSlices: safeCount > 0,
    canPrevious:
      safeCount > 0 && current > 0,
    canNext:
      safeCount > 0 &&
      current < safeCount - 1,
    displayIndex:
      safeCount > 0 ? current + 1 : 0,
  } as const;
}


// ============================================================
// 04 — LABEL HELPERS
// ============================================================

function planeLabel(
  plane: SliceSliderPlane,
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

function formatPhysicalPosition(
  position: number | null | undefined,
): string | null {
  if (
    typeof position !== "number" ||
    !Number.isFinite(position)
  ) {
    return null;
  }

  return `${position.toFixed(2)} mm`;
}


// ============================================================
// 05 — COMPONENT STYLES
// ============================================================

const rootStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  width: "100%",
  minWidth: 0,
  boxSizing: "border-box",
  gap: 9,
  padding: 11,
  color: "#e2e8f0",
  backgroundColor: "#101827",
  border: "1px solid #263244",
  borderRadius: 7,
};

const headerStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  flexWrap: "wrap",
  gap: 7,
};

const controlsStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 7,
  minWidth: 0,
};

const buttonStyle: CSSProperties = {
  minWidth: 31,
  minHeight: 31,
  padding: "5px 8px",
  border: "1px solid #344258",
  borderRadius: 5,
  backgroundColor: "#192437",
  color: "#e2e8f0",
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
};

const sliderStyle: CSSProperties = {
  flex: 1,
  minWidth: 60,
  width: "100%",
  height: 20,
  accentColor: "#38bdf8",
  cursor: "pointer",
};

const secondaryTextStyle: CSSProperties = {
  color: "#94a3b8",
  fontSize: 11,
  fontVariantNumeric: "tabular-nums",
};


// ============================================================
// 06 — MAIN COMPONENT
// ============================================================

export function SliceSlider({
  plane,
  sliceIndex,
  sliceCount,
  onSliceChange,
  disabled = false,
  loading = false,
  size = SLICE_SLIDER_DEFAULT_SIZE,
  showJumpButtons = true,
  showPhysicalPosition = false,
  physicalPositionMm = null,
  className = "",
}: SliceSliderProps) {
  const sliderId = useId();
  const positionId = useId();

  const state = getSliceNavigationState(
    sliceIndex,
    sliceCount,
  );

  const isDisabled =
    disabled ||
    loading ||
    !state.hasSlices;

  const physicalLabel =
    showPhysicalPosition
      ? formatPhysicalPosition(
          physicalPositionMm,
        )
      : null;

  // ==========================================================
  // 07 — CONTROLLED NAVIGATION
  // ==========================================================

  const navigate = useCallback(
    (
      proposedIndex: number,
      source: SliceSliderChangeSource,
    ): void => {
      if (isDisabled) {
        return;
      }

      const next = clampSliceIndex(
        proposedIndex,
        state.sliceCount,
      );

      // Avoid redundant parent updates.
      if (next === state.index) {
        return;
      }

      onSliceChange({
        plane,
        index: next,
        source,
      });
    },
    [
      isDisabled,
      onSliceChange,
      plane,
      state.index,
      state.sliceCount,
    ],
  );

  const handleSliderChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>): void => {
      const nextIndex = Number(
        event.currentTarget.value,
      );

      if (!Number.isSafeInteger(nextIndex)) {
        return;
      }

      navigate(nextIndex, "slider");
    },
    [navigate],
  );

  const previous = useCallback((): void => {
    navigate(
      state.index - 1,
      "previous",
    );
  }, [navigate, state.index]);

  const next = useCallback((): void => {
    navigate(
      state.index + 1,
      "next",
    );
  }, [navigate, state.index]);

  const jumpBack = useCallback((): void => {
    navigate(
      state.index - SLICE_SLIDER_JUMP_STEP,
      "jump-back",
    );
  }, [navigate, state.index]);

  const jumpForward = useCallback((): void => {
    navigate(
      state.index + SLICE_SLIDER_JUMP_STEP,
      "jump-forward",
    );
  }, [navigate, state.index]);

  // ==========================================================
  // 08 — ACCESSIBLE PRESENTATION
  // ==========================================================

  const displayPosition = state.hasSlices
    ? `${state.displayIndex} / ${state.sliceCount}`
    : "No slices";

  const accessibleValue = state.hasSlices
    ? `Slice ${state.displayIndex} of ${state.sliceCount}`
    : "No slices available";

  const canGoBack =
    !isDisabled && state.canPrevious;

  const canGoForward =
    !isDisabled && state.canNext;

  const compact = size === "compact";

  // ==========================================================
  // 09 — JSX
  // ==========================================================

  return (
    <section
      className={className}
      style={{
        ...rootStyle,
        padding: compact ? 8 : 11,
        gap: compact ? 6 : 9,
      }}
      data-slice-slider="true"
      data-slice-plane={plane}
      data-slice-empty={
        state.hasSlices ? "false" : "true"
      }
      aria-label={`${planeLabel(plane)} slice navigation`}
    >
      <div style={headerStyle}>
        <label
          htmlFor={sliderId}
          style={{
            fontSize: compact ? 11 : 12,
            fontWeight: 700,
            color: "#f8fafc",
          }}
        >
          {planeLabel(plane)} Slices
        </label>

        <span
          id={positionId}
          style={{
            ...secondaryTextStyle,
            color: "#cbd5e1",
          }}
        >
          {loading ? "Loading…" : displayPosition}
        </span>
      </div>

      <div style={controlsStyle}>
        {showJumpButtons && (
          <button
            type="button"
            style={{
              ...buttonStyle,
              opacity: canGoBack ? 1 : 0.5,
            }}
            disabled={!canGoBack}
            onClick={jumpBack}
            aria-label={`Back ${SLICE_SLIDER_JUMP_STEP} ${plane} slices`}
            title={`Back ${SLICE_SLIDER_JUMP_STEP} slices`}
          >
            −10
          </button>
        )}

        <button
          type="button"
          style={{
            ...buttonStyle,
            opacity: canGoBack ? 1 : 0.5,
          }}
          disabled={!canGoBack}
          onClick={previous}
          aria-label={`Previous ${plane} slice`}
          title="Previous slice"
        >
          ‹
        </button>

        <input
          id={sliderId}
          type="range"
          min={0}
          max={Math.max(0, state.sliceCount - 1)}
          step={1}
          value={state.index}
          disabled={isDisabled}
          onChange={handleSliderChange}
          style={{
            ...sliderStyle,
            cursor: isDisabled
              ? "not-allowed"
              : "pointer",
          }}
          aria-label={`${planeLabel(plane)} slice`}
          aria-valuetext={accessibleValue}
          aria-describedby={positionId}
          data-slice-range="true"
        />

        <button
          type="button"
          style={{
            ...buttonStyle,
            opacity: canGoForward ? 1 : 0.5,
          }}
          disabled={!canGoForward}
          onClick={next}
          aria-label={`Next ${plane} slice`}
          title="Next slice"
        >
          ›
        </button>

        {showJumpButtons && (
          <button
            type="button"
            style={{
              ...buttonStyle,
              opacity: canGoForward ? 1 : 0.5,
            }}
            disabled={!canGoForward}
            onClick={jumpForward}
            aria-label={`Forward ${SLICE_SLIDER_JUMP_STEP} ${plane} slices`}
            title={`Forward ${SLICE_SLIDER_JUMP_STEP} slices`}
          >
            +10
          </button>
        )}
      </div>

      {physicalLabel !== null && (
        <div
          style={secondaryTextStyle}
          aria-label={`Verified physical position: ${physicalLabel}`}
        >
          Position: {physicalLabel}
        </div>
      )}

      {loading && (
        <span
          style={secondaryTextStyle}
          role="status"
          aria-live="polite"
        >
          Preparing slices…
        </span>
      )}

      {!loading && !state.hasSlices && (
        <span
          style={secondaryTextStyle}
          role="status"
        >
          No navigable slices available.
        </span>
      )}
    </section>
  );
}


// ============================================================
// 10 — COMPONENT CAPABILITIES
// ============================================================

export function getSliceSliderCapabilities() {
  return {
    axialNavigation: true,
    coronalNavigation: true,
    sagittalNavigation: true,
    controlledSliceIndex: true,
    zeroBasedIndexContract: true,
    oneBasedDisplay: true,
    nativeRangeInput: true,
    previousNextButtons: true,
    tenSliceJumpButtons: true,
    indexBoundsClamping: true,
    invalidCountRejection: true,
    keyboardRangeNavigation: true,
    optionalPhysicalPosition: true,
    physicalPositionInference: false,
    compactLayout: true,
    loadingState: true,
    emptyVolumeState: true,
    disabledState: true,
    parentOwnedSliceUpdates: true,
    directNetworkRequests: false,
    browserPersistence: false,
    sourceDatasetModification: false,
    clinicalValidationComplete: false,
  } as const;
}


// ============================================================
// END OF SINUS VIEWER SLICE SLIDER
// ============================================================
