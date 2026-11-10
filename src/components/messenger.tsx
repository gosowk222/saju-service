"use client";

import { ArrowDown, Download, Send } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiFetch, ClientApiError } from "@/lib/client-api";
import type { ChartView } from "@/domain/reading/types";
import type { ReadingStateView } from "@/server/readings/store";
import { ChartPhoto } from "@/components/chart-table";
import { RichText } from "@/components/rich-text";
import { Button, buttonClass } from "@/components/ui/button";
import { Notice, PersonaAvatar, TypingDots } from "@/components/ui/layout";

const REVEAL_INTERVAL_MS = 700;
/** 생성 중에는 주제가 완성될 때마다 저장되므로 자주 확인한다. */
const POLL_INTERVAL_MS = 2000;
/** 후속 답변은 문단이 짧아 더 자주 확인한다. */
const FOLLOWUP_POLL_INTERVAL_MS = 1500;

/** 늦게 도착한 이전 확인 결과가 이미 끝난 후속 답변을 '만드는 중'으로 되돌리지 않게 합친다. */
function mergeFollowups(current: ReadingStateView, next: ReadingStateView): ReadingStateView {
  return {
    ...next,
    followups: next.followups.map((followup) => {
      const known = current.followups.find((item) => item.id === followup.id);
      return known && known.status !== "answering" && followup.status === "answering" ? known : followup;
    }),
  };
}
const NEAR_BOTTOM_PX = 120;

interface Props {
  readonly readingId: string;
  readonly personaName: string;
  /** 조사를 붙인 이름 (묘묘가). 안내 문구에 쓴다. */
  readonly personaSubject: string;
  readonly personaGlyph: string;
  readonly topicTitles: Readonly<Record<string, string>>;
  /** 후속 질문 입력 아래에 보여 줄 상품 범위 안내. */
  readonly scopeSummary: string;
  readonly initialState: ReadingStateView;
  /** 첫 인사 다음에 사진처럼 보여 줄 사주원국. 저장된 계산값이다. */
  readonly chart: ChartView | null;
  readonly nickname: string;
}

/**
 * 상담사 말풍선. 메신저처럼 이어서 보내는 말풍선(continued)은 프로필과 이름을 생략하고 간격을 좁힌다.
 * 창작 장면은 제목 없이 옅은 보라 면으로만 구분하고, 장면이라는 점은 문장의 가정형 말투로 드러낸다.
 * 사진(photo)은 말풍선 면 없이 내용만 보여 준다.
 */
function Bubble({
  glyph,
  name,
  children,
  animate,
  scene,
  photo = false,
  continued = false,
}: {
  glyph: string;
  name: string;
  children: React.ReactNode;
  animate?: boolean;
  scene?: boolean;
  photo?: boolean;
  continued?: boolean;
}) {
  return (
    <div className={`flex items-start gap-3 ${continued ? "-mt-2" : ""} ${animate ? "animate-bubble" : ""}`}>
      {continued ? <span aria-hidden className="w-9 shrink-0" /> : <PersonaAvatar glyph={glyph} />}
      <div className={`flex min-w-0 max-w-[85%] flex-col gap-1 ${photo ? "w-full" : ""}`}>
        {continued ? null : <span className="type-caption-sm text-gray-600">{name}</span>}
        {photo ? (
          children
        ) : (
          <div
            className={`whitespace-pre-wrap wrap-break-word rounded-t-lg rounded-br-lg rounded-bl-(--space-2) px-4 py-4 type-body text-gray-900 ${
              scene ? "border border-primary-200 bg-primary-50" : "bg-gray-100"
            }`}
          >
            {children}
          </div>
        )}
      </div>
    </div>
  );
}

/** 후속 답변은 문단마다 말풍선 하나로 나눠 메신저처럼 보여 준다. 저장된 답변은 그대로다. */
function paragraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function MyBubble({ children, animate }: { children: React.ReactNode; animate?: boolean }) {
  return (
    <div className={`flex justify-end ${animate ? "animate-bubble" : ""}`}>
      <div className="max-w-[85%] whitespace-pre-wrap wrap-break-word rounded-t-lg rounded-bl-lg rounded-br-(--space-2) bg-primary-600 px-4 py-4 type-body text-white">
        {children}
      </div>
    </div>
  );
}

const ERROR_TEXT: Readonly<Record<string, string>> = {
  rate_limited: "요청이 몰려 풀이를 만들지 못했어요.",
  timeout: "풀이를 만드는 데 시간이 너무 오래 걸렸어요.",
  attempts_exhausted: "여러 번 시도했지만 풀이를 만들지 못했어요. 고객센터로 문의해 주세요.",
};

export function Messenger({ readingId, personaName, personaSubject, personaGlyph, topicTitles, scopeSummary, initialState, chart, nickname }: Props) {
  const [state, setState] = useState(initialState);
  // 이 화면에서 생성을 지켜본 경우에만 전달 효과를 쓴다. 다시 열면 바로 보여 준다.
  const [animateReveal] = useState(initialState.status !== "completed");
  const [revealed, setRevealed] = useState(0);
  const [skipReveal, setSkipReveal] = useState(false);
  const [starting, setStarting] = useState(false);
  const [question, setQuestion] = useState("");
  const [sending, setSending] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showJump, setShowJump] = useState(false);
  const [includeFollowups, setIncludeFollowups] = useState(false);
  /** 사용자 쪽 인터넷이 끊겼는지. 서버는 그동안에도 풀이를 계속 만든다. */
  const [connectionLost, setConnectionLost] = useState(false);
  const stickToBottom = useRef(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const started = useRef(false);
  const startingRef = useRef(false);

  const animating = animateReveal && !skipReveal && revealed < state.messages.length;

  const startGeneration = useCallback(
    async (retry: boolean) => {
      setStarting(true);
      startingRef.current = true;
      setNotice(null);
      // 다시 시도할 때도 쓰는 중으로 보여 주고, 완성된 주제를 주기 확인으로 받는다.
      if (retry) setState((current) => ({ ...current, status: "running", canRetry: false }));
      try {
        // 생성이 끝날 때까지 응답이 오지 않는다. 그동안 완성된 주제는 아래 주기 확인으로 받는다.
        const next = await apiFetch<ReadingStateView>(`/api/readings/${readingId}/generate`, { method: "POST", json: { retry } });
        setConnectionLost(false);
        setState(next);
      } catch (failure) {
        if (failure instanceof ClientApiError && (failure.status === 0 || failure.status >= 502)) {
          // 응답만 못 받았을 뿐 서버는 계속 만든다. 아래 주기 확인이 이어서 보여 주므로 실패 알림을 띄우지 않는다.
          if (failure.status === 0) setConnectionLost(true);
        } else {
          setNotice(failure instanceof ClientApiError ? failure.message : "잠시 후 다시 시도해 주세요.");
        }
      } finally {
        setStarting(false);
        startingRef.current = false;
      }
    },
    [readingId],
  );

  // 결제 뒤 처음 들어왔거나 작업이 끊겼으면 이어서 시작한다.
  useEffect(() => {
    if (state.status === "queued" && !started.current) {
      started.current = true;
      void startGeneration(false);
    }
  }, [state.status, startGeneration]);

  // 생성 중에는 저장 상태를 주기적으로 확인해, 완성된 주제의 말풍선을 먼저 보여 준다.
  useEffect(() => {
    if (state.status !== "running" && state.status !== "queued") return;
    const timer = setInterval(() => {
      apiFetch<ReadingStateView>(`/api/readings/${readingId}/state`)
        .then((next) => {
          setConnectionLost(false);
          // 이 화면이 시작 요청을 기다리는 중이 아닐 때만 끊긴 작업을 다시 시작한다.
          if (next.status === "queued" && !startingRef.current) started.current = false;
          // 늦게 도착한 이전 확인 결과가 완료 상태를 덮어쓰지 않게 한다.
          setState((current) => (current.status === "completed" ? current : next));
        })
        // 연결이 돌아오면 다음 확인에서 이어서 받는다.
        .catch((failure: unknown) => {
          if (failure instanceof ClientApiError && failure.status === 0) setConnectionLost(true);
        });
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [state.status, readingId]);

  // 후속 답변을 만드는 동안에도 저장 상태를 확인해, 완성된 문단을 먼저 보여 준다.
  const inflight = state.followups.find((followup) => followup.status === "answering");
  const answering = sending !== null || inflight !== undefined;
  useEffect(() => {
    if (!answering) return;
    const timer = setInterval(() => {
      apiFetch<ReadingStateView>(`/api/readings/${readingId}/state`)
        .then((next) => setState((current) => mergeFollowups(current, next)))
        .catch(() => undefined);
    }, FOLLOWUP_POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [answering, readingId]);

  useEffect(() => {
    if (!animating) return;
    const timer = setTimeout(() => setRevealed((count) => count + 1), REVEAL_INTERVAL_MS);
    return () => clearTimeout(timer);
  }, [animating, revealed]);

  // 사용자가 위로 올려 읽는 중이면 끌어내리지 않는다.
  useEffect(() => {
    const onScroll = () => {
      const distance = document.documentElement.scrollHeight - window.innerHeight - window.scrollY;
      stickToBottom.current = distance < NEAR_BOTTOM_PX;
      if (stickToBottom.current) setShowJump(false);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const inflightLength = inflight?.answer?.length ?? 0;
  useEffect(() => {
    if (!animating && !answering) return;
    if (stickToBottom.current) bottomRef.current?.scrollIntoView({ block: "end" });
    else setShowJump(true);
  }, [revealed, animating, answering, state.followups.length, inflightLength]);

  const visible = useMemo(
    () => (animateReveal && !skipReveal ? state.messages.slice(0, revealed) : state.messages),
    [animateReveal, skipReveal, state.messages, revealed],
  );
  const remaining = Math.max(state.questionLimit - state.questionsUsed, 0);
  const generating = state.status === "queued" || state.status === "running";
  const isDone = state.status === "completed" && !animating;

  async function ask() {
    const text = question.trim();
    if (!text || sending !== null || remaining === 0) return;
    setSending(text);
    setNotice(null);
    setQuestion("");
    stickToBottom.current = true;
    try {
      await apiFetch(`/api/readings/${readingId}/followups`, {
        method: "POST",
        json: { clientRequestId: crypto.randomUUID(), question: text },
      });
      setState(await apiFetch<ReadingStateView>(`/api/readings/${readingId}/state`));
    } catch (failure) {
      setQuestion(text);
      setNotice(failure instanceof ClientApiError ? failure.message : "잠시 후 다시 시도해 주세요.");
    } finally {
      setSending(null);
    }
  }

  return (
    <>
      <main className="flex flex-1 flex-col gap-4 bg-gray-50 px-4 py-5">
        {visible.map((message, index) => {
          const showTopic = message.topicId !== null && message.topicId !== visible[index - 1]?.topicId;
          return (
            <div key={message.seq} className="flex flex-col gap-4">
              {showTopic ? (
                <p className="self-center rounded-pill bg-gray-100 px-4 py-1 type-caption-sm text-gray-600">{topicTitles[message.topicId!]}</p>
              ) : null}
              <Bubble
                glyph={personaGlyph}
                name={personaName}
                animate={animating}
                scene={message.kind === "creative-scene"}
                continued={index > 0 && !showTopic}
              >
                <RichText text={message.text} />
              </Bubble>
              {/* 첫 인사 다음에 사주표를 사진처럼 보낸다. 저장된 메시지에는 넣지 않는다. */}
              {index === 0 && chart ? (
                <Bubble glyph={personaGlyph} name={personaName} animate={animating} photo continued>
                  <ChartPhoto chart={chart} nickname={nickname} />
                </Bubble>
              ) : null}
            </div>
          );
        })}

        {/* 쓰는 중이거나 받은 말풍선을 차례로 보여 주는 중에는 입력 중 표시를 하나만 둔다. */}
        {generating || animating ? (
          <div aria-live="polite" className="flex flex-col gap-3">
            <Bubble glyph={personaGlyph} name={personaName} continued={visible.length > 0}>
              <TypingDots />
              <span className="sr-only">{personaSubject} 입력하고 있어요</span>
            </Bubble>
            {animating ? (
              <button type="button" onClick={() => setSkipReveal(true)} className="self-center type-label text-primary-600">
                전체 바로 보기
              </button>
            ) : (
              <p className="self-center text-center type-caption text-gray-600">
                {connectionLost
                  ? "인터넷 연결이 끊겼어요. 풀이는 계속 만들어지고 있으니, 연결되면 이어서 보여 드릴게요."
                  : visible.length
                    ? `${personaSubject} 다음 이야기를 쓰고 있어요.`
                    : `${personaSubject} 풀이를 쓰고 있어요. 주제가 하나씩 완성되는 대로 바로 보여 드릴게요.`}
              </p>
            )}
          </div>
        ) : null}

        {state.status === "failed" ? (
          <div className="flex flex-col gap-3 rounded-lg border border-gray-200 bg-white p-5" role="alert">
            <p className="type-title text-gray-900">풀이를 만들지 못했어요</p>
            <p className="type-body text-gray-700">
              {ERROR_TEXT[state.errorCode ?? ""] ?? "일시적인 문제가 생겼어요."} 결제는 그대로 유지되니 다시 결제할 필요가 없어요.
            </p>
            {state.canRetry ? (
              <Button size="lg" disabled={starting} onClick={() => startGeneration(true)}>
                {starting ? "다시 만드는 중이에요" : "다시 시도하기"}
              </Button>
            ) : null}
          </div>
        ) : null}

        {isDone ? (
          <>
            <p className="self-center rounded-pill bg-green-50 px-4 py-1 type-caption-sm text-green-600">풀이 완료</p>
            {state.followups.map((followup) => {
              const parts = paragraphs(followup.answer ?? "");
              const writing = followup.status === "answering";
              return (
                <div key={followup.id} className="flex flex-col gap-4">
                  <MyBubble>{followup.question}</MyBubble>
                  {parts.map((part, index) => (
                    <Bubble key={index} glyph={personaGlyph} name={personaName} continued={index > 0} animate={writing}>
                      <RichText text={part} />
                    </Bubble>
                  ))}
                  {/* 다음 문단을 쓰는 동안 입력 중 표시를 둔다. */}
                  {writing ? (
                    <Bubble glyph={personaGlyph} name={personaName} continued={parts.length > 0}>
                      <TypingDots />
                      <span className="sr-only">{personaSubject} 입력하고 있어요</span>
                    </Bubble>
                  ) : null}
                </div>
              );
            })}
            {/* 서버가 질문을 받기 전까지만 보낸 질문을 따로 보여 준다. 받은 뒤에는 위 목록에 나온다. */}
            {sending && !inflight ? (
              <div className="flex flex-col gap-4">
                <MyBubble animate>{sending}</MyBubble>
                <Bubble glyph={personaGlyph} name={personaName}>
                  <TypingDots />
                </Bubble>
              </div>
            ) : null}
            <div className="flex flex-col gap-3 rounded-lg border border-gray-200 bg-white p-5">
              <p className="type-label font-semibold text-gray-900">PDF로 저장하기</p>
              <label className="flex min-h-button items-center gap-3 type-label font-normal text-gray-700">
                <input
                  type="checkbox"
                  className="h-5 w-5 accent-primary-600"
                  checked={includeFollowups}
                  onChange={(event) => setIncludeFollowups(event.target.checked)}
                />
                후속 질문과 답변도 포함하기
              </label>
              <a
                className={buttonClass("secondary", "md")}
                href={`/api/readings/${readingId}/pdf${includeFollowups ? "?followups=1" : ""}`}
                download
              >
                <Download size={18} aria-hidden />
                PDF 내려받기
              </a>
            </div>
          </>
        ) : null}

        {notice ? <Notice tone="danger">{notice}</Notice> : null}
        <div ref={bottomRef} />
      </main>

      {showJump ? (
        <button
          type="button"
          onClick={() => {
            bottomRef.current?.scrollIntoView({ block: "end" });
            setShowJump(false);
          }}
          className="fixed bottom-11 left-1/2 z-20 inline-flex h-button-sm -translate-x-1/2 items-center gap-2 rounded-pill bg-gray-800 px-4 type-caption text-white shadow-float"
        >
          <ArrowDown size={18} aria-hidden />새 메시지
        </button>
      ) : null}

      {isDone ? (
        <div className="sticky bottom-0 flex flex-col gap-2 border-t border-gray-200 bg-white px-4 py-3 pb-safe">
          <p className="type-caption text-gray-600">
            {remaining > 0 ? `남은 질문 ${remaining}회 · ${scopeSummary}` : "질문을 모두 사용했어요"}
          </p>
          <form
            className="flex items-center gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              void ask();
            }}
          >
            <input
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              maxLength={200}
              disabled={remaining === 0 || sending !== null}
              placeholder={remaining > 0 ? "궁금한 점을 물어보세요" : "질문을 모두 사용했어요"}
              aria-label="후속 질문"
              className="motion-fast h-button min-w-0 flex-1 rounded-xl border border-gray-300 bg-gray-50 px-5 type-body text-gray-900 outline-none focus:border-primary-600"
            />
            <button
              type="submit"
              aria-label="보내기"
              disabled={!question.trim() || remaining === 0 || sending !== null}
              className="motion-fast inline-flex h-button w-button shrink-0 items-center justify-center rounded-full bg-primary-600 text-white hover:bg-primary-700 disabled:bg-gray-100 disabled:text-gray-500"
            >
              <Send size={18} aria-hidden />
            </button>
          </form>
        </div>
      ) : null}
    </>
  );
}
