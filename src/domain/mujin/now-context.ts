import type { ScrollProductDefinition } from "../products/types";
import type { DraftMaterial } from "./draft";
import {
  FAMILY_OPTIONS,
  RELATIONSHIP_OPTIONS,
  WORK_OPTIONS,
  nowStatus,
  type FamilyId,
  type MujinNow,
  type RelationshipId,
  type WorkId,
} from "./now";

/**
 * '지금의 나'를 작성 계획에 옮긴다 (docs/implementation/mujin/03_INPUT_AND_PERSONALIZATION.md 2~5, 7절).
 * - nowFacts: 사용자가 고른 항목 (user-fact, source now-selection, factKind current). 선택지 뜻과 추정 금지를 caveats로 둔다.
 * - situationNotes: 고른 상황에서 각 장을 볼 관점. 선택지의 의미이며 사용자가 알려 준 사실이 아니다.
 * 원국 판단 재료는 '지금의 나'에 따라 바뀌지 않는다. 관심 장은 설명 비중만 바꾼다.
 * 두 상태를 고르면 선택 순서를 주업 순서로 보지 않고 선택지 목록 순서로 정리한다.
 */

const CATALOG_ORDER = <T extends string>(ids: readonly T[], catalog: readonly { readonly id: string }[]) =>
  [...ids].sort((a, b) => catalog.findIndex((option) => option.id === a) - catalog.findIndex((option) => option.id === b));

/** 일·학업 상태별로 장을 볼 관점. 적지 않은 장은 그 상태의 맥락을 쓰지 않는다. */
const WORK_ANGLES: Readonly<Record<WorkId, Partial<Readonly<Record<string, string>>>>> = {
  student: {
    ch2: "학습·과제·팀 활동에서 배우고 연습하는 방식으로 읽는다",
    ch3: "진로 탐색과 팀 활동에서 맡는 역할로 읽는다",
    ch6: "팀 활동·과제에서 함께하는 관계로 읽는다",
    ch8: "과제와 시험 일정이 몰리는 생활로 읽는다",
  },
  "job-seeking": {
    ch2: "지원 자료·포트폴리오를 만드는 연습으로 읽는다",
    ch3: "공고 고르기·지원 자료·포트폴리오·면접 준비로 읽는다",
    ch4: "준비 기간의 생활 예산과 돈 관리 습관으로 읽는다",
    ch8: "지원 일정과 준비가 몰리는 생활로 읽는다",
  },
  employed: {
    ch3: "업무 범위·역할·평가·협업·보수 협의로 읽는다",
    ch4: "보수 협의와 생활비 관리로 읽는다",
    ch6: "동료·상사와의 협업으로 읽는다",
    ch8: "업무 범위와 일정 조율로 읽는다",
  },
  freelancer: {
    ch3: "견적·계약·수정·납품·정산으로 읽는다",
    ch4: "견적·정산과 돈 관리 습관으로 읽는다",
    ch6: "의뢰인·협업자와 일의 범위를 맞추는 관계로 읽는다",
    ch8: "수정 요청과 납품 일정의 범위 협의로 읽는다",
  },
  business: {
    ch3: "고객·가격·제공 범위·비용·운영으로 읽는다",
    ch4: "가격과 비용을 관리하는 습관으로 읽는다",
    ch6: "고객·거래처·함께 일하는 사람과의 관계로 읽는다",
    ch8: "운영 일정과 일의 분담으로 읽는다",
  },
  resting: {
    ch2: "다음 활동을 위한 배움 탐색으로 읽는다",
    ch3: "생활 일정·목표·다음 활동 탐색으로 읽는다",
    ch8: "생활 일정과 목표를 세우는 방식으로 읽는다",
  },
  other: {
    ch3: "특정 직업을 전제하지 않는 활동으로 읽는다",
    ch8: "특정 직업을 전제하지 않는 생활 일정으로 읽는다",
  },
};

/** 일·학업 상태의 맥락을 쓰는 질문 (nowFacts의 questionIds). */
const WORK_QUESTIONS: Readonly<Record<string, readonly string[]>> = {
  ch2: ["2-3"],
  ch3: ["3-1", "3-2", "3-3", "3-4"],
  ch4: ["4-1", "4-2"],
  ch6: ["6-1", "6-2"],
  ch8: ["8-1", "8-2", "8-3"],
};

const RELATIONSHIP_ANGLES: Readonly<Record<Exclude<RelationshipId, "private">, string>> = {
  single: "지금 관계가 없어도 쓸 수 있는 표현과 관계 방식으로 읽는다",
  seeing: "알아가는 단계의 표현 속도와 확인 방식으로 읽는다",
  dating: "지금 관계 안의 조율과 합의로 읽는다",
  partnered: "함께 사는 생활의 역할·시간·돈 합의로 읽는다",
};

/** 가족 관심별 관점과 추정 금지. 7-4에서 먼저 볼 대화 범주(시간·돈·역할·선택권)를 함께 적는다. */
const FAMILY_ANGLES: Readonly<Record<Exclude<FamilyId, "none" | "private">, { readonly angle: string; readonly avoid: string }>> = {
  expectations: {
    angle: "가족의 기대와 내 선택을 구분하는 관점으로 읽는다. 7-4의 대화는 선택권 범주를 먼저 본다",
    avoid: "가족이 실제로 무엇을 기대하거나 강요한다고 추정하지 않는다",
  },
  distance: {
    angle: "내 시간과 관계의 거리를 정하는 관점으로 읽는다. 7-4의 대화는 시간 범주를 먼저 본다",
    avoid: "가족과 사이가 나쁘다고 추정하지 않는다",
  },
  independence: {
    angle: "독립이나 생활 변화를 준비하는 관점으로 읽는다. 7-4의 대화는 선택권 범주를 먼저 본다",
    avoid: "실제 독립 예정이나 가족 불화로 바꾸지 않는다",
  },
  care: {
    angle: "돌봄과 역할 분담을 나누는 관점으로 읽는다. 7-4의 대화는 역할 범주를 먼저 본다",
    avoid: "아픈 가족이나 자녀가 있다고 추정하지 않는다",
  },
  money: {
    angle: "가족과 돈·지원 이야기를 나누는 관점으로 읽는다. 7-4의 대화는 돈 범주를 먼저 본다",
    avoid: "가족에게 돈 문제가 있거나 지원을 주고받는다고 추정하지 않는다",
  },
};

const FAMILY_QUESTIONS: Readonly<Record<Exclude<FamilyId, "none" | "private">, readonly string[]>> = {
  expectations: ["7-1", "7-4"],
  distance: ["7-3", "7-4"],
  independence: ["7-3", "7-4"],
  care: ["7-2", "7-4"],
  money: ["7-4"],
};

const NO_GUESS = "이 선택 하나로 나이·소득·건강·가족 구성을 추정하지 않는다.";
const ROMANCE_QUESTIONS = ["5-1", "5-2", "5-3", "5-4"] as const;
const FAMILY_ALL_QUESTIONS = ["7-1", "7-2", "7-3", "7-4"] as const;

const workOption = (id: WorkId) => WORK_OPTIONS.find((option) => option.id === id)!;
const relationshipOption = (id: RelationshipId) => RELATIONSHIP_OPTIONS.find((option) => option.id === id)!;
const familyOption = (id: FamilyId) => FAMILY_OPTIONS.find((option) => option.id === id)!;

/** 사용자가 고른 '지금의 나' 항목. 미응답(빈 칸)은 사실이 아니므로 넣지 않고 situationNotes에만 남긴다. */
export function buildNowFacts(now: MujinNow, product: ScrollProductDefinition): DraftMaterial[] {
  const facts: DraftMaterial[] = [];
  const add = (key: string, questionIds: readonly string[], text: string, caveats: readonly string[]) =>
    facts.push({ key: `now:${key}`, kind: "user-fact", questionIds, text, scope: "user", source: "now-selection", factKind: "current", caveats });

  for (const id of CATALOG_ORDER(now.work, WORK_OPTIONS)) {
    const option = workOption(id);
    const questions = Object.keys(WORK_ANGLES[id]).flatMap((sectionId) => WORK_QUESTIONS[sectionId] ?? []);
    add(`work:${id}`, questions, `사용자가 고른 지금의 일·학업 상태: ${option.label}`, [
      `선택지의 맥락: ${option.context}`,
      `${option.avoid}.`,
      NO_GUESS,
      ...(now.work.length > 1 ? ["두 상태를 함께 골랐다. 선택 순서를 주업 순서로 보지 않는다."] : []),
    ]);
  }

  for (const id of CATALOG_ORDER(now.interests, product.scroll.sections)) {
    const section = product.scroll.sections.find((item) => item.id === id);
    if (!section) continue;
    add(
      `interest:${id}`,
      section.questions.map((question) => question.id),
      `사용자가 더 자세히 보고 싶다고 고른 장: ${section.title}`,
      ["관심은 설명 비중만 바꾸며 사주 판단의 강도를 바꾸지 않는다."],
    );
  }

  if (now.relationship) {
    const option = relationshipOption(now.relationship);
    add(
      `relationship:${option.id}`,
      ROMANCE_QUESTIONS,
      option.id === "private" ? "관계 상태는 답하고 싶지 않다고 했다" : `사용자가 고른 관계 상태: ${option.label}`,
      [`${option.avoid}.`, "상대방의 속마음은 알 수 있는 사실로 다루지 않는다."],
    );
  }

  for (const id of CATALOG_ORDER(now.family, FAMILY_OPTIONS)) {
    const option = familyOption(id);
    if (id === "none") {
      add("family:none", FAMILY_ALL_QUESTIONS, "가족 이야기에서 특별히 다루고 싶은 내용이 없다고 했다", [
        "가족 구성이나 관계를 추정하지 않는다.",
      ]);
    } else if (id === "private") {
      add("family:private", FAMILY_ALL_QUESTIONS, "가족 이야기는 답하고 싶지 않다고 했다", ["가족을 캐묻거나 가족 구성·관계를 추정하지 않는다."]);
    } else {
      add(`family:${id}`, FAMILY_QUESTIONS[id], `사용자가 고른 가족 이야기 관심: ${option.label} (다룰 주제이며 실제 사건이 아니다)`, [
        `${FAMILY_ANGLES[id].avoid}.`,
        "가족 관심 선택은 실제 사건이 아니다.",
      ]);
    }
  }
  return facts;
}

/** 섹션별 situationNotes. 같은 문장은 한 번만 넣는다. */
export function buildSituationNotes(now: MujinNow): ReadonlyMap<string, readonly string[]> {
  const notes = new Map<string, string[]>();
  const push = (sectionId: string, note: string) => {
    const list = notes.get(sectionId) ?? [];
    if (!list.includes(note)) list.push(note);
    notes.set(sectionId, list);
  };
  const status = nowStatus(now);

  const work = CATALOG_ORDER(now.work, WORK_OPTIONS);
  if (status.work === "unanswered") {
    push("ch3", "일·학업 상태는 고르지 않았다: 직업·소속·소득·나이를 가정하지 않고, 상황 예시는 가정형으로 쓴다.");
  }
  for (const id of work) {
    const option = workOption(id);
    for (const [sectionId, angle] of Object.entries(WORK_ANGLES[id])) {
      push(sectionId, `일·학업 상태 '${option.label}': ${angle}. ${option.avoid}.`);
    }
  }
  if (work.length > 1) {
    const shared = Object.keys(WORK_ANGLES[work[0]!]).filter((sectionId) => work.slice(1).some((id) => sectionId in WORK_ANGLES[id]));
    for (const sectionId of shared) push(sectionId, "일·학업 상태를 두 가지 골랐다: 어느 쪽이 주업인지 정하지 않고, 질문에 더 맞는 상태의 맥락만 쓴다.");
  }

  if (status.relationship === "unanswered") {
    push("ch5", "관계 상태는 고르지 않았다: 연애 중인지, 결혼했는지 가정하지 않고 어떤 관계에도 쓸 수 있는 방식으로 쓴다.");
  } else if (status.relationship === "private") {
    push("ch5", "관계 상태는 답하고 싶지 않다고 했다: 관계 상태를 추정하거나 캐묻지 않고 어떤 관계에도 쓸 수 있는 방식으로 쓴다.");
  } else if (now.relationship && now.relationship !== "private") {
    const option = relationshipOption(now.relationship);
    push("ch5", `관계 상태 '${option.label}': ${RELATIONSHIP_ANGLES[now.relationship]}. ${option.avoid}.`);
  }

  if (status.family === "unanswered") {
    push("ch7", "가족 관심은 고르지 않았다: 가족 구성(부모·형제·배우자·자녀)과 관계를 가정하지 않는다.");
  } else if (status.family === "private") {
    push("ch7", "가족 이야기는 답하고 싶지 않다고 했다: 가족을 캐묻거나 추정하지 않고 본인의 선택과 경계 중심으로 쓴다.");
  } else if (status.family === "none") {
    push("ch7", "가족 이야기에서 특별히 다루고 싶은 내용이 없다고 했다: 가족 구성이나 관계를 추정하지 않고 본인의 선택과 경계 중심으로 짧게 쓴다.");
  } else {
    for (const id of CATALOG_ORDER(now.family, FAMILY_OPTIONS)) {
      if (id === "none" || id === "private") continue;
      push("ch7", `가족 이야기 관심 '${familyOption(id).label}': ${FAMILY_ANGLES[id].angle}. ${FAMILY_ANGLES[id].avoid}.`);
    }
    push("ch7", "가족 관심은 다룰 주제이며 실제 사건이 아니다.");
  }

  for (const id of now.interests) push(id, "관심 장으로 골랐다: 설명을 더 자세히 하되 판단의 강도는 바꾸지 않는다.");
  return notes;
}
