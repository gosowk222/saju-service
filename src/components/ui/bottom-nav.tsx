"use client";

import { Compass, Home, Library, User } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/home", label: "홈", icon: Home },
  { href: "/products", label: "탐색", icon: Compass },
  { href: "/library", label: "보관함", icon: Library },
  { href: "/my", label: "마이", icon: User },
] as const;

export function BottomNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="주요 메뉴" className="sticky bottom-0 z-10 border-t border-gray-200 bg-white pb-safe">
      <ul className="grid h-tab-bar grid-cols-4">
        {TABS.map(({ href, label, icon: Icon }) => {
          const active = pathname === href || pathname.startsWith(`${href}/`);
          return (
            <li key={href}>
              <Link
                href={href}
                aria-current={active ? "page" : undefined}
                className={`flex h-full flex-col items-center justify-center gap-1 type-caption-sm hover:no-underline ${
                  active ? "font-semibold text-gray-900 hover:text-gray-900" : "text-gray-600 hover:text-gray-900"
                }`}
              >
                <Icon size={22} strokeWidth={2} aria-hidden />
                {label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
