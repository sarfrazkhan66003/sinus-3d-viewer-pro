
/**
 * ============================================================
 * SINUS VIEWER — VITE CONFIGURATION
 * ============================================================
 *
 * Frontend:
 *   React 19 + TypeScript + Vite 6
 *
 * Medical Rendering:
 *   Cornerstone3D + vtk.js
 *
 * Deployment:
 *   Development: Vite
 *   Production: FastAPI serves the compiled frontend
 *   Hosting: Google Colab + authenticated external tunnel
 *
 * IMPORTANT:
 *   No software dependencies need to be installed locally.
 *   All npm installation and building happens in Colab.
 * ============================================================
 */

import { defineConfig, loadEnv, type UserConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

// ------------------------------------------------------------
// APPLICATION CONSTANTS
// ------------------------------------------------------------

const APP_NAME = "Sinus Viewer";
const FRONTEND_PORT = 5173;
const DEFAULT_BACKEND_URL = "http://127.0.0.1:8000";

// ------------------------------------------------------------
// PATH ALIAS HELPER
// ------------------------------------------------------------

function srcPath(relativePath: string): string {
  return fileURLToPath(
    new URL(`./src/${relativePath}`, import.meta.url)
  );
}

// ------------------------------------------------------------
// VITE CONFIGURATION
// ------------------------------------------------------------

export default defineConfig(({ mode }): UserConfig => {
  const env = loadEnv(mode, process.cwd(), "VITE_");

  const backendTarget =
    env.VITE_DEV_BACKEND_URL || DEFAULT_BACKEND_URL;

  const config: UserConfig = {
    // --------------------------------------------------------
    // APPLICATION BASE
    // --------------------------------------------------------

    base: "/",

    // --------------------------------------------------------
    // REACT PLUGIN
    // --------------------------------------------------------

    plugins: [
      react({
        jsxRuntime: "automatic",
      }),
    ],

    // --------------------------------------------------------
    // SOURCE PATH ALIASES
    // Keep synchronized with tsconfig.json
    // --------------------------------------------------------

    resolve: {
      alias: {
        "@": srcPath(""),
        "@components": srcPath("components"),
        "@pages": srcPath("pages"),
        "@viewer": srcPath("viewer"),
        "@services": srcPath("services"),
        "@store": srcPath("store"),
        "@types": srcPath("types"),
      },
      dedupe: [
        "react",
        "react-dom",
      ],
    },

    // --------------------------------------------------------
    // DEVELOPMENT SERVER
    // Not exposed directly through the public tunnel.
    // --------------------------------------------------------

    server: {
      host: "127.0.0.1",
      port: FRONTEND_PORT,
      strictPort: true,

      open: false,

      // Allow the backend to receive API requests in dev.
      proxy: {
        "/api": {
          target: backendTarget,
          changeOrigin: false,
          secure: true,
          ws: false,
        },
      },

      // Restrict the development file server.
      fs: {
        strict: true,
        deny: [
          ".env",
          ".env.*",
          "*.pem",
          "*.key",
          "*.p12",
          "*.dcm",
          "*.dicom",
          "*.nii",
          "*.nii.gz",
          "**/.git/**",
        ],
      },
    },

    // --------------------------------------------------------
    // PRODUCTION BUILD
    // FastAPI will serve the resulting dist directory.
    // --------------------------------------------------------

    build: {
      target: "es2022",

      outDir: "dist",

      assetsDir: "assets",

      emptyOutDir: true,

      sourcemap: false,

      minify: "esbuild",

      cssCodeSplit: true,

      modulePreload: {
        polyfill: true,
      },

      // Preserve worker compatibility for medical decoding.
      assetsInlineLimit: 0,

      chunkSizeWarningLimit: 1500,

      reportCompressedSize: true,
    },

    // --------------------------------------------------------
    // WEB WORKERS
    // Used by decoding and medical rendering libraries.
    // --------------------------------------------------------

    worker: {
      format: "es",
    },

    // --------------------------------------------------------
    // DEPENDENCY OPTIMIZATION
    // --------------------------------------------------------

    optimizeDeps: {
      include: [
        "react",
        "react-dom",
        "react-router-dom",
        "zustand",
      ],
    },

    // --------------------------------------------------------
    // GLOBAL BUILD CONSTANTS
    // --------------------------------------------------------

    define: {
      __APP_NAME__: JSON.stringify(APP_NAME),
      __APP_VERSION__: JSON.stringify("0.1.0"),
    },

    // --------------------------------------------------------
    // BUILD LOGGING
    // --------------------------------------------------------

    clearScreen: false,

    logLevel: "info",
  };

  return config;
});
