"use client";

import { CSPProvider } from "@base-ui/react/csp-provider";
import type { ReactNode } from "react";

import { CrpApp } from "@/app";
import { TooltipProvider } from "@/components/ui/tooltip";

export function ClientProviders({ children }: { children: ReactNode }) {
  return (
    <CSPProvider disableStyleElements>
      <TooltipProvider><CrpApp>{children}</CrpApp></TooltipProvider>
    </CSPProvider>
  );
}
