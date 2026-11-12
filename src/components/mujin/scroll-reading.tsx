"use client";

import { ArrowDown, Lock, RotateCcw } from "lucide-react";
import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { apiFetch, ClientApiError } from "@/lib/client-api";
import type { ScrollPhaseView, ScrollSectionView, ScrollStateView, ScrollTier } from "@/domain/mujin/types";
import type { PersonaFace, PersonaIntakeLines } from "@/domain/personas";
import { Button, buttonClass } from "@/components/ui/button";
import { Badge, Notice, PageHeader, PersonaAvatar } from "@/components/ui/layout";
import { SkeletonBlock } from "@/components/ui/skeleton";
import { CoreAnswer, SectionBlocks } from "./blocks";
import { FollowupPanel, PdfCard } from "./followup-panel";
import { fillName } from "./intake-model";
import { ConsultScene } from "./scene";
import {
  afterGenerate,
  anchorId,
  decideGenerate,
  haltDuration,
  haltText,
  IDLE_CONTEXT,
  markRetrying,
  mergeScrollState,
  phaseErrorText,
  POLL_INTERVAL_MS,
  readingComplete,
  sceneStatus,
  scrollVisible,
  sectionBadge,
  sectionEyebrow,
  sectionLabel,
  shouldPoll,
  type DriverContext,
  type FollowupSnapshot,
  type GenerateResult,
  type HaltReason,
} from "./scroll-model";
import { SectionTables } from "./tables";
import { TocButton, TocSheet } from "./toc";

interface Props {
  readonly readingId: string;
  /** 서버가 이 화면을 그릴 때 읽은 저장 상태. 다시 열면 이 상태로 바로 보여 준다(생성·연출을 다시 하지 않는다). */
  readonly initialState: ScrollStateView;
  /** 캐릭터 설정의 lines.intake (함수 없는 문자열). */
  readonly lines: PersonaIntakeLines;
  readonly face: PersonaFace;
  readonly personaName: string;
  /** 출생 정보 요약 (예: 양력 1998년 9월 19일 · 오시 · 서울특별시 종로구). */
  readonly birthSummary: string;
  /** 구매 전 이어서 받는 동선 (서버가 그린 이용권·결제 버튼). 권한이 있으면 null. */
  readonly unlock: ReactNode;
  /** 전체 풀이가 끝난 상태로 열었을 때 서버가 읽은 후속 질문. */
  readonly followups: FollowupSnapshot | null;
  readonly scopeSummary: string;
}

type TierFlags = Record<ScrollTier, boolean>;

/** 다른 칸으로 이동한다. 움직임을 줄이는 설정이면 부드러운 스크롤을 쓰지 않는다. 주소 기록은 남기지 않는다. */
function jumpTo(elementId: string, focusSelector?: string) {
  const target = document.getElementById(elementId);
  if (!target) return;
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  requestAnimationFrame(() => {
    target.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
    const focusTarget = focusSelector ? target.querySelector<HTMLElement>(focusSelector) : null;
    focusTarget?.focus({ preventScroll: true });
  });
}

/** 구매 전 유료 칸. 제목·설명·질문 목록만 보여 준다 (작성 중처럼 보이지 않게 회색 막대를 쓰지 않는다). */
function LockedBody({ section }: { section: ScrollSectionView }) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-gray-200 bg-gray-50 p-5">
      <p className="flex items-center gap-2 type-label font-semibold text-gray-700">
        <Lock size={18} aria-hidden className="shrink-0 text-gray-500" />
        이용권이나 결제 뒤에 쓰는 장이에요
      </p>
      <p className="wrap-break-word type-body text-gray-700">{section.summary}</p>
      {section.questions.length ? (
        <ul className="flex list-disc flex-col gap-1 pl-6">
          {section.questions.map((question) => (
            <li key={question.id} className="wrap-break-word type-label font-normal text-gray-600">
              {question.title}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** 아직 차례가 오지 않은 칸. 작성 중 표시는 하지 않는다. 그 단계가 멈췄으면(paused) 이유는 화면 위쪽 안내가 알린다. */
function WaitingBody({ section, paused }: { section: ScrollSectionView; paused: boolean }) {
  return (
    <div className="flex flex-col gap-2">
      <p className="wrap-break-word type-body text-gray-600">{section.summary}</p>
      <p className="type-caption text-gray-600">{paused ? "지금은 이어서 쓰지 않고 있어요. 화면 위쪽 안내를 확인해 주세요." : "차례가 되면 이어서 써요."}</p>
    </div>
  );
}

/** 실제로 쓰는 중인 칸만 회색 막대로 자리를 잡는다. 디자인 시스템이 반복 효과를 금지해 막대는 움직이지 않는다. */
function WritingBody() {
  return (
    <div aria-busy="true" className="flex flex-col gap-3">
      <span className="sr-only">이 장을 쓰고 있어요</span>
      <SkeletonBlock className="h-9 w-full rounded-lg" />
      <SkeletonBlock className="h-5 w-full rounded-sm" />
      <SkeletonBlock className="h-5 w-full rounded-sm" />
      <SkeletonBlock className="h-5 w-2/3 rounded-sm" />
    </div>
  );
}

function FailedBody({ phase, retrying, onRetry }: { phase: ScrollPhaseView; retrying: boolean; onRetry: () => void }) {
  return (
    <div className="flex flex-col gap-3">
      <Notice tone="danger">
        {phaseErrorText(phase.errorCode)} {phase.canRetry ? "다시 시도하면 마치지 못한 장만 다시 쓰고, 이미 쓴 장은 그대로 둬요." : "다시 시도할 수 있는 횟수를 모두 썼어요. 고객센터로 문의해 주세요."}
      </Notice>
      {phase.canRetry ? (
        <Button variant="secondary" className="self-start" disabled={retrying} onClick={onRetry}>
          <RotateCcw size={18} aria-hidden />
          {retrying ? "다시 쓰는 중이에요" : "다시 시도하기"}
        </Button>
      ) : null}
    </div>
  );
}

function SectionView({
  section,
  state,
  retrying,
  halt,
  onRetry,
}: {
  section: ScrollSectionView;
  state: ScrollStateView;
  retrying: boolean;
  halt: HaltReason | null;
  onRetry: (tier: ScrollTier) => void;
}) {
  const id = anchorId(section.id);
  const badge = sectionBadge(section.state);
  const content = section.state === "done" ? section.content : null;
  const phase = section.tier === "free" ? state.free : state.paid;
  return (
    <section id={id} data-section-id={section.id} aria-labelledby={`${id}-title`} className="flex scroll-mt-header flex-col gap-5">
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3">
          <p className="type-caption-sm text-primary-600">{sectionEyebrow(section)}</p>
          {section.kind !== "chart" && section.state !== "done" ? <Badge tone={badge.tone}>{badge.label}</Badge> : null}
        </div>
        <h2 id={`${id}-title`} tabIndex={-1} className="wrap-break-word type-h2 text-gray-900 outline-none">
          {section.title}
        </h2>
      </div>
      {section.state === "locked" ? <LockedBody section={section} /> : null}
      {content?.coreAnswer ? <CoreAnswer text={content.coreAnswer} /> : null}
      {section.state !== "locked" ? <SectionTables tables={section.tables} state={state} /> : null}
      {content ? <SectionBlocks content={content} /> : null}
      {section.state === "writing" ? <WritingBody /> : null}
      {section.state === "waiting" ? <WaitingBody section={section} paused={halt !== null && halt !== "cooldown" && halt !== "not_ready"} /> : null}
      {section.state === "failed" ? <FailedBody phase={phase} retrying={retrying} onRetry={() => onRetry(section.tier)} /> : null}
    </section>
  );
}

/**
 * 무진의 족자 보고서 화면.
 *
 * - 맨 위 상담 장면은 실제 저장 상태만 보여 준다(계산 중·작성 중·완료). 진행률·남은 시간은 없다.
 * - 첫 무료 칸이 완성되면 책상 위 종이가 족자로 펼쳐진다(globals.css의 paper-lift·scroll-unfurl, 300ms 안).
 *   다시 열었을 때 이미 펼쳐진 상태였으면 연출 없이 바로 보여 준다.
 * - 생성 요청은 끝날 때까지 열려 있고, 그동안 2초마다 저장 상태를 받아 완성된 칸부터 제자리에 보여 준다.
 *   읽는 위치를 맨 아래로 옮기지 않고, 말풍선처럼 일부러 기다리는 연출도 하지 않는다.
 * - 구매 전에는 무료 칸과 유료 칸의 목차·설명만 보여 주고, 그 아래에 이용권·결제 동선을 둔다.
 */
export function ScrollReading({ readingId, initialState, lines, face, personaName, birthSummary, unlock, followups, scopeSummary }: Props) {
  const [state, setState] = useState(initialState);
  const [inFlight, setInFlight] = useState<TierFlags>({ free: false, paid: false });
  const [rerun, setRerun] = useState<TierFlags>({ free: false, paid: false });
  const [halted, setHalted] = useState<Record<ScrollTier, HaltReason | null>>({ free: null, paid: null });
  const [connectionLost, setConnectionLost] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [tocOpen, setTocOpen] = useState(false);
  const [paperGone, setPaperGone] = useState(false);
  /** 다시 시도를 누른 뒤에는 족자를 계속 보여 준다 (다시 쓰는 동안 읽던 내용이 사라지지 않게). */
  const [pinned, setPinned] = useState(false);
  // 처음 열 때 이미 족자를 보여 줄 상태였으면(다시 열기) 종이가 펼쳐지는 연출을 하지 않는다.
  const [openedVisible] = useState(() => scrollVisible(initialState, IDLE_CONTEXT));
  const inFlightRef = useRef<TierFlags>({ free: false, paid: false });
  const pollSeq = useRef(0);
  /** 이 번호보다 먼저 보낸 상태 확인의 응답은 버린다 (다시 시도를 누르기 전에 보낸 늦은 응답). */
  const acceptFrom = useRef(0);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());

  const context: DriverContext = { inFlight, halted, rerun };
  const visible = pinned || scrollVisible(state, context);
  const unfolding = visible && !openedVisible;
  const scene = sceneStatus(state, context);
  const complete = readingComplete(state);
  const nextTier = decideGenerate(state, context);

  useEffect(() => {
    const pending = timers.current;
    return () => {
      pending.forEach(clearTimeout);
      pending.clear();
    };
  }, []);

  const refresh = useCallback(async () => {
    pollSeq.current += 1;
    const seq = pollSeq.current;
    try {
      const { state: next } = await apiFetch<{ state: ScrollStateView }>(`/api/readings/${readingId}/scroll`);
      if (seq < acceptFrom.current) return;
      setConnectionLost(false);
      // 늦게 도착한 이전 확인 결과가 이미 완성된 장이나 끝난 단계를 되돌리지 않게 합친다.
      setState((current) => mergeScrollState(current, next));
    } catch (failure) {
      // 연결이 돌아오면 다음 확인에서 이어서 받는다.
      if (failure instanceof ClientApiError && failure.status === 0) setConnectionLost(true);
    }
  }, [readingId]);

  /** 그 단계를 스스로 다시 요청하지 않게 멈춘다. 잠시 멈춤(cooldown, not_ready)은 정해진 시간 뒤에 풀린다. */
  const halt = useCallback((tier: ScrollTier, reason: HaltReason) => {
    setHalted((current) => ({ ...current, [tier]: reason }));
    const duration = haltDuration(reason);
    if (duration === null) return;
    const timer = setTimeout(() => {
      timers.current.delete(timer);
      setHalted((current) => (current[tier] === reason ? { ...current, [tier]: null } : current));
    }, duration);
    timers.current.add(timer);
  }, []);

  const run = useCallback(
    async (tier: ScrollTier, retry: boolean) => {
      if (inFlightRef.current[tier]) return;
      inFlightRef.current = { ...inFlightRef.current, [tier]: true };
      setInFlight((current) => ({ ...current, [tier]: true }));
      setRerun((current) => (current[tier] ? { ...current, [tier]: false } : current));
      let again = false;
      try {
        // 생성이 끝나거나 서버의 시간 예산이 다할 때까지 응답이 오지 않는다. 그동안 완성된 칸은 주기 확인으로 받는다.
        const { result } = await apiFetch<{ result: GenerateResult }>(`/api/readings/${readingId}/scroll/generate`, {
          method: "POST",
          json: { tier, retry },
        });
        setConnectionLost(false);
        const next = afterGenerate(result);
        again = next.rerun;
        if (next.halt) halt(tier, next.halt);
      } catch (failure) {
        if (failure instanceof ClientApiError && (failure.status === 0 || failure.status >= 502)) {
          // 응답만 못 받았을 뿐 서버는 계속 쓸 수 있다. 바로 다시 요청하지 않고 주기 확인으로 이어 간다.
          if (failure.status === 0) setConnectionLost(true);
          halt(tier, "cooldown");
        } else {
          setNotice(failure instanceof ClientApiError ? failure.message : "잠시 후 다시 시도해 주세요.");
          halt(tier, "error");
        }
      } finally {
        inFlightRef.current = { ...inFlightRef.current, [tier]: false };
        setInFlight((current) => ({ ...current, [tier]: false }));
      }
      await refresh();
      if (again) setRerun((current) => ({ ...current, [tier]: true }));
    },
    [readingId, halt, refresh],
  );

  // 시작 전이거나 끊긴 단계를 이어서 요청한다. 무료 칸을 먼저 쓰고, 권한이 있으면 이어서 유료 칸을 쓴다.
  // 요청은 다음 틱에 보낸다. 그 사이에 할 일이 바뀌면(정리 함수) 보내지 않는다.
  useEffect(() => {
    if (!nextTier) return;
    const timer = setTimeout(() => void run(nextTier, false), 0);
    return () => clearTimeout(timer);
  }, [nextTier, run]);

  // 쓰는 동안에는 저장 상태를 주기적으로 받아, 완성된 칸부터 제자리에 보여 준다.
  const polling = shouldPoll(state, context);
  useEffect(() => {
    if (!polling) return;
    const timer = setInterval(() => void refresh(), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [polling, refresh]);

  const retry = useCallback(
    (tier: ScrollTier) => {
      acceptFrom.current = pollSeq.current + 1;
      setPinned(true);
      setNotice(null);
      setHalted((current) => ({ ...current, [tier]: null }));
      setState((current) => markRetrying(current, tier));
      void run(tier, true);
    },
    [run],
  );

  // 지금 읽는 칸을 찾아 목차와 머리글에 표시한다. 머리글 아래부터 화면 위쪽 약 1/3 안에 들어온 첫 칸이다.
  const sectionKey = state.sections.map((section) => section.id).join("|");
  useEffect(() => {
    if (!visible) return;
    const ids = sectionKey.split("|");
    const header = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--size-header")) || 0;
    const intersecting = new Set<string>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = (entry.target as HTMLElement).dataset.sectionId;
          if (!id) continue;
          if (entry.isIntersecting) intersecting.add(id);
          else intersecting.delete(id);
        }
        const first = ids.find((id) => intersecting.has(id));
        if (first) setCurrentId(first);
      },
      { rootMargin: `-${header}px 0px -65% 0px` },
    );
    for (const id of ids) {
      const element = document.getElementById(anchorId(id));
      if (element) observer.observe(element);
    }
    return () => observer.disconnect();
  }, [visible, sectionKey]);

  const current = state.sections.find((section) => section.id === currentId);
  const subtitle = visible && current ? sectionLabel(current) : `${state.productName} · ${state.nickname} 님`;
  const haltNotices = (["free", "paid"] as const).flatMap((tier) => {
    const text = haltText(halted[tier], tier);
    return text && !(tier === "paid" && !state.entitled) ? [text] : [];
  });

  return (
    <>
      <PageHeader
        backHref="/library"
        title={
          <span className="flex items-center gap-3">
            <PersonaAvatar persona={face} />
            <span className="flex min-w-0 flex-col">
              <span className="truncate type-label font-semibold">{personaName}</span>
              <span className="truncate type-caption font-normal text-gray-600">{subtitle}</span>
            </span>
          </span>
        }
        right={visible ? <TocButton expanded={tocOpen} onOpen={() => setTocOpen(true)} /> : null}
      />

      <main className="flex flex-1 flex-col gap-6 bg-gray-50 px-4 py-5">
        {/* 족자가 펼쳐지기 전에도 화면 제목은 있어야 한다. 펼쳐지면 족자의 제목이 그 역할을 한다. */}
        {visible ? null : <h1 className="sr-only">{`${state.nickname} 님의 사주`}</h1>}
        <ConsultScene
          face={face}
          name={personaName}
          mode={scene.mode}
          line={scene.line ? fillName(lines[scene.line], state.nickname) : null}
          badge={scene.badge}
          paper={!visible ? "resting" : unfolding && !paperGone ? "lifting" : null}
          onPaperLifted={() => setPaperGone(true)}
        />

        {haltNotices.map((text) => (
          <Notice key={text} tone="warning">
            {text}
          </Notice>
        ))}
        {notice ? <Notice tone="danger">{notice}</Notice> : null}

        {visible ? (
          <article aria-labelledby="scroll-title" className={`flex flex-col ${unfolding ? "animate-scroll-unfurl" : ""}`}>
            {/* 족자의 위아래 축. 장식이다. */}
            <span aria-hidden className="block h-3 rounded-full bg-primary-900" />
            <div className="mx-2 flex flex-col gap-9 border-x border-gray-200 bg-white px-4 py-7 desktop:px-7">
              <header className="flex flex-col gap-2">
                <p className="type-caption-sm text-primary-600">{state.productName}</p>
                <h1 id="scroll-title" className="wrap-break-word type-h1 text-gray-900">
                  {state.nickname} 님의 사주
                </h1>
                <p className="wrap-break-word type-caption text-gray-600">{birthSummary}</p>
              </header>
              {state.sections.map((section, index) => (
                <Fragment key={section.id}>
                  <SectionView section={section} state={state} retrying={inFlight[section.tier]} halt={halted[section.tier]} onRetry={retry} />
                  {/* 구매 전: 무료 칸이 끝나는 자리에서 이어지는 장이 아직 쓰지 않은 장이라는 것과 받는 방법을 알린다. */}
                  {!state.entitled && section.tier === "free" && state.sections[index + 1]?.tier === "paid" ? (
                    <div className="flex flex-col gap-3 rounded-lg bg-gray-50 p-4">
                      <div className="flex items-start gap-3">
                        <PersonaAvatar persona={face} />
                        <p className="min-w-0 whitespace-pre-line wrap-break-word rounded-t-lg rounded-br-lg rounded-bl-(--space-2) bg-gray-100 px-4 py-4 type-body text-gray-900">
                          {fillName(lines.locked, state.nickname)}
                        </p>
                      </div>
                      {unlock ? (
                        <a
                          href="#unlock"
                          onClick={(event) => {
                            event.preventDefault();
                            jumpTo("unlock", "h2");
                          }}
                          className={buttonClass("tonal", "md", "self-start")}
                        >
                          받는 방법 보기
                          <ArrowDown size={18} aria-hidden />
                        </a>
                      ) : null}
                    </div>
                  ) : null}
                </Fragment>
              ))}
            </div>
            <span aria-hidden className="block h-3 rounded-full bg-primary-900" />
          </article>
        ) : null}

        {visible && !state.entitled && unlock ? (
          <section id="unlock" aria-label="이어지는 장 받기" className="flex scroll-mt-header flex-col gap-4 rounded-lg border border-gray-200 bg-white p-5">
            {unlock}
          </section>
        ) : null}

        {complete ? (
          <>
            <FollowupPanel readingId={readingId} face={face} personaName={personaName} initial={followups} scopeSummary={scopeSummary} />
            <PdfCard readingId={readingId} />
          </>
        ) : null}
      </main>

      {connectionLost ? (
        <p role="status" className="sticky bottom-5 z-10 mx-4 rounded-md bg-gray-800 px-4 py-4 text-center type-label font-normal text-white">
          인터넷 연결이 끊겼어요. 풀이는 서버에서 계속 쓰고 있으니, 연결되면 이어서 보여 드릴게요.
        </p>
      ) : null}

      <TocSheet
        open={tocOpen}
        onClose={() => setTocOpen(false)}
        sections={state.sections}
        currentId={currentId}
        onSelect={(id) => {
          setCurrentId(id);
          jumpTo(anchorId(id), "h2");
        }}
      />
    </>
  );
}
