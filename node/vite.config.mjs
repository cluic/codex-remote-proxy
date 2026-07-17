import { resolve } from "node:path";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const LEGAL_BANNER = `/*! CRP bundled third-party notices:
 * React and ReactDOM - MIT License - Copyright Meta Platforms, Inc. and affiliates.
 * Lucide - ISC License - Copyright Lucide Contributors.
 * SPDX-License-Identifier: MIT AND ISC
 */`;

export default defineConfig({
  root: resolve(import.meta.dirname, "ui-src"),
  publicDir: false,
  base: "/",
  plugins: [react()],
  build: {
    outDir: resolve(import.meta.dirname, "ui"),
    emptyOutDir: true,
    target: "es2022",
    sourcemap: false,
    cssCodeSplit: false,
    manifest: false,
    modulePreload: false,
    assetsInlineLimit: 0,
    rollupOptions: {
      output: {
        codeSplitting: false,
        entryFileNames: "app.js",
        chunkFileNames: "app.js",
        assetFileNames: (assetInfo) => assetInfo.names?.some((name) => name.endsWith(".css"))
          ? "styles.css"
          : "[name][extname]",
        postBanner: LEGAL_BANNER
      }
    }
  }
});
