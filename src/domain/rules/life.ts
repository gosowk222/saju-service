import type { InquiryEvidence, InquiryRule, InquiryRuleContext } from "sajuengine";
import { FAMILY_CAVEAT, HEALTH_CAVEAT, INVEST_CAVEAT, JOB_CAVEAT, SHINSAL_CAVEAT, TRADITION_CAVEAT, ruleMetadata, type RuleDetailSink } from "./common";
import { common, drafter, textDetail } from "./drafting";
import {
  ELEMENTS,
  ELEMENT_COMPANION,
  ELEMENT_DRAIN,
  ELEMENT_HABIT,
  ELEMENT_HANJA,
  ELEMENT_INDUSTRY,
  ELEMENT_LUCK,
  ELEMENT_NATURE,
  ELEMENT_PLACE,
  ELEMENT_PLACE_WEAKNESS,
  ENERGY_TEXT,
  FAMILY_CHILDREN,
  FAMILY_EARLY,
  FAMILY_JOBS,
  FAMILY_PARENTS,
  FAMILY_SIBLINGS,
  FRIENDS_FORTUNE,
  FRIENDS_IMAGE,
  GWIIN_LABEL,
  GWIIN_SHINSAL,
  INVESTMENT_STYLE,
  MOVE_TEXT,
  type Element,
} from "./life-tables";
import {
  OPPOSING_RELATIONS,
  STRENGTH_LABEL,
  findJudgment,
  hourKnown,
  isPartial,
  nearThreshold,
  observedOnlyMissing,
  pairObservation,
  percentText,
  relationPositions,
  shinsalEvidence,
  strengthBand,
  tenGodCounts,
  withJosa,
  type Family,
} from "./materials";

/**
 * 생활 주제 규칙(가족, 친구와 인복, 잘 맞는 곳과 행운)과, 기존 주제에 붙는 에너지 관리·투자 성향 규칙.
 * first-overview.ts와 같이 엔진의 구조화된 값(assessment, natalFacts, evidence의 ruleId·tags·id)만 읽는다.
 * 조건과 검토 상태는 docs/rules/first-overview.md에 있다. AI 초안이며 reviewStatus는 unreviewed다.
 */

/** 시주를 몰라 1, 2위 계열이 이 값 이하로 가까우면 친구들이 보는 모습을 보류한다. */
const IMAGE_HOLD_MARGIN = 10;
/** 한 오행이 이 값 이상이면 기운이 한쪽으로 몰린 리듬으로 본다. */
const ENERGY_DOMINANT_PERCENT = 35;

const isElement = (value: unknown): value is Element => typeof value === "string" && (ELEMENTS as readonly string[]).includes(value);

function elementsOf(context: InquiryRuleContext) {
  const assessment = context.assessment;
  return {
    useful: isElement(assessment?.usefulElement) ? assessment.usefulElement : null,
    helpful: isElement(assessment?.helpfulElement) ? assessment.helpfulElement : null,
    adverse: ((assessment?.adverseElements as readonly unknown[] | undefined) ?? []).filter(isElement),
  };
}

const elementText = (element: Element) => `${element}(${ELEMENT_HANJA[element]}, ${ELEMENT_NATURE[element]})`;

function genderOf(context: InquiryRuleContext): "male" | "female" | null {
  const gender = context.question.context.gender;
  return gender === "male" || gender === "female" ? gender : null;
}

// ─── 가족 ───────────────────────────────────────────────────

/** 전통 육친에서 자녀를 보는 계열. 남성은 관성, 여성은 식상이다. */
const CHILD_FAMILY: Readonly<Record<"male" | "female", Family>> = { male: "authority", female: "output" };

function familyRule(sink?: RuleDetailSink): InquiryRule {
  const meta = ruleMetadata("family");
  return {
    metadata: meta,
    domains: ["family"],
    kinds: ["natal"],
    evaluate: (context) => {
      const base = common(context);
      if (!base) return [];
      const { percents, families, partial } = base;
      const out = drafter(meta.ruleId, context, sink, []);
      const { peer, wealth, resource } = percents;
      const robbers = tenGodCounts(context)["겁재"] ?? 0;

      const parents =
        resource >= 25 ? "nurtured" : resource <= 12 && !observedOnlyMissing(context, "resource") ? "self-made" : wealth >= 25 ? "practical" : "balanced";
      out.add({
        key: "parents",
        text: FAMILY_PARENTS[parents].claim,
        hold: partial && (nearThreshold(resource, 25, 3) || nearThreshold(resource, 12, 3) || nearThreshold(wealth, 25, 3)),
        support: [families],
        caveats: [FAMILY_CAVEAT],
        detail: textDetail("부모와의 관계", FAMILY_PARENTS[parents], [
          `어머니·보살핀 어른으로 보는 ${percentText("resource", percents)}`,
          `아버지·집안의 현실로 보는 ${percentText("wealth", percents)}`,
        ]),
      });

      const siblings = peer >= 30 && robbers >= 1 ? "rival" : peer <= 12 && !observedOnlyMissing(context, "peer") ? "alone" : peer >= 18 ? "close" : null;
      if (siblings) {
        out.add({
          key: "siblings",
          text: FAMILY_SIBLINGS[siblings].claim,
          hold: partial && nearThreshold(peer, siblings === "rival" ? 30 : siblings === "alone" ? 12 : 18, 3),
          support: [families],
          caveats: [FAMILY_CAVEAT],
          detail: textDetail("형제·자매와의 관계", FAMILY_SIBLINGS[siblings], [
            `형제·또래로 보는 ${percentText("peer", percents)}`,
            ...(robbers ? [`원국에 겁재 ${robbers}개`] : []),
          ]),
        });
      }

      const gender = genderOf(context);
      if (gender) {
        const childFamily = CHILD_FAMILY[gender];
        const value = percents[childFamily];
        const children = value >= 25 ? "devoted" : value <= 12 && !observedOnlyMissing(context, childFamily) ? "light" : "warm";
        out.add({
          key: "children",
          text: FAMILY_CHILDREN[children].claim,
          // 시주는 자녀 자리라, 시간을 모르면 단정하지 않는다.
          hold: !hourKnown(context) || (partial && nearThreshold(value, 25, 3)),
          support: [families],
          caveats: [FAMILY_CAVEAT],
          detail: textDetail("자녀와의 인연", FAMILY_CHILDREN[children], [
            `${gender === "male" ? "남성" : "여성"}의 자녀로 보는 ${percentText(childFamily, percents)}`,
            ...(hourKnown(context) ? [] : ["태어난 시간을 몰라 자녀 자리(시주)는 보지 못함"]),
          ]),
        });
      }

      const yearMonth = context.evidence.filter((entry) => {
        if (entry.kind !== "relation" || entry.periodId !== null) return false;
        const positions = relationPositions(entry);
        return positions.includes("year") && positions.includes("month");
      });
      const opposing = yearMonth.filter((entry) => OPPOSING_RELATIONS.some((type) => entry.tags.includes(`relation:${type}`)));
      const binding = yearMonth.filter((entry) => entry.tags.includes("combination"));
      const early = opposing.length ? "turbulent" : binding.length ? "close-knit" : null;
      if (early) {
        out.add({
          key: "early",
          text: FAMILY_EARLY[early].claim,
          support: early === "turbulent" ? opposing : binding,
          caveats: [FAMILY_CAVEAT],
          detail: textDetail("집안 분위기와 성장기", FAMILY_EARLY[early], [
            early === "turbulent"
              ? "연주(어린 시절 자리)와 월주(성장기·부모 자리) 사이에 충·형·원진 같은 부딪힘 관계"
              : "연주(어린 시절 자리)와 월주(성장기·부모 자리) 사이에 합 관계",
          ]),
        });
      }
      return out.drafts.slice(0, 4);
    },
  };
}

// ─── 친구와 인복 ─────────────────────────────────────────────

function friendsRule(sink?: RuleDetailSink): InquiryRule {
  const meta = ruleMetadata("friends");
  return {
    metadata: meta,
    domains: ["friends"],
    kinds: ["natal"],
    evaluate: (context) => {
      const base = common(context);
      if (!base) return [];
      const { percents, families, ranked, partial } = base;
      const out = drafter(meta.ruleId, context, sink, []);

      const gwiin = GWIIN_SHINSAL.map((id) => ({ id, entries: shinsalEvidence(context.evidence, id, null) })).filter((item) => item.entries.length);
      const fortune = gwiin.length ? "helped" : percents.peer >= 20 ? "built" : "few";
      out.add({
        key: "fortune",
        text: FRIENDS_FORTUNE[fortune].claim,
        hold: !gwiin.length && partial && nearThreshold(percents.peer, 20, 3),
        support: gwiin.length ? gwiin.flatMap((item) => item.entries) : [families],
        caveats: gwiin.length ? [SHINSAL_CAVEAT] : [],
        detail: textDetail(
          "인복의 정도",
          FRIENDS_FORTUNE[fortune],
          gwiin.length ? [`원국에 ${gwiin.map((item) => GWIIN_LABEL[item.id]).join("·")} 신살 표지`] : [`귀인 신살 표지가 없고 ${percentText("peer", percents)}`],
        ),
      });

      const [first, second] = [ranked[0]!, ranked[1]!];
      out.add({
        key: "image",
        text: FRIENDS_IMAGE[first].claim,
        hold: partial && percents[first] - percents[second] <= IMAGE_HOLD_MARGIN,
        support: [families],
        detail: textDetail("친구들이 보는 나", FRIENDS_IMAGE[first], [`십성 계열 중 ${percentText(first, percents)}가 가장 큼`]),
      });

      const usefulGods = findJudgment(context.evidence, "m01.assessment.useful-gods");
      const { useful, adverse } = elementsOf(context);
      if (usefulGods && useful) {
        out.add({
          key: "match",
          text: `곁에 두면 좋은 친구는 ${ELEMENT_COMPANION[useful]}예요. ${useful}(${ELEMENT_HANJA[useful]}) 기운이 강한 사람이라, 나에게 필요한 ${withJosa(ELEMENT_NATURE[useful], "을/를")} 채워 줘요.`,
          hold: partial,
          support: [usefulGods],
          caveats: [TRADITION_CAVEAT],
          detail: {
            aspect: "잘 맞는 친구 유형",
            basis: [`용신(가장 필요한 기운)이 ${elementText(useful)}로 계산됨`],
            action: "그런 친구와의 약속은 한 달에 한 번이라도 내가 먼저 잡아 보기",
          },
        });
      }
      const drain = adverse[0];
      if (usefulGods && drain) {
        out.add({
          key: "drain",
          text: `반대로 ${withJosa(ELEMENT_DRAIN[drain], "과/와")} 오래 붙어 있으면 기운이 빨리 닳아요.`,
          hold: partial,
          support: [usefulGods],
          caveats: [TRADITION_CAVEAT],
          detail: {
            aspect: "멀리하면 좋은 사람",
            basis: [`기신(부담이 되는 기운)이 ${elementText(drain)}로 계산됨`],
            weakness: {
              what: "그런 사람과 거리를 두지 못하는 것",
              when: "오래된 사이라 거절하기 미안할 때",
              cost: "만나고 오면 이유 없이 지치고 내 일에 쓸 힘이 줄어요",
              change: "만나는 횟수와 시간을 미리 정해 두고 그 안에서만 만나기",
            },
          },
        });
      }
      return out.drafts.slice(0, 4);
    },
  };
}

// ─── 잘 맞는 곳과 행운 ────────────────────────────────────────

function placeRule(sink?: RuleDetailSink): InquiryRule {
  const meta = ruleMetadata("place");
  return {
    metadata: meta,
    domains: ["place"],
    kinds: ["natal"],
    evaluate: (context) => {
      const usefulGods = findJudgment(context.evidence, "m01.assessment.useful-gods");
      const { useful, helpful, adverse } = elementsOf(context);
      if (!usefulGods || !useful) return [];
      const partial = isPartial(context);
      const out = drafter(meta.ruleId, context, sink, []);
      const basis = [`용신(가장 필요한 기운)이 ${elementText(useful)}로 계산됨`, ...(helpful ? [`희신(돕는 기운)은 ${elementText(helpful)}`] : [])];

      const place = ELEMENT_PLACE[useful];
      const drain = adverse[0];
      out.add({
        key: "region",
        text: `${place.claim} 국내라면 ${place.domestic}, 해외라면 ${withJosa(place.abroad, "이/가")} 어울려요.`,
        hold: partial,
        support: [usefulGods],
        caveats: [TRADITION_CAVEAT],
        detail: {
          aspect: "잘 맞는 지역과 환경",
          basis: [...basis, ...(drain ? [`기신(부담이 되는 기운)은 ${elementText(drain)}`] : [])],
          ...(drain ? { weakness: ELEMENT_PLACE_WEAKNESS[drain] } : {}),
        },
      });

      const yeokma = shinsalEvidence(context.evidence, "yeokma", null);
      const move = yeokma.length ? "mobile" : "rooted";
      out.add({
        key: "move",
        text: MOVE_TEXT[move].claim,
        // 역마가 없다는 것은 표지의 부재라 단정하지 않는다.
        hold: move === "rooted",
        support: yeokma.length ? yeokma : [usefulGods],
        caveats: yeokma.length ? [SHINSAL_CAVEAT] : [TRADITION_CAVEAT],
        detail: textDetail("해외·이동 운", MOVE_TEXT[move], [yeokma.length ? "원국에 역마 신살 표지" : "원국에 역마 신살 표지가 없음"]),
      });

      const luck = ELEMENT_LUCK[useful];
      out.add({
        key: "lucky",
        text: `행운의 방향은 ${luck.direction}, 행운의 색은 ${luck.colors}, 행운의 숫자는 ${luck.numbers}.`,
        hold: partial,
        support: [usefulGods],
        caveats: [TRADITION_CAVEAT],
        detail: {
          aspect: "행운의 방향·색·숫자",
          basis: [...basis, "오행의 전통 대응(방위·색·수)으로 옮김"],
          upside: "중요한 날 기분 좋게 곁들이는 작은 응원",
          action: `면접, 계약, 이사처럼 중요한 날에 ${luck.colors} 소품을 하나 챙기거나 ${withJosa(luck.direction, "을/를")} 향한 자리를 골라 보기${
            helpful ? `. 보조로는 ${ELEMENT_LUCK[helpful].colors}도 잘 맞음` : ""
          }`,
        },
      });

      out.add({
        key: "habit",
        text: ELEMENT_HABIT[useful].claim,
        hold: partial,
        support: [usefulGods],
        caveats: [TRADITION_CAVEAT],
        detail: textDetail("생활 속 개운 습관", ELEMENT_HABIT[useful], basis),
      });
      return out.drafts.slice(0, 4);
    },
  };
}

// ─── 에너지 관리 (기본 성향 주제에 붙는다) ─────────────────────────

function energyRule(sink?: RuleDetailSink): InquiryRule {
  const meta = ruleMetadata("energy");
  return {
    metadata: meta,
    domains: ["temperament"],
    kinds: ["natal"],
    evaluate: (context) => {
      const elements = findJudgment(context.evidence, "m01.assessment.elements");
      const strength = findJudgment(context.evidence, "m01.assessment.strength");
      const band = strengthBand(context.assessment?.strength);
      const percent = context.assessment?.elementPercent as Readonly<Record<Element, number>> | undefined;
      const dominant = isElement(context.assessment?.dominantElement) ? context.assessment.dominantElement : null;
      const excess = dominant && percent && percent[dominant] >= ENERGY_DOMINANT_PERCENT ? dominant : null;
      const key = band === "weak" ? "conserve" : excess ?? "steady";
      const support: (InquiryEvidence | undefined)[] = key === "conserve" ? [strength] : key === "steady" ? [elements, strength] : [elements];
      const out = drafter(meta.ruleId, context, sink, []);
      out.add({
        key: "energy",
        text: ENERGY_TEXT[key].claim,
        hold: isPartial(context),
        support,
        caveats: [HEALTH_CAVEAT],
        detail: textDetail("에너지와 컨디션 관리", ENERGY_TEXT[key], [
          ...(band ? [`일간의 힘이 ${STRENGTH_LABEL[context.assessment!.strength!]}`] : []),
          ...(dominant && percent ? [`오행 중 ${dominant}(${ELEMENT_HANJA[dominant]})이 ${percent[dominant]}%로 가장 많음`] : []),
        ]),
      });
      return out.drafts;
    },
  };
}

// ─── 투자 성향 (돈 주제에 붙는다) ───────────────────────────────

function investmentRule(sink?: RuleDetailSink): InquiryRule {
  const meta = ruleMetadata("investment");
  return {
    metadata: meta,
    domains: ["wealth"],
    kinds: ["natal"],
    evaluate: (context) => {
      const base = common(context);
      if (!base) return [];
      const { percents, families, partial } = base;
      const { peer, output, wealth, authority, resource } = percents;
      const counts = tenGodCounts(context);
      const indirect = counts["편재"] ?? 0;
      const direct = counts["정재"] ?? 0;
      const robbers = counts["겁재"] ?? 0;
      const style =
        peer >= 25 && robbers >= 1
          ? "follow"
          : indirect > direct && (output >= 20 || wealth >= 20)
            ? "opportunity"
            : resource >= 25
              ? "study"
              : (direct > 0 && direct >= indirect) || authority >= 20
                ? "steady"
                : "rule";
      const out = drafter(meta.ruleId, context, sink, []);
      out.add({
        key: "investment",
        text: INVESTMENT_STYLE[style].claim,
        hold: partial && (nearThreshold(peer, 25, 3) || nearThreshold(resource, 25, 3) || nearThreshold(authority, 20, 3)),
        support: [families, style === "opportunity" ? pairObservation(context.evidence, "output", "wealth") : undefined],
        caveats: [INVEST_CAVEAT],
        detail: textDetail("투자 성향과 방식", INVESTMENT_STYLE[style], [
          `원국에 편재 ${indirect}개, 정재 ${direct}개, 겁재 ${robbers}개`,
          percentText("peer", percents),
          percentText(style === "study" ? "resource" : "wealth", percents),
        ]),
      });
      return out.drafts;
    },
  };
}

// ─── 어울리는 직업과 업종 (일과 직업 주제에 붙는다) ─────────────────

function jobsRule(sink?: RuleDetailSink): InquiryRule {
  const meta = ruleMetadata("jobs");
  return {
    metadata: meta,
    domains: ["career"],
    kinds: ["natal"],
    evaluate: (context) => {
      const base = common(context);
      if (!base) return [];
      const { percents, families, ranked, partial } = base;
      const [top, second] = ranked;
      if (!top) return [];
      const out = drafter(meta.ruleId, context, sink, []);
      out.add({
        key: "family",
        text: FAMILY_JOBS[top].claim,
        // 시주를 몰라 1, 2위 계열이 가까우면 직업군을 단정하지 않는다.
        hold: partial && second !== undefined && nearThreshold(percents[top], percents[second], 5),
        support: [families],
        caveats: [JOB_CAVEAT],
        detail: textDetail("어울리는 직업", FAMILY_JOBS[top], [`가장 큰 계열 ${percentText(top, percents)}`]),
      });

      const usefulGods = findJudgment(context.evidence, "m01.assessment.useful-gods");
      const { useful } = elementsOf(context);
      if (usefulGods && useful) {
        out.add({
          key: "industry",
          text: `업종으로 보면 ${withJosa(ELEMENT_INDUSTRY[useful], "과/와")} 인연이 있어요. 가장 필요한 ${elementText(useful)} 기운을 일에서 채우는 셈이라, 같은 일을 해도 덜 지쳐요.`,
          hold: partial,
          support: [usefulGods],
          caveats: [JOB_CAVEAT],
          detail: {
            aspect: "인연 있는 업종",
            basis: [`용신(가장 필요한 기운)이 ${elementText(useful)}로 계산됨`, "오행의 전통 대응(업종)으로 옮김"],
            action: "진로나 이직을 고를 때 하는 일이 비슷하면 이 분야의 회사를 먼저 살펴보기",
          },
        });
      }
      return out.drafts;
    },
  };
}

export function createLifeRules(sink?: RuleDetailSink): InquiryRule[] {
  return [familyRule(sink), friendsRule(sink), placeRule(sink), energyRule(sink), investmentRule(sink), jobsRule(sink)];
}
