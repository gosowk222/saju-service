import "server-only";
import { buildCheckContext, checkDraftSection, checkVoiceSection, TIMING_SECTION_IDS, type MujinCheckContext } from "@/domain/mujin/check";
import { MUJIN_PERSONALIZE_VERSION, personalizeSections, type MujinQuestionInput, type MujinQuestionMaterial } from "@/domain/mujin/personalize";
import { MUJIN_TIMING_PLAN_VERSION, buildClosingSection, buildTimingSections } from "@/domain/mujin/timing-plan";
import {
  MUJIN_PLAN_VERSION,
  type MujinPlan,
  type MujinSectionPlan,
  type MujinTimingBundle,
  type ScrollDraftContent,
  type ScrollSectionContent,
  type ScrollTier,
} from "@/domain/mujin/types";
import { findPersona, type Persona } from "@/domain/personas";
import { findScrollProduct } from "@/domain/products";
import type { ScrollDraftBatch, ScrollProductDefinition, ScrollSectionSpec } from "@/domain/products/types";
import { issueSummary, type ExcludedQuestion } from "@/domain/reading/check";
import { seoulDate } from "@/domain/reading/question";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import { ApiError } from "@/server/api";
import { computeMujinTiming } from "@/server/engine/mujin";
import { createCallRecorder, type LlmCallRecorder, type LlmCallStep } from "@/server/llm/call-log";
import { LlmError, callStructured, callStructuredStream, type StructuredResult } from "@/server/llm/client";
import { LLM_SETTINGS, resolveModelId } from "@/server/llm/config";
import {
  MUJIN_BUNDLES,
  MUJIN_BUNDLE_VERSION,
  MujinDraftSectionParser,
  buildDraftRequest,
  buildVoiceRequest,
  findMujinBundle,
  type MujinBundle,
  type MujinVoiceOutput,
} from "@/server/llm/mujin-prompts";
import { completedArrayItems } from "@/server/llm/stream-parts";
import { UsageMeter } from "@/server/llm/usage";
import { internalReason } from "@/server/log";
import { SCROLL_SETTINGS, ScrollStepError } from "./config";
import { SCROLL_QUESTION_VERSION, prepareScrollQuestionsWith, scrollClassifier, type ScrollClassifier } from "./questions";
import { createScrollStore, type ClaimOutcome, type ClaimedRun, type ScrollReadingRecord, type ScrollStore, type UnitRecord } from "./store";
import { prepareScrollTimingWith } from "./timing";

/**
 * 무진의 종합 사주 생성 실행기. 한 요청 안에서 한 단계(무료 또는 유료)를 시간 예산만큼 쓰고 끝낸다.
 * 서버 응답 뒤에 작업이 계속된다고 가정하지 않는다. 남은 장은 점유를 반납(partial)해 브라우저가 곧바로 다시 요청한다.
 *
 * - 무료 단계: 기초 분석 4개와 1장. 결제 전에 쓰며 reading_free_runs로 점유한다 (generation_jobs를 만들지 않는다).
 * - 유료 단계: 2~10장과 마지막 정리. 구매 권한이 있고 무료 단계가 끝난 뒤에만 시작한다 (generation_jobs, claim_generation).
 *   권한이 없으면 유료 장의 초안을 만들지 않는다 (호출 0). DB 저장 함수도 권한을 다시 확인한다.
 * - Pass 1(평문 초안)은 장 묶음마다 스트림으로 받고, 장 원소가 닫힐 때마다 검사해 저장한 뒤 Pass 2(무진 문장) 대기열에 넣는다.
 *   스트림 수신 루프는 짧은 초안 저장만 기다리고 Pass 2를 기다리지 않는다 (프로세스 전역 동시 호출 제한과의 교착 방지).
 * - 검사에 걸린 장만 다시 요청한다. 장마다 시도 수 상한을 넘으면 그 장만 실패로 남는다. 저장된 장은 다시 만들지 않는다.
 * - 저장 함수가 false를 돌려주면 다른 요청이 이어받은 것이다. 이 요청은 더 저장하지 않는다 (늦은 응답이 새 상태를 덮지 않음).
 * - 장의 tier는 상품 정의(ScrollSectionSpec.tier)에서 정한다. DB는 서버가 보낸 tier를 믿는다.
 * - 모든 LLM 호출은 llm_calls에 태그(단계, 무료·유료, 장·묶음 ID, 버전)와 함께 남는다. 로그에는 코드와 ID만 남긴다.
 */

export type ScrollRunResult = "completed" | "running" | "partial" | "failed" | "exhausted" | "locked" | "daily_limited" | "not_ready";

/** 테스트 주입용 의존성. 기본값은 실제 구현이다. */
export interface RunnerDeps {
  readonly callStructured: typeof callStructured;
  readonly callStructuredStream: typeof callStructuredStream;
  /** 현재 시각 (epoch ms). 시간 예산과 유료 기준일을 정한다. */
  readonly now: () => number;
  readonly store: ScrollStore;
  readonly computeTiming: typeof computeMujinTiming;
  readonly classify: ScrollClassifier;
}

function resolveDeps(partial: Partial<RunnerDeps> = {}): RunnerDeps {
  const call = partial.callStructured ?? callStructured;
  return {
    callStructured: call,
    callStructuredStream: partial.callStructuredStream ?? callStructuredStream,
    now: partial.now ?? Date.now,
    store: partial.store ?? createScrollStore(createSupabaseAdminClient()),
    computeTiming: partial.computeTiming ?? computeMujinTiming,
    classify: partial.classify ?? scrollClassifier(call),
  };
}

const unique = <T>(values: readonly T[]): T[] => [...new Set(values)];

const blankUnit = (unitId: string, tier: ScrollTier): UnitRecord => ({
  unitId,
  tier,
  status: "pending",
  draft: null,
  draftAttempts: 0,
  voiceAttempts: 0,
  errorStage: null,
  errorCode: null,
  errorRetryable: null,
  updatedAt: null,
});

/** Pass 1 초안이 필요한 장: 아직 초안이 없거나, Pass 1에서 실패했고 시도 수가 남았다. */
export function needsDraft(unit: UnitRecord | undefined): boolean {
  if (!unit || unit.status === "pending") return true;
  return unit.status === "failed" && unit.errorStage === "draft" && unit.draftAttempts < SCROLL_SETTINGS.draftAttemptsPerUnit;
}

/** 저장된 초안으로 Pass 2를 할 장: 초안까지 저장했거나, Pass 2에서 실패했고 시도 수가 남았다. */
export function needsVoice(unit: UnitRecord | undefined): boolean {
  if (!unit) return false;
  if (unit.status === "drafted") return true;
  return unit.status === "failed" && unit.errorStage === "voice" && unit.voiceAttempts < SCROLL_SETTINGS.voiceAttemptsPerUnit;
}

/** 실패한 장을 다시 시도할 수 있는가 (재시도 불가로 기록되지 않았고 그 단계의 시도 수가 남았다). */
function retryableUnit(unit: UnitRecord): boolean {
  if (unit.errorRetryable === false) return false;
  return unit.errorStage === "voice" ? unit.voiceAttempts < SCROLL_SETTINGS.voiceAttemptsPerUnit : unit.draftAttempts < SCROLL_SETTINGS.draftAttemptsPerUnit;
}

/** 작성 계획의 다음 재료 번호. 공용 사실·지금의 나·장 재료의 가장 큰 m번호 다음부터 9·10장과 개인화 재료를 붙인다. */
function nextRefOf(plan: MujinPlan): number {
  let max = 0;
  for (const material of [...plan.facts, ...plan.nowFacts, ...plan.sections.flatMap((section) => section.materials)]) {
    const match = /^m(\d+)$/.exec(material.ref);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max + 1;
}

/**
 * Pass 2 대기열. push는 기다리지 않고 곧바로 돌아오며, 동시에 limit개까지 실행한다. drain은 남은 작업을 모두 기다린다.
 * 작업이 던진 오류는 onError로 넘기고 대기열은 멈추지 않는다 (실행기가 멈출지 정한다).
 */
class VoiceQueue {
  private readonly waiting: string[] = [];
  private readonly seen = new Set<string>();
  private readonly running = new Set<Promise<void>>();

  constructor(
    private readonly limit: number,
    private readonly work: (id: string) => Promise<void>,
    private readonly onError: (error: unknown) => void,
  ) {}

  /** 같은 장은 한 요청에서 한 번만 넣는다. */
  push(id: string): void {
    if (this.seen.has(id)) return;
    this.seen.add(id);
    this.waiting.push(id);
    this.pump();
  }

  private pump(): void {
    while (this.running.size < this.limit && this.waiting.length > 0) {
      const id = this.waiting.shift()!;
      // 다음 마이크로태스크에서 시작한다. push를 부른 쪽(스트림 수신 루프)은 작업 코드를 한 줄도 기다리지 않는다.
      const task: Promise<void> = Promise.resolve()
        .then(() => this.work(id))
        .catch((error: unknown) => this.onError(error))
        .finally(() => {
          this.running.delete(task);
          this.pump();
        });
      this.running.add(task);
    }
  }

  async drain(): Promise<void> {
    while (this.running.size > 0 || this.waiting.length > 0) await Promise.all([...this.running]);
  }
}

interface DraftRound {
  readonly batchId: string;
  readonly round: number;
  readonly pending: Set<string>;
  /** 이번 요청에서 원소를 받은 장 (같은 장의 두 번째 원소는 쓰지 않는다). */
  readonly handled: Set<string>;
  readonly problems: Map<string, { readonly code: string; readonly issues: readonly string[] }>;
  readonly previousIssues: readonly string[] | undefined;
}

interface TierRunInit {
  readonly deps: RunnerDeps;
  readonly tier: ScrollTier;
  readonly userId: string;
  readonly reading: ScrollReadingRecord;
  readonly plan: MujinPlan;
  readonly product: ScrollProductDefinition;
  readonly claimed: ClaimedRun;
  readonly startedAt: number;
}

/** 점유한 한 단계의 실행. 요청 하나가 끝나면 버린다. */
class TierRun {
  private readonly deps: RunnerDeps;
  private readonly tier: ScrollTier;
  private readonly userId: string;
  private readonly readingId: string;
  private readonly reading: ScrollReadingRecord;
  private readonly plan: MujinPlan;
  private readonly product: ScrollProductDefinition;
  private readonly claimed: ClaimedRun;
  private readonly attempt: number;
  private readonly startedAt: number;
  private readonly deadlineAt: number;
  private readonly meter = new UsageMeter();
  private readonly recorder: LlmCallRecorder;
  private readonly specs: ReadonlyMap<string, ScrollSectionSpec>;
  /** 이번 단계가 쓰는 장 (원국표 제외, 목차 순서). */
  private readonly unitIds: readonly string[];
  private readonly toc: readonly { readonly sectionId: string; readonly title: string; readonly tier: ScrollTier }[];
  private readonly queue: VoiceQueue;

  private bundle!: MujinBundle;
  private persona!: Persona;
  private modelId!: string;
  private ctx!: MujinCheckContext;
  private timing: MujinTimingBundle | null = null;
  private questions: readonly MujinQuestionInput[] = [];
  private questionMaterials: readonly MujinQuestionMaterial[] = [];
  private excluded: readonly ExcludedQuestion[] = [];
  private closingStartRef = 1;
  private readonly sections = new Map<string, MujinSectionPlan>();
  private readonly units = new Map<string, UnitRecord>();
  private readonly drafts = new Map<string, ScrollDraftContent>();
  private readonly finals = new Map<string, ScrollSectionContent>();
  private readonly usedScenes: string[] = [];

  /** 저장 함수가 false를 돌려줬다 (다른 요청이 이어받음). 더 저장하지 않는다. */
  private lost = false;
  /** 설정 오류나 저장소 오류로 새 호출을 시작하지 않는다. */
  private halted = false;
  /** 시간 예산이 모자라 시작하지 않은 일이 있다. */
  private outOfTime = false;
  /** Pass 2 작업이 던진 오류 (처음 것만). */
  private failure: unknown = null;
  private issueCount = 0;
  private actualModel: string | null = null;

  constructor(init: TierRunInit) {
    this.deps = init.deps;
    this.tier = init.tier;
    this.userId = init.userId;
    this.reading = init.reading;
    this.readingId = init.reading.id;
    this.plan = init.plan;
    this.product = init.product;
    this.claimed = init.claimed;
    this.attempt = init.claimed.attempts;
    this.startedAt = init.startedAt;
    this.deadlineAt = init.startedAt + SCROLL_SETTINGS.budgetMs;
    this.recorder = createCallRecorder((row) => this.deps.store.writeCall(row));
    const sections = init.product.scroll.sections;
    this.specs = new Map(sections.map((section) => [section.id, section] as const));
    this.unitIds = sections.filter((section) => section.tier === init.tier && section.kind !== "chart").map((section) => section.id);
    this.toc = sections.filter((section) => section.kind !== "chart").map((section) => ({ sectionId: section.id, title: section.title, tier: section.tier }));
    this.queue = new VoiceQueue(
      SCROLL_SETTINGS.voiceConcurrency,
      (id) => this.voice(id),
      (error) => {
        this.failure ??= error;
        this.halted = true;
      },
    );
  }

  private get stopped(): boolean {
    return this.lost || this.halted;
  }

  private get draftEffort(): string {
    return this.claimed.reasoningEffort ?? LLM_SETTINGS.tasks.mujinDraft.reasoningEffort;
  }

  private get voiceEffort(): string {
    return LLM_SETTINGS.tasks.mujinVoice.reasoningEffort;
  }

  private get timingView() {
    return this.timing ? { luck: this.timing.luck, months: this.timing.months } : null;
  }

  /** 장의 tier는 상품 정의에서만 정한다. */
  private tierOf(sectionId: string): ScrollTier {
    const spec = this.specs.get(sectionId);
    if (!spec) throw new ScrollStepError("unknown_section", false);
    return spec.tier;
  }

  private hasTime(ms: number): boolean {
    return this.deps.now() + ms <= this.deadlineAt;
  }

  private noteModel(model: string | null): void {
    if (model) this.actualModel = model;
  }

  private tags(step: LlmCallStep, unitId: string, versions: { promptVersion: string; schemaVersion: string; personaVersion: string | null; reasoningEffort: string }) {
    return this.recorder.forCall({
      readingId: this.readingId,
      userId: this.userId,
      productId: this.product.id,
      tier: this.tier,
      step,
      unitId,
      ...versions,
    });
  }

  async execute(): Promise<ScrollRunResult> {
    try {
      // 작업에 고정된 버전으로만 이어 쓴다. 모르는 버전이면 다시 시도해도 같으므로 재시도할 수 없는 실패로 정리한다.
      const bundle = findMujinBundle(this.claimed.promptVersion ?? "");
      if (!bundle) return await this.failStage("prompt_version_unavailable", false);
      const modelId = this.claimed.modelId;
      if (!modelId || modelId === "unconfigured") return await this.failStage("model_not_configured", false);
      const persona = findPersona(this.product.personaId, bundle.personaVersion);
      if (!persona) return await this.failStage("persona_unavailable", false);
      this.bundle = bundle;
      this.persona = persona;
      this.modelId = modelId;

      await this.prepare();
      this.resumeVoice();
      await this.draftChapters();
      if (this.tier === "paid") await this.draftClosing();
      await this.queue.drain();
      await this.recorder.flush();
      if (this.failure) return await this.failFrom(this.failure);
      const result = await this.finish();
      console.info("[scroll] run", {
        readingId: this.readingId,
        tier: this.tier,
        attempt: this.attempt,
        result,
        calls: this.meter.calls,
        issues: this.issueCount,
        durationMs: this.deps.now() - this.startedAt,
      });
      return result;
    } catch (error) {
      this.halted = true;
      await this.queue.drain();
      await this.recorder.flush();
      return await this.failFrom(error);
    }
  }

  /** 기간 재료(유료), 질문, 이번 단계의 장 계획, 검사 기준, 저장된 장 상태를 준비한다. */
  private async prepare(): Promise<void> {
    const { deps, plan, product, tier, readingId } = this;
    const { store } = deps;

    if (tier === "paid") {
      // 첫 유료 생성 때 Asia/Seoul 날짜로 고정하고, 그 뒤에는 고정된 값만 쓴다 (재시도·재열람·후속 질문).
      const referenceDate = await store.fixReferenceDate(readingId, seoulDate(new Date(deps.now())));
      if (!referenceDate) throw new ScrollStepError("reference_date_unavailable", true);
      this.timing = await prepareScrollTimingWith({
        store,
        compute: deps.computeTiming,
        readingId,
        birth: this.reading.birth_input,
        referenceDate,
        gender: plan.gender,
      });
    }

    // 무료 단계에서 처음 정리해 저장하고, 유료 단계는 저장된 것을 다시 쓴다.
    const prepared = await prepareScrollQuestionsWith({
      store,
      classify: deps.classify,
      now: deps.now,
      readingId,
      userId: this.userId,
      product,
      concern: this.reading.concern ?? "",
      modelId: this.modelId,
      deadlineAt: this.deadlineAt,
      recorder: this.recorder,
      tier,
      bundle: this.bundle,
      meter: this.meter,
    });
    this.questions = prepared.questions;
    this.excluded = prepared.excluded;

    let startRef = nextRefOf(plan);
    const base = plan.sections.filter((section) => this.specs.get(section.sectionId)?.tier === tier);
    const added: MujinSectionPlan[] = [];
    if (this.timing) {
      const built = buildTimingSections({ plan, bundle: this.timing, product, startRef });
      added.push(...built.sections);
      startRef = built.nextRef;
    }
    const personalized = personalizeSections({
      sections: [...base, ...added],
      product,
      now: plan.now,
      questions: prepared.questions,
      concernFacts: prepared.concernFacts,
      startRef,
    });
    for (const section of personalized.sections) this.sections.set(section.sectionId, section);
    this.closingStartRef = personalized.nextRef;
    // 무료 단계에는 무료 장에 이어진 질문만 넘긴다. 유료 장에서 답할 질문을 결제 전 장에서 먼저 답하지 않게 한다.
    this.questionMaterials = tier === "free" ? personalized.questionMaterials.filter((question) => question.sectionIds.length > 0) : personalized.questionMaterials;

    const [units, finals] = await Promise.all([store.loadUnits(readingId), store.loadFinals(readingId)]);
    for (const unit of units) {
      this.units.set(unit.unitId, unit);
      if (unit.draft) this.drafts.set(unit.unitId, unit.draft);
    }
    for (const final of finals) this.finals.set(final.sectionId, final.content);

    // 앞에서 이미 쓴 장면 요약을 목차 순서로 넘긴다. 무료 단계에는 무료 장의 것만 넣는다.
    for (const spec of product.scroll.sections) {
      if (tier === "free" && spec.tier !== "free") continue;
      this.usedScenes.push(...(this.drafts.get(spec.id)?.scenes ?? []));
    }

    // 계획에 없는 장은 영원히 쓰이지 않는다. 이 코드와 맞지 않는 계획이다.
    if (this.unitIds.some((id) => this.specs.get(id)?.kind !== "closing" && !this.sections.has(id))) {
      throw new ScrollStepError("plan_section_missing", false);
    }
    if (tier === "paid" && this.closingReady()) this.buildClosing();
    this.ctx = this.checkContext();
  }

  private checkContext(): MujinCheckContext {
    return buildCheckContext({
      plan: this.plan,
      sections: [...this.sections.values()],
      questions: this.questionMaterials,
      chart: this.reading.chart,
      timing: this.timingView,
      excluded: this.excluded,
    });
  }

  private get closingSpec(): ScrollSectionSpec | undefined {
    return this.product.scroll.sections.find((section) => section.kind === "closing" && section.tier === this.tier);
  }

  private isClosingBatch(batch: ScrollDraftBatch): boolean {
    return batch.sectionIds.some((id) => this.specs.get(id)?.kind === "closing");
  }

  /** 마지막 정리를 쓸 수 있는가: 유료 장마다 초안이 있거나, 초안 시도 수를 다 써서 더 쓰지 않는다. */
  private closingReady(): boolean {
    return this.product.scroll.sections
      .filter((section) => section.kind === "chapter" && section.tier === "paid")
      .every((section) => {
        if (this.drafts.has(section.id)) return true;
        const unit = this.units.get(section.id);
        return unit?.status === "failed" && unit.errorStage === "draft" && unit.draftAttempts >= SCROLL_SETTINGS.draftAttemptsPerUnit;
      });
  }

  /** 마지막 정리 계획. 각 장 초안의 핵심 답(초안이 없으면 최종문의 핵심 답)을 모은다. 초안은 저장 뒤 바뀌지 않아 요청마다 같은 계획이 나온다. */
  private buildClosing(): void {
    const chapterAnswers = this.product.scroll.sections
      .filter((section) => section.kind === "chapter")
      .map((section) => ({
        sectionId: section.id,
        title: section.title,
        coreAnswer: this.drafts.get(section.id)?.coreAnswer ?? this.finals.get(section.id)?.coreAnswer ?? "",
      }));
    const closing = buildClosingSection({ product: this.product, questions: this.questions, chapterAnswers, startRef: this.closingStartRef });
    this.sections.set(closing.section.sectionId, closing.section);
    this.ctx = this.checkContext();
  }

  /** 이전 요청에서 초안까지 저장한 장은 저장된 초안으로 Pass 2만 다시 한다 (Pass 1 호출 없음). */
  private resumeVoice(): void {
    for (const id of this.unitIds) {
      if (needsVoice(this.units.get(id)) && this.drafts.has(id) && this.sections.has(id)) this.queue.push(id);
    }
  }

  /** 이번 단계의 Pass 1 묶음을 목차 순서로 하나씩 쓴다 (마지막 정리 묶음 제외). */
  private async draftChapters(): Promise<void> {
    for (const batch of this.product.scroll.draftBatches) {
      if (batch.tier !== this.tier || this.isClosingBatch(batch)) continue;
      if (this.stopped) return;
      const ids = batch.sectionIds.filter((id) => this.specs.get(id)?.tier === this.tier && this.sections.has(id) && needsDraft(this.units.get(id)));
      if (!ids.length) continue;
      if (!this.hasTime(LLM_SETTINGS.tasks.mujinDraft.timeoutMs)) {
        this.outOfTime = true;
        return;
      }
      await this.draftBatch(batch, ids);
    }
  }

  /** 마지막 정리 (유료 단계). 유료 장의 초안이 모두 준비된 뒤에만 쓴다. */
  private async draftClosing(): Promise<void> {
    const spec = this.closingSpec;
    if (!spec || this.stopped || this.outOfTime) return;
    if (!needsDraft(this.units.get(spec.id)) || !this.closingReady()) return;
    if (!this.sections.has(spec.id)) this.buildClosing();
    if (!this.hasTime(LLM_SETTINGS.tasks.mujinDraft.timeoutMs)) {
      this.outOfTime = true;
      return;
    }
    const batch = this.product.scroll.draftBatches.find((entry) => entry.sectionIds.includes(spec.id)) ?? { id: spec.id, tier: spec.tier, sectionIds: [spec.id] };
    await this.draftBatch(batch, [spec.id]);
  }

  /**
   * Pass 1 묶음 하나. 스트림에서 장 원소가 닫힐 때마다 검사·저장하고 Pass 2 대기열에 넣는다.
   * 스트림이 끝나면 받지 못했거나 검사에 걸린 장만 모아, 시간과 retriesPerRun이 허락하면 그 장만 다시 요청한다.
   * 그래도 남은 장은 장마다 실패로 기록한다 (시도 수가 남았으면 다시 시도할 수 있게).
   */
  private async draftBatch(batch: ScrollDraftBatch, ids: readonly string[]): Promise<void> {
    const task = LLM_SETTINGS.tasks.mujinDraft;
    const pending = new Set(ids);
    const problems = new Map<string, { readonly code: string; readonly issues: readonly string[] }>();
    let lastError: LlmError | null = null;
    // 기간 자료는 9·10장 묶음에만 넣는다.
    const timing = batch.sectionIds.some((id) => TIMING_SECTION_IDS.has(id)) ? this.timingView : null;

    for (let round = 0; round <= SCROLL_SETTINGS.retriesPerRun && pending.size > 0; round += 1) {
      if (this.stopped) return;
      if (round > 0 && !this.hasTime(task.timeoutMs)) {
        this.outOfTime = true;
        break;
      }
      const requested = ids.filter((id) => pending.has(id));
      const previousIssues = round > 0 ? unique(requested.flatMap((id) => (problems.get(id)?.issues ?? []).map(issueSummary))).slice(0, 15) : undefined;
      problems.clear();
      lastError = null;
      const state: DraftRound = { batchId: batch.id, round, pending, handled: new Set(), problems, previousIssues };
      const request = buildDraftRequest({
        bundle: this.bundle,
        plan: this.plan,
        sections: requested.map((id) => this.sections.get(id)!),
        questions: this.questionMaterials,
        usedScenes: [...this.usedScenes],
        toc: this.toc,
        timing,
        previousIssues,
      });

      let consumed = 0;
      const consume = async (text: string) => {
        const items = completedArrayItems(text, "sections");
        while (consumed < items.length && !this.stopped) {
          const item = items[consumed];
          consumed += 1;
          await this.acceptDraft(item, state);
        }
      };
      try {
        const result = await this.deps.callStructuredStream({
          ...request,
          model: this.modelId,
          reasoningEffort: this.draftEffort,
          maxOutputTokens: task.maxOutputTokens,
          timeoutMs: task.timeoutMs,
          deadlineAt: this.deadlineAt,
          meter: this.meter,
          onCall: this.tags("pass1", batch.id, {
            promptVersion: this.bundle.draftPrompt,
            schemaVersion: this.bundle.draftSchema,
            personaVersion: null,
            reasoningEffort: this.draftEffort,
          }),
          // 짧은 초안 저장만 기다린다. Pass 2는 대기열에 넣기만 한다.
          onDelta: async (text) => {
            await consume(text);
            return this.stopped ? "stop" : "continue";
          },
        });
        if (!result.stopped) await consume(result.text);
        this.noteModel(result.meta.actualModel);
      } catch (error) {
        // 받기 시작한 뒤 끊긴 스트림도 이미 저장한 장은 그대로 둔다. 설정 오류와 저장소 오류는 단계 실패로 올린다.
        if (!(error instanceof LlmError) || error.isConfigurationError) throw error;
        lastError = error;
      }
      if (this.stopped) return;
      for (const id of requested) {
        if (pending.has(id) && !problems.has(id)) problems.set(id, { code: lastError?.code ?? "missing_section", issues: [`${id}: 응답에 이 장이 없습니다.`] });
      }
    }
    if (this.stopped) return;
    for (const id of ids) {
      if (!pending.has(id)) continue;
      await this.failUnit(id, "draft", problems.get(id)?.code ?? lastError?.code ?? "missing_section");
      if (this.stopped) return;
    }
  }

  /** 스트림에서 닫힌 장 원소 하나. 형식·소속·검사를 확인하고, 통과하면 초안을 저장해 Pass 2 대기열에 넣는다. */
  private async acceptDraft(item: unknown, round: DraftRound): Promise<void> {
    const parsed = MujinDraftSectionParser.safeParse(item);
    if (!parsed.success) {
      const claimed = (item as { sectionId?: unknown } | null)?.sectionId;
      if (typeof claimed === "string" && round.pending.has(claimed) && !round.handled.has(claimed)) {
        round.handled.add(claimed);
        round.problems.set(claimed, { code: "invalid_output", issues: [`${claimed}: 출력 형식이 맞지 않습니다.`] });
      }
      this.issueCount += 1;
      return;
    }
    const draft = parsed.data;
    const id = draft.sectionId;
    // 이 묶음에서 요청하지 않은 장이나 같은 장의 두 번째 원소는 쓰지 않는다.
    if (!round.pending.has(id) || round.handled.has(id)) {
      this.issueCount += 1;
      return;
    }
    round.handled.add(id);
    const issues = checkDraftSection(draft, this.sections.get(id)!, this.ctx);
    if (issues.length) {
      // 그 장의 문제로만 기록하고 스트림은 계속 받는다 (장 초안은 서로 독립이다).
      this.issueCount += issues.length;
      round.problems.set(id, { code: "validation_failed", issues });
      return;
    }
    const tier = this.tierOf(id);
    const saved = await this.deps.store.saveDraft({
      readingId: this.readingId,
      tier,
      attempt: this.attempt,
      unitId: id,
      draft,
      meta: {
        bundle: this.bundle.id,
        draftPrompt: this.bundle.draftPrompt,
        draftSchema: this.bundle.draftSchema,
        modelId: this.modelId,
        batchId: round.batchId,
        round: round.round,
        // 앞선 시도의 문제 종류 (생성 문장 없음).
        issues: round.previousIssues ?? [],
      },
    });
    if (!saved) {
      this.lost = true;
      return;
    }
    round.pending.delete(id);
    const unit = this.units.get(id) ?? blankUnit(id, tier);
    this.units.set(id, { ...unit, status: "drafted", draft, draftAttempts: unit.draftAttempts + 1, errorStage: null, errorCode: null, errorRetryable: null });
    this.drafts.set(id, draft);
    this.usedScenes.push(...draft.scenes);
    this.queue.push(id);
  }

  /** Pass 2 작업 하나 (장 하나). 검사에 걸리면 retriesPerRun번까지 문제만 알려 다시 요청한다. */
  private async voice(id: string): Promise<void> {
    if (this.stopped) return;
    const section = this.sections.get(id);
    const draft = this.drafts.get(id);
    if (!section || !draft) return;
    const task = LLM_SETTINGS.tasks.mujinVoice;
    // 검사 기준과 같은 사용자 사실 (지금의 나 + 이 장의 사용자 사실).
    const userFacts = [...this.plan.nowFacts, ...section.materials.filter((material) => material.kind === "user-fact")];
    let previousIssues: string[] | undefined;
    let code = "validation_failed";
    let attempted = false;

    for (let round = 0; round <= SCROLL_SETTINGS.retriesPerRun; round += 1) {
      if (this.stopped) return;
      // 시간이 모자라면 시작하지 않는다. 저장된 초안으로 다음 요청이 이어 한다.
      if (!this.hasTime(task.timeoutMs + SCROLL_SETTINGS.voiceStartMarginMs)) {
        this.outOfTime = true;
        break;
      }
      attempted = true;
      const request = buildVoiceRequest({
        bundle: this.bundle,
        persona: this.persona,
        nickname: this.plan.nickname,
        section: {
          sectionId: section.sectionId,
          title: section.title,
          questions: section.questions.map((question) => ({ id: question.id, title: question.title })),
          targetChars: section.targetChars,
        },
        draft,
        userFacts,
        previousIssues,
      });
      let result: StructuredResult<MujinVoiceOutput>;
      try {
        result = await this.deps.callStructured({
          ...request,
          model: this.modelId,
          reasoningEffort: this.voiceEffort,
          maxOutputTokens: task.maxOutputTokens,
          timeoutMs: task.timeoutMs,
          deadlineAt: this.deadlineAt,
          meter: this.meter,
          onCall: this.tags("pass2", id, {
            promptVersion: this.bundle.voicePrompt,
            schemaVersion: this.bundle.voiceSchema,
            personaVersion: this.persona.version,
            reasoningEffort: this.voiceEffort,
          }),
        });
      } catch (error) {
        if (!(error instanceof LlmError) || error.isConfigurationError) throw error;
        code = error.code;
        break;
      }
      this.noteModel(result.meta.actualModel);
      // 늦게 도착한 응답은 점유를 잃었으면 저장하지 않는다.
      if (this.stopped) return;
      const content = result.parsed.section;
      const issues = checkVoiceSection(content, draft, section, this.ctx);
      if (!issues.length) {
        const saved = await this.deps.store.saveFinal({
          readingId: this.readingId,
          tier: this.tierOf(id),
          attempt: this.attempt,
          unitId: id,
          content,
          meta: {
            bundle: this.bundle.id,
            voicePrompt: this.bundle.voicePrompt,
            voiceSchema: this.bundle.voiceSchema,
            personaVersion: this.persona.version,
            modelId: this.modelId,
            actualModel: result.meta.actualModel,
            durationMs: result.meta.durationMs,
            issues: previousIssues ?? [],
          },
        });
        if (!saved) {
          this.lost = true;
          return;
        }
        const unit = this.units.get(id) ?? blankUnit(id, this.tierOf(id));
        this.units.set(id, { ...unit, status: "done", voiceAttempts: unit.voiceAttempts + 1, errorStage: null, errorCode: null, errorRetryable: null });
        return;
      }
      this.issueCount += issues.length;
      code = "validation_failed";
      previousIssues = unique(issues.map(issueSummary)).slice(0, 15);
    }
    if (!attempted || this.stopped) return;
    await this.failUnit(id, "voice", code);
  }

  /** 장 하나의 실패 기록. 이번 시도를 더해도 상한 미만이면 다시 시도할 수 있다. */
  private async failUnit(id: string, stage: "draft" | "voice", code: string): Promise<void> {
    const tier = this.tierOf(id);
    const unit = this.units.get(id) ?? blankUnit(id, tier);
    const used = stage === "draft" ? unit.draftAttempts : unit.voiceAttempts;
    const limit = stage === "draft" ? SCROLL_SETTINGS.draftAttemptsPerUnit : SCROLL_SETTINGS.voiceAttemptsPerUnit;
    const retryable = used + 1 < limit;
    const result = await this.deps.store.failUnit({ readingId: this.readingId, tier, attempt: this.attempt, unitId: id, stage, code, retryable });
    if (!result.saved) {
      this.lost = true;
      return;
    }
    this.units.set(id, {
      ...unit,
      status: "failed",
      draftAttempts: result.draftAttempts,
      voiceAttempts: result.voiceAttempts,
      errorStage: stage,
      errorCode: code,
      errorRetryable: retryable,
    });
  }

  /** 저장된 상태를 다시 읽어 단계를 마치거나, 반납하거나, 실패로 정리한다. */
  private async finish(): Promise<ScrollRunResult> {
    if (this.lost) return "running";
    const { store } = this.deps;
    const units = new Map((await store.loadUnits(this.readingId)).map((unit) => [unit.unitId, unit] as const));
    const states = this.unitIds.map((id) => units.get(id));
    if (states.every((unit) => unit?.status === "done")) {
      const completed = await store.completeRun(this.tier, this.readingId, this.attempt, this.tier === "paid" ? this.completionMeta() : {});
      return completed ? "completed" : "running";
    }
    const failed = states.filter((unit): unit is UnitRecord => unit?.status === "failed");
    const retryable = failed.filter(retryableUnit);
    const unfinished = states.filter((unit) => !unit || unit.status === "pending" || unit.status === "drafted");
    if (this.outOfTime && (unfinished.length > 0 || retryable.length > 0)) {
      // 시간이 다 되어 남은 장이 있다. 반납하면 다음 요청이 점유 시간을 기다리지 않고 바로 이어받는다.
      const released = await store.releaseRun(this.tier, this.readingId, this.attempt);
      return released ? "partial" : "running";
    }
    if (failed.length > 0) return this.failStage("units_failed", retryable.length > 0);
    // 시간이 남았는데 쓰지 못한 장이 있다 (예상하지 못한 상태). 같은 요청을 끝없이 되풀이하지 않게 실패로 알린다.
    return this.failStage("units_stalled", true);
  }

  /** complete_generation의 p_meta. 작업 행은 소유자가 읽을 수 있으므로 버전·사용량·횟수만 담는다. */
  private completionMeta(): Record<string, unknown> {
    return {
      actualModel: this.actualModel,
      usage: this.meter.summary(),
      durationMs: Math.round(this.deps.now() - this.startedAt),
      llmCalls: this.meter.calls,
      issueCount: this.issueCount,
      versions: {
        planVersion: this.plan.planVersion,
        productVersion: this.plan.productVersion,
        bundle: this.bundle.id,
        draftPrompt: this.bundle.draftPrompt,
        draftSchema: this.bundle.draftSchema,
        voicePrompt: this.bundle.voicePrompt,
        voiceSchema: this.bundle.voiceSchema,
        questionPrompt: this.bundle.questionPrompt,
        questionSchema: this.bundle.questionSchema,
        questionAnalysis: SCROLL_QUESTION_VERSION,
        personaVersion: this.persona.version,
        planPersonaVersion: this.plan.personaVersion,
        personalizeVersion: MUJIN_PERSONALIZE_VERSION,
        timingPlanVersion: MUJIN_TIMING_PLAN_VERSION,
        timingVersion: this.timing?.version ?? null,
        referenceDate: this.timing?.referenceDate ?? null,
      },
    };
  }

  private async failFrom(error: unknown): Promise<ScrollRunResult> {
    if (error instanceof ScrollStepError) return this.failStage(error.code, error.retryable);
    if (error instanceof LlmError) return this.failStage(error.code, !error.isConfigurationError);
    console.error("[scroll] unexpected", { readingId: this.readingId, tier: this.tier, reason: internalReason(error) });
    return this.failStage("internal", true);
  }

  private async failStage(code: string, retryable: boolean): Promise<ScrollRunResult> {
    if (this.lost) return "running";
    console.error("[scroll] failed", { readingId: this.readingId, tier: this.tier, attempt: this.attempt, code });
    try {
      const recorded = await this.deps.store.failRun(this.tier, this.readingId, this.attempt, code, retryable, this.meter.calls);
      return recorded ? "failed" : "running";
    } catch (error) {
      console.error("[scroll] failure not recorded", { readingId: this.readingId, tier: this.tier, reason: internalReason(error) });
      return "failed";
    }
  }
}

async function claimTier(store: ScrollStore, input: { readonly userId: string; readonly readingId: string; readonly tier: ScrollTier; readonly retry: boolean }): Promise<ClaimOutcome> {
  const current = MUJIN_BUNDLES[MUJIN_BUNDLE_VERSION]!;
  let model: string;
  try {
    model = resolveModelId();
  } catch {
    model = "unconfigured";
  }
  const request = {
    userId: input.userId,
    readingId: input.readingId,
    retry: input.retry,
    model,
    // 묶음 ID 하나로 Pass 1·Pass 2·질문 정리 버전을 함께 고정한다.
    promptVersion: MUJIN_BUNDLE_VERSION,
    reasoningEffort: LLM_SETTINGS.tasks.mujinDraft.reasoningEffort,
    leaseSeconds: SCROLL_SETTINGS.leaseSeconds,
  };
  try {
    return input.tier === "free"
      ? await store.claimFree({ ...request, schemaVersion: current.draftSchema, maxAttempts: SCROLL_SETTINGS.freeMaxRuns, dailyLimit: SCROLL_SETTINGS.freeDailyLimit })
      : await store.claimPaid({ ...request, schemaVersion: current.voiceSchema, maxAttempts: SCROLL_SETTINGS.paidMaxRuns });
  } catch (error) {
    console.error("[scroll] claim failed", { readingId: input.readingId, tier: input.tier, reason: internalReason(error) });
    throw new ApiError(500, "claim_failed", "풀이를 시작하지 못했어요.");
  }
}

/**
 * 한 단계를 이 요청 안에서 쓴다 (명세 5절). 결과:
 * completed(이 단계 끝) · running(다른 요청이 쓰는 중이거나 점유를 잃음) · partial(시간 예산이 끝나 반납, 곧바로 다시 요청) ·
 * failed(장 실패·설정 오류 등, 화면이 다시 시도를 보여 줌) · exhausted(시작 횟수 상한) · locked(구매 권한 없음) ·
 * daily_limited(회원당 하루 무료 시작 수) · not_ready(유료 단계인데 무료 단계가 아직 끝나지 않음).
 * 풀이가 없거나 소유자가 아니면 ApiError(404)를 던진다.
 */
export async function runScrollTier(input: {
  readonly userId: string;
  readonly readingId: string;
  readonly tier: ScrollTier;
  readonly retry: boolean;
  readonly deps?: Partial<RunnerDeps>;
}): Promise<ScrollRunResult> {
  const deps = resolveDeps(input.deps);
  const { userId, readingId, tier } = input;
  const startedAt = deps.now();

  const loaded = await deps.store.loadReading(readingId, userId);
  if (!loaded) throw new ApiError(404, "not_found", "풀이를 찾을 수 없어요.");
  const product = findScrollProduct(loaded.reading.product_id);
  if (!product) throw new ApiError(409, "unsupported_product", "이 풀이는 장별 생성을 쓰지 않아요.");
  if ((loaded.plan as { planVersion?: unknown } | null)?.planVersion !== MUJIN_PLAN_VERSION) {
    throw new ApiError(409, "plan_version_unavailable", "이 풀이는 지금 이어서 쓸 수 없어요.");
  }

  if (tier === "paid") {
    // 권한 없이 유료 장을 시작하지 않는다 (DB의 claim과 저장 함수도 다시 확인한다). 무료 1장이 먼저 보여야 하고 질문 분석도 무료 단계에서 저장된다.
    const [entitled, freeStatus] = await Promise.all([deps.store.hasEntitlement(readingId, userId), deps.store.freeRunStatus(readingId)]);
    if (!entitled) return "locked";
    if (freeStatus !== "completed") return "not_ready";
  }

  const claim = await claimTier(deps.store, { userId, readingId, tier, retry: input.retry });
  if (!claim.claimed) return claim.reason === "not_entitled" ? "locked" : claim.reason;

  return new TierRun({ deps, tier, userId, reading: loaded.reading, plan: loaded.plan, product, claimed: claim.run, startedAt }).execute();
}
