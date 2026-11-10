import type { AssessmentFacet, InquiryConclusion, InquiryReader } from "sajuengine";
import type { Persona } from "../personas";
import type { ProductDefinition, ProductTopic } from "../products/types";
import { RULESET_ID, RULESET_VERSION, detailKey, familyLabel, type RuleDetailSink } from "../rules/first-overview";
import { PATTERN_LABEL, STRENGTH_LABEL, withJosa } from "../rules/materials";
import { ELEMENT_HANJA } from "./chart";
import { DAY_MASTER_IMAGE, elementCountLore, loreFor, type LoreContext } from "./lore";
import type {
  ChartElement,
  ChartView,
  FactStatement,
  InterpretationStatement,
  ReadingPlanV2,
  ReadingPreview,
  TopicPlanStatus,
  TopicPlanV2,
  TopicTrace,
  TopicWeight,
  UserContextStatement,
} from "./types";

export const PLAN_VERSION = "2.0.0";

function buildFacts(chart: ChartView, assessment: AssessmentFacet | null): FactStatement[] {
  const facts: FactStatement[] = [];
  const add = (text: string, originPath: string) => facts.push({ ref: `f${facts.length + 1}`, kind: "engine-fact", text, originPath });

  if (chart.dayMaster) {
    const { ko, hanja, element } = chart.dayMaster;
    add(`일간은 ${ko}(${hanja})이고 오행으로는 ${element}(${ELEMENT_HANJA[element]})입니다.`, "core.document.facts.positions.day.stem");
    if (DAY_MASTER_IMAGE[ko]) {
      const name = withJosa(`일간 ${ko}${element}(${hanja}${ELEMENT_HANJA[element]})`, "은/는");
      add(`${name} 전통적으로 ${DAY_MASTER_IMAGE[ko]}에 빗댑니다.`, "core.document.facts.positions.day.stem");
    }
  }
  const counts = elementCountLore(chart);
  if (counts) add(counts, "core.document.facts.positions");
  if (assessment?.strength) {
    add(`일간의 힘은 ${STRENGTH_LABEL[assessment.strength] ?? assessment.strength}으로 계산되었습니다.`, "facets.assessment.strength");
  }
  if (assessment?.pattern) {
    add(`격국은 ${PATTERN_LABEL[assessment.pattern] ?? assessment.pattern}입니다.`, "facets.assessment.pattern");
  }
  if (assessment?.dominantFamily && assessment.familyPercent) {
    const percents = assessment.familyPercent as Readonly<Record<string, number>>;
    add(
      `십성 계열 중 ${familyLabel(assessment.dominantFamily)}이 ${percents[assessment.dominantFamily]}%로 가장 큽니다.`,
      "facets.assessment.familyPercent",
    );
  }
  if (assessment?.dominantElement && assessment.elementPercent) {
    const percents = assessment.elementPercent as Readonly<Record<string, number>>;
    const element = assessment.dominantElement as ChartElement;
    add(`오행 중 ${withJosa(`${element}(${ELEMENT_HANJA[element]})`, "이/가")} ${percents[element]}%로 가장 많습니다.`, "facets.assessment.elementPercent");
  }
  if (!chart.hourKnown) {
    add("태어난 시간을 몰라 시주는 계산하지 않았습니다.", "core.document.calculation.information");
  }
  return facts;
}

const isAppRule = (conclusion: InquiryConclusion) => conclusion.rule.ruleId.startsWith(`${RULESET_ID}.`);

/**
 * 앱 규칙의 결론을 모두 쓴다(주제당 최대 4개). 엔진 기본 규칙의 보류 결론은 앱 규칙 결론이 하나도 없을 때만
 * 보조 재료로 1개 넘긴다. 엔진 결론은 기술 문장이라 본문 재료로는 앱 규칙 결론을 우선한다.
 */
function selectConclusions(conclusions: readonly InquiryConclusion[]): InquiryConclusion[] {
  const fromApp = conclusions.filter(isAppRule);
  if (fromApp.length) return fromApp;
  return conclusions.filter((conclusion) => conclusion.status === "deferred").slice(0, 1);
}

function topicStatus(selected: readonly InquiryConclusion[]): TopicPlanStatus {
  if (selected.some((conclusion) => isAppRule(conclusion) && conclusion.status === "candidate")) return "adopted";
  if (selected.length > 0) return "tentative";
  return "limited";
}

export function targetFor(topic: Pick<ProductTopic, "depth">, weight: TopicWeight): number {
  if (weight === "focus") return topic.depth.focus;
  if (weight === "light") return topic.depth.light;
  if (weight === "lead") return topic.depth.standard + 1;
  return topic.depth.standard;
}

export function toStatement(
  ref: string,
  conclusion: InquiryConclusion,
  sink: RuleDetailSink | undefined,
  loreContext?: LoreContext,
): InterpretationStatement {
  const detail = sink?.get(detailKey(conclusion.rule.ruleId, conclusion.periodId, conclusion.statement));
  const lore = loreContext ? loreFor(conclusion.supportingEvidence, detail?.basis ?? [], loreContext) : [];
  return {
    ref,
    kind: "service-interpretation",
    text: conclusion.statement,
    status: conclusion.status,
    caveats: conclusion.caveats,
    conclusionId: conclusion.id,
    ruleId: conclusion.rule.ruleId,
    ruleVersion: conclusion.rule.version,
    ...(detail
      ? {
          aspect: detail.aspect,
          basis: detail.basis,
          ...(detail.upside ? { upside: detail.upside } : {}),
          ...(detail.weakness ? { weakness: detail.weakness } : {}),
          ...(detail.action ? { action: detail.action } : {}),
          ...(detail.counterNote ? { counterNote: detail.counterNote } : {}),
          ...(detail.compare ? { compare: detail.compare } : {}),
        }
      : {}),
    ...(lore.length ? { lore } : {}),
  };
}

export function traceOf(topicId: string, domain: string, answer: ReturnType<InquiryReader["answer"]>, adoptedIds: ReadonlySet<string>): TopicTrace {
  return {
    topicId,
    inquiryDomain: domain,
    inquiryStatus: answer.status,
    policyVersion: answer.policyVersion,
    limitations: answer.limitations,
    evaluatedRules: answer.evaluatedRules,
    conclusions: answer.conclusions.map((conclusion) => ({
      id: conclusion.id,
      status: conclusion.status,
      statement: conclusion.statement,
      rule: conclusion.rule,
      supportingEvidenceIds: conclusion.supportingEvidence.map((entry) => entry.id),
      counterEvidenceIds: conclusion.counterEvidence.map((entry) => entry.id),
      contextualEvidenceIds: conclusion.contextualEvidence.map((entry) => entry.id),
      sourceRefs: [...new Set(conclusion.supportingEvidence.flatMap((entry) => entry.sourceRefs))],
      caveats: conclusion.caveats,
      adopted: adoptedIds.has(conclusion.id),
    })),
  };
}

/**
 * 풀이 기록을 만들 때 저장하는 원국 작성 재료. 궁금한 점의 원문은 넣지 않는다.
 * 질문 분석과 기간 재료는 결제 후 생성 단계에서 더한다 (focus.ts).
 */
export function buildReadingPlan(input: {
  readonly reader: InquiryReader;
  readonly sink: RuleDetailSink;
  readonly product: ProductDefinition;
  readonly persona: Persona;
  readonly chart: ChartView;
  readonly assessment: AssessmentFacet | null;
  readonly nickname: string;
  readonly gender: "male" | "female";
  readonly situationId: string | null;
}): { readonly plan: ReadingPlanV2; readonly trace: readonly TopicTrace[] } {
  const { reader, sink, product, persona, chart, assessment, nickname, gender, situationId } = input;
  const situation = product.situation.options.find((option) => option.id === situationId) ?? null;
  let nextStatement = 1;
  const trace: TopicTrace[] = [];

  const topics: TopicPlanV2[] = product.topics.map((topic) => {
    // 가족 규칙이 자녀를 보는 계열을 고를 때 성별을 쓴다. 다른 규칙은 이 값을 읽지 않는다.
    const answer = reader.answer({ domain: topic.inquiryDomain, kind: "natal", context: { gender } });
    const selected = selectConclusions(answer.conclusions);
    const status = topicStatus(selected);
    trace.push(traceOf(topic.id, topic.inquiryDomain, answer, new Set(selected.map((conclusion) => conclusion.id))));
    const weight: TopicWeight = situation?.focusDomains.includes(topic.inquiryDomain) ? "lead" : "standard";
    return {
      topicId: topic.id,
      title: topic.title,
      inquiryDomain: topic.inquiryDomain,
      status,
      limitNote:
        status === "limited"
          ? "이 주제는 판단할 근거가 부족합니다. 무엇을 알 수 없는지 짧게 말하고 결론을 만들지 않습니다."
          : status === "tentative"
            ? "확정하기 어려운 후보입니다. 경향으로만 말하고 한계를 함께 말합니다."
            : null,
      statements: selected.map((conclusion) => toStatement(`s${nextStatement++}`, conclusion, sink, { chart, assessment })),
      outline: topic.outline,
      depth: topic.depth,
      weight,
      target: status === "limited" ? 1 : targetFor(topic, weight),
      creativeSceneAllowed: topic.creativeScene && status === "adopted",
      situationAngle: situation?.angles[topic.inquiryDomain] ?? null,
    };
  });

  const userContext: UserContextStatement[] = situation
    ? [{ ref: "u1", kind: "user-context", text: `사용자가 고른 현재 상황: ${situation.label}`, source: "situation" }]
    : [];

  return {
    plan: {
      planVersion: PLAN_VERSION,
      productId: product.id,
      productVersion: product.version,
      rulesetId: RULESET_ID,
      rulesetVersion: RULESET_VERSION,
      personaId: persona.id,
      personaVersion: persona.version,
      nickname,
      hourKnown: chart.hourKnown,
      gender,
      coverageNotes: chart.hourKnown ? [] : ["태어난 시간을 몰라 시주를 뺀 범위에서 읽었습니다."],
      facts: buildFacts(chart, assessment),
      userContext,
      situation: situation ? { id: situation.id, label: situation.label, context: situation.context } : null,
      topics,
    },
    trace,
  };
}

/**
 * 결제 전에 보여 줄 짧은 맛보기. LLM 없이 계산값과 규칙 결론만으로 만든다.
 * 본문은 결제 후에 별도로 생성되므로 브라우저로 미리 내려가지 않는다.
 */
export function buildReadingPreview(plan: ReadingPlanV2, chart: ChartView): ReadingPreview {
  const bubbles: string[] = [];
  if (chart.dayMaster) {
    const { ko, hanja, element } = chart.dayMaster;
    bubbles.push(`${plan.nickname} 님의 일간은 ${ko}(${hanja}), ${element}(${ELEMENT_HANJA[element]})의 기운이에요.`);
  }
  const temperament = plan.topics[0];
  const lead = temperament?.statements[0];
  if (lead) {
    bubbles.push(lead.status === "candidate" ? lead.text : `아직 단정하기는 어렵지만, ${lead.text}`);
  } else {
    bubbles.push("이 사주에서는 성향을 단정할 근거가 충분하지 않아, 확인되는 범위만 조심스럽게 읽어 드려요.");
  }
  return { bubbles, limitNotes: chart.notes };
}
