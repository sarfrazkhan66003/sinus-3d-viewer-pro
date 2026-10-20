
/**
 * SINUS VIEWER — VIEWPORT KEYBOARD CONTROLS
 * =========================================
 *
 * Scope: a single focused MPR viewport.
 *
 * Keyboard shortcuts:
 *   ArrowUp       Next slice
 *   ArrowDown     Previous slice
 *   PageUp        Jump forward 10 slices
 *   PageDown      Jump backward 10 slices
 *   + or =        Zoom in
 *   -             Zoom out
 *   0             Fit to view
 *   R             Reset view
 *
 * Safety and accessibility:
 * - No global document/window keydown listeners.
 * - Parent owns slice, zoom and display state.
 * - Ignore editable fields and interactive controls.
 * - Ignore Ctrl / Meta / Alt modified shortcuts.
 * - Ignore IME composition and defaultPrevented.
 * - Ignore disabled or unavailable viewports.
 * - Do not intercept event unless action is available.
 * - No direct DICOM, clipboard or network operations.
 *
 * This wrapper must not be nested inside another
 * active viewport shortcut wrapper.
 */

import {
  useCallback,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from "react";

// ============================================================
// 01 — PUBLIC TYPES
// ============================================================

export type ViewportKeyboardPlane =
  | "axial"
  | "coronal"
  | "sagittal";

export type ViewportKeyboardCommand =
  | "next-slice"
  | "previous-slice"
  | "jump-forward"
  | "jump-backward"
  | "zoom-in"
  | "zoom-out"
  | "fit"
  | "reset";

export interface ViewportKeyboardAction {
  readonly plane: ViewportKeyboardPlane;
  readonly command: ViewportKeyboardCommand;
  readonly step: number;
}

export interface ViewportKeyboardControlsProps {
  readonly plane: ViewportKeyboardPlane;
  readonly children: ReactNode;

  /**
   * Only the selected viewport should respond.
   */
  readonly active: boolean;

  readonly enabled?: boolean;
  readonly loading?: boolean;

  /**
   * Parent supplies actual navigational limits.
   * Unavailable commands are never dispatched.
   */
  readonly canPreviousSlice?: boolean;
  readonly canNextSlice?: boolean;
  readonly canZoomIn?: boolean;
  readonly canZoomOut?: boolean;

  readonly onAction: (
    action: ViewportKeyboardAction,
  ) => void;

  /**
   * Optional callback on viewport focus.
   */
  readonly onActivate?: (
    plane: ViewportKeyboardPlane,
  ) => void;

  readonly className?: string;
  readonly ariaLabel?: string;
  readonly style?: CSSProperties;
}

// ============================================================
// 02 — CONSTANTS
// ============================================================

export const VIEWPORT_KEYBOARD_SINGLE_STEP = 1;
export const VIEWPORT_KEYBOARD_JUMP_STEP = 10;

const VIEWPORT_EDITABLE_SELECTOR = [
  "input",
  "textarea",
  "select",
  "button",
  "a[href]",
  "[contenteditable]",
  '[role="textbox"]',
  '[role="combobox"]',
  '[role="slider"]',
  '[role="spinbutton"]',
  '[role="menu"]',
  '[role="menuitem"]',
  '[role="dialog"]',
].join(",");

// ============================================================
// 03 — PURE KEY RESOLUTION
// ============================================================

export interface ViewportKeyDescriptor {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
  readonly repeat: boolean;
  readonly isComposing: boolean;
  readonly defaultPrevented: boolean;
}

export function resolveViewportKeyboardCommand(
  event: ViewportKeyDescriptor,
): ViewportKeyboardCommand | null {
  if (
    event.ctrlKey ||
    event.altKey ||
    event.metaKey ||
    event.isComposing ||
    event.defaultPrevented
  ) {
    return null;
  }

  switch (event.key) {
    case "ArrowUp":
      return "next-slice";

    case "ArrowDown":
      return "previous-slice";

    case "PageUp":
      return "jump-forward";

    case "PageDown":
      return "jump-backward";

    case "+":
      return "zoom-in";

    case "=":
      return event.shiftKey ? null : "zoom-in";

    case "-":
      return "zoom-out";

    case "0":
      return event.shiftKey ? null : "fit";

    case "r":
    case "R":
      return event.shiftKey ? null : "reset";

    default:
      return null;
  }
}

export function getViewportKeyboardStep(
  command: ViewportKeyboardCommand,
): number {
  switch (command) {
    case "next-slice":
    case "previous-slice":
      return VIEWPORT_KEYBOARD_SINGLE_STEP;

    case "jump-forward":
    case "jump-backward":
      return VIEWPORT_KEYBOARD_JUMP_STEP;

    case "zoom-in":
    case "zoom-out":
    case "fit":
    case "reset":
      return 0;
  }
}

// ============================================================
// 04 — DOM TARGET PROTECTION
// ============================================================

export function isViewportEditableTarget(
  target: EventTarget | null,
): boolean {
  if (
    typeof Element === "undefined" ||
    !(target instanceof Element)
  ) {
    return false;
  }

  return target.closest(
    VIEWPORT_EDITABLE_SELECTOR,
  ) !== null;
}

// ============================================================
// 05 — COMMAND PERMISSION CHECKS
// ============================================================

export interface ViewportKeyboardAvailability {
  readonly canPreviousSlice: boolean;
  readonly canNextSlice: boolean;
  readonly canZoomIn: boolean;
  readonly canZoomOut: boolean;
}

export function isViewportKeyboardCommandAvailable(
  command: ViewportKeyboardCommand,
  availability: ViewportKeyboardAvailability,
): boolean {
  switch (command) {
    case "next-slice":
    case "jump-forward":
      return availability.canNextSlice;

    case "previous-slice":
    case "jump-backward":
      return availability.canPreviousSlice;

    case "zoom-in":
      return availability.canZoomIn;

    case "zoom-out":
      return availability.canZoomOut;

    case "fit":
    case "reset":
      return true;
  }
}

// ============================================================
// 06 — LABEL HELPERS
// ============================================================

export function viewportKeyboardPlaneLabel(
  plane: ViewportKeyboardPlane,
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

export const VIEWPORT_KEYBOARD_SHORTCUTS = [
  { keys: "ArrowUp", action: "Next slice" },
  { keys: "ArrowDown", action: "Previous slice" },
  { keys: "PageUp", action: "Forward 10 slices" },
  { keys: "PageDown", action: "Back 10 slices" },
  { keys: "+ / =", action: "Zoom in" },
  { keys: "-", action: "Zoom out" },
  { keys: "0", action: "Fit to view" },
  { keys: "R", action: "Reset view" },
] as const;

// ============================================================
// 07 — WRAPPER STYLES
// ============================================================

const defaultWrapperStyle: CSSProperties = {
  position: "relative",
  width: "100%",
  height: "100%",
  minWidth: 0,
  minHeight: 0,
  outlineOffset: -2,
};

// ============================================================
// 08 — MAIN COMPONENT
// ============================================================

export function ViewportKeyboardControls({
  plane,
  children,
  active,
  enabled = true,
  loading = false,
  canPreviousSlice = true,
  canNextSlice = true,
  canZoomIn = true,
  canZoomOut = true,
  onAction,
  onActivate,
  className = "",
  ariaLabel,
  style,
}: ViewportKeyboardControlsProps) {
  const ready = active && enabled && !loading;

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>): void => {
      if (!ready) {
        return;
      }

      if (isViewportEditableTarget(event.target)) {
        return;
      }

      const command =
        resolveViewportKeyboardCommand({
          key: event.key,
          shiftKey: event.shiftKey,
          ctrlKey: event.ctrlKey,
          altKey: event.altKey,
          metaKey: event.metaKey,
          repeat: event.repeat,
          isComposing: event.nativeEvent.isComposing,
          defaultPrevented: event.defaultPrevented,
        });

      if (command === null) {
        return;
      }

      const availability: ViewportKeyboardAvailability = {
        canPreviousSlice,
        canNextSlice,
        canZoomIn,
        canZoomOut,
      };

      if (
        !isViewportKeyboardCommandAvailable(
          command,
          availability,
        )
      ) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      onAction({
        plane,
        command,
        step: getViewportKeyboardStep(command),
      });
    },
    [
      ready,
      canPreviousSlice,
      canNextSlice,
      canZoomIn,
      canZoomOut,
      onAction,
      plane,
    ],
  );

  const handleFocus = useCallback((): void => {
    if (enabled && !loading && !active) {
      onActivate?.(plane);
    }
  }, [enabled, loading, active, onActivate, plane]);

  return (
    <div
      className={className}
      style={{
        ...defaultWrapperStyle,
        ...style,
      }}
      tabIndex={enabled && !loading ? 0 : -1}
      role="region"
      aria-label={
        ariaLabel ??
        `${viewportKeyboardPlaneLabel(plane)} viewport`
      }
      aria-keyshortcuts={
        "ArrowUp ArrowDown PageUp PageDown " +
        "Plus Minus 0 R"
      }
      data-viewport-keyboard-controls="true"
      data-viewport-keyboard-plane={plane}
      data-viewport-keyboard-active={
        active ? "true" : "false"
      }
      onFocus={handleFocus}
      onKeyDown={handleKeyDown}
    >
      {children}
    </div>
  );
}

// ============================================================
// 09 — COMPONENT CAPABILITIES
// ============================================================

export function getViewportKeyboardControlsCapabilities() {
  return {
    axialSupport: true,
    coronalSupport: true,
    sagittalSupport: true,
    focusedViewportScope: true,
    globalKeyboardListeners: false,
    previousNextSlice: true,
    tenSliceJump: true,
    zoomInOut: true,
    fitToView: true,
    resetView: true,
    editableFieldProtection: true,
    interactiveControlProtection: true,
    modifierConflictProtection: true,
    imeCompositionProtection: true,
    commandAvailabilityGuards: true,
    parentOwnedActions: true,
    focusActivationCallback: true,
    originalDICOMModification: false,
    networkRequests: false,
    browserPersistence: false,
    clinicalValidationComplete: false,
  } as const;
}

// ============================================================
// END OF SINUS VIEWER VIEWPORT KEYBOARD CONTROLS
// ============================================================
