import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "@/lib/utils"

/**
 * Filled buttons get a faint top-to-bottom sheen, an inner top highlight and a soft drop shadow so they read as
 * physical controls instead of flat colour blocks. Outline/secondary get a subtle inner highlight only.
 */
const FILLED =
  "bg-[linear-gradient(180deg,rgba(255,255,255,0.14),rgba(255,255,255,0)_58%)] shadow-[inset_0_1px_0_rgba(255,255,255,0.22),inset_0_-1px_0_rgba(0,0,0,0.22),0_1px_2px_rgba(0,0,0,0.35)] hover:brightness-110 active:brightness-95"
const RAISED = "shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_1px_1px_rgba(0,0,0,0.25)]"

const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-lg border border-transparent bg-clip-padding text-sm font-medium tracking-[0.01em] whitespace-nowrap transition-[background-color,border-color,color,box-shadow,transform,filter] duration-150 outline-none select-none focus-visible:ring-3 focus-visible:ring-ring/40 active:not-aria-[haspopup]:translate-y-px active:not-aria-[haspopup]:shadow-none disabled:pointer-events-none disabled:opacity-50 disabled:shadow-none aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: `bg-primary text-primary-foreground ${FILLED}`,
        outline: `border-foreground/15 bg-foreground/[0.04] text-foreground/90 ${RAISED} hover:border-foreground/25 hover:bg-foreground/[0.08] hover:text-foreground aria-expanded:bg-foreground/[0.08] aria-expanded:text-foreground`,
        secondary: `bg-secondary text-secondary-foreground ${RAISED} hover:bg-accent hover:text-foreground aria-expanded:bg-accent aria-expanded:text-foreground`,
        ghost:
          "text-foreground/80 hover:bg-foreground/[0.06] hover:text-foreground aria-expanded:bg-foreground/[0.06] aria-expanded:text-foreground",
        destructive:
          "bg-destructive/15 text-destructive hover:bg-destructive/25 focus-visible:ring-destructive/30",
        link: "text-primary underline-offset-4 hover:underline",
        // Domain variants: trading actions and platform-token highlights.
        up: `bg-up text-black ${FILLED}`,
        down: `bg-down text-white ${FILLED}`,
        gold: `bg-gold text-black ${FILLED}`,
        glow: "bg-primary bg-[linear-gradient(180deg,rgba(255,255,255,0.16),rgba(255,255,255,0)_58%)] text-primary-foreground shadow-glow hover:brightness-110 active:brightness-95",
      },
      size: {
        default:
          "h-8 gap-1.5 px-3 has-data-[icon=inline-end]:pr-2.5 has-data-[icon=inline-start]:pl-2.5",
        xs: "h-6 gap-1 rounded-[min(var(--radius-md),10px)] px-2 text-xs in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-7 gap-1 rounded-[min(var(--radius-md),12px)] px-2.5 text-[0.8rem] in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-9 gap-1.5 px-3.5 has-data-[icon=inline-end]:pr-2.5 has-data-[icon=inline-start]:pl-2.5",
        xl: "h-11 gap-2 rounded-xl px-5 text-base font-semibold",
        icon: "size-8",
        "icon-xs":
          "size-6 rounded-[min(var(--radius-md),10px)] in-data-[slot=button-group]:rounded-lg [&_svg:not([class*='size-'])]:size-3",
        "icon-sm":
          "size-7 rounded-[min(var(--radius-md),12px)] in-data-[slot=button-group]:rounded-lg",
        "icon-lg": "size-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
