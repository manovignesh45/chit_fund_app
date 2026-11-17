"use client"

import * as React from "react"
import * as SheetPrimitive from "@radix-ui/react-dialog"
import { cva, type VariantProps } from "class-variance-authority"
import { X } from "lucide-react"

import { cn } from "@/lib/utils"

const Sheet = SheetPrimitive.Root

const SheetTrigger = SheetPrimitive.Trigger

const SheetClose = SheetPrimitive.Close

const SheetPortal = SheetPrimitive.Portal

const SheetOverlay = React.forwardRef<
  React.ElementRef<typeof SheetPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof SheetPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <SheetPrimitive.Overlay
    className={cn(
      "fixed inset-0 z-50 bg-overlay/50 dark:bg-overlay/60 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
      className
    )}
    {...props}
    ref={ref}
  />
))
SheetOverlay.displayName = SheetPrimitive.Overlay.displayName

const sheetVariants = cva(
  "fixed z-50 gap-4 bg-popover p-6 text-popover-foreground shadow-lg transition ease-in-out data-[state=closed]:duration-200 data-[state=open]:duration-300 data-[state=open]:animate-in data-[state=closed]:animate-out",
  {
    variants: {
      side: {
        top: "inset-x-0 top-0 border-b data-[state=closed]:slide-out-to-top data-[state=open]:slide-in-from-top",
        bottom:
          "inset-x-0 bottom-0 max-h-[90dvh] overflow-y-auto rounded-t-xl border-t pb-[max(1.5rem,env(safe-area-inset-bottom))] data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom",
        left: "inset-y-0 left-0 h-full w-3/4 border-r data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left sm:max-w-sm",
        right:
          "inset-y-0 right-0 h-full w-3/4 border-l data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right sm:max-w-sm",
      },
    },
    defaultVariants: {
      side: "right",
    },
  }
)

interface SheetContentProps
  extends React.ComponentPropsWithoutRef<typeof SheetPrimitive.Content>,
    VariantProps<typeof sheetVariants> {}

/** Distance (px) or speed (px/ms) of a downward drag that closes a bottom sheet. */
const DISMISS_DISTANCE = 120
const DISMISS_VELOCITY = 0.5
const SNAP_MS = 200

/** Touches that start in these keep their own gestures (text selection, sliders). */
const NO_DRAG = 'textarea, input[type="range"], [contenteditable="true"], [data-sheet-no-drag]'

/** True when the touch starts inside something (other than the sheet) that is scrolled down. */
function insideScrolled(target: EventTarget | null, sheet: HTMLElement): boolean {
  let el = target instanceof Element ? target : null
  while (el && el !== sheet) {
    if (el.scrollTop > 0) return true
    el = el.parentElement
  }
  return false
}

/**
 * Bottom sheets: drag down from the top of the sheet to close it. The drag only starts when
 * the sheet is scrolled to the top and the finger moves mostly downwards, so scrolling the
 * sheet's content and horizontal gestures behave as before. Closing goes through the sheet's
 * own Close button, so `onOpenChange(false)` fires as for the X.
 */
function useSwipeToClose(sheet: HTMLElement | null, close: React.RefObject<HTMLButtonElement | null>, enabled: boolean) {
  React.useEffect(() => {
    if (!sheet || !enabled) return
    let startX = 0
    let startY = 0
    let startTime = 0
    let tracking = false
    let dragging = false
    let offset = 0

    const reset = () => {
      tracking = false
      dragging = false
      offset = 0
    }
    const onStart = (event: TouchEvent) => {
      reset()
      if (event.touches.length !== 1) return
      const target = event.target as Element | null
      if (target?.closest?.(NO_DRAG)) return
      if (sheet.scrollTop > 0 || insideScrolled(target, sheet)) return
      startX = event.touches[0].clientX
      startY = event.touches[0].clientY
      startTime = event.timeStamp
      tracking = true
    }
    const onMove = (event: TouchEvent) => {
      if (!tracking) return
      const dx = event.touches[0].clientX - startX
      const dy = event.touches[0].clientY - startY
      if (!dragging) {
        if (Math.abs(dy) < 8 && Math.abs(dx) < 8) return
        // Up, or sideways: not a dismiss gesture — leave it to the browser.
        if (dy <= 0 || Math.abs(dx) > Math.abs(dy)) {
          tracking = false
          return
        }
        dragging = true
        sheet.style.transition = 'none'
      }
      event.preventDefault()
      offset = Math.max(0, dy)
      sheet.style.transform = `translateY(${offset}px)`
    }
    const onEnd = (event: TouchEvent) => {
      if (!dragging) return reset()
      const velocity = offset / Math.max(1, event.timeStamp - startTime)
      const dismiss = offset > Math.min(DISMISS_DISTANCE, sheet.offsetHeight * 0.4) || (velocity > DISMISS_VELOCITY && offset > 24)
      sheet.style.transition = `transform ${SNAP_MS}ms ease-out`
      if (dismiss) {
        sheet.style.transform = 'translateY(100%)'
        // Already off screen: skip the close animation, which would start from the top again.
        window.setTimeout(() => {
          sheet.style.animation = 'none'
          close.current?.click()
        }, SNAP_MS)
      } else {
        sheet.style.transform = ''
      }
      reset()
    }

    sheet.addEventListener('touchstart', onStart, { passive: true })
    sheet.addEventListener('touchmove', onMove, { passive: false })
    sheet.addEventListener('touchend', onEnd)
    sheet.addEventListener('touchcancel', onEnd)
    return () => {
      sheet.removeEventListener('touchstart', onStart)
      sheet.removeEventListener('touchmove', onMove)
      sheet.removeEventListener('touchend', onEnd)
      sheet.removeEventListener('touchcancel', onEnd)
    }
  }, [sheet, close, enabled])
}

const SheetContent = React.forwardRef<
  React.ElementRef<typeof SheetPrimitive.Content>,
  SheetContentProps
>(({ side = "right", className, children, ...props }, ref) => {
  const bottom = side === "bottom"
  const closeRef = React.useRef<HTMLButtonElement>(null)
  const [node, setNode] = React.useState<HTMLDivElement | null>(null)
  const setRefs = React.useCallback(
    (el: HTMLDivElement | null) => {
      setNode(el)
      if (typeof ref === "function") ref(el)
      else if (ref) ref.current = el
    },
    [ref]
  )
  useSwipeToClose(node, closeRef, bottom)

  return (
    <SheetPortal>
      <SheetOverlay />
      <SheetPrimitive.Content
        ref={setRefs}
        className={cn(sheetVariants({ side }), className)}
        {...props}
      >
        {bottom ? (
          // Grab handle: shows the sheet can be dragged down to close.
          <div aria-hidden="true" className="pointer-events-none absolute left-1/2 top-2 h-1.5 w-10 -translate-x-1/2 rounded-full bg-muted-foreground/30" />
        ) : null}
        <SheetPrimitive.Close ref={closeRef} className="absolute right-2 top-2 inline-flex h-11 w-11 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none md:right-3 md:top-3 md:h-8 md:w-8">
          <X className="h-4 w-4" />
          <span className="sr-only">Close</span>
        </SheetPrimitive.Close>
        {children}
      </SheetPrimitive.Content>
    </SheetPortal>
  )
})
SheetContent.displayName = SheetPrimitive.Content.displayName

const SheetHeader = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex flex-col space-y-2 text-center sm:text-left",
      className
    )}
    {...props}
  />
)
SheetHeader.displayName = "SheetHeader"

const SheetFooter = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex flex-col-reverse gap-2 sm:flex-row sm:justify-end",
      className
    )}
    {...props}
  />
)
SheetFooter.displayName = "SheetFooter"

const SheetTitle = React.forwardRef<
  React.ElementRef<typeof SheetPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof SheetPrimitive.Title>
>(({ className, ...props }, ref) => (
  <SheetPrimitive.Title
    ref={ref}
    className={cn("text-lg font-semibold text-foreground", className)}
    {...props}
  />
))
SheetTitle.displayName = SheetPrimitive.Title.displayName

const SheetDescription = React.forwardRef<
  React.ElementRef<typeof SheetPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof SheetPrimitive.Description>
>(({ className, ...props }, ref) => (
  <SheetPrimitive.Description
    ref={ref}
    className={cn("text-sm text-muted-foreground", className)}
    {...props}
  />
))
SheetDescription.displayName = SheetPrimitive.Description.displayName

export {
  Sheet,
  SheetPortal,
  SheetOverlay,
  SheetTrigger,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetFooter,
  SheetTitle,
  SheetDescription,
}
