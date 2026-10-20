
/**
 * SINUS VIEWER — KEYBOARD SHORTCUTS
 * =================================
 *
 * Reusable keyboard controller for MPR navigation.
 *
 * Features:
 * - 1 / 2 / 3: Select axial / coronal / sagittal.
 * - Arrow Up / Down: Previous / next slice.
 * - Page Up / Down: Move 10 slices.
 * - F: Fit active viewport.
 * - C: Center active viewport on crosshair.
 * - ?: Open keyboard shortcut help.
 * - Escape: Close shortcut help.
 * - Input and modal safety guards.
 * - Accessible help dialog with focus restoration.
 * - Parent-owned navigation actions.
 *
 * Privacy:
 * - No patient identifiers or DICOM UID handling.
 * - No direct backend requests.
 * - No browser persistence.
 * - No source medical image modifications.
 *
 * Shortcuts do not modify original DICOM files.
 */

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

import type {
  PreviewPlane,
} from "../../types/api";

import type {
  MPRControllerActions,
} from "../../hooks/useMPR";


// ============================================================
// 01 — PUBLIC TYPES
// ============================================================

export type ViewerShortcutCommand =
  | "select-axial"
  | "select-coronal"
  | "select-sagittal"
  | "previous-slice"
  | "next-slice"
  | "previous-ten-slices"
  | "next-ten-slices"
  | "fit-active"
  | "center-crosshair"
  | "toggle-help";

export interface KeyboardShortcutsProps {
  readonly actions: MPRControllerActions;
  readonly activePlane: PreviewPlane;

  readonly enabled?: boolean;
  readonly loading?: boolean;

  readonly showHelpButton?: boolean;
  readonly className?: string;

  readonly onShortcut?: (
    command: ViewerShortcutCommand,
  ) => void;
}

export interface ViewerShortcutDefinition {
  readonly keys: string;
  readonly description: string;
  readonly command: ViewerShortcutCommand;
}


// ============================================================
// 02 — CONSTANTS
// ============================================================

export const VIEWER_SHORTCUTS:
  readonly ViewerShortcutDefinition[] = [
  {
    keys: "1",
    description: "Select axial view",
    command: "select-axial",
  },
  {
    keys: "2",
    description: "Select coronal view",
    command: "select-coronal",
  },
  {
    keys: "3",
    description: "Select sagittal view",
    command: "select-sagittal",
  },
  {
    keys: "↑",
    description: "Previous slice",
    command: "previous-slice",
  },
  {
    keys: "↓",
    description: "Next slice",
    command: "next-slice",
  },
  {
    keys: "Page Up",
    description: "Previous 10 slices",
    command: "previous-ten-slices",
  },
  {
    keys: "Page Down",
    description: "Next 10 slices",
    command: "next-ten-slices",
  },
  {
    keys: "F",
    description: "Fit active image to viewport",
    command: "fit-active",
  },
  {
    keys: "C",
    description: "Center active image on crosshair",
    command: "center-crosshair",
  },
  {
    keys: "?",
    description: "Show keyboard shortcuts",
    command: "toggle-help",
  },
];


// ============================================================
// 03 — INPUT SAFETY
// ============================================================

/**
 * Do not hijack keys used by text fields, buttons,
 * editable content, or another dialog.
 */
export function shouldIgnoreViewerShortcut(
  event: KeyboardEvent,
): boolean {
  if (
    event.defaultPrevented ||
    event.isComposing ||
    event.ctrlKey ||
    event.altKey ||
    event.metaKey
  ) {
    return true;
  }

  const target = event.target;

  if (!(target instanceof Element)) {
    return false;
  }

  const interactive = target.closest(
    [
      "input",
      "textarea",
      "select",
      "button",
      "a[href]",
      "[contenteditable]",
      "[role='textbox']",
      "[role='combobox']",
      "[role='slider']",
      "[role='spinbutton']",
      "[role='menu']",
      "[role='listbox']",
    ].join(","),
  );

  if (interactive !== null) {
    return true;
  }

  if (
    target instanceof HTMLElement &&
    target.isContentEditable
  ) {
    return true;
  }

  if (
    target.closest(
      "[role='dialog'], [role='alertdialog']",
    )
  ) {
    return true;
  }

  // Native modal dialogs and unrelated overlays.
  if (
    typeof document !== "undefined" &&
    document.querySelector(
      "dialog[open], [role='dialog'][aria-modal='true'], " +
      "[role='alertdialog'][aria-modal='true']",
    )
  ) {
    return true;
  }

  return false;
}


// ============================================================
// 04 — KEY MAPPING
// ============================================================

export function resolveViewerShortcut(
  event: Pick<KeyboardEvent, "key" | "shiftKey">,
): ViewerShortcutCommand | null {
  if (event.shiftKey) {
    return event.key === "?"
      ? "toggle-help"
      : null;
  }

  switch (event.key) {
    case "1":
      return "select-axial";

    case "2":
      return "select-coronal";

    case "3":
      return "select-sagittal";

    case "ArrowUp":
      return "previous-slice";

    case "ArrowDown":
      return "next-slice";

    case "PageUp":
      return "previous-ten-slices";

    case "PageDown":
      return "next-ten-slices";

    case "f":
    case "F":
      return "fit-active";

    case "c":
    case "C":
      return "center-crosshair";

    case "?":
      return "toggle-help";

    default:
      return null;
  }
}


// ============================================================
// 05 — STYLES
// ============================================================

const helpButtonStyle: CSSProperties = {
  padding: "7px 11px",
  minHeight: 32,
  border: "1px solid #344258",
  borderRadius: 5,
  backgroundColor: "#192437",
  color: "#f8fafc",
  cursor: "pointer",
  fontSize: 12,
  fontWeight: 600,
};

const backdropStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 13000,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 16,
  backgroundColor: "rgba(2, 6, 23, 0.85)",
};

const dialogStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  width: "min(460px, 100%)",
  maxHeight: "85vh",
  overflowY: "auto",
  gap: 14,
  padding: 20,
  boxSizing: "border-box",
  border: "1px solid #344258",
  borderRadius: 9,
  backgroundColor: "#101827",
  color: "#e2e8f0",
  boxShadow: "0 18px 45px rgba(0,0,0,0.5)",
};

const rowStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: 16,
  padding: "7px 0",
  borderBottom: "1px solid #263244",
};

const keyStyle: CSSProperties = {
  minWidth: 36,
  padding: "4px 8px",
  border: "1px solid #475569",
  borderRadius: 5,
  backgroundColor: "#192437",
  color: "#f8fafc",
  fontSize: 12,
  textAlign: "center",
  whiteSpace: "nowrap",
};


// ============================================================
// 06 — MAIN COMPONENT
// ============================================================

export function KeyboardShortcuts({
  actions,
  activePlane,
  enabled = true,
  loading = false,
  showHelpButton = true,
  className = "",
  onShortcut,
}: KeyboardShortcutsProps) {
  const titleId = useId();
  const descriptionId = useId();

  const [helpOpen, setHelpOpen] =
    useState(false);

  const helpRef = useRef<HTMLDivElement | null>(
    null,
  );

  const closeButtonRef =
    useRef<HTMLButtonElement | null>(null);

  const previousFocusRef =
    useRef<HTMLElement | null>(null);

  const canNavigate = enabled && !loading;

  // ==========================================================
  // 07 — COMMAND DISPATCH
  // ==========================================================

  const executeCommand = useCallback(
    (command: ViewerShortcutCommand): void => {
      if (!canNavigate) {
        return;
      }

      switch (command) {
        case "select-axial":
          actions.setActivePlane("axial");
          break;

        case "select-coronal":
          actions.setActivePlane("coronal");
          break;

        case "select-sagittal":
          actions.setActivePlane("sagittal");
          break;

        case "previous-slice":
          actions.scrollSlice(activePlane, -1);
          break;

        case "next-slice":
          actions.scrollSlice(activePlane, 1);
          break;

        case "previous-ten-slices":
          actions.scrollSlice(activePlane, -10);
          break;

        case "next-ten-slices":
          actions.scrollSlice(activePlane, 10);
          break;

        case "fit-active":
          actions.fit(activePlane);
          break;

        case "center-crosshair":
          actions.centerOnCrosshair(activePlane);
          break;

        case "toggle-help":
          setHelpOpen(true);
          break;
      }

      onShortcut?.(command);
    },
    [actions, activePlane, canNavigate, onShortcut],
  );

  // ==========================================================
  // 08 — DOCUMENT KEYBOARD LISTENER
  // ==========================================================

  useEffect(() => {
    if (!canNavigate) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.repeat || helpOpen) {
        return;
      }

      if (shouldIgnoreViewerShortcut(event)) {
        return;
      }

      const command = resolveViewerShortcut(
        event,
      );

      if (command === null) {
        return;
      }

      event.preventDefault();
      executeCommand(command);
    };

    document.addEventListener(
      "keydown",
      handleKeyDown,
    );

    return () => {
      document.removeEventListener(
        "keydown",
        handleKeyDown,
      );
    };
  }, [canNavigate, helpOpen, executeCommand]);

  // ==========================================================
  // 09 — HELP OPEN / CLOSE
  // ==========================================================

  const openHelp = useCallback((): void => {
    if (canNavigate) {
      setHelpOpen(true);
    }
  }, [canNavigate]);

  const closeHelp = useCallback((): void => {
    setHelpOpen(false);
  }, []);

  useEffect(() => {
    if (!canNavigate) {
      setHelpOpen(false);
    }
  }, [canNavigate]);

  // ==========================================================
  // 10 — HELP FOCUS MANAGEMENT
  // ==========================================================

  useEffect(() => {
    if (!helpOpen) {
      return;
    }

    const previous = document.activeElement;

    previousFocusRef.current =
      previous instanceof HTMLElement
        ? previous
        : null;

    closeButtonRef.current?.focus();

    const keepFocusInside = (event: FocusEvent): void => {
      const dialog = helpRef.current;

      if (
        dialog &&
        !dialog.contains(event.target as Node)
      ) {
        closeButtonRef.current?.focus();
      }
    };

    document.addEventListener(
      "focusin",
      keepFocusInside,
    );

    return () => {
      document.removeEventListener(
        "focusin",
        keepFocusInside,
      );

      const previousFocus = previousFocusRef.current;

      if (previousFocus?.isConnected) {
        previousFocus.focus();
      }

      previousFocusRef.current = null;
    };
  }, [helpOpen]);

  // ==========================================================
  // 11 — HELP KEYBOARD HANDLING
  // ==========================================================

  const handleHelpKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeHelp();
        return;
      }

      if (event.key !== "Tab") {
        return;
      }

      // The Close button is the dialog's only
      // interactive control; keep keyboard focus there.
      event.preventDefault();
      closeButtonRef.current?.focus();
    },
    [closeHelp],
  );

  // ==========================================================
  // 12 — JSX
  // ==========================================================

  return (
    <>
      {showHelpButton && (
        <button
          type="button"
          className={className}
          style={helpButtonStyle}
          disabled={!canNavigate}
          onClick={openHelp}
          aria-haspopup="dialog"
          aria-expanded={helpOpen}
        >
          Keyboard Shortcuts (?)
        </button>
      )}

      {helpOpen && (
        <div style={backdropStyle}>
          <div
            ref={helpRef}
            style={dialogStyle}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={descriptionId}
            tabIndex={-1}
            onKeyDown={handleHelpKeyDown}
            data-keyboard-shortcuts-help="true"
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
              }}
            >
              <h2
                id={titleId}
                style={{
                  margin: 0,
                  fontSize: 17,
                }}
              >
                Keyboard Shortcuts
              </h2>

              <button
                ref={closeButtonRef}
                type="button"
                style={helpButtonStyle}
                onClick={closeHelp}
                aria-label="Close keyboard shortcuts"
              >
                Close
              </button>
            </div>

            <p
              id={descriptionId}
              style={{
                margin: 0,
                color: "#94a3b8",
                fontSize: 12,
                lineHeight: 1.5,
              }}
            >
              Shortcuts control the currently active
              MPR viewport. Text inputs and other
              dialogs are excluded.
            </p>

            <div
              role="list"
              aria-label="Available viewer shortcuts"
            >
              {VIEWER_SHORTCUTS.map((shortcut) => (
                <div
                  key={shortcut.command}
                  role="listitem"
                  style={rowStyle}
                >
                  <span style={{ fontSize: 12 }}>
                    {shortcut.description}
                  </span>

                  <kbd style={keyStyle}>
                    {shortcut.keys}
                  </kbd>
                </div>
              ))}
            </div>

            <p
              style={{
                margin: 0,
                color: "#94a3b8",
                fontSize: 11,
                lineHeight: 1.5,
              }}
            >
              Shortcuts change viewer navigation
              only. Original CT/CBCT DICOM files
              remain unchanged.
            </p>
          </div>
        </div>
      )}
    </>
  );
}


// ============================================================
// 13 — CAPABILITIES
// ============================================================

export function getKeyboardShortcutsCapabilities() {
  return {
    axialSelection: true,
    coronalSelection: true,
    sagittalSelection: true,
    singleSliceNavigation: true,
    tenSliceNavigation: true,
    fitActiveViewport: true,
    centerCrosshair: true,
    keyboardHelpPanel: true,
    escapeHelpDismissal: true,
    textInputProtection: true,
    modalProtection: true,
    modifierKeyProtection: true,
    repeatKeyProtection: true,
    helpFocusRestoration: true,
    parentOwnedNavigation: true,
    directBackendRequests: false,
    browserPersistence: false,
    sourceDatasetModification: false,
  } as const;
}


// ============================================================
// END OF SINUS VIEWER KEYBOARD SHORTCUTS
// ============================================================
