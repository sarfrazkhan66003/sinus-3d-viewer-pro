
/**
 * SINUS VIEWER — VIEWPORT LOADING SKELETON
 * ========================================
 *
 * Neutral, privacy-safe placeholder for a single
 * MPR viewport while image content is unavailable.
 *
 * States:
 * - loading
 * - decoding
 * - preparing
 * - rendering
 *
 * Features:
 * - Axial / coronal / sagittal support.
 * - Fixed, allowlisted loading messages.
 * - Optional verified progress percentage.
 * - Indeterminate progress presentation.
 * - Responsive layout and compact mode.
 * - Reduced-motion compatible static visuals.
 * - No cached patient-image preview.
 * - No patient identifiers or raw error messages.
 *
 * The component does NOT:
 * - Fetch or decode DICOM files.
 * - Display previous image pixels.
 * - Generate synthetic anatomical imagery.
 * - Inspect backend exceptions.
 * - Persist information in browser storage.
 * - Modify original CT/CBCT data.
 */

import {
  useMemo,
  type CSSProperties,
} from "react";

// ============================================================
// 01 — TYPES
// ============================================================

export type LoadingSkeletonPlane =
  | "axial"
  | "coronal"
  | "sagittal";

export type LoadingSkeletonPhase =
  | "loading"
  | "decoding"
  | "preparing"
  | "rendering";

export interface ViewportLoadingSkeletonProps {
  readonly plane: LoadingSkeletonPlane;
  readonly phase?: LoadingSkeletonPhase;

  readonly visible?: boolean;
  readonly compact?: boolean;

  /**
   * Genuine progress from an upstream operation.
   * Omit when no trustworthy percentage exists.
   */
  readonly progressPercent?: number | null;

  readonly showProgress?: boolean;
  readonly showPlaneLabel?: boolean;

  /**
   * Optional externally controlled height.
   * Parent must ensure viewport sizing is valid.
   */
  readonly minHeightCssPx?: number;

  readonly className?: string;
}

export interface LoadingSkeletonDisplay {
  readonly planeLabel: string;
  readonly title: string;
  readonly description: string;
  readonly progressPercent: number | null;
  readonly determinate: boolean;
}

// ============================================================
// 02 — CONSTANTS
// ============================================================

export const SKELETON_DEFAULT_MIN_HEIGHT_PX = 180;
export const SKELETON_MIN_HEIGHT_PX = 80;
export const SKELETON_MAX_HEIGHT_PX = 10000;

const PHASE_MESSAGES: Readonly<
  Record<
    LoadingSkeletonPhase,
    {
      readonly title: string;
      readonly description: string;
    }
  >
> = {
  loading: {
    title: "Loading image volume",
    description: "Preparing image data for viewing.",
  },
  decoding: {
    title: "Decoding image frames",
    description: "Processing supported image data.",
  },
  preparing: {
    title: "Preparing MPR views",
    description: "Constructing the display geometry.",
  },
  rendering: {
    title: "Rendering image",
    description: "Preparing the current view.",
  },
};

// ============================================================
// 03 — VALIDATION HELPERS
// ============================================================

export function isLoadingSkeletonPhase(
  value: unknown,
): value is LoadingSkeletonPhase {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(
      PHASE_MESSAGES,
      value,
    )
  );
}

export function normalizeSkeletonProgress(
  value: number | null | undefined,
): number | null {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value)
  ) {
    return null;
  }

  return Math.max(
    0,
    Math.min(100, value),
  );
}

export function normalizeSkeletonMinHeight(
  value: number | undefined,
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value)
  ) {
    return SKELETON_DEFAULT_MIN_HEIGHT_PX;
  }

  return Math.max(
    SKELETON_MIN_HEIGHT_PX,
    Math.min(SKELETON_MAX_HEIGHT_PX, value),
  );
}

export function loadingSkeletonPlaneLabel(
  plane: LoadingSkeletonPlane,
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

// ============================================================
// 04 — DISPLAY MODEL
// ============================================================

export function buildLoadingSkeletonDisplay(
  plane: LoadingSkeletonPlane,
  phase: LoadingSkeletonPhase,
  progressPercent?: number | null,
  showProgress = true,
): LoadingSkeletonDisplay {
  const safePhase = isLoadingSkeletonPhase(phase)
    ? phase
    : "loading";

  const message = PHASE_MESSAGES[safePhase];

  const progress = showProgress
    ? normalizeSkeletonProgress(progressPercent)
    : null;

  return {
    planeLabel: loadingSkeletonPlaneLabel(plane),
    title: message.title,
    description: message.description,
    progressPercent: progress,
    determinate: progress !== null,
  };
}

// ============================================================
// 05 — STYLES
// ============================================================

const rootStyle: CSSProperties = {
  position: "relative",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  width: "100%",
  height: "100%",
  boxSizing: "border-box",
  overflow: "hidden",
  padding: 16,
  backgroundColor: "#090f1b",
  color: "#e2e8f0",
  userSelect: "none",
};

const innerStyle: CSSProperties = {
  position: "relative",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 11,
  width: "100%",
  maxWidth: 330,
  textAlign: "center",
  zIndex: 1,
};

const neutralFrameStyle: CSSProperties = {
  width: "min(42%, 150px)",
  aspectRatio: "1",
  minWidth: 72,
  maxWidth: 150,
  border: "1px solid #334155",
  borderRadius: 8,
  backgroundColor: "#121c2c",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  boxShadow: "inset 0 0 0 5px rgba(255,255,255,0.015)",
};

const progressTrackStyle: CSSProperties = {
  width: "100%",
  height: 7,
  borderRadius: 999,
  backgroundColor: "#253348",
  overflow: "hidden",
};

const progressFillStyle: CSSProperties = {
  height: "100%",
  borderRadius: 999,
  backgroundColor: "#38bdf8",
  transition: "none",
};

const descriptionStyle: CSSProperties = {
  color: "#94a3b8",
  fontSize: 11,
  lineHeight: 1.5,
};

// ============================================================
// 06 — NEUTRAL PLACEHOLDER GLYPH
// ============================================================

function NeutralViewportGlyph() {
  return (
    <svg
      width={46}
      height={46}
      viewBox="0 0 48 48"
      fill="none"
      stroke="#64748b"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="5" y="5" width="38" height="38" rx="4" />
      <path d="M24 10v9M24 29v9M10 24h9M29 24h9" />
      <circle cx="24" cy="24" r="5" />
    </svg>
  );
}

// ============================================================
// 07 — MAIN COMPONENT
// ============================================================

export function ViewportLoadingSkeleton({
  plane,
  phase = "loading",
  visible = true,
  compact = false,
  progressPercent = null,
  showProgress = true,
  showPlaneLabel = true,
  minHeightCssPx,
  className = "",
}: ViewportLoadingSkeletonProps) {
  const display = useMemo(
    () =>
      buildLoadingSkeletonDisplay(
        plane,
        phase,
        progressPercent,
        showProgress,
      ),
    [
      plane,
      phase,
      progressPercent,
      showProgress,
    ],
  );

  if (!visible) {
    return null;
  }

  const minHeight = normalizeSkeletonMinHeight(
    minHeightCssPx,
  );

  return (
    <section
      className={className}
      style={{
        ...rootStyle,
        minHeight,
        padding: compact ? 10 : 16,
      }}
      role="status"
      aria-live="polite"
      aria-busy="true"
      aria-label={
        `${display.planeLabel} image preparation`
      }
      data-viewport-loading-skeleton="true"
      data-skeleton-plane={plane}
      data-skeleton-phase={
        isLoadingSkeletonPhase(phase)
          ? phase
          : "loading"
      }
    >
      <div
        style={{
          ...innerStyle,
          gap: compact ? 7 : 11,
        }}
      >
        <div
          style={{
            ...neutralFrameStyle,
            width: compact ? 76 : "min(42%, 150px)",
            minWidth: compact ? 76 : 72,
          }}
          aria-hidden="true"
          data-skeleton-neutral-frame="true"
        >
          <NeutralViewportGlyph />
        </div>

        {showPlaneLabel && (
          <strong
            style={{
              color: "#e0f2fe",
              fontSize: compact ? 11 : 12,
              letterSpacing: "0.03em",
            }}
          >
            {display.planeLabel}
          </strong>
        )}

        <span
          style={{
            fontSize: compact ? 12 : 13,
            fontWeight: 600,
          }}
        >
          {display.title}
        </span>

        {!compact && (
          <span style={descriptionStyle}>
            {display.description}
          </span>
        )}

        {showProgress && (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 6,
              width: "100%",
            }}
          >
            {display.determinate ? (
              <>
                <div
                  role="progressbar"
                  aria-label={
                    `${display.planeLabel} loading progress`
                  }
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={
                    display.progressPercent ?? 0
                  }
                  style={progressTrackStyle}
                  data-skeleton-progress="determinate"
                >
                  <div
                    style={{
                      ...progressFillStyle,
                      width:
                        `${display.progressPercent ?? 0}%`,
                    }}
                  />
                </div>

                <span
                  style={{
                    color: "#cbd5e1",
                    fontSize: 11,
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {Math.round(
                    display.progressPercent ?? 0,
                  )}%
                </span>
              </>
            ) : (
              <div
                role="progressbar"
                aria-label={
                  `${display.planeLabel} loading`
                }
                style={{
                  ...progressTrackStyle,
                  background:
                    "linear-gradient(90deg, #253348 0%, #155e75 50%, #253348 100%)",
                }}
                data-skeleton-progress="indeterminate"
              />
            )}
          </div>
        )}
      </div>
    </section>
  );
}

// ============================================================
// 08 — CAPABILITIES
// ============================================================

export function getViewportLoadingSkeletonCapabilities() {
  return {
    axialSupport: true,
    coronalSupport: true,
    sagittalSupport: true,
    loadingState: true,
    decodingState: true,
    preparingState: true,
    renderingState: true,
    determinateProgress: true,
    indeterminateProgress: true,
    safeProgressClamping: true,
    allowlistedStatusMessages: true,
    responsiveLayout: true,
    compactLayout: true,
    reducedMotionFriendly: true,
    patientContentPreview: false,
    anatomicalImageGeneration: false,
    patientMetadataDisplay: false,
    directNetworkRequests: false,
    browserPersistence: false,
    originalDICOMModification: false,
    clinicalValidationComplete: false,
  } as const;
}

// ============================================================
// END OF SINUS VIEWER VIEWPORT LOADING SKELETON
// ============================================================
