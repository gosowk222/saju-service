import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { Suspense } from "react";
import { BottomNav } from "@/components/ui/bottom-nav";
import { LinkButton } from "@/components/ui/button";
import { ProductThumb } from "@/components/product-card";
import { Badge, EmptyState, GlyphAvatar, PageHeader } from "@/components/ui/layout";
import { SkeletonBlock, SkeletonScreen } from "@/components/ui/skeleton";
import { findPersona } from "@/domain/personas";
import { findProduct, isScrollProduct, PRODUCTS } from "@/domain/products";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { requirePageUser } from "@/server/auth";
import type { EntitlementSource, JobRow, ReadingRow } from "@/server/readings/store";

function formatDate(iso: string): string {
  return new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
}

function StatusBadge({ job }: { job: JobRow | undefined }) {
  if (job?.status === "completed") return <Badge>완료</Badge>;
  if (job?.status === "failed") return <Badge tone="danger">다시 시도 필요</Badge>;
  return <Badge tone="progress">풀이 작성 중</Badge>;
}

type LibraryReading = Pick<ReadingRow, "id" | "product_id" | "nickname" | "persona_id">;

/** 보관함 한 줄. source가 null이면 아직 권한이 없는 족자 풀이(무료 부분만 있음)다. */
interface LibraryRow {
  readonly reading_id: string;
  readonly source: EntitlementSource | null;
  readonly created_at: string;
}

async function LibraryList() {
  await requirePageUser("/library");
  const supabase = await createSupabaseServerClient();
  // 족자 상품(무진)은 무료 부분만 있는 풀이도 보관함에 둔다. 사용자 권한(RLS)으로 읽으므로 본인 풀이만 온다.
  const scrollProductIds = PRODUCTS.filter((product) => isScrollProduct(product)).map((product) => product.id);
  const [{ data: entitlements }, { data: scrollReadings }] = await Promise.all([
    supabase.from("entitlements").select("reading_id, source, created_at").order("created_at", { ascending: false }),
    scrollProductIds.length
      ? supabase
          .from("readings")
          .select("id, product_id, nickname, persona_id, created_at")
          .in("product_id", scrollProductIds)
          .order("created_at", { ascending: false })
      : Promise.resolve({ data: [] }),
  ]);

  const entitled = (entitlements ?? []) as LibraryRow[];
  const entitledIds = new Set(entitled.map((row) => row.reading_id));
  const freeOnly = ((scrollReadings ?? []) as (LibraryReading & { created_at: string })[]).filter((reading) => !entitledIds.has(reading.id));
  // 권한이 생긴 풀이는 권한이 생긴 때, 무료 부분만 있는 풀이는 만든 때로 최신순 정렬한다.
  const rows: LibraryRow[] = [...entitled, ...freeOnly.map((reading) => ({ reading_id: reading.id, source: null, created_at: reading.created_at }))].sort(
    (a, b) => b.created_at.localeCompare(a.created_at),
  );
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
                <StatusBadgeRow job={jobById.get(row.reading_id)} name={persona?.name} free={row.source === "free_ticket"} freeOnly={row.source === null} />
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

/** freeOnly: 아직 받지 않은 족자 풀이. 생성 작업 상태 대신 무료 부분만 있다고 표시한다. */
function StatusBadgeRow({ job, name, free, freeOnly = false }: { job: JobRow | undefined; name?: string; free: boolean; freeOnly?: boolean }) {
  return (
    <div className="flex items-center gap-2">
      {freeOnly ? <Badge>무료 부분</Badge> : <StatusBadge job={job} />}
      {free ? <Badge tone="success">무료 이용권</Badge> : null}
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
