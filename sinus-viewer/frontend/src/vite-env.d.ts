
/// <reference types="vite/client" />

/**
 * ============================================================
 * SINUS VIEWER — VITE ENVIRONMENT TYPE DECLARATIONS
 * ============================================================
 *
 * Application: Sinus Viewer
 * Frontend: React + TypeScript + Vite
 *
 * PURPOSE:
 * 1. Type-check public frontend environment variables.
 * 2. Declare build-time application constants.
 * 3. Provide static asset and worker module types.
 *
 * SECURITY:
 * Every VITE_* environment variable may be exposed to the
 * browser bundle. Never place patient data, passwords,
 * API secrets, private keys, or access tokens in VITE_*.
 *
 * No local dependencies are required to write this file.
 * ============================================================
 */

/**
 * Public environment variables made available by Vite.
 *
 * These are deployment settings, not secrets.
 */
interface ImportMetaEnv {
  /**
   * Optional public application title.
   */
  readonly VITE_APP_NAME?: string;

  /**
   * Optional public application version.
   */
  readonly VITE_APP_VERSION?: string;

  /**
   * Browser API base path.
   *
   * Production default: /api
   *
   * Prefer same-origin relative paths rather than
   * exposing Colab's internal backend address.
   */
  readonly VITE_API_BASE_URL?: string;

  /**
   * Development-only Vite proxy destination.
   *
   * Used by vite.config.ts during development.
   * Must not contain authentication credentials.
   */
  readonly VITE_DEV_BACKEND_URL?: string;

  /**
   * Optional public deployment label.
   *
   * Examples:
   * development
   * staging
   * production
   */
  readonly VITE_DEPLOYMENT_ENV?: string;

  /**
   * Optional public feature flags.
   *
   * Parse and validate these values at runtime.
   * Vite environment values are strings.
   */
  readonly VITE_ENABLE_3D?: string;
  readonly VITE_ENABLE_MEASUREMENTS?: string;
  readonly VITE_ENABLE_DEBUG_UI?: string;
}

/**
 * Extend Vite's import.meta typing.
 */
interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/**
 * Application constants injected through vite.config.ts.
 *
 * These identifiers are replaced during the Vite build.
 */
declare const __APP_NAME__: string;
declare const __APP_VERSION__: string;

/**
 * Static SVG imports.
 */
declare module "*.svg" {
  const source: string;
  export default source;
}

/**
 * Worker imports using the Vite ?worker query.
 */
declare module "*?worker" {
  const WorkerConstructor: {
    new (): Worker;
  };

  export default WorkerConstructor;
}

/**
 * URL-style worker imports.
 */
declare module "*?worker&url" {
  const workerUrl: string;
  export default workerUrl;
}

/**
 * Raw text imports supported by Vite.
 */
declare module "*?raw" {
  const rawContent: string;
  export default rawContent;
}
