import { Lock } from "lucide-react";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { ChartTable } from "@/components/chart-table";
import { PurchaseButton } from "@/components/purchase-button";
import { LinkButton } from "@/components/ui/button";
import { Card, LoadingScreen, Notice, PageHeader, PersonaAvatar } from "@/components/ui/layout";
import { BRANCH_OPTIONS } from "@/domain/birth/input";
import { parseIsoDate, formatKoreanDate } from "@/domain/birth/date";
import { findPersona } from "@/domain/personas";
import { findProduct, formatPrice } from "@/domain/products";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { requirePageUser } from "@/server/auth";
import { getEntitlement, getReading, type ReadingRow } from "@/server/readings/store";

function birthSummary(reading: ReadingRow): string {
  const { birth_input: birth, place_snapshot: place } = reading;
  const date = formatKoreanDate(parseIsoDate(birth.birthDate));
  const calendar = birth.calendar.type === "solar" ? "양력" : birth.calendar.isLeapMonth ? "음력 윤달" : "음력";
  const time =
    birth.birthTime.status === "unknown"
      ? "시간 모름"
      : (BRANCH_OPTIONS.find((option) => option.value === (birth.birthTime as { branch: string }).branch)?.label ?? "");
  return `${calendar} ${date} · ${time} · ${place.label}`;
}

async function Preview({ params }: { params: Promise<{ readingId: string }> }) {
  const { readingId } = await params;
  await requirePageUser(`/readings/${readingId}/preview`);
  const supabase = await createSupabaseServerClient();
  const [reading, entitlement] = await Promise.all([getReading(supabase, readingId), getEntitlement(supabase, readingId)]);
  if (!reading) notFound();
  if (entitlement) redirect(`/readings/${readingId}`);

  const product = findProduct(reading.product_id);
  const persona = findPersona(reading.persona_id);
  if (!product || !persona) notFound();

  return (
    <>
      <PageHeader title="사주원국과 맛보기" backHref="/home" />
      <main className="flex flex-1 flex-col gap-7 px-5 py-6">
        <section className="flex flex-col gap-2">
          <h1 className="wrap-break-word type-h2">{reading.nickname} 님의 사주</h1>
          <p className="wrap-break-word type-caption text-gray-600">{birthSummary(reading)}</p>
          <div>
            <LinkButton href={`/readings/new?product=${product.id}&edit=${reading.id}`} variant="secondary">
              입력 수정
            </LinkButton>
          </div>
        </section>

        <Card>
          <ChartTable chart={reading.chart} />
        </Card>
        {reading.preview.limitNotes.map((note) => (
          <Notice key={note}>{note}</Notice>
        ))}

        <section className="flex flex-col gap-3">
          <h2 className="type-title">맛보기</h2>
          {reading.preview.bubbles.map((bubble) => (
            <div key={bubble} className="flex items-start gap-3">
              <PersonaAvatar glyph={persona.avatarGlyph} />
              <p className="wrap-break-word rounded-t-lg rounded-br-lg rounded-bl-(--space-2) bg-gray-100 px-4 py-4 type-body text-gray-900">{bubble}</p>
            </div>
          ))}
        </section>

        <Card>
          <h2 className="type-title">결제하면 받을 수 있어요</h2>
          <ul className="mt-3 flex flex-col gap-3">
            {product.topics.map((topic) => (
              <li key={topic.id} className="flex items-center gap-3 type-label font-normal text-gray-700">
                <Lock size={18} className="shrink-0 text-gray-500" aria-hidden />
                {topic.title}
              </li>
            ))}
          </ul>
          <p className="mt-4 type-caption text-gray-600">
            {persona.name}의 메신저 풀이 {product.expectedBubbles} · 후속 질문 {product.followupLimit}회 · 보관함 · PDF
          </p>
        </Card>
      </main>
      <div className="sticky bottom-0 flex flex-col gap-3 border-t border-gray-200 bg-white px-5 py-4 pb-safe">
        <div className="flex items-center justify-between">
          <span className="type-label font-normal text-gray-600">{product.name}</span>
          <span className="type-title type-price">{formatPrice(product.priceKrw)}</span>
        </div>
        <PurchaseButton readingId={reading.id} label="결제하고 풀이 받기" />
      </div>
    </>
  );
}

export default function PreviewPage(props: { params: Promise<{ readingId: string }> }) {
  return (
    <Suspense fallback={<LoadingScreen />}>
      <Preview params={props.params} />
    </Suspense>
  );
}
