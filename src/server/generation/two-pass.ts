import "server-only";
import type { z } from "zod";
import { issueSummary } from "@/domain/reading/check";
import { createCallRecorder, type LlmCallRecorder, type LlmCallRow, type LlmCallStep } from "@/server/llm/call-log";
import { LlmError, callStructured, callStructuredStream, type StructuredResult } from "@/server/llm/client";
import { LLM_SETTINGS } from "@/server/llm/config";
import type { ExampleRecord } from "@/server/llm/example-block";
import { completedArrayItems } from "@/server/llm/stream-parts";
import { UsageMeter } from "@/server/llm/usage";

/**
 * 2-pass 생성의 공통 실행기. 무진 족자(src/server/scroll/runner.ts)와 묘묘 메신저(src/server/generation/messenger-run.ts)가 함께 쓴다.
 * 상품마다 다른 것(무엇이 한 단위인지, 요청을 어떻게 만드는지, 무엇을 검사하는지, 최종문을 어디에 보여 주는지)은 하위 클래스가 정하고,
 * 실행 순서·동시 호출·재시도·시간 예산·저장 확인·호출 기록은 여기 한곳에 둔다.
 *
 * - Pass 1(중립 초안)은 묶음마다 스트림으로 받고, 단위 원소가 닫힐 때마다 검사해 저장한 뒤 Pass 2 대기열에 넣는다.
 *   스트림 수신 루프는 짧은 초안 저장만 기다리고 Pass 2를 기다리지 않는다 (프로세스 전역 동시 호출 제한과의 교착 방지).
 * - Pass 2(캐릭터 문장)는 단위마다 한 번 부르고, 검사에 걸리면 문제만 알려 정해진 횟수까지 다시 요청한다.
 *   Pass 2만 실패하면 저장된 초안으로 그 단계만 다시 한다 (Pass 1 호출 없음).
 * - 검사에 걸린 단위만 다시 요청한다. 단위마다 시도 수 상한을 넘으면 그 단위만 실패로 남는다. 저장된 단위는 다시 만들지 않는다.
 * - 저장 함수가 false를 돌려주면 다른 요청이 이어받은 것이다. 이 실행은 더 저장하지 않는다 (늦은 응답이 새 상태를 덮지 않음).
 * - 모든 LLM 호출은 guardStart를 켠다: 동시 호출 자리를 기다린 뒤 남은 시간이 그 호출의 제한 시간보다 짧으면 보내지 않고
 *   deadline_reached로 끝난다 (호출 기록 없음). 이때는 단위 실패로 세지 않고 새 호출을 멈춘 뒤 반납(partial)한다.
 * - 모든 LLM 호출은 llm_calls에 태그(단계, 무료·유료, 단위·묶음 ID, 시도 번호, 캐릭터, 생성 묶음, 버전)와 함께 남는다.
 */

export type UnitTier = "free" | "paid";
export type UnitStatus = "pending" | "drafted" | "done" | "failed";

/** reading_units 한 행 (서버 전용). draft는 Pass 1 초안이며 브라우저로 보내지 않는다. */
export interface UnitRecord<D = unknown> {
  readonly unitId: string;
  readonly tier: UnitTier;
  readonly status: UnitStatus;
  readonly draft: D | null;
  readonly draftAttempts: number;
  readonly voiceAttempts: number;
  readonly errorStage: "draft" | "voice" | null;
  readonly errorCode: string | null;
  readonly errorRetryable: boolean | null;
  readonly updatedAt: string | null;
}

/** 단위 저장의 공통 인자. tier는 상품 정의가 정한 값이어야 한다 (DB는 서버가 보낸 tier를 믿는다). */
export interface UnitWrite {
  readonly readingId: string;
  readonly tier: UnitTier;
  /** 지금 점유한 실행의 시도 번호 (claim 결과의 attempts). */
  readonly attempt: number;
  readonly unitId: string;
}

export interface UnitFailure {
  readonly saved: boolean;
  readonly draftAttempts: number;
  readonly voiceAttempts: number;
}

/** 단위 저장소 (save_unit_draft, save_unit_final, fail_unit, record_llm_call). 실행기는 이 모양만 안다. */
export interface UnitStore<D, F> {
  /** false면 이 실행이 점유를 잃었다(다른 요청이 이어받음). 더 저장하지 않는다. */
  saveDraft(unit: UnitWrite & { readonly draft: D; readonly meta: Record<string, unknown> }): Promise<boolean>;
  saveFinal(unit: UnitWrite & { readonly content: F; readonly meta: Record<string, unknown> }): Promise<boolean>;
  failUnit(unit: UnitWrite & { readonly stage: "draft" | "voice"; readonly code: string; readonly retryable: boolean }): Promise<UnitFailure>;
  /** 호출 단위 기록 한 줄 (record_llm_call). 실패하면 던지고, 기록기(createCallRecorder)가 실패 수만 센다. */
  writeCall(row: LlmCallRow): Promise<void>;
}

/** 2-pass 실행 설정. 무진은 SCROLL_SETTINGS, 묘묘는 생성 묶음의 settings가 넘긴다. */
export interface TwoPassSettings {
  /** 요청 하나에서 쓸 시간. 이 시간을 넘길 호출은 시작하지 않는다. */
  readonly budgetMs: number;
  /** 요청 하나에서 함께 부르는 Pass 2 호출 수. 프로세스 전역 동시 호출 제한(4)보다 작게 둔다. */
  readonly voiceConcurrency: number;
  /** 단위 하나의 Pass 1 시도 총수 상한 (reading_units.draft_attempts). */
  readonly draftAttemptsPerUnit: number;
  /** 단위 하나의 Pass 2 시도 총수 상한 (reading_units.voice_attempts). */
  readonly voiceAttemptsPerUnit: number;
  /** 한 요청 안에서 검사에 걸린 단위만 다시 요청하는 횟수. */
  readonly retriesPerRun: number;
  /** Pass 2를 시작할 때 호출 제한 시간 외에 남겨 둘 여유 (대기열 정리, 저장, 반납). */
  readonly voiceStartMarginMs: number;
}

export const blankUnit = <D>(unitId: string, tier: UnitTier): UnitRecord<D> => ({
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

/** Pass 1 초안이 필요한 단위: 아직 초안이 없거나, Pass 1에서 실패했고 시도 수가 남았다. */
export function needsDraft(unit: UnitRecord | undefined, settings: Pick<TwoPassSettings, "draftAttemptsPerUnit">): boolean {
  if (!unit || unit.status === "pending") return true;
  return unit.status === "failed" && unit.errorStage === "draft" && unit.draftAttempts < settings.draftAttemptsPerUnit;
}

/** 저장된 초안으로 Pass 2를 할 단위: 초안까지 저장했거나, Pass 2에서 실패했고 시도 수가 남았다. */
export function needsVoice(unit: UnitRecord | undefined, settings: Pick<TwoPassSettings, "voiceAttemptsPerUnit">): boolean {
  if (!unit) return false;
  if (unit.status === "drafted") return true;
  return unit.status === "failed" && unit.errorStage === "voice" && unit.voiceAttempts < settings.voiceAttemptsPerUnit;
}

/** 실패한 단위를 다시 시도할 수 있는가 (재시도 불가로 기록되지 않았고 그 단계의 시도 수가 남았다). */
export function retryableUnit(unit: UnitRecord, settings: Pick<TwoPassSettings, "draftAttemptsPerUnit" | "voiceAttemptsPerUnit">): boolean {
  if (unit.errorRetryable === false) return false;
  return unit.errorStage === "voice" ? unit.voiceAttempts < settings.voiceAttemptsPerUnit : unit.draftAttempts < settings.draftAttemptsPerUnit;
}

/**
 * 단위들의 저장 상태로 이번 실행을 어떻게 끝낼지 정한다.
 * done: 모두 끝남 · release: 시간이 다 되어 남은 일이 있음(반납하면 다음 요청이 바로 이어받는다) · failed: 실패한 단위가 있음 ·
 * stalled: 시간이 남았는데 쓰지 못한 단위가 있음 (같은 요청을 끝없이 되풀이하지 않게 실패로 알린다).
 */
export function unitOutcome(
  states: readonly (UnitRecord | undefined)[],
  outOfTime: boolean,
  settings: Pick<TwoPassSettings, "draftAttemptsPerUnit" | "voiceAttemptsPerUnit">,
): { readonly kind: "done" } | { readonly kind: "release" } | { readonly kind: "failed"; readonly retryable: boolean } | { readonly kind: "stalled" } {
  if (states.every((unit) => unit?.status === "done")) return { kind: "done" };
  const failed = states.filter((unit): unit is UnitRecord => unit?.status === "failed");
  const retryable = failed.filter((unit) => retryableUnit(unit, settings));
  const unfinished = states.filter((unit) => !unit || unit.status === "pending" || unit.status === "drafted");
  if (outOfTime && (unfinished.length > 0 || retryable.length > 0)) return { kind: "release" };
  if (failed.length > 0) return { kind: "failed", retryable: retryable.length > 0 };
  return { kind: "stalled" };
}

/**
 * Pass 2 대기열. push는 기다리지 않고 곧바로 돌아오며, 동시에 limit개까지 실행한다. drain은 남은 작업을 모두 기다린다.
 * 작업이 던진 오류는 onError로 넘기고 대기열은 멈추지 않는다 (실행기가 멈출지 정한다).
 */
export class VoiceQueue {
  private readonly waiting: string[] = [];
  private readonly seen = new Set<string>();
  private readonly running = new Set<Promise<void>>();

  constructor(
    private readonly limit: number,
    private readonly work: (id: string) => Promise<void>,
    private readonly onError: (error: unknown) => void,
  ) {}

  /** 같은 단위는 한 요청에서 한 번만 넣는다. */
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

/** 동시 호출 자리를 기다린 뒤 남은 시간이 모자라 보내지 않은 호출 (callStructured의 guardStart). */
export const isNotSent = (error: unknown): boolean => error instanceof LlmError && error.code === "deadline_reached";

const unique = <T>(values: readonly T[]): T[] => [...new Set(values)];

/** 모델 요청에 넘길 칸 (지시, 입력, 출력 형식). */
export interface RequestFields<T> {
  readonly instructions: string;
  readonly input: string;
  readonly schemaName: string;
  readonly jsonSchema: Record<string, unknown>;
  readonly parser: z.ZodType<T>;
}

/** 호출 기록에 남기는 버전. */
export interface StepVersions {
  readonly promptVersion: string;
  readonly schemaVersion: string | null;
  readonly personaVersion: string | null;
  readonly reasoningEffort: string;
}

/** 실행기가 쓰는 의존성. 테스트는 가짜 모델 호출과 시계를 넣는다. */
export interface TwoPassDeps {
  readonly callStructured: typeof callStructured;
  readonly callStructuredStream: typeof callStructuredStream;
  /** 현재 시각 (epoch ms). 시간 예산을 정한다. */
  readonly now: () => number;
}

export interface TwoPassInit<D, F> {
  readonly deps: TwoPassDeps;
  readonly settings: TwoPassSettings;
  readonly store: UnitStore<D, F>;
  readonly readingId: string;
  readonly userId: string;
  readonly productId: string;
  /** 지금 점유한 실행의 시도 번호. */
  readonly attempt: number;
  readonly modelId: string;
  readonly startedAt: number;
  /** 호출 기록에 함께 남기는 풀이의 캐릭터 ID와 생성 묶음 ID (llm_calls.persona_id, policy_version). */
  readonly personaId: string | null;
  readonly policyVersion: string | null;
  /** 생성 시도 전체의 사용량 (호출한 쪽이 질문 정리 등과 함께 집계할 때). 실행기의 호출도 함께 쌓인다. */
  readonly meter?: UsageMeter;
}

/** Pass 1 묶음 하나 (단위 ID 순서대로 쓴다). */
export interface DraftBatchSpec {
  readonly id: string;
}

interface DraftRound {
  readonly batchId: string;
  readonly round: number;
  readonly pending: Set<string>;
  /** 이번 요청에서 원소를 받은 단위 (같은 단위의 두 번째 원소는 쓰지 않는다). */
  readonly handled: Set<string>;
  readonly problems: Map<string, { readonly code: string; readonly issues: readonly string[] }>;
  readonly previousIssues: readonly string[] | undefined;
}

/** Pass 1 원소 하나를 읽은 결과. 형식이 맞지 않으면 draft가 null이고, 원소가 밝힌 단위 ID가 있으면 unitId에 둔다. */
export type ParsedDraft<D> = { readonly ok: true; readonly unitId: string; readonly draft: D } | { readonly ok: false; readonly unitId: string | null };

/** Pass 2 요청 하나 (예시 기록은 모델 요청에 섞지 않고 저장 기록에만 남긴다). */
export interface VoiceCall<V> {
  readonly request: RequestFields<V>;
  readonly examples: ExampleRecord | null;
}

/**
 * 점유한 한 실행 (요청 하나가 끝나면 버린다). D: Pass 1 초안 한 단위, F: 저장하는 최종 단위, V: Pass 2 모델 출력.
 * 하위 클래스는 아래 abstract 자리만 채운다. 실행 순서(준비 → 저장된 초안의 Pass 2 → Pass 1 묶음 → 대기열 비우기 → 마무리)는 하위 클래스의 execute가 정한다.
 */
export abstract class TwoPassRun<D, F, V, B extends DraftBatchSpec = DraftBatchSpec> {
  protected readonly deps: TwoPassDeps;
  protected readonly settings: TwoPassSettings;
  protected readonly unitStore: UnitStore<D, F>;
  protected readonly readingId: string;
  protected readonly userId: string;
  protected readonly productId: string;
  protected readonly attempt: number;
  protected readonly modelId: string;
  protected readonly startedAt: number;
  protected readonly deadlineAt: number;
  protected readonly meter: UsageMeter;
  protected readonly recorder: LlmCallRecorder;
  protected readonly queue: VoiceQueue;
  private readonly personaId: string | null;
  private readonly policyVersion: string | null;

  protected readonly units = new Map<string, UnitRecord<D>>();
  protected readonly drafts = new Map<string, D>();

  /** 저장 함수가 false를 돌려줬다 (다른 요청이 이어받음). 더 저장하지 않는다. */
  protected lost = false;
  /** 설정 오류나 저장소 오류로 새 호출을 시작하지 않는다. */
  protected halted = false;
  /** 시간 예산이 모자라 시작하지 않은 일이 있다. */
  protected outOfTime = false;
  /** 동시 호출 자리를 기다리다 남은 시간이 모자라 보내지 못한 호출이 있다 (deadline_reached). 새 호출을 시작하지 않는다. */
  protected notSent = false;
  /** Pass 2 작업이 던진 오류 (처음 것만). */
  protected failure: unknown = null;
  protected issueCount = 0;
  protected actualModel: string | null = null;

  constructor(init: TwoPassInit<D, F>) {
    this.deps = init.deps;
    this.settings = init.settings;
    this.unitStore = init.store;
    this.readingId = init.readingId;
    this.userId = init.userId;
    this.productId = init.productId;
    this.attempt = init.attempt;
    this.modelId = init.modelId;
    this.startedAt = init.startedAt;
    this.deadlineAt = init.startedAt + init.settings.budgetMs;
    this.personaId = init.personaId;
    this.policyVersion = init.policyVersion;
    this.meter = new UsageMeter(init.meter);
    this.recorder = createCallRecorder((row) => this.unitStore.writeCall(row));
    this.queue = new VoiceQueue(
      init.settings.voiceConcurrency,
      (id) => this.voice(id),
      (error) => {
        this.failure ??= error;
        this.halted = true;
      },
    );
  }

  // ─── 하위 클래스가 채우는 자리 ─────────────────────

  /** 단위의 tier (상품 정의에서만 정한다). 모르는 단위면 던진다. */
  protected abstract tierOf(unitId: string): UnitTier;
  /** 호출 기록(llm_calls.tier)에 남기는 이번 실행의 단계. */
  protected abstract callTier(): UnitTier | null;
  /** Pass 1 응답에 요청한 단위가 없을 때 남기는 문제 (다시 요청할 때 모델에 알려 준다). */
  protected missingUnitIssue(unitId: string): string {
    return `${unitId}: 응답에 이 장이 없습니다.`;
  }
  /** Pass 1 출력에서 단위 원소가 들어 있는 최상위 배열 이름 (예: sections, units). */
  protected abstract readonly draftItemsKey: string;
  protected abstract draftReasoningEffort(): string;
  protected abstract voiceReasoningEffort(): string;
  protected abstract draftVersions(): StepVersions;
  protected abstract voiceVersions(): StepVersions;
  /** Pass 1 묶음 요청. unitIds는 이번에 쓸 단위 (순서대로). */
  protected abstract buildDraftRequest(batch: B, unitIds: readonly string[], previousIssues: readonly string[] | undefined): RequestFields<unknown>;
  protected abstract parseDraft(item: unknown): ParsedDraft<D>;
  protected abstract checkDraft(unitId: string, draft: D): string[];
  /** reading_units.draft_meta (생성 문장 없이 버전·묶음·앞선 문제 종류만). */
  protected abstract draftMeta(batchId: string, round: number, previousIssues: readonly string[] | undefined): Record<string, unknown>;
  /** 초안을 저장한 뒤 (예: 다음 묶음에 넘길 장면 요약을 모은다). */
  protected onDraftSaved(unitId: string, draft: D): void {
    void unitId;
    void draft;
  }
  /** Pass 2를 할 수 있는 단위인가 (계획에 있는 단위). */
  protected abstract canVoice(unitId: string): boolean;
  protected abstract buildVoiceRequest(unitId: string, draft: D, previousIssues: readonly string[] | undefined): VoiceCall<V>;
  /** Pass 2 출력에서 저장할 최종 단위를 꺼낸다. */
  protected abstract finalOf(unitId: string, output: V): F;
  protected abstract checkVoice(unitId: string, content: F, draft: D): string[];
  /** reading_sections.meta (소유자가 읽을 수 있으므로 버전·예시 ID·시간·문제 종류만). */
  protected abstract finalMeta(input: {
    readonly examples: ExampleRecord | null;
    readonly actualModel: string | null;
    readonly durationMs: number;
    readonly previousIssues: readonly string[];
  }): Record<string, unknown>;
  /** 최종 단위를 저장한 뒤 (예: 메신저는 순서가 된 단위부터 말풍선으로 보낸다). 던지면 실행을 멈춘다. */
  protected async afterFinal(unitId: string, content: F): Promise<void> {
    void unitId;
    void content;
  }

  // ─── 공통 실행 ─────────────────────

  protected get stopped(): boolean {
    return this.lost || this.halted;
  }

  protected hasTime(ms: number): boolean {
    return this.deps.now() + ms <= this.deadlineAt;
  }

  /** 보내지 못한 호출(deadline_reached)이 있었다. 단위 실패로 세지 않고 새 호출을 멈추며, 끝에서 반납(partial)한다. */
  protected markNotSent(): void {
    this.notSent = true;
    this.outOfTime = true;
  }

  protected noteModel(model: string | null): void {
    if (model) this.actualModel = model;
  }

  /** 호출 하나의 기록 태그. 질문 정리처럼 다른 모듈이 보내는 호출도 이 함수로 같은 태그를 붙인다. */
  protected tags(step: LlmCallStep, unitId: string | null, tier: UnitTier | null, versions: StepVersions) {
    return this.recorder.forCall({
      readingId: this.readingId,
      userId: this.userId,
      productId: this.productId,
      tier,
      step,
      unitId,
      attempt: this.attempt,
      personaId: this.personaId,
      policyVersion: this.policyVersion,
      ...versions,
    });
  }

  /** 이전 요청에서 초안까지 저장한 단위는 저장된 초안으로 Pass 2만 다시 한다 (Pass 1 호출 없음). */
  protected resumeVoice(unitIds: readonly string[]): void {
    for (const id of unitIds) {
      if (needsVoice(this.units.get(id), this.settings) && this.drafts.has(id) && this.canVoice(id)) this.queue.push(id);
    }
  }

  /**
   * Pass 1 묶음을 순서대로 하나씩 쓴다. unitIdsOf는 묶음에서 이번에 쓸 단위 (초안이 필요한 단위)를 돌려준다.
   * 멈췄거나 보내지 못한 호출이 있었거나 시간이 모자라면 새 묶음을 시작하지 않는다.
   */
  protected async runDraftBatches(batches: readonly B[], unitIdsOf: (batch: B) => readonly string[]): Promise<void> {
    for (const batch of batches) {
      if (this.stopped || this.notSent) return;
      const ids = unitIdsOf(batch).filter((id) => needsDraft(this.units.get(id), this.settings));
      if (!ids.length) continue;
      if (!this.hasTime(LLM_SETTINGS.tasks.draft.timeoutMs)) {
        this.outOfTime = true;
        return;
      }
      await this.draftBatch(batch, ids);
    }
  }

  /**
   * Pass 1 묶음 하나. 스트림에서 단위 원소가 닫힐 때마다 검사·저장하고 Pass 2 대기열에 넣는다.
   * 스트림이 끝나면 받지 못했거나 검사에 걸린 단위만 모아, 시간과 retriesPerRun이 허락하면 그 단위만 다시 요청한다.
   * 그래도 남은 단위는 단위마다 실패로 기록한다 (시도 수가 남았으면 다시 시도할 수 있게).
   */
  protected async draftBatch(batch: B, ids: readonly string[]): Promise<void> {
    const task = LLM_SETTINGS.tasks.draft;
    const pending = new Set(ids);
    const problems = new Map<string, { readonly code: string; readonly issues: readonly string[] }>();
    let lastError: LlmError | null = null;

    for (let round = 0; round <= this.settings.retriesPerRun && pending.size > 0; round += 1) {
      if (this.stopped) return;
      if (round > 0 && (this.notSent || !this.hasTime(task.timeoutMs))) {
        this.outOfTime = true;
        break;
      }
      const requested = ids.filter((id) => pending.has(id));
      const previousIssues = round > 0 ? unique(requested.flatMap((id) => (problems.get(id)?.issues ?? []).map(issueSummary))).slice(0, 15) : undefined;
      // 다시 요청을 보내지 못하면 앞 시도의 문제를 그대로 기록한다.
      const previousProblems = new Map(problems);
      const previousError = lastError;
      problems.clear();
      lastError = null;
      const state: DraftRound = { batchId: batch.id, round, pending, handled: new Set(), problems, previousIssues };
      // Pass 1은 캐릭터 없는 중립 초안이라 문답 예시가 없다.
      const request = this.buildDraftRequest(batch, requested, previousIssues);

      let consumed = 0;
      const consume = async (text: string) => {
        const items = completedArrayItems(text, this.draftItemsKey);
        // 이미 받은 원소는 점유를 잃지 않았으면 검사해 저장한다. 다른 작업 오류로 멈춘 실행도 저장한다 (저장 함수가 점유를 다시 확인한다).
        // 더 받지는 않는다 (onDelta가 stop을 돌려준다).
        while (consumed < items.length && !this.lost) {
          const item = items[consumed];
          consumed += 1;
          await this.acceptDraft(item, state);
        }
      };
      try {
        const result = await this.deps.callStructuredStream({
          ...request,
          model: this.modelId,
          reasoningEffort: this.draftReasoningEffort(),
          maxOutputTokens: task.maxOutputTokens,
          timeoutMs: task.timeoutMs,
          deadlineAt: this.deadlineAt,
          // 동시 호출 자리를 기다린 뒤 남은 시간이 모자라면 보내지 않는다 (deadline_reached). 스트림 타이머도 자리를 얻은 뒤 시작한다.
          guardStart: true,
          meter: this.meter,
          onCall: this.tags("pass1", batch.id, this.callTier(), this.draftVersions()),
          // 짧은 초안 저장만 기다린다. Pass 2는 대기열에 넣기만 한다.
          onDelta: async (text) => {
            await consume(text);
            return this.stopped ? "stop" : "continue";
          },
        });
        if (!result.stopped) await consume(result.text);
        this.noteModel(result.meta.actualModel);
      } catch (error) {
        // 받기 시작한 뒤 끊긴 스트림도 이미 저장한 단위는 그대로 둔다. 설정 오류와 저장소 오류는 단계 실패로 올린다.
        if (!(error instanceof LlmError) || error.isConfigurationError) throw error;
        if (isNotSent(error)) {
          // 보내지 않은 호출이다. 이 묶음의 단위를 실패로 세지 않고 새 호출을 멈춘다 (반납 뒤 다음 요청이 이어 쓴다).
          // 다시 요청하는 차례였으면 앞 시도에서 걸린 문제만 그 단위의 실패로 남긴다.
          this.markNotSent();
          if (round === 0) return;
          for (const [id, problem] of previousProblems) problems.set(id, problem);
          lastError = previousError;
          break;
        }
        lastError = error;
      }
      if (this.stopped) return;
      for (const id of requested) {
        if (pending.has(id) && !problems.has(id)) problems.set(id, { code: lastError?.code ?? "missing_section", issues: [this.missingUnitIssue(id)] });
      }
    }
    if (this.stopped) return;
    for (const id of ids) {
      if (!pending.has(id)) continue;
      await this.failUnit(id, "draft", problems.get(id)?.code ?? lastError?.code ?? "missing_section");
      if (this.stopped) return;
    }
  }

  /** 스트림에서 닫힌 단위 원소 하나. 형식·소속·검사를 확인하고, 통과하면 초안을 저장해 Pass 2 대기열에 넣는다. */
  private async acceptDraft(item: unknown, round: DraftRound): Promise<void> {
    const parsed = this.parseDraft(item);
    if (!parsed.ok) {
      const claimed = parsed.unitId;
      if (claimed !== null && round.pending.has(claimed) && !round.handled.has(claimed)) {
        round.handled.add(claimed);
        round.problems.set(claimed, { code: "invalid_output", issues: [`${claimed}: 출력 형식이 맞지 않습니다.`] });
      }
      this.issueCount += 1;
      return;
    }
    const { unitId: id, draft } = parsed;
    // 이 묶음에서 요청하지 않은 단위나 같은 단위의 두 번째 원소는 쓰지 않는다.
    if (!round.pending.has(id) || round.handled.has(id)) {
      this.issueCount += 1;
      return;
    }
    round.handled.add(id);
    const issues = this.checkDraft(id, draft);
    if (issues.length) {
      // 그 단위의 문제로만 기록하고 스트림은 계속 받는다 (단위 초안은 서로 독립이다).
      this.issueCount += issues.length;
      round.problems.set(id, { code: "validation_failed", issues });
      return;
    }
    const tier = this.tierOf(id);
    const saved = await this.unitStore.saveDraft({
      readingId: this.readingId,
      tier,
      attempt: this.attempt,
      unitId: id,
      draft,
      meta: this.draftMeta(round.batchId, round.round, round.previousIssues),
    });
    if (!saved) {
      this.lost = true;
      return;
    }
    round.pending.delete(id);
    const unit = this.units.get(id) ?? blankUnit<D>(id, tier);
    this.units.set(id, { ...unit, status: "drafted", draft, draftAttempts: unit.draftAttempts + 1, errorStage: null, errorCode: null, errorRetryable: null });
    this.drafts.set(id, draft);
    this.onDraftSaved(id, draft);
    this.queue.push(id);
  }

  /** Pass 2 작업 하나 (단위 하나). 검사에 걸리면 retriesPerRun번까지 문제만 알려 다시 요청한다. */
  private async voice(id: string): Promise<void> {
    if (this.stopped) return;
    const draft = this.drafts.get(id);
    if (!draft || !this.canVoice(id)) return;
    const task = LLM_SETTINGS.tasks.voice;
    let previousIssues: string[] | undefined;
    let code = "validation_failed";
    /** 실제로 보낸 Pass 2가 있었는가 (보내지 못한 호출은 세지 않는다). */
    let attempted = false;

    for (let round = 0; round <= this.settings.retriesPerRun; round += 1) {
      // 새 호출을 시작하기 전에는 멈춤(점유 잃음·다른 작업 오류)을 본다. 앞 시도가 있었으면 그 실패는 아래에서 기록한다.
      if (this.stopped) break;
      // 시간이 모자라거나 보내지 못한 호출이 있었으면 시작하지 않는다. 저장된 초안으로 다음 요청이 이어 한다.
      if (this.notSent || !this.hasTime(task.timeoutMs + this.settings.voiceStartMarginMs)) {
        this.outOfTime = true;
        break;
      }
      // 같은 단위의 재시도는 같은 조건으로 같은 예시를 고른다.
      const built = this.buildVoiceRequest(id, draft, previousIssues);
      let result: StructuredResult<V>;
      try {
        result = await this.deps.callStructured({
          ...built.request,
          model: this.modelId,
          reasoningEffort: this.voiceReasoningEffort(),
          maxOutputTokens: task.maxOutputTokens,
          timeoutMs: task.timeoutMs,
          deadlineAt: this.deadlineAt,
          // 동시 호출 자리를 기다린 뒤 남은 시간이 모자라면 보내지 않는다 (deadline_reached).
          guardStart: true,
          meter: this.meter,
          onCall: this.tags("pass2", id, this.callTier(), this.voiceVersions()),
        });
      } catch (error) {
        if (!(error instanceof LlmError) || error.isConfigurationError) throw error;
        if (isNotSent(error)) {
          // 보내지 않은 호출이다. 단위 실패로 세지 않고 새 호출을 멈춘다. 앞 시도가 있었으면 그 실패만 아래에서 기록한다.
          this.markNotSent();
          break;
        }
        attempted = true;
        code = error.code;
        break;
      }
      attempted = true;
      this.noteModel(result.meta.actualModel);
      // 응답을 받은 뒤에는 점유를 잃었을 때만 버린다 (늦은 응답이 새 상태를 덮지 않게). 다른 작업 오류로 멈춘 실행도
      // 검사를 통과한 결과는 저장한다. 저장 함수가 점유를 다시 확인한다.
      if (this.lost) return;
      const content = this.finalOf(id, result.parsed);
      const issues = this.checkVoice(id, content, draft);
      if (!issues.length) {
        const saved = await this.unitStore.saveFinal({
          readingId: this.readingId,
          tier: this.tierOf(id),
          attempt: this.attempt,
          unitId: id,
          content,
          meta: this.finalMeta({ examples: built.examples, actualModel: result.meta.actualModel, durationMs: result.meta.durationMs, previousIssues: previousIssues ?? [] }),
        });
        if (!saved) {
          this.lost = true;
          return;
        }
        const unit = this.units.get(id) ?? blankUnit<D>(id, this.tierOf(id));
        this.units.set(id, { ...unit, status: "done", voiceAttempts: unit.voiceAttempts + 1, errorStage: null, errorCode: null, errorRetryable: null });
        await this.afterFinal(id, content);
        return;
      }
      this.issueCount += issues.length;
      code = "validation_failed";
      previousIssues = unique(issues.map(issueSummary)).slice(0, 15);
    }
    // 실제로 보낸 시도의 실패만 기록한다. 점유를 잃었으면 기록하지 않는다 (저장 함수도 거부한다).
    if (!attempted || this.lost) return;
    await this.failUnit(id, "voice", code);
  }

  /** 단위 하나의 실패 기록. 이번 시도를 더해도 상한 미만이면 다시 시도할 수 있다. */
  protected async failUnit(id: string, stage: "draft" | "voice", code: string): Promise<void> {
    const tier = this.tierOf(id);
    const unit = this.units.get(id) ?? blankUnit<D>(id, tier);
    const used = stage === "draft" ? unit.draftAttempts : unit.voiceAttempts;
    const limit = stage === "draft" ? this.settings.draftAttemptsPerUnit : this.settings.voiceAttemptsPerUnit;
    const retryable = used + 1 < limit;
    const result = await this.unitStore.failUnit({ readingId: this.readingId, tier, attempt: this.attempt, unitId: id, stage, code, retryable });
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
}
