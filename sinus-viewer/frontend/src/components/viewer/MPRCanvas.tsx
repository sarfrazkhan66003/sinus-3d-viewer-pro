
/**
 * SINUS VIEWER — MPR CANVAS
 * =========================
 *
 * Two-layer React canvas component:
 *
 * 1. Base canvas:
 *    World-space MPR sampling and grayscale rendering.
 *
 * 2. Overlay canvas:
 *    Crosshair, orientation labels and centre indicator.
 *
 * Features:
 * - Patient-aligned axial / coronal / sagittal rendering.
 * - Oblique-source-volume compatibility.
 * - Window / level and brightness / contrast.
 * - Synchronized crosshair overlay.
 * - Pointer-based pan and click-to-crosshair.
 * - Wheel-based zoom or slice navigation.
 * - Selection-safe rendering cleanup.
 * - No extra frontend dependencies.
 *
 * IMPORTANT:
 * - Source volume is already decoded as Float32Array.
 * - This component never fetches original DICOM files.
 * - Pixel intensities may not be calibrated HU.
 * - Orientation labels require clinical verification.
 * - Sampling on the main thread may need a Web Worker
 *   for high-resolution clinical workflows.
 *
 * No browser persistence or original dataset writes.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";

import type { PreviewPlane } from "../../types/api";

import {
  buildMPRSamplingPlane,
  projectMPRCrosshair,
  type MPRScreenPoint,
  type MPRViewportState,
} from "../../utils/mpr";

import {
  sampleMPRPlane,
  type InterpolationMode,
  type SamplingVolume,
} from "../../utils/volumeSampling";

import {
  renderRGBA,
  type RenderOptions,
} from "../../utils/windowLevel";

import type {
  WorldPointLPS,
} from "../../utils/geometry";


// ============================================================
// 01 — CONSTANTS
// ============================================================

export const DEFAULT_MPR_WHEEL_ZOOM_FACTOR = 1.1;

export const DEFAULT_MPR_DRAG_THRESHOLD = 3;

export type MPRWheelMode = "slice" | "zoom";

export type MPRCanvasRenderStatus =
  | "idle"
  | "rendering"
  | "ready"
  | "error";


// ============================================================
// 02 — COMPONENT PROPS
// ============================================================

export interface MPRCanvasProps {
  readonly volume: SamplingVolume | null;

  readonly viewport: MPRViewportState;

  readonly renderOptions: RenderOptions;

  readonly crosshairWorld?: WorldPointLPS | null;

  readonly interpolation?: InterpolationMode;

  readonly outsideValue?: number;

  readonly showCrosshair?: boolean;

  readonly showOrientationLabels?: boolean;

  readonly wheelMode?: MPRWheelMode;

  readonly interactive?: boolean;

  readonly className?: string;

  readonly onPan?: (
    plane: PreviewPlane,
    deltaX: number,
    deltaY: number,
  ) => void;

  readonly onZoom?: (
    plane: PreviewPlane,
    factor: number,
    anchor: MPRScreenPoint,
  ) => void;

  readonly onScrollSlice?: (
    plane: PreviewPlane,
    steps: number,
  ) => void;

  readonly onCrosshairPlace?: (
    plane: PreviewPlane,
    point: MPRScreenPoint,
  ) => void;

  readonly onRenderError?: (
    message: string,
  ) => void;
}


// ============================================================
// 03 — INTERNAL TYPES
// ============================================================

interface PointerDragState {
  readonly pointerId: number;

  readonly startX: number;
  readonly startY: number;

  lastX: number;
  lastY: number;

  moved: boolean;
}

interface OrientationMarker {
  readonly top: string;
  readonly bottom: string;
  readonly left: string;
  readonly right: string;
}


// ============================================================
// 04 — BASIC HELPERS
// ============================================================

function finite(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value)
  );
}

function safeRenderMessage(): string {
  return "Unable to render the selected MPR image.";
}

/**
 * These labels describe the positive LPS axes used by
 * the MPR sampling convention.
 *
 * They are not a substitute for validated radiological
 * display orientation conventions.
 */
function orientationMarkers(
  plane: PreviewPlane,
): OrientationMarker {
  switch (plane) {
    case "axial":
      return {
        top: "A",
        bottom: "P",
        left: "R",
        right: "L",
      };

    case "coronal":
      return {
        top: "I",
        bottom: "S",
        left: "R",
        right: "L",
      };

    case "sagittal":
      return {
        top: "I",
        bottom: "S",
        left: "A",
        right: "P",
      };
  }
}


// ============================================================
// 05 — CANVAS DIMENSION MANAGEMENT
// ============================================================

function configureCanvas(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
): void {
  if (
    canvas.width !== width ||
    canvas.height !== height
  ) {
    canvas.width = width;
    canvas.height = height;
  }
}

function clearCanvas(
  canvas: HTMLCanvasElement | null,
): void {
  if (!canvas) {
    return;
  }

  const context = canvas.getContext("2d");

  if (context) {
    context.clearRect(
      0,
      0,
      canvas.width,
      canvas.height,
    );
  }
}


// ============================================================
// 06 — SCREEN COORDINATE CONVERSION
// ============================================================

/**
 * Convert pointer position from CSS layout pixels
 * into the MPR viewport's raster pixel coordinates.
 *
 * This preserves interaction alignment when the canvas
 * is displayed at a different CSS size.
 */
function pointerToMPRPixel(
  event: ReactPointerEvent<HTMLCanvasElement>,
  viewport: MPRViewportState,
): MPRScreenPoint {
  const rect =
    event.currentTarget.getBoundingClientRect();

  if (
    !positiveRectDimension(rect.width) ||
    !positiveRectDimension(rect.height)
  ) {
    return {
      x: (viewport.size.width - 1) / 2,
      y: (viewport.size.height - 1) / 2,
    };
  }

  return {
    x:
      (event.clientX - rect.left) *
      viewport.size.width / rect.width,

    y:
      (event.clientY - rect.top) *
      viewport.size.height / rect.height,
  };
}

function positiveRectDimension(value: number): boolean {
  return finite(value) && value > 0;
}

function cssDeltaToMPR(
  element: HTMLCanvasElement,
  viewport: MPRViewportState,
  deltaX: number,
  deltaY: number,
): MPRScreenPoint {
  const rect = element.getBoundingClientRect();

  if (
    !positiveRectDimension(rect.width) ||
    !positiveRectDimension(rect.height)
  ) {
    return { x: 0, y: 0 };
  }

  return {
    x: deltaX * viewport.size.width / rect.width,
    y: deltaY * viewport.size.height / rect.height,
  };
}


// ============================================================
// 07 — DRAW ORIENTATION MARKERS
// ============================================================

function drawOrientationMarkers(
  context: CanvasRenderingContext2D,
  plane: PreviewPlane,
  width: number,
  height: number,
): void {
  const labels = orientationMarkers(plane);

  context.save();

  context.fillStyle = "#93c5fd";
  context.strokeStyle = "#111827";
  context.lineWidth = 3;

  context.textAlign = "center";
  context.textBaseline = "middle";

  context.font = "bold 14px sans-serif";

  const entries = [
    {
      value: labels.top,
      x: width / 2,
      y: 15,
    },
    {
      value: labels.bottom,
      x: width / 2,
      y: height - 15,
    },
    {
      value: labels.left,
      x: 14,
      y: height / 2,
    },
    {
      value: labels.right,
      x: width - 14,
      y: height / 2,
    },
  ];

  for (const entry of entries) {
    context.strokeText(
      entry.value,
      entry.x,
      entry.y,
    );

    context.fillText(
      entry.value,
      entry.x,
      entry.y,
    );
  }

  context.restore();
}


// ============================================================
// 08 — DRAW CROSSHAIR
// ============================================================

function drawCrosshair(
  context: CanvasRenderingContext2D,
  viewport: MPRViewportState,
  world: WorldPointLPS,
): void {
  const projection = projectMPRCrosshair(
    viewport,
    world,
  );

  if (!projection.visible) {
    return;
  }

  const { x, y } = projection.screen;

  const width = viewport.size.width;
  const height = viewport.size.height;

  context.save();

  context.strokeStyle = "#22d3ee";
  context.lineWidth = 1;
  context.globalAlpha = 0.9;

  context.setLineDash([5, 4]);

  context.beginPath();
  context.moveTo(x, 0);
  context.lineTo(x, height);
  context.moveTo(0, y);
  context.lineTo(width, y);
  context.stroke();

  context.setLineDash([]);

  context.fillStyle = "#f8fafc";

  context.beginPath();
  context.arc(
    x,
    y,
    2.5,
    0,
    Math.PI * 2,
  );
  context.fill();

  context.restore();
}


// ============================================================
// 09 — MAIN COMPONENT
// ============================================================

export function MPRCanvas({
  volume,
  viewport,
  renderOptions,
  crosshairWorld = null,
  interpolation = "linear",
  outsideValue = 0,
  showCrosshair = true,
  showOrientationLabels = true,
  wheelMode = "slice",
  interactive = true,
  className = "",
  onPan,
  onZoom,
  onScrollSlice,
  onCrosshairPlace,
  onRenderError,
}: MPRCanvasProps) {
  const imageCanvasRef =
    useRef<HTMLCanvasElement | null>(null);

  const overlayCanvasRef =
    useRef<HTMLCanvasElement | null>(null);

  const dragRef =
    useRef<PointerDragState | null>(null);

  const [renderStatus, setRenderStatus] =
    useState<MPRCanvasRenderStatus>(
      volume ? "rendering" : "idle",
    );

  const [renderError, setRenderError] =
    useState<string | null>(null);

  // ==========================================================
  // 10 — IMAGE RENDERING
  // ==========================================================

  useEffect(() => {
    const canvas = imageCanvasRef.current;

    if (!canvas) {
      return;
    }

    let active = true;

    if (!volume) {
      clearCanvas(canvas);
      setRenderStatus("idle");
      setRenderError(null);
      return;
    }

    setRenderStatus("rendering");
    setRenderError(null);

    try {
      const plane = buildMPRSamplingPlane(
        viewport,
      );

      const sampled = sampleMPRPlane(
        volume,
        plane,
        {
          interpolation,
          boundary: "fill",
          outsideValue,
        },
      );

      const image = renderRGBA(
        sampled.intensities,
        sampled.width,
        sampled.height,
        renderOptions,
      );

      if (!active) {
        return;
      }

      configureCanvas(
        canvas,
        image.width,
        image.height,
      );

      const context = canvas.getContext(
        "2d",
        {
          alpha: false,
        },
      );

      if (!context) {
        throw new Error(
          "Canvas rendering context unavailable.",
        );
      }

      const pixels = context.createImageData(
        image.width,
        image.height,
      );

      pixels.data.set(image.pixels);

      context.putImageData(
        pixels,
        0,
        0,
      );

      setRenderStatus("ready");
      setRenderError(null);
    } catch {
      if (!active) {
        return;
      }

      clearCanvas(canvas);

      const message = safeRenderMessage();

      setRenderStatus("error");
      setRenderError(message);

      onRenderError?.(message);
    }

    return () => {
      active = false;
    };
  }, [
    volume,
    viewport,
    renderOptions,
    interpolation,
    outsideValue,
    onRenderError,
  ]);

  // ==========================================================
  // 11 — CROSSHAIR / MARKER OVERLAY
  // ==========================================================

  useEffect(() => {
    const canvas = overlayCanvasRef.current;

    if (!canvas) {
      return;
    }

    configureCanvas(
      canvas,
      viewport.size.width,
      viewport.size.height,
    );

    const context = canvas.getContext("2d");

    if (!context) {
      return;
    }

    context.clearRect(
      0,
      0,
      canvas.width,
      canvas.height,
    );

    if (!volume || renderStatus !== "ready") {
      return;
    }

    if (showOrientationLabels) {
      drawOrientationMarkers(
        context,
        viewport.plane,
        viewport.size.width,
        viewport.size.height,
      );
    }

    if (
      showCrosshair &&
      crosshairWorld !== null
    ) {
      drawCrosshair(
        context,
        viewport,
        crosshairWorld,
      );
    }
  }, [
    volume,
    viewport,
    crosshairWorld,
    showCrosshair,
    showOrientationLabels,
    renderStatus,
  ]);

  // ==========================================================
  // 12 — POINTER DOWN
  // ==========================================================

  const handlePointerDown = useCallback(
    (
      event: ReactPointerEvent<HTMLCanvasElement>,
    ): void => {
      if (
        !interactive ||
        !volume ||
        event.button !== 0
      ) {
        return;
      }

      dragRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        lastX: event.clientX,
        lastY: event.clientY,
        moved: false,
      };

      event.currentTarget.setPointerCapture(
        event.pointerId,
      );
    },
    [interactive, volume],
  );

  // ==========================================================
  // 13 — POINTER MOVE / PAN
  // ==========================================================

  const handlePointerMove = useCallback(
    (
      event: ReactPointerEvent<HTMLCanvasElement>,
    ): void => {
      const drag = dragRef.current;

      if (
        !drag ||
        drag.pointerId !== event.pointerId ||
        !interactive
      ) {
        return;
      }

      const deltaX =
        event.clientX - drag.lastX;

      const deltaY =
        event.clientY - drag.lastY;

      const totalDistance = Math.hypot(
        event.clientX - drag.startX,
        event.clientY - drag.startY,
      );

      if (
        totalDistance >=
        DEFAULT_MPR_DRAG_THRESHOLD
      ) {
        drag.moved = true;
      }

      if (drag.moved && onPan) {
        const converted = cssDeltaToMPR(
          event.currentTarget,
          viewport,
          deltaX,
          deltaY,
        );

        onPan(
          viewport.plane,
          converted.x,
          converted.y,
        );
      }

      drag.lastX = event.clientX;
      drag.lastY = event.clientY;
    },
    [interactive, viewport, onPan],
  );

  // ==========================================================
  // 14 — POINTER UP / CROSSHAIR PLACEMENT
  // ==========================================================

  const handlePointerUp = useCallback(
    (
      event: ReactPointerEvent<HTMLCanvasElement>,
    ): void => {
      const drag = dragRef.current;

      if (
        !drag ||
        drag.pointerId !== event.pointerId
      ) {
        return;
      }

      dragRef.current = null;

      if (
        event.currentTarget.hasPointerCapture(
          event.pointerId,
        )
      ) {
        event.currentTarget.releasePointerCapture(
          event.pointerId,
        );
      }

      if (
        interactive &&
        !drag.moved &&
        onCrosshairPlace
      ) {
        onCrosshairPlace(
          viewport.plane,
          pointerToMPRPixel(
            event,
            viewport,
          ),
        );
      }
    },
    [
      interactive,
      viewport,
      onCrosshairPlace,
    ],
  );

  const handlePointerCancel = useCallback(
    (): void => {
      dragRef.current = null;
    },
    [],
  );

  // ==========================================================
  // 15 — WHEEL NAVIGATION
  // ==========================================================

  const handleWheel = useCallback(
    (
      event: ReactWheelEvent<HTMLCanvasElement>,
    ): void => {
      if (
        !interactive ||
        !volume ||
        !finite(event.deltaY) ||
        event.deltaY === 0
      ) {
        return;
      }

      if (
        wheelMode === "zoom" ||
        event.ctrlKey
      ) {
        if (!onZoom) {
          return;
        }

        const factor =
          event.deltaY < 0
            ? DEFAULT_MPR_WHEEL_ZOOM_FACTOR
            : 1 /
              DEFAULT_MPR_WHEEL_ZOOM_FACTOR;

        const rect =
          event.currentTarget.getBoundingClientRect();

        const anchor: MPRScreenPoint = {
          x: rect.width > 0
            ? (event.clientX - rect.left) *
              viewport.size.width / rect.width
            : (viewport.size.width - 1) / 2,

          y: rect.height > 0
            ? (event.clientY - rect.top) *
              viewport.size.height / rect.height
            : (viewport.size.height - 1) / 2,
        };

        onZoom(
          viewport.plane,
          factor,
          anchor,
        );

        return;
      }

      if (onScrollSlice) {
        const steps =
          event.deltaY > 0 ? 1 : -1;

        onScrollSlice(
          viewport.plane,
          steps,
        );
      }
    },
    [
      interactive,
      volume,
      viewport,
      wheelMode,
      onZoom,
      onScrollSlice,
    ],
  );

  // ==========================================================
  // 16 — VIEW ACCESSIBILITY
  // ==========================================================

  const planeLabel =
    viewport.plane === "axial"
      ? "Axial"
      : viewport.plane === "coronal"
        ? "Coronal"
        : "Sagittal";

  const containerStyle = {
    position: "relative" as const,
    width: "100%",
    height: "100%",
    minWidth: 0,
    minHeight: 0,
    overflow: "hidden" as const,
    backgroundColor: "#000000",
  };

  const canvasStyle = {
    position: "absolute" as const,
    inset: 0,
    width: "100%",
    height: "100%",
    display: "block",
  };

  // ==========================================================
  // 17 — JSX OUTPUT
  // ==========================================================

  return (
    <div
      className={className}
      style={containerStyle}
      data-mpr-plane={viewport.plane}
      data-render-status={renderStatus}
      aria-label={`${planeLabel} MPR viewport`}
    >
      <canvas
        ref={imageCanvasRef}
        width={viewport.size.width}
        height={viewport.size.height}
        style={canvasStyle}
        aria-hidden="true"
      />

      <canvas
        ref={overlayCanvasRef}
        width={viewport.size.width}
        height={viewport.size.height}
        style={{
          ...canvasStyle,
          pointerEvents: "none",
        }}
        aria-hidden="true"
      />

      <canvas
        width={viewport.size.width}
        height={viewport.size.height}
        style={{
          ...canvasStyle,
          touchAction: "none",
          cursor: interactive
            ? "crosshair"
            : "default",
        }}
        role="img"
        aria-label={`${planeLabel} medical image interaction surface`}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onLostPointerCapture={handlePointerCancel}
        onWheel={handleWheel}
      />

      {renderStatus === "rendering" && (
        <div
          style={{
            position: "absolute",
            left: 10,
            bottom: 10,
            color: "#e5e7eb",
            backgroundColor: "rgba(0,0,0,0.65)",
            padding: "4px 8px",
            fontSize: 12,
            pointerEvents: "none",
          }}
          role="status"
        >
          Rendering {planeLabel}...
        </div>
      )}

      {renderStatus === "idle" && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "#9ca3af",
            fontSize: 13,
            pointerEvents: "none",
          }}
        >
          No volume loaded
        </div>
      )}

      {renderStatus === "error" && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 16,
            color: "#fca5a5",
            textAlign: "center",
            fontSize: 13,
            backgroundColor: "rgba(0,0,0,0.80)",
            pointerEvents: "none",
          }}
          role="alert"
        >
          {renderError ?? safeRenderMessage()}
        </div>
      )}
    </div>
  );
}


// ============================================================
// 18 — COMPONENT CAPABILITIES
// ============================================================

export function getMPRCanvasCapabilities() {
  return {
    canvas2DRendering: true,
    patientAlignedResampling: true,
    obliqueSourceGeometry: true,
    windowLevelDisplay: true,
    grayscaleRGBA: true,
    overlayCrosshair: true,
    orientationMarkers: true,
    pointerPanning: true,
    clickToCrosshair: true,
    wheelSliceNavigation: true,
    wheelZoom: true,
    sourceVoxelModification: false,
    clinicalValidationComplete: false,
  } as const;
}


// ============================================================
// END OF SINUS VIEWER MPR CANVAS
// ============================================================
