import { notFound } from "next/navigation";
import { Suspense } from "react";
import { BirthWizard } from "@/components/birth-wizard";
import { LoadingScreen, PageHeader } from "@/components/ui/layout";
import { DraftSchema, emptyDraft, type Draft } from "@/domain/birth/input";
import { DEFAULT_PRODUCT_ID, findProduct } from "@/domain/products";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { requirePageUser } from "@/server/auth";
import { getReading, type ReadingRow } from "@/server/readings/store";

const REVIEW_STEP = 7;

function draftFromReading(reading: ReadingRow): Draft {
  const { birth_input: birth, place_snapshot: place } = reading;
  return DraftSchema.parse({
    productId: reading.product_id,
    step: REVIEW_STEP,
    nickname: reading.nickname,
    gender: birth.gender === "male" ? "male" : "female",
    yymmdd: birth.birthDate.slice(2).replaceAll("-", ""),
    calendar: birth.calendar.type,
    isLeapMonth: birth.calendar.type === "lunar" ? birth.calendar.isLeapMonth : false,
    place: { geonameId: place.geonameId, name: place.name, admin: place.admin },
    birthTime: birth.birthTime,
    situationId: reading.situation_id,
    concern: reading.concern,
  });
}

async function NewReading({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const productId = typeof params.product === "string" ? params.product : DEFAULT_PRODUCT_ID;
  const editId = typeof params.edit === "string" ? params.edit : null;
  const product = findProduct(productId);
  if (!product) notFound();

  const search = new URLSearchParams({ product: product.id, ...(editId ? { edit: editId } : {}) });
  await requirePageUser(`/readings/new?${search.toString()}`);
  const supabase = await createSupabaseServerClient();

  let draft: Draft = emptyDraft(product.id);
  const editing = editId ? await getReading(supabase, editId) : null;
  if (editing) {
    draft = draftFromReading(editing);
  } else {
    const { data } = await supabase.from("reading_drafts").select("payload").eq("product_id", product.id).maybeSingle();
    if (data) {
      const parsed = DraftSchema.safeParse(data.payload);
      if (parsed.success) draft = parsed.data;
    }
  }

  return (
    <>
      <PageHeader title={product.name} backHref={editing ? `/readings/${editing.id}/preview` : `/products/${product.id}`} />
      {/* 화면을 오가도 이전 상태가 남지 않도록 서버에서 받을 때마다 새로 시작한다. */}
      <BirthWizard key={crypto.randomUUID()} initialDraft={draft} product={product} />
    </>
  );
}

export default function NewReadingPage(props: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return (
    <Suspense fallback={<LoadingScreen />}>
      <NewReading searchParams={props.searchParams} />
    </Suspense>
  );
}
