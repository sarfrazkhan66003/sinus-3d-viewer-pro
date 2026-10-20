
/**
 * SINUS VIEWER — CONFIRMATION DIALOG
 * ==================================
 *
 * Reusable modal confirmation for in-memory UI actions.
 *
 * Features:
 * - Controlled open/close state.
 * - React portal to document.body.
 * - Keyboard focus trap.
 * - Initial focus on Cancel (safe default).
 * - Escape key cancellation.
 * - Focus restoration after closing.
 * - Async/sync confirmation callbacks.
 * - Protection against duplicate confirmation clicks.
 * - Loading and generic error states.
 * - Accessible dialog labels and descriptions.
 *
 * SECURITY:
 * - No original DICOM filesystem access.
 * - No direct network operations.
 * - No browser persistence.
 * - No logging of exceptions or patient information.
 * - Does not perform deletion or session invalidation.
 *
 * The parent owns the actual confirmed operation.
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

import {
  createPortal,
} from "react-dom";


// ============================================================
// 01 — PUBLIC TYPES
// ============================================================

export type ConfirmDialogIntent =
  | "default"
  | "warning"
  | "danger";

export type ConfirmDialogAction =
  | "clear-measurements"
  | "delete-measurement"
  | "close-viewer"
  | "sign-out"
  | "discard-changes"
  | "generic";

export interface ConfirmDialogProps {
  readonly open: boolean;
  readonly action: ConfirmDialogAction;

  readonly intent?: ConfirmDialogIntent;

  readonly disabled?: boolean;
  readonly className?: string;

  /**
   * Optional safe, application-owned title and message.
   * Do not pass patient names, DICOM identifiers,
   * filesystem paths or raw backend error messages.
   */
  readonly title?: string;
  readonly description?: string;

  readonly confirmLabel?: string;
  readonly cancelLabel?: string;

  readonly onConfirm: () => void | Promise<void>;
  readonly onCancel: () => void;

  /**
   * Called after confirmation succeeds.
   * The parent must set open=false.
   */
  readonly onConfirmed?: () => void;

  readonly children?: ReactNode;
}


// ============================================================
// 02 — CONSTANTS
// ============================================================

export const CONFIRM_DIALOG_MAX_TEXT_LENGTH = 240;

export const CONFIRM_DIALOG_MAX_LABEL_LENGTH = 48;

const CONFIRM_DIALOG_GENERIC_ERROR =
  "The action could not be completed. Please try again.";


// ============================================================
// 03 — SAFE ACTION TEXT
// ============================================================

interface ActionDescription {
  readonly title: string;
  readonly description: string;
  readonly confirm: string;
}

const ACTION_DESCRIPTIONS: Readonly<
  Record<ConfirmDialogAction, ActionDescription>
> = {
  "clear-measurements": {
    title: "Clear measurements?",
    description:
      "All current in-memory measurements will be cleared.",
    confirm: "Clear Measurements",
  },

  "delete-measurement": {
    title: "Delete measurement?",
    description:
      "The selected in-memory measurement will be removed.",
    confirm: "Delete Measurement",
  },

  "close-viewer": {
    title: "Close viewer?",
    description:
      "The current image viewer and its temporary state will be closed.",
    confirm: "Close Viewer",
  },

  "sign-out": {
    title: "Sign out?",
    description:
      "The current session will be closed by the application.",
    confirm: "Sign Out",
  },

  "discard-changes": {
    title: "Discard changes?",
    description:
      "Unsaved interface changes will be discarded.",
    confirm: "Discard Changes",
  },

  generic: {
    title: "Confirm action?",
    description:
      "Please confirm that you want to continue.",
    confirm: "Confirm",
  },
};


// ============================================================
// 04 — VALIDATION HELPERS
// ============================================================

function safeText(
  value: string | undefined,
  fallback: string,
  maximum: number,
): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maximum
  ) {
    return fallback;
  }

  // Application-owned UI strings only.
  // React handles text escaping, not PHI classification.
  return value;
}

function intentColor(
  intent: ConfirmDialogIntent,
): string {
  switch (intent) {
    case "danger":
      return "#b91c1c";

    case "warning":
      return "#92400e";

    case "default":
      return "#0f766e";
  }
}


// ============================================================
// 05 — FOCUSABLE ELEMENT DISCOVERY
// ============================================================

const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(", ");

function getFocusableElements(
  container: HTMLElement,
): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      FOCUSABLE_SELECTOR,
    ),
  ).filter((element) => {
    return (
      !element.hasAttribute("hidden") &&
      element.getAttribute("aria-hidden") !== "true" &&
      element.getClientRects().length > 0
    );
  });
}


// ============================================================
// 06 — STYLES
// ============================================================

const backdropStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 10000,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 16,
  backgroundColor: "rgba(2, 6, 23, 0.82)",
};

const dialogStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 14,
  width: "100%",
  maxWidth: 440,
  maxHeight: "min(90vh, 720px)",
  overflowY: "auto",
  boxSizing: "border-box",
  border: "1px solid #344258",
  borderRadius: 10,
  padding: 20,
  backgroundColor: "#101827",
  color: "#e2e8f0",
  boxShadow: "0 18px 55px rgba(0,0,0,0.55)",
};

const actionRowStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  justifyContent: "flex-end",
  gap: 8,
};

const buttonStyle: CSSProperties = {
  minHeight: 36,
  padding: "8px 14px",
  border: "1px solid #344258",
  borderRadius: 5,
  backgroundColor: "#192437",
  color: "#f8fafc",
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
};

const errorStyle: CSSProperties = {
  padding: 9,
  borderRadius: 5,
  border: "1px solid #7f1d1d",
  backgroundColor: "#450a0a",
  color: "#fecaca",
  fontSize: 12,
};


// ============================================================
// 07 — MAIN COMPONENT
// ============================================================

export function ConfirmDialog({
  open,
  action,
  intent = "warning",
  disabled = false,
  className = "",
  title,
  description,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel,
  onConfirmed,
  children,
}: ConfirmDialogProps) {
  const titleId = useId();
  const descriptionId = useId();

  const dialogRef = useRef<HTMLDivElement | null>(
    null,
  );

  const cancelButtonRef = useRef<HTMLButtonElement | null>(
    null,
  );

  const previousFocusRef = useRef<HTMLElement | null>(
    null,
  );

  const pendingRef = useRef(false);
  const mountedRef = useRef(true);

  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(
    null,
  );

  const actionText =
    ACTION_DESCRIPTIONS[action] ??
    ACTION_DESCRIPTIONS.generic;

  const displayTitle = safeText(
    title,
    actionText.title,
    CONFIRM_DIALOG_MAX_TEXT_LENGTH,
  );

  const displayDescription = safeText(
    description,
    actionText.description,
    CONFIRM_DIALOG_MAX_TEXT_LENGTH,
  );

  const displayConfirmLabel = safeText(
    confirmLabel,
    actionText.confirm,
    CONFIRM_DIALOG_MAX_LABEL_LENGTH,
  );

  const displayCancelLabel = safeText(
    cancelLabel,
    "Cancel",
    CONFIRM_DIALOG_MAX_LABEL_LENGTH,
  );

  const isBusy = confirming || disabled;
  const accentColor = intentColor(intent);

  // ==========================================================
  // 08 — COMPONENT LIFECYCLE
  // ==========================================================

  useEffect(() => {
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;
    };
  }, []);

  // ==========================================================
  // 09 — OPEN / CLOSE FOCUS MANAGEMENT
  // ==========================================================

  useEffect(() => {
    if (!open || typeof document === "undefined") {
      return;
    }

    const active = document.activeElement;

    previousFocusRef.current =
      active instanceof HTMLElement
        ? active
        : null;

    setError(null);
    setConfirming(false);
    pendingRef.current = false;

    cancelButtonRef.current?.focus();

    /**
     * Use focusin to keep keyboard or programmatic
     * focus within the modal while it is open.
     */
    const handleFocusIn = (event: FocusEvent): void => {
      const dialog = dialogRef.current;

      if (
        !dialog ||
        dialog.contains(event.target as Node)
      ) {
        return;
      }

      const firstFocusable =
        getFocusableElements(dialog)[0];

      (firstFocusable ?? dialog).focus();
    };

    document.addEventListener(
      "focusin",
      handleFocusIn,
    );

    return () => {
      document.removeEventListener(
        "focusin",
        handleFocusIn,
      );

      pendingRef.current = false;

      const previous = previousFocusRef.current;

      if (previous?.isConnected) {
        previous.focus();
      }

      previousFocusRef.current = null;
    };
  }, [open]);

  // ==========================================================
  // 10 — CANCEL ACTION
  // ==========================================================

  const handleCancel = useCallback((): void => {
    if (isBusy || pendingRef.current) {
      return;
    }

    setError(null);
    onCancel();
  }, [isBusy, onCancel]);

  // ==========================================================
  // 11 — CONFIRM ACTION
  // ==========================================================

  const handleConfirm = useCallback(
    async (): Promise<void> => {
      if (isBusy || pendingRef.current) {
        return;
      }

      pendingRef.current = true;
      setConfirming(true);
      setError(null);

      try {
        await onConfirm();

        if (mountedRef.current) {
          onConfirmed?.();
        }
      } catch {
        if (mountedRef.current) {
          setError(CONFIRM_DIALOG_GENERIC_ERROR);
        }
      } finally {
        pendingRef.current = false;

        if (mountedRef.current) {
          setConfirming(false);
        }
      }
    },
    [isBusy, onConfirm, onConfirmed],
  );

  // ==========================================================
  // 12 — KEYBOARD NAVIGATION
  // ==========================================================

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        handleCancel();
        return;
      }

      if (event.key !== "Tab") {
        return;
      }

      const dialog = dialogRef.current;

      if (!dialog) {
        return;
      }

      const focusables = getFocusableElements(
        dialog,
      );

      if (focusables.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }

      const first = focusables[0];
      const last = focusables[
        focusables.length - 1
      ];

      const active = document.activeElement;

      if (event.shiftKey) {
        if (
          active === first ||
          !dialog.contains(active)
        ) {
          event.preventDefault();
          last.focus();
        }
      } else if (
        active === last ||
        !dialog.contains(active)
      ) {
        event.preventDefault();
        first.focus();
      }
    },
    [handleCancel],
  );

  // ==========================================================
  // 13 — CLOSED STATE
  // ==========================================================

  if (!open || typeof document === "undefined") {
    return null;
  }

  // ==========================================================
  // 14 — MODAL JSX
  // ==========================================================

  return createPortal(
    <div
      style={backdropStyle}
      data-confirm-dialog-backdrop="true"
    >
      <div
        ref={dialogRef}
        className={className}
        style={dialogStyle}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        data-confirm-dialog="true"
        data-confirm-action={action}
        aria-busy={confirming}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
          }}
        >
          <span
            aria-hidden="true"
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 32,
              height: 32,
              flexShrink: 0,
              borderRadius: "50%",
              border: `1px solid ${accentColor}`,
              color: "#f8fafc",
              fontWeight: 700,
            }}
          >
            !
          </span>

          <h2
            id={titleId}
            style={{
              margin: 0,
              fontSize: 17,
              color: "#f8fafc",
            }}
          >
            {displayTitle}
          </h2>
        </div>

        <p
          id={descriptionId}
          style={{
            margin: 0,
            color: "#cbd5e1",
            fontSize: 13,
            lineHeight: 1.6,
          }}
        >
          {displayDescription}
        </p>

        {children && (
          <div
            style={{
              color: "#94a3b8",
              fontSize: 12,
            }}
          >
            {children}
          </div>
        )}

        {error && (
          <div
            role="alert"
            style={errorStyle}
          >
            {error}
          </div>
        )}

        <div style={actionRowStyle}>
          <button
            ref={cancelButtonRef}
            type="button"
            style={buttonStyle}
            disabled={isBusy}
            onClick={handleCancel}
          >
            {displayCancelLabel}
          </button>

          <button
            type="button"
            disabled={isBusy}
            onClick={() => {
              void handleConfirm();
            }}
            style={{
              ...buttonStyle,
              backgroundColor: accentColor,
              borderColor: accentColor,
              opacity: isBusy ? 0.6 : 1,
              cursor: isBusy
                ? "not-allowed"
                : "pointer",
            }}
          >
            {confirming
              ? "Processing…"
              : displayConfirmLabel}
          </button>
        </div>

        <p
          style={{
            margin: 0,
            color: "#94a3b8",
            fontSize: 11,
            lineHeight: 1.5,
          }}
        >
          This confirmation does not modify
          original CT/CBCT DICOM files.
        </p>
      </div>
    </div>,
    document.body,
  );
}


// ============================================================
// 15 — COMPONENT CAPABILITIES
// ============================================================

export function getConfirmDialogCapabilities() {
  return {
    controlledVisibility: true,
    modalPortal: true,
    initialCancelFocus: true,
    keyboardFocusTrap: true,
    escapeKeyCancellation: true,
    focusRestoration: true,
    asynchronousConfirmation: true,
    duplicateClickProtection: true,
    genericErrorPresentation: true,
    parentOwnedActions: true,
    accessibleDialog: true,
    directDICOMDeletion: false,
    directBackendRequests: false,
    browserPersistence: false,
    patientIdentifiersDisplayed: false,
    sourceDatasetModification: false,
  } as const;
}


// ============================================================
// END OF SINUS VIEWER CONFIRMATION DIALOG
// ============================================================
