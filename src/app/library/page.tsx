import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { Suspense } from "react";
import { BottomNav } from "@/components/ui/bottom-nav";
import { LinkButton } from "@/components/ui/button";
import { ProductThumb } from "@/components/product-card";
import { Badge, EmptyState, GlyphAvatar, PageHeader } from "@/components/ui/layout";
import { SkeletonBlock, SkeletonScreen } from "@/components/ui/skeleton";
import { findPersona } from "@/domain/personas";
import { findProduct } from "@/domain/products";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { requirePageUser } from "@/server/auth";
import type { JobRow, ReadingRow } from "@/server/readings/store";

function formatDate(iso: string): string {
  return new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
}

function StatusBadge({ job }: { job: JobRow | undefined }) {
  if (job?.status === "completed") return <Badge>완료</Badge>;
  if (job?.status === "failed") return <Badge tone="danger">다시 시도 필요</Badge>;
  return <Badge tone="progress">풀이 작성 중</Badge>;
}

async function LibraryList() {
  await requirePageUser("/library");
  const supabase = await createSupabaseServerClient();
  const { data: entitlements } = await supabase
    .from("entitlements")
    .select("reading_id, created_at")
    .order("created_at", { ascending: false });

  const rows = (entitlements ?? []) as { reading_id: string; created_at: string }[];
  if (rows.length === 0) {
    return (
      <EmptyState
        title="아직 받은 풀이가 없어요"
        description="첫 풀이를 받아 보면 여기에 차곡차곡 모여요."
        action={<LinkButton href="/products">풀이 고르러 가기</LinkButton>}
      />
    );
  }

  const ids = rows.map((row) => row.reading_id);
  const [{ data: readings }, { data: jobs }] = await Promise.all([
    supabase.from("readings").select("id, product_id, nickname, persona_id").in("id", ids),
    supabase.from("generation_jobs").select("reading_id, status").in("reading_id", ids),
  ]);
  const readingById = new Map(((readings ?? []) as Pick<ReadingRow, "id" | "product_id" | "nickname" | "persona_id">[]).map((row) => [row.id, row]));
  const jobById = new Map(((jobs ?? []) as JobRow[]).map((row) => [row.reading_id, row]));

  return (
    <ul className="flex flex-col gap-3">
      {rows.map((row) => {
        const reading = readingById.get(row.reading_id);
        if (!reading) return null;
        const persona = findPersona(reading.persona_id);
        const product = findProduct(reading.product_id);
        return (
          <li key={row.reading_id}>
            <Link
              href={`/readings/${row.reading_id}`}
              className="flex items-center gap-4 rounded-lg border border-gray-200 p-4 text-gray-900 hover:text-gray-900 hover:no-underline"
            >
              {product ? <ProductThumb product={product} /> : <GlyphAvatar glyph={persona?.avatarGlyph ?? "사"} large />}
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <StatusBadgeRow job={jobById.get(row.reading_id)} name={persona?.name} />
                <span className="truncate type-label font-semibold">{product?.name ?? "사주 풀이"}</span>
                <span className="truncate type-caption text-gray-600">
                  {reading.nickname} 님 · {formatDate(row.created_at)}
                </span>
              </div>
              <ChevronRight size={18} className="shrink-0 text-gray-400" aria-hidden />
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

function StatusBadgeRow({ job, name }: { job: JobRow | undefined; name?: string }) {
  return (
    <div className="flex items-center gap-2">
      <StatusBadge job={job} />
      {name ? <span className="type-caption-sm text-gray-600">{name}</span> : null}
    </div>
  );
}

/** 목록 칸(썸네일, 상태, 이름, 날짜)과 같은 모양으로 자리를 잡아 둔다. */
function LibrarySkeleton() {
  return (
    <SkeletonScreen className="flex flex-col gap-3">
      {[0, 1, 2].map((row) => (
        <div key={row} className="flex items-center gap-4 rounded-lg border border-gray-200 p-4">
          <SkeletonBlock className="h-tile w-tile shrink-0 rounded-md" />
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <SkeletonBlock className="h-7 w-1/4 rounded-sm" />
            <SkeletonBlock className="h-5 w-2/3 rounded-sm" />
            <SkeletonBlock className="h-4 w-1/2 rounded-sm" />
          </div>
        </div>
      ))}
    </SkeletonScreen>
  );
}

export default function LibraryPage() {
  return (
    <>
      <PageHeader title="내 풀이 보관함" />
      <main className="flex flex-1 flex-col gap-4 px-5 py-6">
        <Suspense fallback={<LibrarySkeleton />}>
          <LibraryList />
        </Suspense>
      </main>
      <BottomNav />
    </>
  );
}
