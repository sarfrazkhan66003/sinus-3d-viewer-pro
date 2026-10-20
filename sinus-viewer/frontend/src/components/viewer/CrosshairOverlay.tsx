
/**
 * SINUS VIEWER — MPR CROSSHAIR OVERLAY
 * ====================================
 *
 * Controlled crosshair presentation and interaction.
 *
 * Features:
 * - Horizontal and vertical crosshair lines.
 * - Center marker and draggable handle.
 * - Pointer capture during dragging.
 * - Normalized 0..1 viewport coordinates.
 * - Viewport boundary clamping.
 * - Optional keyboard crosshair movement.
 * - Parent-supplied screen-to-patient mapping.
 * - Accessible crosshair position and controls.
 * - Optional non-interactive display.
 *
 * GEOMETRY CONTRACT:
 *
 * The parent must derive the displayed crosshair
 * position from verified MPR volume geometry.
 *
 * The mapper receives a local CSS-pixel coordinate,
 * measured from the overlay's top-left corner.
 *
 * The mapper must account for:
 * - Anatomical plane orientation.
 * - Canvas resizing and device pixel ratio.
 * - Image fit, pan and zoom.
 * - Any image rotation and reflection.
 * - Physical voxel spacing and affine geometry.
 *
 * This component does not infer DICOM LPS geometry.
 *
 * SECURITY:
 * - No backend requests.
 * - No DICOM file operations.
 * - No browser persistence.
 * - No patient identifying information.
 *
 * Clinical accuracy requires separate validation.
 */

import {
  useCallback,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
} from "react";


// ============================================================
// 01 — PUBLIC TYPES
// ============================================================

export interface CrosshairScreenPosition {
  /**
   * Normalized CSS viewport coordinates.
   *
   * x = 0 is left; x = 1 is right.
   * y = 0 is top;  y = 1 is bottom.
   */
  readonly x: number;
  readonly y: number;
}

export interface CrosshairPixelPosition {
  readonly x: number;
  readonly y: number;
}

export type CrosshairPatientLPS = readonly [
  number,
  number,
  number,
];

export type CrosshairPlane =
  | "axial"
  | "coronal"
  | "sagittal";

export type CrosshairInteractionSource =
  | "pointer"
  | "keyboard";

export interface CrosshairMovePayload {
  readonly plane: CrosshairPlane;
  readonly screen: CrosshairScreenPosition;
  readonly patientLPS: CrosshairPatientLPS;
  readonly source: CrosshairInteractionSource;
}

/**
 * The mapping implementation belongs to the parent.
 *
 * rect is the overlay's current client rectangle.
 * point is expressed in local CSS pixels.
 *
 * Return null if this point cannot be mapped
 * reliably to a finite patient-space coordinate.
 */
export type CrosshairCoordinateMapper = (
  point: CrosshairPixelPosition,
  rect: DOMRect,
) => CrosshairPatientLPS | null;

export interface CrosshairOverlayProps {
  readonly plane: CrosshairPlane;

  /**
   * Current crosshair position in normalized,
   * final displayed viewport coordinates.
   *
   * This is controlled by the parent.
   */
  readonly position: CrosshairScreenPosition | null;

  readonly visible?: boolean;
  readonly interactive?: boolean;
  readonly disabled?: boolean;
  readonly compact?: boolean;

  readonly color?: string;
  readonly className?: string;

  /**
   * If absent, the crosshair is display-only.
   */
  readonly mapScreenToPatient?:
    CrosshairCoordinateMapper;

  /**
   * Called only after the parent-provided mapper
   * produces finite patient-space coordinates.
   */
  readonly onMove?: (
    payload: CrosshairMovePayload,
  ) => void;

  readonly onInteractionStart?: () => void;
  readonly onInteractionEnd?: () => void;
}


// ============================================================
// 02 — CONSTANTS
// ============================================================

export const CROSSHAIR_DEFAULT_COLOR = "#38bdf8";

export const CROSSHAIR_HANDLE_SIZE = 30;

export const CROSSHAIR_COMPACT_HANDLE_SIZE = 24;

export const CROSSHAIR_KEYBOARD_STEP = 0.01;

export const CROSSHAIR_KEYBOARD_FAST_STEP = 0.05;

export const CROSSHAIR_MIN_VIEWPORT_SIZE = 1;


// ============================================================
// 03 — SAFE NUMERIC HELPERS
// ============================================================

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function normalizeCrosshairPosition(
  position: CrosshairScreenPosition | null | undefined,
): CrosshairScreenPosition | null {
  if (
    !position ||
    !Number.isFinite(position.x) ||
    !Number.isFinite(position.y)
  ) {
    return null;
  }

  return {
    x: clamp01(position.x),
    y: clamp01(position.y),
  };
}

export function isValidCrosshairPatientLPS(
  value: unknown,
): value is CrosshairPatientLPS {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    value.every(
      (coordinate) =>
        typeof coordinate === "number" &&
        Number.isFinite(coordinate),
    )
  );
}


// ============================================================
// 04 — VIEWPORT COORDINATE HELPERS
// ============================================================

export function clientToNormalizedCrosshair(
  clientX: number,
  clientY: number,
  rect: DOMRect,
): CrosshairScreenPosition | null {
  if (
    !Number.isFinite(clientX) ||
    !Number.isFinite(clientY) ||
    !Number.isFinite(rect.left) ||
    !Number.isFinite(rect.top) ||
    !Number.isFinite(rect.width) ||
    !Number.isFinite(rect.height) ||
    rect.width < CROSSHAIR_MIN_VIEWPORT_SIZE ||
    rect.height < CROSSHAIR_MIN_VIEWPORT_SIZE
  ) {
    return null;
  }

  return {
    x: clamp01((clientX - rect.left) / rect.width),
    y: clamp01((clientY - rect.top) / rect.height),
  };
}

export function normalizedCrosshairToPixels(
  position: CrosshairScreenPosition,
  rect: DOMRect,
): CrosshairPixelPosition | null {
  const normalized = normalizeCrosshairPosition(
    position,
  );

  if (
    normalized === null ||
    !Number.isFinite(rect.width) ||
    !Number.isFinite(rect.height) ||
    rect.width < CROSSHAIR_MIN_VIEWPORT_SIZE ||
    rect.height < CROSSHAIR_MIN_VIEWPORT_SIZE
  ) {
    return null;
  }

  return {
    x: normalized.x * rect.width,
    y: normalized.y * rect.height,
  };
}


// ============================================================
// 05 — PRESENTATION STYLES
// ============================================================

const overlayStyle: CSSProperties = {
  position: "absolute",
  inset: 0,
  overflow: "hidden",
  pointerEvents: "none",
  zIndex: 12,
  boxSizing: "border-box",
};

const verticalLineStyle: CSSProperties = {
  position: "absolute",
  top: 0,
  bottom: 0,
  width: 1,
  transform: "translateX(-50%)",
  pointerEvents: "none",
};

const horizontalLineStyle: CSSProperties = {
  position: "absolute",
  left: 0,
  right: 0,
  height: 1,
  transform: "translateY(-50%)",
  pointerEvents: "none",
};

const centerMarkerStyle: CSSProperties = {
  position: "absolute",
  width: 9,
  height: 9,
  borderRadius: "50%",
  transform: "translate(-50%, -50%)",
  border: "2px solid #f8fafc",
  boxSizing: "border-box",
  boxShadow: "0 0 0 2px rgba(2,6,23,0.65)",
  pointerEvents: "none",
};

const handleStyle: CSSProperties = {
  position: "absolute",
  transform: "translate(-50%, -50%)",
  border: "none",
  borderRadius: "50%",
  background: "transparent",
  padding: 0,
  touchAction: "none",
  userSelect: "none",
  cursor: "grab",
};

const positionTextStyle: CSSProperties = {
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
// 06 — MAIN COMPONENT
// ============================================================

export function CrosshairOverlay({
  plane,
  position,
  visible = true,
  interactive = true,
  disabled = false,
  compact = false,
  color = CROSSHAIR_DEFAULT_COLOR,
  className = "",
  mapScreenToPatient,
  onMove,
  onInteractionStart,
  onInteractionEnd,
}: CrosshairOverlayProps) {
  const overlayRef = useRef<HTMLDivElement | null>(
    null,
  );

  const activePointerRef = useRef<number | null>(
    null,
  );

  const [dragging, setDragging] = useState(false);

  const normalizedPosition =
    normalizeCrosshairPosition(position);

  const canInteract =
    visible &&
    interactive &&
    !disabled &&
    normalizedPosition !== null &&
    typeof mapScreenToPatient === "function" &&
    typeof onMove === "function";

  // ==========================================================
  // 07 — VERIFIED PARENT MAPPING
  // ==========================================================

  const emitMove = useCallback(
    (
      nextPosition: CrosshairScreenPosition,
      source: CrosshairInteractionSource,
    ): void => {
      const overlay = overlayRef.current;

      if (
        !overlay ||
        !canInteract ||
        !mapScreenToPatient ||
        !onMove
      ) {
        return;
      }

      const rect = overlay.getBoundingClientRect();

      const localPoint =
        normalizedCrosshairToPixels(
          nextPosition,
          rect,
        );

      if (localPoint === null) {
        return;
      }

      /**
       * The mapper must implement the actual image
       * display transform. Do not substitute plane-
       * based axis assumptions here.
       */
      let patientLPS: CrosshairPatientLPS | null;

      try {
        patientLPS = mapScreenToPatient(
          localPoint,
          rect,
        );
      } catch {
        // A failed geometry mapping must not move
        // the synchronized crosshair.
        return;
      }

      if (
        !isValidCrosshairPatientLPS(patientLPS)
      ) {
        return;
      }

      onMove({
        plane,
        screen: nextPosition,
        patientLPS,
        source,
      });
    },
    [
      canInteract,
      mapScreenToPatient,
      onMove,
      plane,
    ],
  );

  // ==========================================================
  // 08 — POINTER COORDINATE MAPPING
  // ==========================================================

  const updateFromPointer = useCallback(
    (event: PointerEvent<HTMLButtonElement>): void => {
      const overlay = overlayRef.current;

      if (!overlay) {
        return;
      }

      const nextPosition =
        clientToNormalizedCrosshair(
          event.clientX,
          event.clientY,
          overlay.getBoundingClientRect(),
        );

      if (nextPosition) {
        emitMove(nextPosition, "pointer");
      }
    },
    [emitMove],
  );

  // ==========================================================
  // 09 — POINTER DRAG START
  // ==========================================================

  const handlePointerDown = useCallback(
    (event: PointerEvent<HTMLButtonElement>): void => {
      if (
        !canInteract ||
        activePointerRef.current !== null ||
        event.button !== 0
      ) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      activePointerRef.current = event.pointerId;
      setDragging(true);

      event.currentTarget.setPointerCapture(
        event.pointerId,
      );

      onInteractionStart?.();

      updateFromPointer(event);
    },
    [
      canInteract,
      onInteractionStart,
      updateFromPointer,
    ],
  );

  // ==========================================================
  // 10 — POINTER DRAG MOVE
  // ==========================================================

  const handlePointerMove = useCallback(
    (event: PointerEvent<HTMLButtonElement>): void => {
      if (
        !canInteract ||
        activePointerRef.current !== event.pointerId
      ) {
        return;
      }

      event.preventDefault();
      updateFromPointer(event);
    },
    [canInteract, updateFromPointer],
  );

  // ==========================================================
  // 11 — POINTER DRAG END
  // ==========================================================

  const finishInteraction = useCallback((): void => {
    if (activePointerRef.current === null) {
      return;
    }

    activePointerRef.current = null;
    setDragging(false);
    onInteractionEnd?.();
  }, [onInteractionEnd]);

  const handlePointerUp = useCallback(
    (event: PointerEvent<HTMLButtonElement>): void => {
      if (
        activePointerRef.current !== event.pointerId
      ) {
        return;
      }

      updateFromPointer(event);

      if (
        event.currentTarget.hasPointerCapture(
          event.pointerId,
        )
      ) {
        event.currentTarget.releasePointerCapture(
          event.pointerId,
        );
      }

      finishInteraction();
    },
    [finishInteraction, updateFromPointer],
  );

  const handlePointerCancel = useCallback(
    (event: PointerEvent<HTMLButtonElement>): void => {
      if (
        activePointerRef.current === event.pointerId
      ) {
        finishInteraction();
      }
    },
    [finishInteraction],
  );

  // ==========================================================
  // 12 — KEYBOARD NAVIGATION
  // ==========================================================

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>): void => {
      if (
        !canInteract ||
        normalizedPosition === null ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey
      ) {
        return;
      }

      const step = event.shiftKey
        ? CROSSHAIR_KEYBOARD_FAST_STEP
        : CROSSHAIR_KEYBOARD_STEP;

      let deltaX = 0;
      let deltaY = 0;

      switch (event.key) {
        case "ArrowLeft":
          deltaX = -step;
          break;

        case "ArrowRight":
          deltaX = step;
          break;

        case "ArrowUp":
          deltaY = -step;
          break;

        case "ArrowDown":
          deltaY = step;
          break;

        default:
          return;
      }

      event.preventDefault();
      event.stopPropagation();

      emitMove(
        {
          x: clamp01(normalizedPosition.x + deltaX),
          y: clamp01(normalizedPosition.y + deltaY),
        },
        "keyboard",
      );
    },
    [
      canInteract,
      normalizedPosition,
      emitMove,
    ],
  );

  // ==========================================================
  // 13 — RENDER GUARD
  // ==========================================================

  if (!visible || normalizedPosition === null) {
    return null;
  }

  const left = `${normalizedPosition.x * 100}%`;
  const top = `${normalizedPosition.y * 100}%`;

  const handleSize = compact
    ? CROSSHAIR_COMPACT_HANDLE_SIZE
    : CROSSHAIR_HANDLE_SIZE;

  const accessiblePosition =
    `Crosshair position: ` +
    `${Math.round(normalizedPosition.x * 100)} percent horizontally, ` +
    `${Math.round(normalizedPosition.y * 100)} percent vertically.`;

  // ==========================================================
  // 14 — JSX
  // ==========================================================

  return (
    <div
      ref={overlayRef}
      className={className}
      style={overlayStyle}
      data-crosshair-overlay="true"
      data-crosshair-plane={plane}
      data-crosshair-interactive={
        canInteract ? "true" : "false"
      }
    >
      <div
        style={{
          ...verticalLineStyle,
          left,
          backgroundColor: color,
          boxShadow: `0 0 3px ${color}`,
        }}
        aria-hidden="true"
        data-crosshair-axis="vertical"
      />

      <div
        style={{
          ...horizontalLineStyle,
          top,
          backgroundColor: color,
          boxShadow: `0 0 3px ${color}`,
        }}
        aria-hidden="true"
        data-crosshair-axis="horizontal"
      />

      <div
        style={{
          ...centerMarkerStyle,
          left,
          top,
          backgroundColor: color,
        }}
        aria-hidden="true"
        data-crosshair-center="true"
      />

      {canInteract && (
        <button
          type="button"
          style={{
            ...handleStyle,
            left,
            top,
            width: handleSize,
            height: handleSize,
            pointerEvents: "auto",
            cursor: dragging
              ? "grabbing"
              : "grab",
          }}
          aria-label={`${plane} crosshair handle`}
          aria-description={
            "Drag to reposition. Use arrow keys " +
            "for small movements or Shift plus " +
            "arrow keys for larger movements."
          }
          aria-keyshortcuts={
            "ArrowLeft ArrowRight ArrowUp ArrowDown"
          }
          title="Drag to move crosshair"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerCancel}
          onLostPointerCapture={finishInteraction}
          onKeyDown={handleKeyDown}
          data-crosshair-handle="true"
        />
      )}

      <span style={positionTextStyle}>
        {accessiblePosition}
      </span>
    </div>
  );
}


// ============================================================
// 15 — CAPABILITIES
// ============================================================

export function getCrosshairOverlayCapabilities() {
  return {
    axialSupport: true,
    coronalSupport: true,
    sagittalSupport: true,
    horizontalLine: true,
    verticalLine: true,
    centerMarker: true,
    pointerDragging: true,
    pointerCapture: true,
    keyboardAdjustment: true,
    viewportBoundaryClamping: true,
    normalizedScreenCoordinates: true,
    parentSuppliedPatientMapping: true,
    finitePatientCoordinateValidation: true,
    controlledCrosshairPosition: true,
    readOnlyPresentationMode: true,
    automaticDICOMGeometryInference: false,
    directBackendRequests: false,
    browserPersistence: false,
    sourceDatasetModification: false,
    clinicalValidationComplete: false,
  } as const;
}


// ============================================================
// END OF SINUS VIEWER CROSSHAIR OVERLAY
// ============================================================
