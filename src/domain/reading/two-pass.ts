/**
 * 메신저 상품(묘묘)의 2-pass 단위와 검사.
 *
 * 단위: 궁금한 점에 대한 답(질문이 있을 때, unitId = 상품의 focusSection.id)과 주제마다 하나 (unitId = topicId). 순서는 화면 순서다.
 * 시작 인사는 첫 단위의 Pass 2가, 마무리는 마지막 단위의 Pass 2가 함께 쓴다 (중립 초안에는 인사·호칭·캐릭터 반응이 없다).
 *
 * - Pass 1 초안(MessengerDraftUnit): 캐릭터 없는 평서문 문단(points). 결론·이유·조건·사용자 상황과의 연결·행동 제안·보존할 조건과 숫자를
 *   충분히 담는다. 검사는 최종 말풍선과 같은 narrationChecker(근거 참조와 소속, 질문 누락, 날짜·비율·금액·확률, 원국 계산값,
 *   창작 장면의 사실화, 범위 밖 질문의 재유입)로 하고, 문단 길이 상한만 말풍선보다 넉넉하게 둔다.
 * - Pass 2 최종(MessengerFinalUnit): 같은 뜻의 캐릭터 말풍선. 1-pass와 같은 narrationChecker 검사에 더해, 초안에 없던 근거·장면·숫자를
 *   더하지 않았는지 본다 (의미 보존, 무진 Pass 2 검사와 같은 기준). 말투·말버릇·감탄사 개수로는 실패시키지 않는다.
 */
import { claimedNumbers, numbersOf } from "./numbers";
import { narrationChecker, type ExcludedQuestion } from "./check";
import type { Persona } from "../personas";
import type { ChartView, NarrationBubble, NarrationPlanV2 } from "./types";

export interface MessengerDraftPoint {
  readonly kind: "explanation" | "creative-scene";
  readonly refs: readonly string[];
  readonly text: string;
}

/** Pass 1 초안 한 단위 (reading_units.draft, 서버 전용). */
export interface MessengerDraftUnit {
  readonly unitId: string;
  /** 이 단위의 핵심 답 한두 문장. */
  readonly coreAnswer: string;
  readonly points: readonly MessengerDraftPoint[];
  /** 이 단위에서 쓴 장면과 핵심 조언의 짧은 요약. 다음 묶음이 되풀이하지 않게 넘기는 내부 메모다. */
  readonly notes: readonly string[];
}

/** Pass 2 최종 한 단위 (reading_sections.content). 화면에는 reading_messages의 말풍선으로 나간다. */
export interface MessengerFinalUnit {
  readonly unitId: string;
  /** 첫 단위만. 그 밖은 빈 문자열. */
  readonly opening: string;
  readonly bubbles: readonly NarrationBubble[];
  /** 마지막 단위만. 그 밖은 빈 문자열. */
  readonly closing: string;
}

export interface MessengerUnit {
  readonly unitId: string;
  readonly kind: "focus" | "topic";
}

/** 화면 순서의 단위 목록. 질문이 없으면 답변 영역 단위가 없다. */
export function messengerUnits(plan: NarrationPlanV2): MessengerUnit[] {
  return [
    ...(plan.questions.length ? [{ unitId: plan.focusSection.id, kind: "focus" as const }] : []),
    ...plan.topics.map((topic) => ({ unitId: topic.topicId, kind: "topic" as const })),
  ];
}

/** 초안 문단을 말풍선 모양으로 읽는다 (검사기를 같이 쓰려고). */
const asBubbles = (points: readonly MessengerDraftPoint[]): NarrationBubble[] =>
  points.map((point) => ({ kind: point.kind, refs: [...point.refs], text: point.text, highlight: "" }));

/** 초안 문단은 말풍선 여러 개로 나뉠 설명이라 말풍선 길이 상한의 세 배까지 둔다. */
const DRAFT_LENGTH_FACTOR = 3;

function checkerFor(plan: NarrationPlanV2, chart: ChartView, excluded: readonly ExcludedQuestion[], persona: Persona, lengthFactor = 1) {
  const sized = lengthFactor === 1 ? plan : { ...plan, length: { ...plan.length, bubbleHardMax: plan.length.bubbleHardMax * lengthFactor } };
  return narrationChecker(sized, chart, excluded, persona);
}

function unitIssues(unit: MessengerUnit, bubbles: readonly NarrationBubble[], checker: ReturnType<typeof narrationChecker>): string[] {
  const issues = unit.kind === "focus" ? checker.focus(bubbles) : checker.topic({ topicId: unit.unitId, bubbles: [...bubbles] });
  issues.push(...checker.excluded(bubbles.map((bubble) => bubble.text)));
  return issues;
}

/**
 * Pass 1 초안 한 단위의 검사. persona는 이 작업의 캐릭터 설정이다 (중립 초안이라 말투는 보지 않는다. 검사기 모양을 맞추려고 넘긴다).
 * 단위 ID, 핵심 답, 문단 형식, 근거 참조와 소속, 질문 누락, 문장 검사, 장면, 범위 밖 질문을 본다.
 */
export function checkMessengerDraft(input: {
  readonly unit: MessengerUnit;
  readonly draft: MessengerDraftUnit;
  readonly plan: NarrationPlanV2;
  readonly chart: ChartView;
  readonly excluded: readonly ExcludedQuestion[];
  readonly persona: Persona;
}): string[] {
  const { unit, draft } = input;
  const issues: string[] = [];
  if (draft.unitId !== unit.unitId) issues.push(`${unit.unitId}: 단위 ID가 계획과 다릅니다 (${draft.unitId.slice(0, 40)}).`);
  if (!draft.coreAnswer.trim()) issues.push(`${unit.unitId}: 핵심 답이 비어 있습니다.`);
  if (!draft.points.length) issues.push(`${unit.unitId}: 설명 문단이 없습니다.`);
  const checker = checkerFor(input.plan, input.chart, input.excluded, input.persona, DRAFT_LENGTH_FACTOR);
  issues.push(...unitIssues(unit, asBubbles(draft.points), checker));
  return [...new Set(issues)];
}

const sceneCount = (items: readonly { readonly kind: string }[]) => items.filter((item) => item.kind === "creative-scene").length;

/**
 * Pass 2 최종 한 단위의 검사. 1-pass와 같은 말풍선 검사(narrationChecker)에 의미 보존 검사를 더한다.
 * remembered: 이미 저장한 다른 단위의 문장 (같은 문장 반복 확인). frame: 이 단위가 시작 인사·마무리를 함께 쓰는지.
 * userTexts: 사용자가 알려 준 사실과 질문 요약 (최종문이 그 숫자를 다시 말해도 새 숫자로 보지 않는다).
 */
export function checkMessengerVoice(input: {
  readonly unit: MessengerUnit;
  readonly final: MessengerFinalUnit;
  readonly draft: MessengerDraftUnit;
  readonly plan: NarrationPlanV2;
  readonly chart: ChartView;
  readonly excluded: readonly ExcludedQuestion[];
  readonly persona: Persona;
  readonly remembered: readonly string[];
  readonly frame: { readonly opening: boolean; readonly closing: boolean };
}): string[] {
  const { unit, final, draft, frame } = input;
  const issues: string[] = [];
  const checker = checkerFor(input.plan, input.chart, input.excluded, input.persona);
  for (const text of input.remembered) checker.remember(text);

  if (frame.opening) issues.push(...checker.frame(final.opening), ...checker.excluded([final.opening]));
  else if (final.opening.trim()) issues.push(`${unit.unitId}: 첫 단위가 아닌데 시작 인사를 썼습니다.`);
  if (frame.closing) issues.push(...checker.frame(final.closing), ...checker.excluded([final.closing]));
  else if (final.closing.trim()) issues.push(`${unit.unitId}: 마지막 단위가 아닌데 마무리를 썼습니다.`);
  issues.push(...unitIssues(unit, final.bubbles, checker));

  // 의미 보존: 초안에 있던 근거만, 초안의 장면 수까지, 초안·사용자 사실에 있던 숫자만 쓴다.
  const draftRefs = new Set(draft.points.flatMap((point) => point.refs));
  for (const bubble of final.bubbles) {
    for (const ref of bubble.refs) if (!draftRefs.has(ref)) issues.push(`${unit.unitId}: 초안에 없던 근거를 참조했습니다 (${ref.slice(0, 20)}).`);
  }
  if (sceneCount(final.bubbles) > sceneCount(draft.points)) issues.push(`${unit.unitId}: 초안에 없던 장면을 더했습니다.`);
  const allowed = numbersOf([
    draft.coreAnswer,
    ...draft.points.map((point) => point.text),
    input.plan.base.nickname,
    ...input.plan.userContext.map((item) => item.text),
    ...input.plan.questions.map((question) => question.summary),
  ]);
  for (const text of [final.opening, final.closing, ...final.bubbles.map((bubble) => bubble.text)]) {
    for (const value of claimedNumbers(text)) if (!allowed.has(value)) issues.push(`${unit.unitId}: 초안에 없던 숫자를 썼습니다 (${value.slice(0, 20)}).`);
  }
  return [...new Set(issues)];
}
