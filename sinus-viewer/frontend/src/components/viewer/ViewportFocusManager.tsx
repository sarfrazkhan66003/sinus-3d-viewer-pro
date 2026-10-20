
/**
 * SINUS VIEWER — VIEWPORT FOCUS MANAGER
 * =====================================
 *
 * Controlled focus and active-plane coordination
 * for one axial, coronal or sagittal MPR viewport.
 *
 * Parent renders one instance for each plane.
 *
 * Features:
 * - Pointer-based viewport activation.
 * - Keyboard focus-based activation.
 * - Controlled active-plane indication.
 * - Optional programmatic focus requests.
 * - Focus restoration to viewport root.
 * - Disabled / loading / unauthorized guards.
 * - Accessible active viewport labels.
 *
 * IMPORTANT:
 * - Parent is the source of truth for activePlane.
 * - This component does not own slice/zoom state.
 * - It does not call DICOM or image services.
 * - It does not install global key listeners.
 * - It does not store patient identifiers.
 * - Backend authorization is enforced separately.
 */

import {
  useCallback,
  useEffect,
  useRef,
  type CSSProperties,
  type FocusEvent,
  type PointerEvent,
  type ReactNode,
} from "react";

// ============================================================
// 01 — PUBLIC TYPES
// ============================================================

export type ViewportFocusPlane =
  | "axial"
  | "coronal"
  | "sagittal";

export type ViewportFocusActivationSource =
  | "pointer"
  | "keyboard-focus"
  | "programmatic";

export interface ViewportFocusActivation {
  readonly plane: ViewportFocusPlane;
  readonly source: ViewportFocusActivationSource;
}

export interface ViewportFocusManagerProps {
  readonly plane: ViewportFocusPlane;

  /**
   * Controlled state from the MPR workspace.
   */
  readonly active: boolean;

  /**
   * Parent-owned current-session permission.
   * UI checking does not replace backend auth.
   */
  readonly authorized: boolean;

  readonly enabled?: boolean;
  readonly loading?: boolean;

  readonly children: ReactNode;

  /**
   * Called only when an eligible inactive viewport
   * receives an activation interaction.
   */
  readonly onActivate: (
    activation: ViewportFocusActivation,
  ) => void;

  /**
   * Increment to request focus on this viewport.
   *
   * A request is applied only when the viewport is
   * authorized, enabled and not loading.
   *
   * Optional; omit for pointer/focus-only behavior.
   */
  readonly focusRequestVersion?: number;

  /**
   * Return focus to the viewport root rather than
   * selecting a child toolbar or menu control.
   */
  readonly onRootFocus?: (
    plane: ViewportFocusPlane,
  ) => void;

  readonly showActiveOutline?: boolean;
  readonly className?: string;
  readonly style?: CSSProperties;
}

export interface ViewportFocusAvailability {
  readonly authorized: boolean;
  readonly enabled: boolean;
  readonly loading: boolean;
}

// ============================================================
// 02 — PURE HELPERS
// ============================================================

export function viewportFocusPlaneLabel(
  plane: ViewportFocusPlane,
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

export function canFocusViewport(
  availability: ViewportFocusAvailability,
): boolean {
  return (
    availability.authorized === true &&
    availability.enabled === true &&
    availability.loading === false
  );
}

export function shouldActivateViewport(
  active: boolean,
  availability: ViewportFocusAvailability,
): boolean {
  return (
    active !== true &&
    canFocusViewport(availability)
  );
}

export function validViewportFocusRequest(
  value: number | undefined,
): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
  );
}

// ============================================================
// 03 — STYLES
// ============================================================

const rootStyle: CSSProperties = {
  position: "relative",
  width: "100%",
  height: "100%",
  minWidth: 0,
  minHeight: 0,
  boxSizing: "border-box",
  outlineOffset: -3,
};

const activeOutlineStyle: CSSProperties = {
  outline: "2px solid #38bdf8",
};

const inactiveOutlineStyle: CSSProperties = {
  outline: "2px solid transparent",
};

// ============================================================
// 04 — MAIN COMPONENT
// ============================================================

export function ViewportFocusManager({
  plane,
  active,
  authorized,
  enabled = true,
  loading = false,
  children,
  onActivate,
  focusRequestVersion,
  onRootFocus,
  showActiveOutline = true,
  className = "",
  style,
}: ViewportFocusManagerProps) {
  const rootRef = useRef<HTMLDivElement>(null);

  /**
   * Tracks the last programmatic focus request.
   *
   * An initial numeric token is treated as the
   * baseline, not as an automatic focus request.
   * Future changes trigger requests.
   */
  const lastRequestRef = useRef<
    number | undefined
  >(focusRequestVersion);

  const availability: ViewportFocusAvailability = {
    authorized,
    enabled,
    loading,
  };

  const available = canFocusViewport(availability);

  // ==========================================================
  // 05 — POINTER ACTIVATION
  // ==========================================================

  const handlePointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>): void => {
      if (!available) {
        return;
      }

      /**
       * Only primary pointer/left mouse activation.
       *
       * Right-click is reserved for the viewport
       * context menu. It must not unexpectedly
       * change the active MPR plane.
       */
      if (
        !event.isPrimary ||
        event.button !== 0
      ) {
        return;
      }

      if (!active) {
        onActivate({
          plane,
          source: "pointer",
        });
      }

      /**
       * Do not call preventDefault here.
       *
       * Canvas mouse interaction, buttons,
       * sliders and pointer events must continue.
       */
    },
    [available, active, onActivate, plane],
  );

  // ==========================================================
  // 06 — FOCUS ACTIVATION
  // ==========================================================

  const handleFocusCapture = useCallback(
    (event: FocusEvent<HTMLDivElement>): void => {
      if (!available) {
        return;
      }

      if (!active) {
        onActivate({
          plane,
          source: "keyboard-focus",
        });
      }

      /**
       * Parent can distinguish root focus from
       * focus on nested toolbar/menu controls.
       */
      if (event.target === rootRef.current) {
        onRootFocus?.(plane);
      }
    },
    [
      available,
      active,
      onActivate,
      onRootFocus,
      plane,
    ],
  );

  // ==========================================================
  // 07 — PROGRAMMATIC FOCUS REQUEST
  // ==========================================================

  useEffect(() => {
    if (!validViewportFocusRequest(
      focusRequestVersion,
    )) {
      return;
    }

    const previous =
      lastRequestRef.current;

    lastRequestRef.current =
      focusRequestVersion;

    // Do not steal focus on the initial mount.
    if (previous === undefined) {
      return;
    }

    if (
      previous === focusRequestVersion ||
      !available
    ) {
      return;
    }

    const element = rootRef.current;

    if (!element) {
      return;
    }

    element.focus({
      preventScroll: true,
    });

    /**
     * Focus capture can activate an inactive plane.
     * Dispatch explicitly only when focus did not
     * enter this viewport (e.g. browser refused).
     */
    if (
      !active &&
      document.activeElement !== element &&
      !element.contains(document.activeElement)
    ) {
      onActivate({
        plane,
        source: "programmatic",
      });
    }
  }, [
    focusRequestVersion,
    available,
    active,
    onActivate,
    plane,
  ]);

  // ==========================================================
  // 08 — DISPLAY
  // ==========================================================

  const planeLabel =
    viewportFocusPlaneLabel(plane);

  const statusDescription = !authorized
    ? "access unavailable"
    : !enabled
      ? "disabled"
      : loading
        ? "loading"
        : active
          ? "active"
          : "inactive";

  return (
    <div
      ref={rootRef}
      className={className}
      style={{
        ...rootStyle,
        ...(showActiveOutline
          ? activeOutlineStyle
          : inactiveOutlineStyle),
        ...(showActiveOutline && !active
          ? inactiveOutlineStyle
          : {}),
        ...style,
      }}
      tabIndex={available ? 0 : -1}
      role="region"
      aria-label={
        `${planeLabel} viewport, ${statusDescription}`
      }
      data-viewport-focus-manager="true"
      data-focus-plane={plane}
      data-focus-active={
        active ? "true" : "false"
      }
      data-focus-available={
        available ? "true" : "false"
      }
      onPointerDown={handlePointerDown}
      onFocusCapture={handleFocusCapture}
    >
      {children}
    </div>
  );
}

// ============================================================
// 09 — CAPABILITIES
// ============================================================

export function getViewportFocusManagerCapabilities() {
  return {
    axialSupport: true,
    coronalSupport: true,
    sagittalSupport: true,
    controlledActiveState: true,
    pointerActivation: true,
    keyboardFocusActivation: true,
    programmaticFocusRequests: true,
    preventsInitialFocusStealing: true,
    rootFocusCallback: true,
    primaryPointerFiltering: true,
    rightClickPreserved: true,
    authorizationGate: true,
    loadingGate: true,
    disabledGate: true,
    accessibleViewportRegion: true,
    activeOutline: true,
    parentOwnedKeyboardCommands: true,
    globalKeyboardListeners: false,
    backendAuthorizationEnforcement: false,
    directDICOMAccess: false,
    directNetworkRequests: false,
    browserPersistence: false,
    patientMetadataAccess: false,
    originalDatasetModification: false,
    clinicalValidationComplete: false,
  } as const;
}

// ============================================================
// END OF SINUS VIEWER VIEWPORT FOCUS MANAGER
// ============================================================
