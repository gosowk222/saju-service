import { ChevronLeft } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

export function PageHeader({ title, backHref, right }: { title?: ReactNode; backHref?: string; right?: ReactNode }) {
  return (
    <header className="sticky top-0 z-10 flex h-header shrink-0 items-center gap-2 border-b border-gray-100 bg-white px-3">
      {backHref ? (
        <Link
          href={backHref}
          aria-label="뒤로"
          className="inline-flex h-button w-button shrink-0 items-center justify-center text-gray-900 hover:text-gray-900"
        >
          <ChevronLeft size={22} aria-hidden />
        </Link>
      ) : null}
      <div className="min-w-0 flex-1 truncate type-title">{title}</div>
      {right}
    </header>
  );
}

export function Screen({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <main className={`flex flex-1 flex-col gap-7 px-5 py-6 ${className}`}>{children}</main>;
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <section className={`rounded-lg border border-gray-200 bg-white p-5 ${className}`}>{children}</section>;
}

export function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "progress" | "success" | "danger" | "warning";
}) {
  const tones = {
    neutral: "bg-gray-100 text-gray-700",
    progress: "bg-primary-100 text-primary-600",
    success: "bg-green-50 text-green-600",
    danger: "bg-rose-50 text-rose-600",
    warning: "bg-gold-50 text-gold-700",
  };
  return <span className={`inline-flex h-7 items-center rounded-sm px-3 type-caption-sm ${tones[tone]}`}>{children}</span>;
}

export function Notice({ children, tone = "info" }: { children: ReactNode; tone?: "info" | "danger" | "warning" }) {
  const tones = {
    info: "bg-primary-50 text-gray-700",
    danger: "bg-rose-50 text-rose-600",
    warning: "bg-gold-50 text-gold-700",
  };
  return (
    <p role={tone === "danger" ? "alert" : undefined} className={`rounded-md px-4 py-4 type-label font-normal ${tones[tone]}`}>
      {children}
    </p>
  );
}

export function LoadingScreen({ label = "불러오는 중이에요" }: { label?: string }) {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-3 px-5 py-11 text-gray-600" aria-busy="true">
      <TypingDots />
      <p className="type-label font-normal">{label}</p>
    </main>
  );
}

export function TypingDots() {
  return (
    <span className="inline-flex items-center gap-2" aria-hidden>
      <span className="h-2 w-2 rounded-full bg-gray-400" />
      <span className="h-2 w-2 rounded-full bg-gray-400" />
      <span className="h-2 w-2 rounded-full bg-gray-400" />
    </span>
  );
}

export function EmptyState({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 px-5 py-11 text-center">
      <p className="type-title text-gray-900">{title}</p>
      {description ? <p className="type-body text-gray-600">{description}</p> : null}
      {action ? <div className="mt-3">{action}</div> : null}
    </div>
  );
}

export function PersonaAvatar({ glyph, large = false }: { glyph: string; large?: boolean }) {
  return (
    <span
      aria-hidden
      className={`inline-flex shrink-0 items-center justify-center rounded-full bg-primary-100 font-serif text-primary-700 ${
        large ? "h-tile w-tile type-h3" : "h-9 w-9 type-label"
      }`}
    >
      {glyph}
    </span>
  );
}
