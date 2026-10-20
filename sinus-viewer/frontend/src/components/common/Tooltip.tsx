
/**
 * SINUS VIEWER — ACCESSIBLE TOOLTIP
 * =================================
 *
 * Reusable contextual help for viewer controls.
 *
 * Features:
 * - Pointer hover and keyboard focus.
 * - Controlled opening delay.
 * - Escape-key dismissal.
 * - Top, bottom, left, right or automatic placement.
 * - Viewport edge collision handling.
 * - Repositioning on scrolling and resizing.
 * - React portal above clipped viewer panels.
 * - Accessible aria-describedby association.
 * - Reduced-motion support.
 *
 * Security:
 * - Only predefined application guidance.
 * - No patient identifiers or DICOM metadata.
 * - No network or filesystem operations.
 * - No browser persistence.
 * - No source medical-image modification.
 *
 * The component does not execute toolbar actions.
 */

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

import { createPortal } from "react-dom";

// ============================================================
// 01 — PUBLIC TYPES
// ============================================================

export type TooltipPlacement =
  | "auto"
  | "top"
  | "bottom"
  | "left"
  | "right";

export type TooltipMessageKey =
  | "dataset-browser"
  | "open-viewer"
  | "axial-view"
  | "coronal-view"
  | "sagittal-view"
  | "fit-view"
  | "center-crosshair"
  | "pan-view"
  | "zoom-view"
  | "scroll-slices"
  | "window-center"
  | "window-width"
  | "auto-window"
  | "invert-grayscale"
  | "measure-distance"
  | "measure-angle"
  | "measure-polyline"
  | "measure-polygon"
  | "finish-measurement"
  | "undo-measurement"
  | "preview-images"
  | "reset-view"
  | "sign-out";

export interface TooltipProps {
  readonly children: ReactNode;
  readonly messageKey: TooltipMessageKey;

  readonly placement?: TooltipPlacement;
  readonly delayMs?: number;
  readonly disabled?: boolean;

  readonly className?: string;
}

interface TooltipPosition {
  readonly top: number;
  readonly left: number;
  readonly placement: Exclude<TooltipPlacement, "auto">;
}

// ============================================================
// 02 — CONSTANTS
// ============================================================

export const TOOLTIP_DEFAULT_DELAY_MS = 450;
export const TOOLTIP_MAX_DELAY_MS = 2000;
export const TOOLTIP_VIEWPORT_MARGIN = 8;
export const TOOLTIP_TRIGGER_GAP = 9;
export const TOOLTIP_MAX_WIDTH = 260;

export const TOOLTIP_MESSAGES: Readonly<
  Record<TooltipMessageKey, string>
> = {
  "dataset-browser":
    "Browse backend-authorized imaging datasets.",
  "open-viewer":
    "Open the validated imaging series in the viewer.",
  "axial-view":
    "Display the transverse anatomical plane.",
  "coronal-view":
    "Display the frontal anatomical plane.",
  "sagittal-view":
    "Display the side anatomical plane.",
  "fit-view":
    "Fit the current image to the available viewport.",
  "center-crosshair":
    "Center the view on the current crosshair position.",
  "pan-view":
    "Move the image within the viewport.",
  "zoom-view":
    "Magnify or reduce the displayed image.",
  "scroll-slices":
    "Navigate through anatomical image slices.",
  "window-center":
    "Adjust the center of the displayed intensity range.",
  "window-width":
    "Adjust the width of the displayed intensity range.",
  "auto-window":
    "Estimate a display range from loaded image intensities.",
  "invert-grayscale":
    "Reverse the grayscale display mapping.",
  "measure-distance":
    "Select two points to measure physical distance.",
  "measure-angle":
    "Select three points to measure an angle.",
  "measure-polyline":
    "Draw connected segments to measure total length.",
  "measure-polygon":
    "Draw a planar polygon to estimate enclosed area.",
  "finish-measurement":
    "Complete the current measurement drawing.",
  "undo-measurement":
    "Undo the latest measurement action.",
  "preview-images":
    "Display non-diagnostic anatomical preview images.",
  "reset-view":
    "Restore the current viewer display settings.",
  "sign-out":
    "End the current authorized application session.",
};

// ============================================================
// 03 — POSITIONING HELPERS
// ============================================================

function clamp(
  value: number,
  min: number,
  max: number,
): number {
  return Math.max(min, Math.min(max, value));
}

function safeDelay(value: number): number {
  return Number.isFinite(value)
    ? clamp(value, 0, TOOLTIP_MAX_DELAY_MS)
    : TOOLTIP_DEFAULT_DELAY_MS;
}

function calculateTooltipPosition(
  trigger: DOMRect,
  tooltip: DOMRect,
  requested: TooltipPlacement,
): TooltipPosition {
  const margin = TOOLTIP_VIEWPORT_MARGIN;
  const gap = TOOLTIP_TRIGGER_GAP;

  const room = {
    top: trigger.top - margin,
    bottom: window.innerHeight - trigger.bottom - margin,
    left: trigger.left - margin,
    right: window.innerWidth - trigger.right - margin,
  };

  const fits = {
    top: room.top >= tooltip.height + gap,
    bottom: room.bottom >= tooltip.height + gap,
    left: room.left >= tooltip.width + gap,
    right: room.right >= tooltip.width + gap,
  };

  const preferred: Exclude<TooltipPlacement, "auto"> =
    requested === "auto" ? "top" : requested;

  const opposite = {
    top: "bottom",
    bottom: "top",
    left: "right",
    right: "left",
  } as const;

  let placement: Exclude<TooltipPlacement, "auto"> =
    preferred;

  if (!fits[placement]) {
    if (fits[opposite[placement]]) {
      placement = opposite[placement];
    } else {
      const candidates = (
        ["top", "bottom", "right", "left"] as const
      ).slice();

      placement = candidates.sort(
        (a, b) => room[b] - room[a],
      )[0];
    }
  }

  let top = trigger.top;
  let left = trigger.left;

  switch (placement) {
    case "top":
      top = trigger.top - tooltip.height - gap;
      left =
        trigger.left +
        (trigger.width - tooltip.width) / 2;
      break;

    case "bottom":
      top = trigger.bottom + gap;
      left =
        trigger.left +
        (trigger.width - tooltip.width) / 2;
      break;

    case "left":
      top =
        trigger.top +
        (trigger.height - tooltip.height) / 2;
      left = trigger.left - tooltip.width - gap;
      break;

    case "right":
      top =
        trigger.top +
        (trigger.height - tooltip.height) / 2;
      left = trigger.right + gap;
      break;
  }

  return {
    top: clamp(
      top,
      margin,
      Math.max(margin, window.innerHeight - tooltip.height - margin),
    ),
    left: clamp(
      left,
      margin,
      Math.max(margin, window.innerWidth - tooltip.width - margin),
    ),
    placement,
  };
}

// ============================================================
// 04 — STYLES
// ============================================================

const triggerStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  minWidth: 0,
};

const tooltipStyle: CSSProperties = {
  position: "fixed",
  zIndex: 12000,
  boxSizing: "border-box",
  maxWidth: `min(${TOOLTIP_MAX_WIDTH}px, calc(100vw - 16px))`,
  padding: "8px 10px",
  borderRadius: 6,
  border: "1px solid #475569",
  backgroundColor: "#0f172a",
  color: "#f8fafc",
  boxShadow: "0 8px 24px rgba(0,0,0,0.45)",
  fontSize: 12,
  fontWeight: 400,
  lineHeight: 1.5,
  overflowWrap: "anywhere",
  pointerEvents: "none",
};

const ANIMATION_CSS = `
  @keyframes sinus-tooltip-enter {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  .sinus-viewer-tooltip-popup {
    animation: sinus-tooltip-enter 120ms ease-out both;
  }

  @media (prefers-reduced-motion: reduce) {
    .sinus-viewer-tooltip-popup {
      animation: none !important;
    }
  }
`;

// ============================================================
// 05 — MAIN TOOLTIP COMPONENT
// ============================================================

export function Tooltip({
  children,
  messageKey,
  placement = "auto",
  delayMs = TOOLTIP_DEFAULT_DELAY_MS,
  disabled = false,
  className = "",
}: TooltipProps) {
  const tooltipId = useId();

  const triggerRef = useRef<HTMLSpanElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const timerRef = useRef<number | null>(null);

  const [open, setOpen] = useState(false);
  const [position, setPosition] =
    useState<TooltipPosition | null>(null);

  const message = TOOLTIP_MESSAGES[messageKey];

  // ==========================================================
  // 06 — TIMER MANAGEMENT
  // ==========================================================

  const clearPendingTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const hide = useCallback(() => {
    clearPendingTimer();
    setOpen(false);
    setPosition(null);
  }, [clearPendingTimer]);

  const show = useCallback(() => {
    if (disabled || !message) {
      return;
    }

    clearPendingTimer();

    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      setOpen(true);
    }, safeDelay(delayMs));
  }, [disabled, message, delayMs, clearPendingTimer]);

  // ==========================================================
  // 07 — POSITION UPDATE
  // ==========================================================

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    const tooltip = tooltipRef.current;

    if (!trigger || !tooltip) {
      return;
    }

    const next = calculateTooltipPosition(
      trigger.getBoundingClientRect(),
      tooltip.getBoundingClientRect(),
      placement,
    );

    setPosition((previous) => {
      if (
        previous?.top === next.top &&
        previous.left === next.left &&
        previous.placement === next.placement
      ) {
        return previous;
      }

      return next;
    });
  }, [placement]);

  // ==========================================================
  // 08 — LIFECYCLE / VIEWPORT EVENTS
  // ==========================================================

  useEffect(() => {
    if (!open || disabled) {
      return;
    }

    updatePosition();

    window.addEventListener("resize", updatePosition);
    window.addEventListener(
      "scroll",
      updatePosition,
      true,
    );

    const observer =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(updatePosition)
        : null;

    if (triggerRef.current) {
      observer?.observe(triggerRef.current);
    }

    if (tooltipRef.current) {
      observer?.observe(tooltipRef.current);
    }

    return () => {
      window.removeEventListener(
        "resize",
        updatePosition,
      );
      window.removeEventListener(
        "scroll",
        updatePosition,
        true,
      );
      observer?.disconnect();
    };
  }, [open, disabled, updatePosition]);

  useEffect(() => {
    if (disabled) {
      hide();
    }
  }, [disabled, hide]);

  useEffect(() => {
    return () => clearPendingTimer();
  }, [clearPendingTimer]);

  // ==========================================================
  // 09 — ESCAPE AND FOCUS
  // ==========================================================

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLSpanElement>) => {
      if (event.key === "Escape") {
        hide();
        event.stopPropagation();
      }
    },
    [hide],
  );

  const handleBlur = useCallback(
    (event: React.FocusEvent<HTMLSpanElement>) => {
      if (
        !event.currentTarget.contains(
          event.relatedTarget as Node | null,
        )
      ) {
        hide();
      }
    },
    [hide],
  );

  const canRender =
    open &&
    !disabled &&
    typeof document !== "undefined" &&
    Boolean(message);

  // ==========================================================
  // 10 — JSX
  // ==========================================================

  return (
    <>
      <span
        ref={triggerRef}
        className={className}
        style={triggerStyle}
        tabIndex={disabled ? -1 : 0}
        onPointerEnter={show}
        onPointerLeave={hide}
        onFocusCapture={show}
        onBlurCapture={handleBlur}
        onKeyDown={handleKeyDown}
        aria-describedby={
          canRender ? tooltipId : undefined
        }
        data-tooltip-trigger={messageKey}
      >
        {children}
      </span>

      {canRender &&
        createPortal(
          <>
            <style>{ANIMATION_CSS}</style>

            <div
              ref={tooltipRef}
              id={tooltipId}
              role="tooltip"
              className="sinus-viewer-tooltip-popup"
              style={{
                ...tooltipStyle,
                top: position?.top ?? 0,
                left: position?.left ?? 0,
                visibility: position
                  ? "visible"
                  : "hidden",
              }}
              data-tooltip-placement={
                position?.placement ?? "pending"
              }
            >
              {message}
            </div>
          </>,
          document.body,
        )}
    </>
  );
}

// ============================================================
// 11 — COMPONENT CAPABILITIES
// ============================================================

export function getTooltipCapabilities() {
  return {
    pointerHover: true,
    keyboardFocus: true,
    escapeDismissal: true,
    focusLossDismissal: true,
    delayedOpening: true,
    automaticPlacement: true,
    viewportCollisionHandling: true,
    scrollRepositioning: true,
    resizeRepositioning: true,
    reactPortal: true,
    reducedMotionSupport: true,
    predefinedSafeMessages: true,
    patientMetadataDisplay: false,
    directNetworkRequests: false,
    browserPersistence: false,
    sourceDICOMModification: false,
  } as const;
}

// ============================================================
// END OF SINUS VIEWER TOOLTIP
// ============================================================
