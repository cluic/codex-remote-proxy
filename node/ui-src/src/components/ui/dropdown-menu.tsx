"use client";

import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export const DropdownMenu = MenuPrimitive.Root;
export const DropdownMenuTrigger = MenuPrimitive.Trigger;

export function DropdownMenuContent({ className, children, side = "bottom", sideOffset = 6, align = "end", ...props }: MenuPrimitive.Popup.Props & Pick<MenuPrimitive.Positioner.Props, "side" | "sideOffset" | "align">) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Positioner side={side} sideOffset={sideOffset} align={align} className="z-50">
        <MenuPrimitive.Popup data-slot="dropdown-menu-content" className={cn("min-w-44 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-xl outline-none", className)} {...props}>{children}</MenuPrimitive.Popup>
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  );
}

export function DropdownMenuItem({ className, children, ...props }: MenuPrimitive.Item.Props & { className?: string; children: ReactNode }) {
  return <MenuPrimitive.Item className={cn("flex cursor-default items-center rounded-md px-2 py-1.5 text-sm outline-none focus:bg-accent data-disabled:opacity-50", className)} {...props}>{children}</MenuPrimitive.Item>;
}
