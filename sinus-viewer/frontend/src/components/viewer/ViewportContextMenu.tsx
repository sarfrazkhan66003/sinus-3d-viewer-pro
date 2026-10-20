
/**
 * SINUS VIEWER — VIEWPORT CONTEXT MENU
 * ====================================
 *
 * Reusable MPR viewport context menu.
 *
 * Controlled actions:
 * - Fit to View
 * - Reset View
 * - Zoom In / Zoom Out
 * - Show / Hide Crosshair
 * - Copy Verified Coordinates
 *
 * Interaction:
 * - Right mouse click
 * - Keyboard ContextMenu / Shift+F10
 * - ArrowUp / ArrowDown menu navigation
 * - Home / End keyboard navigation
 * - Escape, outside pointer, scroll and resize close
 * - Viewport-clamped menu placement
 * - Focus return on close
 *
 * SECURITY AND PRIVACY:
 * - Does not inspect DICOM metadata.
 * - Does not access the clipboard directly.
 * - Copy command requires upstream verification.
 * - Does not expose paths, patient names or UIDs.
 * - Does not modify original DICOM files.
 *
 * Parent remains authoritative for all actions.
 */

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";

// ============================================================
// 01 — PUBLIC TYPES
// ============================================================

export type ContextMenuPlane =
  | "axial"
  | "coronal"
  | "sagittal";

export type ContextMenuCommand =
  | "fit"
  | "reset"
  | "zoom-in"
  | "zoom-out"
  | "toggle-crosshair"
  | "copy-coordinates";

export interface ContextMenuAction {
  readonly plane: ContextMenuPlane;
  readonly command: ContextMenuCommand;
}

export interface ViewportContextMenuProps {
  readonly plane: ContextMenuPlane;

  /**
   * Wrap the existing viewport image and overlays.
   * This element establishes the positioning bounds.
   */
  readonly children: ReactNode;

  readonly onAction: (
    action: ContextMenuAction,
  ) => void;

  readonly enabled?: boolean;
  readonly loading?: boolean;
  readonly crosshairVisible?: boolean;

  /**
   * True only if the parent has validated the
   * coordinate data intended for copying.
   *
   * This component receives no coordinate values.
   */
  readonly verifiedCoordinatesAvailable?: boolean;

  readonly canZoomIn?: boolean;
  readonly canZoomOut?: boolean;

  readonly className?: string;
  readonly ariaLabel?: string;
}

export interface ContextMenuPosition {
  readonly x: number;
  readonly y: number;
}

interface ContextMenuItem {
  readonly command: ContextMenuCommand;
  readonly label: string;
  readonly enabled: boolean;
  readonly separated?: boolean;
}

// ============================================================
// 02 — CONSTANTS
// ============================================================

export const CONTEXT_MENU_ESTIMATED_WIDTH = 224;
export const CONTEXT_MENU_HORIZONTAL_PADDING = 8;
export const CONTEXT_MENU_VERTICAL_PADDING = 8;

// ============================================================
// 03 — PURE COORDINATE HELPERS
// ============================================================

function clamp(
  value: number,
  minimum: number,
  maximum: number,
): number {
  return Math.min(
    Math.max(value, minimum),
    maximum,
  );
}

/**
 * Clamp a menu into a viewport coordinate system.
 * All dimensions are CSS pixels.
 *
 * A viewport smaller than the menu allows the menu
 * to align at zero and scroll internally.
 */
export function clampContextMenuPosition(
  requested: ContextMenuPosition,
  viewportWidth: number,
  viewportHeight: number,
  menuWidth: number,
  menuHeight: number,
): ContextMenuPosition {
  if (
    !Number.isFinite(requested.x) ||
    !Number.isFinite(requested.y) ||
    !Number.isFinite(viewportWidth) ||
    !Number.isFinite(viewportHeight) ||
    !Number.isFinite(menuWidth) ||
    !Number.isFinite(menuHeight) ||
    viewportWidth <= 0 ||
    viewportHeight <= 0 ||
    menuWidth <= 0 ||
    menuHeight <= 0
  ) {
    return { x: 0, y: 0 };
  }

  return {
    x: clamp(
      requested.x,
      0,
      Math.max(0, viewportWidth - menuWidth),
    ),
    y: clamp(
      requested.y,
      0,
      Math.max(0, viewportHeight - menuHeight),
    ),
  };
}

// ============================================================
// 04 — SAFE MENU ITEM CATALOG
// ============================================================

export function getViewportContextMenuItems(
  crosshairVisible: boolean,
  verifiedCoordinatesAvailable: boolean,
  canZoomIn: boolean,
  canZoomOut: boolean,
): readonly ContextMenuItem[] {
  return [
    {
      command: "fit",
      label: "Fit to View",
      enabled: true,
    },
    {
      command: "reset",
      label: "Reset View",
      enabled: true,
    },
    {
      command: "zoom-in",
      label: "Zoom In",
      enabled: canZoomIn,
      separated: true,
    },
    {
      command: "zoom-out",
      label: "Zoom Out",
      enabled: canZoomOut,
    },
    {
      command: "toggle-crosshair",
      label: crosshairVisible
        ? "Hide Crosshair"
        : "Show Crosshair",
      enabled: true,
      separated: true,
    },
    {
      command: "copy-coordinates",
      label: "Copy Verified Coordinates",
      enabled: verifiedCoordinatesAvailable,
      separated: true,
    },
  ];
}

export function contextMenuPlaneLabel(
  plane: ContextMenuPlane,
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
// 05 — STYLES
// ============================================================

const wrapperStyle: CSSProperties = {
  position: "relative",
  width: "100%",
  height: "100%",
  minWidth: 0,
  minHeight: 0,
  outlineOffset: -2,
};

const menuStyle: CSSProperties = {
  position: "absolute",
  zIndex: 50,
  display: "flex",
  flexDirection: "column",
  gap: 2,
  boxSizing: "border-box",
  width: CONTEXT_MENU_ESTIMATED_WIDTH,
  maxWidth: "100%",
  maxHeight: "100%",
  overflowY: "auto",
  padding: 5,
  border: "1px solid #475569",
  borderRadius: 7,
  backgroundColor: "#101827",
  color: "#e2e8f0",
  boxShadow: "0 12px 30px rgba(0,0,0,0.45)",
};

const itemStyle: CSSProperties = {
  display: "block",
  width: "100%",
  minHeight: 32,
  padding: "7px 10px",
  border: 0,
  borderRadius: 4,
  background: "transparent",
  color: "#e2e8f0",
  fontSize: 12,
  textAlign: "left",
  cursor: "pointer",
};

const separatorStyle: CSSProperties = {
  height: 1,
  margin: "4px 3px",
  backgroundColor: "#334155",
};

// ============================================================
// 06 — MAIN COMPONENT
// ============================================================

export function ViewportContextMenu({
  plane,
  children,
  onAction,
  enabled = true,
  loading = false,
  crosshairVisible = true,
  verifiedCoordinatesAvailable = false,
  canZoomIn = true,
  canZoomOut = true,
  className = "",
  ariaLabel,
}: ViewportContextMenuProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const itemRefs = useRef<
    Array<HTMLButtonElement | null>
  >([]);

  const menuId = useId();

  const [open, setOpen] = useState(false);
  const [requestedPosition, setRequestedPosition] =
    useState<ContextMenuPosition>({ x: 0, y: 0 });
  const [menuPosition, setMenuPosition] =
    useState<ContextMenuPosition>({ x: 0, y: 0 });

  const canOpen = enabled && !loading;

  const items = getViewportContextMenuItems(
    crosshairVisible,
    verifiedCoordinatesAvailable,
    canZoomIn,
    canZoomOut,
  );

  // ==========================================================
  // 07 — CLOSE / FOCUS RETURN
  // ==========================================================

  const closeMenu = useCallback(
    (restoreFocus = false): void => {
      setOpen(false);

      if (
        restoreFocus &&
        triggerRef.current?.isConnected
      ) {
        triggerRef.current.focus();
      }
    },
    [],
  );

  // ==========================================================
  // 08 — OPEN AT LOCAL VIEWPORT POSITION
  // ==========================================================

  const openAt = useCallback(
    (
      requested: ContextMenuPosition,
      trigger: HTMLElement,
    ): void => {
      const wrapper = wrapperRef.current;

      if (!wrapper || !canOpen) {
        return;
      }

      triggerRef.current = trigger;
      setRequestedPosition(requested);
      setMenuPosition(requested);
      setOpen(true);
    },
    [canOpen],
  );

  // ==========================================================
  // 09 — RIGHT CLICK
  // ==========================================================

  const handleContextMenu = useCallback(
    (event: MouseEvent<HTMLDivElement>): void => {
      if (!canOpen) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      const wrapper = wrapperRef.current;

      if (!wrapper) {
        return;
      }

      const rect = wrapper.getBoundingClientRect();

      openAt(
        {
          x: event.clientX - rect.left,
          y: event.clientY - rect.top,
        },
        wrapper,
      );
    },
    [canOpen, openAt],
  );

  // ==========================================================
  // 10 — KEYBOARD MENU OPEN
  // ==========================================================

  const handleWrapperKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>): void => {
      if (
        !canOpen ||
        open ||
        !(
          event.key === "ContextMenu" ||
          (event.shiftKey && event.key === "F10")
        )
      ) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      const wrapper = wrapperRef.current;

      if (!wrapper) {
        return;
      }

      const rect = wrapper.getBoundingClientRect();

      openAt(
        {
          x: rect.width / 2,
          y: rect.height / 2,
        },
        wrapper,
      );
    },
    [canOpen, open, openAt],
  );

  // ==========================================================
  // 11 — MEASURE AND CLAMP THE ACTUAL MENU
  // ==========================================================

  useEffect(() => {
    if (!open) {
      return;
    }

    const wrapper = wrapperRef.current;
    const menu = menuRef.current;

    if (!wrapper || !menu) {
      return;
    }

    const updatePosition = () => {
      const containerRect =
        wrapper.getBoundingClientRect();

      const menuRect =
        menu.getBoundingClientRect();

      const position = clampContextMenuPosition(
        requestedPosition,
        containerRect.width,
        containerRect.height,
        menuRect.width,
        menuRect.height,
      );

      setMenuPosition(position);
    };

    updatePosition();

    const observer =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(updatePosition)
        : null;

    observer?.observe(wrapper);
    observer?.observe(menu);

    return () => {
      observer?.disconnect();
    };
  }, [open, requestedPosition]);

  // ==========================================================
  // 12 — FOCUS INITIAL ENABLED ITEM
  // ==========================================================

  useEffect(() => {
    if (!open) {
      return;
    }

    const firstEnabledIndex = items.findIndex(
      (item) => item.enabled,
    );

    if (firstEnabledIndex >= 0) {
      itemRefs.current[firstEnabledIndex]?.focus();
    }
    // Initial focus only; do not steal focus when
    // crosshair visibility or zoom bounds update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // ==========================================================
  // 13 — OUTSIDE POINTER / SCROLL / RESIZE
  // ==========================================================

  useEffect(() => {
    if (!open) {
      return;
    }

    const handleOutsidePointer = (
      event: PointerEvent,
    ) => {
      const target = event.target;

      if (
        target instanceof Node &&
        !menuRef.current?.contains(target)
      ) {
        closeMenu(false);
      }
    };

    const handleScroll = () => closeMenu(false);
    const handleResize = () => closeMenu(false);

    document.addEventListener(
      "pointerdown",
      handleOutsidePointer,
      true,
    );

    window.addEventListener(
      "scroll",
      handleScroll,
      true,
    );

    window.addEventListener(
      "resize",
      handleResize,
    );

    return () => {
      document.removeEventListener(
        "pointerdown",
        handleOutsidePointer,
        true,
      );
      window.removeEventListener(
        "scroll",
        handleScroll,
        true,
      );
      window.removeEventListener(
        "resize",
        handleResize,
      );
    };
  }, [open, closeMenu]);

  // ==========================================================
  // 14 — CLOSE IF PARENT DISABLES THE VIEWPORT
  // ==========================================================

  useEffect(() => {
    if (!canOpen && open) {
      closeMenu(false);
    }
  }, [canOpen, open, closeMenu]);

  // ==========================================================
  // 15 — ALLOWLISTED COMMAND DISPATCH
  // ==========================================================

  const executeCommand = useCallback(
    (command: ContextMenuCommand): void => {
      if (!canOpen) {
        return;
      }

      const allowed = getViewportContextMenuItems(
        crosshairVisible,
        verifiedCoordinatesAvailable,
        canZoomIn,
        canZoomOut,
      ).some(
        (item) =>
          item.command === command &&
          item.enabled,
      );

      if (!allowed) {
        return;
      }

      closeMenu(true);

      onAction({
        plane,
        command,
      });
    },
    [
      canOpen,
      crosshairVisible,
      verifiedCoordinatesAvailable,
      canZoomIn,
      canZoomOut,
      closeMenu,
      onAction,
      plane,
    ],
  );

  // ==========================================================
  // 16 — KEYBOARD NAVIGATION WITHIN THE MENU
  // ==========================================================

  const handleMenuKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeMenu(true);
        return;
      }

      if (
        event.key !== "ArrowDown" &&
        event.key !== "ArrowUp" &&
        event.key !== "Home" &&
        event.key !== "End"
      ) {
        return;
      }

      const enabledIndices = items
        .map((item, index) =>
          item.enabled ? index : -1,
        )
        .filter((index) => index >= 0);

      if (enabledIndices.length === 0) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      const currentIndex = itemRefs.current.findIndex(
        (element) => element === document.activeElement,
      );

      const position = enabledIndices.indexOf(
        currentIndex,
      );

      let nextPosition = 0;

      if (event.key === "End") {
        nextPosition = enabledIndices.length - 1;
      } else if (event.key === "Home") {
        nextPosition = 0;
      } else if (event.key === "ArrowDown") {
        nextPosition =
          (position + 1) % enabledIndices.length;
      } else {
        nextPosition =
          position <= 0
            ? enabledIndices.length - 1
            : position - 1;
      }

      const index = enabledIndices[nextPosition];

      itemRefs.current[index]?.focus();
    },
    [items, closeMenu],
  );

  // ==========================================================
  // 17 — RENDER
  // ==========================================================

  return (
    <div
      ref={wrapperRef}
      className={className}
      style={wrapperStyle}
      tabIndex={canOpen ? 0 : -1}
      aria-label={
        ariaLabel ??
        `${contextMenuPlaneLabel(plane)} viewport`
      }
      aria-haspopup="menu"
      aria-expanded={open}
      aria-controls={open ? menuId : undefined}
      data-viewport-context-root="true"
      data-viewport-context-plane={plane}
      onContextMenu={handleContextMenu}
      onKeyDown={handleWrapperKeyDown}
    >
      {children}

      {open && canOpen && (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label={
            `${contextMenuPlaneLabel(plane)} viewport actions`
          }
          style={{
            ...menuStyle,
            left: menuPosition.x,
            top: menuPosition.y,
          }}
          data-viewport-context-menu="true"
          onKeyDown={handleMenuKeyDown}
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
        >
          {items.map((item, index) => (
            <div key={item.command}>
              {item.separated && (
                <div
                  role="separator"
                  style={separatorStyle}
                />
              )}

              <button
                ref={(element) => {
                  itemRefs.current[index] = element;
                }}
                type="button"
                role="menuitem"
                disabled={!item.enabled}
                tabIndex={
                  item.enabled ? -1 : -1
                }
                style={{
                  ...itemStyle,
                  opacity: item.enabled ? 1 : 0.45,
                  cursor: item.enabled
                    ? "pointer"
                    : "not-allowed",
                }}
                onClick={() =>
                  executeCommand(item.command)
                }
                onMouseEnter={() => {
                  if (item.enabled) {
                    itemRefs.current[index]?.focus();
                  }
                }}
                data-context-command={item.command}
              >
                {item.label}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ============================================================
// 18 — CAPABILITIES
// ============================================================

export function getViewportContextMenuCapabilities() {
  return {
    axialSupport: true,
    coronalSupport: true,
    sagittalSupport: true,
    rightClickOpening: true,
    keyboardOpening: true,
    arrowKeyNavigation: true,
    escapeToClose: true,
    outsideClickDismissal: true,
    scrollDismissal: true,
    resizeDismissal: true,
    viewportClamping: true,
    fitToView: true,
    resetView: true,
    zoomIn: true,
    zoomOut: true,
    crosshairVisibilityToggle: true,
    verifiedCoordinatesCopyCommand: true,
    directClipboardAccess: false,
    parentOwnedCommands: true,
    backendErrorDisplay: false,
    patientIdentifierDisplay: false,
    directNetworkRequests: false,
    browserPersistence: false,
    sourceDatasetModification: false,
    clinicalValidationComplete: false,
  } as const;
}

// ============================================================
// END OF SINUS VIEWER VIEWPORT CONTEXT MENU
// ============================================================
