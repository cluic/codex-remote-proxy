"use client";

import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export const Sheet = DialogPrimitive.Root;
export const SheetTrigger = DialogPrimitive.Trigger;
export const SheetClose = DialogPrimitive.Close;

export function SheetContent({ className, children, side = "left", ...props }: DialogPrimitive.Popup.Props & { className?: string; children: ReactNode; side?: "left" | "right" }) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Backdrop data-slot="sheet-backdrop" className="fixed inset-0 z-50 bg-black/35" />
      <DialogPrimitive.Popup data-slot="sheet-content" data-side={side} className={cn("fixed inset-y-0 z-50 flex w-[min(19rem,86vw)] flex-col overflow-auto bg-sidebar text-sidebar-foreground shadow-2xl", side === "left" ? "left-0" : "right-0", className)} {...props}>
        {children}
      </DialogPrimitive.Popup>
    </DialogPrimitive.Portal>
  );
}
