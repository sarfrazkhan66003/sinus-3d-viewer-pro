
/**
 * SINUS VIEWER — REACT APPLICATION ENTRY POINT
 * =============================================
 *
 * Responsibilities:
 * - Mount the React 18 application.
 * - Enable client-side routing.
 * - Load application-wide styles.
 * - Install privacy-safe browser error handlers.
 * - Avoid logging clinical data or API payloads.
 * - Enable React StrictMode.
 *
 * Security:
 * - Never read or store patient information here.
 * - Never persist authentication cookies or tokens.
 * - Never print raw JavaScript errors containing
 *   URLs, request bodies, DICOM metadata or filenames.
 * - Browser authentication uses HttpOnly cookies,
 *   managed by the backend and API client.
 *
 * Deployment:
 * - React is compiled with Vite in Google Colab.
 * - Windows VS Code is used only as the source editor.
 * - No dataset file operations occur here.
 *
 * React 18 / TypeScript / Vite
 */

import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";

import App from "./App";
import "./index.css";


// ============================================================
// 01 — APPLICATION CONSTANTS
// ============================================================

const APPLICATION_NAME = "Sinus Viewer";

const ROOT_ELEMENT_ID = "root";

const GLOBAL_ERROR_EVENT = "error";

const GLOBAL_REJECTION_EVENT = "unhandledrejection";


// ============================================================
// 02 — SAFE ERROR CLASSIFICATION
// ============================================================

type SafeErrorCategory =
  | "APPLICATION_ERROR"
  | "UNHANDLED_PROMISE"
  | "STARTUP_ERROR";

interface SafeErrorRecord {
  readonly category: SafeErrorCategory;
  readonly timestamp: number;
}


/**
 * Keep browser-side monitoring records deliberately small.
 *
 * Never include:
 * - Error messages or stack traces.
 * - Request URLs or query parameters.
 * - Source DICOM paths.
 * - Patient metadata.
 * - Authentication credentials or tokens.
 */

const MAX_SAFE_ERROR_RECORDS = 25;

const safeErrorRecords: SafeErrorRecord[] = [];


/**
 * Record only generic error categories and timestamps.
 *
 * This is process-local browser memory, not persistent
 * storage and not an external telemetry service.
 */
function recordSafeError(
  category: SafeErrorCategory,
): void {
  const record: SafeErrorRecord = {
    category,
    timestamp: Date.now(),
  };

  safeErrorRecords.push(record);

  if (
    safeErrorRecords.length >
    MAX_SAFE_ERROR_RECORDS
  ) {
    safeErrorRecords.shift();
  }

  /*
   * Intentionally do not log the underlying Error object,
   * reason, stack, URL, or browser event.
   */
  if (import.meta.env.DEV) {
    console.warn(
      `[${APPLICATION_NAME}] ${category}`,
    );
  }
}


// ============================================================
// 03 — GLOBAL ERROR LISTENERS
// ============================================================

function registerGlobalErrorHandlers(): void {
  window.addEventListener(
    GLOBAL_ERROR_EVENT,
    (_event: ErrorEvent): void => {
      recordSafeError("APPLICATION_ERROR");

      /*
       * Do not prevent default here.
       * Browser developer tools may still show errors
       * during development, but this application does
       * not intentionally serialize their contents.
       */
    },
  );

  window.addEventListener(
    GLOBAL_REJECTION_EVENT,
    (event: PromiseRejectionEvent): void => {
      recordSafeError("UNHANDLED_PROMISE");

      /*
       * Prevent browser-level console output that may
       * include sensitive rejection payloads.
       */
      event.preventDefault();
    },
  );
}


// ============================================================
// 04 — ROOT ELEMENT RESOLUTION
// ============================================================

function getRootElement(): HTMLElement {
  const element = document.getElementById(
    ROOT_ELEMENT_ID,
  );

  if (element === null) {
    recordSafeError("STARTUP_ERROR");

    throw new Error(
      "Sinus Viewer root element is unavailable.",
    );
  }

  return element;
}


// ============================================================
// 05 — APPLICATION BOOTSTRAP
// ============================================================

function bootstrapApplication(): void {
  registerGlobalErrorHandlers();

  const rootElement = getRootElement();

  const root = ReactDOM.createRoot(rootElement);

  root.render(
    <React.StrictMode>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </React.StrictMode>,
  );
}


// ============================================================
// 06 — BOOTSTRAP EXECUTION
// ============================================================

bootstrapApplication();


// ============================================================
// END OF REACT APPLICATION ENTRY POINT
// ============================================================
