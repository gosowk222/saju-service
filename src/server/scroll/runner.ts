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
import type { ExcludedQuestion } from "@/domain/reading/check";
import { seoulDate } from "@/domain/reading/question";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import { ApiError } from "@/server/api";
import { computeMujinTiming } from "@/server/engine/mujin";
import { LlmError, callStructured, callStructuredStream } from "@/server/llm/client";
import { LLM_SETTINGS, resolveModelId } from "@/server/llm/config";
import { promptExampleConfig, type ExampleRecord } from "@/server/llm/example-block";
import {
  MujinDraftSectionParser,
  buildDraftRequest,
  buildVoiceRequest,
  findMujinBundle,
  requestFields,
  type MujinBundle,
  type MujinVoiceOutput,
} from "@/server/llm/mujin-prompts";
import { internalReason } from "@/server/log";
import {
  TwoPassRun,
  isNotSent,
  needsDraft as needsDraftWith,
  needsVoice as needsVoiceWith,
  unitOutcome,
  type ParsedDraft,
  type RequestFields,
  type StepVersions,
  type UnitTier,
  type VoiceCall,
} from "@/server/generation/two-pass";
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
 * - 장 단위 2-pass의 공통 실행(스트림 수신, 장 검사·저장, Pass 2 대기열, 재시도, 실패 기록, 호출 기록)은 src/server/generation/two-pass.ts의
 *   TwoPassRun에 있고, 묘묘 2-pass(src/server/generation/messenger-run.ts)와 함께 쓴다. 이 파일은 무진에만 있는 준비와 마무리를 정한다.
 * - Pass 1(평문 초안)은 장 묶음마다 스트림으로 받고, 장 원소가 닫힐 때마다 검사해 저장한 뒤 Pass 2(무진 문장) 대기열에 넣는다.
 *   스트림 수신 루프는 짧은 초안 저장만 기다리고 Pass 2를 기다리지 않는다 (프로세스 전역 동시 호출 제한과의 교착 방지).
 * - 검사에 걸린 장만 다시 요청한다. 장마다 시도 수 상한을 넘으면 그 장만 실패로 남는다. 저장된 장은 다시 만들지 않는다.
 * - 저장 함수가 false를 돌려주면 다른 요청이 이어받은 것이다. 이 요청은 더 저장하지 않는다 (늦은 응답이 새 상태를 덮지 않음).
 * - 장의 tier는 상품 정의(ScrollSectionSpec.tier)에서 정한다. DB는 서버가 보낸 tier를 믿는다.
 * - 모든 LLM 호출은 llm_calls에 태그(단계, 무료·유료, 장·묶음 ID, 버전)와 함께 남는다. 로그에는 코드와 ID만 남긴다.
 * - 모든 LLM 호출은 guardStart를 켠다: 프로세스 전역 동시 호출 자리를 기다린 뒤 남은 시간이 그 호출의 제한 시간보다 짧으면
 *   보내지 않고 deadline_reached로 끝난다 (호출 기록 없음). 이때는 장 실패로 세지 않고 새 호출을 멈춘 뒤 반납(partial)한다.
 * - 새 호출을 시작하기 전에는 멈춤(점유 잃음·다른 작업 오류)을 보고, 응답을 받은 뒤에는 점유를 잃었을 때만 버린다.
 *   다른 작업 오류로 멈춘 실행도 이미 받은 결과는 검사해 저장한다 (저장 함수가 점유를 다시 확인한다).
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

/** 요청에 guardStart를 켜서 보낸다. 질문 정리처럼 요청을 다른 모듈이 만드는 호출에 쓴다. */
function guarded(call: typeof callStructured): typeof callStructured {
  return (request) => call({ ...request, guardStart: true });
}

function resolveDeps(partial: Partial<RunnerDeps> = {}): RunnerDeps {
  const call = partial.callStructured ?? callStructured;
  return {
    callStructured: call,
    callStructuredStream: partial.callStructuredStream ?? callStructuredStream,
    now: partial.now ?? Date.now,
    store: partial.store ?? createScrollStore(createSupabaseAdminClient()),
    computeTiming: partial.computeTiming ?? computeMujinTiming,
    classify: partial.classify ?? scrollClassifier(guarded(call)),
  };
}

/** Pass 1 초안이 필요한 장 (무진 설정의 시도 수 상한, 공통 판단은 two-pass.ts). */
export function needsDraft(unit: UnitRecord | undefined): boolean {
  return needsDraftWith(unit, SCROLL_SETTINGS);
}

/** 저장된 초안으로 Pass 2를 할 장 (무진 설정의 시도 수 상한, 공통 판단은 two-pass.ts). */
export function needsVoice(unit: UnitRecord | undefined): boolean {
  return needsVoiceWith(unit, SCROLL_SETTINGS);
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

/** 점유한 한 단계의 실행. 요청 하나가 끝나면 버린다. 공통 2-pass 실행(TwoPassRun)에 무진의 장·묶음·검사·저장 메타를 채운다. */
class TierRun extends TwoPassRun<ScrollDraftContent, ScrollSectionContent, MujinVoiceOutput, ScrollDraftBatch> {
  private readonly runnerDeps: RunnerDeps;
  private readonly tier: ScrollTier;
  private readonly reading: ScrollReadingRecord;
  private readonly plan: MujinPlan;
  private readonly product: ScrollProductDefinition;
  private readonly claimed: ClaimedRun;
  private readonly specs: ReadonlyMap<string, ScrollSectionSpec>;
  /** 이번 단계가 쓰는 장 (원국표 제외, 목차 순서). */
  private readonly unitIds: readonly string[];
  private readonly toc: readonly { readonly sectionId: string; readonly title: string; readonly tier: ScrollTier }[];
  protected readonly draftItemsKey = "sections";

  private bundle!: MujinBundle;
  private persona!: Persona;
  private ctx!: MujinCheckContext;
  private timing: MujinTimingBundle | null = null;
  private questions: readonly MujinQuestionInput[] = [];
  private questionMaterials: readonly MujinQuestionMaterial[] = [];
  private excluded: readonly ExcludedQuestion[] = [];
  private closingStartRef = 1;
  private readonly sections = new Map<string, MujinSectionPlan>();
  private readonly finals = new Map<string, ScrollSectionContent>();
  private readonly usedScenes: string[] = [];

  constructor(init: TierRunInit) {
    super({
      deps: init.deps,
      settings: SCROLL_SETTINGS,
      store: init.deps.store,
      readingId: init.reading.id,
      userId: init.userId,
      productId: init.product.id,
      attempt: init.claimed.attempts,
      // 모델이 정해지지 않은 작업은 execute가 호출 전에 실패로 정리한다.
      modelId: init.claimed.modelId ?? "unconfigured",
      startedAt: init.startedAt,
      personaId: init.product.personaId,
      policyVersion: init.claimed.promptVersion,
    });
    this.runnerDeps = init.deps;
    this.tier = init.tier;
    this.reading = init.reading;
    this.plan = init.plan;
    this.product = init.product;
    this.claimed = init.claimed;
    const sections = init.product.scroll.sections;
    this.specs = new Map(sections.map((section) => [section.id, section] as const));
    this.unitIds = sections.filter((section) => section.tier === init.tier && section.kind !== "chart").map((section) => section.id);
    this.toc = sections.filter((section) => section.kind !== "chart").map((section) => ({ sectionId: section.id, title: section.title, tier: section.tier }));
  }

  private get timingView() {
    return this.timing ? { luck: this.timing.luck, months: this.timing.months } : null;
  }

  // ─── 공통 실행기(TwoPassRun)가 부르는 자리 ─────────────────────

  /** 장의 tier는 상품 정의에서만 정한다. */
  protected tierOf(sectionId: string): ScrollTier {
    const spec = this.specs.get(sectionId);
    if (!spec) throw new ScrollStepError("unknown_section", false);
    return spec.tier;
  }

  protected callTier(): UnitTier {
    return this.tier;
  }

  protected draftReasoningEffort(): string {
    return this.claimed.reasoningEffort ?? LLM_SETTINGS.tasks.draft.reasoningEffort;
  }

  protected voiceReasoningEffort(): string {
    return LLM_SETTINGS.tasks.voice.reasoningEffort;
  }

  protected draftVersions(): StepVersions {
    return { promptVersion: this.bundle.draftPrompt, schemaVersion: this.bundle.draftSchema, personaVersion: null, reasoningEffort: this.draftReasoningEffort() };
  }

  protected voiceVersions(): StepVersions {
    return { promptVersion: this.bundle.voicePrompt, schemaVersion: this.bundle.voiceSchema, personaVersion: this.persona.version, reasoningEffort: this.voiceReasoningEffort() };
  }

  protected buildDraftRequest(batch: ScrollDraftBatch, requested: readonly string[], previousIssues: readonly string[] | undefined): RequestFields<unknown> {
    // 기간 자료는 9·10장 묶음에만 넣는다.
    const timing = batch.sectionIds.some((id) => TIMING_SECTION_IDS.has(id)) ? this.timingView : null;
    // Pass 1은 캐릭터 없는 중립 초안이라 문답 예시가 없다 (buildDraftRequest의 examples는 늘 null).
    return requestFields(
      buildDraftRequest({
        bundle: this.bundle,
        plan: this.plan,
        sections: requested.map((id) => this.sections.get(id)!),
        questions: this.questionMaterials,
        usedScenes: [...this.usedScenes],
        toc: this.toc,
        timing,
        previousIssues,
      }),
    ) as RequestFields<unknown>;
  }

  protected parseDraft(item: unknown): ParsedDraft<ScrollDraftContent> {
    const parsed = MujinDraftSectionParser.safeParse(item);
    if (parsed.success) return { ok: true, unitId: parsed.data.sectionId, draft: parsed.data };
    const claimed = (item as { sectionId?: unknown } | null)?.sectionId;
    return { ok: false, unitId: typeof claimed === "string" ? claimed : null };
  }

  protected checkDraft(id: string, draft: ScrollDraftContent): string[] {
    return checkDraftSection(draft, this.sections.get(id)!, this.ctx);
  }

  protected draftMeta(batchId: string, round: number, previousIssues: readonly string[] | undefined): Record<string, unknown> {
    return {
      bundle: this.bundle.id,
      draftPrompt: this.bundle.draftPrompt,
      draftSchema: this.bundle.draftSchema,
      modelId: this.modelId,
      batchId,
      round,
      // 앞선 시도의 문제 종류 (생성 문장 없음).
      issues: previousIssues ?? [],
    };
  }

  protected onDraftSaved(_id: string, draft: ScrollDraftContent): void {
    this.usedScenes.push(...draft.scenes);
  }

  protected canVoice(id: string): boolean {
    return this.sections.has(id);
  }

  protected buildVoiceRequest(id: string, draft: ScrollDraftContent, previousIssues: readonly string[] | undefined): VoiceCall<MujinVoiceOutput> {
    const section = this.sections.get(id)!;
    // 검사 기준과 같은 사용자 사실 (지금의 나 + 이 장의 사용자 사실).
    const userFacts = [...this.plan.nowFacts, ...section.materials.filter((material) => material.kind === "user-fact")];
    const built = buildVoiceRequest({
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
      previousIssues: previousIssues ? [...previousIssues] : undefined,
      // 문답 예시(mujin-voice-1.1.0부터)는 풀이 ID·장 ID와 저장된 계획으로 고른다. 같은 장의 재시도는 같은 예시를 받는다.
      hourKnown: this.plan.hourKnown,
      exampleSeed: this.readingId,
    });
    return { request: requestFields(built), examples: built.examples };
  }

  protected finalOf(_id: string, output: MujinVoiceOutput): ScrollSectionContent {
    return output.section;
  }

  protected checkVoice(id: string, content: ScrollSectionContent, draft: ScrollDraftContent): string[] {
    return checkVoiceSection(content, draft, this.sections.get(id)!, this.ctx);
  }

  protected finalMeta(input: { readonly examples: ExampleRecord | null; readonly actualModel: string | null; readonly durationMs: number; readonly previousIssues: readonly string[] }) {
    return {
      bundle: this.bundle.id,
      voicePrompt: this.bundle.voicePrompt,
      voiceSchema: this.bundle.voiceSchema,
      personaVersion: this.persona.version,
      modelId: this.modelId,
      actualModel: input.actualModel,
      durationMs: input.durationMs,
      issues: input.previousIssues,
      // 지시에 넣은 문답 예시의 카탈로그·정책 버전과 ID (1.0.0 묶음은 null). 예시 문장은 넣지 않는다.
      examples: input.examples,
    };
  }

  // ─── 무진 단계 실행 ─────────────────────

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

      await this.prepare();
      this.resumeVoice(this.unitIds);
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
      if (isNotSent(error)) {
        // 질문 정리를 보내지 못했다 (남은 시간 부족). 단계를 실패로 두지 않고 반납해 다음 요청이 이어 쓰게 한다.
        this.markNotSent();
        await this.queue.drain();
        await this.recorder.flush();
        return this.failure ? await this.failFrom(this.failure) : await this.finish();
      }
      this.halted = true;
      await this.queue.drain();
      await this.recorder.flush();
      return await this.failFrom(error);
    }
  }

  /** 기간 재료(유료), 질문, 이번 단계의 장 계획, 검사 기준, 저장된 장 상태를 준비한다. */
  private async prepare(): Promise<void> {
    const { plan, product, tier, readingId } = this;
    const deps = this.runnerDeps;
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

  /** 이번 단계의 Pass 1 묶음을 목차 순서로 하나씩 쓴다 (마지막 정리 묶음 제외). */
  private async draftChapters(): Promise<void> {
    const batches = this.product.scroll.draftBatches.filter((batch) => batch.tier === this.tier && !this.isClosingBatch(batch));
    // 멈췄거나 보내지 못한 호출이 있었으면 새 묶음을 시작하지 않는다 (runDraftBatches).
    await this.runDraftBatches(batches, (batch) => batch.sectionIds.filter((id) => this.specs.get(id)?.tier === this.tier && this.sections.has(id)));
  }

  /** 마지막 정리 (유료 단계). 유료 장의 초안이 모두 준비된 뒤에만 쓴다. */
  private async draftClosing(): Promise<void> {
    const spec = this.closingSpec;
    if (!spec || this.stopped || this.outOfTime) return;
    if (!needsDraft(this.units.get(spec.id)) || !this.closingReady()) return;
    if (!this.sections.has(spec.id)) this.buildClosing();
    if (!this.hasTime(LLM_SETTINGS.tasks.draft.timeoutMs)) {
      this.outOfTime = true;
      return;
    }
    const batch = this.product.scroll.draftBatches.find((entry) => entry.sectionIds.includes(spec.id)) ?? { id: spec.id, tier: spec.tier, sectionIds: [spec.id] };
    await this.draftBatch(batch, [spec.id]);
  }

  /** 저장된 상태를 다시 읽어 단계를 마치거나, 반납하거나, 실패로 정리한다. */
  private async finish(): Promise<ScrollRunResult> {
    if (this.lost) return "running";
    const { store } = this.runnerDeps;
    const units = new Map((await store.loadUnits(this.readingId)).map((unit) => [unit.unitId, unit] as const));
    const outcome = unitOutcome(
      this.unitIds.map((id) => units.get(id)),
      this.outOfTime,
      SCROLL_SETTINGS,
    );
    if (outcome.kind === "done") {
      const completed = await store.completeRun(this.tier, this.readingId, this.attempt, this.tier === "paid" ? this.completionMeta() : {});
      return completed ? "completed" : "running";
    }
    if (outcome.kind === "release") {
      // 시간이 다 되어 남은 장이 있다. 반납하면 다음 요청이 점유 시간을 기다리지 않고 바로 이어받는다.
      const released = await store.releaseRun(this.tier, this.readingId, this.attempt);
      return released ? "partial" : "running";
    }
    if (outcome.kind === "failed") return this.failStage("units_failed", outcome.retryable);
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
        // Pass 2 지시에 넣는 문답 예시의 카탈로그·정책 버전 (장마다 고른 ID는 reading_sections.meta.examples에 있다). 1.0.0 묶음은 null.
        exampleCatalog: promptExampleConfig(this.bundle.voicePrompt)?.catalogVersion ?? null,
        examplePolicy: promptExampleConfig(this.bundle.voicePrompt)?.policyVersion ?? null,
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
      const recorded = await this.runnerDeps.store.failRun(this.tier, this.readingId, this.attempt, code, retryable, this.meter.calls);
      return recorded ? "failed" : "running";
    } catch (error) {
      console.error("[scroll] failure not recorded", { readingId: this.readingId, tier: this.tier, reason: internalReason(error) });
      return "failed";
    }
  }
}

async function claimTier(
  store: ScrollStore,
  product: ScrollProductDefinition,
  input: { readonly userId: string; readonly readingId: string; readonly tier: ScrollTier; readonly retry: boolean },
): Promise<ClaimOutcome> {
  // 새 단계가 고정할 묶음은 상품 설정이 가리킨다. 모르는 묶음이면 시작하지 않는다 (다른 묶음으로 바꾸지 않는다).
  const current = findMujinBundle(product.generation.bundle);
  if (!current) {
    console.error("[scroll] claim failed", { readingId: input.readingId, tier: input.tier, reason: "bundle_unavailable" });
    throw new ApiError(500, "claim_failed", "풀이를 시작하지 못했어요.");
  }
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
    promptVersion: current.id,
    reasoningEffort: LLM_SETTINGS.tasks.draft.reasoningEffort,
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
    // 다만 무료 단계가 더 다시 시도할 수 없는 실패로 끝났으면, 구매한 유료 장까지 막지 않는다 (질문 분석이 없으면 유료 단계가 정리한다).
    const [entitled, free] = await Promise.all([deps.store.hasEntitlement(readingId, userId), deps.store.freeRunStatus(readingId)]);
    if (!entitled) return "locked";
    if (free?.status !== "completed" && !free?.finalFailure) return "not_ready";
  }

  const claim = await claimTier(deps.store, product, { userId, readingId, tier, retry: input.retry });
  if (!claim.claimed) return claim.reason === "not_entitled" ? "locked" : claim.reason;

  return new TierRun({ deps, tier, userId, reading: loaded.reading, plan: loaded.plan, product, claimed: claim.run, startedAt }).execute();
}
