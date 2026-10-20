
/**
 * SINUS VIEWER — FRONTEND PREVIEW SERVICE
 * =======================================
 *
 * Features:
 * - Authorized axial / coronal / sagittal previews.
 * - Preview metadata and image loading.
 * - Sequential PNG downloads to limit server contention.
 * - Browser object URL creation and lifecycle management.
 * - Cancellation and stale-response protection.
 * - React useSyncExternalStore-compatible subscriptions.
 * - Cleanup on dataset change, logout or unmount.
 *
 * Security:
 * - No patient identifiers or raw DICOM metadata in state.
 * - Only opaque, server-generated handles are accepted.
 * - PNGs are held in memory; never written to browser storage.
 * - No raw HTTP responses, paths or errors are logged.
 * - Blob URLs must not be persisted or shared.
 * - Backend authentication and ownership remain mandatory.
 *
 * Preview images are navigation aids, NOT diagnostic images.
 *
 * No filesystem operations.
 */

import {
  apiGetPreviewPNG,
  apiGetPreviews,
  getPublicErrorText,
  isAuthenticationFailure,
} from "./apiClient";

import {
  isOpaqueHandle,
  type PreviewDescriptor,
  type PreviewImage,
  type PreviewPlane,
} from "../types/api";


// ============================================================
// 01 — TYPES AND CONSTANTS
// ============================================================

export const PREVIEW_PLANES = [
  "axial",
  "coronal",
  "sagittal",
] as const;

export type PreviewLoadStatus =
  | "idle"
  | "loading"
  | "ready"
  | "cancelled"
  | "error"
  | "authentication-required";

export interface PreviewResource {
  readonly plane: PreviewPlane;
  readonly url: string;
  readonly metadata: PreviewImage;
}

export interface PreviewResources {
  readonly axial: PreviewResource;
  readonly coronal: PreviewResource;
  readonly sagittal: PreviewResource;
}

export interface PreviewLoadProgress {
  readonly status: PreviewLoadStatus;
  readonly completedPlanes: number;
  readonly totalPlanes: 3;
  readonly currentPlane: PreviewPlane | null;
  readonly percentage: number;
  readonly error: string | null;
}

export interface PreviewServiceSnapshot {
  readonly datasetSessionId: string | null;
  readonly seriesHandle: string | null;
  readonly descriptor: PreviewDescriptor | null;
  readonly images: PreviewResources | null;
  readonly progress: PreviewLoadProgress;
}

export interface PreviewLoadOptions {
  readonly signal?: AbortSignal;
}

export type PreviewStateListener = (
  snapshot: PreviewServiceSnapshot,
) => void;

const TOTAL_PLANES = 3 as const;


// ============================================================
// 02 — CONTROLLED PUBLIC ERRORS
// ============================================================

export type FrontendPreviewErrorCode =
  | "INVALID_SELECTION"
  | "INVALID_PREVIEW"
  | "CANCELLED"
  | "AUTH_REQUIRED"
  | "NETWORK_FAILURE";

export class FrontendPreviewError extends Error {
  readonly code: FrontendPreviewErrorCode;

  constructor(
    code: FrontendPreviewErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "FrontendPreviewError";
    this.code = code;
  }
}

function cancellationError(): FrontendPreviewError {
  return new FrontendPreviewError(
    "CANCELLED",
    "Preview loading was cancelled.",
  );
}

function publicError(error: unknown): FrontendPreviewError {
  if (error instanceof FrontendPreviewError) {
    return error;
  }

  if (isAuthenticationFailure(error)) {
    return new FrontendPreviewError(
      "AUTH_REQUIRED",
      "Your session has expired. Sign in again.",
    );
  }

  return new FrontendPreviewError(
    "NETWORK_FAILURE",
    getPublicErrorText(error),
  );
}


// ============================================================
// 03 — INITIAL SNAPSHOT
// ============================================================

function makeProgress(
  status: PreviewLoadStatus = "idle",
  completedPlanes = 0,
  currentPlane: PreviewPlane | null = null,
  error: string | null = null,
): PreviewLoadProgress {
  return {
    status,
    completedPlanes,
    totalPlanes: TOTAL_PLANES,
    currentPlane,
    percentage: Math.round(
      (completedPlanes / TOTAL_PLANES) * 100,
    ),
    error,
  };
}

function initialSnapshot(): PreviewServiceSnapshot {
  return {
    datasetSessionId: null,
    seriesHandle: null,
    descriptor: null,
    images: null,
    progress: makeProgress(),
  };
}


// ============================================================
// 04 — INPUT AND METADATA VALIDATION
// ============================================================

function validateSelection(
  datasetSessionId: string,
  seriesHandle: string,
): void {
  if (
    !isOpaqueHandle(datasetSessionId) ||
    !isOpaqueHandle(seriesHandle)
  ) {
    throw new FrontendPreviewError(
      "INVALID_SELECTION",
      "Select a valid dataset and series.",
    );
  }
}

function validateImageMetadata(
  image: PreviewImage,
  plane: PreviewPlane,
): void {
  const [height, width] = image.shape_yx;

  if (
    image.plane !== plane ||
    image.dtype !== "uint8" ||
    image.diagnostic_quality !== false ||
    !Number.isSafeInteger(height) ||
    !Number.isSafeInteger(width) ||
    height < 1 ||
    width < 1 ||
    height > 512 ||
    width > 512 ||
    image.byte_size !== height * width ||
    !Number.isSafeInteger(image.sampled_slice_count) ||
    image.sampled_slice_count < 1 ||
    !Number.isSafeInteger(image.representative_slice_index) ||
    image.representative_slice_index < 0 ||
    !Number.isFinite(image.window_low) ||
    !Number.isFinite(image.window_high) ||
    image.window_high <= image.window_low
  ) {
    throw new FrontendPreviewError(
      "INVALID_PREVIEW",
      "Invalid preview metadata.",
    );
  }
}

function validateDescriptor(
  descriptor: PreviewDescriptor,
): void {
  if (descriptor.diagnostic_quality !== false) {
    throw new FrontendPreviewError(
      "INVALID_PREVIEW",
      "Invalid preview quality declaration.",
    );
  }

  for (const plane of PREVIEW_PLANES) {
    validateImageMetadata(descriptor[plane], plane);
  }
}


// ============================================================
// 05 — OBJECT URL CLEANUP
// ============================================================

function revokePreviewURLs(
  resources: PreviewResources | null,
): void {
  if (!resources) {
    return;
  }

  for (const plane of PREVIEW_PLANES) {
    URL.revokeObjectURL(resources[plane].url);
  }
}

function revokePendingURLs(
  urls: readonly string[],
): void {
  for (const url of urls) {
    URL.revokeObjectURL(url);
  }
}


// ============================================================
// 06 — FRONTEND PREVIEW SERVICE
// ============================================================

export class FrontendPreviewService {
  private snapshot: PreviewServiceSnapshot =
    initialSnapshot();

  private readonly listeners =
    new Set<PreviewStateListener>();

  private requestVersion = 0;

  private controller: AbortController | null = null;

  private disposed = false;

  // ==========================================================
  // 07 — REACT STATE SUBSCRIPTIONS
  // ==========================================================

  getSnapshot = (): PreviewServiceSnapshot => {
    return this.snapshot;
  };

  subscribe = (
    listener: PreviewStateListener,
  ): (() => void) => {
    if (this.disposed) {
      return () => undefined;
    }

    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  };

  private publish(
    next: PreviewServiceSnapshot,
  ): void {
    if (this.disposed) {
      return;
    }

    this.snapshot = next;

    for (const listener of this.listeners) {
      try {
        listener(next);
      } catch {
        // UI listener failures cannot stop other listeners.
      }
    }
  }

  private isCurrent(
    version: number,
    controller: AbortController,
  ): boolean {
    return (
      !this.disposed &&
      this.requestVersion === version &&
      this.controller === controller &&
      !controller.signal.aborted
    );
  }

  private assertCurrent(
    version: number,
    controller: AbortController,
  ): void {
    if (!this.isCurrent(version, controller)) {
      throw cancellationError();
    }
  }

  private publishProgress(
    progress: PreviewLoadProgress,
  ): void {
    this.publish({
      ...this.snapshot,
      progress,
    });
  }

  // ==========================================================
  // 08 — CANCEL CURRENT LOADING
  // ==========================================================

  cancel(): void {
    if (this.disposed) {
      return;
    }

    this.requestVersion++;
    this.controller?.abort();
    this.controller = null;

    if (this.snapshot.progress.status === "loading") {
      this.publishProgress(
        makeProgress("cancelled"),
      );
    }
  }

  // ==========================================================
  // 09 — CLEAR ALL PREVIEW DATA
  // ==========================================================

  reset(): void {
    if (this.disposed) {
      return;
    }

    this.requestVersion++;
    this.controller?.abort();
    this.controller = null;

    const oldImages = this.snapshot.images;

    this.publish(initialSnapshot());

    revokePreviewURLs(oldImages);
  }

  // ==========================================================
  // 10 — DISPOSE
  // ==========================================================

  dispose(): void {
    if (this.disposed) {
      return;
    }

    this.requestVersion++;
    this.controller?.abort();
    this.controller = null;
    this.disposed = true;

    const oldImages = this.snapshot.images;

    this.listeners.clear();
    this.snapshot = initialSnapshot();

    revokePreviewURLs(oldImages);
  }

  // ==========================================================
  // 11 — LOAD THREE PREVIEW IMAGES
  // ==========================================================

  async load(
    datasetSessionId: string,
    seriesHandle: string,
    options: PreviewLoadOptions = {},
  ): Promise<PreviewResources> {
    if (this.disposed) {
      throw new FrontendPreviewError(
        "INVALID_SELECTION",
        "Preview service is unavailable.",
      );
    }

    validateSelection(datasetSessionId, seriesHandle);

    // Supersede the previous request.
    this.requestVersion++;
    const version = this.requestVersion;

    this.controller?.abort();

    const controller = new AbortController();
    this.controller = controller;

    const abortFromCaller = (): void => {
      controller.abort();
    };

    options.signal?.addEventListener(
      "abort",
      abortFromCaller,
      { once: true },
    );

    if (options.signal?.aborted) {
      controller.abort();
    }

    const oldImages = this.snapshot.images;

    // Remove old image references before loading the next
    // selection. Existing UI consumers must stop using URLs
    // from previous snapshots.
    this.publish({
      datasetSessionId,
      seriesHandle,
      descriptor: null,
      images: null,
      progress: makeProgress(
        "loading",
        0,
        "axial",
      ),
    });

    revokePreviewURLs(oldImages);

    // URLs created before completion remain owned by this
    // operation and must always be revoked on failure.
    const pendingURLs: string[] = [];

    let resourcesCommitted = false;

    try {
      this.assertCurrent(version, controller);

      // Metadata calls currently cannot accept AbortSignal,
      // so stale results are explicitly rejected afterward.
      const response = await apiGetPreviews(
        datasetSessionId,
        seriesHandle,
      );

      this.assertCurrent(version, controller);

      if (response.series_handle !== seriesHandle) {
        throw new FrontendPreviewError(
          "INVALID_PREVIEW",
          "Preview series mismatch.",
        );
      }

      const descriptor = response.previews;

      validateDescriptor(descriptor);

      const loaded = {} as Record<
        PreviewPlane,
        PreviewResource
      >;

      let completed = 0;

      // Sequential download prevents three concurrent
      // builds from competing for the backend semaphore.
      for (const plane of PREVIEW_PLANES) {
        this.assertCurrent(version, controller);

        this.publishProgress(
          makeProgress(
            "loading",
            completed,
            plane,
          ),
        );

        const blob = await apiGetPreviewPNG(
          datasetSessionId,
          seriesHandle,
          plane,
          controller.signal,
        );

        this.assertCurrent(version, controller);

        if (
          blob.type !== "image/png" ||
          blob.size < 8 ||
          blob.size > 8 * 1024 * 1024
        ) {
          throw new FrontendPreviewError(
            "INVALID_PREVIEW",
            "Invalid preview image.",
          );
        }

        const url = URL.createObjectURL(blob);

        pendingURLs.push(url);

        loaded[plane] = {
          plane,
          url,
          metadata: descriptor[plane],
        };

        completed++;

        this.publishProgress(
          makeProgress(
            "loading",
            completed,
            completed < TOTAL_PLANES
              ? PREVIEW_PLANES[completed]
              : null,
          ),
        );
      }

      this.assertCurrent(version, controller);

      const images: PreviewResources = {
        axial: loaded.axial,
        coronal: loaded.coronal,
        sagittal: loaded.sagittal,
      };

      this.publish({
        datasetSessionId,
        seriesHandle,
        descriptor,
        images,
        progress: makeProgress(
          "ready",
          TOTAL_PLANES,
        ),
      });

      // The service snapshot now owns these URLs.
      resourcesCommitted = true;

      return images;
    } catch (error: unknown) {
      if (!this.isCurrent(version, controller)) {
        throw cancellationError();
      }

      const failure = publicError(error);

      this.publish({
        datasetSessionId,
        seriesHandle,
        descriptor: null,
        images: null,
        progress: makeProgress(
          failure.code === "AUTH_REQUIRED"
            ? "authentication-required"
            : failure.code === "CANCELLED"
              ? "cancelled"
              : "error",
          0,
          null,
          failure.message,
        ),
      });

      throw failure;
    } finally {
      options.signal?.removeEventListener(
        "abort",
        abortFromCaller,
      );

      if (!resourcesCommitted) {
        revokePendingURLs(pendingURLs);
      }

      if (this.controller === controller) {
        this.controller = null;
      }
    }
  }

  // ==========================================================
  // 12 — SAFE PREVIEW ACCESSORS
  // ==========================================================

  getPreview(
    plane: PreviewPlane,
  ): PreviewResource | null {
    if (this.disposed) {
      return null;
    }

    return this.snapshot.images?.[plane] ?? null;
  }

  hasPreviews(): boolean {
    return (
      !this.disposed &&
      this.snapshot.progress.status === "ready" &&
      this.snapshot.images !== null
    );
  }
}


// ============================================================
// 13 — SERVICE FACTORY
// ============================================================

export function createPreviewService():
  FrontendPreviewService {
  return new FrontendPreviewService();
}


// ============================================================
// END OF FRONTEND PREVIEW SERVICE
// ============================================================
