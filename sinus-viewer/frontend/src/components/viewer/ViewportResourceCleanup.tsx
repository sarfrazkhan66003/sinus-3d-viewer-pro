
/**
 * SINUS VIEWER
 * VIEWPORT RESOURCE CLEANUP
 *
 * FILE 113 — CLEAN VERSION
 *
 * Manages cleanup callbacks for temporary,
 * application-owned viewport resources.
 *
 * Supported lifecycle events:
 * - Viewport unmount
 * - Volume generation change
 * - Authorization state change
 * - Explicit release or cleanup
 *
 * Never modifies original DICOM files.
 * Never deletes source dataset directories.
 * Never stores patient-identifying metadata.
 *
 * Resource cleanup remains independent from
 * backend authorization and clinical validation.
 */

import {
  useCallback,
  useLayoutEffect,
  useMemo,
  type ReactNode,
} from "react";

// ============================================================
// 01 — TYPES
// ============================================================

export type ResourceCleanupPlane =
  | "axial"
  | "coronal"
  | "sagittal";

export type ViewportResourceKind =
  | "abort-controller"
  | "worker"
  | "object-url"
  | "image-buffer"
  | "gpu-resource"
  | "subscription"
  | "event-listener"
  | "other";

export type ViewportResourceDisposer =
  () => void | Promise<void>;

export interface ViewportResourceIdentity {
  readonly plane: ResourceCleanupPlane;
  readonly generation: number;
  readonly authorized: boolean;
}

export interface ViewportResourceRegistration {
  readonly key: string;
  readonly kind: ViewportResourceKind;
  readonly dispose: ViewportResourceDisposer;
}

export interface ViewportCleanupReport {
  readonly attempted: number;
  readonly completed: number;
  readonly failed: number;
}

export interface ViewportResourceCleanupController {
  readonly register: (
    resource: ViewportResourceRegistration,
  ) => boolean;

  readonly release: (
    key: string,
  ) => Promise<boolean>;

  readonly clear: () => Promise<ViewportCleanupReport>;

  readonly count: () => number;
}

export interface ViewportResourceCleanupProps
  extends ViewportResourceIdentity {
  readonly children: (
    controller: ViewportResourceCleanupController,
  ) => ReactNode;
}

export interface UseViewportResourceCleanupOptions
  extends ViewportResourceIdentity {}

// ============================================================
// 02 — CONSTANTS
// ============================================================

export const VIEWPORT_MAX_MANAGED_RESOURCES = 256;

const EMPTY_CLEANUP_REPORT: ViewportCleanupReport = {
  attempted: 0,
  completed: 0,
  failed: 0,
};

// ============================================================
// 03 — VALIDATION
// ============================================================

export function isValidResourceGeneration(
  value: unknown,
): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
  );
}

export function isValidResourceKey(
  value: unknown,
): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 128 &&
    /^[a-zA-Z0-9_.:-]+$/.test(value)
  );
}

export function isViewportResourceKind(
  value: unknown,
): value is ViewportResourceKind {
  switch (value) {
    case "abort-controller":
    case "worker":
    case "object-url":
    case "image-buffer":
    case "gpu-resource":
    case "subscription":
    case "event-listener":
    case "other":
      return true;

    default:
      return false;
  }
}

export function resourceCleanupPlaneLabel(
  plane: ResourceCleanupPlane,
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
// 04 — SAFE DISPOSER EXECUTION
// ============================================================

export async function executeViewportDisposer(
  disposer: ViewportResourceDisposer,
): Promise<boolean> {
  try {
    await disposer();
    return true;
  } catch {
    return false;
  }
}

// ============================================================
// 05 — RESOURCE REGISTRY
// ============================================================

/**
 * Stores cleanup callbacks for a viewport.
 *
 * A resource is detached before its disposer
 * executes, avoiding duplicate cleanup.
 *
 * Dispose closes the registry permanently.
 *
 * Cleanup callbacks may complete asynchronously.
 */
export class ViewportResourceRegistry {
  private readonly resources =
    new Map<string, ViewportResourceRegistration>();

  private disposed = false;

  // ----------------------------------------------------------
  // REGISTER
  // ----------------------------------------------------------

  register(
    resource: ViewportResourceRegistration,
  ): boolean {
    if (
      this.disposed ||
      !isValidResourceKey(resource.key) ||
      !isViewportResourceKind(resource.kind) ||
      typeof resource.dispose !== "function" ||
      this.resources.has(resource.key) ||
      this.resources.size >=
        VIEWPORT_MAX_MANAGED_RESOURCES
    ) {
      return false;
    }

    this.resources.set(
      resource.key,
      resource,
    );

    return true;
  }

  // ----------------------------------------------------------
  // RELEASE ONE RESOURCE
  // ----------------------------------------------------------

  async release(key: string): Promise<boolean> {
    if (!isValidResourceKey(key)) {
      return false;
    }

    const resource = this.resources.get(key);

    if (!resource) {
      return false;
    }

    this.resources.delete(key);

    return executeViewportDisposer(
      resource.dispose,
    );
  }

  // ----------------------------------------------------------
  // CLEAR ALL REGISTERED RESOURCES
  // ----------------------------------------------------------

  async clear(): Promise<ViewportCleanupReport> {
    const pending = Array.from(
      this.resources.values(),
    );

    /**
     * Detach before running callbacks.
     * Subsequent clear calls cannot rerun the
     * same registered cleanup.
     */
    this.resources.clear();

    if (pending.length === 0) {
      return {
        ...EMPTY_CLEANUP_REPORT,
      };
    }

    /**
     * Every disposer receives one attempt.
     * A rejected disposer does not interrupt
     * cleanup of the remaining resources.
     */
    const results = await Promise.all(
      pending.map((resource) =>
        executeViewportDisposer(
          resource.dispose,
        ),
      ),
    );

    const completed = results.filter(
      (success) => success,
    ).length;

    return {
      attempted: results.length,
      completed,
      failed: results.length - completed,
    };
  }

  // ----------------------------------------------------------
  // PERMANENT DISPOSAL
  // ----------------------------------------------------------

  dispose(): Promise<ViewportCleanupReport> {
    this.disposed = true;

    return this.clear();
  }

  // ----------------------------------------------------------
  // INSPECTION
  // ----------------------------------------------------------

  count(): number {
    return this.resources.size;
  }

  isDisposed(): boolean {
    return this.disposed;
  }
}

// ============================================================
// 06 — REACT HOOK
// ============================================================

/**
 * A new registry is created when plane,
 * generation or authorization state changes.
 *
 * Registration should occur only in effects
 * or event handlers, never during render.
 *
 * The previous registry is disposed when
 * the identity changes or the hook unmounts.
 *
 * The parent must also invalidate old rendering
 * tasks, frames and external caches.
 */
export function useViewportResourceCleanup(
  options: UseViewportResourceCleanupOptions,
): ViewportResourceCleanupController {
  const validIdentity =
    isValidResourceGeneration(
      options.generation,
    ) &&
    options.authorized === true;

  const registry = useMemo(
    () => new ViewportResourceRegistry(),
    [
      options.plane,
      options.generation,
      options.authorized,
    ],
  );

  useLayoutEffect(() => {
    return () => {
      void registry.dispose();
    };
  }, [registry]);

  // ----------------------------------------------------------
  // REGISTER
  // ----------------------------------------------------------

  const register = useCallback(
    (
      resource: ViewportResourceRegistration,
    ): boolean => {
      if (!validIdentity) {
        return false;
      }

      return registry.register(resource);
    },
    [
      registry,
      validIdentity,
    ],
  );

  // ----------------------------------------------------------
  // RELEASE
  // ----------------------------------------------------------

  const release = useCallback(
    (key: string): Promise<boolean> => {
      return registry.release(key);
    },
    [registry],
  );

  // ----------------------------------------------------------
  // CLEAR
  // ----------------------------------------------------------

  const clear = useCallback(
    (): Promise<ViewportCleanupReport> => {
      return registry.clear();
    },
    [registry],
  );

  // ----------------------------------------------------------
  // COUNT
  // ----------------------------------------------------------

  const count = useCallback((): number => {
    return registry.count();
  }, [registry]);

  return {
    register,
    release,
    clear,
    count,
  };
}

// ============================================================
// 07 — RENDER-PROP COMPONENT
// ============================================================

export function ViewportResourceCleanup({
  plane,
  generation,
  authorized,
  children,
}: ViewportResourceCleanupProps) {
  const controller =
    useViewportResourceCleanup({
      plane,
      generation,
      authorized,
    });

  return <>{children(controller)}</>;
}

// ============================================================
// 08 — CAPABILITIES
// ============================================================

export function getViewportResourceCleanupCapabilities() {
  return {
    axialSupport: true,
    coronalSupport: true,
    sagittalSupport: true,
    generationScopedRegistry: true,
    authorizationGate: true,
    boundedResourceRegistration: true,
    duplicateKeyRejection: true,
    explicitSingleResourceRelease: true,
    explicitClear: true,
    permanentDisposal: true,
    reentrantDuplicateDisposalProtection: true,
    synchronousRegistryDetachment: true,
    asynchronousDisposerSupport: true,
    safeDisposerFailureHandling: true,
    reactUnmountCleanup: true,
    reactIdentityChangeCleanup: true,
    stableRegistrationCallbacks: true,
    renderPropController: true,
    applicationOwnedResourcesOnly: true,
    directDICOMAccess: false,
    directNetworkRequests: false,
    browserPersistence: false,
    patientMetadataStorage: false,
    originalDatasetModification: false,
    clinicalValidationComplete: false,
  } as const;
}

// ============================================================
// END OF SINUS VIEWER VIEWPORT RESOURCE CLEANUP — FILE 113
// ============================================================
