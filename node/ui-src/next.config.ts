import type { NextConfig } from "next";
import { resolve } from "node:path";

const buildId = process.env.CRP_UI_BUILD_ID;

const nextConfig: NextConfig = {
  output: "export",
  distDir: process.env.CRP_UI_DIST_DIR ?? ".next",
  trailingSlash: false,
  devIndicators: false,
  turbopack: { root: resolve(import.meta.dirname, "..") },
  generateBuildId: async () => {
    if (!buildId) throw new Error("CRP_UI_BUILD_ID is required for a reproducible UI build.");
    return buildId;
  }
};

export default nextConfig;
