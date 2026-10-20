
/**
 * SINUS VIEWER — REACT PREVIEWS HOOK
 * ==================================
 *
 * React 18 integration for FrontendPreviewService.
 *
 * Features:
 * - useSyncExternalStore subscriptions.
 * - Stable preview service per hook owner.
 * - Authorized axial/coronal/sagittal PNG loading.
 * - Progress and authentication state handling.
 * - AbortSignal forwarding to preview loading.
 * - Selection comparison for dataset changes.
 * - Object URL lifecycle delegated to File 48.
 * - StrictMode-compatible cleanup.
 *
 * SECURITY:
 * - No patient names, original paths or DICOM UIDs.
 * - No image persistence in browser storage.
 * - No console logging of image data or URLs.
 * - Original DICOM dataset remains read-only.
 *
 * IMPORTANT:
 * - The service owns every generated Blob URL.
 * - UI components must not revoke service-owned URLs.
 * - Reset on logout and dataset/series change.
 * - URL references become invalid after reset/dispose.
 * - Previews are navigation aids, not diagnostic images.
 */

import {
  useCallback,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react";

import {
  createPreviewService,
  FrontendPreviewError,
  type FrontendPreviewService,
  type PreviewLoadOptions,
  type PreviewLoadProgress,
  type PreviewResource,
  type PreviewResources,
  type PreviewServiceSnapshot,
} from "../services/previewService";

import type {
  PreviewDescriptor,
  PreviewPlane,
} from "../types/api";


// ============================================================
// 01 — PUBLIC TYPES
// ============================================================

export interface PreviewSelection {
  readonly datasetSessionId: string;
  readonly seriesHandle: string;
}

export interface PreviewActions {
  readonly load: (
    selection: PreviewSelection,
    options?: PreviewLoadOptions,
  ) => Promise<PreviewResources>;

  readonly cancel: () => void;

  readonly reset: () => void;

  readonly getPreview: (
    plane: PreviewPlane,
  ) => PreviewResource | null;
}

export interface UsePreviewsResult {
  readonly state: PreviewServiceSnapshot;
  readonly progress: PreviewLoadProgress;
  readonly images: PreviewResources | null;
  readonly descriptor: PreviewDescriptor | null;

  readonly axial: PreviewResource | null;
  readonly coronal: PreviewResource | null;
  readonly sagittal: PreviewResource | null;

  readonly actions: PreviewActions;
  readonly service: FrontendPreviewService;

  readonly isLoading: boolean;
  readonly isReady: boolean;
  readonly isCancelled: boolean;
  readonly hasError: boolean;
  readonly requiresAuthentication: boolean;
  readonly hasPreviews: boolean;

  readonly completedPlanes: number;
  readonly percentage: number;
  readonly error: string | null;
}


// ============================================================
// 02 — OWNED SERVICE
// ============================================================

/**
 * One service instance belongs to one hook owner.
 *
 * Do not call usePreviews() independently for every
 * image card. The three planes must share one loader.
 *
 * Construction does not perform HTTP requests.
 */
function useOwnedPreviewService():
  FrontendPreviewService {
  const [service] = useState<FrontendPreviewService>(
    () => createPreviewService(),
  );

  useEffect(() => {
    return () => {
      /**
       * Reset cancels pending PNG requests and revokes
       * all committed service-owned Blob URLs.
       *
       * React StrictMode may replay effect cleanup
       * in development. Reset is reusable while
       * dispose permanently disables the service.
       *
       * Therefore dispose() is not invoked from this
       * effect cleanup.
       */
      service.reset();
    };
  }, [service]);

  return service;
}


// ============================================================
// 03 — EXTERNAL STORE SUBSCRIPTION
// ============================================================

/**
 * Observe an existing service owned by a parent or
 * React context.
 *
 * This hook never resets or disposes external services.
 */
export function usePreviewsSnapshot(
  service: FrontendPreviewService,
): PreviewServiceSnapshot {
  return useSyncExternalStore(
    service.subscribe,
    service.getSnapshot,
    service.getSnapshot,
  );
}


// ============================================================
// 04 — STABLE ACTION WRAPPERS
// ============================================================

export function usePreviewsActions(
  service: FrontendPreviewService,
): PreviewActions {
  const load = useCallback(
    (
      selection: PreviewSelection,
      options: PreviewLoadOptions = {},
    ): Promise<PreviewResources> => {
      return service.load(
        selection.datasetSessionId,
        selection.seriesHandle,
        options,
      );
    },
    [service],
  );

  const cancel = useCallback(
    (): void => {
      service.cancel();
    },
    [service],
  );

  const reset = useCallback(
    (): void => {
      service.reset();
    },
    [service],
  );

  const getPreview = useCallback(
    (plane: PreviewPlane): PreviewResource | null => {
      return service.getPreview(plane);
    },
    [service],
  );

  return {
    load,
    cancel,
    reset,
    getPreview,
  };
}


// ============================================================
// 05 — MAIN USE PREVIEWS HOOK
// ============================================================

/**
 * Self-contained previews hook.
 *
 * Use once inside the dataset browser or viewer owner.
 * Pass axial/coronal/sagittal resources to child views.
 *
 * Loading is intentionally explicit rather than
 * automatically triggered during render or mount.
 *
 * This prevents unintended medical-image requests
 * before an authorized series has been selected.
 */
export function usePreviews(): UsePreviewsResult {
  const service = useOwnedPreviewService();

  const state = usePreviewsSnapshot(service);
  const actions = usePreviewsActions(service);

  const progress = state.progress;
  const images = state.images;
  const descriptor = state.descriptor;

  const isLoading =
    progress.status === "loading";

  const isReady =
    progress.status === "ready" &&
    images !== null;

  const isCancelled =
    progress.status === "cancelled";

  const hasError =
    progress.status === "error";

  const requiresAuthentication =
    progress.status === "authentication-required";

  const hasPreviews = isReady;

  const axial = images?.axial ?? null;
  const coronal = images?.coronal ?? null;
  const sagittal = images?.sagittal ?? null;

  return {
    state,
    progress,
    images,
    descriptor,

    axial,
    coronal,
    sagittal,

    actions,
    service,

    isLoading,
    isReady,
    isCancelled,
    hasError,
    requiresAuthentication,
    hasPreviews,

    completedPlanes: progress.completedPlanes,
    percentage: progress.percentage,
    error: progress.error,
  };
}


// ============================================================
// 06 — SAFE ERROR ADAPTER
// ============================================================

/**
 * Returns a controlled UI-facing error.
 *
 * Do not expose unknown exception details, image
 * bytes, raw response objects or source locations.
 */
export function getPreviewActionError(
  error: unknown,
): string {
  if (error instanceof FrontendPreviewError) {
    return error.message;
  }

  return "The preview operation could not be completed.";
}


// ============================================================
// 07 — SELECTION EQUALITY
// ============================================================

/**
 * Compare opaque dataset/series handles.
 *
 * Used by the future viewer integration to determine
 * when old preview resources must be reset.
 */
export function isSamePreviewSelection(
  first: PreviewSelection | null,
  second: PreviewSelection | null,
): boolean {
  if (first === null || second === null) {
    return first === second;
  }

  return (
    first.datasetSessionId === second.datasetSessionId &&
    first.seriesHandle === second.seriesHandle
  );
}


// ============================================================
// 08 — SERVICE RESOURCE VALIDITY
// ============================================================

/**
 * Check whether the current snapshot belongs to the
 * active dataset/series selection.
 *
 * This is useful before passing URLs to an image
 * component after asynchronous selection changes.
 *
 * This does not perform an authentication check;
 * the API server enforces session authorization.
 */
export function previewsMatchSelection(
  snapshot: PreviewServiceSnapshot,
  selection: PreviewSelection | null,
): boolean {
  if (
    selection === null ||
    snapshot.progress.status !== "ready" ||
    snapshot.images === null
  ) {
    return false;
  }

  return (
    snapshot.datasetSessionId ===
      selection.datasetSessionId &&
    snapshot.seriesHandle ===
      selection.seriesHandle
  );
}


// ============================================================
// 09 — SAFE IMAGE ACCESS FROM SNAPSHOT
// ============================================================

/**
 * Select a preview directly from the subscribed
 * snapshot instead of using a possibly stale
 * asynchronous result from load().
 */
export function getSnapshotPreview(
  snapshot: PreviewServiceSnapshot,
  plane: PreviewPlane,
): PreviewResource | null {
  if (
    snapshot.progress.status !== "ready" ||
    snapshot.images === null
  ) {
    return null;
  }

  switch (plane) {
    case "axial":
      return snapshot.images.axial;

    case "coronal":
      return snapshot.images.coronal;

    case "sagittal":
      return snapshot.images.sagittal;

    default:
      return null;
  }
}


// ============================================================
// 10 — HOOK CAPABILITIES
// ============================================================

export function getPreviewsHookCapabilities() {
  return {
    reactExternalStore: true,
    stablePerOwnerService: true,
    threePlanePreviews: true,
    explicitAuthorizedLoading: true,
    progressSubscriptions: true,
    cancellablePNGRequests: true,
    staleResponseProtection: true,
    blobURLCleanup: true,
    automaticLoadOnMount: false,
    persistentBrowserStorage: false,
    diagnosticQuality: false,
    modifiesSourceDataset: false,
  } as const;
}


// ============================================================
// END OF SINUS VIEWER REACT PREVIEWS HOOK
// ============================================================
