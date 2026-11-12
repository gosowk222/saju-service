/**
 * 무진 족자 화면의 상태 규칙. 화면 컴포넌트와 단위 테스트가 함께 쓰는 순수 함수만 둔다.
 *
 * - 상태는 서버 저장 상태(ScrollStateView)만 근거로 보여 준다. 진행률, 남은 시간, 연출용 지연은 만들지 않는다.
 * - 늦게 도착한 확인 결과가 이미 완성된 장이나 끝난 단계를 되돌리지 않게 합친다.
 * - 장 순서는 서버가 준 목차 순서 그대로다. 뒤 장이 먼저 끝나도 순서를 바꾸지 않는다.
 */

import type { ReadingStateView } from "@/server/readings/store";
import type {
  MonthDomain,
  MonthTone,
  MujinLuck,
  MujinLuckPeriod,
  MujinMonths,
  NatalStageCell,
  PhaseStatus,
  ScrollPhaseView,
  ScrollSectionView,
  ScrollStateView,
  ScrollTier,
  SectionViewState,
} from "@/domain/mujin/types";
import type { PersonaIntakeLines } from "@/domain/personas";

/** 생성 중에는 장이 완성될 때마다 저장되므로 자주 확인한다 (메신저와 같은 주기). */
export const POLL_INTERVAL_MS = 2000;
/** 후속 답변은 문단이 짧아 더 자주 확인한다 (메신저와 같은 주기). */
export const FOLLOWUP_POLL_INTERVAL_MS = 1500;
/** 연결이 끊겼거나 다른 요청이 이미 쓰는 중일 때, 같은 단계를 바로 다시 요청하지 않고 기다리는 시간. */
export const GENERATE_COOLDOWN_MS = 6000;
/** 서버가 아직 시작할 차례가 아니라고 했을 때(not_ready) 다시 물어보기까지 기다리는 시간. */
export const NOT_READY_RETRY_MS = 30_000;

/** POST /api/readings/{id}/scroll/generate의 결과. */
export type GenerateResult = "completed" | "running" | "partial" | "failed" | "exhausted" | "locked" | "daily_limited" | "not_ready";

/**
 * 화면이 한 단계를 스스로 다시 요청하지 않는 이유.
 * cooldown: 잠시 뒤 다시 요청(연결 끊김, 다른 요청이 쓰는 중). 그동안도 진행 중으로 본다.
 * not_ready: 서버가 아직 시작할 차례가 아니라고 함. 진행 중으로 보지 않고 한참 뒤에 다시 물어본다.
 * 나머지는 사용자가 다시 시도하거나 화면을 새로 열 때까지 멈춘다.
 */
export type HaltReason = "cooldown" | "not_ready" | "failed" | "exhausted" | "locked" | "daily_limited" | "error";

/** 스스로 풀리는 멈춤과 그 시간. 나머지 멈춤은 풀리지 않는다. */
export function haltDuration(reason: HaltReason): number | null {
  if (reason === "cooldown") return GENERATE_COOLDOWN_MS;
  if (reason === "not_ready") return NOT_READY_RETRY_MS;
  return null;
}

export interface DriverContext {
  /** 이 화면이 보낸 생성 요청이 아직 열려 있는 단계. */
  readonly inFlight: Readonly<Record<ScrollTier, boolean>>;
  readonly halted: Readonly<Record<ScrollTier, HaltReason | null>>;
  /** 서버가 시간 예산이 끝나 남은 일이 있다고 알려(partial) 바로 다시 요청할 단계. */
  readonly rerun?: Readonly<Record<ScrollTier, boolean>>;
}

export const IDLE_CONTEXT: DriverContext = { inFlight: { free: false, paid: false }, halted: { free: null, paid: null } };

export function phaseActive(status: PhaseStatus): boolean {
  return status === "queued" || status === "running";
}

const TIERS: readonly ScrollTier[] = ["free", "paid"];

function phaseOf(state: ScrollStateView, tier: ScrollTier): ScrollPhaseView {
  return tier === "free" ? state.free : state.paid;
}

/** 이 단계의 칸 가운데 오류(failed)로 보이는 칸이 있는가. 오류 칸은 그 안에서 다시 시도 버튼이나 문의 안내를 보여 준다. */
function hasFailedSection(state: ScrollStateView, tier: ScrollTier): boolean {
  return state.sections.some((section) => section.tier === tier && section.state === "failed");
}

/** 단계 단위 안내에서 무엇을 마치지 못했는지 (화면 문구의 목적어). */
const PHASE_SUBJECT: Readonly<Record<ScrollTier, string>> = { free: "무료 부분을", paid: "이어지는 장을" };

/** 이 단계가 아직 진행될 차례인가 (요청 중, 서버에서 진행 중, 또는 시작 전이면서 멈추지 않음). */
function phaseMoving(state: ScrollStateView, tier: ScrollTier, context: DriverContext): boolean {
  if (tier === "paid" && !state.entitled) return false;
  const phase = phaseOf(state, tier);
  if (context.inFlight[tier] || context.rerun?.[tier]) return true;
  if (context.halted[tier] && context.halted[tier] !== "cooldown") return false;
  return phaseActive(phase.status) || phase.status === "idle";
}

/** 원국표는 계산값만 있는 칸이다. 글로 쓰는 칸만 센다. */
function writtenSections(state: ScrollStateView): readonly ScrollSectionView[] {
  return state.sections.filter((section) => section.kind !== "chart");
}

/** 원국표를 뺀 무료 칸 가운데 하나라도 완성되었는가. 족자가 처음 펼쳐지는 조건이다. */
export function firstFreeReady(state: ScrollStateView): boolean {
  return writtenSections(state).some((section) => section.tier === "free" && section.state === "done");
}

/**
 * 족자 본문을 보여 줄 때인가. 첫 무료 칸이 완성되었거나, 무료 단계가 더 진행되지 않을 때(실패·멈춤·이미 끝남)다.
 * 그 전에는 상담 장면만 보여 준다 (책상 위 종이가 족자로 펼쳐지기 전).
 */
export function scrollVisible(state: ScrollStateView, context: DriverContext): boolean {
  return firstFreeReady(state) || !phaseMoving(state, "free", context);
}

/**
 * 지금 스스로 생성 요청을 보낼 단계. 무료 단계를 먼저 쓰고, 유료 단계는 권한이 있고 무료 단계가 더 진행되지 않을 때 시작한다.
 * 시작 전(idle)이거나 서버가 다시 시작할 차례(queued)라고 한 단계, 직전 요청이 partial로 끝난 단계만 요청한다.
 * 실패한 단계는 사용자가 다시 시도할 때만 요청한다.
 */
export function decideGenerate(state: ScrollStateView, context: DriverContext): ScrollTier | null {
  const startable = (tier: ScrollTier) => {
    if (context.inFlight[tier] || context.halted[tier]) return false;
    if (context.rerun?.[tier]) return true;
    const phase = phaseOf(state, tier);
    return phase.status === "idle" || phase.status === "queued";
  };
  if (startable("free")) return "free";
  if (state.entitled && startable("paid") && !phaseMoving(state, "free", context)) return "paid";
  return null;
}

/**
 * 저장 상태를 주기적으로 받을 때인가. 이 화면의 생성 요청이 열려 있거나, 서버가 어떤 단계를 쓰는 중(running)이라고 할 때만 받는다.
 * 시작 전·대기(queued)·멈춤 상태에서는 받지 않는다 (곧 다시 요청하면 그 요청이 열려 있는 동안 받는다).
 */
export function shouldPoll(state: ScrollStateView, context: DriverContext): boolean {
  if (context.inFlight.free || context.inFlight.paid) return true;
  return state.free.status === "running" || (state.entitled && state.paid.status === "running");
}

/** 생성 요청 결과에 따라 화면이 할 일. rerun: 같은 단계를 바로 다시 요청, halt: 스스로 다시 요청하지 않음. */
export function afterGenerate(result: GenerateResult): { readonly rerun: boolean; readonly halt: HaltReason | null } {
  switch (result) {
    case "partial":
      // 서버의 시간 예산이 끝나 남은 일이 있다. 이어서 요청한다.
      return { rerun: true, halt: null };
    case "completed":
      return { rerun: false, halt: null };
    case "running":
      // 다른 요청(다른 탭 등)이 이미 쓰는 중이다. 저장 상태를 받다가 잠시 뒤 다시 확인한다.
      return { rerun: false, halt: "cooldown" };
    case "not_ready":
      return { rerun: false, halt: "not_ready" };
    case "failed":
      return { rerun: false, halt: "failed" };
    case "exhausted":
      return { rerun: false, halt: "exhausted" };
    case "locked":
      return { rerun: false, halt: "locked" };
    case "daily_limited":
      return { rerun: false, halt: "daily_limited" };
  }
}

/** 단계가 끝난 상태(completed)는 늦게 도착한 이전 결과로 되돌리지 않는다. */
function keepPhase<T extends ScrollPhaseView>(current: T, next: T): T {
  return current.status === "completed" && next.status !== "completed" ? current : next;
}

/**
 * 주기 확인 결과를 지금 상태에 합친다. 이미 완성된 장(done)과 끝난 단계는 늦게 도착한 이전 결과로 되돌리지 않는다.
 * 목차 순서는 서버가 준 순서를 따른다.
 */
export function mergeScrollState(current: ScrollStateView, next: ScrollStateView): ScrollStateView {
  if (current.readingId !== next.readingId) return current;
  const known = new Map(current.sections.map((section) => [section.id, section] as const));
  return {
    ...next,
    entitled: current.entitled || next.entitled,
    free: keepPhase(current.free, next.free),
    paid: keepPhase(current.paid, next.paid),
    sections: next.sections.map((section) => {
      const before = known.get(section.id);
      return before?.state === "done" && before.content && section.state !== "done" ? before : section;
    }),
    timing: next.timing ?? current.timing,
  };
}

/**
 * 다시 시도를 누른 직후의 화면 상태. 그 단계의 실패한 칸을 대기로 돌리고 다시 시도 버튼을 감춘다.
 * 실제 작성 중 표시는 서버가 그 칸을 쓰기 시작했다고 알려 줄 때만 한다.
 */
export function markRetrying(state: ScrollStateView, tier: ScrollTier): ScrollStateView {
  const retrying = <T extends ScrollPhaseView>(phase: T): T => ({ ...phase, status: "running", canRetry: false, errorCode: null });
  return {
    ...state,
    free: tier === "free" ? retrying(state.free) : state.free,
    paid: tier === "paid" ? retrying(state.paid) : state.paid,
    sections: state.sections.map((section) => (section.tier === tier && section.state === "failed" ? { ...section, state: "waiting" } : section)),
  };
}

/** 전체 풀이가 끝났는가. 후속 질문과 PDF는 이때 연다 (서버도 같은 조건을 다시 확인한다). */
export function readingComplete(state: ScrollStateView): boolean {
  return state.entitled && state.paid.status === "completed" && writtenSections(state).every((section) => section.state === "done");
}

export type SceneMode = "idle" | "computing" | "writing" | "reading";

export interface SceneStatus {
  /** 상담 장면의 상태 (영상을 받으면 상태별 영상을 고르는 데 쓴다). */
  readonly mode: SceneMode;
  /** 무진이 하는 말 (캐릭터 설정의 lines.intake 키). 보여 줄 말이 없으면 null. */
  readonly line: keyof PersonaIntakeLines | null;
  /** 장면 위 상태 표시 (화면 문구). 실제 저장 상태로만 정한다. */
  readonly badge: string | null;
}

/**
 * 상담 장면의 상태. 실제 저장 상태만 근거로 한다.
 * - 계산 중: 생성이 진행 중인데 아직 완성된 칸도, 작성 중인 칸도 없을 때.
 * - 작성 중: 실제로 쓰는 중(writing)인 칸이 있을 때.
 * - 완료: 그 단계가 끝났을 때. 연출을 위해 완료 표시를 늦추지 않는다.
 * - 실패: 오류 칸이 있거나 단계가 실패했을 때. 다시 시도할 수 있을 때만 '다시 시도 필요'라고 하고,
 *   무진의 '이 장만 다시 쓴다'는 말(sectionFailed)은 다시 시도할 수 있는 오류 칸이 있을 때만 쓴다.
 */
export function sceneStatus(state: ScrollStateView, context: DriverContext): SceneStatus {
  const sections = writtenSections(state);
  const writing = sections.filter((section) => section.state === "writing");
  if (writing.some((section) => section.tier === "free")) return { mode: "writing", line: "writingFree", badge: "작성 중" };
  if (writing.length > 0) return { mode: "writing", line: "writingPaid", badge: "작성 중" };

  const freeMoving = phaseMoving(state, "free", context);
  const paidMoving = phaseMoving(state, "paid", context);
  const anyDone = sections.some((section) => section.state === "done");
  if ((freeMoving || paidMoving) && !anyDone) return { mode: "computing", line: "computing", badge: "계산 중" };
  // 다음 묶음을 준비하는 짧은 사이. 쓰는 칸이 아직 없으므로 '작성 중'이라고 하지 않는다.
  if (freeMoving) return { mode: "writing", line: "writingFree", badge: "다음 장 준비 중" };
  if (paidMoving) return { mode: "writing", line: "writingPaid", badge: "다음 장 준비 중" };

  const failing = TIERS.filter(
    (tier) => (tier === "free" || state.entitled) && (hasFailedSection(state, tier) || phaseOf(state, tier).status === "failed"),
  );
  if (failing.length > 0) {
    if (failing.some((tier) => hasFailedSection(state, tier) && phaseOf(state, tier).canRetry)) {
      return { mode: "reading", line: "sectionFailed", badge: "다시 시도 필요" };
    }
    // 단계만 실패하고 오류 칸이 없을 때는 족자 위 단계 안내가 다시 시도 버튼을 보여 준다.
    if (failing.some((tier) => phaseOf(state, tier).canRetry)) return { mode: "reading", line: null, badge: "다시 시도 필요" };
    return { mode: "reading", line: null, badge: "문의 필요" };
  }
  if (state.entitled && state.paid.status === "completed") return { mode: "reading", line: "paidDone", badge: "완료" };
  if (!state.entitled && state.free.status === "completed") return { mode: "reading", line: "freeDone", badge: "무료 부분 완료" };
  return { mode: "reading", line: null, badge: null };
}

export type BadgeTone = "neutral" | "progress" | "success" | "danger" | "warning";

/** 목차와 본문의 칸 상태 표시 (화면 문구). 완료는 디자인 시스템의 완료 배지(gray)로 쓴다. */
export function sectionBadge(state: SectionViewState): { readonly label: string; readonly tone: BadgeTone } {
  switch (state) {
    case "locked":
      return { label: "잠김", tone: "neutral" };
    case "waiting":
      return { label: "대기", tone: "neutral" };
    case "writing":
      return { label: "작성 중", tone: "progress" };
    case "failed":
      return { label: "오류", tone: "danger" };
    case "done":
      return { label: "완료", tone: "neutral" };
  }
}

/** 목차와 장 머리의 작은 표시 (기초, 1장, 정리). */
export function sectionEyebrow(section: Pick<ScrollSectionView, "kind" | "number">): string {
  if (section.kind === "chapter" && section.number !== null) return `${section.number}장`;
  if (section.kind === "closing") return "정리";
  return "기초";
}

/** 머리글에 보여 줄 현재 위치 이름 (예: 3장 직업과 사회생활). */
export function sectionLabel(section: Pick<ScrollSectionView, "kind" | "number" | "title">): string {
  return section.kind === "chapter" && section.number !== null ? `${section.number}장 ${section.title}` : section.title;
}

export function anchorId(sectionId: string): string {
  return `section-${sectionId}`;
}

/**
 * 단계 오류 코드의 안내 (화면 문구). subject는 무엇을 마치지 못했는지다 (오류 칸은 '이 장을', 족자 위 단계 안내는 '무료 부분을' 등).
 * 모르는 코드는 일반 안내를 쓴다. 문의 안내는 retryGuide가 붙인다.
 */
export function phaseErrorText(errorCode: string | null, subject = "이 장을"): string {
  switch (errorCode) {
    case "rate_limited":
      return `요청이 몰려 ${subject} 마치지 못했어요.`;
    case "timeout":
      return `${subject} 쓰는 데 시간이 너무 오래 걸렸어요.`;
    case "attempts_exhausted":
      return `여러 번 시도했지만 ${subject} 마치지 못했어요.`;
    default:
      return `일시적인 문제로 ${subject} 마치지 못했어요.`;
  }
}

/**
 * 다시 시도해도 같은 결과인 설정·버전 오류 (서버 실행기가 재시도 불가로 남기는 코드). 시도 횟수를 다 쓴 실패와 안내를 나눈다.
 * 여기에 없는 코드로 다시 시도할 수 없으면 횟수를 다 쓴 것으로 안내한다 (장 시도 수 소진 units_failed, 시작 상한 attempts_exhausted 등).
 */
const UNRECOVERABLE_ERROR_CODES: ReadonlySet<string> = new Set([
  "prompt_version_unavailable",
  "plan_version_unavailable",
  "model_not_configured",
  "persona_unavailable",
  "plan_section_missing",
  "unknown_section",
  "timing_too_large",
  "live_call_blocked",
  "model_not_found",
  "permission_denied",
  "auth_failed",
  "bad_request",
]);

/** 실패 뒤 할 수 있는 일 (화면 문구). 다시 시도 버튼은 phase.canRetry일 때만 보인다. */
export function retryGuide(phase: ScrollPhaseView): string {
  if (phase.canRetry) return "다시 시도하면 마치지 못한 장만 다시 쓰고, 이미 쓴 장은 그대로 둬요.";
  if (phase.errorCode && UNRECOVERABLE_ERROR_CODES.has(phase.errorCode)) return "지금은 이어서 쓸 수 없어요. 고객센터로 문의해 주세요.";
  return "다시 시도할 수 있는 횟수를 모두 썼어요. 고객센터로 문의해 주세요.";
}

/** 오류 칸과 단계 단위 실패 안내 (화면 문구): 이유 + 할 수 있는 일. */
export function failureText(phase: ScrollPhaseView, subject = "이 장을"): string {
  return `${phaseErrorText(phase.errorCode, subject)} ${retryGuide(phase)}`;
}

/**
 * 단계가 스스로 멈춘 이유의 안내 (화면 문구). 안내할 것이 없으면 null.
 * failed는 그 단계의 저장 상태(phase)로 문구를 고른다: 다시 시도할 수 있으면 오류 칸의 버튼으로, 없으면 문의로 안내한다.
 * 저장 상태가 아직 실패가 아니면(실패를 기록하기 전, 점유 시간이 남음) 잠시 뒤 다시 열면 이어서 쓴다.
 */
export function haltText(reason: HaltReason | null, tier: ScrollTier, phase?: ScrollPhaseView): string | null {
  switch (reason) {
    case "failed":
      if (phase?.status !== "failed") return `${PHASE_SUBJECT[tier]} 쓰다가 멈췄어요. 잠시 뒤 이 화면을 다시 열어 주세요.`;
      return phase.canRetry
        ? `${PHASE_SUBJECT[tier]} 쓰다가 멈췄어요. 오류가 난 장에서 다시 시도할 수 있어요.`
        : `${PHASE_SUBJECT[tier]} 다 쓰지 못하고 멈췄어요. 고객센터로 문의해 주세요.`;
    case "daily_limited":
      return "오늘 시작할 수 있는 무료 풀이를 모두 썼어요. 내일 이 화면을 다시 열면 이어서 씁니다.";
    case "exhausted":
      // 시작 횟수 상한에 닿은 단계는 다시 열어도 이어서 쓰지 않는다.
      return tier === "free"
        ? "여러 번 시도했지만 무료 부분을 마치지 못했어요. 고객센터로 문의해 주세요."
        : "여러 번 시도했지만 이어지는 장을 마치지 못했어요. 이용권이나 결제는 이 풀이에 그대로 남아 있으니 고객센터로 문의해 주세요.";
    case "locked":
      return tier === "paid" ? "이어지는 장은 이용권이나 결제로 받은 뒤에 씁니다." : null;
    case "not_ready":
      return tier === "paid" ? "앞의 무료 부분을 마친 뒤에 이어지는 장을 쓰기 시작해요. 잠시 뒤 다시 확인할게요." : "풀이를 준비하고 있어요. 잠시 뒤 다시 확인할게요.";
    default:
      return null;
  }
}

/** 족자 위 단계 안내 하나. danger는 단계 단위 실패이고, retry면 그 단계를 다시 시도하는 버튼을 함께 둔다. */
export interface PhaseAlert {
  readonly tier: ScrollTier;
  readonly tone: "warning" | "danger";
  readonly text: string;
  readonly retry: boolean;
}

/**
 * 족자 위(상담 장면 아래)에 보여 줄 단계 안내. 권한이 없으면 유료 단계는 안내하지 않는다.
 * - 단계가 실패했는데 오류 칸이 하나도 없으면(모든 칸이 완성된 뒤 마무리 실패, 이전 응답 등) 이 안내가 실패 이유와 다시 시도 버튼을 맡는다.
 *   그러지 않으면 화면에 다시 시도할 곳이 없어 생성이 멈춘다. 이때는 멈춘 이유 안내를 따로 두지 않는다 (같은 내용).
 * - 그 밖에는 이 화면이 스스로 멈춘 이유(haltText)를 알린다. 오류 칸이 있으면 다시 시도 버튼은 오류 칸에 있다.
 */
export function phaseAlerts(state: ScrollStateView, context: DriverContext): PhaseAlert[] {
  return TIERS.flatMap((tier): PhaseAlert[] => {
    if (tier === "paid" && !state.entitled) return [];
    const phase = phaseOf(state, tier);
    if (phase.status === "failed" && !hasFailedSection(state, tier)) {
      return [{ tier, tone: "danger", text: failureText(phase, PHASE_SUBJECT[tier]), retry: phase.canRetry }];
    }
    const text = haltText(context.halted[tier], tier, phase);
    return text ? [{ tier, tone: "warning", text, retry: false }] : [];
  });
}

/**
 * 연결이 끊겼을 때의 안내 (화면 문구). 생성 요청 하나는 서버의 시간 예산 안에서만 쓰고, 그 뒤에는 이 화면이 다시 요청해야
 * 이어서 쓴다. 그래서 서버가 계속 쓰고 있다고 약속하지 않는다.
 */
export const CONNECTION_LOST_TEXT = "인터넷 연결이 끊겼어요. 다 쓴 장은 저장되어 있으니, 연결되면 이어서 보여 드리고 남은 장도 이어서 쓸게요.";

// ── 후속 질문 ─────────────────────────────────────────────

export interface FollowupSnapshot {
  readonly followups: ReadingStateView["followups"];
  readonly questionsUsed: number;
  readonly questionLimit: number;
}

export function followupSnapshotOf(state: Pick<ReadingStateView, "followups" | "questionsUsed" | "questionLimit">): FollowupSnapshot {
  return { followups: state.followups, questionsUsed: state.questionsUsed, questionLimit: state.questionLimit };
}

/** 늦게 도착한 이전 확인 결과가 이미 끝난 답을 '쓰는 중'으로 되돌리거나 쓴 횟수를 줄이지 않게 합친다. */
export function mergeFollowups(current: FollowupSnapshot | null, next: FollowupSnapshot): FollowupSnapshot {
  if (!current) return next;
  return {
    questionLimit: next.questionLimit,
    questionsUsed: Math.max(current.questionsUsed, next.questionsUsed),
    followups: next.followups.map((followup) => {
      const known = current.followups.find((item) => item.id === followup.id);
      return known && known.status !== "answering" && followup.status === "answering" ? known : followup;
    }),
  };
}

/** 후속 답변은 빈 줄로 나눈 문단마다 보여 준다. 저장된 답변은 그대로다. */
export function paragraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter(Boolean);
}

// ── 표 ─────────────────────────────────────────────────────

export type PositionKey = NatalStageCell["position"];

/** 원국표(ChartTable)와 같은 순서: 시주, 일주, 월주, 연주. */
export const POSITION_ORDER: readonly PositionKey[] = ["hour", "day", "month", "year"];
export const POSITION_LABEL: Readonly<Record<PositionKey, string>> = { hour: "시주", day: "일주", month: "월주", year: "연주" };

/** 칸을 원국표 순서로 놓는다. 계산되지 않은 자리(시각 미상의 시주)는 null이다. */
export function byPosition<T extends { readonly position: PositionKey }>(cells: readonly T[]): (T | null)[] {
  return POSITION_ORDER.map((position) => cells.find((cell) => cell.position === position) ?? null);
}

export const STAGE_BASIS_LABEL: Readonly<Record<NatalStageCell["basis"], string>> = {
  "day-master": "일간 기준",
  self: "그 기둥의 천간 기준",
};

/** 표에 나온 12운성 기준. 일간 기준을 먼저, 자좌(그 기둥의 천간 기준)를 다음에 둔다. */
export function stageBasesOf(cells: readonly NatalStageCell[]): NatalStageCell["basis"][] {
  return (["day-master", "self"] as const).filter((basis) => cells.some((cell) => cell.basis === basis));
}

/** 한 자리·한 기준의 12운성 칸. */
export function stageAt(cells: readonly NatalStageCell[], position: NatalStageCell["position"], basis: NatalStageCell["basis"]): NatalStageCell | null {
  return cells.find((cell) => cell.position === position && cell.basis === basis) ?? null;
}

/**
 * 12운성 표의 '기둥' 칸. 자좌 칸의 천간이 그 기둥의 천간이므로 자좌 칸으로 기둥을 쓴다.
 * 일간 기준 칸의 천간은 일간이라 기둥이 아니다 (예: 일간 갑이면 연지 자 칸은 '갑자'가 아니다). 자좌 칸이 없으면 지지만 쓴다.
 */
export function stagePillarLabel(cells: readonly NatalStageCell[], position: NatalStageCell["position"]): string {
  const self = stageAt(cells, position, "self");
  if (self) return `${self.stem}${self.branch}`;
  const dayMaster = stageAt(cells, position, "day-master");
  return dayMaster ? `${dayMaster.branch}(지지)` : "모름";
}

/** 모든 칸의 12운성 기준이 같으면 그 기준을, 섞여 있으면 null을 준다 (칸마다 표시). */
export function sharedStageBasis(cells: readonly NatalStageCell[]): NatalStageCell["basis"] | null {
  const first = cells[0]?.basis;
  return first && cells.every((cell) => cell.basis === first) ? first : null;
}

export const MONTH_DOMAINS: readonly MonthDomain[] = ["career", "wealth", "romance", "social"];
export const MONTH_DOMAIN_LABEL: Readonly<Record<MonthDomain, string>> = { career: "일·직업", wealth: "돈", romance: "연애", social: "관계" };

/** 같은 달의 표지 구성을 말로 쓴 것. 점수나 확률이 아니다. */
export const MONTH_TONE_LABEL: Readonly<Record<MonthTone, string>> = {
  mixed: "긍정·주의 함께",
  positive: "긍정 표지",
  caution: "주의 표지",
  neutral: "뚜렷한 표지 없음",
  "no-data": "자료 없음",
};

/** 그 달이 그 분야의 주목 구간이나 주의 구간으로 골렸는가. */
export function monthFlags(months: Pick<MujinMonths, "notable" | "careful">, periodId: string, domain: MonthDomain): { readonly notable: boolean; readonly careful: boolean } {
  const has = (groups: MujinMonths["notable"]) => groups.some((group) => group.domain === domain && group.periodIds.includes(periodId));
  return { notable: has(months.notable), careful: has(months.careful) };
}

export const LUCK_SLOTS = [
  { key: "previous", label: "직전 대운" },
  { key: "current", label: "현재 대운" },
  { key: "next", label: "다음 대운" },
] as const;

export function luckRows(luck: MujinLuck): { readonly key: (typeof LUCK_SLOTS)[number]["key"]; readonly label: string; readonly period: MujinLuckPeriod | null }[] {
  return LUCK_SLOTS.map((slot) => ({ key: slot.key, label: slot.label, period: luck[slot.key] }));
}

/** 9장 대운을 보여 줄 수 없는 이유 (화면 문구). */
export function luckUnavailableText(reason: MujinLuck["reason"]): string {
  switch (reason) {
    case "hour-unknown":
      return "태어난 시간을 몰라 대운을 계산하지 않았어요. 대운 구간을 임의로 고르지 않고, 이 장은 확인할 수 있는 범위에서만 설명합니다.";
    case "outside-sequence":
      return "기준일이 계산된 대운 범위 밖이라 현재 대운을 고르지 않았어요.";
    default:
      return "대운 자료를 계산하지 못해 대운 표를 보여 드리지 못해요.";
  }
}

const SEOUL_YEAR_MONTH = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", year: "numeric", month: "long" });

/** 시각(ISO)을 Asia/Seoul 기준 'YYYY년 M월'로. 읽을 수 없으면 원문을 그대로 쓴다. */
export function formatYearMonth(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : SEOUL_YEAR_MONTH.format(date);
}

/** 달력 날짜(YYYY-MM-DD)를 'M월 D일'로. 시간대 계산 없이 숫자만 옮긴다. */
export function formatMonthDay(isoDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoDate);
  return match ? `${Number(match[2])}월 ${Number(match[3])}일` : isoDate;
}

/** 달력 날짜(YYYY-MM-DD)를 'YYYY년 M월 D일'로. */
export function formatFullDate(isoDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoDate);
  return match ? `${match[1]}년 ${Number(match[2])}월 ${Number(match[3])}일` : isoDate;
}
