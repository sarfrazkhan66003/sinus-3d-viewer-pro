
/**
 * ============================================================
 * SINUS VIEWER — POSTCSS CONFIGURATION
 * ============================================================
 *
 * Application : Sinus Viewer
 * Frontend    : React 19 + TypeScript + Vite 6
 * CSS Engine  : Tailwind CSS v3 + PostCSS
 *
 * PURPOSE:
 * - Generate Tailwind utility classes
 * - Add browser-compatible CSS vendor prefixes
 * - Process production CSS through Vite
 *
 * DEPLOYMENT:
 * - No local dependency installation
 * - CSS compilation happens in Google Colab
 *
 * ============================================================
 */

import tailwindcss from "tailwindcss";
import autoprefixer from "autoprefixer";

/**
 * PostCSS configuration.
 *
 * Plugin execution order:
 *
 * 1. Tailwind CSS
 *    Expands @tailwind directives and utility classes.
 *
 * 2. Autoprefixer
 *    Adds necessary vendor prefixes based on
 *    supported browser targets.
 *
 * Vite performs production CSS bundling and minification
 * when the frontend production build is executed.
 */

const config = {
  plugins: [
    tailwindcss({
      config: "./tailwind.config.ts",
    }),

    autoprefixer(),
  ],
};

export default config;
