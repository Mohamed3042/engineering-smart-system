import { LoaderCircle } from "lucide-react";
import { Slot } from "radix-ui";
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Tooltip } from "./Overlay";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "quiet-danger" | "link";
export type ButtonSize = "sm" | "md" | "lg";

const base =
  "inline-flex items-center justify-center gap-2 whitespace-nowrap font-medium select-none transition-[background-color,border-color,color,box-shadow] duration-150 ease-out disabled:pointer-events-none disabled:opacity-50 [&_svg]:shrink-0";

const variants: Record<ButtonVariant, string> = {
  primary: "bg-brand text-white hover:bg-brand-hover active:bg-brand-press shadow-[0_1px_0_rgb(0_0_0/0.06)]",
  secondary: "bg-surface text-ink border border-line-strong hover:bg-hover active:bg-sunken",
  ghost: "text-ink-2 hover:bg-hover hover:text-ink active:bg-sunken",
  danger: "bg-block text-white hover:bg-[#9a1f18] active:bg-[#851a14]",
  "quiet-danger": "text-block hover:bg-block-soft",
  link: "text-brand-ink underline-offset-4 hover:underline px-0! h-auto!",
};

const sizes: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-sm rounded-md [&_svg]:size-4",
  md: "h-10 px-4 text-[0.9375rem] rounded-md [&_svg]:size-[1.125rem]",
  lg: "h-12 px-5 text-base rounded-lg [&_svg]:size-5",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  /** Render the child element (e.g. a router <Link>) with button styles. */
  asChild?: boolean;
  icon?: ReactNode;
  iconRight?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "primary", size = "md", loading, asChild, icon, iconRight, className, children, disabled, type, ...rest },
  ref,
) {
  const cls = cn(base, variants[variant], sizes[size], className);
  if (asChild) {
    return (
      <Slot.Root ref={ref} className={cls} {...rest}>
        {children}
      </Slot.Root>
    );
  }
  return (
    <button
      ref={ref}
      type={type ?? "button"}
      className={cls}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <LoaderCircle className="animate-spin" aria-hidden /> : icon}
      {children}
      {iconRight}
    </button>
  );
});

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  variant?: "ghost" | "secondary" | "primary";
  size?: "sm" | "md";
  tooltip?: boolean;
}

/** Icon-only button. `label` is required: it becomes the accessible name and the tooltip. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, variant = "ghost", size = "md", tooltip = true, className, children, type, ...rest },
  ref,
) {
  const btn = (
    <button
      ref={ref}
      type={type ?? "button"}
      aria-label={label}
      className={cn(
        base,
        variants[variant],
        size === "sm" ? "size-8 rounded-md [&_svg]:size-4" : "size-10 rounded-md [&_svg]:size-5",
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
  return tooltip ? <Tooltip content={label}>{btn}</Tooltip> : btn;
});
