import type { AssessmentFacet, InquiryConclusion, InquiryEvidence, InquiryReader } from "sajuengine";
import type { Persona } from "../personas";
import type { ScrollProductDefinition, ScrollSectionSpec } from "../products/types";
import { loreFor, patternLore, strengthLore } from "../reading/lore";
import { toStatement, traceOf } from "../reading/plan";
import type { ChartView, TopicTrace } from "../reading/types";
import { RULESET_ID, RULESET_VERSION, detailKey, type RuleDetail, type RuleDetailSink } from "../rules/common";
import { ELEMENTS, type Element } from "../rules/life-tables";
import { FAMILIES, FAMILY_LABEL, FAMILY_MEANING, STRENGTH_LABEL, rankFamilies, withJosa, type Family } from "../rules/materials";
import {
  ENGINE_PATTERN_LABEL,
  ENGINE_STRENGTH_LABEL,
  buildElementMaterials,
  buildSharedFacts,
  buildStageMaterials,
  buildTenGodMaterials,
  monthMainPattern,
} from "./basics";
import type { DraftMaterial } from "./draft";
import {
  ASKED_DOMAINS,
  BASICS_CAUTIONS,
  EXCLUDED_COMPARE_CRITERIA,
  JUDGMENT_ROUTES,
  MIXED_CAVEAT,
  MUJIN_RULESET,
  NATAL_SECTION_IDS,
  NEUTRAL_COMPARE_OPTIONS,
  NEUTRAL_COMPARE_TEXT,
  NEUTRAL_OVERRIDES,
  SAME_CAUSE_FAMILY,
  SECOND_FAMILY_JUDGMENTS,
  SPLIT_CAVEAT,
  TOP_FAMILY_JUDGMENTS,
  isExcluded,
  linkSpec,
  neutralIndustryText,
  questionGuide,
  type JudgmentRoute,
  type LinkSpec,
} from "./natal-links";
import type { MujinNow } from "./now";
import { buildNowFacts, buildSituationNotes } from "./now-context";
import { OPPOSING_TAGS, TAG_CATALOG_VERSION, addressesFor, tagOrder, tagsFor, variantParts } from "./tags";
import {
  MUJIN_PLAN_VERSION,
  type MaterialEvidence,
  type MujinMaterial,
  type MujinPlan,
  type MujinQuestionPlan,
  type MujinSectionPlan,
  type MujinTables,
  type QuestionStatus,
  type SectionWeight,
} from "./types";

/**
 * 무진 원국 작성 계획 (기초 분석 P02~P05, 1장~8장). 결제 전에 저장하고, 무료·유료 생성과 재시도·재열람이 같은 계획을 쓴다.
 * 9·10장과 마지막 정리는 유료 생성 때 기간 재료로 더한다. 원국표(chart)는 글이 없어 섹션 계획에 없다.
 *
 * - 판단(judgment): reader에 등록된 첫 상품 규칙(first-overview 3.1.0)의 결론을 결론 key 기준으로 질문에 배분한다.
 *   명세가 제외한 연결(강약→체력·회복·수입 변동 감당, 가족사 짐작, 용신으로 사람 판정)은 빼거나 무진용 중립 문장으로 바꾼다.
 * - 계산 사실(engine-fact): 표·원국·엔진 판단의 계산값. 이름은 엔진 표기(편관격·월겁격, 신강·신약)를 따른다.
 * - 연결(derived): 채택(candidate)된 판단의 의미 태그에서 이은 설명. parentRefs로 부모 판단을 가리키며 새 계산 근거가 아니다.
 * - 일반 점검(general): 판단이 없을 때. 사주 판단이 아니라고 밝힌다.
 * - 사용자 사실(user-fact): '지금의 나'에서 고른 항목 (nowFacts). 원국 재료는 '지금의 나'에 따라 바뀌지 않는다.
 * 규칙과 연결표: docs/rules/mujin-overview.md. 모두 unreviewed다.
 */

const STRENGTH_RULE = "m01.assessment.strength";
const APP_PREFIX = `${RULESET_ID}.`;

interface JudgmentEntry {
  readonly key: string;
  readonly ruleId: string;
  readonly conclusionKey: string;
  readonly route: JudgmentRoute;
  readonly routeIndex: number;
  readonly conclusion: InquiryConclusion;
  readonly detail: RuleDetail | undefined;
  readonly tags: readonly string[];
  /** 조건·한계가 큰 판단 (비교, 예외 메모, 1·2위 동률, 검토 표지가 아닌 반대 근거). */
  readonly big: boolean;
  readonly draft: DraftMaterial;
}

const conclusionKeyOf = (conclusion: InquiryConclusion) => conclusion.id.split(":").slice(2).join(":");
const isElement = (value: unknown): value is Element => typeof value === "string" && (ELEMENTS as readonly string[]).includes(value);
const ids = (entries: readonly InquiryEvidence[]) => entries.map((entry) => entry.id);

function familyPercentsOf(assessment: AssessmentFacet | null): Readonly<Record<Family, number>> | null {
  const percent = assessment?.familyPercent as Readonly<Record<Family, number>> | undefined;
  return percent && FAMILIES.every((family) => typeof percent[family] === "number") ? percent : null;
}

/** 같은 값이면 여럿. rankFamilies와 같은 순서(비율, 같으면 이름순). */
function tiedAt(percents: Readonly<Record<Family, number>>, rank: number): Family[] {
  const ranked = rankFamilies(percents);
  const value = percents[ranked[rank]!];
  return ranked.filter((family) => percents[family] === value);
}

const CHARM_LABEL: Readonly<Record<string, string>> = { hamji: "도화(함지)", hongyeom: "홍염" };

/** 무진 재료의 근거 문장. 엔진 표기와 한국어 이름으로 바꾼다 (구조화된 값에서 다시 만든다, 문장 치환이 아니다). */
function mujinBasis(ruleId: string, key: string, variant: string | undefined, basis: readonly string[], assessment: AssessmentFacet | null): readonly string[] {
  if (ruleId === "first-overview.strengths" && key === "ability" && variant) {
    return [`격국이 ${ENGINE_PATTERN_LABEL[variant] ?? variant}으로 계산됨`];
  }
  if (ruleId === "first-overview.social" && key === "boundary" && variant !== "recharge" && assessment?.strength && basis[0]?.startsWith("일간의 힘 ")) {
    const strength = assessment.strength;
    return [`일간의 힘 ${ENGINE_STRENGTH_LABEL[strength] ?? strength}(${STRENGTH_LABEL[strength] ?? strength})`, ...basis.slice(1)];
  }
  if (ruleId === "first-overview.romance" && key === "attraction") {
    const charm = variantParts(variant).filter((part) => part.startsWith("charm:")).map((part) => part.slice("charm:".length));
    return [...basis.slice(0, 1), ...charm.map((id) => `원국에 ${CHARM_LABEL[id] ?? id} 신살 표지`)];
  }
  return basis;
}

interface Context {
  readonly sink: RuleDetailSink;
  readonly chart: ChartView;
  readonly assessment: AssessmentFacet | null;
  readonly percents: Readonly<Record<Family, number>> | null;
  /**
   * 무진 재료에서 빼는 명리 설명 줄.
   * - 월지 본기로 정한 격국이 아니면 '월지 본기 십성' 줄(patternLore)이 엔진 격국과 어긋난다.
   * - 일간의 힘 줄(strengthLore)의 %는 일간을 포함한 오행 비율의 합이라 엔진 강약 비율과 다른 숫자다.
   *   무진은 강약을 엔진 표기(신강·신약)로만 말한다 (P02).
   */
  readonly hiddenLore: ReadonlySet<string>;
}

function judgmentEntry(conclusion: InquiryConclusion, route: JudgmentRoute, routeIndex: number, context: Context): JudgmentEntry {
  const { sink, chart, assessment, percents } = context;
  const ruleId = conclusion.rule.ruleId;
  const key = conclusionKeyOf(conclusion);
  const detail = sink.get(detailKey(ruleId, conclusion.periodId, conclusion.statement));
  const variant = detail?.variant;
  const base = toStatement(`judgment:${conclusion.id}`, conclusion, sink, { chart, assessment });
  const override = NEUTRAL_OVERRIDES[`${ruleId}|${key}|${variant ?? ""}`];

  let text = override?.text ?? base.text;
  const weakness = override?.weakness ?? base.weakness;
  const action = override?.action ?? base.action;
  let basis = mujinBasis(ruleId, key, variant, base.basis ?? [], assessment);
  let compare = base.compare;
  let lore = (base.lore ?? []).filter((line) => !context.hiddenLore.has(line));
  let supporting = conclusion.supportingEvidence;
  let counter = conclusion.counterEvidence;
  const caveats = [...base.caveats];
  let big = Boolean(base.counterNote) || counter.some((entry) => entry.disposition !== "review-required");

  if (ruleId === "first-overview.jobs" && key === "industry" && isElement(variant)) text = neutralIndustryText(variant);

  if (ruleId === "first-overview.career" && key === "path-compare") {
    // 강약으로 수입 변동을 견딜 능력을 판정하는 기준('안정성과 변동성')과 그 근거(강약 판단)를 무진 비교에서 뺀다 (3-3).
    const excluded: readonly string[] = EXCLUDED_COMPARE_CRITERIA;
    text = NEUTRAL_COMPARE_TEXT;
    compare = base.compare
      ? { options: NEUTRAL_COMPARE_OPTIONS, criteria: base.compare.criteria.filter((item) => !excluded.includes(item.name)), needs: base.compare.needs }
      : undefined;
    basis = basis.filter((line) => !excluded.some((name) => line.startsWith(`${name}:`)));
    supporting = supporting.filter((entry) => entry.ruleId !== STRENGTH_RULE);
    counter = counter.filter((entry) => entry.ruleId !== STRENGTH_RULE);
    lore = loreFor(supporting, basis, { chart, assessment }).filter((line) => !context.hiddenLore.has(line));
    caveats.push("강약으로 수입 변동을 견딜 능력을 판정하지 않는다.", "자금·경력·고객 같은 현실 조건은 사용자가 알려 준 정보가 있을 때만 쓴다.");
    big = true;
  }

  const pair = `${ruleId}|${key}`;
  if (percents && TOP_FAMILY_JUDGMENTS.includes(pair) && variant !== "balanced") {
    const tied = tiedAt(percents, 0);
    if (tied.length > 1) {
      caveats.push(
        `가장 큰 계열인 ${withJosa(tied.map((family) => FAMILY_LABEL[family]).join("·"), "이/가")} 같은 비율(${percents[tied[0]!]}%)이라, 한 계열만의 성향으로 단정하지 않고 함께 고려해 경향으로 전한다.`,
      );
      big = true;
    }
  }
  if (percents && SECOND_FAMILY_JUDGMENTS.includes(pair)) {
    const tied = tiedAt(percents, 1);
    if (tied.length > 1) {
      caveats.push(
        `두 번째로 큰 계열인 ${withJosa(tied.map((family) => FAMILY_LABEL[family]).join("·"), "이/가")} 같은 비율(${percents[tied[0]!]}%)이라, 보조 조합을 한쪽으로 단정하지 않는다.`,
      );
      big = true;
    }
  }
  if (compare) big = true;

  // 의미 태그는 채택(candidate)된 판단에만 붙인다. 태그표에 없는 변형은 태그가 없다.
  const tags = conclusion.status === "candidate" ? tagsFor(ruleId, key, variant) : [];
  const evidence: MaterialEvidence = { supporting: ids(supporting), counter: ids(counter), contextual: ids(conclusion.contextualEvidence) };
  const draft: DraftMaterial = {
    key: `judgment:${conclusion.id}`,
    kind: "judgment",
    questionIds: route.questionIds,
    text,
    scope: "natal",
    status: conclusion.status,
    ruleId,
    ruleVersion: conclusion.rule.version,
    conclusionId: conclusion.id,
    ...(variant ? { variant } : {}),
    ...(base.aspect ? { aspect: base.aspect } : {}),
    ...(basis.length ? { basis } : {}),
    ...(base.upside ? { upside: base.upside } : {}),
    ...(weakness ? { weakness } : {}),
    ...(action ? { action } : {}),
    ...(base.counterNote ? { counterNote: base.counterNote } : {}),
    ...(compare ? { compare } : {}),
    ...(lore.length ? { lore } : {}),
    caveats,
    ...(tags.length ? { tags } : {}),
    evidence,
  };
  return { key: draft.key, ruleId, conclusionKey: key, route, routeIndex, conclusion, detail, tags, big, draft };
}

/** P05의 중심·보조 계열. 1장 판단과 같은 결론(conclusionId·상태·근거)을 구조 설명으로만 쓴다. 약점·행동 제안은 1장에만 둔다. */
function structureCopies(entries: readonly JudgmentEntry[], percents: Readonly<Record<Family, number>> | null): DraftMaterial[] {
  const out: DraftMaterial[] = [];
  const core = entries.find((entry) => entry.ruleId === "first-overview.temperament" && entry.conclusionKey === "core");
  const mix = entries.find((entry) => entry.ruleId === "first-overview.temperament" && entry.conclusionKey === "mix");
  if (!percents) return out;
  const copy = (entry: JudgmentEntry, key: string, aspect: string, text: string): DraftMaterial => ({
    key,
    kind: "judgment",
    questionIds: ["P05"],
    text,
    scope: "natal",
    status: entry.conclusion.status,
    ruleId: entry.ruleId,
    ruleVersion: entry.conclusion.rule.version,
    conclusionId: entry.conclusion.id,
    ...(entry.draft.variant ? { variant: entry.draft.variant } : {}),
    aspect,
    ...(entry.draft.basis ? { basis: entry.draft.basis } : {}),
    caveats: entry.draft.caveats ?? [],
    ...(entry.draft.evidence ? { evidence: entry.draft.evidence } : {}),
  });
  const variant = core?.draft.variant;
  const first = rankFamilies(percents)[0]!;
  if (core && variant && (FAMILIES as readonly string[]).includes(variant)) {
    const family = variant as Family;
    out.push(
      copy(
        core,
        "basics:center",
        "중심 계열",
        `십성 다섯 계열 가운데 ${withJosa(`${FAMILY_LABEL[family]}(${FAMILY_MEANING[family]})`, "이/가")} ${percents[family]}%로 가장 커서 중심 계열로 읽어요. 25% 이상인 계열을 중심으로 보는 기준이에요.`,
      ),
    );
  } else if (core && variant === "balanced") {
    out.push(
      copy(
        core,
        "basics:center",
        "중심 계열",
        `가장 큰 계열도 ${FAMILY_LABEL[first]} ${percents[first]}%로 25%에 이르지 않아, 한 계열이 중심을 잡기보다 여러 계열이 고르게 섞인 구조로 읽어요.`,
      ),
    );
  }
  // 보조 계열은 조합(변형 "a|b") 가운데 1위가 아닌 쪽이다. 1위가 25%에 못 미쳐 균형으로 읽힌 원국도 조합은 있을 수 있다.
  const pair = mix?.draft.variant?.split("|") ?? [];
  const second = pair.find((family) => family !== first) as Family | undefined;
  if (mix && second && (FAMILIES as readonly string[]).includes(second)) {
    out.push(
      copy(
        mix,
        "basics:second",
        "보조 계열",
        `두 번째로 큰 ${withJosa(`${FAMILY_LABEL[second]}(${FAMILY_MEANING[second]})`, "이/가")} ${percents[second]}%로 18% 이상이라, 중심 계열과 함께 나타나는 보조 성향으로 읽어요.`,
      ),
    );
  }
  return out;
}

/** 한 질문에 같은 원인(같은 계열 비중)의 판단이 둘 이상이면 뒤의 판단에 근거를 한 번만 설명하라는 한계를 붙인다. */
function markSameCause(entries: readonly JudgmentEntry[]): JudgmentEntry[] {
  const notes = new Map<string, string>();
  const seen = new Map<string, Set<string>>();
  for (const entry of entries) {
    const family = SAME_CAUSE_FAMILY[`${entry.ruleId}|${entry.conclusionKey}`]?.(entry.detail?.variant);
    if (!family || !(FAMILIES as readonly string[]).includes(family)) continue;
    for (const questionId of entry.route.questionIds) {
      const causes = seen.get(questionId) ?? new Set<string>();
      if (causes.has(family)) {
        notes.set(entry.key, `같은 질문의 앞 판단과 같은 원인(${FAMILY_LABEL[family as Family]} 비중)에서 나온 판단이라, 근거는 한 번만 설명하고 겹치는 내용은 합쳐 쓴다.`);
      }
      causes.add(family);
      seen.set(questionId, causes);
    }
  }
  return entries.map((entry) => {
    const note = notes.get(entry.key);
    return note ? { ...entry, draft: { ...entry.draft, caveats: [...(entry.draft.caveats ?? []), note] } } : entry;
  });
}

interface LinkEntry {
  tags: string[];
  parents: JudgmentEntry[];
  text: string;
  caveats: string[];
}

/** 신규 연결 질문의 derived 재료. 같은 원인(태그)은 한 재료로 합치고, 상반된 경향은 같은 판단이면 혼합, 다른 판단이면 조건별로 둔다. */
function deriveFor(spec: LinkSpec, adopted: readonly JudgmentEntry[], chosen: Map<string, readonly string[]>): DraftMaterial[] {
  const allowed = spec.fromQuestions ? new Set(spec.fromQuestions.flatMap((id) => chosen.get(id) ?? [])) : null;
  const pool = adopted.filter((entry) => !spec.sources || spec.sources.includes(entry.ruleId));
  const usable = (tag: string) => (!allowed || allowed.has(tag)) && pool.some((entry) => entry.tags.includes(tag));
  const parentsOf = (tags: readonly string[]) => pool.filter((entry) => entry.tags.some((tag) => tags.includes(tag)));

  let entries: LinkEntry[];
  if (spec.links) {
    const links = spec.links;
    entries = Object.keys(links)
      .filter(usable)
      .sort((a, b) => tagOrder(a) - tagOrder(b))
      .map((tag) => ({ tags: [tag], parents: parentsOf([tag]), text: links[tag]!, caveats: [] }));
    for (const [a, b] of OPPOSING_TAGS) {
      const first = entries.find((entry) => entry.tags[0] === a);
      const second = entries.find((entry) => entry.tags[0] === b);
      if (!first || !second) continue;
      if (first.parents.some((parent) => second.parents.includes(parent))) {
        first.tags = [a, b];
        first.parents = pool.filter((entry) => first.parents.includes(entry) || second.parents.includes(entry));
        first.text = `${first.text} / ${second.text}`;
        first.caveats.push(MIXED_CAVEAT);
        entries = entries.filter((entry) => entry !== second);
      } else {
        first.caveats.push(SPLIT_CAVEAT);
        second.caveats.push(SPLIT_CAVEAT);
      }
    }
  } else {
    entries = (spec.groups ?? [])
      .map((group) => {
        const tags = group.tags.filter(usable).sort((a, b) => tagOrder(a) - tagOrder(b));
        return { tags, parents: parentsOf(tags), text: group.text, caveats: [] as string[] };
      })
      .filter((entry) => entry.tags.length > 0);
  }
  entries = entries.slice(0, spec.max);
  chosen.set(spec.questionId, entries.flatMap((entry) => entry.tags));
  return entries.map((entry) => ({
    key: `derived:${spec.questionId}:${entry.tags.join("+")}`,
    kind: "derived",
    questionIds: [spec.questionId],
    text: entry.text,
    scope: "natal",
    caveats: [...spec.caveats, ...entry.caveats],
    tags: entry.tags,
    parentKeys: entry.parents.map((parent) => parent.key),
  }));
}

const STATUS_NOTE: Readonly<Record<QuestionStatus, string | null>> = {
  adopted: null,
  conditional: "판단은 있으나 조건과 한계를 함께 말한다.",
  deferred: "판단을 보류한 상태다(시각 미상이나 기준값 근처). 결론으로 확정하지 않고 보류한 이유를 짧게 말한다.",
  general: "이 질문에 이을 채택 판단이 없다. 일반 점검으로만 짧게 다루고 사주 판단처럼 말하지 않는다.",
  unavailable: "계산 자료가 없어 이 질문은 판단하지 않는다. 무엇을 알 수 없는지만 짧게 말한다.",
};

const GENERAL_CAVEAT = "사주 판단이 아닌 일반 점검이다.";
const PARTIAL_NOTE = "태어난 시간을 몰라 시주를 뺀 범위의 판단이다.";
const round50 = (value: number) => Math.round(value / 50) * 50;

function targetFor(spec: ScrollSectionSpec, weight: SectionWeight): { readonly min: number; readonly max: number } {
  if (weight === "standard") return spec.targetChars;
  return { min: round50(spec.targetChars.min * 1.2), max: round50(spec.targetChars.max * 1.25) };
}

/** 같은 행동 문장(action, weakness.change)은 목차 순서에서 처음 나온 재료에만 남긴다. 지운 weakness.change는 빈 문자열이다. */
function dedupeActions(drafts: readonly DraftMaterial[]): DraftMaterial[] {
  const seen = new Set<string>();
  const firstTime = (text: string | undefined) => {
    const key = text?.trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  };
  return drafts.map((draft) => {
    let next: DraftMaterial = draft;
    if (draft.action !== undefined && !firstTime(draft.action)) {
      const { action: _removed, ...rest } = next;
      void _removed;
      next = rest;
    }
    if (draft.weakness && !firstTime(draft.weakness.change)) next = { ...next, weakness: { ...draft.weakness, change: "" } };
    return next;
  });
}

export function buildMujinPlan(input: {
  readonly reader: InquiryReader;
  readonly sink: RuleDetailSink;
  readonly product: ScrollProductDefinition;
  readonly persona: Persona;
  readonly chart: ChartView;
  readonly assessment: AssessmentFacet | null;
  readonly tables: MujinTables;
  readonly nickname: string;
  readonly gender: "male" | "female";
  readonly now: MujinNow;
}): { readonly plan: MujinPlan; readonly trace: readonly TopicTrace[] } {
  const { reader, sink, product, persona, chart, assessment, tables, nickname, gender, now } = input;
  const percents = familyPercentsOf(assessment);
  const partial = !chart.hourKnown || (assessment?.coverage !== undefined && assessment.coverage !== "complete");
  const patternLine = patternLore(chart);
  const strengthLine = strengthLore(chart);
  const context: Context = {
    sink,
    chart,
    assessment,
    percents,
    hiddenLore: new Set(
      [patternLine && assessment?.pattern && monthMainPattern(chart) !== assessment.pattern ? patternLine : null, strengthLine].filter(
        (line): line is string => Boolean(line),
      ),
    ),
  };

  // 1. 원국 질문. 분야마다 한 번씩 받는다 (family·place는 무진 질문에 쓰지 않아 묻지 않는다).
  const answers = ASKED_DOMAINS.map((domain) => ({ domain, answer: reader.answer({ domain, kind: "natal", context: { gender } }) }));

  // 2. 판단 재료. 앱 규칙 결론만 쓰고, 제외한 연결은 거른다.
  let judgments: JudgmentEntry[] = [];
  for (const { answer } of answers) {
    for (const conclusion of answer.conclusions) {
      const ruleId = conclusion.rule.ruleId;
      if (!ruleId.startsWith(APP_PREFIX) || conclusion.periodId !== null) continue;
      const key = conclusionKeyOf(conclusion);
      if (isExcluded(ruleId, key)) continue;
      const routeIndex = JUDGMENT_ROUTES.findIndex((route) => route.ruleId === ruleId && route.key === key);
      if (routeIndex < 0) continue;
      judgments.push(judgmentEntry(conclusion, JUDGMENT_ROUTES[routeIndex]!, routeIndex, context));
    }
  }
  // 2-4: 가장 약한 계열의 보완 행동은 채택된 능력의 경향과 관련될 때만 보조로 쓴다.
  const ability = judgments.find((entry) => entry.ruleId === "first-overview.strengths" && entry.conclusionKey === "ability");
  const scarce = judgments.find((entry) => entry.ruleId === "first-overview.strengths" && entry.conclusionKey === "action");
  if (scarce) {
    const abilityTags = ability?.conclusion.status === "candidate" ? tagsFor(ability.ruleId, "ability", ability.detail?.variant) : [];
    const addresses = addressesFor(scarce.ruleId, "action", scarce.detail?.variant);
    if (!addresses.some((tag) => abilityTags.includes(tag))) judgments = judgments.filter((entry) => entry !== scarce);
  }

  const sectionSpecs = NATAL_SECTION_IDS.map((id) => product.scroll.sections.find((section) => section.id === id)).filter(
    (section): section is ScrollSectionSpec => Boolean(section),
  );
  const sectionOf = new Map<string, string>(sectionSpecs.flatMap((section) => section.questions.map((question) => [question.id, section.id] as const)));
  const sectionIndex = (id: string) => sectionSpecs.findIndex((section) => section.id === id);
  const questionIndex = (questionId: string) => {
    const section = sectionSpecs.find((item) => item.id === sectionOf.get(questionId));
    return section ? section.questions.findIndex((question) => question.id === questionId) : -1;
  };
  judgments = judgments
    .filter((entry) => sectionOf.has(entry.route.questionIds[0]!))
    .sort(
      (a, b) =>
        sectionIndex(sectionOf.get(a.route.questionIds[0]!)!) - sectionIndex(sectionOf.get(b.route.questionIds[0]!)!) ||
        questionIndex(a.route.questionIds[0]!) - questionIndex(b.route.questionIds[0]!) ||
        a.routeIndex - b.routeIndex ||
        a.ruleId.localeCompare(b.ruleId),
    );
  judgments = markSameCause(judgments);
  const adopted = judgments.filter((entry) => entry.conclusion.status === "candidate" && entry.tags.length > 0);

  // 3. 계산 사실과 섹션 재료를 목차 순서로 모은다.
  const facts = buildSharedFacts(chart, assessment, tables);
  const chosen = new Map<string, readonly string[]>();
  const sectionDrafts = new Map<string, DraftMaterial[]>();
  const generalFor = new Set<string>();
  const deferredByGuard = new Set<string>();
  const unseenWealth =
    partial &&
    ((assessment?.observedMissingFamilies as readonly string[] | undefined) ?? []).includes("wealth") &&
    !((assessment?.missingFamilies as readonly string[] | undefined) ?? []).includes("wealth");

  for (const section of sectionSpecs) {
    const drafts: DraftMaterial[] = [];
    if (section.id === "basics-elements") drafts.push(...buildElementMaterials(chart, tables));
    if (section.id === "basics-stages") drafts.push(...buildStageMaterials(chart, tables));
    if (section.id === "basics-ten-gods") drafts.push(...buildTenGodMaterials(chart, assessment, tables), ...structureCopies(judgments, percents));
    if (section.kind === "chapter") {
      for (const question of section.questions) {
        const own = judgments.filter((entry) => entry.route.questionIds[0] === question.id).map((entry) => entry.draft);
        const spec = linkSpec(question.id);
        const derived = spec ? deriveFor(spec, adopted, chosen) : [];
        drafts.push(...own, ...derived);
        const served = judgments.some((entry) => entry.route.questionIds.includes(question.id)) || derived.length > 0;
        if (question.id === "4-1" && !served && unseenWealth) deferredByGuard.add(question.id);
        if (!served && (deferredByGuard.has(question.id) || !dataMissing(question.id))) {
          const guide = questionGuide(question.id);
          if (guide) {
            drafts.push({ key: `general:${question.id}`, kind: "general", questionIds: [question.id], text: guide.general, scope: "natal", caveats: [GENERAL_CAVEAT] });
            generalFor.add(question.id);
          }
        }
      }
    }
    sectionDrafts.set(section.id, drafts);
  }

  function dataMissing(questionId: string): boolean {
    return (questionGuide(questionId)?.needs ?? []).some((need) =>
      need === "families" ? !percents : need === "strength" ? !assessment?.strength : !assessment?.pattern,
    );
  }

  // 4. 같은 행동 문장은 처음 나온 재료에만 남기고, 목차 순서로 ref를 붙인다 (사실 → 섹션 → 지금의 나).
  const ordered = dedupeActions([...facts, ...sectionSpecs.flatMap((section) => sectionDrafts.get(section.id) ?? [])]);
  const nowDrafts = buildNowFacts(now, product);
  const refOf = new Map<string, string>();
  [...ordered, ...nowDrafts].forEach((draft, index) => refOf.set(draft.key, `m${index + 1}`));
  const toMaterial = (draft: DraftMaterial): MujinMaterial => {
    const { key, parentKeys, ...rest } = draft;
    return {
      ref: refOf.get(key)!,
      ...rest,
      ...(parentKeys ? { parentRefs: parentKeys.map((parent) => refOf.get(parent)!).filter(Boolean) } : {}),
    };
  };
  const byKey = new Map(ordered.map((draft) => [draft.key, toMaterial(draft)] as const));
  const factMaterials = facts.map((draft) => byKey.get(draft.key)!);
  const hourFactRef = refOf.get("fact:hour-unknown") ?? null;
  const notes = buildSituationNotes(now);

  // 5. 섹션과 질문 계획.
  const sections: MujinSectionPlan[] = sectionSpecs.map((section) => {
    const materials = (sectionDrafts.get(section.id) ?? []).map((draft) => byKey.get(draft.key)!);
    const questions: MujinQuestionPlan[] = section.questions.map((question) => {
      const refs = [...factMaterials, ...materials].filter((material) => material.questionIds.includes(question.id)).map((material) => material.ref);
      const own = materials.filter((material) => material.questionIds.includes(question.id));
      const status = statusOf(section, question.id, own, factMaterials);
      return { id: question.id, title: question.title, status, refs, note: noteOf(section, question.id, status, own) };
    });
    const weight: SectionWeight = (now.interests as readonly string[]).includes(section.id) ? "interest" : "standard";
    return {
      sectionId: section.id,
      tier: section.tier,
      title: section.title,
      questions,
      materials,
      weight,
      targetChars: targetFor(section, weight),
      situationNotes: notes.get(section.id) ?? [],
    };
  });

  function statusOf(section: ScrollSectionSpec, questionId: string, own: readonly MujinMaterial[], shared: readonly MujinMaterial[]): QuestionStatus {
    if (section.kind === "basics") {
      // 시각 미상 안내 사실만 있으면 계산 자료가 없는 것이다.
      const content = [...shared.filter((fact) => fact.questionIds.includes(questionId) && fact.ref !== hourFactRef), ...own];
      if (!content.length) return "unavailable";
      return partial ? "conditional" : "adopted";
    }
    const judged = own.filter((material) => material.kind === "judgment");
    const derived = own.filter((material) => material.kind === "derived");
    if (!judged.length && !derived.length) {
      if (deferredByGuard.has(questionId)) return "deferred";
      return generalFor.has(questionId) ? "general" : "unavailable";
    }
    const candidates = judged.filter((material) => material.status === "candidate");
    const bigOf = (material: MujinMaterial) => judgments.find((entry) => entry.key === `judgment:${material.conclusionId}`)?.big ?? false;
    if (own.some((material) => material.compare)) return "conditional";
    if (candidates.length) return partial || candidates.every(bigOf) ? "conditional" : "adopted";
    if (derived.length) return partial ? "conditional" : "adopted";
    return "deferred";
  }

  function noteOf(section: ScrollSectionSpec, questionId: string, status: QuestionStatus, own: readonly MujinMaterial[]): string | null {
    const parts: (string | null)[] = [STATUS_NOTE[status]];
    if (status === "conditional" && partial) parts.push(PARTIAL_NOTE);
    if (deferredByGuard.has(questionId)) parts.push("시주를 몰라 재성이 보이지 않는 것일 수 있어 돈을 바라보는 방식의 첫 분기('돈보다 의미')를 보류했다.");
    if (questionId === "P05" && own.some((material) => material.aspect === "중심 계열") && !own.some((material) => material.aspect === "보조 계열")) {
      parts.push("두 번째 계열이 기준(18%)에 이르지 않거나 조합 판단이 없어 보조 조합은 따로 세우지 않는다.");
    }
    parts.push(...(section.kind === "basics" ? (BASICS_CAUTIONS[questionId] ?? []) : (questionGuide(questionId)?.cautions ?? [])));
    const note = parts.filter((part): part is string => Boolean(part)).join(" ");
    return note || null;
  }

  const adoptedIds = new Set(judgments.map((entry) => entry.conclusion.id));
  const trace = answers.map(({ domain, answer }) => traceOf(domain, domain, answer, adoptedIds));

  return {
    plan: {
      planVersion: MUJIN_PLAN_VERSION,
      productId: product.id,
      productVersion: product.version,
      personaId: persona.id,
      personaVersion: persona.version,
      rulesets: [
        { id: RULESET_ID, version: RULESET_VERSION, reviewStatus: "unreviewed" },
        { id: MUJIN_RULESET.id, version: MUJIN_RULESET.version, reviewStatus: MUJIN_RULESET.reviewStatus },
      ],
      tagCatalogVersion: TAG_CATALOG_VERSION,
      nickname,
      gender,
      hourKnown: chart.hourKnown,
      coverageNotes: chart.hourKnown
        ? []
        : ["태어난 시간을 몰라 시주를 뺀 범위에서 읽었습니다. 시주에 있을 수 있는 글자·십성·12운성·신살은 보지 못했고, 보이지 않는 것을 없다고 확정하지 않습니다."],
      now,
      nowFacts: nowDrafts.map(toMaterial),
      facts: factMaterials,
      tables,
      sections,
    },
    trace,
  };
}
