
/**
 * SINUS VIEWER — VIEWPORT TOOLBAR
 * ===============================
 *
 * Presentation-only toolbar for a single MPR viewport.
 *
 * Features:
 * - Plane-specific identification.
 * - Pan and zoom tool selection.
 * - Crosshair navigation tool.
 * - Zoom in and zoom out commands.
 * - Fit-to-view and reset-view commands.
 * - Crosshair visibility toggle.
 * - Optional plane activation.
 * - Controlled active tool and crosshair visibility.
 * - Loading / disabled / unavailable guards.
 * - Compact and normal layouts.
 * - Accessible buttons and keyboard focus.
 *
 * IMPORTANT:
 * This component does not implement geometry or
 * image transformations. The parent owns all actions.
 *
 * PRIVACY:
 * - No patient metadata displayed.
 * - No raw source paths or DICOM UIDs.
 * - No network requests or browser persistence.
 * - No original DICOM modifications.
 *
 * Diagnostic use requires independent validation.
 */

import {
  useCallback,
  type CSSProperties,
  type ReactNode,
} from "react";


// ============================================================
// 01 — PUBLIC TYPES
// ============================================================

export type ViewportToolbarPlane =
  | "axial"
  | "coronal"
  | "sagittal";

export type ViewportInteractionTool =
  | "pan"
  | "zoom"
  | "crosshair";

export type ViewportToolbarSize =
  | "compact"
  | "normal";

export type ViewportToolbarCommand =
  | "activate"
  | "zoom-in"
  | "zoom-out"
  | "fit"
  | "reset"
  | "toggle-crosshair";

export interface ViewportToolbarProps {
  readonly plane: ViewportToolbarPlane;

  readonly activeTool: ViewportInteractionTool;

  readonly crosshairVisible: boolean;

  readonly viewportActive?: boolean;
  readonly viewerReady?: boolean;

  readonly disabled?: boolean;
  readonly loading?: boolean;

  readonly size?: ViewportToolbarSize;

  readonly showPlaneButton?: boolean;
  readonly showZoomButtons?: boolean;
  readonly showCrosshairButton?: boolean;

  readonly className?: string;

  /**
   * Parent owns tool switching.
   */
  readonly onToolChange: (
    tool: ViewportInteractionTool,
    plane: ViewportToolbarPlane,
  ) => void;

  /**
   * Parent owns all image-view operations.
   */
  readonly onCommand: (
    command: ViewportToolbarCommand,
    plane: ViewportToolbarPlane,
  ) => void;
}


// ============================================================
// 02 — CONSTANTS
// ============================================================

export const VIEWPORT_TOOLBAR_DEFAULT_SIZE:
  ViewportToolbarSize = "normal";

export const VIEWPORT_TOOLBAR_MIN_BUTTON_SIZE = 32;

export const VIEWPORT_TOOLBAR_COMPACT_BUTTON_SIZE = 28;

export const VIEWPORT_TOOLBAR_TOOLS:
  readonly ViewportInteractionTool[] = [
    "pan",
    "zoom",
    "crosshair",
  ];


// ============================================================
// 03 — LABEL HELPERS
// ============================================================

export function viewportToolbarPlaneLabel(
  plane: ViewportToolbarPlane,
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

function toolLabel(
  tool: ViewportInteractionTool,
): string {
  switch (tool) {
    case "pan":
      return "Pan";

    case "zoom":
      return "Zoom";

    case "crosshair":
      return "Crosshair";
  }
}

function toolDescription(
  tool: ViewportInteractionTool,
): string {
  switch (tool) {
    case "pan":
      return "Move the displayed image";

    case "zoom":
      return "Adjust image magnification";

    case "crosshair":
      return "Navigate using the crosshair";
  }
}

function commandDescription(
  command: ViewportToolbarCommand,
): string {
  switch (command) {
    case "activate":
      return "Make this the active viewport";

    case "zoom-in":
      return "Increase viewport magnification";

    case "zoom-out":
      return "Decrease viewport magnification";

    case "fit":
      return "Fit the image to the viewport";

    case "reset":
      return "Restore viewport display settings";

    case "toggle-crosshair":
      return "Show or hide the crosshair overlay";
  }
}


// ============================================================
// 04 — ICON COMPONENT
// ============================================================

interface ToolbarIconProps {
  readonly name:
    | "pan"
    | "zoom"
    | "crosshair"
    | "zoom-in"
    | "zoom-out"
    | "fit"
    | "reset"
    | "eye"
    | "eye-off"
    | "activate";

  readonly size?: number;
}

function ToolbarIcon({
  name,
  size = 17,
}: ToolbarIconProps) {
  let drawing: ReactNode;

  switch (name) {
    case "pan":
      drawing = (
        <>
          <path d="M12 2v20M2 12h20" />
          <path d="m8 6 4-4 4 4" />
          <path d="m8 18 4 4 4-4" />
          <path d="m6 8-4 4 4 4" />
          <path d="m18 8 4 4-4 4" />
        </>
      );
      break;

    case "zoom":
      drawing = (
        <>
          <circle cx="10" cy="10" r="7" />
          <path d="m15 15 6 6" />
          <path d="M10 6v8M6 10h8" />
        </>
      );
      break;

    case "crosshair":
      drawing = (
        <>
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v5M12 17v5M2 12h5M17 12h5" />
        </>
      );
      break;

    case "zoom-in":
      drawing = (
        <>
          <circle cx="10" cy="10" r="7" />
          <path d="m15 15 6 6M10 6v8M6 10h8" />
        </>
      );
      break;

    case "zoom-out":
      drawing = (
        <>
          <circle cx="10" cy="10" r="7" />
          <path d="m15 15 6 6M6 10h8" />
        </>
      );
      break;

    case "fit":
      drawing = (
        <>
          <path d="M8 3H3v5M16 3h5v5" />
          <path d="M3 16v5h5M21 16v5h-5" />
          <rect x="7" y="7" width="10" height="10" rx="1" />
        </>
      );
      break;

    case "reset":
      drawing = (
        <>
          <path d="M3 11a9 9 0 1 1 2.6 6.4" />
          <path d="M3 4v7h7" />
        </>
      );
      break;

    case "eye":
      drawing = (
        <>
          <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
          <circle cx="12" cy="12" r="3" />
        </>
      );
      break;

    case "eye-off":
      drawing = (
        <>
          <path d="m3 3 18 18" />
          <path d="M10.7 5.1A11 11 0 0 1 12 5c6.5 0 10 7 10 7a16 16 0 0 1-3 3.7" />
          <path d="M6.2 6.2C3.5 8.1 2 12 2 12s3.5 7 10 7a10 10 0 0 0 4-.8" />
          <path d="M10 10a3 3 0 0 0 4 4" />
        </>
      );
      break;

    case "activate":
      drawing = (
        <>
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <path d="M8 12h8M12 8v8" />
        </>
      );
      break;
  }

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      style={{
        display: "block",
        flexShrink: 0,
      }}
    >
      {drawing}
    </svg>
  );
}


// ============================================================
// 05 — STYLES
// ============================================================

const rootStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  flexWrap: "wrap",
  gap: 6,
  width: "100%",
  minWidth: 0,
  boxSizing: "border-box",
  padding: 7,
  borderBottom: "1px solid #263244",
  backgroundColor: "#101827",
  color: "#e2e8f0",
};

const toolGroupStyle: CSSProperties = {
  display: "inline-flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: 4,
};

const buttonStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 5,
  minWidth: VIEWPORT_TOOLBAR_MIN_BUTTON_SIZE,
  minHeight: VIEWPORT_TOOLBAR_MIN_BUTTON_SIZE,
  padding: "6px 9px",
  borderRadius: 5,
  border: "1px solid #344258",
  backgroundColor: "#192437",
  color: "#e2e8f0",
  fontSize: 11,
  fontWeight: 600,
  cursor: "pointer",
};

const selectedButtonStyle: CSSProperties = {
  ...buttonStyle,
  borderColor: "#38bdf8",
  backgroundColor: "#164e63",
  color: "#e0f2fe",
};

const disabledButtonStyle: CSSProperties = {
  opacity: 0.48,
  cursor: "not-allowed",
};

const planeLabelStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  color: "#f8fafc",
};

const dividerStyle: CSSProperties = {
  height: 22,
  width: 1,
  margin: "0 3px",
  backgroundColor: "#334155",
};


// ============================================================
// 06 — REUSABLE TOOLBAR BUTTON
// ============================================================

interface ToolbarButtonProps {
  readonly label: string;
  readonly title: string;
  readonly icon: ToolbarIconProps["name"];

  readonly selected?: boolean;
  readonly disabled?: boolean;
  readonly compact?: boolean;

  readonly onClick: () => void;
}

function ToolbarButton({
  label,
  title,
  icon,
  selected = false,
  disabled = false,
  compact = false,
  onClick,
}: ToolbarButtonProps) {
  const buttonSize = compact
    ? VIEWPORT_TOOLBAR_COMPACT_BUTTON_SIZE
    : VIEWPORT_TOOLBAR_MIN_BUTTON_SIZE;

  return (
    <button
      type="button"
      style={{
        ...(selected
          ? selectedButtonStyle
          : buttonStyle),
        minWidth: buttonSize,
        minHeight: buttonSize,
        padding: compact ? 4 : "6px 9px",
        ...(disabled
          ? disabledButtonStyle
          : {}),
      }}
      disabled={disabled}
      onClick={onClick}
      aria-label={title}
      aria-pressed={selected}
      title={title}
      data-toolbar-button={label.toLowerCase()}
    >
      <ToolbarIcon
        name={icon}
        size={compact ? 15 : 17}
      />

      {!compact && (
        <span>{label}</span>
      )}
    </button>
  );
}


// ============================================================
// 07 — MAIN VIEWPORT TOOLBAR
// ============================================================

export function ViewportToolbar({
  plane,
  activeTool,
  crosshairVisible,
  viewportActive = false,
  viewerReady = false,
  disabled = false,
  loading = false,
  size = VIEWPORT_TOOLBAR_DEFAULT_SIZE,
  showPlaneButton = true,
  showZoomButtons = true,
  showCrosshairButton = true,
  className = "",
  onToolChange,
  onCommand,
}: ViewportToolbarProps) {
  const compact = size === "compact";

  const canInteract =
    viewerReady && !disabled && !loading;

  const label = viewportToolbarPlaneLabel(
    plane,
  );

  // ==========================================================
  // 08 — TOOL SELECTION
  // ==========================================================

  const changeTool = useCallback(
    (tool: ViewportInteractionTool): void => {
      if (!canInteract) {
        return;
      }

      if (activeTool === tool) {
        return;
      }

      onToolChange(tool, plane);
    },
    [
      activeTool,
      canInteract,
      onToolChange,
      plane,
    ],
  );

  // ==========================================================
  // 09 — COMMAND DISPATCH
  // ==========================================================

  const executeCommand = useCallback(
    (command: ViewportToolbarCommand): void => {
      if (!canInteract) {
        return;
      }

      onCommand(command, plane);
    },
    [
      canInteract,
      onCommand,
      plane,
    ],
  );

  const activate = useCallback(
    () => executeCommand("activate"),
    [executeCommand],
  );

  const zoomIn = useCallback(
    () => executeCommand("zoom-in"),
    [executeCommand],
  );

  const zoomOut = useCallback(
    () => executeCommand("zoom-out"),
    [executeCommand],
  );

  const fit = useCallback(
    () => executeCommand("fit"),
    [executeCommand],
  );

  const reset = useCallback(
    () => executeCommand("reset"),
    [executeCommand],
  );

  const toggleCrosshair = useCallback(
    () => executeCommand("toggle-crosshair"),
    [executeCommand],
  );

  // ==========================================================
  // 10 — JSX OUTPUT
  // ==========================================================

  return (
    <div
      className={className}
      style={rootStyle}
      role="toolbar"
      aria-label={`${label} viewport tools`}
      aria-disabled={!canInteract}
      data-viewport-toolbar="true"
      data-viewport-plane={plane}
      data-viewport-ready={
        viewerReady ? "true" : "false"
      }
      data-active-tool={activeTool}
    >
      <div style={toolGroupStyle}>
        <span style={planeLabelStyle}>
          {label}
        </span>

        {showPlaneButton && (
          <ToolbarButton
            label="Active"
            title={commandDescription("activate")}
            icon="activate"
            selected={viewportActive}
            disabled={!canInteract}
            compact={compact}
            onClick={activate}
          />
        )}
      </div>

      <span
        aria-hidden="true"
        style={dividerStyle}
      />

      <div
        style={toolGroupStyle}
        role="group"
        aria-label="Viewport interaction mode"
      >
        {VIEWPORT_TOOLBAR_TOOLS.map((tool) => (
          <ToolbarButton
            key={tool}
            label={toolLabel(tool)}
            title={toolDescription(tool)}
            icon={tool}
            selected={activeTool === tool}
            disabled={!canInteract}
            compact={compact}
            onClick={() => changeTool(tool)}
          />
        ))}
      </div>

      {showZoomButtons && (
        <>
          <span
            aria-hidden="true"
            style={dividerStyle}
          />

          <div
            style={toolGroupStyle}
            role="group"
            aria-label="Zoom controls"
          >
            <ToolbarButton
              label="Zoom +"
              title={commandDescription("zoom-in")}
              icon="zoom-in"
              disabled={!canInteract}
              compact={compact}
              onClick={zoomIn}
            />

            <ToolbarButton
              label="Zoom −"
              title={commandDescription("zoom-out")}
              icon="zoom-out"
              disabled={!canInteract}
              compact={compact}
              onClick={zoomOut}
            />
          </div>
        </>
      )}

      <span
        aria-hidden="true"
        style={dividerStyle}
      />

      <div
        style={toolGroupStyle}
        role="group"
        aria-label="Viewport display controls"
      >
        <ToolbarButton
          label="Fit"
          title={commandDescription("fit")}
          icon="fit"
          disabled={!canInteract}
          compact={compact}
          onClick={fit}
        />

        <ToolbarButton
          label="Reset"
          title={commandDescription("reset")}
          icon="reset"
          disabled={!canInteract}
          compact={compact}
          onClick={reset}
        />

        {showCrosshairButton && (
          <ToolbarButton
            label="Crosshair"
            title={commandDescription("toggle-crosshair")}
            icon={
              crosshairVisible
                ? "eye"
                : "eye-off"
            }
            selected={crosshairVisible}
            disabled={!canInteract}
            compact={compact}
            onClick={toggleCrosshair}
          />
        )}
      </div>

      {loading && (
        <span
          role="status"
          aria-live="polite"
          style={{
            marginLeft: "auto",
            color: "#94a3b8",
            fontSize: 11,
          }}
        >
          Loading…
        </span>
      )}
    </div>
  );
}


// ============================================================
// 11 — CAPABILITIES
// ============================================================

export function getViewportToolbarCapabilities() {
  return {
    axialSupport: true,
    coronalSupport: true,
    sagittalSupport: true,
    planeActivation: true,
    panTool: true,
    zoomTool: true,
    crosshairTool: true,
    zoomIn: true,
    zoomOut: true,
    fitView: true,
    resetView: true,
    crosshairVisibilityToggle: true,
    controlledToolSelection: true,
    controlledCrosshairVisibility: true,
    parentOwnedActions: true,
    compactLayout: true,
    disabledState: true,
    loadingState: true,
    accessibleToolbar: true,
    directGeometryModification: false,
    directNetworkRequests: false,
    browserPersistence: false,
    sourceDatasetModification: false,
    clinicalValidationComplete: false,
  } as const;
}


// ============================================================
// END OF SINUS VIEWER VIEWPORT TOOLBAR
// ============================================================
