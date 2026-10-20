
/**
 * SINUS VIEWER — TOAST NOTIFICATION SYSTEM
 * ========================================
 *
 * Reusable in-memory notifications for:
 * - Success
 * - Information
 * - Warning
 * - Error
 *
 * Features:
 * - React context and useToast() hook.
 * - Predefined, non-identifying message catalog.
 * - Multiple simultaneous notifications.
 * - Automatic dismissal using bounded durations.
 * - Manual dismissal.
 * - Maximum visible notification limit.
 * - Accessible status and alert announcements.
 * - Compact responsive presentation.
 * - Reduced-motion CSS.
 *
 * PRIVACY:
 * - No arbitrary backend error messages.
 * - No patient identifiers, DICOM UIDs or paths.
 * - No persistent storage or network requests.
 * - No original DICOM filesystem operations.
 *
 * The parent application owns the underlying actions.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";


// ============================================================
// 01 — PUBLIC TYPES
// ============================================================

export type ToastVariant =
  | "success"
  | "info"
  | "warning"
  | "error";

export type ToastMessageKey =
  | "dataset-loaded"
  | "dataset-empty"
  | "series-selected"
  | "series-unavailable"
  | "series-validation-failed"
  | "preview-loaded"
  | "preview-failed"
  | "volume-loaded"
  | "volume-failed"
  | "measurement-created"
  | "measurement-removed"
  | "measurements-cleared"
  | "operation-cancelled"
  | "operation-failed"
  | "connection-restored"
  | "connection-lost"
  | "authentication-required"
  | "settings-reset";

export interface ToastNotification {
  readonly id: number;
  readonly messageKey: ToastMessageKey;
  readonly variant: ToastVariant;
  readonly durationMs: number;
}

export interface ToastContextValue {
  readonly notifications: readonly ToastNotification[];

  readonly notify: (
    messageKey: ToastMessageKey,
    variant?: ToastVariant,
  ) => number;

  readonly dismiss: (id: number) => void;

  readonly dismissAll: () => void;
}

export interface ToastProviderProps {
  readonly children: ReactNode;
  readonly maxVisible?: number;
  readonly compact?: boolean;
}

export interface ToastViewportProps {
  readonly notifications: readonly ToastNotification[];
  readonly onDismiss: (id: number) => void;
  readonly compact?: boolean;
}


// ============================================================
// 02 — CONSTANTS
// ============================================================

export const TOAST_DEFAULT_DURATION_MS = 4500;
export const TOAST_ERROR_DURATION_MS = 7000;
export const TOAST_WARNING_DURATION_MS = 6000;

export const TOAST_MAX_VISIBLE = 5;
export const TOAST_MAX_ALLOWED_VISIBLE = 10;


// ============================================================
// 03 — SAFE MESSAGE CATALOG
// ============================================================

interface ToastMessageDefinition {
  readonly text: string;
  readonly defaultVariant: ToastVariant;
}

export const TOAST_MESSAGES: Readonly<
  Record<ToastMessageKey, ToastMessageDefinition>
> = {
  "dataset-loaded": {
    text: "Authorized datasets loaded.",
    defaultVariant: "success",
  },
  "dataset-empty": {
    text: "No authorized datasets are available.",
    defaultVariant: "info",
  },
  "series-selected": {
    text: "Imaging series selected.",
    defaultVariant: "info",
  },
  "series-unavailable": {
    text: "The imaging series is unavailable.",
    defaultVariant: "warning",
  },
  "series-validation-failed": {
    text: "The imaging series could not be validated.",
    defaultVariant: "error",
  },
  "preview-loaded": {
    text: "Image previews are ready.",
    defaultVariant: "success",
  },
  "preview-failed": {
    text: "Image previews could not be loaded.",
    defaultVariant: "error",
  },
  "volume-loaded": {
    text: "The imaging volume is ready.",
    defaultVariant: "success",
  },
  "volume-failed": {
    text: "The imaging volume could not be opened.",
    defaultVariant: "error",
  },
  "measurement-created": {
    text: "Measurement added.",
    defaultVariant: "success",
  },
  "measurement-removed": {
    text: "Measurement removed.",
    defaultVariant: "info",
  },
  "measurements-cleared": {
    text: "Current measurements cleared.",
    defaultVariant: "info",
  },
  "operation-cancelled": {
    text: "Operation cancelled.",
    defaultVariant: "info",
  },
  "operation-failed": {
    text: "The requested operation was unsuccessful.",
    defaultVariant: "error",
  },
  "connection-restored": {
    text: "Backend connection restored.",
    defaultVariant: "success",
  },
  "connection-lost": {
    text: "Backend connection unavailable.",
    defaultVariant: "warning",
  },
  "authentication-required": {
    text: "Authentication is required.",
    defaultVariant: "warning",
  },
  "settings-reset": {
    text: "Display settings restored.",
    defaultVariant: "info",
  },
};


// ============================================================
// 04 — VALIDATION AND PRESENTATION HELPERS
// ============================================================

export function getToastDuration(
  variant: ToastVariant,
): number {
  switch (variant) {
    case "error":
      return TOAST_ERROR_DURATION_MS;
    case "warning":
      return TOAST_WARNING_DURATION_MS;
    case "success":
    case "info":
      return TOAST_DEFAULT_DURATION_MS;
  }
}

function safeMaximum(value: number): number {
  if (!Number.isFinite(value)) {
    return TOAST_MAX_VISIBLE;
  }

  return Math.max(
    1,
    Math.min(
      TOAST_MAX_ALLOWED_VISIBLE,
      Math.floor(value),
    ),
  );
}

function toastAccent(variant: ToastVariant): string {
  switch (variant) {
    case "success":
      return "#34d399";
    case "info":
      return "#38bdf8";
    case "warning":
      return "#fbbf24";
    case "error":
      return "#f87171";
  }
}

function toastSymbol(variant: ToastVariant): string {
  switch (variant) {
    case "success":
      return "✓";
    case "info":
      return "i";
    case "warning":
      return "!";
    case "error":
      return "×";
  }
}


// ============================================================
// 05 — CONTEXT
// ============================================================

const ToastContext = createContext<
  ToastContextValue | null
>(null);

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);

  if (context === null) {
    throw new Error(
      "ToastProvider is required for useToast.",
    );
  }

  return context;
}


// ============================================================
// 06 — STYLES
// ============================================================

const viewportStyle: CSSProperties = {
  position: "fixed",
  right: 16,
  bottom: 16,
  zIndex: 11000,
  width: "min(380px, calc(100vw - 32px))",
  display: "flex",
  flexDirection: "column",
  alignItems: "stretch",
  gap: 9,
  pointerEvents: "none",
};

const toastStyle: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 10,
  padding: "11px 12px",
  minWidth: 0,
  boxSizing: "border-box",
  color: "#f8fafc",
  backgroundColor: "#101827",
  border: "1px solid #344258",
  borderRadius: 8,
  boxShadow: "0 10px 28px rgba(0,0,0,0.4)",
  pointerEvents: "auto",
};

const closeButtonStyle: CSSProperties = {
  flexShrink: 0,
  border: "1px solid #344258",
  borderRadius: 4,
  backgroundColor: "#192437",
  color: "#f8fafc",
  minWidth: 28,
  minHeight: 28,
  cursor: "pointer",
  fontSize: 16,
};

const ANIMATION_CSS = `
  @keyframes sinus-viewer-toast-enter {
    from {
      opacity: 0;
      transform: translateY(10px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  .sinus-viewer-toast-item {
    animation: sinus-viewer-toast-enter 180ms ease-out both;
  }

  @media (prefers-reduced-motion: reduce) {
    .sinus-viewer-toast-item {
      animation: none !important;
    }
  }
`;


// ============================================================
// 07 — INDIVIDUAL TOAST
// ============================================================

interface ToastItemProps {
  readonly notification: ToastNotification;
  readonly onDismiss: (id: number) => void;
  readonly compact: boolean;
}

function ToastItem({
  notification,
  onDismiss,
  compact,
}: ToastItemProps) {
  const { id, messageKey, variant, durationMs } =
    notification;

  /**
   * Timer belongs to this mounted item. It is
   * automatically cleaned up if the item disappears
   * or the provider unmounts.
   */
  useEffect(() => {
    const timer = window.setTimeout(() => {
      onDismiss(id);
    }, durationMs);

    return () => window.clearTimeout(timer);
  }, [durationMs, id, onDismiss]);

  const message =
    TOAST_MESSAGES[messageKey]?.text ??
    TOAST_MESSAGES["operation-failed"].text;

  const accent = toastAccent(variant);

  const close = useCallback((): void => {
    onDismiss(id);
  }, [id, onDismiss]);

  return (
    <div
      className="sinus-viewer-toast-item"
      style={{
        ...toastStyle,
        padding: compact ? "8px 9px" : "11px 12px",
        borderLeft: `3px solid ${accent}`,
      }}
      role={variant === "error" ? "alert" : "status"}
      aria-live={
        variant === "error" ? "assertive" : "polite"
      }
      aria-atomic="true"
      data-toast-variant={variant}
      data-toast-message={messageKey}
    >
      <span
        aria-hidden="true"
        style={{
          width: 22,
          height: 22,
          borderRadius: "50%",
          flexShrink: 0,
          display: "inline-flex",
          justifyContent: "center",
          alignItems: "center",
          color: accent,
          border: `1px solid ${accent}`,
          fontSize: 13,
          fontWeight: 700,
        }}
      >
        {toastSymbol(variant)}
      </span>

      <div
        style={{
          flex: 1,
          minWidth: 0,
          fontSize: 12,
          lineHeight: 1.5,
          overflowWrap: "anywhere",
          paddingTop: 2,
        }}
      >
        {message}
      </div>

      <button
        type="button"
        style={closeButtonStyle}
        onClick={close}
        aria-label="Dismiss notification"
        title="Dismiss notification"
      >
        ×
      </button>
    </div>
  );
}


// ============================================================
// 08 — TOAST VIEWPORT
// ============================================================

export function ToastViewport({
  notifications,
  onDismiss,
  compact = false,
}: ToastViewportProps) {
  if (notifications.length === 0) {
    return null;
  }

  return (
    <aside
      style={{
        ...viewportStyle,
        right: compact ? 8 : 16,
        bottom: compact ? 8 : 16,
        width: compact
          ? "min(340px, calc(100vw - 16px))"
          : viewportStyle.width,
      }}
      aria-label="Application notifications"
      data-toast-viewport="true"
    >
      <style>{ANIMATION_CSS}</style>

      {notifications.map((notification) => (
        <ToastItem
          key={notification.id}
          notification={notification}
          onDismiss={onDismiss}
          compact={compact}
        />
      ))}
    </aside>
  );
}


// ============================================================
// 09 — TOAST PROVIDER
// ============================================================

export function ToastProvider({
  children,
  maxVisible = TOAST_MAX_VISIBLE,
  compact = false,
}: ToastProviderProps) {
  const [notifications, setNotifications] = useState<
    readonly ToastNotification[]
  >([]);

  const nextIdRef = useRef(0);

  const limit = safeMaximum(maxVisible);

  // ==========================================================
  // 10 — DISMISS ONE / ALL
  // ==========================================================

  const dismiss = useCallback((id: number): void => {
    setNotifications((previous) =>
      previous.filter((item) => item.id !== id),
    );
  }, []);

  const dismissAll = useCallback((): void => {
    setNotifications([]);
  }, []);

  // ==========================================================
  // 11 — NOTIFY
  // ==========================================================

  const notify = useCallback(
    (
      messageKey: ToastMessageKey,
      variant?: ToastVariant,
    ): number => {
      /**
       * Runtime validation matters because TypeScript
       * types alone do not validate external callers.
       */
      const definition = TOAST_MESSAGES[messageKey];

      if (!definition) {
        return -1;
      }

      const resolvedVariant =
        variant === "success" ||
        variant === "info" ||
        variant === "warning" ||
        variant === "error"
          ? variant
          : definition.defaultVariant;

      const id = ++nextIdRef.current;

      const notification: ToastNotification = {
        id,
        messageKey,
        variant: resolvedVariant,
        durationMs: getToastDuration(resolvedVariant),
      };

      setNotifications((previous) => [
        ...previous.slice(-(limit - 1)),
        notification,
      ]);

      return id;
    },
    [limit],
  );

  // ==========================================================
  // 12 — CONTEXT VALUE
  // ==========================================================

  const value = useMemo<ToastContextValue>(
    () => ({
      notifications,
      notify,
      dismiss,
      dismissAll,
    }),
    [notifications, notify, dismiss, dismissAll],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}

      <ToastViewport
        notifications={notifications}
        onDismiss={dismiss}
        compact={compact}
      />
    </ToastContext.Provider>
  );
}


// ============================================================
// 13 — CAPABILITIES
// ============================================================

export function getToastCapabilities() {
  return {
    successNotifications: true,
    informationNotifications: true,
    warningNotifications: true,
    errorNotifications: true,
    predefinedSafeMessages: true,
    notificationQueue: true,
    automaticDismissal: true,
    manualDismissal: true,
    dismissAll: true,
    boundedVisibleCount: true,
    reactContext: true,
    accessibleAnnouncements: true,
    reducedMotionSupport: true,
    rawBackendMessages: false,
    browserPersistence: false,
    directNetworkRequests: false,
    originalDICOMAccess: false,
    modifiesSourceDataset: false,
  } as const;
}


// ============================================================
// END OF SINUS VIEWER TOAST SYSTEM
// ============================================================
