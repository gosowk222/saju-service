import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  MujinLuck,
  MujinMonths,
  MujinPlan,
  ScrollPhaseView,
  ScrollSectionContent,
  ScrollSectionView,
  ScrollStateView,
  SectionViewState,
} from "@/domain/mujin/types";
import { findPersona } from "@/domain/personas";
import { findScrollProduct } from "@/domain/products";
import type { ScrollProductDefinition, ScrollSectionSpec } from "@/domain/products/types";
import type { ChartView } from "@/domain/reading/types";
import { createSupabaseAdminClient, createSupabaseServerClient } from "@/lib/supabase/server";
import { SCROLL_SETTINGS } from "./config";
import { dateOnly, loadFinalSections, loadTimingBundle, type FinalSection, type UnitStatus } from "./store";

/**
 * 족자 화면의 상태 (GET /api/readings/{id}/scroll, /readings/{id} 첫 화면). 저장된 상태만 근거로 한다.
 *
 * - 소유 확인은 사용자 세션 클라이언트(RLS)로 한다. 다른 회원의 풀이는 null이다.
 * - 완성문(reading_sections)도 사용자 클라이언트로 읽어 RLS가 무료 장·구매 권한을 강제한다. 여기에 더해 상품 정의의 tier로
 *   한 번 더 거른다: 권한이 없으면 유료 장의 content는 항상 null이고, 유료 기간표(timing)도 보내지 않는다.
 * - Pass 1 초안은 읽지 않는다. 장 진행 상태(reading_units)는 서버 클라이언트로 상태·시도 수만 읽는다.
 * - 화면 계약: 단계는 처음이면 idle, 다시 시작할 차례(반납됨·점유 만료)면 queued다 (화면은 이 둘일 때만 생성 요청을 보낸다).
 *   원국표 칸은 done·content null이다. writing은 실제로 쓰는 칸만이다 (초안을 저장해 Pass 2 중인 장, 지금 Pass 1 묶음의 장).
 *   failed는 화면이 다시 시도를 그리는 칸이다 (다시 시도할 수 있는지는 그 단계의 canRetry로 정한다).
 *   · 단계가 failed이면 그 단계의 끝나지 않은 칸은 모두 failed다. 질문 정리 실패·저장 오류처럼 장별 실패 기록 없이 단계만 실패해도 다시 시도할 칸이 생긴다.
 *   · 단계가 진행 중(running·queued)이면 시도 수가 남은 실패 장은 곧 자동으로 다시 쓰므로 waiting(또는 지금 다시 쓰면 writing)이다.
 *     시도 수를 다 쓴 장만 failed다.
 */

type Db = SupabaseClient;

/** 단계 실행 행 (reading_free_runs 또는 generation_jobs). */
export interface PhaseRecord {
  /** queued | running | completed | failed | cancelled(유료만: 이용권 반환으로 닫힘) */
  readonly status: string;
  readonly attempts: number;
  readonly leaseUntil: string | null;
  readonly errorCode: string | null;
  readonly errorRetryable: boolean | null;
}

/** 장 진행 상태 (초안 없이 상태·시도 수만). */
export interface UnitStateRecord {
  readonly unitId: string;
  readonly status: UnitStatus;
  readonly draftAttempts: number;
  readonly voiceAttempts: number;
  readonly errorStage: "draft" | "voice" | null;
  readonly updatedAt: string | null;
}

export interface ScrollStateInput {
  readonly reading: {
    readonly id: string;
    readonly persona_id: string;
    readonly nickname: string;
    readonly created_at: string;
    readonly chart: ChartView;
  };
  readonly product: ScrollProductDefinition;
  readonly personaName: string;
  readonly plan: Pick<MujinPlan, "hourKnown" | "tables">;
  readonly entitled: boolean;
  readonly freeRun: PhaseRecord | null;
  readonly job: (PhaseRecord & { readonly referenceDate: string | null }) | null;
  readonly units: readonly UnitStateRecord[];
  /** 읽을 수 있었던 완성문. 사용자 클라이언트로 읽은 것을 넘긴다. */
  readonly finals: readonly FinalSection[];
  readonly timing: { readonly luck: MujinLuck; readonly months: MujinMonths } | null;
  /** 점유 만료를 판단할 현재 시각 (epoch ms). */
  readonly now: number;
}

const leaseValid = (phase: PhaseRecord | null, now: number): boolean =>
  !!phase && phase.status === "running" && phase.leaseUntil !== null && Date.parse(phase.leaseUntil) > now;

/** 단계가 아직 진행 중인가: 실행 중(점유가 만료됐어도 다음 요청이 이어받는다)이거나 반납되어 다시 시작할 차례다. */
const inProgress = (phase: PhaseRecord | null): boolean => !!phase && (phase.status === "running" || phase.status === "queued");

function phaseView(phase: PhaseRecord | null, maxRuns: number, now: number): ScrollPhaseView {
  if (!phase) return { status: "idle", canRetry: false, errorCode: null };
  switch (phase.status) {
    case "running":
      // 점유 시간이 지났으면 다시 시작할 차례다 (다음 생성 요청이 이어받는다).
      return { status: leaseValid(phase, now) ? "running" : "queued", canRetry: false, errorCode: null };
    case "queued":
      return { status: "queued", canRetry: false, errorCode: null };
    case "completed":
      return { status: "completed", canRetry: false, errorCode: null };
    case "failed":
      return { status: "failed", canRetry: phase.errorRetryable !== false && phase.attempts < maxRuns, errorCode: phase.errorCode };
    default:
      // cancelled(이용권 반환으로 닫힌 작업)처럼 더 진행하지 않는 상태.
      return { status: "locked", canRetry: false, errorCode: phase.errorCode };
  }
}

/** 그 단계의 시도 수가 남은 실패 장인가. */
function attemptsLeft(unit: UnitStateRecord): boolean {
  if (unit.errorStage === "voice") return unit.voiceAttempts < SCROLL_SETTINGS.voiceAttemptsPerUnit;
  if (unit.errorStage === "draft") return unit.draftAttempts < SCROLL_SETTINGS.draftAttemptsPerUnit;
  return false;
}

/** 블록의 작성용 참조(ref)는 서버 안에서만 쓴다. 화면에는 보내지 않는다. */
function viewContent(content: ScrollSectionContent): ScrollSectionContent {
  return {
    sectionId: content.sectionId,
    coreAnswer: content.coreAnswer,
    blocks: (content.blocks ?? []).map((block) => ({ ...block, refs: [] })),
  };
}

/**
 * 저장 상태로 화면 상태를 만든다 (순수 함수). 장 순서는 상품 목차 순서다. 뒤 장이 먼저 완성돼도 순서를 바꾸지 않는다.
 *
 * 장 상태: 원국표 → done(content null). 유료이고 권한 없음 → locked(content null). 완성문 있음 → done.
 * 그 장의 단계가 failed → failed (장별 실패 기록이 없어도 단계 실패로 멈춘 칸에 다시 시도를 그리게 한다).
 * 실패한 장: 시도 수를 다 썼거나 단계가 진행 중(running·queued)이 아니면 failed. 진행 중이고 시도 수가 남았으면 곧 다시 쓰므로
 * waiting이다. 그 가운데 이번 점유를 시작하기 전에 실패해 지금 실행이 다시 쓰는 장(Pass 2 실패, 지금 Pass 1 묶음의 초안 실패)은 writing이다.
 * 실행 중(점유 유효)이면: 초안 저장됨(Pass 2 중) → writing, 지금 Pass 1 묶음(초안이 필요한 장이 남은 첫 묶음)의 장 → writing,
 * 그 밖 → waiting. 실행 중이 아니면 waiting.
 */
export function buildScrollStateView(input: ScrollStateInput): ScrollStateView {
  const { product, entitled, now, reading } = input;
  const specs = product.scroll.sections;
  const tierOf = new Map(specs.map((spec) => [spec.id, spec.tier] as const));
  const units = new Map(input.units.map((unit) => [unit.unitId, unit] as const));
  // RLS에 더한 두 번째 확인: 상품 정의에서 유료인 장은 권한이 있을 때만 쓴다.
  const finals = new Map(
    input.finals.filter((final) => tierOf.get(final.sectionId) === "free" || (entitled && tierOf.get(final.sectionId) === "paid")).map((final) => [final.sectionId, final.content] as const),
  );
  const phaseOf = (spec: ScrollSectionSpec): PhaseRecord | null => (spec.tier === "free" ? input.freeRun : input.job);

  /** 지금 실행이 이어서 다시 쓸 실패 장 (이번 점유를 시작하기 전에 실패했고 시도 수가 남았다). */
  const retrying = (unit: UnitStateRecord, phase: PhaseRecord | null): boolean => {
    if (unit.status !== "failed" || !leaseValid(phase, now) || !unit.updatedAt || !attemptsLeft(unit)) return false;
    const claimedAt = Date.parse(phase!.leaseUntil!) - SCROLL_SETTINGS.leaseSeconds * 1000;
    return Date.parse(unit.updatedAt) < claimedAt;
  };
  const needsDraft = (spec: ScrollSectionSpec): boolean => {
    if (finals.has(spec.id)) return false;
    const unit = units.get(spec.id);
    if (!unit || unit.status === "pending") return true;
    return unit.errorStage === "draft" && retrying(unit, phaseOf(spec));
  };
  const specById = new Map(specs.map((spec) => [spec.id, spec] as const));
  /** 단계마다 지금 Pass 1을 쓰는 묶음 (초안이 필요한 장이 남은 첫 묶음). */
  const currentBatch = (tier: ScrollSectionSpec["tier"]) =>
    product.scroll.draftBatches.find((batch) => batch.tier === tier && batch.sectionIds.some((id) => specById.has(id) && needsDraft(specById.get(id)!)));
  const current = { free: currentBatch("free"), paid: currentBatch("paid") };

  const inCurrentBatch = (spec: ScrollSectionSpec): boolean => current[spec.tier]?.sectionIds.includes(spec.id) ?? false;

  const stateOf = (spec: ScrollSectionSpec): { readonly state: SectionViewState; readonly content: ScrollSectionContent | null } => {
    if (spec.kind === "chart") return { state: "done", content: null };
    if (spec.tier === "paid" && !entitled) return { state: "locked", content: null };
    const content = finals.get(spec.id);
    if (content) return { state: "done", content: viewContent(content) };
    const unit = units.get(spec.id);
    const phase = phaseOf(spec);
    // 단계가 실패로 끝났다 (장 실패, 질문 정리 실패, 저장 오류, 기준일·기간 재료 오류 등). 끝나지 않은 칸은 모두 실패로 보여
    // 화면이 그 칸에서 다시 시도(phase.canRetry)를 그리게 한다. 장별 실패 기록(reading_units)이 없어도 같다.
    if (phase?.status === "failed") return { state: "failed", content: null };
    if (unit?.status === "failed") {
      // 시도 수를 다 쓴 장은 더 쓰지 않는다. 단계가 진행 중이 아니면 다시 쓸 실행도 없다.
      if (!attemptsLeft(unit) || !inProgress(phase)) return { state: "failed", content: null };
      // 진행 중인 단계가 곧 다시 쓰는 장이다. 이번 점유 전에 실패한 장은 지금 실행이 다시 쓴다
      // (Pass 2 실패는 저장된 초안으로 바로, Pass 1 실패는 그 장의 묶음 차례에).
      if (retrying(unit, phase) && (unit.errorStage === "voice" || inCurrentBatch(spec))) return { state: "writing", content: null };
      return { state: "waiting", content: null };
    }
    if (leaseValid(phase, now)) {
      if (unit?.status === "drafted") return { state: "writing", content: null };
      if (inCurrentBatch(spec) && needsDraft(spec)) return { state: "writing", content: null };
    }
    return { state: "waiting", content: null };
  };

  const sections: ScrollSectionView[] = specs.map((spec) => ({
    id: spec.id,
    kind: spec.kind,
    number: spec.number,
    title: spec.title,
    tier: spec.tier,
    summary: spec.summary,
    questions: spec.questions.map((question) => ({ id: question.id, title: question.title })),
    tables: spec.tables,
    ...stateOf(spec),
  }));

  return {
    readingId: reading.id,
    productId: product.id,
    productName: product.name,
    personaId: reading.persona_id,
    personaName: input.personaName,
    nickname: reading.nickname,
    createdAt: reading.created_at,
    hourKnown: input.plan.hourKnown,
    chart: reading.chart,
    tables: input.plan.tables,
    entitled,
    free: phaseView(input.freeRun, SCROLL_SETTINGS.freeMaxRuns, now),
    paid: entitled
      ? { ...phaseView(input.job, SCROLL_SETTINGS.paidMaxRuns, now), referenceDate: input.job?.referenceDate ?? null }
      : { status: "locked", canRetry: false, errorCode: null, referenceDate: null },
    sections,
    timing: entitled ? input.timing : null,
  };
}

interface PhaseRow {
  readonly status: string;
  readonly attempts: number;
  readonly lease_until: string | null;
  readonly error_code: string | null;
  readonly error_retryable: boolean | null;
}

const toPhase = (row: PhaseRow | null): PhaseRecord | null =>
  row ? { status: row.status, attempts: row.attempts, leaseUntil: row.lease_until, errorCode: row.error_code, errorRetryable: row.error_retryable } : null;

function rowsOf<T>(result: { readonly data: T | null; readonly error: unknown }): T | null {
  if (result.error) throw new Error("scroll_state_load_failed");
  return result.data;
}

/**
 * 족자 화면 상태를 읽는다. 소유자가 아니거나 족자 상품이 아니면 null.
 * clients를 주지 않으면 요청의 사용자 세션 클라이언트와 서버 클라이언트를 만든다 (테스트는 직접 넘긴다).
 */
export async function loadScrollState(
  userId: string,
  readingId: string,
  clients: { readonly user?: Db; readonly admin?: Db; readonly now?: () => number } = {},
): Promise<ScrollStateView | null> {
  const user = clients.user ?? (await createSupabaseServerClient());
  // 소유 확인: 사용자 권한(RLS)으로 읽는다. 다른 회원의 풀이는 행이 돌아오지 않는다.
  const { data: reading, error } = await user
    .from("readings")
    .select("id, user_id, product_id, persona_id, nickname, created_at, chart")
    .eq("id", readingId)
    .maybeSingle();
  if (error || !reading || (reading as { user_id: string }).user_id !== userId) return null;
  const row = reading as { id: string; product_id: string; persona_id: string; nickname: string; created_at: string; chart: ChartView };
  const product = findScrollProduct(row.product_id);
  if (!product) return null;

  const admin = clients.admin ?? createSupabaseAdminClient();
  const [entitlement, job, freeRun, finals, units, internals] = await Promise.all([
    user.from("entitlements").select("reading_id").eq("reading_id", readingId).maybeSingle(),
    user.from("generation_jobs").select("status, attempts, lease_until, error_code, error_retryable, reference_date").eq("reading_id", readingId).maybeSingle(),
    user.from("reading_free_runs").select("status, attempts, lease_until, error_code, error_retryable").eq("reading_id", readingId).maybeSingle(),
    loadFinalSections(user, readingId),
    // 초안 칸(draft)은 읽지 않는다.
    admin.from("reading_units").select("unit_id, status, draft_attempts, voice_attempts, error_stage, updated_at").eq("reading_id", readingId).eq("user_id", userId),
    admin.from("reading_internals").select("plan").eq("reading_id", readingId).maybeSingle(),
  ]);
  const plan = (rowsOf(internals) as { plan: MujinPlan } | null)?.plan;
  if (!plan?.tables) return null;
  const entitled = rowsOf(entitlement) !== null;
  const jobRow = rowsOf(job) as (PhaseRow & { reference_date: unknown }) | null;
  const referenceDate = dateOnly(jobRow?.reference_date);
  const timing = entitled && referenceDate ? await loadTimingBundle(admin, readingId, referenceDate) : null;
  const unitRows = (rowsOf(units) ?? []) as {
    unit_id: string;
    status: UnitStatus;
    draft_attempts: number;
    voice_attempts: number;
    error_stage: "draft" | "voice" | null;
    updated_at: string | null;
  }[];

  return buildScrollStateView({
    reading: row,
    product,
    personaName: findPersona(row.persona_id)?.name ?? row.persona_id,
    plan,
    entitled,
    freeRun: toPhase(rowsOf(freeRun) as PhaseRow | null),
    job: jobRow ? { ...toPhase(jobRow)!, referenceDate } : null,
    units: unitRows.map((unit) => ({
      unitId: unit.unit_id,
      status: unit.status,
      draftAttempts: unit.draft_attempts,
      voiceAttempts: unit.voice_attempts,
      errorStage: unit.error_stage,
      updatedAt: unit.updated_at,
    })),
    finals,
    timing: timing ? { luck: timing.luck, months: timing.months } : null,
    now: (clients.now ?? Date.now)(),
  });
}
