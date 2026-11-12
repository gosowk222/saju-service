import { NextResponse } from "next/server";
import type { ScrollSectionView } from "@/domain/mujin/types";
import { findPersona } from "@/domain/personas";
import { findProduct, isScrollProduct, topicTitlesOf } from "@/domain/products";
import { ApiError, requireApiUser, route } from "@/server/api";
import { renderReadingPdf, renderScrollPdf, scrollPdfInput } from "@/server/pdf/render";
import { getEntitlement, getFollowups, getMessages, getJob, getReading, type FollowupRow } from "@/server/readings/store";
import { loadScrollState } from "@/server/scroll/state";

function formatDate(iso: string): string {
  const parts = new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(new Date(iso));
  return parts;
}

/** PDF에는 정상 답변만 싣는다 (범위 밖 안내·되묻기·실패는 뺀다). */
function answeredFollowups(followups: readonly FollowupRow[]) {
  return followups.filter((item) => item.status === "answered" && item.answer).map((item) => ({ question: item.question, answer: item.answer! }));
}

function pdfResponse(pdf: Buffer, name: string | undefined): NextResponse {
  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(`${name ?? "사주풀이"}.pdf`)}`,
      "Cache-Control": "private, no-store",
    },
  });
}

/**
 * 파일을 저장해 두지 않고 요청마다 소유권과 구매 권한을 확인한 뒤 만든다.
 * 족자 상품(무진)도 같은 조건이다: 소유자, 구매 권한(결제 또는 이용권), 유료 단계 완료(generation_jobs completed).
 * 무료 부분만 있는 풀이는 PDF로 내보내지 않는다. 본문은 화면과 같은 조회(loadScrollState)로 다시 읽어 최종문과 실제 표만 넣는다.
 */
export const GET = route<{ readingId: string }>(async (request, { readingId }) => {
  const { user, supabase } = await requireApiUser();
  const [reading, entitlement, job] = await Promise.all([
    getReading(supabase, readingId),
    getEntitlement(supabase, readingId),
    getJob(supabase, readingId),
  ]);
  if (!reading || !entitlement) throw new ApiError(403, "not_entitled", "구매 후 이용할 수 있어요.");
  if (job?.status !== "completed") throw new ApiError(409, "not_ready", "풀이가 완료된 뒤에 받을 수 있어요.");

  const product = findProduct(reading.product_id);
  const includeFollowups = request.nextUrl.searchParams.get("followups") === "1";

  if (isScrollProduct(product)) {
    const [state, followups] = await Promise.all([
      loadScrollState(user.id, readingId),
      includeFollowups ? getFollowups(supabase, readingId) : Promise.resolve([]),
    ]);
    // 화면 상태로 한 번 더 확인한다. 권한이 없으면 상태에 유료 본문이 없고, 끝나지 않은 장이 있으면 내보내지 않는다.
    if (!state || !state.entitled) throw new ApiError(403, "not_entitled", "구매 후 이용할 수 있어요.");
    if (state.paid.status !== "completed" || state.sections.some((section: ScrollSectionView) => section.kind !== "chart" && !section.content)) {
      throw new ApiError(409, "not_ready", "풀이가 완료된 뒤에 받을 수 있어요.");
    }
    const pdf = await renderScrollPdf(scrollPdfInput(state, { createdAt: formatDate(reading.created_at), followups: answeredFollowups(followups) }));
    return pdfResponse(pdf, product.name);
  }

  const [messages, followups] = await Promise.all([
    getMessages(supabase, readingId),
    includeFollowups ? getFollowups(supabase, readingId) : Promise.resolve([]),
  ]);

  const pdf = await renderReadingPdf({
    productName: product?.name ?? "사주 풀이",
    nickname: reading.nickname,
    createdAt: formatDate(reading.created_at),
    personaName: findPersona(reading.persona_id)?.name ?? "",
    chart: reading.chart,
    topicTitles: topicTitlesOf(product),
    messages,
    followups: answeredFollowups(followups),
  });

  return pdfResponse(pdf, product?.name);
});
