"use client";

import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export function Dialog({ children, ...props }: DialogPrimitive.Root.Props & { children: ReactNode }) {
  return <DialogPrimitive.Root data-slot="dialog" {...props}>{children}</DialogPrimitive.Root>;
}

export function DialogContent({ className, children, ...props }: DialogPrimitive.Popup.Props & { children: ReactNode }) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Backdrop data-slot="dialog-backdrop" className="fixed inset-0 z-50 bg-black/25 backdrop-blur-[1px]" />
      <DialogPrimitive.Popup data-slot="dialog-content" className={cn("fixed top-1/2 left-1/2 z-50 max-h-[92vh] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-2xl", className)} {...props}>
        {children}
      </DialogPrimitive.Popup>
    </DialogPrimitive.Portal>
  );
}

export const DialogTitle = DialogPrimitive.Title;
export const DialogDescription = DialogPrimitive.Description;
export const DialogClose = DialogPrimitive.Close;
