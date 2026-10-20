
/**
 * ============================================================
 * SINUS VIEWER — TAILWIND DESIGN SYSTEM
 * ============================================================
 *
 * Professional Medical Imaging Workstation
 * Theme: Dark Radiology Interface
 * Tailwind CSS: v3
 *
 * This file defines design tokens only.
 * Actual component layouts are implemented separately.
 * ============================================================
 */

import type { Config } from "tailwindcss";

const config = {
  darkMode: ["class"],

  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],

  theme: {
    container: {
      center: true,
      padding: {
        DEFAULT: "1rem",
        sm: "1.5rem",
        lg: "2rem",
        xl: "2.5rem",
      },
      screens: {
        "2xl": "1440px",
      },
    },

    extend: {
      // ------------------------------------------------------
      // COLOR SYSTEM
      // ------------------------------------------------------

      colors: {
        border: "hsl(var(--border) / <alpha-value>)",
        input: "hsl(var(--input) / <alpha-value>)",
        ring: "hsl(var(--ring) / <alpha-value>)",

        background: "hsl(var(--background) / <alpha-value>)",
        foreground: "hsl(var(--foreground) / <alpha-value>)",

        card: {
          DEFAULT: "hsl(var(--card) / <alpha-value>)",
          foreground: "hsl(var(--card-foreground) / <alpha-value>)",
        },

        popover: {
          DEFAULT: "hsl(var(--popover) / <alpha-value>)",
          foreground: "hsl(var(--popover-foreground) / <alpha-value>)",
        },

        primary: {
          DEFAULT: "hsl(var(--primary) / <alpha-value>)",
          foreground: "hsl(var(--primary-foreground) / <alpha-value>)",
        },

        secondary: {
          DEFAULT: "hsl(var(--secondary) / <alpha-value>)",
          foreground: "hsl(var(--secondary-foreground) / <alpha-value>)",
        },

        muted: {
          DEFAULT: "hsl(var(--muted) / <alpha-value>)",
          foreground: "hsl(var(--muted-foreground) / <alpha-value>)",
        },

        accent: {
          DEFAULT: "hsl(var(--accent) / <alpha-value>)",
          foreground: "hsl(var(--accent-foreground) / <alpha-value>)",
        },

        destructive: {
          DEFAULT: "hsl(var(--destructive) / <alpha-value>)",
          foreground: "hsl(var(--destructive-foreground) / <alpha-value>)",
        },

        // Fixed medical viewer colors.
        radiology: {
          canvas: "#080D16",
          shell: "#101722",
          panel: "#172233",
          elevated: "#1D2B3D",
          hover: "#26364A",
          border: "#354051",

          cyan: "#48C6D5",
          blue: "#5B9FE8",
          green: "#4FD1A1",
          amber: "#E9B96E",
          red: "#F07878",

          text: "#EDF3F9",
          subtext: "#BBC5D3",
          subtle: "#9DAABF",
        },

        viewport: {
          DEFAULT: "#000000",
          surface: "#080D16",
          frame: "#26364A",
          crosshair: "#48C6D5",
          axial: "#F07878",
          coronal: "#4FD1A1",
          sagittal: "#E9B96E",
        },

        status: {
          success: "#4FD1A1",
          warning: "#E9B96E",
          error: "#F07878",
          info: "#5B9FE8",
        },
      },

      // ------------------------------------------------------
      // FONT SYSTEM
      // ------------------------------------------------------

      fontFamily: {
        sans: [
          "Inter",
          "Segoe UI",
          "Arial",
          "sans-serif",
        ],
        mono: [
          "JetBrains Mono",
          "Consolas",
          "monospace",
        ],
      },

      fontSize: {
        "2xs": ["0.625rem", { lineHeight: "0.875rem" }],
        "3xs": ["0.5625rem", { lineHeight: "0.75rem" }],
      },

      // ------------------------------------------------------
      // BORDER RADIUS
      // ------------------------------------------------------

      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
        xl: "0.875rem",
        "2xl": "1rem",
      },

      // ------------------------------------------------------
      // WORKSTATION LAYOUT DIMENSIONS
      // ------------------------------------------------------

      spacing: {
        "sidebar": "16rem",
        "sidebar-collapsed": "4rem",
        "app-header": "3.75rem",
        "app-status": "1.75rem",
        "viewer-toolbar": "3rem",
      },

      minHeight: {
        viewport: "16rem",
        workstation: "calc(100dvh - 5.5rem)",
      },

      maxHeight: {
        workstation: "calc(100dvh - 5.5rem)",
      },

      gridTemplateColumns: {
        "viewer-2": "repeat(2, minmax(0, 1fr))",
        "viewer-sidebar": "16rem minmax(0, 1fr)",
      },

      // ------------------------------------------------------
      // SHADOW SYSTEM
      // ------------------------------------------------------

      boxShadow: {
        panel: "0 8px 32px rgba(0, 0, 0, 0.18)",
        floating: "0 16px 48px rgba(0, 0, 0, 0.28)",
        viewport: "inset 0 0 0 1px rgba(255, 255, 255, 0.06)",
        focus: "0 0 0 3px rgba(72, 198, 213, 0.22)",
      },

      // ------------------------------------------------------
      // ANIMATION
      // ------------------------------------------------------

      keyframes: {
        "fade-in": {
          from: {
            opacity: "0",
          },
          to: {
            opacity: "1",
          },
        },

        "slide-in-right": {
          from: {
            opacity: "0",
            transform: "translateX(8px)",
          },
          to: {
            opacity: "1",
            transform: "translateX(0)",
          },
        },

        "pulse-soft": {
          "0%, 100%": {
            opacity: "1",
          },
          "50%": {
            opacity: "0.6",
          },
        },
      },

      animation: {
        "fade-in": "fade-in 180ms ease-out both",
        "slide-in-right": "slide-in-right 200ms ease-out both",
        "pulse-soft": "pulse-soft 1.8s ease-in-out infinite",
      },

      // ------------------------------------------------------
      // TRANSITION TIMING
      // ------------------------------------------------------

      transitionDuration: {
        "180": "180ms",
        "240": "240ms",
      },

      zIndex: {
        toolbar: "20",
        sidebar: "30",
        overlay: "40",
        modal: "50",
        toast: "60",
      },
    },
  },

  plugins: [],
} satisfies Config;

export default config;
