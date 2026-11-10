import Link from "next/link";
import type { ComponentProps } from "react";

export type ButtonVariant = "primary" | "secondary" | "tonal" | "ghost";
export type ButtonSize = "md" | "lg";

const BASE =
  "motion-fast pressable inline-flex items-center justify-center gap-2 rounded-pill px-6 type-label font-semibold no-underline hover:no-underline disabled:bg-gray-100 disabled:text-gray-500";

const VARIANTS: Readonly<Record<ButtonVariant, string>> = {
  primary: "bg-primary-600 text-white hover:bg-primary-700 hover:text-white",
  secondary: "border border-gray-200 bg-white text-gray-900 hover:border-gray-300 hover:text-gray-900",
  tonal: "bg-primary-100 text-primary-600 hover:bg-primary-200 hover:text-primary-700",
  ghost: "bg-transparent text-gray-700 hover:bg-gray-100 hover:text-gray-900",
};

const SIZES: Readonly<Record<ButtonSize, string>> = { md: "h-button", lg: "h-button-lg w-full" };

export function buttonClass(variant: ButtonVariant = "primary", size: ButtonSize = "md", extra = ""): string {
  return `${BASE} ${VARIANTS[variant]} ${SIZES[size]} ${extra}`.trim();
}

export function Button({
  variant,
  size,
  className = "",
  type = "button",
  ...props
}: ComponentProps<"button"> & { variant?: ButtonVariant; size?: ButtonSize }) {
  return <button type={type} className={buttonClass(variant, size, className)} {...props} />;
}

export function LinkButton({
  variant,
  size,
  className = "",
  ...props
}: ComponentProps<typeof Link> & { variant?: ButtonVariant; size?: ButtonSize }) {
  return <Link className={buttonClass(variant, size, className)} {...props} />;
}
