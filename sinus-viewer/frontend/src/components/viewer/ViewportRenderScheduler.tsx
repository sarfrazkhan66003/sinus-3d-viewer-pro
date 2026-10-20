
/**
 * SINUS VIEWER — VIEWPORT RENDER SCHEDULER
 * ========================================
 *
 * File 106 — Corrected complete version.
 *
 * Features:
 * - Latest request wins.
 * - Animation-frame request coalescing.
 * - One active asynchronous worker.
 * - AbortSignal cancellation.
 * - Stale-result rejection.
 * - Volume/plane revision invalidation.
 * - Stable React hook callbacks.
 * - Renderless React controller.
 * - Safe cleanup.
 *
 * IMPORTANT:
 * Rendering should produce an offscreen result.
 * The render worker must not paint directly onto
 * the visible canvas before commit approval.
 *
 * Original CT/CBCT DICOM files remain READ ONLY.
 */


import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";

// ============================================================
// 01 — PUBLIC TYPES
// ============================================================

export type RenderSchedulerPlane =
  | "axial"
  | "coronal"
  | "sagittal";

export type RenderScheduleReason =
  | "initial"
  | "slice"
  | "zoom"
  | "pan"
  | "resize"
  | "window-level"
  | "crosshair"
  | "settings"
  | "volume-change";

export interface ScheduledRenderRequest<TInput> {
  readonly reason: RenderScheduleReason;
  readonly input: TInput;
}

export interface RenderExecutionContext {
  readonly signal: AbortSignal;
  readonly sequence: number;
}

export interface RenderScheduleResult<TResult> {
  readonly sequence: number;
  readonly reason: RenderScheduleReason;
  readonly result: TResult;
}

export type ViewportRenderWorker<TInput, TResult> = (
  input: TInput,
  context: RenderExecutionContext,
) => Promise<TResult> | TResult;

export type ViewportRenderCommit<TResult> = (
  value: RenderScheduleResult<TResult>,
) => void;

export type ViewportRenderFailure = (
  reason: "render-failed",
) => void;

export interface ViewportRenderSchedulerOptions<
  TInput,
  TResult,
> {
  readonly render: ViewportRenderWorker<TInput, TResult>;
  readonly commit: ViewportRenderCommit<TResult>;
  readonly onFailure?: ViewportRenderFailure;
}

export interface ViewportRenderSchedulerProps<
  TInput,
  TResult,
> extends ViewportRenderSchedulerOptions<
    TInput,
    TResult
  > {
  readonly plane: RenderSchedulerPlane;

  readonly request:
    | ScheduledRenderRequest<TInput>
    | null;

  /**
   * Opaque non-identifying revision.
   *
   * Increment when changing:
   * - Volume/session
   * - Plane identity
   * - Rendering geometry
   */
  readonly revision: number;

  readonly enabled?: boolean;
  readonly children?: ReactNode;
}

// ============================================================
// 02 — VALIDATION HELPERS
// ============================================================

export function isValidRenderRevision(
  revision: number,
): boolean {
  return (
    Number.isSafeInteger(revision) &&
    revision >= 0
  );
}

export function isRenderScheduleReason(
  value: unknown,
): value is RenderScheduleReason {
  switch (value) {
    case "initial":
    case "slice":
    case "zoom":
    case "pan":
    case "resize":
    case "window-level":
    case "crosshair":
    case "settings":
    case "volume-change":
      return true;

    default:
      return false;
  }
}

// ============================================================
// 03 — FRAMEWORK-INDEPENDENT SCHEDULER
// ============================================================

/**
 * Manages asynchronous rendering.
 *
 * Rules:
 * 1. A newer request replaces pending work.
 * 2. Active older work receives abort().
 * 3. Only the latest sequence may commit.
 * 4. Only one render worker executes at a time.
 * 5. Disposal invalidates all pending results.
 *
 * Abort is cooperative. A worker that ignores
 * cancellation may delay newer work.
 */
export class ViewportRenderScheduler<
  TInput,
  TResult,
> {
  private readonly options:
    ViewportRenderSchedulerOptions<
      TInput,
      TResult
    >;

  private sequence = 0;

  private disposed = false;

  private pending:
    | ScheduledRenderRequest<TInput>
    | null = null;

  private running = false;

  private controller:
    | AbortController
    | null = null;

  private frameId: number | null = null;

  private queuedMicrotask = false;

  constructor(
    options: ViewportRenderSchedulerOptions<
      TInput,
      TResult
    >,
  ) {
    this.options = options;
  }

  // ==========================================================
  // 04 — SCHEDULE
  // ==========================================================

  schedule(
    request: ScheduledRenderRequest<TInput>,
  ): number {
    if (this.disposed) {
      return -1;
    }

    if (
      !request ||
      !isRenderScheduleReason(request.reason)
    ) {
      return -1;
    }

    const sequence = ++this.sequence;

    // Latest pending request replaces older pending.
    this.pending = request;

    // Invalidate currently running work.
    this.controller?.abort();

    this.requestDrain();

    return sequence;
  }

  // ==========================================================
  // 05 — INVALIDATE
  // ==========================================================

  invalidate(): void {
    if (this.disposed) {
      return;
    }

    ++this.sequence;

    this.pending = null;

    this.controller?.abort();

    if (this.frameId !== null) {
      if (
        typeof cancelAnimationFrame === "function"
      ) {
        cancelAnimationFrame(this.frameId);
      }

      this.frameId = null;
    }
  }

  // ==========================================================
  // 06 — REQUEST DRAIN
  // ==========================================================

  private requestDrain(): void {
    if (
      this.disposed ||
      this.running ||
      this.pending === null
    ) {
      return;
    }

    if (
      this.frameId !== null ||
      this.queuedMicrotask
    ) {
      return;
    }

    if (
      typeof requestAnimationFrame === "function"
    ) {
      this.frameId = requestAnimationFrame(() => {
        this.frameId = null;
        void this.drain();
      });

      return;
    }

    // Fallback for non-browser/test environments.
    this.queuedMicrotask = true;

    queueMicrotask(() => {
      this.queuedMicrotask = false;
      void this.drain();
    });
  }

  // ==========================================================
  // 07 — EXECUTE ONE RENDER
  // ==========================================================

  private async drain(): Promise<void> {
    if (
      this.disposed ||
      this.running ||
      this.pending === null
    ) {
      return;
    }

    const request = this.pending;

    const sequence = this.sequence;

    this.pending = null;

    this.running = true;

    const controller = new AbortController();

    this.controller = controller;

    try {
      const result = await this.options.render(
        request.input,
        {
          signal: controller.signal,
          sequence,
        },
      );

      // Commit only an accepted current result.
      const current =
        !this.disposed &&
        !controller.signal.aborted &&
        sequence === this.sequence;

      if (current) {
        this.options.commit({
          sequence,
          reason: request.reason,
          result,
        });
      }
    } catch {
      // Never expose raw backend/renderer errors.
      const current =
        !this.disposed &&
        !controller.signal.aborted &&
        sequence === this.sequence;

      if (current) {
        this.options.onFailure?.(
          "render-failed",
        );
      }
    } finally {
      if (this.controller === controller) {
        this.controller = null;
      }

      this.running = false;

      // A newer request may have arrived.
      // Process only the latest pending request.
      if (
        !this.disposed &&
        this.pending !== null
      ) {
        this.requestDrain();
      }
    }
  }

  // ==========================================================
  // 08 — CLEANUP
  // ==========================================================

  dispose(): void {
    if (this.disposed) {
      return;
    }

    this.invalidate();

    this.disposed = true;
  }

  getCurrentSequence(): number {
    return this.sequence;
  }

  isDisposed(): boolean {
    return this.disposed;
  }
}

// ============================================================
// 09 — REACT HOOK OPTIONS
// ============================================================

export interface UseViewportRenderSchedulerOptions<
  TInput,
  TResult,
> extends ViewportRenderSchedulerOptions<
    TInput,
    TResult
  > {
  readonly enabled?: boolean;
  readonly revision: number;
  readonly plane: RenderSchedulerPlane;
}

// ============================================================
// 10 — REACT HOOK
// ============================================================

/**
 * IMPORTANT:
 *
 * useViewportRenderScheduler is a HOOK FUNCTION.
 * It is not a separate file.
 *
 * This function lives inside:
 * ViewportRenderScheduler.tsx
 *
 * Callbacks are stable and scheduler lifetime is
 * tied to the React component that calls this hook.
 */
export function useViewportRenderScheduler<
  TInput,
  TResult,
>(
  options: UseViewportRenderSchedulerOptions<
    TInput,
    TResult
  >,
) {
  const callbacksRef = useRef(options);

  const scheduler = useMemo(
    () =>
      new ViewportRenderScheduler<
        TInput,
        TResult
      >({
        render: (input, context) =>
          callbacksRef.current.render(
            input,
            context,
          ),

        commit: (result) =>
          callbacksRef.current.commit(result),

        onFailure: (reason) =>
          callbacksRef.current.onFailure?.(
            reason,
          ),
      }),
    [],
  );

  const enabled = options.enabled ?? true;

  const validRevision =
    isValidRenderRevision(options.revision);

  /**
   * Update callback references after each commit,
   * avoiding recreation of scheduler instances.
   */
  useLayoutEffect(() => {
    callbacksRef.current = options;
  });

  /**
   * Invalidate older work when:
   * - plane changes
   * - revision changes
   * - enabled state changes
   *
   * Parent must also invalidate immediately
   * when revoking access before any visible
   * result can be presented.
   */
  useLayoutEffect(() => {
    scheduler.invalidate();
  }, [
    scheduler,
    options.plane,
    options.revision,
    enabled,
  ]);

  /**
   * Dispose scheduler on unmount.
   */
  useEffect(() => {
    return () => {
      scheduler.dispose();
    };
  }, [scheduler]);

  // ==========================================================
  // 11 — STABLE SCHEDULE CALLBACK
  // ==========================================================

  const schedule = useCallback(
    (request: ScheduledRenderRequest<TInput>): number => {
      if (!enabled || !validRevision) {
        return -1;
      }

      return scheduler.schedule(request);
    },
    [enabled, validRevision, scheduler],
  );


  // ==========================================================
  // 12 — STABLE INVALIDATE CALLBACK
  // ==========================================================

  const invalidate = useCallback((): void => {
    scheduler.invalidate();
  }, [scheduler]);

  const getCurrentSequence = useCallback(
    (): number => {
      return scheduler.getCurrentSequence();
    },
    [scheduler],
  );

  return {
    schedule,
    invalidate,
    getCurrentSequence,
  };
}

// ============================================================
// 13 — RENDERLESS REACT CONTROLLER
// ============================================================

/**
 * Declarative adapter for stable render requests.
 *
 * Parent should memoize request objects.
 * If request changes on every React render,
 * this component will treat each one as new work.
 *
 * The hook schedules work; this component does not
 * independently draw the visible image.
 */
export function ViewportRenderSchedulerController<
  TInput,
  TResult,
>({
  plane,
  request,
  revision,
  enabled = true,
  render,
  commit,
  onFailure,
  children = null,
}: ViewportRenderSchedulerProps<TInput, TResult>) {
  const controller = useViewportRenderScheduler<
    TInput,
    TResult
  >({
    plane,
    revision,
    enabled,
    render,
    commit,
    onFailure,
  });

  const schedule = controller.schedule;

  useEffect(() => {
    if (
      enabled &&
      isValidRenderRevision(revision) &&
      request !== null
    ) {
      schedule(request);
    }
  }, [
    enabled,
    revision,
    plane,
    request,
    schedule,
  ]);

  return <>{children}</>;
}

// ============================================================
// 14 — CAPABILITIES
// ============================================================

export function getViewportRenderSchedulerCapabilities() {
  return {
    latestRequestWins: true,
    animationFrameCoalescing: true,
    singleActiveWorker: true,
    abortSignalCancellation: true,
    staleSequenceRejection: true,
    manualInvalidation: true,
    resourceDisposal: true,
    reactHookAdapter: true,
    stableReactCallbacks: true,
    renderlessReactController: true,
    parentOwnedRenderWorker: true,
    offscreenRenderingContract: true,
    synchronousVisibleCanvasPainting: false,
    backendAuthorizationEnforcement: false,
    directDICOMAccess: false,
    networkRequests: false,
    browserPersistence: false,
    sourceDatasetModification: false,
    clinicalValidationComplete: false,
  } as const;
}

// ============================================================
// END OF SINUS VIEWER RENDER SCHEDULER — FILE 106
// ============================================================
