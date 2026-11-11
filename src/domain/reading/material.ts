import type { CompareDetail } from "../rules/common";
import type { InterpretationStatement } from "./types";

/**
 * 작성 재료 3.0.0 (reading-3.0.0, followup-3.0.0부터). 규칙이 만든 해석 묶음을 LLM이 읽을 작성용 메모로 바꾼다.
 *
 * 해석 규칙은 판단 하나마다 존댓말 상담 문장 묶음(판단 문장, 장점, 약점 네 칸, 바꿀 행동)을 만든다.
 * 이 묶음을 칸 순서대로 넘기면 모델은 그대로 반말로 읽어 주기 쉽다 (docs/READING_QUALITY.md 20절, 23절).
 * 그래서 계산값, 판단의 의미, 조건과 근거의 연결은 그대로 두고 종류만 나눠 넘긴다.
 * - chart: 엔진 계산에서 옮긴 원국 근거 (lore)
 * - meaning, status: 서비스가 채택한 해석과 그 확실성 (deferred면 조건부로만 말한다)
 * - why, limits, commonLimits: 판단 이유, 해석마다의 반대 근거·적용 조건·한계, 모든 해석에 걸리는 한계
 * - strength, risk: 장점, 근거 있는 약점 (무엇이, 언제, 그래서 잃는 것)
 * - actions: 서비스가 제안하는 행동. 그 주제의 해석에 딸린 것만 그 주제에 둔다 (for가 해석 ref)
 * 사용자가 알려 준 상황(userContext, situation)과 창작 허용(creativeSceneAllowed)은 입력의 다른 칸에 따로 있다.
 *
 * 같은 근거(why, chart)는 처음 나온 해석에만 넣고, 같은 문장의 행동은 처음 나온 주제에만 둔다.
 * 행동의 횟수·주기(사흘, 일주일, 석 달)는 서비스가 정한 실천 단위다. 계산값이 아니므로 숫자를 바꾸지도, 계산값처럼 표시하지도 않는다.
 * 검사는 이 메모가 아니라 계획 전체의 재료로 하므로, 덜어 낸 근거를 말해도 검사에 걸리지 않는다.
 */
export const WRITING_MATERIAL_VERSION = "material-3.0.0";

export interface WritingRisk {
  /** 무엇이 약점인지. */
  readonly pattern: string;
  /** 어떤 상황에서 나오는지. */
  readonly when: string;
  /** 그래서 무엇을 잃는지. */
  readonly cost: string;
}

export interface WritingReading {
  readonly ref: string;
  readonly aspect: string | null;
  readonly status: InterpretationStatement["status"];
  readonly meaning: string;
  readonly why?: readonly string[];
  readonly chart?: readonly string[];
  readonly strength?: string;
  readonly risk?: WritingRisk;
  /** 이 해석에만 걸리는 반대 근거·예외·한계. */
  readonly limits?: readonly string[];
  readonly compare?: CompareDetail;
}

export interface WritingAction {
  /** 이 행동이 딸린 해석의 ref. 말풍선 refs에 그대로 넣는다. */
  readonly for: string;
  /** fix: 약점을 바꾸는 행동, use: 해석을 생활에 써먹는 행동. */
  readonly kind: "fix" | "use";
  readonly text: string;
}

export interface WritingGroup {
  readonly readings: readonly WritingReading[];
  readonly actions: readonly WritingAction[];
}

export interface WritingMaterial {
  /** 여러 해석에 함께 걸리는 한계. 한 번만 넣는다. */
  readonly commonLimits: readonly string[];
  /** 입력 순서(주제 순서)와 같은 묶음. */
  readonly groups: readonly WritingGroup[];
}

/** groups는 주제 순서대로의 해석 묶음이다 (후속 답변은 묶음 하나). */
export function writingMaterial(groups: readonly (readonly InterpretationStatement[])[]): WritingMaterial {
  const caveatCount = new Map<string, number>();
  for (const statement of groups.flat()) for (const caveat of new Set(statement.caveats)) caveatCount.set(caveat, (caveatCount.get(caveat) ?? 0) + 1);
  const commonLimits = [...caveatCount].filter(([, count]) => count > 1).map(([caveat]) => caveat);
  const shared = new Set(commonLimits);
  const seenChart = new Set<string>();
  const seenWhy = new Set<string>();
  const seenAction = new Set<string>();
  const fresh = (items: readonly string[] | undefined, seen: Set<string>) => {
    const kept = (items ?? []).filter((item) => item.trim() && !seen.has(item));
    for (const item of kept) seen.add(item);
    return kept;
  };

  const reading = (statement: InterpretationStatement): WritingReading => {
    // 비교 해석의 이유는 규칙이 비교 기준(compare.criteria)을 "기준: 이유"로 옮겨 적은 것이라, 비교 기준이 있으면 같은 문장을 두 번 넣지 않는다.
    const fromCompare = new Set(statement.compare?.criteria.map((item) => `${item.name}: ${item.reason}`) ?? []);
    const why = fresh(
      statement.basis?.filter((item) => !fromCompare.has(item)),
      seenWhy,
    );
    const chart = fresh(statement.lore, seenChart);
    const limits = [...(statement.counterNote ? [statement.counterNote] : []), ...statement.caveats.filter((caveat) => !shared.has(caveat))];
    const weakness = statement.weakness;
    return {
      ref: statement.ref,
      aspect: statement.aspect ?? null,
      status: statement.status,
      meaning: statement.text,
      ...(why.length ? { why } : {}),
      ...(chart.length ? { chart } : {}),
      ...(statement.upside ? { strength: statement.upside } : {}),
      ...(weakness ? { risk: { pattern: weakness.what, when: weakness.when, cost: weakness.cost } } : {}),
      ...(limits.length ? { limits } : {}),
      ...(statement.compare ? { compare: statement.compare } : {}),
    };
  };

  const actions = (statements: readonly InterpretationStatement[]): WritingAction[] => {
    const found: WritingAction[] = [];
    for (const statement of statements) {
      const candidates: [WritingAction["kind"], string | undefined][] = [
        ["fix", statement.weakness?.change],
        ["use", statement.action],
      ];
      for (const [kind, text] of candidates) {
        const key = text?.trim();
        if (!key || seenAction.has(key)) continue;
        seenAction.add(key);
        found.push({ for: statement.ref, kind, text: key });
      }
    }
    return found;
  };

  return { commonLimits, groups: groups.map((statements) => ({ readings: statements.map(reading), actions: actions(statements) })) };
}
