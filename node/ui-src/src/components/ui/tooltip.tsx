"use client";

import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export function TooltipProvider({ children, ...props }: TooltipPrimitive.Provider.Props & { children: ReactNode }) {
  return <TooltipPrimitive.Provider delay={300} {...props}>{children}</TooltipPrimitive.Provider>;
}

export const Tooltip = TooltipPrimitive.Root;
export const TooltipTrigger = TooltipPrimitive.Trigger;

export function TooltipContent({ className, children, ...props }: TooltipPrimitive.Popup.Props & Pick<TooltipPrimitive.Positioner.Props, "side" | "sideOffset" | "align"> & { children: ReactNode }) {
  const { side = "top", sideOffset = 6, align = "center" } = props;
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Positioner side={side} sideOffset={sideOffset} align={align} className="z-50">
        <TooltipPrimitive.Popup data-slot="tooltip-content" className={cn("max-w-60 rounded-md bg-foreground px-2 py-1 text-xs text-background shadow-lg", className)}>
          {children}
        </TooltipPrimitive.Popup>
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  );
}
