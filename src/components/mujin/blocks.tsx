import { Square } from "lucide-react";
import type { ReactNode } from "react";
import { RichText } from "@/components/rich-text";
import type { ScrollBlock, ScrollSectionContent } from "@/domain/mujin/types";

/**
 * 족자 한 칸의 본문. 앱이 정한 구조 블록만 그린다. 모델이 쓴 글은 글자로만 넣고(**강조**만 굵게),
 * HTML로 해석하지 않는다. 블록 종류와 개수는 칸마다 다를 수 있다.
 * 본문은 모바일에서 읽기 좋은 body-lg(17/26), 보조 상자는 body(15/22)로 쓴다.
 */

/** 장 첫머리의 핵심 답. */
export function CoreAnswer({ text }: { text: string }) {
  return (
    <div className="flex flex-col gap-2 rounded-lg bg-primary-50 px-5 py-4">
      <p className="type-caption-sm text-primary-600">핵심 답</p>
      <p className="whitespace-pre-line wrap-break-word type-body-lg font-medium text-gray-900">
        <RichText text={text} />
      </p>
    </div>
  );
}

function Paragraph({ text, className }: { text: string; className: string }) {
  return (
    <p className={`whitespace-pre-line wrap-break-word ${className}`}>
      <RichText text={text} />
    </p>
  );
}

/** 이름표가 붙은 보조 상자 (근거, 조건과 한계, 생활 적용). */
function LabeledBox({ label, className, children }: { label: string; className: string; children: ReactNode }) {
  return (
    <div className={`flex flex-col gap-2 rounded-md px-4 py-4 ${className}`}>
      <p className="type-caption-sm text-gray-600">{label}</p>
      {children}
    </div>
  );
}

function BlockView({ block }: { block: ScrollBlock }) {
  switch (block.type) {
    case "paragraph":
      return <Paragraph text={block.text} className="type-body-lg text-gray-900" />;
    case "basis":
      return (
        <LabeledBox label="이렇게 읽은 근거" className="bg-gray-50">
          <Paragraph text={block.text} className="type-body text-gray-700" />
        </LabeledBox>
      );
    case "condition":
      return (
        <LabeledBox label="조건과 한계" className="border border-gray-200 bg-white">
          <Paragraph text={block.text} className="type-body text-gray-900" />
        </LabeledBox>
      );
    case "apply":
      return (
        <LabeledBox label="생활에 적용하기" className="border border-primary-200 bg-white">
          <Paragraph text={block.text} className="type-body text-gray-900" />
        </LabeledBox>
      );
    case "compare":
      return (
        <div className="flex flex-col gap-3">
          {block.text ? <Paragraph text={block.text} className="type-body-lg text-gray-900" /> : null}
          {block.items.length ? (
            <dl className="grid gap-3 desktop:grid-cols-2">
              {block.items.map((item, index) => (
                <div key={`${item.label}-${index}`} className="flex flex-col gap-1 rounded-md border border-gray-200 bg-white px-4 py-4">
                  <dt className="wrap-break-word type-label font-semibold text-gray-900">{item.label}</dt>
                  <dd className="whitespace-pre-line wrap-break-word type-body text-gray-700">
                    <RichText text={item.text} />
                  </dd>
                </div>
              ))}
            </dl>
          ) : null}
        </div>
      );
    case "checklist":
      return (
        <LabeledBox label="점검해 볼 것" className="border border-gray-200 bg-white">
          {block.text ? <Paragraph text={block.text} className="type-body text-gray-900" /> : null}
          {block.items.length ? (
            <ul className="flex flex-col gap-2">
              {block.items.map((item, index) => (
                <li key={`${item.text}-${index}`} className="flex items-start gap-3 type-body text-gray-900">
                  <Square size={18} aria-hidden className="mt-1 shrink-0 text-gray-500" />
                  <span className="min-w-0 whitespace-pre-line wrap-break-word">
                    {item.label ? <strong className="font-semibold">{item.label} </strong> : null}
                    <RichText text={item.text} />
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </LabeledBox>
      );
    case "scene":
      // 가정해 보는 생활 장면. 메신저 장면 말풍선처럼 제목 없이 옅은 보라 면과 왼쪽 선으로만 구분하고,
      // 장면이라는 점은 가정하는 말투가 드러낸다. 색을 볼 수 없는 사용자에게만 화면 밖 글자로 알린다.
      // 왼쪽 선은 1px이다. 디자인 시스템은 면을 1px 테두리로 나누고 2px는 포커스·일간 강조·선택에만 쓴다 (docs/DESIGN_NOTES.md).
      return (
        <div className="rounded-r-md border-l border-primary-300 bg-primary-50 px-4 py-4">
          <span className="sr-only">가정해 보는 장면: </span>
          <Paragraph text={block.text} className="type-body text-gray-900" />
        </div>
      );
  }
}

/** 핵심 답 다음의 블록 목록. 표는 핵심 답과 블록 사이에 화면이 넣는다. */
export function SectionBlocks({ content }: { content: ScrollSectionContent }) {
  return (
    <div className="flex flex-col gap-5">
      {content.blocks.map((block, index) => (
        <BlockView key={index} block={block} />
      ))}
    </div>
  );
}
