/**
 * 무진의 종합 사주(mujin-overview) 실제 모델 비교 도구. `npm run llm:export`·`npm run llm:render`에 `--product=mujin-overview`를 주면 쓴다.
 * 모델을 부르지 않고, API 키와 OPENAI 환경 변수를 읽지 않는다 (요청 본문의 model 칸에는 자리 표시만 둔다).
 *
 * 운영 실행기(src/server/scroll/runner.ts의 TierRun)와 같은 순서, 같은 함수로 요청을 만든다.
 *   1. 원국과 원국 작성 계획: analyzeMujinBirth (풀이 기록을 만들 때와 같다).
 *   2. 질문 정리: prepareScrollQuestionsWith. 질문 정리 모델 대신 사례에 고정한 가상 결과(scripts/llm-cases.ts)를 넣는다.
 *      범위 판정과 사용자 사실 정리는 운영 코드 그대로다.
 *   3. 단계별 장 계획: 유료는 기간 재료(computeMujinTiming, 기준일 고정) → 9·10장(buildTimingSections) → 개인화(personalizeSections),
 *      무료는 개인화만. 무료 단계의 Pass 1 입력에는 무료 장에 이어진 질문만 넣는다.
 *   4. Pass 1 묶음 요청(buildDraftRequest). 받은 초안이 있으면 장별 Pass 2 요청(buildVoiceRequest)과 마지막 정리의 Pass 1 요청.
 *   5. 받은 결과는 운영 검사(checkDraftSection, checkVoiceSection)로 읽고, 장마다 초안과 최종문을 나란히 적는다.
 * 운영과 다른 점(질문 정리 고정, 기준일 고정, 스트림 대신 한 번에 받음, 앞 묶음 초안이 없을 때의 장면 요약, 다시 쓰기 요청 없음)은
 * 안내 파일(00-guide.md)과 docs/personas/mujin-evaluation.md 3절에 적는다. 검사 통과는 형식·근거 확인일 뿐 문체 품질 판정이 아니다.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { z } from "zod";
import { buildCheckContext, checkDraftSection, checkVoiceSection, TIMING_SECTION_IDS, type MujinCheckContext } from "@/domain/mujin/check";
import { MujinNowSchema, familyLabel, relationshipLabel, workLabel, type MujinNow } from "@/domain/mujin/now";
import { MUJIN_PERSONALIZE_VERSION, personalizeSections, type MujinQuestionMaterial } from "@/domain/mujin/personalize";
import { MUJIN_TIMING_PLAN_VERSION, buildClosingSection, buildTimingSections } from "@/domain/mujin/timing-plan";
import type {
  MujinLuck,
  MujinMonths,
  MujinPlan,
  MujinSectionPlan,
  MujinTimingBundle,
  QuestionStatus,
  ScrollBlock,
  ScrollDraftContent,
  ScrollSectionContent,
  ScrollTier,
  UserFactKind,
} from "@/domain/mujin/types";
import { findPersona, type Persona } from "@/domain/personas";
import { MUJIN_OVERVIEW } from "@/domain/products/mujin-overview";
import type { ScrollDraftBatch, ScrollSectionSpec } from "@/domain/products/types";
import { analyzeMujinBirth, computeMujinTiming } from "@/server/engine/mujin";
import type { LlmCallRecorder } from "@/server/llm/call-log";
import { LLM_SETTINGS, type LlmTaskSettings } from "@/server/llm/config";
import {
  MUJIN_BUNDLES,
  MUJIN_BUNDLE_VERSION,
  MujinDraftSectionParser,
  buildDraftRequest,
  buildMujinQuestionRequest,
  buildVoiceRequest,
  type BuiltRequest,
  type MujinBundle,
  type MujinDraftOutput,
  type MujinVoiceOutput,
} from "@/server/llm/mujin-prompts";
import { prepareScrollQuestionsWith, type PreparedScrollQuestions } from "@/server/scroll/questions";
import type { AnalysisStore } from "@/server/scroll/store";
import { MUJIN_DEFAULT_REFERENCE_DATE, MUJIN_EVALUATION_CASES, mujinCaseBirth, readOption, type MujinEvaluationCase } from "./llm-cases";

const PRODUCT = MUJIN_OVERVIEW;

/** 내보내기 기본 폴더. docs/model-comparison/prompts/는 git에 올리지 않는다 (.gitignore). 사례마다 `<기준일>_<사례>` 폴더를 만든다. */
export const MUJIN_PROMPTS_ROOT = "docs/model-comparison/prompts/mujin";

/** 요청 본문의 모델 자리. 실제 모델 이름은 사용자가 비교할 모델로 바꾼다 (이 스크립트는 OPENAI_MODEL을 읽지 않는다). */
export const MODEL_PLACEHOLDER = "<OPENAI_MODEL과 같은 모델>";

/** 사용자가 플레이그라운드 결과를 저장할 파일 이름 규칙. 묶음·장 ID를 이름에서 읽는다. */
const PASS1_OUTPUT = /^p1-(.+)\.output\.json$/;
const PASS2_OUTPUT = /^p2-(.+)\.output\.json$/;

const SPECS: ReadonlyMap<string, ScrollSectionSpec> = new Map(PRODUCT.scroll.sections.map((section) => [section.id, section] as const));
/** 글을 쓰는 장 (원국표 제외), 목차 순서. */
const WRITTEN: readonly ScrollSectionSpec[] = PRODUCT.scroll.sections.filter((section) => section.kind !== "chart");
/** 운영 실행기와 같은 목차 입력 (원국표 제외). */
const TOC = WRITTEN.map((section) => ({ sectionId: section.id, title: section.title, tier: section.tier }));
const PAID_CHAPTERS = PRODUCT.scroll.sections.filter((section) => section.kind === "chapter" && section.tier === "paid").map((section) => section.id);

type TimingView = { readonly luck: MujinLuck; readonly months: MujinMonths };

/** 단계(무료·유료) 하나의 작성 계획. 운영 TierRun.prepare가 만드는 것과 같다. */
export interface MujinStage {
  readonly tier: ScrollTier;
  /** 이 단계가 쓰는 장 계획 (개인화 반영, 마지막 정리 제외). */
  readonly sections: ReadonlyMap<string, MujinSectionPlan>;
  /** Pass 1 입력의 질문. 무료 단계는 무료 장에 이어진 질문만 넣는다. */
  readonly questionMaterials: readonly MujinQuestionMaterial[];
  /** 9·10장 기간 자료 (유료 단계만). */
  readonly timing: TimingView | null;
  /** 마지막 정리 재료 번호의 시작 (개인화 다음 번호). */
  readonly closingStartRef: number;
}

export interface MujinEvaluation {
  readonly entry: MujinEvaluationCase;
  readonly referenceDate: string;
  readonly bundle: MujinBundle;
  readonly persona: Persona;
  readonly base: ReturnType<typeof analyzeMujinBirth>;
  readonly timing: MujinTimingBundle;
  readonly prepared: PreparedScrollQuestions;
  readonly stages: { readonly free: MujinStage; readonly paid: MujinStage };
}

/** 사용자가 플레이그라운드에서 받은 결과. */
export interface MujinOutputs {
  /** 장 ID → Pass 1 초안. */
  readonly drafts: ReadonlyMap<string, ScrollDraftContent>;
  /** 장 ID → Pass 2 최종문. 키는 요청한 장이다 (결과의 sectionId가 달라도 그 장에 묶어 검사가 잡게 한다). */
  readonly finals: ReadonlyMap<string, ScrollSectionContent>;
}

export const NO_OUTPUTS: MujinOutputs = { drafts: new Map(), finals: new Map() };

const isDefined = <T>(value: T | undefined | null): value is T => value !== undefined && value !== null;

/** YYYY-MM-DD 형식의 실제 날짜인지 (2월 30일 같은 날짜는 거부). */
export function isReferenceDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** 기준일 정오(Asia/Seoul)의 시각. 운영은 질문 정리 기준일을 이 시각의 서울 날짜로 정한다. */
const noonOf = (date: string) => Date.parse(`${date}T12:00:00+09:00`);

/** 운영 실행기의 nextRefOf와 같다: 공용 사실·지금의 나·장 재료의 가장 큰 m번호 다음. */
function nextRefOf(plan: MujinPlan): number {
  let max = 0;
  for (const material of [...plan.facts, ...plan.nowFacts, ...plan.sections.flatMap((section) => section.materials)]) {
    const match = /^m(\d+)$/.exec(material.ref);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max + 1;
}

/** 질문 정리 결과를 한 번만 저장하는 메모리 저장소 (DB 대신). */
function memoryAnalysisStore(): AnalysisStore {
  const saved = new Map<string, unknown>();
  return {
    async loadAnalysis<T>(_readingId: string, cacheKey: string) {
      return (saved.get(cacheKey) as T | undefined) ?? null;
    },
    async saveAnalysis<T>(_readingId: string, cacheKey: string, _kind: "question" | "timing", _version: string, payload: T) {
      if (!saved.has(cacheKey)) saved.set(cacheKey, payload);
      return { saved: true, payload: saved.get(cacheKey) as T };
    },
  };
}

/** 호출 기록을 남기지 않는다 (호출 자체가 없다). */
const NO_RECORDER: LlmCallRecorder = { forCall: () => () => undefined, flush: async () => undefined, failures: () => 0 };

function prepareCaseQuestions(entry: MujinEvaluationCase, bundle: MujinBundle, referenceDate: string): Promise<PreparedScrollQuestions> {
  return prepareScrollQuestionsWith({
    store: memoryAnalysisStore(),
    readingId: `llm-export:${entry.id}`,
    userId: "llm-export",
    product: PRODUCT,
    concern: entry.concern,
    modelId: MODEL_PLACEHOLDER,
    deadlineAt: Number.MAX_SAFE_INTEGER,
    recorder: NO_RECORDER,
    tier: "free",
    bundle,
    now: () => noonOf(referenceDate),
    // 질문 정리 모델 대신 사례에 고정한 가상 결과를 돌려준다. 궁금한 점이 비어 있으면 운영처럼 이 함수를 부르지 않는다.
    classify: async () => {
      if (!entry.classification) throw new Error(`${entry.id}: 궁금한 점이 있는데 고정 질문 정리 결과(classification)가 없습니다.`);
      return entry.classification;
    },
  });
}

function buildStage(tier: ScrollTier, plan: MujinPlan, timing: MujinTimingBundle, prepared: PreparedScrollQuestions): MujinStage {
  let startRef = nextRefOf(plan);
  const base = plan.sections.filter((section) => SPECS.get(section.sectionId)?.tier === tier);
  const added: MujinSectionPlan[] = [];
  if (tier === "paid") {
    const built = buildTimingSections({ plan, bundle: timing, product: PRODUCT, startRef });
    added.push(...built.sections);
    startRef = built.nextRef;
  }
  const personalized = personalizeSections({
    sections: [...base, ...added],
    product: PRODUCT,
    now: plan.now,
    questions: prepared.questions,
    concernFacts: prepared.concernFacts,
    startRef,
  });
  return {
    tier,
    sections: new Map(personalized.sections.map((section) => [section.sectionId, section] as const)),
    // 무료 단계에는 무료 장에 이어진 질문만 넘긴다 (유료 장에서 답할 질문을 결제 전 장에서 먼저 답하지 않게, 운영과 같다).
    questionMaterials: tier === "free" ? personalized.questionMaterials.filter((question) => question.sectionIds.length > 0) : personalized.questionMaterials,
    timing: tier === "paid" ? { luck: timing.luck, months: timing.months } : null,
    closingStartRef: personalized.nextRef,
  };
}

/**
 * 사례 하나의 작성 계획을 운영과 같은 함수로 만든다 (엔진 계산만, 모델 호출 없음). 같은 사례·기준일이면 늘 같은 계획이 나온다.
 * 기준일은 9·10장 기간 재료와 질문 정리의 기준이다 (운영: 질문 정리는 무료 생성 날, 기간 재료는 첫 유료 생성 날).
 */
export async function buildMujinEvaluation(entry: MujinEvaluationCase, referenceDate: string = MUJIN_DEFAULT_REFERENCE_DATE): Promise<MujinEvaluation> {
  if (!isReferenceDate(referenceDate)) throw new Error(`기준일은 YYYY-MM-DD 형식의 실제 날짜여야 합니다: ${referenceDate}`);
  const bundle = MUJIN_BUNDLES[MUJIN_BUNDLE_VERSION]!;
  const persona = findPersona(PRODUCT.personaId, bundle.personaVersion);
  if (!persona) throw new Error(`무진 설정을 찾지 못했습니다: ${PRODUCT.personaId} ${bundle.personaVersion}`);
  // 풀이 기록을 만들 때(src/server/scroll/create.ts)처럼 지금의 나를 같은 형식으로 다시 확인한다.
  const now = MujinNowSchema.parse(entry.now);
  const base = analyzeMujinBirth({ birth: mujinCaseBirth(entry), product: PRODUCT, nickname: entry.nickname, now });
  const timing = computeMujinTiming({ birth: base.birth, referenceDate, gender: base.plan.gender });
  const prepared = await prepareCaseQuestions(entry, bundle, referenceDate);
  return {
    entry,
    referenceDate,
    bundle,
    persona,
    base,
    timing,
    prepared,
    stages: { free: buildStage("free", base.plan, timing, prepared), paid: buildStage("paid", base.plan, timing, prepared) },
  };
}

// ─── 요청 만들기 ─────────────────────────────────────────────────────────────

const isClosingBatch = (batch: ScrollDraftBatch) => batch.sectionIds.some((id) => SPECS.get(id)?.kind === "closing");

/** 운영에서 이 묶음을 쓸 때 이미 초안이 있을 장: 앞 묶음의 장 (목차 순서). 무료 묶음은 무료 장만 본다. */
function earlierSections(batch: ScrollDraftBatch): string[] {
  const batches = PRODUCT.scroll.draftBatches;
  return batches
    .slice(0, batches.findIndex((entry) => entry.id === batch.id))
    .flatMap((entry) => entry.sectionIds)
    .filter((id) => batch.tier === "paid" || SPECS.get(id)?.tier === "free");
}

export interface MujinClosingState {
  /** 마지막 정리 계획. 운영처럼 유료 장의 초안이 모두 있어야 만든다 (각 장 초안의 핵심 답을 모은다). */
  readonly plan: MujinSectionPlan | null;
  /** 초안이 없어 마지막 정리를 아직 만들지 못하게 하는 유료 장. */
  readonly missing: readonly string[];
}

export function closingState(evaluation: MujinEvaluation, outputs: MujinOutputs = NO_OUTPUTS): MujinClosingState {
  const missing = PAID_CHAPTERS.filter((id) => !outputs.drafts.has(id));
  if (missing.length) return { plan: null, missing };
  const chapterAnswers = PRODUCT.scroll.sections
    .filter((section) => section.kind === "chapter")
    .map((section) => ({
      sectionId: section.id,
      title: section.title,
      coreAnswer: outputs.drafts.get(section.id)?.coreAnswer ?? outputs.finals.get(section.id)?.coreAnswer ?? "",
    }));
  const built = buildClosingSection({ product: PRODUCT, questions: evaluation.prepared.questions, chapterAnswers, startRef: evaluation.stages.paid.closingStartRef });
  return { plan: built.section, missing: [] };
}

export interface MujinPass1Request {
  readonly batch: ScrollDraftBatch;
  readonly request: BuiltRequest<MujinDraftOutput>;
  /** usedScenes(앞 묶음의 장면 요약)를 넣은 앞 장(given)과, 초안이 없어 넣지 못한 앞 장(missing). */
  readonly scenes: { readonly given: readonly string[]; readonly missing: readonly string[] };
}

/**
 * Pass 1 묶음 요청 (운영 draftBatch의 첫 요청과 같다). 마지막 정리 묶음은 유료 장 초안이 모두 있을 때만 만든다.
 * usedScenes에는 받은 초안 가운데 앞 묶음 장의 장면 요약을 목차 순서로 넣는다. 앞 묶음 초안이 없으면 비어 있다 (운영과 다름, scenes.missing).
 */
export function pass1Requests(evaluation: MujinEvaluation, outputs: MujinOutputs = NO_OUTPUTS): { readonly requests: readonly MujinPass1Request[]; readonly closing: MujinClosingState } {
  const { bundle, base, stages } = evaluation;
  const closing = closingState(evaluation, outputs);
  const requests: MujinPass1Request[] = [];
  for (const batch of PRODUCT.scroll.draftBatches) {
    const stage = stages[batch.tier];
    const sections = isClosingBatch(batch) ? [closing.plan].filter(isDefined) : batch.sectionIds.map((id) => stage.sections.get(id)).filter(isDefined);
    if (!sections.length) continue;
    const earlier = earlierSections(batch);
    const given = earlier.filter((id) => outputs.drafts.has(id));
    const request = buildDraftRequest({
      bundle,
      plan: base.plan,
      sections,
      questions: stage.questionMaterials,
      usedScenes: given.flatMap((id) => outputs.drafts.get(id)!.scenes),
      toc: TOC,
      // 기간 자료는 9·10장 묶음에만 넣는다 (운영과 같다).
      timing: batch.sectionIds.some((id) => TIMING_SECTION_IDS.has(id)) ? stage.timing : null,
    });
    requests.push({ batch, request, scenes: { given, missing: earlier.filter((id) => !outputs.drafts.has(id)) } });
  }
  return { requests, closing };
}

/** 장 ID의 작성 계획 (그 장을 쓰는 단계의 것). 마지막 정리는 계획이 준비됐을 때만 있다. */
export function sectionPlanOf(evaluation: MujinEvaluation, sectionId: string, closing: MujinClosingState): MujinSectionPlan | null {
  const spec = SPECS.get(sectionId);
  if (!spec || spec.kind === "chart") return null;
  if (spec.kind === "closing") return closing.plan;
  return evaluation.stages[spec.tier].sections.get(sectionId) ?? null;
}

function voiceRequestFor(evaluation: MujinEvaluation, section: MujinSectionPlan, draft: ScrollDraftContent): BuiltRequest<MujinVoiceOutput> {
  const { plan } = evaluation.base;
  return buildVoiceRequest({
    bundle: evaluation.bundle,
    persona: evaluation.persona,
    nickname: plan.nickname,
    section: {
      sectionId: section.sectionId,
      title: section.title,
      questions: section.questions.map(({ id, title }) => ({ id, title })),
      targetChars: section.targetChars,
    },
    draft,
    // 운영과 같이 지금의 나와 이 장의 사용자 사실을 넘긴다 (검사 기준과 같은 사실).
    userFacts: [...plan.nowFacts, ...section.materials.filter((material) => material.kind === "user-fact")],
  });
}

export interface MujinPass2Request {
  readonly sectionId: string;
  readonly tier: ScrollTier;
  readonly request: BuiltRequest<MujinVoiceOutput>;
}

/** 초안이 있는 장마다 Pass 2 요청 (운영 voice의 첫 요청과 같다). 검사에 걸린 초안도 비교를 위해 요청을 만든다. */
export function pass2Requests(evaluation: MujinEvaluation, outputs: MujinOutputs): MujinPass2Request[] {
  const closing = closingState(evaluation, outputs);
  return WRITTEN.flatMap((spec) => {
    const draft = outputs.drafts.get(spec.id);
    const section = sectionPlanOf(evaluation, spec.id, closing);
    return draft && section ? [{ sectionId: spec.id, tier: spec.tier, request: voiceRequestFor(evaluation, section, draft) }] : [];
  });
}

/** 질문 정리 요청 (선택, 고정 가상 값과 실제 분류를 비교할 때). 궁금한 점이 비어 있으면 없다 (운영도 부르지 않는다). */
export function questionRequest(evaluation: MujinEvaluation) {
  const { entry, bundle, referenceDate } = evaluation;
  return entry.concern.trim() ? buildMujinQuestionRequest({ product: PRODUCT, concern: entry.concern, referenceDate, bundle }) : null;
}

/** 단계의 검사 기준 (운영 TierRun.checkContext와 같다). 마지막 정리를 검사할 때만 그 계획을 더한다. */
export function checkContextOf(evaluation: MujinEvaluation, tier: ScrollTier, closingPlan: MujinSectionPlan | null = null): MujinCheckContext {
  const stage = evaluation.stages[tier];
  return buildCheckContext({
    plan: evaluation.base.plan,
    sections: [...stage.sections.values(), ...(closingPlan ? [closingPlan] : [])],
    questions: stage.questionMaterials,
    chart: evaluation.base.chart,
    timing: stage.timing,
    excluded: evaluation.prepared.excluded,
  });
}

/** 운영 호출(src/server/llm/client.ts)과 같은 Responses API 본문. 모델만 비교할 것으로 바꾼다. */
export function requestBody(request: Pick<BuiltRequest<unknown>, "instructions" | "input" | "schemaName" | "jsonSchema">, task: LlmTaskSettings): Record<string, unknown> {
  return {
    model: MODEL_PLACEHOLDER,
    instructions: request.instructions,
    input: request.input,
    store: false,
    max_output_tokens: task.maxOutputTokens,
    reasoning: { effort: task.reasoningEffort },
    text: { format: { type: "json_schema", name: request.schemaName, schema: request.jsonSchema, strict: true } },
  };
}

// ─── 결과 읽기 ─────────────────────────────────────────────────────────────

export interface OutputSource {
  readonly file: string;
  readonly pass: 1 | 2;
  /** 파일 이름에서 읽은 묶음 ID(Pass 1)나 장 ID(Pass 2). 이름 규칙(p1-<묶음>.output.json, p2-<장>.output.json)과 다르면 null. */
  readonly unit: string | null;
}

/** 명령줄의 경로 목록 (쉼표로 나눈 파일·폴더). */
export const splitPaths = (value: string): string[] =>
  value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

/**
 * 결과 파일 목록. 폴더는 이름 규칙(p1-<묶음>.output.json, p2-<장>.output.json)에 맞는 파일만 읽고, 파일은 이름과 관계없이 읽는다.
 * 기본 사례 폴더처럼 없어도 되는 경로는 optional로 준다 (없으면 빈 목록).
 */
export function outputSources(paths: readonly string[], pass: 1 | 2, optional = false): OutputSource[] {
  const pattern = pass === 1 ? PASS1_OUTPUT : PASS2_OUTPUT;
  const sources: OutputSource[] = [];
  for (const entry of paths) {
    const target = path.resolve(entry);
    if (!existsSync(target)) {
      if (optional) continue;
      throw new Error(`결과 경로가 없습니다: ${entry}`);
    }
    if (statSync(target).isDirectory()) {
      for (const name of readdirSync(target).sort()) {
        const match = pattern.exec(name);
        if (match) sources.push({ file: path.join(target, name), pass, unit: match[1]! });
      }
    } else {
      sources.push({ file: target, pass, unit: pattern.exec(path.basename(target))?.[1] ?? null });
    }
  }
  return sources;
}

/** 저장한 결과에서 모델이 낸 JSON을 꺼낸다: 그 JSON 자체, Responses API 응답 전체(output[].content[] output_text), { output_text }. */
export function modelJson(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const record = raw as { readonly output_text?: unknown; readonly output?: unknown };
  if (typeof record.output_text === "string") return JSON.parse(record.output_text);
  if (Array.isArray(record.output)) {
    for (const item of record.output as { readonly content?: readonly { readonly type?: unknown; readonly text?: unknown }[] }[]) {
      for (const part of item?.content ?? []) if (part?.type === "output_text" && typeof part.text === "string") return JSON.parse(part.text);
    }
  }
  return raw;
}

export interface LoadedOutputs extends MujinOutputs {
  /** 읽은 파일과 그 파일에서 받은 장. */
  readonly files: readonly { readonly file: string; readonly pass: 1 | 2; readonly sections: readonly string[] }[];
  /** 읽지 못했거나 버린 결과 (형식 오류, 요청하지 않은 장, 같은 장의 두 번째 결과). */
  readonly problems: readonly string[];
}

/** Pass 2 출력 파서 (운영 형식). 요청을 만드는 함수에서만 꺼낼 수 있어 빈 장으로 한 번 만든다. */
function voiceParserOf(evaluation: MujinEvaluation): z.ZodType<MujinVoiceOutput> {
  return buildVoiceRequest({
    bundle: evaluation.bundle,
    persona: evaluation.persona,
    nickname: evaluation.base.plan.nickname,
    section: { sectionId: "-", title: "-", questions: [], targetChars: { min: 0, max: 0 } },
    draft: { sectionId: "-", coreAnswer: "", blocks: [], scenes: [] },
    userFacts: [],
  }).parser;
}

function readModelJson(file: string): { readonly value: unknown } | { readonly error: string } {
  try {
    return { value: modelJson(JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, ""))) };
  } catch {
    return { error: "JSON으로 읽지 못했습니다." };
  }
}

const isWrittenSection = (id: string) => SPECS.has(id) && SPECS.get(id)!.kind !== "chart";

/**
 * 결과 파일을 읽는다. 운영처럼 장 원소마다 형식을 확인하고, 묶음에서 요청하지 않은 장과 같은 장의 두 번째 원소는 쓰지 않는다.
 * Pass 2 결과는 파일 이름의 장(p2-<장>.output.json)에 묶는다. 이름 규칙과 다르면 결과의 sectionId를 쓴다.
 */
export function loadOutputs(evaluation: MujinEvaluation, sources: readonly OutputSource[]): LoadedOutputs {
  const drafts = new Map<string, ScrollDraftContent>();
  const finals = new Map<string, ScrollSectionContent>();
  const files: { file: string; pass: 1 | 2; sections: string[] }[] = [];
  const problems: string[] = [];
  const voiceParser = voiceParserOf(evaluation);

  for (const source of sources) {
    const label = path.basename(source.file);
    const read = readModelJson(source.file);
    if ("error" in read) {
      problems.push(`${label}: ${read.error}`);
      continue;
    }
    const sections: string[] = [];
    files.push({ file: source.file, pass: source.pass, sections });

    if (source.pass === 1) {
      const items = (read.value as { readonly sections?: unknown } | null)?.sections;
      if (!Array.isArray(items)) {
        problems.push(`${label}: Pass 1 결과 형식({ sections: [...] })이 아닙니다.`);
        continue;
      }
      const batch = source.unit ? PRODUCT.scroll.draftBatches.find((entry) => entry.id === source.unit) : undefined;
      if (source.unit && !batch) problems.push(`${label}: 파일 이름의 묶음(${source.unit})을 모릅니다. 장 ID로만 읽습니다.`);
      const elements: readonly unknown[] = items;
      for (const [index, item] of elements.entries()) {
        const claimed = (item as { readonly sectionId?: unknown } | null)?.sectionId;
        const where = `${label} ${index + 1}번째 장${typeof claimed === "string" ? ` (${claimed})` : ""}`;
        const parsed = MujinDraftSectionParser.safeParse(item);
        if (!parsed.success) {
          problems.push(`${where}: 출력 형식이 맞지 않아 읽지 않았습니다.`);
          continue;
        }
        const id = parsed.data.sectionId;
        const reason = !isWrittenSection(id)
          ? "이 상품에 없는 장입니다."
          : batch && !batch.sectionIds.includes(id)
            ? `이 묶음(${batch.id})에서 요청하지 않은 장이라 읽지 않았습니다.`
            : drafts.has(id)
              ? "같은 장의 초안을 이미 읽어 앞의 것을 씁니다."
              : null;
        if (reason) {
          problems.push(`${where}: ${reason}`);
          continue;
        }
        drafts.set(id, parsed.data);
        sections.push(id);
      }
      continue;
    }

    const parsed = voiceParser.safeParse(read.value);
    if (!parsed.success) {
      problems.push(`${label}: Pass 2 결과 형식({ section: { sectionId, coreAnswer, blocks } })이 아닙니다.`);
      continue;
    }
    const id = source.unit ?? parsed.data.section.sectionId;
    if (!isWrittenSection(id)) {
      problems.push(`${label}: 이 상품에 없는 장(${id})입니다.`);
      continue;
    }
    if (finals.has(id)) {
      problems.push(`${label}: 같은 장(${id})의 최종문을 이미 읽어 앞의 것을 씁니다.`);
      continue;
    }
    finals.set(id, parsed.data.section);
    sections.push(id);
  }
  return { drafts, finals, files, problems };
}

/** 사례 폴더(기본)나 --draft·--voice 경로에서 결과를 읽는다. 경로를 주면 그 경로만, 안 주면 사례 폴더의 이름 규칙 파일을 읽는다. */
export function loadCaseOutputs(evaluation: MujinEvaluation, options: { readonly dir: string; readonly draft?: string; readonly voice?: string }): LoadedOutputs {
  return loadOutputs(evaluation, [
    ...(options.draft ? outputSources(splitPaths(options.draft), 1) : outputSources([options.dir], 1, true)),
    ...(options.voice ? outputSources(splitPaths(options.voice), 2) : outputSources([options.dir], 2, true)),
  ]);
}

// ─── 장별 검사와 글자 수 ─────────────────────────────────────────────────────

/** 화면에 보이는 글자 수 (공백 포함, 강조 표시 ** 제외): 핵심 답, 블록 글, 비교·점검 항목. 편집 목표와 견주는 참고값이다. */
export function contentChars(content: ScrollSectionContent): number {
  const texts = [content.coreAnswer, ...content.blocks.flatMap((block) => [block.text, ...block.items.flatMap((item) => [item.label, item.text])])];
  return texts.reduce((sum, text) => sum + text.replaceAll("**", "").length, 0);
}

export interface MujinSectionReview {
  readonly spec: ScrollSectionSpec;
  readonly batchId: string;
  /** 그 장의 작성 계획 (마지막 정리는 유료 장 초안이 모두 있어야 있다). */
  readonly plan: MujinSectionPlan | null;
  readonly draft: ScrollDraftContent | null;
  readonly final: ScrollSectionContent | null;
  /** 운영 Pass 1 검사(checkDraftSection). 초안이나 계획이 없으면 null. */
  readonly draftIssues: readonly string[] | null;
  /** 운영 Pass 2 검사(checkVoiceSection). 최종문·초안·계획이 모두 있어야 한다. */
  readonly finalIssues: readonly string[] | null;
  readonly draftChars: number | null;
  readonly finalChars: number | null;
}

/**
 * 장마다 운영 검사를 돌린다. 검사 기준은 운영처럼 단계별로 만든다 (무료: 무료 장·무료 질문·기간 자료 없음, 유료: 유료 장·모든 질문·기간 자료).
 * 유료 장은 마지막 정리가 생기기 전의 기준으로, 마지막 정리는 그 계획을 더한 기준으로 본다 (운영에서 장 초안을 검사하는 때와 같다).
 */
export function reviewSections(evaluation: MujinEvaluation, outputs: MujinOutputs): MujinSectionReview[] {
  const closing = closingState(evaluation, outputs);
  const contexts = {
    free: checkContextOf(evaluation, "free"),
    paid: checkContextOf(evaluation, "paid"),
    closing: closing.plan ? checkContextOf(evaluation, "paid", closing.plan) : null,
  };
  return WRITTEN.map((spec) => {
    const plan = sectionPlanOf(evaluation, spec.id, closing);
    const context = spec.kind === "closing" ? contexts.closing : contexts[spec.tier];
    const draft = outputs.drafts.get(spec.id) ?? null;
    const final = outputs.finals.get(spec.id) ?? null;
    return {
      spec,
      batchId: PRODUCT.scroll.draftBatches.find((batch) => batch.sectionIds.includes(spec.id))?.id ?? spec.id,
      plan,
      draft,
      final,
      draftIssues: draft && plan && context ? checkDraftSection(draft, plan, context) : null,
      finalIssues: final && draft && plan && context ? checkVoiceSection(final, draft, plan, context) : null,
      draftChars: draft ? contentChars(draft) : null,
      finalChars: final ? contentChars(final) : null,
    };
  });
}

// ─── 표시용 문구 ─────────────────────────────────────────────────────────────

const STATUS_LABEL: Readonly<Record<QuestionStatus, string>> = {
  adopted: "채택",
  conditional: "조건부",
  deferred: "보류",
  general: "일반 점검",
  unavailable: "자료 없음",
};

const FACT_KIND_LABEL: Readonly<Record<UserFactKind, string>> = {
  current: "현재",
  past: "과거",
  plan: "계획",
  hypothetical: "가정",
  "about-others": "다른 사람에 대한 관찰",
};

/** 질문 분야와 의도의 짧은 이름 (안내 표에만 쓴다). */
const DOMAIN_LABEL: Readonly<Record<string, string>> = {
  temperament: "성향",
  strengths: "강점·재능",
  career: "직업",
  wealth: "재물",
  romance: "연애",
  social: "인간관계",
  family: "가족",
  friends: "친구",
  place: "지역",
  general: "넓은 질문",
  health: "건강",
  investment: "투자",
  study: "학업",
  "other-person": "다른 사람",
  "non-saju": "사주와 무관",
};
const INTENT_LABEL: Readonly<Record<string, string>> = {
  explain: "뜻 설명",
  apply: "적용",
  timing: "시기",
  compare: "비교",
  outcome: "결과 확정 요구",
  general: "넓은 질문",
};
const labeled = (labels: Readonly<Record<string, string>>, value: string) => (Object.hasOwn(labels, value) ? `${labels[value]} (${value})` : value);

const BLOCK_LABEL: Readonly<Record<ScrollBlock["type"], string>> = {
  paragraph: "설명",
  basis: "근거",
  condition: "조건",
  compare: "비교",
  apply: "적용",
  checklist: "점검",
  scene: "장면",
};

/** 장 이름 (예: '1장 성향과 내면', '원국 분석', '마지막 정리'). */
export function sectionName(sectionId: string): string {
  const spec = SPECS.get(sectionId);
  if (!spec) return sectionId;
  return spec.number === null ? spec.title : `${spec.number}장 ${spec.title}`;
}

const tierLabel = (tier: ScrollTier) => (tier === "free" ? "무료" : "유료");
const range = (target: { readonly min: number; readonly max: number }) => `${target.min.toLocaleString("ko-KR")}~${target.max.toLocaleString("ko-KR")}자`;
const chars = (value: number | null) => (value === null ? "-" : `${value.toLocaleString("ko-KR")}자`);

function birthLabel(entry: MujinEvaluationCase): string {
  const { birth } = entry;
  const time = birth.birthTime.status === "branch" ? `${birth.birthTime.branch}시` : "시각 모름";
  return `${birth.birthDate} (${birth.calendar === "solar" ? "양력" : "음력"}) ${time}, ${birth.gender === "male" ? "남" : "여"}, 서울특별시`;
}

export function nowLabel(now: MujinNow): string {
  const list = (values: readonly string[]) => (values.length ? values.join(", ") : "미응답");
  return [
    `일·학업: ${list(now.work.map(workLabel))}`,
    `관심 장: ${list(now.interests.map(sectionName))}`,
    `관계: ${now.relationship ? relationshipLabel(now.relationship) : "미응답"}`,
    `가족: ${list(now.family.map(familyLabel))}`,
  ].join(" / ");
}

/** 표 칸에 넣을 글. 표를 깨는 |와 꺾쇠를 바꾸고 줄바꿈은 <br>로 둔다. */
function cell(text: string): string {
  return text.replaceAll("|", "\\|").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replace(/\r?\n/g, "<br>");
}

function blockCell(block: ScrollBlock | undefined): string {
  if (!block) return "";
  const questions = block.questionIds.length ? ` · 질문 ${block.questionIds.join(", ")}` : "";
  const items = block.items.map((item) => `- ${item.label ? `${item.label}: ` : ""}${item.text}`);
  return cell([`[${BLOCK_LABEL[block.type] ?? block.type}${questions}]`, block.text, ...items].filter((line) => line.trim().length > 0).join("\n"));
}

/** 질문이 이어진 장 (무료·유료 단계를 합쳐 목차 순서). 마지막 정리는 모든 질문을 모은다. */
function linkedSections(evaluation: MujinEvaluation, ref: string): string[] {
  const ids = new Set([...evaluation.stages.free.questionMaterials, ...evaluation.stages.paid.questionMaterials].filter((question) => question.ref === ref).flatMap((question) => question.sectionIds));
  return [...WRITTEN.filter((spec) => ids.has(spec.id)).map((spec) => sectionName(spec.id)), "마지막 정리"];
}

const HEADER_NOTES = (evaluation: MujinEvaluation) => [
  "> 모델을 부르지 않고 만든 파일이다. API 키와 OPENAI 환경 변수를 읽지 않는다.",
  "> **질문 정리 결과는 실제 모델의 출력이 아니라 이 사례에 고정한 가상 값이다** (`scripts/llm-cases.ts`의 `MUJIN_EVALUATION_CASES`). 운영에서는 질문 정리 모델(`mujin-question-1.0.0`)이 궁금한 점 원문을 읽어 만든다.",
  `> 9·10장 기간 재료와 질문 정리의 기준일은 ${evaluation.referenceDate}로 고정했다 (운영: 질문 정리는 무료 단계를 쓴 날, 기간 재료는 첫 유료 생성 날).`,
  "> 출생 정보·별명·궁금한 점은 모두 가상의 평가 입력이다. 결과 원문은 이 폴더(git에 올리지 않음)에만 둔다.",
];

function caseLines(evaluation: MujinEvaluation): string[] {
  const { entry } = evaluation;
  return [
    "| 칸 | 값 |",
    "| --- | --- |",
    `| 사례 | \`${entry.id}\` (docs/personas/mujin-evaluation.md 2절 ${entry.number}번) |`,
    `| 명세의 항목 | ${cell(entry.item)} |`,
    `| 주로 볼 것 | ${cell(entry.focus)} |`,
    `| 별명 | ${cell(entry.nickname)} |`,
    `| 출생 | ${birthLabel(entry)} |`,
    `| 지금의 나 | ${cell(nowLabel(entry.now))} |`,
    `| 진짜 궁금한 점 | ${entry.concern ? cell(entry.concern) : "(비워 둠, 질문 정리를 하지 않는다)"} |`,
  ];
}

function questionLines(evaluation: MujinEvaluation): string[] {
  const { entry, prepared } = evaluation;
  if (!entry.classification) return ["궁금한 점이 비어 있어 질문 정리를 하지 않았다 (운영과 같다). 모든 장을 상품 기본 구성으로 쓴다."];
  const lines = [
    "고정 분류 결과(가상 값)를 운영 코드가 상품 범위로 다시 판정한 것이다.",
    "",
    "| ref | 정리된 질문 | 분야 | 의도 | 범위 | 이어진 장 |",
    "| --- | --- | --- | --- | --- | --- |",
    ...prepared.analysis.items.map((item) => {
      const head = `| ${item.id} | ${cell(item.summary)} | ${labeled(DOMAIN_LABEL, item.domain)} | ${labeled(INTENT_LABEL, item.intent)}`;
      return item.scope === "in"
        ? `${head}${item.answerability === "limited" ? ", 판단할 수 있는 부분만 답함" : ""} | 범위 안 | ${cell(linkedSections(evaluation, item.id).join(", "))} |`
        : `${head} | 범위 밖 (생성 입력에 넣지 않음) | - |`;
    }),
    "",
  ];
  const facts = entry.classification.userFacts;
  if (facts.length) {
    lines.push("| 사용자 사실 (가상 값) | 분야 | 종류 | 생성 입력 |", "| --- | --- | --- | --- |");
    for (const fact of facts) {
      const used = prepared.concernFacts.some((kept) => kept.text === fact.text.trim());
      lines.push(`| ${cell(fact.text)} | ${labeled(DOMAIN_LABEL, fact.domain)} | ${FACT_KIND_LABEL[fact.kind] ?? fact.kind} | ${used ? "넣음" : "넣지 않음 (범위 밖)"} |`);
    }
  } else {
    lines.push("사용자 사실: 없음");
  }
  return lines;
}

function versionLines(evaluation: MujinEvaluation): string[] {
  const { bundle, base, timing } = evaluation;
  const draft = LLM_SETTINGS.tasks.mujinDraft;
  const voice = LLM_SETTINGS.tasks.mujinVoice;
  return [
    `- 묶음 \`${bundle.id}\`: Pass 1 \`${bundle.draftPrompt}\` / \`${bundle.draftSchema}\`, Pass 2 \`${bundle.voicePrompt}\` / \`${bundle.voiceSchema}\`, 질문 정리 \`${bundle.questionPrompt}\`, 무진 설정 ${evaluation.persona.version}, 해석 지침 \`${bundle.guideVersion}\``,
    `- 상품 \`${PRODUCT.id}\` ${PRODUCT.version}, 작성 계획 \`${base.plan.planVersion}\`, 개인화 \`${MUJIN_PERSONALIZE_VERSION}\`, 기간 계획 \`${MUJIN_TIMING_PLAN_VERSION}\`, 기간 재료 \`${timing.version}\` (기준일 ${timing.referenceDate})`,
    `- 운영과 같은 호출 설정: Pass 1 추론 ${draft.reasoningEffort}·출력 한도 ${draft.maxOutputTokens.toLocaleString("ko-KR")}, Pass 2 추론 ${voice.reasoningEffort}·출력 한도 ${voice.maxOutputTokens.toLocaleString("ko-KR")} (src/server/llm/config.ts)`,
  ];
}

// ─── 내보내기 (llm:export) ─────────────────────────────────────────────────

/** 사례 폴더의 기본 위치. */
export function defaultCaseDir(entry: MujinEvaluationCase, referenceDate: string): string {
  return path.resolve(MUJIN_PROMPTS_ROOT, `${referenceDate}_${entry.id}`);
}

function writeRequestFiles(dir: string, stem: string, request: Pick<BuiltRequest<unknown>, "instructions" | "input" | "schemaName" | "jsonSchema">, task: LlmTaskSettings): string[] {
  const files: [string, string][] = [
    [`${stem}.instructions.txt`, request.instructions],
    // 운영이 보내는 문자열 그대로 (JSON 한 줄). 읽기 편하게 보려면 편집기의 JSON 정렬 기능을 쓴다.
    [`${stem}.input.json`, request.input],
    [`${stem}.schema.json`, JSON.stringify({ name: request.schemaName, strict: true, schema: request.jsonSchema }, null, 2)],
    [`${stem}.request.json`, JSON.stringify(requestBody(request, task), null, 2)],
  ];
  for (const [name, content] of files) writeFileSync(path.join(dir, name), content);
  return files.map(([name]) => name);
}

interface ExportRow {
  readonly order: string;
  readonly pass: string;
  readonly unit: string;
  readonly request: string;
  readonly output: string;
  readonly state: string;
}

export interface MujinExportResult {
  readonly dir: string;
  /** 이번에 쓴 파일 이름 (사례 폴더 기준). */
  readonly written: readonly string[];
  /** 지금 실행할 수 있는 요청 (파일 이름 앞부분). */
  readonly ready: readonly string[];
}

/**
 * 사례 폴더에 요청 파일과 안내 파일(00-guide.md)을 쓴다.
 * - Pass 1: 결과가 아직 없는 묶음의 요청만 쓴다 (결과가 있는 묶음의 요청은 그 결과를 만든 그대로 둔다). 마지막 정리는 유료 장 초안이 모두 있을 때.
 * - Pass 2: 초안이 있고 최종문이 아직 없는 장의 요청만 쓴다.
 * - 질문 정리(p0-question): 궁금한 점이 있으면 참고용으로 쓴다. 다음 단계 입력에는 쓰지 않는다 (고정 가상 값을 쓴다).
 */
export function writeMujinExport(evaluation: MujinEvaluation, outputs: LoadedOutputs, dir: string): MujinExportResult {
  mkdirSync(dir, { recursive: true });
  const written: string[] = [];
  const ready: string[] = [];
  const rows: ExportRow[] = [];

  const question = questionRequest(evaluation);
  if (question) written.push(...writeRequestFiles(dir, "p0-question", question, LLM_SETTINGS.tasks.classify));

  const { requests, closing } = pass1Requests(evaluation, outputs);
  let order = 1;
  for (const batch of PRODUCT.scroll.draftBatches) {
    const names = batch.sectionIds.map(sectionName).join(", ");
    const entry = requests.find((request) => request.batch.id === batch.id);
    const drafted = batch.sectionIds.filter((id) => outputs.drafts.has(id));
    const stem = `p1-${batch.id}`;
    let state: string;
    if (drafted.length === batch.sectionIds.length) {
      state = "결과 있음";
    } else if (drafted.length > 0) {
      state = `일부 장만 있음 (없는 장: ${batch.sectionIds.filter((id) => !outputs.drafts.has(id)).join(", ")}). 같은 요청을 다시 실행해 결과 파일을 바꾼다`;
    } else if (!entry) {
      state = `기다림: 유료 장 초안이 모두 있어야 만든다 (없는 장: ${closing.missing.join(", ")})`;
    } else {
      written.push(...writeRequestFiles(dir, stem, entry.request, LLM_SETTINGS.tasks.mujinDraft));
      ready.push(stem);
      const { given, missing } = entry.scenes;
      state =
        given.length + missing.length === 0
          ? "실행할 차례"
          : missing.length === 0
            ? `실행할 차례 (앞 묶음 초안 ${given.length}개의 장면 요약을 넣음, 운영과 같다)`
            : given.length === 0
              ? "실행할 차례 (앞 묶음 초안이 아직 없어 장면 요약이 비어 있다, 운영과 다르다)"
              : `실행할 차례 (앞 묶음 장 ${given.length + missing.length}개 가운데 ${given.length}개의 초안만 장면 요약에 넣음, 운영과 다르다)`;
    }
    rows.push({ order: String(order++), pass: `Pass 1 (${tierLabel(batch.tier)})`, unit: `\`${batch.id}\`: ${names}`, request: `${stem}.*`, output: `${stem}.output.json`, state });
  }

  for (const request of pass2Requests(evaluation, outputs)) {
    if (outputs.finals.has(request.sectionId)) continue;
    const stem = `p2-${request.sectionId}`;
    written.push(...writeRequestFiles(dir, stem, request.request, LLM_SETTINGS.tasks.mujinVoice));
    ready.push(stem);
  }
  for (const spec of WRITTEN) {
    const stem = `p2-${spec.id}`;
    const state = outputs.finals.has(spec.id) ? "결과 있음" : ready.includes(stem) ? "실행할 차례" : outputs.drafts.has(spec.id) ? "기다림: 마지막 정리 계획이 아직 없다" : "기다림: 이 장의 Pass 1 초안이 있어야 만든다";
    rows.push({ order: String(order++), pass: `Pass 2 (${tierLabel(spec.tier)})`, unit: `\`${spec.id}\`: ${sectionName(spec.id)}`, request: `${stem}.*`, output: `${stem}.output.json`, state });
  }

  writeFileSync(path.join(dir, "00-guide.md"), guideMarkdown(evaluation, outputs, dir, rows));
  written.push("00-guide.md");
  return { dir, written, ready };
}

function commandLine(script: "llm:export" | "llm:render", evaluation: MujinEvaluation, dir: string): string {
  const parts = [`npm run ${script} '--' --product=${PRODUCT.id} --case=${evaluation.entry.id} --reference=${evaluation.referenceDate}`];
  if (path.resolve(dir) !== defaultCaseDir(evaluation.entry, evaluation.referenceDate)) parts.push(`--dir="${dir}"`);
  return parts.join(" ");
}

function guideMarkdown(evaluation: MujinEvaluation, outputs: LoadedOutputs, dir: string, rows: readonly ExportRow[]): string {
  const { entry } = evaluation;
  const reviews = reviewSections(evaluation, outputs).filter((review) => review.draft);
  const lines = [
    `# 무진 모델 비교 파일: ${entry.id} (사례 ${entry.number}, 기준일 ${evaluation.referenceDate})`,
    "",
    ...HEADER_NOTES(evaluation),
    "",
    "## 사례",
    "",
    ...caseLines(evaluation),
    "",
    "## 질문 정리 (고정 가상 값)",
    "",
    ...questionLines(evaluation),
    "",
    "## 버전",
    "",
    ...versionLines(evaluation),
    "",
    "## 진행 상황",
    "",
    "결과 파일은 사용자가 플레이그라운드 결과를 저장하는 이름이다. 이 이름이어야 다음 명령이 읽는다.",
    "",
    "| 순서 | 단계 | 묶음·장 | 요청 파일 | 결과 파일 (직접 저장) | 상태 |",
    "| --- | --- | --- | --- | --- | --- |",
    ...rows.map((row) => `| ${row.order} | ${row.pass} | ${cell(row.unit)} | ${row.request} | ${row.output} | ${cell(row.state)} |`),
    "",
    "## 순서",
    "",
    "1. 표에서 '실행할 차례'인 Pass 1 요청을 플레이그라운드에서 실행하고, 모델이 낸 JSON을 '결과 파일' 이름으로 이 폴더에 저장한다.",
    "   운영과 같은 장면 요약(usedScenes)을 넣으려면 묶음 하나를 실행할 때마다 아래 명령을 다시 실행해 다음 묶음의 요청 파일을 새로 만든다.",
    "   한 번에 모두 실행해도 되지만, 그러면 뒤 묶음의 장면 요약이 비어 장면과 조언이 운영보다 더 겹칠 수 있다.",
    `   \`${commandLine("llm:export", evaluation, dir)}\``,
    "2. 같은 명령을 다시 실행하면 저장한 초안으로 장별 Pass 2 요청이 생긴다. 유료 장(2~10장) 초안이 모두 있으면 마지막 정리의 Pass 1 요청도 생긴다.",
    "3. Pass 2 요청을 실행해 결과를 '결과 파일' 이름으로 저장한다 (마지막 정리도 Pass 1 → Pass 2 순서).",
    `4. \`${commandLine("llm:render", evaluation, dir)}\`로 이 폴더에 \`comparison.md\`(장마다 초안과 최종문을 나란히 놓은 표, 운영 검사 결과, 글자 수)를 만들고 읽는다.`,
    "5. docs/personas/mujin-evaluation.md 1절(명세 07 4절)의 항목 1~9로 판정하고 3절 양식에 기록한다.",
    ...(entry.concern ? ["", "선택: `p0-question.*`은 이 사례의 궁금한 점으로 만든 실제 질문 정리 요청이다. 실행하면 모델의 분류를 위의 고정 가상 값과 비교할 수 있다 (다음 단계 입력에는 쓰지 않는다)."] : []),
    "",
    "## 플레이그라운드에서 실행하는 법",
    "",
    "- 모델: 운영과 같은 모델 (OPENAI_MODEL에 둔 값, 개발 기본 gpt-5.6-luna). 추론 강도와 출력 한도는 위 '버전'과 같게 둔다.",
    "- 지시(System message, Instructions): `*.instructions.txt` 내용 그대로.",
    "- 입력(User message): `*.input.json` 내용 그대로. 운영이 보내는 문자열과 같다 (JSON 한 줄).",
    "- 출력 형식: JSON schema로 `*.schema.json` 내용을 넣는다 (`strict: true`).",
    "- 직접 요청을 보내는 도구를 쓰면 `*.request.json`이 Responses API 본문이다. `model`만 바꾼다. 응답 전체를 저장해도 결과로 읽는다.",
    "- 결과: 모델이 낸 JSON(Pass 1은 `{ \"sections\": [...] }`, Pass 2는 `{ \"section\": {...} }`)을 결과 파일 이름으로 저장한다.",
    "",
    "## Pass 1 초안 검사 (운영 검사)",
    "",
    ...(reviews.length
      ? reviews.flatMap((review) =>
          review.draftIssues === null
            ? [`- ${sectionName(review.spec.id)}: 계획이 아직 없어 검사하지 않았다`]
            : review.draftIssues.length
              ? [`- ${sectionName(review.spec.id)}: ${review.draftIssues.length}건`, ...review.draftIssues.map((issue) => `  - ${issue}`)]
              : [`- ${sectionName(review.spec.id)}: 문제 없음`],
        )
      : ["아직 읽은 초안이 없다."]),
    ...(outputs.problems.length ? ["", "읽지 못했거나 버린 결과:", ...outputs.problems.map((problem) => `- ${problem}`)] : []),
    "",
    "운영에서는 검사에 걸린 장만 문제 목록을 붙여 Pass 1을 다시 요청한다. 이 도구는 다시 쓰기 요청을 만들지 않고, 비교를 위해 검사에 걸린 초안의 Pass 2 요청도 만든다.",
    "",
    "## 운영과 다른 점",
    "",
    "- 질문 정리: 모델 대신 사례에 고정한 가상 값을 쓴다 (위 머리말).",
    "- 기준일: 질문 정리와 9·10장 기간 재료 모두 위 기준일 하나로 고정한다.",
    "- 받는 방식: 운영은 Pass 1을 스트림으로 받아 닫힌 장마다 검사·저장한다. 플레이그라운드에서는 한 번에 받는다. 지시·입력·출력 형식은 같다.",
    "- 장면 요약(usedScenes): 운영은 앞 묶음 초안의 장면 요약을 넣는다. 이 도구는 이 폴더에 저장된 앞 묶음 초안만 넣는다 (진행 상황 표의 상태에 적는다).",
    "- 다시 쓰기: 운영은 검사에 걸린 장만 문제 목록과 함께 다시 요청한다(fixTheseProblemsFromPreviousAttempt). 이 도구는 그 요청을 만들지 않는다.",
    "",
  ];
  return `${lines.join("\n")}\n`;
}

// ─── 비교표 (llm:render) ─────────────────────────────────────────────────────

/** 명세 07 4절 무진 품질 평가 항목 (docs/personas/mujin-evaluation.md 1절). 평가 기록용이며 생성 지시에 넣지 않는다. */
export const MUJIN_QUALITY_ITEMS: readonly string[] = [
  "일반적인 존댓말 해설과 무진이 구별되는가",
  "첫 인사뿐 아니라 중간의 긴 장에도 성격이 남는가",
  "무엇을 먼저 짚고 어떤 차이를 설명하는지에 관찰력이 있는가",
  "약점의 조건과 손해, 조정 방향이 선명한가",
  "핵심 답과 설명의 깊이가 줄지 않았는가",
  "차·향·농담·반문이 반복되지 않는가",
  "무거운 고민에서도 고통을 희화화하지 않으면서 무진의 태도가 남는가",
  "새 사용자 사실이나 판단이 추가되지 않았는가",
  "Pass 1의 조건·날짜·수치·행동 제안이 유지되는가",
];

function issueCount(issues: readonly string[] | null): string {
  return issues === null ? "-" : `${issues.length}건`;
}

function sectionDetail(review: MujinSectionReview): string[] {
  const { spec, plan, draft, final } = review;
  const target = plan?.targetChars ?? spec.targetChars;
  const lines = [
    `## ${sectionName(spec.id)} (\`${spec.id}\`, ${tierLabel(spec.tier)}, 묶음 \`${review.batchId}\`)`,
    "",
    `편집 목표 ${range(target)}${plan ? ` (비중 ${plan.weight})` : ""} · 초안 ${chars(review.draftChars)} · 최종문 ${chars(review.finalChars)}. 글자 수는 참고값이며 실패 기준이 아니다.`,
    "",
  ];
  if (plan) {
    lines.push(`질문: ${plan.questions.map((question) => `${question.id} ${question.title} [${STATUS_LABEL[question.status] ?? question.status}]`).join(" / ") || "없음"}`, "");
  } else if (spec.kind === "closing") {
    lines.push("마지막 정리 계획이 없다 (유료 장 초안이 모두 있어야 만든다). 검사하지 않았다.", "");
  }

  lines.push("운영 검사:");
  if (!draft) lines.push("- 초안: 결과 없음");
  else if (review.draftIssues === null) lines.push("- 초안: 검사하지 않음 (계획 없음)");
  else if (!review.draftIssues.length) lines.push("- 초안: 문제 없음");
  else lines.push(`- 초안: ${review.draftIssues.length}건`, ...review.draftIssues.map((issue) => `  - ${issue}`));
  if (!final) lines.push("- 최종문: 결과 없음");
  else if (review.finalIssues === null) lines.push(`- 최종문: 검사하지 않음 (${draft ? "계획 없음" : "Pass 2 검사는 그 장의 초안이 있어야 한다"})`);
  else if (!review.finalIssues.length) lines.push("- 최종문: 문제 없음");
  else lines.push(`- 최종문: ${review.finalIssues.length}건`, ...review.finalIssues.map((issue) => `  - ${issue}`));
  lines.push("");

  if (!draft && !final) return [...lines, "아직 이 장의 결과가 없다.", ""];
  const draftBlocks = draft?.blocks ?? [];
  const finalBlocks = final?.blocks ?? [];
  lines.push(
    "블록은 순서대로 나란히 놓았다. 최종문이 블록을 합치거나 나누면 줄이 어긋나므로 내용으로 대조한다.",
    "",
    "| 칸 | 초안 (Pass 1) | 최종문 (Pass 2) |",
    "| --- | --- | --- |",
    `| 핵심 답 | ${draft ? cell(draft.coreAnswer) : "(없음)"} | ${final ? cell(final.coreAnswer) : "(없음)"} |`,
  );
  for (let index = 0; index < Math.max(draftBlocks.length, finalBlocks.length); index += 1) {
    lines.push(`| 블록 ${index + 1} | ${blockCell(draftBlocks[index])} | ${blockCell(finalBlocks[index])} |`);
  }
  lines.push("");
  if (draft?.scenes.length) lines.push(`초안의 장면 요약 (다음 묶음에 넘기는 메모, 화면에 보이지 않음): ${draft.scenes.join(" / ")}`, "");
  return lines;
}

/** 장마다 초안과 최종문을 나란히 놓은 비교 문서 (Markdown). */
export function renderMujinComparison(evaluation: MujinEvaluation, outputs: LoadedOutputs): string {
  const { entry } = evaluation;
  const reviews = reviewSections(evaluation, outputs);
  const lines = [
    `# 무진 초안·최종문 비교: ${entry.id} (사례 ${entry.number}, 기준일 ${evaluation.referenceDate})`,
    "",
    ...HEADER_NOTES(evaluation),
    "> 검사는 운영과 같은 장 단위 검사(checkDraftSection, checkVoiceSection)다. 검사 통과는 형식·근거·숫자 확인일 뿐 문체 품질 판정이 아니다. 품질은 docs/personas/mujin-evaluation.md 1절 항목으로 사람이 읽고 판단한다.",
    "> 글자 수는 공백을 넣고 강조 표시(**)를 뺀 값이다. 편집 목표는 최소 글자 수가 아니며 실패 기준이 아니다.",
    "",
    "## 사례",
    "",
    ...caseLines(evaluation),
    "",
    "## 질문 정리 (고정 가상 값)",
    "",
    ...questionLines(evaluation),
    "",
    "## 버전",
    "",
    ...versionLines(evaluation),
    "",
    "## 읽은 결과",
    "",
    ...(outputs.files.length
      ? outputs.files.map((file) => `- ${path.basename(file.file)} (Pass ${file.pass}): ${file.sections.length ? file.sections.join(", ") : "받은 장 없음"}`)
      : ["- 없음"]),
    ...(outputs.problems.length ? ["", "읽지 못했거나 버린 결과:", ...outputs.problems.map((problem) => `- ${problem}`)] : []),
    "",
    "## 한눈에 보기",
    "",
    "| 장 | 단계 | 편집 목표 | 초안 글자 | 최종문 글자 | 초안 검사 | 최종문 검사 |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...reviews.map(
      (review) =>
        `| ${cell(sectionName(review.spec.id))} | ${tierLabel(review.spec.tier)} | ${range(review.plan?.targetChars ?? review.spec.targetChars)} | ${chars(review.draftChars)} | ${chars(review.finalChars)} | ${issueCount(review.draftIssues)} | ${issueCount(review.finalIssues)} |`,
    ),
    "",
    ...reviews.flatMap(sectionDetail),
    "## 평가 기록 (docs/personas/mujin-evaluation.md 1절)",
    "",
    "최종문만 처음부터 이어 읽고 항목마다 예 / 부분 / 아니오와 근거 문단을 적는다. 5번과 9번은 위 표에서 같은 장의 초안과 최종문을 나란히 본다.",
    "",
    "| # | 항목 | 판정 | 근거 문단 | 메모 |",
    "| --- | --- | --- | --- | --- |",
    ...MUJIN_QUALITY_ITEMS.map((item, index) => `| ${index + 1} | ${item} |  |  |  |`),
    "",
  ];
  return `${lines.join("\n")}\n`;
}

// ─── 명령 (llm:export, llm:render) ───────────────────────────────────────────

function usage(script: "llm:export" | "llm:render"): string {
  const extra = script === "llm:export" ? "[--draft=<Pass 1 결과 파일·폴더, 쉼표로 여러 개>]" : "[--draft=<경로>] [--voice=<Pass 2 결과 파일·폴더>] [--out=<비교 문서 .md>]";
  return [
    `사용법: npm run ${script} '--' --product=${PRODUCT.id} --case=<${MUJIN_EVALUATION_CASES.map((entry) => entry.id).join("|")}> [--reference=YYYY-MM-DD (기본 ${MUJIN_DEFAULT_REFERENCE_DATE})] [--dir=<사례 폴더>] ${extra}`,
    `사례 폴더 기본값: ${MUJIN_PROMPTS_ROOT}/<기준일>_<사례> (git에 올리지 않음)`,
  ].join("\n");
}

interface CliContext {
  readonly evaluation: MujinEvaluation;
  readonly dir: string;
  readonly outputs: LoadedOutputs;
}

async function cliContext(script: "llm:export" | "llm:render", argv: readonly string[]): Promise<CliContext | null> {
  const caseId = readOption("case", argv);
  const entry = MUJIN_EVALUATION_CASES.find((item) => item.id === caseId);
  if (!entry) {
    console.log(usage(script));
    return null;
  }
  const referenceDate = readOption("reference", argv) ?? MUJIN_DEFAULT_REFERENCE_DATE;
  if (!isReferenceDate(referenceDate)) {
    console.log(`기준일은 YYYY-MM-DD 형식의 실제 날짜여야 합니다: ${referenceDate}`);
    return null;
  }
  const evaluation = await buildMujinEvaluation(entry, referenceDate);
  const dirOption = readOption("dir", argv);
  const dir = dirOption ? path.resolve(dirOption) : defaultCaseDir(entry, referenceDate);
  const outputs = loadCaseOutputs(evaluation, { dir, draft: readOption("draft", argv), voice: script === "llm:render" ? readOption("voice", argv) : undefined });
  return { evaluation, dir, outputs };
}

/** llm:export --product=mujin-overview. 모델을 부르지 않는다. */
export async function exportMujinCli(argv: readonly string[] = process.argv): Promise<void> {
  const context = await cliContext("llm:export", argv);
  if (!context) return;
  const { evaluation, dir, outputs } = context;
  const result = writeMujinExport(evaluation, outputs, dir);
  console.log(
    [
      `무진 모델 비교 파일: ${evaluation.entry.id} (기준일 ${evaluation.referenceDate}, 모델 호출 없음, 질문 정리는 고정 가상 값)`,
      `폴더: ${dir}`,
      `읽은 결과: Pass 1 초안 ${outputs.drafts.size}개, Pass 2 최종문 ${outputs.finals.size}개${outputs.problems.length ? `, 문제 ${outputs.problems.length}건 (00-guide.md 참고)` : ""}`,
      `이번에 쓴 파일 ${result.written.length}개. 지금 실행할 요청: ${result.ready.length ? result.ready.join(", ") : "없음"}`,
      `다음 할 일은 ${path.join(dir, "00-guide.md")}에 있다.`,
    ].join("\n"),
  );
}

/** llm:render --product=mujin-overview. 모델을 부르지 않는다. */
export async function renderMujinCli(argv: readonly string[] = process.argv): Promise<void> {
  const context = await cliContext("llm:render", argv);
  if (!context) return;
  const { evaluation, dir, outputs } = context;
  if (!outputs.drafts.size && !outputs.finals.size) {
    console.log(`읽을 결과가 없습니다. ${dir}에 p1-<묶음>.output.json, p2-<장>.output.json을 저장했는지 확인하세요.${outputs.problems.length ? `\n${outputs.problems.join("\n")}` : ""}`);
    return;
  }
  const report = renderMujinComparison(evaluation, outputs);
  const target = path.resolve(readOption("out", argv) ?? path.join(dir, "comparison.md"));
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, report);
  const reviews = reviewSections(evaluation, outputs);
  const total = (pick: (review: MujinSectionReview) => readonly string[] | null) => reviews.reduce((sum, review) => sum + (pick(review)?.length ?? 0), 0);
  console.log(
    [
      `무진 초안·최종문 비교: ${evaluation.entry.id} (기준일 ${evaluation.referenceDate}, 모델 호출 없음)`,
      `초안 ${outputs.drafts.size}개(검사 문제 ${total((review) => review.draftIssues)}건), 최종문 ${outputs.finals.size}개(검사 문제 ${total((review) => review.finalIssues)}건)${outputs.problems.length ? `, 읽기 문제 ${outputs.problems.length}건` : ""}`,
      `저장: ${target}`,
      "검사 통과는 형식·근거 확인일 뿐 문체 품질 판정이 아니다. docs/personas/mujin-evaluation.md 1절 항목으로 읽고 판단한다.",
    ].join("\n"),
  );
}
