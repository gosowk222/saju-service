import { describe, expect, it } from "vitest";
import { DraftSchema } from "@/domain/birth/input";
import { EMPTY_NOW, FAMILY_OPTIONS, INTEREST_CHAPTER_IDS, MujinNowSchema, type FamilyId, type MujinNow } from "@/domain/mujin/now";
import type { MujinMonths, NatalStageCell, PhaseStatus, ScrollSectionView, ScrollStateView, ScrollTier, SectionViewState } from "@/domain/mujin/types";
import { generatingDescription } from "@/components/free-ticket-card";
import { buildScrollStateView, type PhaseRecord, type ScrollStateInput } from "@/server/scroll/state";
import { findPersona, type PersonaIntakeLines } from "@/domain/personas";
import { MUJIN_OVERVIEW } from "@/domain/products/mujin-overview";
import {
  addressName,
  familyDisabled,
  fillName,
  INTAKE_STEPS,
  isSubmitEnter,
  limitedDisabled,
  limitNotice,
  nowAnswered,
  nowSummary,
  REVIEW_STEP,
  STEP_LINE,
  stepAt,
  stepValid,
  toggleFamily,
  toggleInterest,
  toggleRelationship,
  toggleWork,
} from "@/components/mujin/intake-model";
import {
  afterGenerate,
  anchorId,
  byPosition,
  CONNECTION_LOST_TEXT,
  decideGenerate,
  failureText,
  firstFreeReady,
  formatFullDate,
  formatMonthDay,
  formatYearMonth,
  haltDuration,
  haltText,
  IDLE_CONTEXT,
  luckRows,
  luckUnavailableText,
  markRetrying,
  mergeFollowups,
  mergeScrollState,
  MONTH_TONE_LABEL,
  monthFlags,
  paragraphs,
  phaseAlerts,
  readingComplete,
  sceneStatus,
  scrollVisible,
  sectionBadge,
  sectionEyebrow,
  sectionLabel,
  sharedStageBasis,
  shouldPoll,
  stageAt,
  stageBasesOf,
  stagePillarLabel,
  type DriverContext,
  type FollowupSnapshot,
} from "@/components/mujin/scroll-model";

// ── 가상 상태 만들기 (실제 사용자 자료가 아니다) ────────────────────────

type SectionStates = Partial<Record<string, SectionViewState>>;

function sectionsOf(states: SectionStates, entitled: boolean): ScrollSectionView[] {
  return MUJIN_OVERVIEW.scroll.sections.map((spec) => {
    const fallback: SectionViewState = spec.kind === "chart" ? "done" : spec.tier === "paid" && !entitled ? "locked" : "waiting";
    const state = states[spec.id] ?? fallback;
    return {
      id: spec.id,
      kind: spec.kind,
      number: spec.number,
      title: spec.title,
      tier: spec.tier,
      summary: spec.summary,
      questions: spec.questions,
      tables: spec.tables,
      state,
      content: state === "done" && spec.kind !== "chart" ? { sectionId: spec.id, coreAnswer: `${spec.title} 핵심 답`, blocks: [] } : null,
    };
  });
}

function makeState(
  options: {
    free?: PhaseStatus;
    paid?: PhaseStatus;
    entitled?: boolean;
    sections?: SectionStates;
    readingId?: string;
    /** 단계별 canRetry (기본 false). */
    retry?: Partial<Record<ScrollTier, boolean>>;
    /** 단계별 오류 코드 (기본 null). */
    errorCode?: Partial<Record<ScrollTier, string>>;
  } = {},
): ScrollStateView {
  const entitled = options.entitled ?? false;
  return {
    readingId: options.readingId ?? "reading-1",
    productId: MUJIN_OVERVIEW.id,
    productName: MUJIN_OVERVIEW.name,
    personaId: "mujin",
    personaName: "무진 도사",
    nickname: "달빛",
    createdAt: "2026-11-12T01:00:00.000Z",
    hourKnown: true,
    chart: { pillars: [], dayMaster: null, elementPercent: null, hourKnown: true, status: "ok", notes: [] },
    tables: {
      elements: { counts: { 목: 2, 화: 1, 토: 2, 금: 1, 수: 2 }, percents: null },
      stages: [],
      tenGods: { cells: [], families: null },
    },
    entitled,
    free: { status: options.free ?? "idle", canRetry: options.retry?.free ?? false, errorCode: options.errorCode?.free ?? null },
    paid: {
      status: options.paid ?? (entitled ? "queued" : "locked"),
      canRetry: options.retry?.paid ?? false,
      errorCode: options.errorCode?.paid ?? null,
      referenceDate: null,
    },
    sections: sectionsOf(options.sections ?? {}, entitled),
    timing: null,
  };
}

const FREE_WRITTEN = ["basics-structure", "basics-elements", "basics-stages", "basics-ten-gods", "ch1"] as const;
const PAID_WRITTEN = ["ch2", "ch3", "ch4", "ch5", "ch6", "ch7", "ch8", "ch9", "ch10", "closing"] as const;
const all = (ids: readonly string[], state: SectionViewState): SectionStates => Object.fromEntries(ids.map((id) => [id, state]));

function context(overrides: Partial<DriverContext> = {}): DriverContext {
  return { ...IDLE_CONTEXT, ...overrides };
}

// ── 대화형 입력 ────────────────────────────────────────────────────────

describe("무진 대화형 입력 순서와 문장", () => {
  it("출생지역을 출생시각보다 먼저 받고, 확인 단계 번호가 초안 단계 범위(0~8) 안에 있다", () => {
    expect(INTAKE_STEPS).toEqual(["nickname", "gender", "birthDate", "place", "time", "now", "concern", "review"]);
    expect(INTAKE_STEPS.indexOf("place")).toBeLessThan(INTAKE_STEPS.indexOf("time"));
    expect(REVIEW_STEP).toBe(7);
    expect(DraftSchema.safeParse({ productId: MUJIN_OVERVIEW.id, step: REVIEW_STEP }).success).toBe(true);
    expect(stepAt(99)).toBe("review");
    expect(stepAt(-3)).toBe("nickname");
  });

  it("단계마다 쓰는 무진의 말이 캐릭터 설정(lines.intake)에 있고 함수가 아닌 문자열이다", () => {
    const intake = findPersona("mujin")?.lines.intake;
    expect(intake).toBeDefined();
    const sceneLines: (keyof PersonaIntakeLines)[] = ["computing", "writingFree", "freeDone", "writingPaid", "paidDone", "sectionFailed", "locked"];
    for (const key of [...Object.values(STEP_LINE), ...sceneLines]) {
      expect(typeof intake![key], key).toBe("string");
      expect(intake![key].length, key).toBeGreaterThan(0);
    }
  });

  it("{name} 자리를 '별명 님'으로 바꾸고, 별명이 없으면 '손님'으로 부른다", () => {
    expect(addressName("  달빛  ")).toBe("달빛 님");
    expect(addressName("")).toBe("손님");
    expect(addressName("<script>")).toBe("손님");
    expect(fillName("{name}, 반갑습니다.", "달빛")).toBe("달빛 님, 반갑습니다.");
    expect(fillName("요즘 {name}의 상황과 {name}의 관심", "하나")).toBe("요즘 하나 님의 상황과 하나 님의 관심");
    expect(fillName("이름 자리가 없는 문장", "달빛")).toBe("이름 자리가 없는 문장");
    const intake = findPersona("mujin")!.lines.intake!;
    expect(fillName(intake.askGender, "달빛")).not.toContain("{name}");
  });

  it("필수 단계는 값이 있어야 넘어가고, 지금의 나와 궁금한 점은 건너뛸 수 있다", () => {
    const base = { nickname: "달빛", gender: "female" as const, resolvedOk: true, hasPlace: true, hasTime: true, concern: "", concernRequired: false };
    expect(stepValid("nickname", { ...base, nickname: "" })).toBe(false);
    expect(stepValid("nickname", base)).toBe(true);
    expect(stepValid("gender", { ...base, gender: null })).toBe(false);
    expect(stepValid("birthDate", { ...base, resolvedOk: false })).toBe(false);
    expect(stepValid("place", { ...base, hasPlace: false })).toBe(false);
    expect(stepValid("time", { ...base, hasTime: false })).toBe(false);
    expect(stepValid("now", base)).toBe(true);
    expect(stepValid("concern", base)).toBe(true);
    expect(stepValid("concern", { ...base, concernRequired: true })).toBe(false);
    expect(stepValid("review", base)).toBe(true);
    expect(stepValid("review", { ...base, hasTime: false })).toBe(false);
  });

  it("한글 조합 중 Enter와 Shift+Enter로는 넘어가지 않는다", () => {
    const enter = { key: "Enter", keyCode: 13, shiftKey: false, nativeEvent: { isComposing: false } };
    expect(isSubmitEnter(enter)).toBe(true);
    expect(isSubmitEnter({ ...enter, nativeEvent: { isComposing: true } })).toBe(false);
    expect(isSubmitEnter({ ...enter, keyCode: 229 })).toBe(false);
    expect(isSubmitEnter({ ...enter, shiftKey: true })).toBe(false);
    expect(isSubmitEnter({ ...enter, key: "a", keyCode: 65 })).toBe(false);
  });
});

describe("지금의 나 선택 제한", () => {
  it("일·학업과 관심 장은 2개까지 고르고, 세 번째는 막히며 이유를 알린다", () => {
    let now: MujinNow = EMPTY_NOW;
    now = { ...now, work: toggleWork(now.work, "student") };
    now = { ...now, work: toggleWork(now.work, "freelancer") };
    expect(now.work).toEqual(["student", "freelancer"]);
    expect(toggleWork(now.work, "employed")).toEqual(["student", "freelancer"]);
    expect(limitedDisabled(now.work, "employed", 2)).toBe(true);
    expect(limitedDisabled(now.work, "student", 2)).toBe(false);
    expect(limitNotice("work", now)).toContain("2개까지");
    expect(toggleWork(now.work, "student")).toEqual(["freelancer"]);

    const interests = toggleInterest(toggleInterest([], "ch3"), "ch10");
    expect(interests).toEqual(["ch3", "ch10"]);
    expect(toggleInterest(interests, "ch1")).toEqual(["ch3", "ch10"]);
    expect(limitNotice("interests", { ...EMPTY_NOW, interests })).toContain("2개까지");
    expect(limitNotice("interests", { ...EMPTY_NOW, interests: ["ch3"] })).toBeNull();
  });

  it("관계 상태는 하나만, 같은 것을 다시 누르면 미응답으로 돌아간다", () => {
    expect(toggleRelationship(null, "dating")).toBe("dating");
    expect(toggleRelationship("dating", "single")).toBe("single");
    expect(toggleRelationship("single", "single")).toBeNull();
  });

  it("가족 관심은 앞의 다섯 개 중 2개까지, 뒤의 두 개는 다른 항목과 함께 고르지 않는다", () => {
    let family: FamilyId[] = toggleFamily([], "care");
    family = toggleFamily(family, "money");
    expect(family).toEqual(["care", "money"]);
    expect(toggleFamily(family, "distance")).toEqual(["care", "money"]);
    expect(familyDisabled(family, "distance")).toBe(true);
    // 배타 항목은 막지 않고, 고르면 나머지를 비운다.
    expect(familyDisabled(family, "none")).toBe(false);
    expect(toggleFamily(family, "private")).toEqual(["private"]);
    // 배타 항목이 있을 때 일반 항목을 고르면 배타 항목을 뺀다.
    expect(toggleFamily(["none"], "independence")).toEqual(["independence"]);
    expect(limitNotice("family", { ...EMPTY_NOW, family })).toContain("2개까지");
    expect(limitNotice("family", { ...EMPTY_NOW, family: ["none"] })).toBeNull();
  });

  it("어떤 순서로 눌러도 화면이 만드는 값은 서버 검증(MujinNowSchema)을 통과한다", () => {
    const ids = FAMILY_OPTIONS.map((option) => option.id);
    let seed = 7;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648);
    for (let round = 0; round < 200; round += 1) {
      let now: MujinNow = EMPTY_NOW;
      for (let press = 0; press < 12; press += 1) {
        now = {
          ...now,
          family: toggleFamily(now.family, ids[next() % ids.length]!),
          interests: toggleInterest(now.interests, INTEREST_CHAPTER_IDS[next() % INTEREST_CHAPTER_IDS.length]!),
          work: toggleWork(now.work, (["student", "job-seeking", "employed", "freelancer", "business", "resting", "other"] as const)[next() % 7]!),
        };
        expect(MujinNowSchema.safeParse(now).success).toBe(true);
      }
    }
  });

  it("관심 장 선택지는 상품의 1~10장 ID·제목과 같다", () => {
    const chapters = MUJIN_OVERVIEW.scroll.sections.filter((section) => section.kind === "chapter");
    expect(chapters.map((section) => section.id)).toEqual([...INTEREST_CHAPTER_IDS]);
    expect(chapters.map((section) => section.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("확인 화면 요약은 고르지 않은 항목을 미응답으로, 관심 장 미선택을 골고루 보기로 쓴다", () => {
    const title = (id: string) => MUJIN_OVERVIEW.scroll.sections.find((section) => section.id === id)!.title;
    const empty = nowSummary(EMPTY_NOW, title);
    expect(empty.work).toBe("고르지 않음");
    expect(empty.interests).toContain("골고루");
    expect(nowAnswered(EMPTY_NOW)).toBe(false);
    const filled = nowSummary({ work: ["employed"], interests: ["ch4"], relationship: "private", family: ["none"] }, title);
    expect(filled).toEqual({ work: "직장에 다니는 중", interests: "재물과 돈 관리", relationship: "답하고 싶지 않음", family: "특별히 다루고 싶은 내용 없음" });
  });
});

// ── 족자 생성 상태 ──────────────────────────────────────────────────────

describe("족자 생성 요청 순서", () => {
  it("무료 단계를 먼저 시작하고, 유료 단계는 권한이 있고 무료 단계가 더 진행되지 않을 때 시작한다", () => {
    expect(decideGenerate(makeState({ free: "idle" }), context())).toBe("free");
    expect(decideGenerate(makeState({ free: "queued" }), context())).toBe("free");
    expect(decideGenerate(makeState({ free: "running" }), context())).toBeNull();
    // 권한이 없으면 유료 단계를 요청하지 않는다.
    expect(decideGenerate(makeState({ free: "completed", sections: all(FREE_WRITTEN, "done") }), context())).toBeNull();
    // 권한이 생겨도 무료 단계가 쓰는 중이면 기다린다.
    expect(decideGenerate(makeState({ free: "running", entitled: true, paid: "queued" }), context())).toBeNull();
    expect(decideGenerate(makeState({ free: "completed", entitled: true, paid: "queued", sections: all(FREE_WRITTEN, "done") }), context())).toBe("paid");
    // 무료 단계가 실패해도 받은 유료 장은 쓴다.
    expect(decideGenerate(makeState({ free: "failed", entitled: true, paid: "idle" }), context())).toBe("paid");
  });

  it("이미 요청 중이거나 멈춘 단계는 다시 요청하지 않고, partial로 끝난 단계는 바로 다시 요청한다", () => {
    const state = makeState({ free: "queued" });
    expect(decideGenerate(state, context({ inFlight: { free: true, paid: false } }))).toBeNull();
    expect(decideGenerate(state, context({ halted: { free: "daily_limited", paid: null } }))).toBeNull();
    expect(decideGenerate(state, context({ halted: { free: "cooldown", paid: null } }))).toBeNull();
    expect(decideGenerate(makeState({ free: "running" }), context({ rerun: { free: true, paid: false } }))).toBe("free");
    // 실패한 단계는 사용자가 다시 시도할 때만 요청한다.
    expect(decideGenerate(makeState({ free: "failed" }), context())).toBeNull();
  });

  it("요청이 열려 있거나 서버가 쓰는 중일 때만 저장 상태를 주기적으로 받는다", () => {
    expect(shouldPoll(makeState({ free: "idle" }), context())).toBe(false);
    expect(shouldPoll(makeState({ free: "idle" }), context({ inFlight: { free: true, paid: false } }))).toBe(true);
    expect(shouldPoll(makeState({ free: "running" }), context())).toBe(true);
    expect(shouldPoll(makeState({ free: "completed", entitled: true, paid: "queued" }), context({ halted: { free: null, paid: "not_ready" } }))).toBe(false);
    // 권한이 없으면 유료 단계 상태로 받지 않는다.
    expect(shouldPoll(makeState({ free: "completed", entitled: false, paid: "running" }), context())).toBe(false);
  });

  it("아직 차례가 아니라는 응답(not_ready) 동안은 진행 중이라고 표시하지 않는다", () => {
    const state = makeState({ free: "completed", entitled: true, paid: "queued", sections: all(FREE_WRITTEN, "done") });
    const waiting = context({ halted: { free: null, paid: "not_ready" } });
    expect(decideGenerate(state, waiting)).toBeNull();
    expect(sceneStatus(state, waiting).badge).not.toBe("다음 장 준비 중");
    expect(haltText("not_ready", "paid")).toContain("무료 부분");
  });

  it("생성 결과마다 다시 요청할지, 스스로 멈출지 정한다", () => {
    expect(afterGenerate("partial")).toEqual({ rerun: true, halt: null });
    expect(afterGenerate("completed")).toEqual({ rerun: false, halt: null });
    expect(afterGenerate("running").halt).toBe("cooldown");
    expect(afterGenerate("not_ready").halt).toBe("not_ready");
    expect(haltDuration("cooldown")).toBeGreaterThan(0);
    expect(haltDuration("not_ready")).toBeGreaterThan(haltDuration("cooldown")!);
    expect(haltDuration("daily_limited")).toBeNull();
    expect(afterGenerate("daily_limited").halt).toBe("daily_limited");
    expect(afterGenerate("exhausted").halt).toBe("exhausted");
    expect(afterGenerate("locked").halt).toBe("locked");
    expect(afterGenerate("failed").halt).toBe("failed");
    expect(haltText("daily_limited", "free")).toContain("내일");
    expect(haltText("cooldown", "free")).toBeNull();
  });
});

describe("족자가 펼쳐지는 때와 상담 장면 상태", () => {
  it("첫 무료 칸이 완성되기 전에는 상담 장면만, 완성되면 족자를 보여 준다", () => {
    expect(scrollVisible(makeState({ free: "idle" }), context())).toBe(false);
    expect(scrollVisible(makeState({ free: "running", sections: { "basics-structure": "writing" } }), context())).toBe(false);
    const ready = makeState({ free: "running", sections: { "basics-structure": "done", "basics-elements": "writing" } });
    expect(firstFreeReady(ready)).toBe(true);
    expect(scrollVisible(ready, context())).toBe(true);
    // 무료 단계가 더 진행되지 않으면(실패, 하루 한도) 완성된 칸이 없어도 펼쳐 상태를 보여 준다.
    expect(scrollVisible(makeState({ free: "failed", sections: { "basics-structure": "failed" } }), context())).toBe(true);
    expect(scrollVisible(makeState({ free: "idle" }), context({ halted: { free: "daily_limited", paid: null } }))).toBe(true);
    // 다시 열었을 때 이미 끝난 풀이는 처음부터 보인다 (펼치는 연출을 다시 하지 않는다).
    expect(scrollVisible(makeState({ free: "completed", sections: all(FREE_WRITTEN, "done") }), IDLE_CONTEXT)).toBe(true);
  });

  it("계산 중은 완성된 칸도 작성 중인 칸도 없을 때만, 작성 중은 실제로 쓰는 칸이 있을 때만 보인다", () => {
    const computing = sceneStatus(makeState({ free: "running" }), context());
    expect(computing).toEqual({ mode: "computing", line: "computing", badge: "계산 중" });

    const writing = sceneStatus(makeState({ free: "running", sections: { "basics-structure": "writing" } }), context());
    expect(writing).toEqual({ mode: "writing", line: "writingFree", badge: "작성 중" });

    // 한 칸이 끝나고 다음 칸을 아직 쓰지 않는 사이에는 계산 중이라고 하지 않는다.
    const gap = sceneStatus(makeState({ free: "running", sections: { "basics-structure": "done" } }), context());
    expect(gap.line).toBe("writingFree");
    expect(gap.badge).not.toBe("계산 중");
    expect(gap.badge).not.toBe("작성 중");

    const paidWriting = sceneStatus(
      makeState({ free: "completed", entitled: true, paid: "running", sections: { ...all(FREE_WRITTEN, "done"), ch5: "writing" } }),
      context(),
    );
    expect(paidWriting).toEqual({ mode: "writing", line: "writingPaid", badge: "작성 중" });
  });

  it("끝난 단계는 바로 완료로, 실패한 칸이 있으면 다시 시도 안내로 보인다", () => {
    const freeDone = sceneStatus(makeState({ free: "completed", sections: all(FREE_WRITTEN, "done") }), context());
    expect(freeDone).toEqual({ mode: "reading", line: "freeDone", badge: "무료 부분 완료" });

    const paidDone = sceneStatus(
      makeState({ free: "completed", entitled: true, paid: "completed", sections: { ...all(FREE_WRITTEN, "done"), ...all(PAID_WRITTEN, "done") } }),
      context(),
    );
    expect(paidDone).toEqual({ mode: "reading", line: "paidDone", badge: "완료" });

    const failed = sceneStatus(
      makeState({ free: "completed", entitled: true, paid: "failed", retry: { paid: true }, sections: { ...all(FREE_WRITTEN, "done"), ch3: "failed" } }),
      context(),
    );
    expect(failed).toEqual({ mode: "reading", line: "sectionFailed", badge: "다시 시도 필요" });
  });

  it("상태 표시에 근거 없는 진행률이나 남은 시간을 쓰지 않는다", () => {
    const states = [
      makeState({ free: "running" }),
      makeState({ free: "running", sections: { "basics-structure": "writing" } }),
      makeState({ free: "running", sections: { "basics-structure": "done" } }),
      makeState({ free: "completed", sections: all(FREE_WRITTEN, "done") }),
      makeState({ free: "completed", entitled: true, paid: "running", sections: { ...all(FREE_WRITTEN, "done"), ch2: "writing" } }),
    ];
    for (const state of states) {
      const badge = sceneStatus(state, context()).badge ?? "";
      // 숫자가 없으면 '3분', '10초', '40%' 같은 진행률·시간 표시도 없다.
      expect(badge).not.toMatch(/\d|%|남은 시간|진행률/);
    }
  });
});

describe("늦게 도착한 상태 합치기와 다시 시도", () => {
  it("이미 완성된 칸과 끝난 단계는 늦은 응답으로 되돌리지 않고, 나머지는 새 상태를 따른다", () => {
    const current = makeState({ free: "completed", entitled: true, paid: "running", sections: { ...all(FREE_WRITTEN, "done"), ch2: "done", ch3: "writing" } });
    const stale = makeState({ free: "running", entitled: true, paid: "running", sections: { "basics-structure": "writing", ch2: "writing", ch3: "waiting", ch4: "writing" } });
    const merged = mergeScrollState(current, stale);
    expect(merged.free.status).toBe("completed");
    const state = (id: string) => merged.sections.find((section) => section.id === id)!.state;
    expect(state("basics-structure")).toBe("done");
    expect(state("ch2")).toBe("done");
    expect(merged.sections.find((section) => section.id === "ch2")!.content?.coreAnswer).toContain("핵심 답");
    // 아직 완성되지 않은 칸은 새 상태를 따른다.
    expect(state("ch3")).toBe("waiting");
    expect(state("ch4")).toBe("writing");
    // 목차 순서는 서버가 준 순서 그대로다.
    expect(merged.sections.map((section) => section.id)).toEqual(MUJIN_OVERVIEW.scroll.sections.map((section) => section.id));
  });

  it("다른 풀이의 응답은 무시하고, 기간 재료는 새 응답에 없으면 지금 것을 지킨다", () => {
    const current = { ...makeState({ entitled: true }), timing: { luck: { status: "unavailable" as const, reason: "hour-unknown" as const, referenceAt: "", previous: null, current: null, next: null }, months: emptyMonths() } };
    expect(mergeScrollState(current, makeState({ readingId: "other" }))).toBe(current);
    expect(mergeScrollState(current, makeState({ entitled: true })).timing).toBe(current.timing);
  });

  it("다시 시도를 누르면 그 단계의 실패 칸만 대기로 돌리고 다시 시도 버튼을 감춘다", () => {
    const failed = makeState({
      free: "failed",
      entitled: true,
      paid: "failed",
      sections: { "basics-structure": "failed", ch1: "done", ch3: "failed", ch4: "done" },
    });
    const retrying = markRetrying({ ...failed, paid: { ...failed.paid, canRetry: true, errorCode: "timeout" } }, "paid");
    const state = (id: string) => retrying.sections.find((section) => section.id === id)!.state;
    expect(state("ch3")).toBe("waiting");
    expect(state("ch4")).toBe("done");
    expect(state("basics-structure")).toBe("failed");
    expect(retrying.paid).toMatchObject({ status: "running", canRetry: false, errorCode: null });
    expect(retrying.free.status).toBe("failed");
  });

  it("전체 완료는 권한이 있고 유료 단계가 끝나 모든 글 칸이 완성되었을 때만이다", () => {
    const done = { ...all(FREE_WRITTEN, "done"), ...all(PAID_WRITTEN, "done") };
    expect(readingComplete(makeState({ free: "completed", entitled: true, paid: "completed", sections: done }))).toBe(true);
    expect(readingComplete(makeState({ free: "completed", entitled: true, paid: "completed", sections: { ...done, ch9: "failed" } }))).toBe(false);
    expect(readingComplete(makeState({ free: "completed", entitled: false, sections: all(FREE_WRITTEN, "done") }))).toBe(false);
  });
});

describe("단계 실패: 오류 칸 안내, 족자 위 단계 안내, 다시 시도", () => {
  const failedPhase = (canRetry: boolean, errorCode: string | null = "timeout") => ({ status: "failed" as const, canRetry, errorCode });

  it("단계가 실패해 끝나지 않은 칸이 오류로 오면 그 칸들이 다시 시도를 맡고, 족자 위에는 멈췄다는 안내만 둔다", () => {
    // 질문 정리 실패처럼 무료 단계 전체가 실패한 경우. 서버는 끝나지 않은 무료 칸을 모두 오류(failed)로 준다.
    const state = makeState({ free: "failed", retry: { free: true }, errorCode: { free: "server_error" }, sections: all(FREE_WRITTEN, "failed") });
    // 다시 열었을 때(이 화면이 멈춘 적 없음)는 족자 위 안내가 없다. 오류 칸과 상담 장면이 알린다.
    expect(phaseAlerts(state, context())).toEqual([]);
    expect(sceneStatus(state, context())).toEqual({ mode: "reading", line: "sectionFailed", badge: "다시 시도 필요" });
    // 이 화면의 요청이 실패로 끝났으면 족자 위에 멈췄다는 안내를 둔다 (버튼은 오류 칸에 있다).
    const alerts = phaseAlerts(state, context({ halted: { free: "failed", paid: null } }));
    expect(alerts).toEqual([{ tier: "free", tone: "warning", retry: false, text: expect.stringContaining("다시 시도") }]);
    // 오류 칸 안내는 그 칸 단계의 canRetry로 다시 시도 버튼을 고른다.
    expect(failureText(state.free)).toContain("다시 시도하면 마치지 못한 장만 다시 쓰고");
  });

  it("단계가 실패했는데 오류 칸이 하나도 없어도 족자 위에 단계 안내와 다시 시도 버튼을 둔다", () => {
    // 무료 단계: 칸은 대기로 남았는데 단계만 실패 (예외 상태, 이전 서버 응답).
    const free = makeState({ free: "failed", retry: { free: true }, errorCode: { free: "timeout" } });
    expect(phaseAlerts(free, context({ halted: { free: "failed", paid: null } }))).toEqual([
      { tier: "free", tone: "danger", retry: true, text: expect.stringContaining("무료 부분을") },
    ]);
    expect(sceneStatus(free, context())).toMatchObject({ mode: "reading", badge: "다시 시도 필요" });
    // 유료 단계: 모든 유료 장이 완성됐는데 마무리 저장이 실패한 경우.
    const paid = makeState({
      free: "completed",
      entitled: true,
      paid: "failed",
      retry: { paid: true },
      sections: { ...all(FREE_WRITTEN, "done"), ...all(PAID_WRITTEN, "done") },
    });
    expect(phaseAlerts(paid, context())).toEqual([{ tier: "paid", tone: "danger", retry: true, text: expect.stringContaining("이어지는 장을") }]);
    // 권한이 없으면 유료 단계 안내를 두지 않는다.
    expect(phaseAlerts({ ...paid, entitled: false }, context())).toEqual([]);
    // 다시 시도할 수 없으면 버튼 대신 횟수를 다 썼다는 안내와 문의 안내.
    const exhausted = makeState({ free: "failed", errorCode: { free: "attempts_exhausted" } });
    expect(phaseAlerts(exhausted, context())).toEqual([{ tier: "free", tone: "danger", retry: false, text: expect.stringContaining("고객센터") }]);
    // 다시 시도를 누르면 단계가 진행 중으로 바뀌어 안내와 버튼이 사라진다.
    expect(phaseAlerts(markRetrying(free, "free"), context())).toEqual([]);
  });

  it("멈춘 이유 '실패'에도 안내가 있고, 시도 횟수를 다 쓴 무료 단계에 다시 열어 보라고 하지 않는다", () => {
    expect(haltText("failed", "free", failedPhase(true))).toContain("다시 시도");
    expect(haltText("failed", "paid", failedPhase(false))).toContain("고객센터");
    // 서버 저장 상태가 아직 실패가 아니면(실패 기록 전) 잠시 뒤 다시 열면 이어진다.
    expect(haltText("failed", "free", { status: "running", canRetry: false, errorCode: null })).toContain("다시 열어");
    expect(haltText("failed", "free")).not.toBeNull();
    expect(haltText("exhausted", "free")).not.toContain("다시 열어");
    expect(haltText("exhausted", "free")).toContain("고객센터");
  });

  it("오류 칸 안내: 다시 시도할 수 있으면 다시 시도를, 없으면 횟수 소진과 문의를, 설정 오류면 횟수 없이 문의를 안내한다", () => {
    expect(failureText(failedPhase(true, "server_error"))).toContain("다시 시도하면 마치지 못한 장만 다시 쓰고");
    const used = failureText(failedPhase(false, "units_failed"));
    expect(used).toContain("횟수를 모두 썼어요");
    expect(used).toContain("고객센터");
    const config = failureText(failedPhase(false, "prompt_version_unavailable"));
    expect(config).not.toContain("횟수");
    expect(config).toContain("고객센터");
    // 같은 문의 안내를 두 번 쓰지 않는다.
    expect(failureText(failedPhase(false, "attempts_exhausted")).match(/고객센터/g)).toHaveLength(1);
    // 실행 중인 단계에서 시도 수를 다 쓴 장 (단계 오류 코드 없음).
    expect(failureText({ status: "running", canRetry: false, errorCode: null })).toContain("횟수를 모두 썼어요");
    // 단계 단위 안내는 무엇을 마치지 못했는지 단계 이름으로 쓴다.
    expect(failureText(failedPhase(true), "무료 부분을")).toContain("무료 부분을 쓰는 데");
  });

  it("다시 시도할 수 없는 실패만 남으면 상담 장면이 다시 시도하라고 하지 않는다", () => {
    const scene = sceneStatus(makeState({ free: "failed", errorCode: { free: "attempts_exhausted" }, sections: all(FREE_WRITTEN, "failed") }), context());
    expect(scene.mode).toBe("reading");
    expect(scene.badge).not.toBe("다시 시도 필요");
    expect(scene.line).toBeNull();
    // 상태 표시에 숫자·진행률은 없다.
    expect(scene.badge ?? "").not.toMatch(/\d|%/);
  });
});

describe("서버 상태 계약과 화면: 단계 단위 실패 뒤에도 다시 시도할 곳이 있다", () => {
  const NOW = Date.parse("2026-11-12T03:00:00.000Z");
  const sample = makeState();
  const input = (extra: Partial<ScrollStateInput>): ScrollStateInput => ({
    reading: { id: "reading-1", persona_id: "mujin", nickname: "달빛", created_at: sample.createdAt, chart: sample.chart },
    product: MUJIN_OVERVIEW,
    personaName: "무진 도사",
    plan: { hourKnown: true, tables: sample.tables },
    entitled: false,
    freeRun: null,
    job: null,
    units: [],
    finals: [],
    timing: null,
    now: NOW,
    ...extra,
  });
  const failedRun = (errorCode: string, attempts = 1): PhaseRecord => ({ status: "failed", attempts, leaseUntil: null, errorCode, errorRetryable: true });
  const written = (view: ScrollStateView, tier: ScrollTier) => view.sections.filter((section) => section.tier === tier && section.kind !== "chart");

  it("질문 정리 실패(장 기록 없음): 무료 칸이 모두 오류이고 다시 시도할 수 있으며, 누르면 대기로 돌아간다", () => {
    const view = buildScrollStateView(input({ freeRun: failedRun("server_error") }));
    expect(written(view, "free").map((section) => section.state)).toEqual(FREE_WRITTEN.map(() => "failed"));
    expect(view.free.canRetry).toBe(true);
    // 오류 칸이 다시 시도 버튼을 맡으므로 족자 위 단계 안내 상자는 없고, 화면이 스스로 다시 요청하지도 않는다.
    expect(phaseAlerts(view, context()).filter((alert) => alert.tone === "danger")).toEqual([]);
    expect(scrollVisible(view, context())).toBe(true);
    expect(decideGenerate(view, context())).toBeNull();
    expect(sceneStatus(view, context()).badge).toBe("다시 시도 필요");
    const retrying = markRetrying(view, "free");
    expect(written(retrying, "free").every((section) => section.state === "waiting")).toBe(true);
    expect(retrying.free).toMatchObject({ status: "running", canRetry: false });
  });

  it("유료 단계 저장 오류(초안만 있는 장, 장 기록 없는 장): 끝나지 않은 유료 칸이 오류이고 완성된 장은 그대로다", () => {
    const view = buildScrollStateView(
      input({
        entitled: true,
        freeRun: { status: "completed", attempts: 1, leaseUntil: null, errorCode: null, errorRetryable: null },
        job: { ...failedRun("internal"), referenceDate: "2026-11-12" },
        units: [{ unitId: "ch2", status: "drafted", draftAttempts: 1, voiceAttempts: 0, errorStage: null, updatedAt: new Date(NOW).toISOString() }],
        finals: [...FREE_WRITTEN, "ch3"].map((sectionId) => ({ sectionId, tier: sectionId === "ch3" ? "paid" : "free", content: { sectionId, coreAnswer: "가상", blocks: [] } })),
      }),
    );
    const state = (id: string) => view.sections.find((section) => section.id === id)!.state;
    expect(state("ch3")).toBe("done");
    expect(state("ch2")).toBe("failed");
    expect(state("closing")).toBe("failed");
    expect(view.paid.canRetry).toBe(true);
    expect(phaseAlerts(view, context()).filter((alert) => alert.tone === "danger")).toEqual([]);
  });

  it("단계 실패인데 모든 칸이 완성(마무리 저장 실패): 오류 칸이 없어도 족자 위 단계 안내에 다시 시도 버튼이 있다", () => {
    const view = buildScrollStateView(
      input({
        freeRun: failedRun("internal"),
        finals: FREE_WRITTEN.map((sectionId) => ({ sectionId, tier: "free", content: { sectionId, coreAnswer: "가상", blocks: [] } })),
      }),
    );
    expect(written(view, "free").every((section) => section.state === "done")).toBe(true);
    expect(phaseAlerts(view, context())).toEqual([{ tier: "free", tone: "danger", retry: true, text: expect.stringContaining("무료 부분을") }]);
    expect(sceneStatus(view, context()).badge).toBe("다시 시도 필요");
  });
});

describe("실제 동작과 맞는 안내 (무진)", () => {
  it("무료 이용권 카드: 족자 상품은 화면을 닫아도 계속 만든다고 말하지 않고, 묘묘 문구는 그대로다", () => {
    expect(generatingDescription("messenger", null)).toBe("화면을 닫아도 이어서 만들어요.");
    expect(generatingDescription("messenger", "남은 무료 이용권 1장")).toBe("화면을 닫아도 이어서 만들어요. 남은 무료 이용권 1장.");
    // 상품을 확인하지 못했을 때도 기존 문구를 쓴다.
    expect(generatingDescription(null, null)).toBe("화면을 닫아도 이어서 만들어요.");
    const scroll = generatingDescription("scroll", "남은 무료 이용권 1장");
    expect(scroll).not.toContain("닫아도");
    expect(scroll).toContain("풀이 화면을 다시 열면 이어서");
    expect(scroll).toContain("남은 무료 이용권 1장");
  });

  it("족자 화면의 연결 끊김 안내는 서버가 계속 쓰고 있다고 약속하지 않는다", () => {
    expect(CONNECTION_LOST_TEXT).toContain("연결이 끊겼어요");
    expect(CONNECTION_LOST_TEXT).not.toMatch(/서버에서 계속|계속 쓰고 있/);
  });
});

describe("목차와 칸 상태 표시", () => {
  it("잠김·대기·작성 중·오류·완료를 글자로 구분한다", () => {
    expect(sectionBadge("locked").label).toBe("잠김");
    expect(sectionBadge("waiting").label).toBe("대기");
    expect(sectionBadge("writing")).toEqual({ label: "작성 중", tone: "progress" });
    expect(sectionBadge("failed")).toEqual({ label: "오류", tone: "danger" });
    expect(sectionBadge("done")).toEqual({ label: "완료", tone: "neutral" });
  });

  it("장 번호와 제목, 앵커 이름을 만든다", () => {
    const chapter = { kind: "chapter" as const, number: 3, title: "직업과 사회생활" };
    expect(sectionEyebrow(chapter)).toBe("3장");
    expect(sectionLabel(chapter)).toBe("3장 직업과 사회생활");
    expect(sectionEyebrow({ kind: "basics", number: null })).toBe("기초");
    expect(sectionEyebrow({ kind: "closing", number: null })).toBe("정리");
    expect(sectionLabel({ kind: "closing", number: null, title: "마지막 정리" })).toBe("마지막 정리");
    expect(anchorId("ch3")).toBe("section-ch3");
  });
});

describe("후속 질문 합치기", () => {
  const snapshot = (status: FollowupSnapshot["followups"][number]["status"], used: number): FollowupSnapshot => ({
    followups: [{ id: "f1", question: "질문", answer: status === "answering" ? null : "답", status, createdAt: "2026-11-12T02:00:00.000Z" }],
    questionsUsed: used,
    questionLimit: 3,
  });

  it("이미 끝난 답을 늦은 응답의 '쓰는 중'으로 되돌리지 않고 쓴 횟수도 줄이지 않는다", () => {
    const merged = mergeFollowups(snapshot("answered", 1), snapshot("answering", 0));
    expect(merged.followups[0]!.status).toBe("answered");
    expect(merged.questionsUsed).toBe(1);
    expect(mergeFollowups(null, snapshot("answering", 0)).followups[0]!.status).toBe("answering");
  });

  it("답은 빈 줄로 나눈 문단마다 보여 준다", () => {
    expect(paragraphs("첫 문단\n\n  둘째 문단  \n \n")).toEqual(["첫 문단", "둘째 문단"]);
  });
});

// ── 표 ─────────────────────────────────────────────────────────────────

function emptyMonths(): MujinMonths {
  return { status: "available", window: { startMonth: "2026-11", endMonth: "2027-10", label: "" }, months: [], notable: [], careful: [], limitations: [] };
}

describe("표 도우미", () => {
  it("12운성 칸을 원국표 순서(시주·일주·월주·연주)로 놓고 시각 미상의 시주는 비운다", () => {
    const cells: NatalStageCell[] = [
      { position: "year", label: "연주", basis: "day-master", stem: "갑", branch: "자", stage: "목욕" },
      { position: "day", label: "일주", basis: "day-master", stem: "병", branch: "인", stage: "장생" },
      { position: "month", label: "월주", basis: "day-master", stem: "정", branch: "묘", stage: "사" },
    ];
    expect(byPosition(cells).map((cell) => cell?.position ?? null)).toEqual([null, "day", "month", "year"]);
    expect(sharedStageBasis(cells)).toBe("day-master");
    expect(sharedStageBasis([...cells, { ...cells[0]!, position: "hour", basis: "self" }])).toBeNull();
  });

  it("12운성 표의 기둥은 자좌 칸(그 기둥의 천간)으로 쓰고, 일간 기준 칸의 '일간+지지'를 기둥처럼 보이지 않는다", () => {
    // 가상 원국: 일간 갑, 연주 병자. 일간 기준 연지 칸의 천간은 일간(갑)이다.
    const stages = [
      { position: "year" as const, label: "연주", basis: "day-master" as const, stem: "갑", branch: "자", stage: "목욕" },
      { position: "year" as const, label: "연주", basis: "self" as const, stem: "병", branch: "자", stage: "태" },
      { position: "month" as const, label: "월주", basis: "day-master" as const, stem: "갑", branch: "진", stage: "쇠" },
    ];
    expect(stagePillarLabel(stages, "year")).toBe("병자");
    expect(stagePillarLabel(stages, "month")).toBe("진(지지)");
    expect(stagePillarLabel(stages, "hour")).toBe("모름");
    expect(stageBasesOf(stages)).toEqual(["day-master", "self"]);
    expect(stageAt(stages, "year", "self")?.stage).toBe("태");
    expect(stageAt(stages, "year", "day-master")?.stage).toBe("목욕");
  });

  it("12개월 표의 주목·주의 표시는 분야와 달이 함께 맞을 때만이고, 표지 설명에 점수·확률이 없다", () => {
    const months = { notable: [{ domain: "career" as const, periodIds: ["monthly:2026-12"] }], careful: [{ domain: "wealth" as const, periodIds: ["monthly:2026-12"] }] };
    expect(monthFlags(months, "monthly:2026-12", "career")).toEqual({ notable: true, careful: false });
    expect(monthFlags(months, "monthly:2026-12", "wealth")).toEqual({ notable: false, careful: true });
    expect(monthFlags(months, "monthly:2027-01", "career")).toEqual({ notable: false, careful: false });
    for (const label of Object.values(MONTH_TONE_LABEL)) expect(label).not.toMatch(/\d|%|점수|확률/);
  });

  it("대운은 직전·현재·다음 순서로 놓고, 계산할 수 없으면 이유를 쓴다", () => {
    const rows = luckRows({ status: "unavailable", reason: "hour-unknown", referenceAt: "", previous: null, current: null, next: null });
    expect(rows.map((row) => row.label)).toEqual(["직전 대운", "현재 대운", "다음 대운"]);
    expect(luckUnavailableText("hour-unknown")).toContain("태어난 시간을 몰라");
    expect(luckUnavailableText("outside-sequence")).toContain("범위 밖");
  });

  it("날짜는 Asia/Seoul 기준으로 쓴다", () => {
    expect(formatYearMonth("2031-02-28T16:30:00.000Z")).toBe("2031년 3월");
    expect(formatYearMonth("잘못된 값")).toBe("잘못된 값");
    expect(formatMonthDay("2026-11-07")).toBe("11월 7일");
    expect(formatFullDate("2026-11-12")).toBe("2026년 11월 12일");
  });
});
