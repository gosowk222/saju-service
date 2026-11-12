"use client";

import { List, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { buttonClass } from "@/components/ui/button";
import { Badge } from "@/components/ui/layout";
import type { ScrollSectionView } from "@/domain/mujin/types";
import { anchorId, sectionBadge, sectionEyebrow } from "./scroll-model";

/**
 * 족자 목차. 디자인 시스템이 사이드 내비를 두지 않으므로 머리글의 목차 버튼으로 바텀시트를 연다.
 * 바텀시트는 디자인 시스템 규격(radius-xl 위 모서리, shadow-float, duration-slow)을 따른다.
 * 현재 읽는 칸은 aria-current와 굵기로 표시한다 (하단 탭처럼 색만으로 구분하지 않는다).
 */

export const TOC_ID = "scroll-toc";

export function TocButton({ expanded, onOpen }: { expanded: boolean; onOpen: () => void }) {
  return (
    <button type="button" aria-haspopup="dialog" aria-expanded={expanded} aria-controls={TOC_ID} onClick={onOpen} className={buttonClass("ghost", "md", "shrink-0 px-4")}>
      <List size={18} aria-hidden />
      목차
    </button>
  );
}

function TocList({ sections, currentId, onPick }: { sections: readonly ScrollSectionView[]; currentId: string | null; onPick: (id: string) => void }) {
  return (
    <ol className="flex flex-col">
      {sections.map((section) => {
        const current = section.id === currentId;
        const badge = sectionBadge(section.state);
        return (
          <li key={section.id}>
            <a
              href={`#${anchorId(section.id)}`}
              aria-current={current ? "location" : undefined}
              onClick={(event) => {
                event.preventDefault();
                onPick(section.id);
              }}
              className={`motion-fast flex min-h-button-lg items-center gap-3 border-b border-gray-100 py-2 no-underline hover:text-gray-900 hover:no-underline ${
                current ? "text-gray-900" : "text-gray-700"
              }`}
            >
              <span className="w-9 shrink-0 type-caption-sm text-gray-600">{sectionEyebrow(section)}</span>
              <span className={`min-w-0 flex-1 wrap-break-word type-label ${current ? "font-semibold" : "font-normal"}`}>{section.title}</span>
              {section.kind === "chart" ? null : <Badge tone={badge.tone}>{badge.label}</Badge>}
            </a>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * 목차 바텀시트. 브라우저의 모달 대화상자(dialog)를 써서 포커스 가두기와 Esc 닫기를 맡긴다.
 * 칸을 고르면 시트를 닫고 onSelect로 그 칸의 위치를 알린다 (이동과 포커스는 화면이 한다).
 */
export function TocSheet({
  open,
  onClose,
  sections,
  currentId,
  onSelect,
}: {
  open: boolean;
  onClose: () => void;
  sections: readonly ScrollSectionView[];
  currentId: string | null;
  onSelect: (id: string) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      id={TOC_ID}
      ref={ref}
      aria-labelledby={`${TOC_ID}-title`}
      onClose={onClose}
      onClick={(event) => {
        // 시트 바깥(배경)을 누르면 닫는다.
        if (event.target === event.currentTarget) event.currentTarget.close();
      }}
      className="animate-sheet mx-auto mb-0 mt-auto w-full max-w-content rounded-t-xl border-0 bg-white p-0 text-gray-900 shadow-float"
    >
      <div className="flex flex-col gap-2 px-5 pt-5 pb-safe">
        <div className="flex items-center justify-between gap-3">
          <h2 id={`${TOC_ID}-title`} className="type-title">
            목차
          </h2>
          <button
            type="button"
            aria-label="목차 닫기"
            onClick={() => ref.current?.close()}
            className="motion-fast inline-flex h-button w-button shrink-0 items-center justify-center rounded-full text-gray-700 hover:bg-gray-100"
          >
            <X size={22} aria-hidden />
          </button>
        </div>
        <div className="pb-5">
          <TocList
            sections={sections}
            currentId={currentId}
            onPick={(id) => {
              ref.current?.close();
              onSelect(id);
            }}
          />
        </div>
      </div>
    </dialog>
  );
}
