import "server-only";
import type { Persona } from "@/domain/personas";
import type { ExcludedQuestion } from "@/domain/reading/check";
import {
  checkMessengerDraft,
  checkMessengerVoice,
  messengerUnits,
  type MessengerDraftUnit,
  type MessengerFinalUnit,
  type MessengerUnit,
} from "@/domain/reading/two-pass";
import type { ChartView, NarrationPlanV2 } from "@/domain/reading/types";
import { LlmError } from "@/server/llm/client";
import { LLM_SETTINGS } from "@/server/llm/config";
import type { ExampleRecord, ExampleSources } from "@/server/llm/example-block";
import { buildMessengerDraftRequest, buildMessengerVoiceRequest, MessengerDraftUnitParser, type MessengerVoiceOutput } from "@/server/llm/messenger-prompts";
import { closingMessage, focusMessages, openingMessage, sentPartsFrom, topicMessages, type NewMessage } from "@/server/llm/narrate";
import type { UsageMeter } from "@/server/llm/usage";
import { internalReason } from "@/server/log";
import type { MessengerBundle } from "./bundles";
import type { MessengerStore } from "./messenger-store";
import {
  TwoPassRun,
  isNotSent,
  unitOutcome,
  type DraftBatchSpec,
  type ParsedDraft,
  type RequestFields,
  type StepVersions,
  type TwoPassDeps,
  type UnitTier,
  type VoiceCall,
} from "./two-pass";

/**
 * 메신저 상품(묘묘)의 최초 풀이 2-pass 실행기. 실행 순서·재시도·동시 호출·호출 기록은 공통 실행기(TwoPassRun, 무진과 같다)가 맡고,
 * 여기서는 메신저에만 있는 것을 정한다.
 *
 * - 단위: 궁금한 점에 대한 답(질문이 있을 때)과 주제마다 하나 (domain/reading/two-pass.ts의 messengerUnits, 화면 순서).
 *   Pass 1 묶음은 생성 묶음의 draftBatches대로 나눈다 (첫 묶음은 작게 해서 첫 말풍선을 빨리).
 * - 시작 인사는 첫 단위의 Pass 2가, 마무리는 마지막 단위의 Pass 2가 함께 쓴다. 중립 초안에는 인사가 없다.
 * - 화면 순서: Pass 2는 동시에 돌아 끝나는 순서가 뒤섞인다. 검사를 통과한 단위는 먼저 reading_sections에 저장하고,
 *   앞 단위가 모두 보내진 단위부터 reading_messages에 순번을 이어 붙인다. 그래서 순번(메시지 ID)은 재시도·이어 쓰기에서 흔들리지 않고,
 *   초안(Pass 1)은 화면에 나가지 않으며, 이미 보낸 말풍선을 갈아 끼우지 않는다.
 * - 이어 쓰기: 저장된 말풍선으로 보낸 단위를 알아내고, 저장만 되고 아직 안 보낸 최종 단위는 모델 없이 보낸다. 초안만 있는 단위는 Pass 2만,
 *   초안도 없는 단위는 Pass 1부터 한다. 이미 보낸 단위는 다시 만들지 않는다.
 * - 실행 방식은 작업에 고정된 생성 묶음 ID로만 정한다 (캐릭터 이름·말씨로 정하지 않는다). 캐릭터 설정은 묶음이 고정한 버전이다.
 */

export interface MessengerBatch extends DraftBatchSpec {
  readonly unitIds: readonly string[];
}

/** 화면 순서의 단위를 묶음으로 나눈다. 첫 묶음 firstUnits개, 그 뒤 nextUnits개씩. 묶음 ID는 b1, b2, ... (호출 기록의 unit_id). */
export function messengerBatches(units: readonly MessengerUnit[], sizes: MessengerBundle["draftBatches"]): MessengerBatch[] {
  const batches: MessengerBatch[] = [];
  let index = 0;
  while (index < units.length) {
    const size = Math.max(1, batches.length === 0 ? sizes.firstUnits : sizes.nextUnits);
    batches.push({ id: `b${batches.length + 1}`, unitIds: units.slice(index, index + size).map((unit) => unit.unitId) });
    index += size;
  }
  return batches;
}

export type MessengerRunResult =
  /** 모든 단위를 보냈다. closing은 complete_generation이 함께 저장할 마무리 말풍선이다 (seq 포함). */
  | { readonly kind: "completed"; readonly closing: NewMessage & { readonly seq: number } }
  /** 시간 예산이 끝나 남은 일이 있다. 호출한 쪽이 작업을 반납(release_generation)해 다음 요청이 바로 이어 쓴다. */
  | { readonly kind: "release" }
  /** 다른 요청이 이어받았다. 더 저장하지 않는다. */
  | { readonly kind: "lost" }
  | { readonly kind: "failed"; readonly code: string; readonly retryable: boolean };

export interface MessengerRunDeps extends TwoPassDeps {
  readonly store: MessengerStore;
  /** 예시 카탈로그·정책을 찾는 곳 (테스트가 임시 캐릭터의 카탈로그를 넣는다). 없으면 등록된 카탈로그. */
  readonly exampleSources?: ExampleSources;
}

export interface MessengerRunInit {
  readonly deps: MessengerRunDeps;
  readonly bundle: MessengerBundle;
  /** 묶음이 고정한 캐릭터 설정 (bundle.personaId, bundle.personaVersion). */
  readonly persona: Persona;
  readonly plan: NarrationPlanV2;
  readonly excluded: readonly ExcludedQuestion[];
  readonly chart: ChartView;
  readonly readingId: string;
  readonly userId: string;
  readonly productId: string;
  readonly attempt: number;
  readonly modelId: string;
  /** 작업에 고정된 추론 설정 (generation_jobs.reasoning_effort). Pass 1에 쓴다. */
  readonly reasoningEffort: string | null;
  readonly startedAt: number;
  /** 이 생성 시도 전체의 사용량 (질문 정리 포함). 실행기의 호출도 함께 쌓인다. */
  readonly meter?: UsageMeter;
}

export class MessengerRun extends TwoPassRun<MessengerDraftUnit, MessengerFinalUnit, MessengerVoiceOutput, MessengerBatch> {
  protected readonly draftItemsKey = "units";
  private readonly store: MessengerStore;
  private readonly bundle: MessengerBundle;
  private readonly persona: Persona;
  private readonly plan: NarrationPlanV2;
  private readonly excluded: readonly ExcludedQuestion[];
  private readonly chart: ChartView;
  private readonly reasoningEffort: string | null;
  private readonly exampleSources: ExampleSources | undefined;
  private readonly order: readonly MessengerUnit[];
  private readonly indexOf: ReadonlyMap<string, number>;
  private readonly batches: readonly MessengerBatch[];
  private readonly finals = new Map<string, MessengerFinalUnit>();
  private readonly usedNotes: string[] = [];
  private readonly exampleRecords = new Map<string, ExampleRecord>();
  /** 화면에 보낸 단위 수 (앞에서부터). */
  private sentUnits = 0;
  private openingSent = false;
  private nextSeq = 1;
  /** 말풍선 보내기는 한 번에 하나씩 (Pass 2가 동시에 끝나도 순번이 섞이지 않게). */
  private sending: Promise<void> = Promise.resolve();

  constructor(init: MessengerRunInit) {
    super({
      deps: init.deps,
      settings: init.bundle.settings,
      store: init.deps.store,
      readingId: init.readingId,
      userId: init.userId,
      productId: init.productId,
      attempt: init.attempt,
      modelId: init.modelId,
      startedAt: init.startedAt,
      personaId: init.persona.id,
      policyVersion: init.bundle.id,
      meter: init.meter,
    });
    this.store = init.deps.store;
    this.bundle = init.bundle;
    this.persona = init.persona;
    this.plan = init.plan;
    this.excluded = init.excluded;
    this.chart = init.chart;
    this.reasoningEffort = init.reasoningEffort;
    this.exampleSources = init.deps.exampleSources;
    this.order = messengerUnits(init.plan);
    this.indexOf = new Map(this.order.map((unit, index) => [unit.unitId, index] as const));
    this.batches = messengerBatches(this.order, init.bundle.draftBatches);
  }

  /** 이 실행의 사용량·호출 수·검사 문제 수·실제 모델·고른 예시 (생성 기록용). */
  summary() {
    const ids = [...this.exampleRecords.values()].flatMap((record) => record.ids);
    return {
      usage: this.meter.summary(),
      llmCalls: this.meter.calls,
      issueCount: this.issueCount,
      actualModel: this.actualModel,
      examples: { catalogVersion: this.bundle.examples.catalogVersion, policyVersion: this.bundle.examples.policyVersion, ids: [...new Set(ids)] },
    };
  }

  // ─── 공통 실행기(TwoPassRun)가 부르는 자리 ─────────────────────

  /** 메신저 최초 풀이는 구매 권한이 생긴 뒤에만 만든다 (DB 저장 함수가 generation_jobs와 구매 권한을 다시 확인한다). */
  protected tierOf(unitId: string): UnitTier {
    if (!this.indexOf.has(unitId)) throw new LlmError("invalid_output", `계획에 없는 단위입니다: ${unitId.slice(0, 40)}`, 0);
    return "paid";
  }

  protected callTier(): UnitTier {
    return "paid";
  }

  protected missingUnitIssue(unitId: string): string {
    return `${unitId}: 응답에 이 단위가 없습니다.`;
  }

  protected draftReasoningEffort(): string {
    return this.reasoningEffort ?? LLM_SETTINGS.tasks.draft.reasoningEffort;
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

  protected buildDraftRequest(_batch: MessengerBatch, unitIds: readonly string[], previousIssues: readonly string[] | undefined): RequestFields<unknown> {
    return buildMessengerDraftRequest(
      { prompt: this.bundle.draftPrompt, schema: this.bundle.draftSchema },
      { plan: this.plan, units: unitIds.map((id) => this.unitOf(id)), usedNotes: [...this.usedNotes], previousIssues },
    ) as RequestFields<unknown>;
  }

  protected parseDraft(item: unknown): ParsedDraft<MessengerDraftUnit> {
    const parsed = MessengerDraftUnitParser.safeParse(item);
    if (parsed.success) return { ok: true, unitId: parsed.data.unitId, draft: parsed.data };
    const claimed = (item as { unitId?: unknown } | null)?.unitId;
    return { ok: false, unitId: typeof claimed === "string" ? claimed : null };
  }

  protected checkDraft(unitId: string, draft: MessengerDraftUnit): string[] {
    return checkMessengerDraft({ unit: this.unitOf(unitId), draft, plan: this.plan, chart: this.chart, excluded: this.excluded, persona: this.persona });
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

  protected onDraftSaved(_unitId: string, draft: MessengerDraftUnit): void {
    this.usedNotes.push(...draft.notes);
  }

  protected canVoice(unitId: string): boolean {
    return this.indexOf.has(unitId);
  }

  protected buildVoiceRequest(unitId: string, draft: MessengerDraftUnit, previousIssues: readonly string[] | undefined): VoiceCall<MessengerVoiceOutput> {
    const index = this.indexOf.get(unitId)!;
    const built = buildMessengerVoiceRequest(
      { prompt: this.bundle.voicePrompt, schema: this.bundle.voiceSchema },
      {
        plan: this.plan,
        persona: this.persona,
        unit: this.unitOf(unitId),
        unitIndex: index,
        draft,
        earlierUnits: this.order.slice(0, index).flatMap((unit) => {
          const earlier = this.drafts.get(unit.unitId);
          return earlier ? [{ title: this.titleOf(unit), coreAnswer: earlier.coreAnswer }] : [];
        }),
        frame: this.frameOf(unitId),
        previousIssues,
        // 예시는 묶음이 고정한 카탈로그·정책으로 풀이 ID와 단위 순번에서 고른다. 같은 단위의 재시도는 같은 예시다.
        examples: this.bundle.examples,
        exampleSeed: this.readingId,
        label: this.bundle.id,
        exampleSources: this.exampleSources,
      },
    );
    if (built.examples) this.exampleRecords.set(unitId, built.examples);
    return { request: built.request, examples: built.examples };
  }

  protected finalOf(unitId: string, output: MessengerVoiceOutput): MessengerFinalUnit {
    return { unitId, opening: output.opening, bubbles: output.bubbles, closing: output.closing };
  }

  protected checkVoice(unitId: string, content: MessengerFinalUnit, draft: MessengerDraftUnit): string[] {
    // 같은 문장 반복은 이미 저장한 다른 단위의 문장과 비교한다.
    const remembered = [...this.finals.values()]
      .filter((final) => final.unitId !== unitId)
      .flatMap((final) => [final.opening, final.closing, ...final.bubbles.map((bubble) => bubble.text)])
      .filter((text) => text.trim());
    return checkMessengerVoice({
      unit: this.unitOf(unitId),
      final: content,
      draft,
      plan: this.plan,
      chart: this.chart,
      excluded: this.excluded,
      persona: this.persona,
      remembered,
      frame: this.frameOf(unitId),
    });
  }

  protected finalMeta(input: { readonly examples: ExampleRecord | null; readonly actualModel: string | null; readonly durationMs: number; readonly previousIssues: readonly string[] }) {
    return {
      bundle: this.bundle.id,
      voicePrompt: this.bundle.voicePrompt,
      voiceSchema: this.bundle.voiceSchema,
      personaId: this.persona.id,
      personaVersion: this.persona.version,
      modelId: this.modelId,
      actualModel: input.actualModel,
      durationMs: input.durationMs,
      issues: input.previousIssues,
      // 지시에 넣은 문답 예시의 카탈로그·정책·안내 버전과 ID. 예시 문장은 넣지 않는다.
      examples: input.examples,
    };
  }

  protected async afterFinal(unitId: string, content: MessengerFinalUnit): Promise<void> {
    this.finals.set(unitId, content);
    await this.sendReady();
  }

  // ─── 메신저 실행 ─────────────────────

  private unitOf(unitId: string): MessengerUnit {
    const index = this.indexOf.get(unitId);
    if (index === undefined) throw new LlmError("invalid_output", `계획에 없는 단위입니다: ${unitId.slice(0, 40)}`, 0);
    return this.order[index]!;
  }

  private titleOf(unit: MessengerUnit): string {
    return unit.kind === "focus" ? this.plan.focusSection.title : (this.plan.topics.find((topic) => topic.topicId === unit.unitId)?.title ?? unit.unitId);
  }

  private frameOf(unitId: string) {
    const index = this.indexOf.get(unitId)!;
    return { opening: index === 0, closing: index === this.order.length - 1 };
  }

  /** 앞 단위가 모두 보내진 최종 단위부터 순서대로 말풍선을 보낸다. 한 번에 하나씩 돈다. 점유를 잃으면 멈춘다. */
  private sendReady(): Promise<void> {
    const run = async () => {
      while (this.sentUnits < this.order.length && !this.lost) {
        const unit = this.order[this.sentUnits]!;
        const final = this.finals.get(unit.unitId);
        if (!final) return;
        const messages: NewMessage[] = [
          ...(this.sentUnits === 0 && !this.openingSent ? [openingMessage(final.opening)] : []),
          ...(unit.kind === "focus" ? focusMessages(final.bubbles, unit.unitId) : topicMessages({ topicId: unit.unitId, bubbles: [...final.bubbles] })),
        ];
        const numbered = messages.map((message, index) => ({ ...message, seq: this.nextSeq + index }));
        const sent = await this.store.appendMessages({ readingId: this.readingId, userId: this.userId, attempt: this.attempt, messages: numbered });
        if (!sent) {
          this.lost = true;
          return;
        }
        this.nextSeq += numbered.length;
        this.openingSent = true;
        this.sentUnits += 1;
      }
    };
    // 앞선 보내기가 실패했어도 다음 보내기는 시도한다 (실패는 그 보내기를 기다린 쪽이 받는다).
    this.sending = this.sending.catch(() => undefined).then(run);
    return this.sending;
  }

  /** 저장된 단위·최종 단위·보낸 말풍선을 읽어 이어 쓸 자리를 정한다. 저장만 되고 아직 안 보낸 최종 단위는 모델 없이 보낸다. */
  private async prepare(): Promise<void> {
    const [units, finals, messages] = await Promise.all([this.store.loadUnits(this.readingId), this.store.loadFinals(this.readingId), this.store.loadMessages(this.readingId)]);
    for (const unit of units) {
      if (!this.indexOf.has(unit.unitId)) continue;
      this.units.set(unit.unitId, unit);
      if (unit.draft) this.drafts.set(unit.unitId, unit.draft);
    }
    for (const final of finals) if (this.indexOf.has(final.unitId)) this.finals.set(final.unitId, final.content);
    // 앞 묶음의 요약을 화면 순서대로 넘긴다 (다음 묶음이 같은 장면·조언을 되풀이하지 않게).
    for (const unit of this.order) this.usedNotes.push(...(this.drafts.get(unit.unitId)?.notes ?? []));

    const sent = sentPartsFrom(messages, this.plan.focusSection.id);
    this.openingSent = sent.opening !== null;
    this.nextSeq = messages.reduce((max, message) => Math.max(max, message.seq), 0) + 1;
    const sentTopics = new Set(sent.topics.map((topic) => topic.topicId));
    while (this.sentUnits < this.order.length) {
      const unit = this.order[this.sentUnits]!;
      const done = unit.kind === "focus" ? sent.focus.length > 0 : sentTopics.has(unit.unitId);
      if (!done) break;
      this.sentUnits += 1;
    }
    await this.sendReady();
  }

  async execute(): Promise<MessengerRunResult> {
    try {
      await this.prepare();
      this.resumeVoice(this.order.map((unit) => unit.unitId));
      await this.runDraftBatches(this.batches, (batch) => batch.unitIds);
      await this.queue.drain();
      await this.sending.catch(() => undefined);
      await this.recorder.flush();
      if (this.failure) return this.failedFrom(this.failure);
      return await this.finish();
    } catch (error) {
      if (isNotSent(error)) {
        this.markNotSent();
        await this.queue.drain();
        await this.recorder.flush();
        return this.failure ? this.failedFrom(this.failure) : await this.finish();
      }
      this.halted = true;
      await this.queue.drain();
      await this.recorder.flush();
      return this.failedFrom(error);
    }
  }

  private async finish(): Promise<MessengerRunResult> {
    if (this.lost) return { kind: "lost" };
    const units = new Map((await this.store.loadUnits(this.readingId)).map((unit) => [unit.unitId, unit] as const));
    const outcome = unitOutcome(
      this.order.map((unit) => units.get(unit.unitId)),
      this.outOfTime,
      this.settings,
    );
    if (outcome.kind === "done") {
      await this.sendReady();
      if (this.lost) return { kind: "lost" };
      const last = this.finals.get(this.order[this.order.length - 1]!.unitId);
      if (this.sentUnits < this.order.length || !last) return { kind: "failed", code: "units_stalled", retryable: true };
      return { kind: "completed", closing: { ...closingMessage(last.closing), seq: this.nextSeq } };
    }
    if (outcome.kind === "release") return { kind: "release" };
    if (outcome.kind === "failed") return { kind: "failed", code: "units_failed", retryable: outcome.retryable };
    // 시간이 남았는데 쓰지 못한 단위가 있다 (예상하지 못한 상태). 같은 요청을 끝없이 되풀이하지 않게 실패로 알린다.
    return { kind: "failed", code: "units_stalled", retryable: true };
  }

  private failedFrom(error: unknown): MessengerRunResult {
    if (this.lost) return { kind: "lost" };
    if (error instanceof LlmError) return { kind: "failed", code: error.code, retryable: !error.isConfigurationError };
    console.error("[generation] two-pass unexpected", { readingId: this.readingId, reason: internalReason(error) });
    return { kind: "failed", code: "internal", retryable: true };
  }
}
