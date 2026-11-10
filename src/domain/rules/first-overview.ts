import type { InquiryConclusionDraft, InquiryEvidence, InquiryRule, InquiryRuleContext } from "sajuengine";
import {
  FAMILY_LABEL,
  FAMILY_MEANING,
  OPPOSING_RELATIONS,
  PATTERN_LABEL,
  STRENGTH_LABEL,
  dayBranchTenGod,
  familyPercents,
  findJudgment,
  hourKnown,
  isPartial,
  nearThreshold,
  observedOnlyMissing,
  pairObservation,
  percentText,
  rankFamilies,
  relationEvidence,
  shinsalEvidence,
  strengthBand,
  tenGodCounts,
  tenGodFamily,
  topicGuards,
  uniqueIds,
  type Family,
} from "./materials";
import {
  CAREER_ORG_FIT,
  CAREER_ORIENTATION,
  CAREER_STYLE,
  PATTERN_ABILITY,
  ROMANCE_ATTRACTION,
  ROMANCE_CHARM_SHINSAL,
  ROMANCE_COMFORT,
  ROMANCE_CONFLICT,
  ROMANCE_DEEPENING,
  SCARCE_ACTION,
  SHINSAL_ENVIRONMENT,
  SHINSAL_ENVIRONMENT_ORDER,
  SOCIAL_BOUNDARY,
  SOCIAL_COMPETITION,
  SOCIAL_CONFLICT,
  SOCIAL_COOPERATION,
  SOCIAL_GWIIN,
  STRENGTH_REACTION,
  TEMPERAMENT_BALANCED,
  TEMPERAMENT_CONDITION,
  TEMPERAMENT_CORE,
  TEMPERAMENT_MIX,
  WEALTH_INCOME,
  WEALTH_KEEPING,
  WEALTH_RELATIONS,
  type ReadingText,
} from "./natal-tables";
import {
  GUARD_CAVEAT,
  OUTCOME_CAVEAT,
  PARTIAL_CAVEAT,
  SHINSAL_CAVEAT,
  detailKey,
  ruleMetadata,
  type CompareDetail,
  type RuleDetail,
  type RuleDetailSink,
} from "./common";
import { createTimingRule } from "./timing";

/**
 * 첫 상품의 앱 규칙. 조건과 검토 상태는 docs/rules/first-overview.md에 있다.
 *
 * 구조화된 값(assessment, natalFacts의 십성, evidence의 ruleId·tags)만 읽는다. assertion 문장은 해석하지 않는다.
 * AI가 작성한 초안이며 명리 전문가의 검토를 받지 않았으므로 reviewStatus는 unreviewed다.
 */

export {
  OUTCOME_CAVEAT,
  PARTIAL_CAVEAT,
  RULESET_ID,
  RULESET_VERSION,
  SOURCE_REF,
  detailKey,
  type CompareDetail,
  type RuleDetail,
  type RuleDetailSink,
  type TimingDetail,
  type TimingMarker,
} from "./common";
export type { Weakness } from "./natal-tables";

/** 다섯 계열이 고르면 각 20%다. 25% 이상일 때만 두드러진다고 본다. */
export const DOMINANT_MIN_PERCENT = 25;
/** 시주를 모를 때 1위와 2위 차이가 이 값 이하이면 순서가 바뀔 수 있어 보류한다. */
export const PARTIAL_HOLD_MARGIN = 10;
/** 두 번째 계열이 이 값 이상이면 함께 나타나는 성향으로 본다. */
export const MIX_MIN_PERCENT = 18;
/** 비중 낮음 기준. */
export const SCARCE_MAX_PERCENT = 12;

interface Drafter {
  readonly add: (entry: {
    readonly key: string;
    readonly text: string;
    readonly hold?: boolean;
    readonly support: readonly (InquiryEvidence | undefined)[];
    readonly counter?: readonly (InquiryEvidence | undefined)[];
    readonly caveats?: readonly string[];
    readonly detail: RuleDetail;
  }) => void;
  readonly drafts: InquiryConclusionDraft[];
}

function drafter(ruleId: string, context: InquiryRuleContext, sink: RuleDetailSink | undefined, guards: readonly InquiryEvidence[]): Drafter {
  const drafts: InquiryConclusionDraft[] = [];
  const partial = isPartial(context);
  return {
    drafts,
    add: ({ key, text, hold = false, support, counter = [], caveats = [], detail }) => {
      const supportIds = uniqueIds(support);
      if (!supportIds.length) return;
      const counterIds = uniqueIds([...counter, ...guards]).filter((id) => !supportIds.includes(id));
      drafts.push({
        key,
        statement: text,
        status: hold ? "deferred" : "candidate",
        supportingEvidenceIds: supportIds,
        counterEvidenceIds: counterIds,
        caveats: [
          OUTCOME_CAVEAT,
          ...(partial ? [PARTIAL_CAVEAT] : []),
          ...(guards.length ? [GUARD_CAVEAT] : []),
          ...caveats,
        ],
      });
      sink?.set(detailKey(ruleId, context.periodId, text), detail);
    },
  };
}

function textDetail(aspect: string, reading: ReadingText, basis: readonly string[], extra: Partial<RuleDetail> = {}): RuleDetail {
  return {
    aspect,
    basis,
    ...(reading.upside ? { upside: reading.upside } : {}),
    ...(reading.weakness ? { weakness: reading.weakness } : {}),
    ...(reading.action ? { action: reading.action } : {}),
    ...extra,
  };
}

const metadata = ruleMetadata;

interface Common {
  readonly percents: Readonly<Record<Family, number>>;
  readonly families: InquiryEvidence;
  readonly ranked: readonly Family[];
  readonly partial: boolean;
}

function common(context: InquiryRuleContext): Common | null {
  const percents = familyPercents(context);
  const families = findJudgment(context.evidence, "m01.assessment.families");
  if (!percents || !families) return null;
  return { percents, families, ranked: rankFamilies(percents), partial: isPartial(context) };
}

// ─── 기본 성향 ──────────────────────────────────────────────

function temperamentRule(sink?: RuleDetailSink): InquiryRule {
  const meta = metadata("temperament");
  return {
    metadata: meta,
    domains: ["temperament"],
    kinds: ["natal"],
    evaluate: (context) => {
      const base = common(context);
      if (!base) return [];
      const { percents, families, ranked, partial } = base;
      const out = drafter(meta.ruleId, context, sink, topicGuards(context.evidence, "temperament"));
      const [first, second] = [ranked[0]!, ranked[1]!];

      if (percents[first] >= DOMINANT_MIN_PERCENT) {
        const reading = TEMPERAMENT_CORE[first];
        out.add({
          key: "core",
          text: reading.claim,
          hold: partial && percents[first] - percents[second] <= PARTIAL_HOLD_MARGIN,
          support: [families],
          detail: textDetail("핵심 특징", reading, [`십성 계열 중 ${percentText(first, percents)}가 가장 큼`]),
        });
      } else {
        out.add({
          key: "core",
          text: TEMPERAMENT_BALANCED.claim,
          hold: partial && nearThreshold(percents[first], DOMINANT_MIN_PERCENT, 4),
          support: [families],
          detail: textDetail("핵심 특징", TEMPERAMENT_BALANCED, [`가장 큰 계열도 ${percentText(first, percents)}로 25%에 이르지 않음`]),
        });
      }

      if (percents[second] >= MIX_MIN_PERCENT) {
        const reading = TEMPERAMENT_MIX[[first, second].sort().join("|")];
        if (reading) {
          out.add({
            key: "mix",
            text: reading.claim,
            hold: partial && nearThreshold(percents[second], MIX_MIN_PERCENT, 4),
            support: [families, pairObservation(context.evidence, first, second)],
            detail: textDetail("서로 다른 성향이 함께 나타나는 이유", reading, [
              `${percentText(first, percents)}, ${percentText(second, percents)}가 함께 큼`,
            ]),
          });
        }
      }

      const strength = findJudgment(context.evidence, "m01.assessment.strength");
      const band = strengthBand(context.assessment?.strength);
      if (strength && band) {
        const reading = STRENGTH_REACTION[band];
        const borderline = context.assessment?.strength !== "strong" && context.assessment?.strength !== "weak";
        out.add({
          key: "reaction",
          text: reading.claim,
          hold: partial && borderline,
          support: [strength],
          detail: textDetail("상황에 따른 반응", reading, [`일간의 힘이 ${STRENGTH_LABEL[context.assessment!.strength!]}으로 계산됨`]),
        });
        if (band !== "balanced") {
          const inner = first === "peer" || first === "resource";
          const condition = TEMPERAMENT_CONDITION[`${band}-${inner ? "inner" : "outer"}`];
          out.add({
            key: "condition",
            text: condition.claim,
            hold: partial && borderline,
            support: [strength, families],
            detail: textDetail("강점과 약점이 갈리는 조건", condition, [
              `일간의 힘 ${STRENGTH_LABEL[context.assessment!.strength!]}`,
              `가장 큰 계열 ${percentText(first, percents)}`,
            ]),
          });
        }
      }
      return out.drafts.slice(0, 4);
    },
  };
}

// ─── 강점과 활용 방법 ─────────────────────────────────────────

function strengthsRule(sink?: RuleDetailSink): InquiryRule {
  const meta = metadata("strengths");
  return {
    metadata: meta,
    domains: ["strengths"],
    kinds: ["natal"],
    evaluate: (context) => {
      const base = common(context);
      if (!base) return [];
      const { percents, families, ranked } = base;
      const out = drafter(meta.ruleId, context, sink, topicGuards(context.evidence, "strengths"));

      const patternJudgment = findJudgment(context.evidence, "m01.assessment.pattern");
      const pattern = context.assessment?.pattern;
      const ability = pattern ? PATTERN_ABILITY[pattern] : undefined;
      if (patternJudgment && pattern && ability) {
        out.add({
          key: "ability",
          text: ability.claim,
          support: [patternJudgment],
          detail: textDetail("발휘하기 좋은 능력", ability, [`격국이 ${PATTERN_LABEL[pattern] ?? pattern}으로 계산됨`]),
        });
      }

      const present = SHINSAL_ENVIRONMENT_ORDER.map((id) => ({ id, entries: shinsalEvidence(context.evidence, id, null) }))
        .filter((item) => item.entries.length > 0)
        .slice(0, 2);
      if (present.length) {
        out.add({
          key: "environment",
          text: present.map((item) => SHINSAL_ENVIRONMENT[item.id]).join(" "),
          support: present.flatMap((item) => item.entries),
          caveats: [SHINSAL_CAVEAT],
          detail: { aspect: "강점이 살아나는 환경", basis: present.map((item) => `원국에 ${item.id} 신살 표지가 있음`) },
        });
      }

      const scarce = ranked[ranked.length - 1]!;
      if (percents[scarce] <= SCARCE_MAX_PERCENT) {
        out.add({
          key: "action",
          text: SCARCE_ACTION[scarce],
          hold: observedOnlyMissing(context, scarce),
          support: [families],
          detail: {
            aspect: "능력을 실제 행동으로 연결하는 방법",
            basis: [`가장 약한 계열이 ${percentText(scarce, percents)}`],
          },
        });
      }
      return out.drafts.slice(0, 4);
    },
  };
}

// ─── 일과 직업 ──────────────────────────────────────────────

/** 취업과 창업 비교에서 사용자에게 확인해야 하는 현실 조건. 사주로 추측하지 않는다. */
export const PATH_COMPARE_NEEDS = [
  "창업 자금과 수입 없이 버틸 수 있는 기간",
  "해당 분야의 경력이나 실력을 보여 줄 증거",
  "첫 고객이나 판로가 있는지",
  "함께할 사람이 있는지",
] as const;

function careerRule(sink?: RuleDetailSink): InquiryRule {
  const meta = metadata("career");
  return {
    metadata: meta,
    domains: ["career"],
    kinds: ["natal"],
    evaluate: (context) => {
      const base = common(context);
      if (!base) return [];
      const { percents, families, ranked, partial } = base;
      const out = drafter(meta.ruleId, context, sink, topicGuards(context.evidence, "career"));
      const [first, second] = [ranked[0]!, ranked[1]!];
      const { peer, output, authority } = percents;

      if (percents[first] >= DOMINANT_MIN_PERCENT) {
        const reading = CAREER_STYLE[first];
        out.add({
          key: "style",
          text: reading.claim,
          hold: partial && percents[first] - percents[second] <= PARTIAL_HOLD_MARGIN,
          support: [families],
          detail: textDetail("일하는 방식", reading, [`가장 큰 계열 ${percentText(first, percents)}`]),
        });
      }

      const fit = authority >= 20 && authority >= peer ? "structured" : peer + output >= 50 && authority <= 12 ? "autonomous" : "mixed";
      const fitReading = CAREER_ORG_FIT[fit];
      const tension = fit === "structured" && output >= 30;
      out.add({
        key: "org-fit",
        text: fitReading.claim,
        hold: partial && (nearThreshold(authority, 20, 4) || nearThreshold(authority, 12, 4)),
        support: [families, pairObservation(context.evidence, "authority", "resource")],
        detail: textDetail("조직과 업무 환경", fitReading, [percentText("authority", percents), percentText("peer", percents), percentText("output", percents)], {
          ...(tension ? { counterNote: `표현 기운(${percentText("output", percents)})도 강해서 위계가 너무 엄격한 조직에서는 답답함이 커질 수 있다.` } : {}),
        }),
      });

      const orientation = (["resource", "peer", "output"] as const)
        .map((family) => ({ family, value: percents[family] }))
        .sort((a, b) => b.value - a.value || a.family.localeCompare(b.family));
      const strongest = orientation[0]!;
      const weakest = orientation[orientation.length - 1]!;
      out.add({
        key: "orientation",
        text: [
          CAREER_ORIENTATION[strongest.family].strong,
          ...(weakest.value <= 15 ? [CAREER_ORIENTATION[weakest.family].weak] : []),
        ].join(" "),
        hold: partial && strongest.value - orientation[1]!.value <= 5,
        support: [families],
        detail: {
          aspect: "전문성·협업·독립성",
          basis: [
            `전문성 쪽 ${percentText("resource", percents)}`,
            `협업·경쟁 쪽 ${percentText("peer", percents)}`,
            `독자 산출 쪽 ${percentText("output", percents)}`,
          ],
        },
      });

      const compare = pathCompare(context, percents);
      if (compare) {
        const strength = findJudgment(context.evidence, "m01.assessment.strength");
        const evidenceOf = (name: string) => (name === "안정성과 변동성" ? strength : families);
        const firstSide = compare.criteria.filter((item) => item.leaning === "first");
        const secondSide = compare.criteria.filter((item) => item.leaning === "second");
        const leading = firstSide.length === secondSide.length ? null : firstSide.length > secondSide.length ? "first" : "second";
        const winners = leading === null ? [...firstSide, ...secondSide] : leading === "first" ? firstSide : secondSide;
        const losers = leading === null ? [] : leading === "first" ? secondSide : firstSide;
        const summary =
          leading === null
            ? "취업과 창업 중 하나를 사주가 정해 주지는 않아요. 같은 기준으로 비교하면 기준마다 방향이 갈려서, 결정은 현실 조건이 좌우해요."
            : leading === "first"
              ? "취업과 창업 중 하나를 사주가 정해 주지는 않아요. 같은 기준으로 비교하면 조직에 들어가는 쪽의 조건이 더 많이 맞아요."
              : "취업과 창업 중 하나를 사주가 정해 주지는 않아요. 같은 기준으로 비교하면 스스로 일을 꾸리는 쪽의 조건이 더 많이 맞아요.";
        out.add({
          key: "path-compare",
          text: summary,
          hold: leading === null || winners.length - losers.length < 2,
          support: winners.length ? winners.map((item) => evidenceOf(item.name)) : [families],
          counter: losers.map((item) => evidenceOf(item.name)),
          caveats: ["창업 자금, 경력, 고객 확보처럼 입력되지 않은 현실 조건은 판단하지 않았다."],
          detail: { aspect: "취업·이직·창업의 조건 비교", basis: compare.criteria.map((item) => `${item.name}: ${item.reason}`), compare },
        });
      }
      return out.drafts.slice(0, 4);
    },
  };
}

function pathCompare(context: InquiryRuleContext, percents: Readonly<Record<Family, number>>): CompareDetail | null {
  const { peer, output, authority, wealth } = percents;
  const criteria: CompareDetail["criteria"][number][] = [];

  if (authority >= 20 && authority >= peer) {
    criteria.push({ name: "자율성과 업무 구조", leaning: "first", reason: `규칙·역할 기운(${percentText("authority", percents)})이 자기 기준 기운(${percentText("peer", percents)})보다 커서 체계 안에서 안정감을 느끼는 쪽` });
  } else if (peer + output >= 50 && authority <= 12) {
    criteria.push({ name: "자율성과 업무 구조", leaning: "second", reason: `자기 기준과 표현 기운이 합쳐 ${peer + output}%이고 규칙·역할 기운은 ${authority}%라 재량이 필요한 쪽` });
  } else {
    criteria.push({ name: "자율성과 업무 구조", leaning: "neutral", reason: "틀과 재량이 둘 다 필요한 균형형" });
  }

  const band = strengthBand(context.assessment?.strength);
  if (band === "weak") {
    criteria.push({ name: "안정성과 변동성", leaning: "first", reason: "일간의 힘이 약한 편이라 수입 굴곡을 혼자 버티는 부담이 큰 쪽" });
  } else if (band === "strong") {
    criteria.push({ name: "안정성과 변동성", leaning: "second", reason: "일간의 힘이 강한 편이라 변동을 버티는 힘이 있는 쪽" });
  } else if (band === "balanced") {
    criteria.push({ name: "안정성과 변동성", leaning: "neutral", reason: "일간의 힘이 균형 잡힌 편이라 어느 쪽도 크게 기울지 않음" });
  }

  const counts = tenGodCounts(context);
  const indirect = counts["편재"] ?? 0;
  const direct = counts["정재"] ?? 0;
  if (wealth < 10) {
    criteria.push({ name: "돈을 버는 방식", leaning: "first", reason: `재성(${wealth}%)이 약해 돈 관리보다 일 자체에 끌리는 쪽이라, 혼자 운영하면 재무를 맡을 사람이 필요` });
  } else if (indirect > direct) {
    criteria.push({ name: "돈을 버는 방식", leaning: "second", reason: `기회형 재물 표지(편재 ${indirect}개)가 고정형(정재 ${direct}개)보다 많은 쪽` });
  } else if (direct > indirect) {
    criteria.push({ name: "돈을 버는 방식", leaning: "first", reason: `고정형 재물 표지(정재 ${direct}개)가 기회형(편재 ${indirect}개)보다 많아 꾸준한 보상을 선호하는 쪽` });
  }

  if (peer >= 25) {
    criteria.push({ name: "협업과 책임", leaning: "neutral", reason: `자기 기준·동료 기운(${percentText("peer", percents)})이 커서 동업형이라면 지분과 역할 다툼을 특히 조심해야 함` });
  }

  if (criteria.length < 2) return null;
  return { options: ["취업(조직에 들어가는 길)", "창업·독립"], criteria, needs: PATH_COMPARE_NEEDS };
}

// ─── 돈을 다루는 경향 ─────────────────────────────────────────

function wealthRule(sink?: RuleDetailSink): InquiryRule {
  const meta = metadata("wealth");
  return {
    metadata: meta,
    domains: ["wealth"],
    kinds: ["natal"],
    evaluate: (context) => {
      const base = common(context);
      if (!base) return [];
      const { percents, families, partial } = base;
      const out = drafter(meta.ruleId, context, sink, topicGuards(context.evidence, "wealth"));
      const { peer, output, wealth, authority, resource } = percents;
      const counts = tenGodCounts(context);
      const indirect = counts["편재"] ?? 0;
      const direct = counts["정재"] ?? 0;
      const robbers = counts["겁재"] ?? 0;

      const income =
        wealth < 10 && !observedOnlyMissing(context, "wealth")
          ? "detached"
          : output >= 25 && wealth >= 10
            ? "craft"
            : indirect > direct
              ? "opportunity"
              : direct > 0
                ? "steady"
                : null;
      if (income) {
        const reading = WEALTH_INCOME[income];
        const basis =
          income === "craft"
            ? [`${percentText("output", percents)}가 크고 ${percentText("wealth", percents)}로 이어지는 구조`]
            : income === "detached"
              ? [`${percentText("wealth", percents)}로 약함`]
              : [`원국에 편재 ${indirect}개, 정재 ${direct}개`];
        out.add({
          key: "income",
          text: reading.claim,
          hold: partial && (nearThreshold(wealth, 10, 3) || nearThreshold(output, 25, 3)),
          support: [families, pairObservation(context.evidence, "output", "wealth")],
          detail: textDetail("수입 활동과 관련된 특징", reading, basis),
        });
      }

      const keeping = peer >= 25 ? "spend" : authority >= 20 ? "guard" : resource >= 25 ? "learn" : "track";
      const keepingReading = WEALTH_KEEPING[keeping];
      out.add({
        key: "keeping",
        text: keepingReading.claim,
        hold: partial && (nearThreshold(peer, 25, 3) || nearThreshold(authority, 20, 3)),
        support: [families],
        detail: textDetail("돈을 유지하고 쓰는 방식", keepingReading, [percentText("peer", percents), percentText("authority", percents), percentText("resource", percents)]),
      });

      // 비겁이 평균(20%) 근처면 흔한 구조라, 비중이 크거나 겁재가 여럿일 때만 금전 관계의 약점으로 본다.
      const relation = (peer >= 25 && robbers >= 1) || (peer >= 20 && robbers >= 2) ? "leaky" : peer < 15 ? "solo" : null;
      if (relation) {
        const reading = WEALTH_RELATIONS[relation];
        out.add({
          key: "relations",
          text: reading.claim,
          hold: partial && nearThreshold(peer, relation === "leaky" ? 20 : 15, 3),
          support: [families, findJudgment(context.evidence, "m03.wealth.wealth-peer")],
          detail: textDetail(
            "지출·동업·금전 관계에서 살필 점",
            reading,
            relation === "leaky" ? [percentText("peer", percents), `원국에 겁재 ${robbers}개`] : [percentText("peer", percents)],
          ),
        });
      }
      return out.drafts.slice(0, 4);
    },
  };
}

// ─── 연애와 관계 방식 ─────────────────────────────────────────

const COMBINATIONS = ["branch-six-combination", "branch-three-combination", "branch-directional-combination"] as const;

function romanceRule(sink?: RuleDetailSink): InquiryRule {
  const meta = metadata("romance");
  return {
    metadata: meta,
    domains: ["romance"],
    kinds: ["natal"],
    evaluate: (context) => {
      const base = common(context);
      if (!base) return [];
      const { percents, families, partial } = base;
      const out = drafter(meta.ruleId, context, sink, topicGuards(context.evidence, "romance"));
      const { peer, output, authority, resource } = percents;

      const style = output >= 25 ? "direct" : output <= 12 ? "subtle" : "adaptive";
      const charm = (["hamji", "hongyeom"] as const)
        .map((id) => ({ id, entries: shinsalEvidence(context.evidence, id, null) }))
        .filter((item) => item.entries.length);
      const styleReading = ROMANCE_ATTRACTION[style];
      out.add({
        key: "attraction",
        text: [styleReading.claim, ...charm.map((item) => ROMANCE_CHARM_SHINSAL[item.id])].join(" "),
        hold: partial && (nearThreshold(output, 25, 3) || nearThreshold(output, 12, 3)),
        support: [families, ...charm.flatMap((item) => item.entries)],
        caveats: charm.length ? [SHINSAL_CAVEAT] : [],
        detail: textDetail("매력과 표현 방식", styleReading, [percentText("output", percents), ...charm.map((item) => `원국에 ${item.id} 신살 표지`)]),
      });

      const comfortFamily = tenGodFamily(dayBranchTenGod(context));
      if (comfortFamily) {
        const reading = ROMANCE_COMFORT[comfortFamily];
        out.add({
          key: "comfort",
          text: reading.claim,
          support: [families],
          detail: textDetail("편안하게 느끼는 관계", reading, [
            `배우자 자리로 보는 일지의 본기가 ${dayBranchTenGod(context)}(${FAMILY_LABEL[comfortFamily]}: ${FAMILY_MEANING[comfortFamily]})`,
          ]),
        });
      }

      const friction = relationEvidence(context.evidence, { periodId: null, dayBranch: true, types: OPPOSING_RELATIONS });
      const binding = relationEvidence(context.evidence, { periodId: null, dayBranch: true, types: COMBINATIONS });
      const solitude = [...shinsalEvidence(context.evidence, "gosin", null), ...shinsalEvidence(context.evidence, "gwasuk", null)];
      const deepening = friction.length && binding.length ? "push-pull" : friction.length ? "friction" : binding.length ? "binding" : solitude.length ? "solitude" : null;
      if (deepening) {
        const reading = ROMANCE_DEEPENING[deepening];
        const engineJudgments = [findJudgment(context.evidence, "m03.romance.day-opposition"), findJudgment(context.evidence, "m03.romance.day-combination")];
        out.add({
          key: "deepening",
          text: reading.claim,
          support: deepening === "solitude" ? solitude : [...friction, ...binding, ...engineJudgments],
          caveats: [
            ...(deepening === "solitude" ? [SHINSAL_CAVEAT] : ["관계 표지가 있다는 것은 실제 갈등이나 이별을 뜻하지 않는다."]),
            ...(!hourKnown(context) ? ["시주를 몰라 시주와 일지 사이의 관계는 보지 못했다."] : []),
          ],
          detail: textDetail(
            "관계가 깊어지면서 드러나는 약점",
            reading,
            deepening === "solitude" ? ["원국에 고신·과숙 신살 표지"] : [`일지에 걸린 관계 표지: 대립 ${friction.length}개, 합 ${binding.length}개`],
          ),
        });
      }

      const band = strengthBand(context.assessment?.strength);
      const conflict =
        output >= 25 ? "talk" : peer >= 25 ? "stand" : authority >= 20 || resource >= 25 ? "hold" : band === "strong" ? "stand" : band === "weak" ? "hold" : null;
      if (conflict) {
        const reading = ROMANCE_CONFLICT[conflict];
        out.add({
          key: "conflict",
          text: reading.claim,
          hold: partial && nearThreshold(output, 25, 3),
          support: [families, findJudgment(context.evidence, "m01.assessment.strength")],
          detail: textDetail("갈등과 조율 방식", reading, [percentText("output", percents), percentText("peer", percents), percentText("authority", percents)]),
        });
      }
      return out.drafts.slice(0, 4);
    },
  };
}

// ─── 인간관계 ───────────────────────────────────────────────

function socialRule(sink?: RuleDetailSink): InquiryRule {
  const meta = metadata("social");
  return {
    metadata: meta,
    domains: ["social"],
    kinds: ["natal"],
    evaluate: (context) => {
      const base = common(context);
      if (!base) return [];
      const { percents, families, partial } = base;
      const out = drafter(meta.ruleId, context, sink, topicGuards(context.evidence, "social"));
      const { peer, output, authority, resource } = percents;
      const counts = tenGodCounts(context);
      const band = strengthBand(context.assessment?.strength);

      const cooperation = peer >= 25 ? "crew" : peer <= 12 ? "few" : resource >= 25 ? "listener" : "flexible";
      const gwiin = shinsalEvidence(context.evidence, "cheonul-gwiin", null);
      const coopReading = SOCIAL_COOPERATION[cooperation];
      out.add({
        key: "cooperation",
        text: [coopReading.claim, ...(gwiin.length ? [SOCIAL_GWIIN] : [])].join(" "),
        hold: partial && (nearThreshold(peer, 25, 3) || nearThreshold(peer, 12, 3)),
        support: [families, ...gwiin],
        caveats: gwiin.length ? [SHINSAL_CAVEAT] : [],
        detail: textDetail("친구·동료와의 협력", coopReading, [percentText("peer", percents), ...(gwiin.length ? ["원국에 천을귀인 신살 표지"] : [])]),
      });

      const yangin = shinsalEvidence(context.evidence, "yangin", null);
      const robbers = counts["겁재"] ?? 0;
      const competition = (robbers >= 1 && peer >= 25) || (robbers >= 2 && peer >= 20) || yangin.length ? "rival" : peer < 15 ? "yielding" : null;
      if (competition) {
        const reading = SOCIAL_COMPETITION[competition];
        out.add({
          key: "competition",
          text: reading.claim,
          hold: partial && nearThreshold(peer, competition === "rival" ? 25 : 15, 3) && !yangin.length,
          support: [families, ...yangin],
          detail: textDetail("경쟁과 비교", reading, [
            percentText("peer", percents),
            ...((counts["겁재"] ?? 0) > 0 ? [`원국에 겁재 ${counts["겁재"]}개`] : []),
            ...(yangin.length ? ["원국에 양인 신살 표지"] : []),
          ]),
        });
      }

      const recharge = [
        ...shinsalEvidence(context.evidence, "hwagae", null),
        ...shinsalEvidence(context.evidence, "gosin", null),
        ...shinsalEvidence(context.evidence, "gwasuk", null),
      ];
      const boundary = band === "weak" && (resource >= 20 || peer < 15) ? "porous" : recharge.length ? "recharge" : authority >= 20 ? "formal" : null;
      if (boundary) {
        const reading = SOCIAL_BOUNDARY[boundary];
        out.add({
          key: "boundary",
          text: reading.claim,
          support: boundary === "recharge" ? recharge : [families, findJudgment(context.evidence, "m01.assessment.strength")],
          caveats: boundary === "recharge" ? [SHINSAL_CAVEAT] : [],
          detail: textDetail(
            "거리와 경계 설정",
            reading,
            boundary === "recharge" ? ["원국에 화개·고신·과숙 중 하나 이상의 신살 표지"] : [`일간의 힘 ${band ?? "알 수 없음"}`, percentText("resource", percents), percentText("authority", percents)],
          ),
        });
      }

      const conflict =
        (counts["상관"] ?? 0) > 0 && output >= 25 ? "direct" : authority >= 20 ? "procedural" : band === "weak" ? "avoid" : band === "strong" ? "face" : null;
      if (conflict) {
        const reading = SOCIAL_CONFLICT[conflict];
        out.add({
          key: "conflict",
          text: reading.claim,
          hold: partial && conflict !== "avoid" && conflict !== "face" && nearThreshold(conflict === "direct" ? output : authority, conflict === "direct" ? 25 : 20, 3),
          support: [families, findJudgment(context.evidence, "m01.assessment.strength")],
          detail: textDetail("갈등 상황의 반응", reading, [
            ...((counts["상관"] ?? 0) > 0 ? [`원국에 상관 ${counts["상관"]}개`] : []),
            percentText("output", percents),
            percentText("authority", percents),
          ]),
        });
      }
      return out.drafts.slice(0, 4);
    },
  };
}

/**
 * 요청마다 새로 만든다. sink를 넘기면 결론마다 세부 내용을 기록한다.
 * 규칙 자체는 상태를 갖지 않으며, sink는 그 요청에서만 쓰고 버린다.
 */
export function createFirstOverviewRules(sink?: RuleDetailSink): InquiryRule[] {
  return [temperamentRule(sink), strengthsRule(sink), careerRule(sink), wealthRule(sink), romanceRule(sink), socialRule(sink), createTimingRule(sink)];
}

export const FIRST_OVERVIEW_RULES: readonly InquiryRule[] = createFirstOverviewRules();

export function familyLabel(family: string): string {
  return FAMILY_LABEL[family as Family] ?? family;
}
