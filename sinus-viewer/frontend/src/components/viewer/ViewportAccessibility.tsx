
/**
 * SINUS VIEWER — VIEWPORT ACCESSIBILITY
 * ======================================
 *
 * Accessibility support for one MPR viewport.
 *
 * Features:
 * - Axial / coronal / sagittal semantics.
 * - Safe, allowlisted lifecycle announcements.
 * - Keyboard shortcut instructions.
 * - Accessible viewport region.
 * - Optional keyboard help panel.
 * - Focusable help button.
 * - Close on Escape.
 * - React children stay mounted.
 * - No patient-identifying metadata.
 *
 * This component does not:
 * - Process keyboard slice-navigation commands.
 * - Read DICOM metadata or image pixels.
 * - Announce coordinates or measurement values.
 * - Render raw backend errors.
 * - Fetch data or persist browser state.
 *
 * Parent must not pass identifying information
 * in ariaLabel or any other text property.
 */

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from "react";

// ============================================================
// 01 — PUBLIC TYPES
// ============================================================

export type AccessibleViewportPlane =
  | "axial"
  | "coronal"
  | "sagittal";

export type AccessibleViewportStatus =
  | "idle"
  | "loading"
  | "decoding"
  | "preparing"
  | "rendering"
  | "ready"
  | "unavailable"
  | "error";

export interface ViewportAccessibilityProps {
  readonly plane: AccessibleViewportPlane;
  readonly status: AccessibleViewportStatus;
  readonly children: ReactNode;

  readonly enabled?: boolean;
  readonly showHelpButton?: boolean;
  readonly compact?: boolean;

  /**
   * Default labels are safest.
   *
   * If overridden, this text must be a static,
   * non-identifying UI label.
   */
  readonly ariaLabel?: string;

  readonly className?: string;
}

export interface ViewportAccessibilityMessage {
  readonly label: string;
  readonly announcement: string;
  readonly busy: boolean;
}

export interface AccessibleViewportShortcut {
  readonly keys: string;
  readonly description: string;
}

// ============================================================
// 02 — FIXED, SAFE STATUS MESSAGES
// ============================================================

const STATUS_MESSAGES: Readonly<
  Record<
    AccessibleViewportStatus,
    {
      readonly announcement: string;
      readonly busy: boolean;
    }
  >
> = {
  idle: {
    announcement: "Waiting for an image.",
    busy: false,
  },
  loading: {
    announcement: "Image volume loading.",
    busy: true,
  },
  decoding: {
    announcement: "Image frames decoding.",
    busy: true,
  },
  preparing: {
    announcement: "Multiplanar view preparing.",
    busy: true,
  },
  rendering: {
    announcement: "Image view rendering.",
    busy: true,
  },
  ready: {
    announcement: "Image viewport ready.",
    busy: false,
  },
  unavailable: {
    announcement: "Image viewport unavailable.",
    busy: false,
  },
  error: {
    announcement: "Image viewport could not be displayed.",
    busy: false,
  },
};

// ============================================================
// 03 — SHORTCUT HELP CATALOG
// ============================================================

/**
 * Must be kept consistent with File 96.
 *
 * These are descriptions only. This component
 * does not attach global keyboard listeners.
 */
export const ACCESSIBLE_VIEWPORT_SHORTCUTS:
  readonly AccessibleViewportShortcut[] = [
    {
      keys: "Arrow Up",
      description: "Next image slice",
    },
    {
      keys: "Arrow Down",
      description: "Previous image slice",
    },
    {
      keys: "Page Up",
      description: "Move forward by ten slices",
    },
    {
      keys: "Page Down",
      description: "Move backward by ten slices",
    },
    {
      keys: "Plus or Equals",
      description: "Zoom in",
    },
    {
      keys: "Minus",
      description: "Zoom out",
    },
    {
      keys: "Zero",
      description: "Fit image to viewport",
    },
    {
      keys: "R",
      description: "Reset view",
    },
  ];

// ============================================================
// 04 — PURE HELPERS
// ============================================================

export function accessibleViewportPlaneLabel(
  plane: AccessibleViewportPlane,
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

export function isAccessibleViewportStatus(
  value: unknown,
): value is AccessibleViewportStatus {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(
      STATUS_MESSAGES,
      value,
    )
  );
}

export function buildViewportAccessibilityMessage(
  plane: AccessibleViewportPlane,
  status: AccessibleViewportStatus,
): ViewportAccessibilityMessage {
  const planeLabel =
    accessibleViewportPlaneLabel(plane);

  const safeStatus =
    isAccessibleViewportStatus(status)
      ? status
      : "unavailable";

  const definition = STATUS_MESSAGES[safeStatus];

  return {
    label: `${planeLabel} image viewport`,
    announcement:
      `${planeLabel}: ${definition.announcement}`,
    busy: definition.busy,
  };
}

// ============================================================
// 05 — VISUALLY HIDDEN STYLE
// ============================================================

const visuallyHiddenStyle: CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0, 0, 0, 0)",
  whiteSpace: "nowrap",
  border: 0,
};

// ============================================================
// 06 — LAYOUT STYLES
// ============================================================

const rootStyle: CSSProperties = {
  position: "relative",
  width: "100%",
  height: "100%",
  minWidth: 0,
  minHeight: 0,
  outlineOffset: -3,
};

const helpButtonStyle: CSSProperties = {
  position: "absolute",
  right: 8,
  bottom: 8,
  zIndex: 65,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  minHeight: 30,
  padding: "5px 9px",
  border: "1px solid #475569",
  borderRadius: 5,
  backgroundColor: "rgba(15,23,42,0.95)",
  color: "#e2e8f0",
  fontSize: 11,
  fontWeight: 600,
  cursor: "pointer",
};

const helpPanelStyle: CSSProperties = {
  position: "absolute",
  right: 8,
  bottom: 45,
  zIndex: 66,
  width: "min(300px, calc(100% - 16px))",
  maxHeight: "min(360px, calc(100% - 55px))",
  overflowY: "auto",
  boxSizing: "border-box",
  padding: 12,
  border: "1px solid #475569",
  borderRadius: 7,
  backgroundColor: "#101827",
  color: "#e2e8f0",
  boxShadow: "0 12px 28px rgba(0,0,0,0.4)",
  fontSize: 12,
};

const helpRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  justifyContent: "space-between",
  gap: 12,
  padding: "4px 0",
};

const keyLabelStyle: CSSProperties = {
  flexShrink: 0,
  color: "#bae6fd",
  fontFamily: "monospace",
  fontSize: 11,
};

const descriptionStyle: CSSProperties = {
  textAlign: "right",
  color: "#cbd5e1",
  fontSize: 11,
  lineHeight: 1.4,
};

// ============================================================
// 07 — MAIN COMPONENT
// ============================================================

export function ViewportAccessibility({
  plane,
  status,
  children,
  enabled = true,
  showHelpButton = true,
  compact = false,
  ariaLabel,
  className = "",
}: ViewportAccessibilityProps) {
  const helpId = useId();
  const descriptionId = useId();

  const helpButtonRef = useRef<HTMLButtonElement>(null);

  const [helpOpen, setHelpOpen] = useState(false);

  const message = buildViewportAccessibilityMessage(
    plane,
    status,
  );

  const closeHelp = useCallback((): void => {
    setHelpOpen(false);
    helpButtonRef.current?.focus();
  }, []);

  // Hide help when viewport is disabled or
  // help UI is removed by the parent.
  useEffect(() => {
    if (!enabled || !showHelpButton) {
      setHelpOpen(false);
    }
  }, [enabled, showHelpButton]);

  const handleHelpKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>): void => {
      if (
        helpOpen &&
        event.key === "Escape"
      ) {
        event.preventDefault();
        event.stopPropagation();
        closeHelp();
      }
    },
    [helpOpen, closeHelp],
  );

  const handleHelpToggle = useCallback((): void => {
    if (!enabled) {
      return;
    }

    if (helpOpen) {
      closeHelp();
    } else {
      setHelpOpen(true);
    }
  }, [enabled, helpOpen, closeHelp]);

  return (
    <section
      className={className}
      style={rootStyle}
      role="region"
      aria-label={ariaLabel ?? message.label}
      aria-describedby={descriptionId}
      aria-busy={message.busy}
      data-viewport-accessibility="true"
      data-a11y-plane={plane}
      data-a11y-status={
        isAccessibleViewportStatus(status)
          ? status
          : "unavailable"
      }
      onKeyDown={handleHelpKeyDown}
    >
      <span
        id={descriptionId}
        style={visuallyHiddenStyle}
      >
        Focus the image viewport to use its keyboard
        shortcuts. Keyboard help is available from
        the help button when enabled.
      </span>

      <div
        style={visuallyHiddenStyle}
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-a11y-announcement="true"
      >
        {message.announcement}
      </div>

      {children}

      {enabled && showHelpButton && (
        <>
          <button
            ref={helpButtonRef}
            type="button"
            style={{
              ...helpButtonStyle,
              minHeight: compact ? 27 : 30,
              padding: compact
                ? "4px 7px"
                : "5px 9px",
            }}
            onClick={handleHelpToggle}
            aria-expanded={helpOpen}
            aria-controls={helpId}
            aria-label={
              helpOpen
                ? "Close viewport keyboard help"
                : "Open viewport keyboard help"
            }
            data-a11y-help-button="true"
          >
            <span aria-hidden="true">?</span>

            {!compact && (
              <span style={{ marginLeft: 5 }}>
                Keyboard help
              </span>
            )}
          </button>

          {helpOpen && (
            <div
              id={helpId}
              style={helpPanelStyle}
              role="group"
              aria-label={
                `${accessibleViewportPlaneLabel(plane)} keyboard shortcuts`
              }
              data-a11y-help-panel="true"
            >
              <strong
                style={{
                  display: "block",
                  fontSize: 12,
                  marginBottom: 8,
                }}
              >
                Viewport keyboard shortcuts
              </strong>

              {ACCESSIBLE_VIEWPORT_SHORTCUTS.map(
                (shortcut) => (
                  <div
                    key={shortcut.keys}
                    style={helpRowStyle}
                  >
                    <span style={keyLabelStyle}>
                      {shortcut.keys}
                    </span>

                    <span style={descriptionStyle}>
                      {shortcut.description}
                    </span>
                  </div>
                ),
              )}

              <p
                style={{
                  margin: "9px 0 0",
                  color: "#94a3b8",
                  fontSize: 10,
                  lineHeight: 1.5,
                }}
              >
                Shortcuts work only when the active
                viewport has keyboard focus and a
                text field or menu is not being edited.
              </p>
            </div>
          )}
        </>
      )}
    </section>
  );
}

// ============================================================
// 08 — CAPABILITIES
// ============================================================

export function getViewportAccessibilityCapabilities() {
  return {
    axialSupport: true,
    coronalSupport: true,
    sagittalSupport: true,
    accessibleRegion: true,
    planeDescription: true,
    fixedStatusAnnouncements: true,
    loadingBusyState: true,
    keyboardShortcutHelp: true,
    expandableHelpPanel: true,
    escapeToCloseHelp: true,
    focusRestorationOnHelpClose: true,
    compactLayout: true,
    childrenRemainMounted: true,
    rawBackendErrorAnnouncements: false,
    patientIdentifierAnnouncements: false,
    patientCoordinateAnnouncements: false,
    directKeyboardNavigation: false,
    globalKeyboardListeners: false,
    directDICOMAccess: false,
    directNetworkRequests: false,
    browserPersistence: false,
    clinicalValidationComplete: false,
  } as const;
}

// ============================================================
// END OF SINUS VIEWER VIEWPORT ACCESSIBILITY
// ============================================================
