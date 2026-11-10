import type { InquiryConclusionDraft, InquiryEvidence, InquiryRuleContext } from "sajuengine";
import { GUARD_CAVEAT, OUTCOME_CAVEAT, PARTIAL_CAVEAT, detailKey, type RuleDetail, type RuleDetailSink } from "./common";
import { familyPercents, findJudgment, isPartial, rankFamilies, uniqueIds, type Family } from "./materials";
import type { ReadingText } from "./natal-tables";

/**
 * 규칙이 결론 초안을 만들 때 쓰는 공통 도우미. 근거 ID 정리, 공통 한계 문장, 세부 내용 기록을 한곳에서 한다.
 * 첫 상품의 원국 규칙(first-overview.ts)과 생활 주제 규칙(life.ts)이 함께 쓴다.
 */

export interface Drafter {
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

export function drafter(ruleId: string, context: InquiryRuleContext, sink: RuleDetailSink | undefined, guards: readonly InquiryEvidence[]): Drafter {
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

export function textDetail(aspect: string, reading: ReadingText, basis: readonly string[], extra: Partial<RuleDetail> = {}): RuleDetail {
  return {
    aspect,
    basis,
    ...(reading.upside ? { upside: reading.upside } : {}),
    ...(reading.weakness ? { weakness: reading.weakness } : {}),
    ...(reading.action ? { action: reading.action } : {}),
    ...extra,
  };
}


export interface Common {
  readonly percents: Readonly<Record<Family, number>>;
  readonly families: InquiryEvidence;
  readonly ranked: readonly Family[];
  readonly partial: boolean;
}

export function common(context: InquiryRuleContext): Common | null {
  const percents = familyPercents(context);
  const families = findJudgment(context.evidence, "m01.assessment.families");
  if (!percents || !families) return null;
  return { percents, families, ranked: rankFamilies(percents), partial: isPartial(context) };
}

