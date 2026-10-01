/**
 * Overlays: Dialog, ConfirmDialog, Drawer (side panel; bottom sheet on phones), Popover,
 * Menu (dropdown) and Tooltip. All built on Radix for focus management and keyboard support.
 */
import { X } from "lucide-react";
import { Dialog as D, DropdownMenu as M, Popover as P, Tooltip as T } from "radix-ui";
import { useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Button, type ButtonVariant } from "./Button";

/* ------------------------------------------------------------------ Dialog */

export interface DialogProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  trigger?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg" | "xl";
  /** Hide the close (×) button, e.g. while a request is running. */
  hideClose?: boolean;
}

const dialogWidths = { sm: "sm:max-w-md", md: "sm:max-w-lg", lg: "sm:max-w-2xl", xl: "sm:max-w-4xl" };

export function Dialog({ open, onOpenChange, trigger, title, description, children, footer, size = "md", hideClose }: DialogProps) {
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      {trigger ? <D.Trigger asChild>{trigger}</D.Trigger> : null}
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-50 bg-ink/30 animate-fade-in" />
        <D.Content
          className={cn(
            "fixed z-50 flex max-h-[92dvh] w-full flex-col bg-surface shadow-pop outline-none",
            // phone: bottom sheet; larger screens: centred dialog
            "inset-x-0 bottom-0 rounded-t-xl animate-sheet-in safe-bottom",
            "sm:inset-x-auto sm:bottom-auto sm:left-1/2 sm:top-1/2 sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-xl sm:animate-pop-in",
            dialogWidths[size],
          )}
        >
          <div className="flex items-start gap-4 border-b border-line px-5 pb-4 pt-5 sm:px-6">
            <div className="min-w-0 flex-1">
              <D.Title className="text-xl font-semibold text-ink">{title}</D.Title>
              {description ? (
                <D.Description className="mt-1 text-sm text-ink-3">{description}</D.Description>
              ) : (
                <D.Description className="sr-only">{typeof title === "string" ? title : "Dialog"}</D.Description>
              )}
            </div>
            {!hideClose && (
              <D.Close asChild>
                <button
                  type="button"
                  aria-label="Close"
                  className="-mr-2 -mt-1 grid size-9 place-items-center rounded-md text-ink-3 hover:bg-hover hover:text-ink"
                >
                  <X className="size-5" />
                </button>
              </D.Close>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-6">{children}</div>
          {footer ? (
            <div className="flex flex-col-reverse gap-2 border-t border-line px-5 py-4 sm:flex-row sm:justify-end sm:px-6">
              {footer}
            </div>
          ) : null}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

export const DialogClose = D.Close;

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  variant?: Extract<ButtonVariant, "primary" | "danger">;
  loading?: boolean;
  disabled?: boolean;
  onConfirm: () => void;
}

/** A decision a person must make on purpose. Never pre-confirmed. */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  confirmLabel,
  cancelLabel = "Cancel",
  variant = "primary",
  loading,
  disabled,
  onConfirm,
}: ConfirmDialogProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !loading && onOpenChange(o)}
      title={title}
      description={description}
      size="sm"
      hideClose={loading}
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={loading}>
            {cancelLabel}
          </Button>
          <Button variant={variant} onClick={onConfirm} loading={loading} disabled={disabled}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
    </Dialog>
  );
}

/* ------------------------------------------------------------------ Drawer */

export interface DrawerProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  trigger?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  width?: "md" | "lg";
}

/** Side panel on desktop, bottom sheet on phones. */
export function Drawer({ open, onOpenChange, trigger, title, description, children, footer, width = "md" }: DrawerProps) {
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      {trigger ? <D.Trigger asChild>{trigger}</D.Trigger> : null}
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-50 bg-ink/25 animate-fade-in" />
        <D.Content
          className={cn(
            "fixed z-50 flex flex-col bg-surface shadow-pop outline-none",
            "inset-x-0 bottom-0 max-h-[92dvh] rounded-t-xl animate-sheet-in safe-bottom",
            "md:inset-y-0 md:left-auto md:right-0 md:max-h-none md:rounded-none md:animate-drawer-in",
            width === "lg" ? "md:w-[min(720px,92vw)]" : "md:w-[min(480px,92vw)]",
          )}
        >
          <div className="flex items-start gap-4 border-b border-line px-5 pb-4 pt-5">
            <div className="min-w-0 flex-1">
              <D.Title className="text-lg font-semibold text-ink">{title}</D.Title>
              {description ? (
                <D.Description className="mt-1 text-sm text-ink-3">{description}</D.Description>
              ) : (
                <D.Description className="sr-only">{typeof title === "string" ? title : "Panel"}</D.Description>
              )}
            </div>
            <D.Close asChild>
              <button
                type="button"
                aria-label="Close"
                className="-mr-2 -mt-1 grid size-9 place-items-center rounded-md text-ink-3 hover:bg-hover hover:text-ink"
              >
                <X className="size-5" />
              </button>
            </D.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">{children}</div>
          {footer ? <div className="flex gap-2 border-t border-line px-5 py-4">{footer}</div> : null}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

/* ------------------------------------------------------------------ Popover */

export function Popover({
  trigger,
  children,
  align = "start",
  className,
  open,
  onOpenChange,
}: {
  trigger: ReactNode;
  children: ReactNode;
  align?: "start" | "center" | "end";
  className?: string;
  open?: boolean;
  onOpenChange?: (o: boolean) => void;
}) {
  return (
    <P.Root open={open} onOpenChange={onOpenChange}>
      <P.Trigger asChild>{trigger}</P.Trigger>
      <P.Portal>
        <P.Content
          align={align}
          sideOffset={6}
          collisionPadding={12}
          className={cn(
            "z-50 rounded-lg border border-line bg-surface p-3 shadow-pop outline-none animate-pop-in",
            className,
          )}
        >
          {children}
        </P.Content>
      </P.Portal>
    </P.Root>
  );
}

/* ------------------------------------------------------------------ Menu */

export interface MenuItem {
  label: ReactNode;
  icon?: ReactNode;
  onSelect?: () => void;
  danger?: boolean;
  disabled?: boolean;
  separatorBefore?: boolean;
}

export function Menu({ trigger, items, align = "end" }: { trigger: ReactNode; items: MenuItem[]; align?: "start" | "end" }) {
  return (
    <M.Root>
      <M.Trigger asChild>{trigger}</M.Trigger>
      <M.Portal>
        <M.Content
          align={align}
          sideOffset={6}
          collisionPadding={12}
          className="z-50 min-w-48 rounded-lg border border-line bg-surface p-1 shadow-pop animate-pop-in"
        >
          {items.map((item, i) => (
            <div key={i}>
              {item.separatorBefore && <M.Separator className="my-1 h-px bg-line" />}
              <M.Item
                disabled={item.disabled}
                onSelect={item.onSelect}
                className={cn(
                  "flex cursor-default items-center gap-2.5 rounded-md px-2.5 py-2 text-sm outline-none select-none",
                  "data-[highlighted]:bg-hover data-[disabled]:opacity-50 [&_svg]:size-4 [&_svg]:text-ink-3",
                  item.danger ? "text-block [&_svg]:text-block" : "text-ink",
                )}
              >
                {item.icon}
                {item.label}
              </M.Item>
            </div>
          ))}
        </M.Content>
      </M.Portal>
    </M.Root>
  );
}

/* ------------------------------------------------------------------ Tooltip */

export function TooltipProvider({ children }: { children: ReactNode }) {
  return (
    <T.Provider delayDuration={350} skipDelayDuration={150}>
      {children}
    </T.Provider>
  );
}

export function Tooltip({ content, children, side = "top" }: { content: ReactNode; children: ReactNode; side?: "top" | "bottom" | "left" | "right" }) {
  return (
    <T.Root>
      <T.Trigger asChild>{children}</T.Trigger>
      <T.Portal>
        <T.Content
          side={side}
          sideOffset={6}
          className="z-[60] max-w-xs rounded-md bg-ink px-2.5 py-1.5 text-xs text-white shadow-pop animate-fade-in"
        >
          {content}
        </T.Content>
      </T.Portal>
    </T.Root>
  );
}

/** Small state helper for dialogs opened from menus or rows. */
export function useDisclosure(initial = false) {
  const [open, setOpen] = useState(initial);
  return { open, setOpen, onOpen: () => setOpen(true), onClose: () => setOpen(false) };
}
