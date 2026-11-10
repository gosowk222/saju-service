import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { Messenger } from "@/components/messenger";
import { LoadingScreen, PageHeader, PersonaAvatar } from "@/components/ui/layout";
import { faceOf, findPersona, withSubject } from "@/domain/personas";
import { findProduct, topicTitlesOf } from "@/domain/products";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { requirePageUser } from "@/server/auth";
import { getReading, loadReadingState } from "@/server/readings/store";

async function Reading({ params }: { params: Promise<{ readingId: string }> }) {
  const { readingId } = await params;
  await requirePageUser(`/readings/${readingId}`);
  const supabase = await createSupabaseServerClient();
  const reading = await getReading(supabase, readingId);
  if (!reading) notFound();

  const state = await loadReadingState(supabase, readingId);
  // 구매 권한이 없으면 본문 화면에 들어올 수 없다.
  if (!state) redirect(`/readings/${readingId}/preview`);

  const product = findProduct(reading.product_id);
  const persona = findPersona(reading.persona_id);
  if (!persona) notFound();

  return (
    <>
      <PageHeader
        backHref="/library"
        title={
          <span className="flex items-center gap-3">
            <PersonaAvatar persona={persona} />
            <span className="flex min-w-0 flex-col">
              <span className="truncate type-label font-semibold">{persona.name}</span>
              <span className="truncate type-caption font-normal text-gray-600">{product?.name ?? "사주 풀이"} · {reading.nickname} 님</span>
            </span>
          </span>
        }
      />
      {/* 다시 들어오면 서버의 최신 저장 상태로 시작한다. */}
      <Messenger
        key={crypto.randomUUID()}
        readingId={readingId}
        personaName={persona.name}
        personaSubject={withSubject(persona.name)}
        personaFace={faceOf(persona)}
        topicTitles={topicTitlesOf(product)}
        scopeSummary={product ? `이 풀이에서는 ${product.scope.summary}` : "이 풀이에 대해 물어볼 수 있어요"}
        initialState={state}
        chart={reading.chart}
        nickname={reading.nickname}
      />
    </>
  );
}

export default function ReadingPage(props: { params: Promise<{ readingId: string }> }) {
  return (
    <Suspense fallback={<LoadingScreen />}>
      <Reading params={props.params} />
    </Suspense>
  );
}
