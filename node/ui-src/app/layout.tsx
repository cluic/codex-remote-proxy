import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

import { ClientProviders } from "./client-providers";
import "./globals.css";

export const metadata: Metadata = {
  description: "Local management console for Codex Remote Proxy"
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  colorScheme: "light",
  themeColor: "#f4f6f4"
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" aria-busy="true">
      <body>
        <ClientProviders>{children}</ClientProviders>
        <noscript>CRP requires JavaScript. CRP 需要启用 JavaScript。</noscript>
      </body>
    </html>
  );
}
