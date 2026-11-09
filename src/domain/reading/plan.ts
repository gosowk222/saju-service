import type { AssessmentFacet, InquiryConclusion, InquiryReader } from "sajuengine";
import type { Persona } from "../personas";
import type { ProductDefinition } from "../products/types";
import { RULESET_ID, RULESET_VERSION, familyLabel } from "../rules/first-overview";
import { ELEMENT_HANJA } from "./chart";
import type {
  ChartElement,
  ChartView,
  FactStatement,
  InterpretationStatement,
  ReadingPlan,
  ReadingPreview,
  TopicPlan,
  TopicPlanStatus,
  TopicTrace,
  UserContextStatement,
} from "./types";

export const PLAN_VERSION = "1.0.0";

const STRENGTH_LABEL: Readonly<Record<string, string>> = {
  strong: "강한 편",
  "slightly-strong": "조금 강한 편",
  balanced: "균형 잡힌 편",
  "slightly-weak": "조금 약한 편",
  weak: "약한 편",
};

const PATTERN_LABEL: Readonly<Record<string, string>> = {
  "eating-god": "식신격",
  "hurting-officer": "상관격",
  "direct-wealth": "정재격",
  "indirect-wealth": "편재격",
  "direct-officer": "정관격",
  "seven-killings": "칠살격",
  "direct-resource": "정인격",
  "indirect-resource": "편인격",
  "month-prosperity": "건록격",
  "month-robbery": "양인격",
};

/** 주제당 넘길 앱 규칙 결론과 엔진 기본 결론의 최대 개수. */
const MAX_APP_CONCLUSIONS = 2;
const MAX_ENGINE_DEFERRED = 1;

function buildFacts(chart: ChartView, assessment: AssessmentFacet | null): FactStatement[] {
  const facts: FactStatement[] = [];
  const add = (text: string, originPath: string) =>
    facts.push({ ref: `f${facts.length + 1}`, kind: "engine-fact", text, originPath });

  if (chart.dayMaster) {
    const { ko, hanja, element } = chart.dayMaster;
    add(`일간은 ${ko}(${hanja})이고 오행으로는 ${element}(${ELEMENT_HANJA[element]})입니다.`, "core.document.facts.positions.day.stem");
  }
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
    add(`오행 중 ${element}(${ELEMENT_HANJA[element]})이 ${percents[element]}%로 가장 많습니다.`, "facets.assessment.elementPercent");
  }
  if (!chart.hourKnown) {
    add("태어난 시간을 몰라 시주는 계산하지 않았습니다.", "core.document.calculation.information");
  }
  return facts;
}

function buildUserContext(
  product: ProductDefinition,
  situationId: string | null,
  concern: string,
): UserContextStatement[] {
  const items: UserContextStatement[] = [];
  const situation = product.situation.options.find((option) => option.id === situationId);
  if (situation) {
    items.push({ ref: "u1", kind: "user-context", text: `사용자가 알려 준 현재 상황: ${situation.label}`, source: "situation" });
  }
  if (concern) {
    items.push({ ref: `u${items.length + 1}`, kind: "user-context", text: `사용자가 궁금하다고 적은 내용: ${concern}`, source: "concern" });
  }
  return items;
}

const isAppRule = (conclusion: InquiryConclusion) => conclusion.rule.ruleId.startsWith(`${RULESET_ID}.`);

function selectConclusions(conclusions: readonly InquiryConclusion[]): InquiryConclusion[] {
  const fromApp = conclusions.filter(isAppRule).sort((a, b) => Number(b.status === "candidate") - Number(a.status === "candidate"));
  const fromEngine = conclusions.filter((conclusion) => !isAppRule(conclusion) && conclusion.status === "deferred");
  return [...fromApp.slice(0, MAX_APP_CONCLUSIONS), ...fromEngine.slice(0, MAX_ENGINE_DEFERRED)];
}

function topicStatus(selected: readonly InquiryConclusion[]): TopicPlanStatus {
  if (selected.some((conclusion) => isAppRule(conclusion) && conclusion.status === "candidate")) return "adopted";
  if (selected.length > 0) return "tentative";
  return "limited";
}

export function buildReadingPlan(input: {
  readonly reader: InquiryReader;
  readonly product: ProductDefinition;
  readonly persona: Persona;
  readonly chart: ChartView;
  readonly assessment: AssessmentFacet | null;
  readonly nickname: string;
  readonly situationId: string | null;
  readonly concern: string;
}): { readonly plan: ReadingPlan; readonly trace: readonly TopicTrace[] } {
  const { reader, product, persona, chart, assessment, nickname, situationId, concern } = input;
  let nextStatement = 1;
  const trace: TopicTrace[] = [];

  const topics: TopicPlan[] = product.topics.map((topic) => {
    const answer = reader.answer({ domain: topic.inquiryDomain, kind: "natal" });
    const selected = selectConclusions(answer.conclusions);
    const status = topicStatus(selected);
    const adoptedIds = new Set(selected.map((conclusion) => conclusion.id));

    trace.push({
      topicId: topic.id,
      inquiryDomain: topic.inquiryDomain,
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
    });

    const statements: InterpretationStatement[] = selected.map((conclusion) => ({
      ref: `s${nextStatement++}`,
      kind: "service-interpretation",
      text: conclusion.statement,
      status: conclusion.status,
      caveats: conclusion.caveats,
      conclusionId: conclusion.id,
      ruleId: conclusion.rule.ruleId,
      ruleVersion: conclusion.rule.version,
    }));

    return {
      topicId: topic.id,
      title: topic.title,
      status,
      limitNote:
        status === "limited"
          ? "이 주제는 판단할 근거가 부족합니다. 알 수 없다고 짧게 말하고 결론을 만들지 않습니다."
          : status === "tentative"
            ? "확정하기 어려운 후보입니다. 경향으로만 말하고 한계를 함께 말합니다."
            : null,
      statements,
      bubbles: status === "limited" ? { min: 1, target: 1, max: 2 } : topic.bubbles,
      creativeSceneAllowed: topic.creativeScene && status === "adopted",
    };
  });

  const coverageNotes = chart.hourKnown ? [] : ["태어난 시간을 몰라 시주를 뺀 범위에서 읽었습니다."];

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
      coverageNotes,
      facts: buildFacts(chart, assessment),
      userContext: buildUserContext(product, situationId, concern),
      topics,
    },
    trace,
  };
}

/**
 * 결제 전에 보여 줄 짧은 맛보기. LLM 없이 계산값과 규칙 결론만으로 만든다.
 * 본문은 결제 후에 별도로 생성되므로 브라우저로 미리 내려가지 않는다.
 */
export function buildReadingPreview(plan: ReadingPlan, chart: ChartView): ReadingPreview {
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
