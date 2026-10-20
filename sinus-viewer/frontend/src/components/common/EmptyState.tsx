
/**
 * SINUS VIEWER — REUSABLE EMPTY STATE
 * ===================================
 *
 * Consistent UI for missing or unselected content.
 *
 * Features:
 * - No dataset selected.
 * - No patient records.
 * - No imaging series.
 * - No previews.
 * - No loaded volume.
 * - No measurements.
 * - No matching results.
 * - Missing/unsupported content.
 * - Retry, Browse, Back and Clear Selection actions.
 * - Compact and full-panel layouts.
 * - Accessible messages and buttons.
 *
 * Privacy and safety:
 * - Only predefined, non-identifying messages.
 * - Never displays patient names or DICOM UIDs.
 * - Never displays original dataset paths.
 * - No API calls or browser persistence.
 * - No source DICOM read/write operations.
 *
 * Actions are supplied by the parent application.
 */

import {
  useCallback,
  type CSSProperties,
  type ReactNode,
} from "react";

// ============================================================
// 01 — PUBLIC TYPES
// ============================================================

export type EmptyStateKind =
  | "no-dataset"
  | "no-patients"
  | "no-series"
  | "no-previews"
  | "no-volume"
  | "no-measurements"
  | "no-results"
  | "unsupported"
  | "generic";

export type EmptyStateSize =
  | "compact"
  | "normal"
  | "full";

export interface EmptyStateProps {
  readonly kind: EmptyStateKind;

  readonly size?: EmptyStateSize;
  readonly disabled?: boolean;
  readonly busy?: boolean;
  readonly className?: string;

  readonly onRetry?: () => void;
  readonly onBrowseDatasets?: () => void;
  readonly onBack?: () => void;
  readonly onClearSelection?: () => void;

  /**
   * Optional safe UI decorations.
   * Never pass patient-identifying React nodes.
   */
  readonly accessory?: ReactNode;
}

interface EmptyStateDefinition {
  readonly title: string;
  readonly description: string;
  readonly icon: "database" | "users" | "layers" |
    "image" | "scan" | "ruler" | "search" |
    "warning" | "info";
  readonly suggestion: string;
}

// ============================================================
// 02 — PREDEFINED PUBLIC MESSAGES
// ============================================================

export const EMPTY_STATE_DEFINITIONS: Readonly<
  Record<EmptyStateKind, EmptyStateDefinition>
> = {
  "no-dataset": {
    title: "No dataset selected",
    description:
      "Choose an authorized dataset to begin browsing imaging records.",
    icon: "database",
    suggestion:
      "Use Browse Datasets to choose an available source.",
  },

  "no-patients": {
    title: "No patient records available",
    description:
      "The selected dataset has no accessible patient records.",
    icon: "users",
    suggestion:
      "Select another authorized dataset or retry.",
  },

  "no-series": {
    title: "No imaging series available",
    description:
      "No accessible CT or CBCT series is available for this selection.",
    icon: "layers",
    suggestion:
      "Try another record or return to the dataset browser.",
  },

  "no-previews": {
    title: "No previews available",
    description:
      "Axial, coronal and sagittal preview images are not available.",
    icon: "image",
    suggestion:
      "Retry preview loading or choose a different series.",
  },

  "no-volume": {
    title: "No volume loaded",
    description:
      "Select an authorized imaging series to open the MPR viewer.",
    icon: "scan",
    suggestion:
      "Browse datasets to select a CT or CBCT volume.",
  },

  "no-measurements": {
    title: "No measurements",
    description:
      "There are no completed measurements to display.",
    icon: "ruler",
    suggestion:
      "Choose a measurement tool and place points on an image.",
  },

  "no-results": {
    title: "No matching results",
    description:
      "No items match the current selection or filters.",
    icon: "search",
    suggestion:
      "Clear the selection or try another search.",
  },

  unsupported: {
    title: "Content unavailable",
    description:
      "This content cannot be displayed with the current viewer.",
    icon: "warning",
    suggestion:
      "Choose a supported imaging series.",
  },

  generic: {
    title: "Nothing to display",
    description:
      "There is no content available in this section.",
    icon: "info",
    suggestion:
      "Choose another item or return to the previous view.",
  },
};

// ============================================================
// 03 — PRESENTATION HELPERS
// ============================================================

function iconPath(
  kind: EmptyStateDefinition["icon"],
): ReactNode {
  switch (kind) {
    case "database":
      return (
        <>
          <ellipse cx="12" cy="5" rx="8" ry="3" />
          <path d="M4 5v14c0 1.66 3.58 3 8 3s8-1.34 8-3V5" />
          <path d="M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3" />
        </>
      );

    case "users":
      return (
        <>
          <circle cx="9" cy="8" r="3" />
          <path d="M3 21v-2a6 6 0 0 1 12 0v2" />
          <path d="M16 5a3 3 0 0 1 0 6" />
          <path d="M18 15a5 5 0 0 1 3 5v1" />
        </>
      );

    case "layers":
      return (
        <>
          <path d="m12 2 10 6-10 6L2 8l10-6Z" />
          <path d="m2 12 10 6 10-6" />
          <path d="m2 16 10 6 10-6" />
        </>
      );

    case "image":
      return (
        <>
          <rect x="2" y="3" width="20" height="18" rx="2" />
          <circle cx="8" cy="9" r="2" />
          <path d="m3 19 6-6 4 4 4-5 4 5" />
        </>
      );

    case "scan":
      return (
        <>
          <path d="M8 3H5a2 2 0 0 0-2 2v3" />
          <path d="M16 3h3a2 2 0 0 1 2 2v3" />
          <path d="M3 16v3a2 2 0 0 0 2 2h3" />
          <path d="M21 16v3a2 2 0 0 1-2 2h-3" />
          <circle cx="12" cy="12" r="5" />
          <path d="M12 8v8M8 12h8" />
        </>
      );

    case "ruler":
      return (
        <>
          <rect
            x="3"
            y="8"
            width="18"
            height="8"
            rx="1"
            transform="rotate(-30 12 12)"
          />
          <path d="m8 11 2 3m2-6 2 3m2-6 2 3" />
        </>
      );

    case "search":
      return (
        <>
          <circle cx="10.5" cy="10.5" r="6.5" />
          <path d="m16 16 5 5" />
        </>
      );

    case "warning":
      return (
        <>
          <path d="M12 3 2 21h20L12 3Z" />
          <path d="M12 9v5" />
          <circle cx="12" cy="17" r="0.5" />
        </>
      );

    case "info":
      return (
        <>
          <circle cx="12" cy="12" r="10" />
          <path d="M12 11v6" />
          <circle cx="12" cy="7.5" r="0.5" />
        </>
      );
  }
}

export function getEmptyStateDefinition(
  kind: EmptyStateKind,
): EmptyStateDefinition {
  return EMPTY_STATE_DEFINITIONS[kind] ??
    EMPTY_STATE_DEFINITIONS.generic;
}

// ============================================================
// 04 — STYLES
// ============================================================

const rootStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: 12,
  width: "100%",
  minWidth: 0,
  boxSizing: "border-box",
  textAlign: "center",
  color: "#e2e8f0",
  backgroundColor: "#101827",
  border: "1px solid #263244",
  borderRadius: 8,
};

const iconStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  borderRadius: "50%",
  backgroundColor: "#172e42",
  color: "#7dd3fc",
};

const descriptionStyle: CSSProperties = {
  margin: 0,
  maxWidth: 440,
  fontSize: 12,
  lineHeight: 1.6,
  color: "#cbd5e1",
};

const suggestionStyle: CSSProperties = {
  margin: 0,
  maxWidth: 440,
  fontSize: 11,
  lineHeight: 1.5,
  color: "#94a3b8",
};

const actionsStyle: CSSProperties = {
  display: "flex",
  justifyContent: "center",
  flexWrap: "wrap",
  gap: 8,
  width: "100%",
};

const buttonStyle: CSSProperties = {
  minHeight: 34,
  padding: "7px 12px",
  borderRadius: 5,
  border: "1px solid #344258",
  backgroundColor: "#192437",
  color: "#f8fafc",
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
};

const primaryButtonStyle: CSSProperties = {
  ...buttonStyle,
  backgroundColor: "#164e63",
  borderColor: "#38bdf8",
  color: "#e0f2fe",
};

// ============================================================
// 05 — MAIN COMPONENT
// ============================================================

export function EmptyState({
  kind,
  size = "normal",
  disabled = false,
  busy = false,
  className = "",
  onRetry,
  onBrowseDatasets,
  onBack,
  onClearSelection,
  accessory,
}: EmptyStateProps) {
  const definition = getEmptyStateDefinition(kind);

  const actionsDisabled = disabled || busy;

  const compact = size === "compact";

  const rootPadding =
    compact ? 12 : size === "full" ? 32 : 20;

  // ==========================================================
  // 06 — OPTIONAL PARENT ACTIONS
  // ==========================================================

  const handleRetry = useCallback((): void => {
    if (!actionsDisabled) {
      onRetry?.();
    }
  }, [actionsDisabled, onRetry]);

  const handleBrowse = useCallback((): void => {
    if (!actionsDisabled) {
      onBrowseDatasets?.();
    }
  }, [actionsDisabled, onBrowseDatasets]);

  const handleBack = useCallback((): void => {
    if (!actionsDisabled) {
      onBack?.();
    }
  }, [actionsDisabled, onBack]);

  const handleClear = useCallback((): void => {
    if (!actionsDisabled) {
      onClearSelection?.();
    }
  }, [actionsDisabled, onClearSelection]);

  // ==========================================================
  // 07 — JSX OUTPUT
  // ==========================================================

  return (
    <section
      className={className}
      style={{
        ...rootStyle,
        padding: rootPadding,
        minHeight: size === "full"
          ? 320
          : compact
            ? 140
            : 220,
        gap: compact ? 8 : 12,
      }}
      aria-label={definition.title}
      data-empty-state={kind}
      data-empty-state-size={size}
    >
      <div
        style={{
          ...iconStyle,
          width: compact ? 42 : 56,
          height: compact ? 42 : 56,
        }}
        aria-hidden="true"
      >
        <svg
          width={compact ? 23 : 30}
          height={compact ? 23 : 30}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.7}
          strokeLinecap="round"
          strokeLinejoin="round"
          focusable="false"
        >
          {iconPath(definition.icon)}
        </svg>
      </div>

      <h2
        style={{
          margin: 0,
          fontSize: compact ? 14 : 17,
          fontWeight: 700,
          color: "#f8fafc",
        }}
      >
        {definition.title}
      </h2>

      <p style={descriptionStyle}>
        {definition.description}
      </p>

      {!compact && (
        <p style={suggestionStyle}>
          {definition.suggestion}
        </p>
      )}

      {accessory && (
        <div
          style={{
            width: "100%",
            maxWidth: 440,
          }}
        >
          {accessory}
        </div>
      )}

      <div
        style={actionsStyle}
        role="group"
        aria-label="Empty state actions"
      >
        {onBrowseDatasets && (
          <button
            type="button"
            style={primaryButtonStyle}
            disabled={actionsDisabled}
            onClick={handleBrowse}
          >
            Browse Datasets
          </button>
        )}

        {onRetry && (
          <button
            type="button"
            style={buttonStyle}
            disabled={actionsDisabled}
            onClick={handleRetry}
          >
            {busy ? "Working…" : "Retry"}
          </button>
        )}

        {onBack && (
          <button
            type="button"
            style={buttonStyle}
            disabled={actionsDisabled}
            onClick={handleBack}
          >
            Go Back
          </button>
        )}

        {onClearSelection && (
          <button
            type="button"
            style={buttonStyle}
            disabled={actionsDisabled}
            onClick={handleClear}
          >
            Clear Selection
          </button>
        )}
      </div>

      {size === "full" && (
        <p
          style={{
            ...suggestionStyle,
            marginTop: 8,
          }}
        >
          Original CT/CBCT DICOM files remain unchanged.
          Research visualization requires validation.
        </p>
      )}
    </section>
  );
}

// ============================================================
// 08 — COMPONENT CAPABILITIES
// ============================================================

export function getEmptyStateCapabilities() {
  return {
    noDatasetState: true,
    noPatientRecordsState: true,
    noSeriesState: true,
    noPreviewsState: true,
    noVolumeState: true,
    noMeasurementsState: true,
    noResultsState: true,
    unsupportedContentState: true,
    predefinedSafeMessages: true,
    compactLayout: true,
    fullPanelLayout: true,
    retryCallback: true,
    browseDatasetsCallback: true,
    backCallback: true,
    clearSelectionCallback: true,
    disabledAndBusyStates: true,
    accessibleButtons: true,
    networkRequests: false,
    browserPersistence: false,
    originalDICOMAccess: false,
    modifiesSourceDataset: false,
  } as const;
}

// ============================================================
// END OF SINUS VIEWER EMPTY STATE
// ============================================================
