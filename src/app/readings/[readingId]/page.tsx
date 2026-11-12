import { notFound, redirect } from "next/navigation";
import { Suspense, type ReactNode } from "react";
import { Messenger } from "@/components/messenger";
import { ScrollReading } from "@/components/mujin/scroll-reading";
import { followupSnapshotOf } from "@/components/mujin/scroll-model";
import { ScrollUnlock } from "@/components/mujin/scroll-unlock";
import { LoadingScreen, PageHeader, PersonaAvatar } from "@/components/ui/layout";
import { formatKoreanDate, parseIsoDate } from "@/domain/birth/date";
import { BRANCH_OPTIONS } from "@/domain/birth/input";
import { faceOf, findPersona, withSubject } from "@/domain/personas";
import { findProduct, findScrollProduct, topicTitlesOf, type ScrollProductDefinition } from "@/domain/products";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getReadingAccess } from "@/server/access";
import { requirePageUser } from "@/server/auth";
import { checkoutMode } from "@/server/checkout/mode";
import { getJob, getReading, loadReadingState, type ReadingRow } from "@/server/readings/store";
import { loadScrollState } from "@/server/scroll/state";
import { loadFreeTicket } from "@/server/tickets/free-ticket";

type Db = Awaited<ReturnType<typeof createSupabaseServerClient>>;

/** 족자 머리에 보여 줄 출생 정보 요약 (예: 양력 1998년 9월 19일 · 오시 · 서울특별시 종로구). */
function birthSummary(reading: ReadingRow): string {
  const { birth_input: birth, place_snapshot: place } = reading;
  const birthTime = birth.birthTime;
  const date = formatKoreanDate(parseIsoDate(birth.birthDate));
  const calendar = birth.calendar.type === "solar" ? "양력" : birth.calendar.isLeapMonth ? "음력 윤달" : "음력";
  const time = birthTime.status === "unknown" ? "시간 모름" : (BRANCH_OPTIONS.find((option) => option.value === birthTime.branch)?.label ?? "");
  return `${calendar} ${date} · ${time} · ${place.label}`;
}

/** 이어서 받는 범위 한 줄 (예: 2~10장과 마지막 정리 · 후속 질문 3회 · 보관함 · PDF). */
function paidScope(product: ScrollProductDefinition): string {
  const paid = product.scroll.sections.filter((section) => section.tier === "paid");
  const numbers = paid.flatMap((section) => (section.kind === "chapter" && section.number !== null ? [section.number] : []));
  const chapters = numbers.length ? `${Math.min(...numbers)}~${Math.max(...numbers)}장` : "";
  const closing = paid.find((section) => section.kind === "closing")?.title;
  const parts = [[chapters, closing].filter(Boolean).join("과 "), `후속 질문 ${product.followupLimit}회`, product.archive ? "보관함" : "", product.pdf ? "PDF" : ""];
  return parts.filter(Boolean).join(" · ");
}

/**
 * 족자 상품(무진)의 풀이 화면. 구매 전에도 무료 부분(원국표, 기초 분석, 1장)을 보여 주고, 유료 장은 권한이 있을 때만 서버가 본문을 보낸다.
 * 처음 그리는 상태는 서버 함수(loadScrollState)로 읽고, 그 뒤의 생성과 상태 확인은 화면(ScrollReading)이 API로 이어 간다.
 */
async function ScrollReadingPage({ userId, supabase, reading, product }: { userId: string; supabase: Db; reading: ReadingRow; product: ScrollProductDefinition }) {
  const persona = findPersona(reading.persona_id);
  const intake = persona?.lines.intake;
  if (!persona || !intake) notFound();
  const state = await loadScrollState(userId, reading.id, { user: supabase });
  // 소유자가 아니면 상태가 없다. 다른 사람의 풀이가 있는지도 알리지 않는다.
  if (!state) notFound();

  let unlock: ReactNode = null;
  if (!state.entitled) {
    const [ticket, access, job] = await Promise.all([loadFreeTicket(supabase, userId), getReadingAccess(userId), getJob(supabase, reading.id)]);
    unlock = (
      <ScrollUnlock
        summary={paidScope(product)}
        readingId={reading.id}
        productId={product.id}
        productName={product.name}
        priceKrw={product.priceKrw}
        provisional={product.priceStatus === "provisional"}
        ticket={ticket}
        closed={job?.status === "cancelled"}
        mode={checkoutMode()}
        allowed={access.allowed}
      />
    );
  }
  // 전체 풀이가 끝난 상태로 열면 후속 질문 기록을 함께 읽는다 (메신저와 같은 조회 방식).
  const followupState = state.entitled && state.paid.status === "completed" ? await loadReadingState(supabase, reading.id) : null;

  return (
    <ScrollReading
      // 다시 들어오면 서버의 최신 저장 상태로 시작한다.
      key={crypto.randomUUID()}
      readingId={reading.id}
      initialState={state}
      lines={intake}
      face={faceOf(persona)}
      personaName={persona.name}
      birthSummary={birthSummary(reading)}
      unlock={unlock}
      followups={followupState ? followupSnapshotOf(followupState) : null}
      scopeSummary={`이 풀이에서는 ${product.scope.summary}`}
    />
  );
}

async function Reading({ params }: { params: Promise<{ readingId: string }> }) {
  const { readingId } = await params;
  const user = await requirePageUser(`/readings/${readingId}`);
  const supabase = await createSupabaseServerClient();
  const reading = await getReading(supabase, readingId);
  if (!reading) notFound();

  // 족자 상품은 권한이 없어도 무료 부분을 이 화면에서 보여 준다. 메신저 상품은 아래의 기존 흐름 그대로다.
  const scrollProduct = findScrollProduct(reading.product_id);
  if (scrollProduct) return <ScrollReadingPage userId={user.id} supabase={supabase} reading={reading} product={scrollProduct} />;

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
