import { NextResponse } from "next/server";
import { findPersona } from "@/domain/personas";
import { findProduct, topicTitlesOf } from "@/domain/products";
import { ApiError, requireApiUser, route } from "@/server/api";
import { renderReadingPdf } from "@/server/pdf/render";
import { getEntitlement, getFollowups, getMessages, getJob, getReading } from "@/server/readings/store";

function formatDate(iso: string): string {
  const parts = new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(new Date(iso));
  return parts;
}

/** 파일을 저장해 두지 않고 요청마다 소유권과 구매 권한을 확인한 뒤 만든다. */
export const GET = route<{ readingId: string }>(async (request, { readingId }) => {
  const { supabase } = await requireApiUser();
  const [reading, entitlement, job] = await Promise.all([
    getReading(supabase, readingId),
    getEntitlement(supabase, readingId),
    getJob(supabase, readingId),
  ]);
  if (!reading || !entitlement) throw new ApiError(403, "not_entitled", "구매 후 이용할 수 있어요.");
  if (job?.status !== "completed") throw new ApiError(409, "not_ready", "풀이가 완료된 뒤에 받을 수 있어요.");

  const product = findProduct(reading.product_id);
  const includeFollowups = request.nextUrl.searchParams.get("followups") === "1";
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
    followups: followups
      .filter((item) => item.status === "answered" && item.answer)
      .map((item) => ({ question: item.question, answer: item.answer! })),
  });

  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(`${product?.name ?? "사주풀이"}.pdf`)}`,
      "Cache-Control": "private, no-store",
    },
  });
});
