
/**
 * SINUS VIEWER — VIEWPORT RESIZE OBSERVER
 * =======================================
 *
 * Measures an MPR viewport container in CSS pixels.
 *
 * Features:
 * - ResizeObserver with initial measurement.
 * - Window-resize fallback.
 * - Optional requestAnimationFrame coalescing.
 * - Invalid/zero dimension protection.
 * - Configurable size-change tolerance.
 * - Width, height and aspect-ratio reporting.
 * - Stable callback handling.
 * - Automatic observer/event cleanup.
 * - Parent-owned renderer and geometry updates.
 *
 * IMPORTANT:
 * Width/height are CSS pixels, not DICOM pixels,
 * physical millimeters, or device pixels.
 *
 * The parent must independently derive:
 * - Canvas bitmap dimensions.
 * - MPR display transform.
 * - Verified horizontal mm-per-CSS-pixel scale.
 * - Crosshair and measurement projection.
 *
 * This component does not alter DICOM files.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type CSSProperties,
  type ReactNode,
} from "react";

// ============================================================
// 01 — PUBLIC TYPES
// ============================================================

export type ResizeViewportPlane =
  | "axial"
  | "coronal"
  | "sagittal";

export interface ViewportCssSize {
  readonly width: number;
  readonly height: number;
  readonly aspectRatio: number;
}

export interface ViewportResizeEvent {
  readonly plane: ResizeViewportPlane;
  readonly size: ViewportCssSize;
}

export interface ViewportResizeObserverProps {
  readonly plane: ResizeViewportPlane;
  readonly children: ReactNode;

  /**
   * Parent uses these CSS dimensions to update
   * its own canvas and display transforms.
   */
  readonly onResize: (
    event: ViewportResizeEvent,
  ) => void;

  readonly enabled?: boolean;

  /**
   * CSS-pixel difference below this threshold
   * does not trigger a new parent notification.
   */
  readonly toleranceCssPx?: number;

  /**
   * Coalesce multiple observations into one
   * animation frame when supported.
   */
  readonly useAnimationFrame?: boolean;

  readonly className?: string;
  readonly style?: CSSProperties;
}

// ============================================================
// 02 — CONSTANTS
// ============================================================

export const VIEWPORT_RESIZE_MIN_CSS_PX = 1;
export const VIEWPORT_RESIZE_MAX_CSS_PX = 100000;
export const VIEWPORT_RESIZE_DEFAULT_TOLERANCE = 0.25;

// ============================================================
// 03 — PURE SIZE HELPERS
// ============================================================

export function isValidViewportCssDimension(
  value: number,
): boolean {
  return (
    Number.isFinite(value) &&
    value >= VIEWPORT_RESIZE_MIN_CSS_PX &&
    value <= VIEWPORT_RESIZE_MAX_CSS_PX
  );
}

export function createViewportCssSize(
  width: number,
  height: number,
): ViewportCssSize | null {
  if (
    !isValidViewportCssDimension(width) ||
    !isValidViewportCssDimension(height)
  ) {
    return null;
  }

  const aspectRatio = width / height;

  if (
    !Number.isFinite(aspectRatio) ||
    aspectRatio <= 0
  ) {
    return null;
  }

  return {
    width,
    height,
    aspectRatio,
  };
}

export function normalizeResizeTolerance(
  value: number,
): number {
  if (
    !Number.isFinite(value) ||
    value < 0 ||
    value > 100
  ) {
    return VIEWPORT_RESIZE_DEFAULT_TOLERANCE;
  }

  return value;
}

export function hasMeaningfulViewportResize(
  previous: ViewportCssSize | null,
  next: ViewportCssSize,
  toleranceCssPx = VIEWPORT_RESIZE_DEFAULT_TOLERANCE,
): boolean {
  if (!previous) {
    return true;
  }

  const tolerance =
    normalizeResizeTolerance(toleranceCssPx);

  return (
    Math.abs(previous.width - next.width) > tolerance ||
    Math.abs(previous.height - next.height) > tolerance
  );
}

export function resizeViewportPlaneLabel(
  plane: ResizeViewportPlane,
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
// 04 — WRAPPER STYLES
// ============================================================

const rootStyle: CSSProperties = {
  position: "relative",
  display: "block",
  width: "100%",
  height: "100%",
  minWidth: 0,
  minHeight: 0,
  overflow: "hidden",
  boxSizing: "border-box",
};

// ============================================================
// 05 — MAIN COMPONENT
// ============================================================

export function ViewportResizeObserver({
  plane,
  children,
  onResize,
  enabled = true,
  toleranceCssPx = VIEWPORT_RESIZE_DEFAULT_TOLERANCE,
  useAnimationFrame = true,
  className = "",
  style,
}: ViewportResizeObserverProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  const callbackRef = useRef(onResize);
  const latestPlaneRef = useRef(plane);
  const lastReportedRef = useRef<ViewportCssSize | null>(
    null,
  );

  const pendingFrameRef = useRef<number | null>(null);
  const queuedSizeRef = useRef<ViewportCssSize | null>(
    null,
  );

  // Keep callback and plane references current.
  useLayoutEffect(() => {
    callbackRef.current = onResize;
    latestPlaneRef.current = plane;
  }, [onResize, plane]);

  // Clear last reported dimensions when changing
  // plane identity so the new plane receives an
  // independent initial measurement.
  useEffect(() => {
    lastReportedRef.current = null;
  }, [plane]);

  const tolerance =
    normalizeResizeTolerance(toleranceCssPx);

  // ==========================================================
  // 06 — DELIVER A VALID SIZE
  // ==========================================================

  const notifySize = useCallback(
    (size: ViewportCssSize): void => {
      if (
        !hasMeaningfulViewportResize(
          lastReportedRef.current,
          size,
          tolerance,
        )
      ) {
        return;
      }

      lastReportedRef.current = size;

      callbackRef.current({
        plane: latestPlaneRef.current,
        size,
      });
    },
    [tolerance],
  );

  // ==========================================================
  // 07 — OBSERVATION LIFECYCLE
  // ==========================================================

  useEffect(() => {
    const element = containerRef.current;

    if (!element || !enabled) {
      return;
    }

    let disposed = false;

    const flushSize = (): void => {
      pendingFrameRef.current = null;

      if (disposed) {
        return;
      }

      const size = queuedSizeRef.current;
      queuedSizeRef.current = null;

      if (size !== null) {
        notifySize(size);
      }
    };

    const queueMeasurement = (
      width: number,
      height: number,
    ): void => {
      const size = createViewportCssSize(
        width,
        height,
      );

      // Hidden or zero-size containers should not
      // deliver misleading positive dimensions.
      if (size === null || disposed) {
        queuedSizeRef.current = null;
        return;
      }

      if (
        useAnimationFrame &&
        typeof requestAnimationFrame === "function"
      ) {
        queuedSizeRef.current = size;

        if (pendingFrameRef.current === null) {
          pendingFrameRef.current =
            requestAnimationFrame(flushSize);
        }
      } else {
        notifySize(size);
      }
    };

    const measureElement = (): void => {
      const rect = element.getBoundingClientRect();

      queueMeasurement(
        rect.width,
        rect.height,
      );
    };

    // Initial size, including first mount.
    measureElement();

    let observer: ResizeObserver | null = null;

    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(() => {
        measureElement();
      });

      observer.observe(element);
    }

    // Window listener handles browsers/environments
    // without ResizeObserver and provides a secondary
    // resize signal for layout changes.
    window.addEventListener(
      "resize",
      measureElement,
      { passive: true },
    );

    return () => {
      disposed = true;

      observer?.disconnect();

      window.removeEventListener(
        "resize",
        measureElement,
      );

      if (
        pendingFrameRef.current !== null &&
        typeof cancelAnimationFrame === "function"
      ) {
        cancelAnimationFrame(
          pendingFrameRef.current,
        );
      }

      pendingFrameRef.current = null;
      queuedSizeRef.current = null;
    };
  }, [
    enabled,
    plane,
    useAnimationFrame,
    notifySize,
  ]);

  // ==========================================================
  // 08 — RENDER
  // ==========================================================

  return (
    <div
      ref={containerRef}
      className={className}
      style={{
        ...rootStyle,
        ...style,
      }}
      data-viewport-resize-observer="true"
      data-resize-plane={plane}
      data-resize-enabled={
        enabled ? "true" : "false"
      }
    >
      {children}
    </div>
  );
}

// ============================================================
// 09 — CAPABILITIES
// ============================================================

export function getViewportResizeObserverCapabilities() {
  return {
    axialSupport: true,
    coronalSupport: true,
    sagittalSupport: true,
    cssPixelMeasurements: true,
    resizeObserverSupport: true,
    initialMeasurement: true,
    windowResizeFallback: true,
    animationFrameCoalescing: true,
    zeroSizeRejection: true,
    invalidSizeRejection: true,
    duplicateSizeSuppression: true,
    configurableTolerance: true,
    independentPlaneReporting: true,
    observerCleanup: true,
    eventListenerCleanup: true,
    frameCancellation: true,
    parentOwnedRendererUpdates: true,
    directDICOMAccess: false,
    directNetworkRequests: false,
    browserPersistence: false,
    physicalScaleInference: false,
    clinicalValidationComplete: false,
  } as const;
}

// ============================================================
// END OF SINUS VIEWER VIEWPORT RESIZE OBSERVER
// ============================================================
