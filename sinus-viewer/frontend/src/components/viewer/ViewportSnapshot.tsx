
/**
 * SINUS VIEWER — VIEWPORT SNAPSHOT
 * =================================
 *
 * Controlled PNG snapshot export.
 *
 * Features:
 * - Axial, coronal and sagittal support.
 * - Explicit user-triggered export.
 * - Parent-owned capture and authorization.
 * - PNG Blob validation.
 * - Size-limited export.
 * - Safe filename generation.
 * - Temporary object URL cleanup.
 * - Loading and error states.
 * - Optional success callback.
 *
 * PRIVACY:
 * - No patient names, identifiers, UIDs or paths.
 * - No automatic export or background capture.
 * - No browser persistence.
 * - No image metadata is intentionally attached.
 *
 * IMPORTANT:
 * The parent must ensure that its capture function
 * excludes all patient-identifying overlays.
 *
 * PNG output can still contain sensitive anatomy.
 * This UI is not a replacement for backend access
 * control or a clinical anonymization procedure.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";

// ============================================================
// 01 — PUBLIC TYPES
// ============================================================

export type ViewportSnapshotPlane =
  | "axial"
  | "coronal"
  | "sagittal";

export type ViewportSnapshotStatus =
  | "idle"
  | "capturing"
  | "completed"
  | "error";

export type ViewportSnapshotError =
  | "not-authorized"
  | "capture-failed"
  | "invalid-image"
  | "image-too-large"
  | "download-failed";

export interface ViewportSnapshotCaptureRequest {
  readonly plane: ViewportSnapshotPlane;

  /**
   * Parent must verify current-session authorization
   * and remove identifying visual overlays.
   */
  readonly excludePatientIdentifiers: true;

  /**
   * Capture the rendered MPR viewport only.
   */
  readonly format: "image/png";
}

export type ViewportSnapshotCapture = (
  request: ViewportSnapshotCaptureRequest,
) => Promise<Blob>;

export interface ViewportSnapshotProps {
  readonly plane: ViewportSnapshotPlane;

  /**
   * Whether parent permits current viewport export.
   * Must reflect actual session authorization.
   */
  readonly authorized: boolean;

  readonly capture: ViewportSnapshotCapture;

  readonly disabled?: boolean;
  readonly loading?: boolean;
  readonly compact?: boolean;

  readonly maxSizeBytes?: number;

  readonly onComplete?: (
    plane: ViewportSnapshotPlane,
  ) => void;

  readonly onError?: (
    error: ViewportSnapshotError,
    plane: ViewportSnapshotPlane,
  ) => void;

  readonly className?: string;
}

// ============================================================
// 02 — CONSTANTS
// ============================================================

export const SNAPSHOT_MIME_TYPE = "image/png";

export const SNAPSHOT_DEFAULT_MAX_SIZE_BYTES =
  25 * 1024 * 1024;

export const SNAPSHOT_ABSOLUTE_MAX_SIZE_BYTES =
  100 * 1024 * 1024;

export const SNAPSHOT_FILENAME_PREFIX =
  "sinus-viewer";

const PNG_SIGNATURE = [
  137, 80, 78, 71, 13, 10, 26, 10,
] as const;

// ============================================================
// 03 — SAFE HELPERS
// ============================================================

export function snapshotPlaneLabel(
  plane: ViewportSnapshotPlane,
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

export function normalizeSnapshotSizeLimit(
  value: number,
): number {
  if (
    !Number.isSafeInteger(value) ||
    value <= 0
  ) {
    return SNAPSHOT_DEFAULT_MAX_SIZE_BYTES;
  }

  return Math.min(
    value,
    SNAPSHOT_ABSOLUTE_MAX_SIZE_BYTES,
  );
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * Filename contains only application identifier,
 * plane and local export timestamp.
 *
 * No patient-derived values are accepted.
 */
export function createSnapshotFilename(
  plane: ViewportSnapshotPlane,
  date: Date = new Date(),
): string {
  const safePlane =
    plane === "axial" ||
    plane === "coronal" ||
    plane === "sagittal"
      ? plane
      : "view";

  const validDate =
    Number.isFinite(date.getTime())
      ? date
      : new Date(0);

  const timestamp = [
    validDate.getFullYear(),
    pad2(validDate.getMonth() + 1),
    pad2(validDate.getDate()),
  ].join("");

  const time = [
    pad2(validDate.getHours()),
    pad2(validDate.getMinutes()),
    pad2(validDate.getSeconds()),
  ].join("");

  return (
    `${SNAPSHOT_FILENAME_PREFIX}_` +
    `${safePlane}_${timestamp}_${time}.png`
  );
}

/**
 * Checks basic Blob properties.
 * This does not guarantee a decodable PNG.
 */
export function isValidSnapshotBlob(
  value: unknown,
  maxSizeBytes: number,
): value is Blob {
  if (
    typeof Blob === "undefined" ||
    !(value instanceof Blob)
  ) {
    return false;
  }

  const limit =
    normalizeSnapshotSizeLimit(maxSizeBytes);

  return (
    value.type.toLowerCase() ===
      SNAPSHOT_MIME_TYPE &&
    value.size >= PNG_SIGNATURE.length &&
    value.size <= limit
  );
}

/**
 * Verify the PNG magic signature, without reading
 * or retaining the entire image in JS memory.
 */
export async function hasPNGSignature(
  blob: Blob,
): Promise<boolean> {
  try {
    const bytes = new Uint8Array(
      await blob.slice(
        0,
        PNG_SIGNATURE.length,
      ).arrayBuffer(),
    );

    return PNG_SIGNATURE.every(
      (value, index) => bytes[index] === value,
    );
  } catch {
    return false;
  }
}

// ============================================================
// 04 — FIXED STATUS MESSAGES
// ============================================================

const STATUS_MESSAGES: Readonly<
  Record<ViewportSnapshotStatus, string>
> = {
  idle: "Export PNG snapshot",
  capturing: "Preparing snapshot…",
  completed: "Snapshot download initiated",
  error: "Snapshot could not be exported",
};

// ============================================================
// 05 — STYLES
// ============================================================

const rootStyle: CSSProperties = {
  display: "inline-flex",
  flexDirection: "column",
  alignItems: "flex-start",
  gap: 6,
  maxWidth: "100%",
};

const buttonStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 7,
  minHeight: 35,
  padding: "7px 11px",
  border: "1px solid #0e7490",
  borderRadius: 6,
  backgroundColor: "#164e63",
  color: "#f0f9ff",
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
};

const statusTextStyle: CSSProperties = {
  fontSize: 11,
  lineHeight: 1.5,
  color: "#94a3b8",
};

// ============================================================
// 06 — DOWNLOAD ICON
// ============================================================

function SnapshotIcon() {
  return (
    <svg
      width={17}
      height={17}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M12 3v12" />
      <path d="m7 10 5 5 5-5" />
      <path d="M4 17v4h16v-4" />
    </svg>
  );
}

// ============================================================
// 07 — MAIN COMPONENT
// ============================================================

export function ViewportSnapshot({
  plane,
  authorized,
  capture,
  disabled = false,
  loading = false,
  compact = false,
  maxSizeBytes = SNAPSHOT_DEFAULT_MAX_SIZE_BYTES,
  onComplete,
  onError,
  className = "",
}: ViewportSnapshotProps) {
  const [status, setStatus] =
    useState<ViewportSnapshotStatus>("idle");

  const pendingRef = useRef(false);
  const mountedRef = useRef(true);

  /**
   * Keep latest props available after an async
   * capture has finished.
   */
  const authorizedRef = useRef(authorized);
  const onCompleteRef = useRef(onComplete);
  const onErrorRef = useRef(onError);

  authorizedRef.current = authorized;
  onCompleteRef.current = onComplete;
  onErrorRef.current = onError;

  useEffect(() => {
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;
    };
  }, []);

  const canExport =
    authorized &&
    !disabled &&
    !loading &&
    !pendingRef.current &&
    status !== "capturing";

  // ==========================================================
  // 08 — SAFE ERROR REPORTING
  // ==========================================================

  const reportError = useCallback(
    (reason: ViewportSnapshotError): void => {
      if (mountedRef.current) {
        setStatus("error");
        onErrorRef.current?.(reason, plane);
      }
    },
    [plane],
  );

  // ==========================================================
  // 09 — EXPORT WORKFLOW
  // ==========================================================

  const exportSnapshot = useCallback(
    async (): Promise<void> => {
      if (
        pendingRef.current ||
        disabled ||
        loading
      ) {
        return;
      }

      if (!authorizedRef.current) {
        reportError("not-authorized");
        return;
      }

      pendingRef.current = true;

      if (mountedRef.current) {
        setStatus("capturing");
      }

      let snapshot: Blob;

      try {
        snapshot = await capture({
          plane,
          format: "image/png",
          excludePatientIdentifiers: true,
        });
      } catch {
        pendingRef.current = false;
        reportError("capture-failed");
        return;
      }

      const limit =
        normalizeSnapshotSizeLimit(maxSizeBytes);

      if (
        !isValidSnapshotBlob(snapshot, limit) ||
        !(await hasPNGSignature(snapshot))
      ) {
        pendingRef.current = false;

        if (
          snapshot instanceof Blob &&
          snapshot.size > limit
        ) {
          reportError("image-too-large");
        } else {
          reportError("invalid-image");
        }

        return;
      }

      /**
       * Re-check authorization after the asynchronous
       * capture, before triggering the download.
       *
       * Parent authorization still remains mandatory
       * at the capture service boundary.
       */
      if (
        !authorizedRef.current ||
        !mountedRef.current
      ) {
        pendingRef.current = false;
        reportError("not-authorized");
        return;
      }

      let objectUrl: string | null = null;
      let anchor: HTMLAnchorElement | null = null;

      try {
        objectUrl = URL.createObjectURL(snapshot);

        anchor = document.createElement("a");
        anchor.href = objectUrl;
        anchor.download =
          createSnapshotFilename(plane);

        anchor.style.display = "none";

        document.body.appendChild(anchor);
        anchor.click();

        if (mountedRef.current) {
          setStatus("completed");
          onCompleteRef.current?.(plane);
        }
      } catch {
        reportError("download-failed");
      } finally {
        if (anchor?.parentNode) {
          anchor.parentNode.removeChild(anchor);
        }

        if (objectUrl !== null) {
          URL.revokeObjectURL(objectUrl);
        }

        pendingRef.current = false;
      }
    },
    [
      plane,
      capture,
      disabled,
      loading,
      maxSizeBytes,
      reportError,
    ],
  );

  // ==========================================================
  // 10 — RENDER
  // ==========================================================

  const buttonLabel = compact
    ? "Snapshot"
    : `Export ${snapshotPlaneLabel(plane)} PNG`;

  const message =
    STATUS_MESSAGES[status];

  return (
    <div
      className={className}
      style={rootStyle}
      data-viewport-snapshot="true"
      data-snapshot-plane={plane}
      data-snapshot-status={status}
    >
      <button
        type="button"
        style={{
          ...buttonStyle,
          padding: compact ? "6px 8px" : "7px 11px",
          opacity: canExport ? 1 : 0.45,
          cursor: canExport
            ? "pointer"
            : "not-allowed",
        }}
        disabled={!canExport}
        onClick={() => {
          void exportSnapshot();
        }}
        aria-label={buttonLabel}
        aria-busy={status === "capturing"}
        title={
          authorized
            ? "Export non-identifying viewport image"
            : "Snapshot export unavailable"
        }
        data-snapshot-button="true"
      >
        <SnapshotIcon />
        <span>
          {status === "capturing"
            ? "Preparing…"
            : buttonLabel}
        </span>
      </button>

      {status !== "idle" && (
        <span
          style={{
            ...statusTextStyle,
            color: status === "error"
              ? "#fbbf24"
              : "#94a3b8",
          }}
          role="status"
          aria-live="polite"
        >
          {message}
        </span>
      )}
    </div>
  );
}

// ============================================================
// 11 — CAPABILITIES
// ============================================================

export function getViewportSnapshotCapabilities() {
  return {
    axialSupport: true,
    coronalSupport: true,
    sagittalSupport: true,
    pngOnly: true,
    userTriggeredExport: true,
    parentOwnedCapture: true,
    parentAuthorizationRequired: true,
    authorizationRechecked: true,
    identifyingOverlayExclusionRequested: true,
    blobMimeValidation: true,
    pngSignatureValidation: true,
    exportSizeLimit: true,
    safeFilename: true,
    temporaryObjectUrlCleanup: true,
    duplicateExportGuard: true,
    fixedStatusMessages: true,
    safeErrorCategories: true,
    compactLayout: true,
    automaticDeidentification: false,
    directDICOMAccess: false,
    directNetworkRequests: false,
    browserPersistence: false,
    sourceDatasetModification: false,
    clinicalValidationComplete: false,
  } as const;
}

// ============================================================
// END OF SINUS VIEWER VIEWPORT SNAPSHOT
// ============================================================
