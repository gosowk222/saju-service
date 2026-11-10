"use client";

import { ArrowDown, Download, Send } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiFetch, ClientApiError } from "@/lib/client-api";
import type { ReadingStateView } from "@/server/readings/store";
import { Button, buttonClass } from "@/components/ui/button";
import { Notice, PersonaAvatar, TypingDots } from "@/components/ui/layout";

const REVEAL_INTERVAL_MS = 700;
const POLL_INTERVAL_MS = 3000;
const NEAR_BOTTOM_PX = 120;

interface Props {
  readonly readingId: string;
  readonly personaName: string;
  readonly personaGlyph: string;
  readonly topicTitles: Readonly<Record<string, string>>;
  /** 후속 질문 입력 아래에 보여 줄 상품 범위 안내. */
  readonly scopeSummary: string;
  readonly initialState: ReadingStateView;
}

function Bubble({
  glyph,
  name,
  children,
  animate,
  scene,
}: {
  glyph: string;
  name: string;
  children: React.ReactNode;
  animate?: boolean;
  scene?: boolean;
}) {
  return (
    <div className={`flex items-start gap-3 ${animate ? "animate-bubble" : ""}`}>
      <PersonaAvatar glyph={glyph} />
      <div className="flex min-w-0 max-w-[85%] flex-col gap-1">
        <span className="type-caption-sm text-gray-600">{name}</span>
        <div
          className={`whitespace-pre-wrap break-words rounded-t-lg rounded-br-lg rounded-bl-[var(--space-2)] px-4 py-4 type-body text-gray-900 ${
            scene ? "border border-primary-200 bg-primary-50" : "bg-gray-100"
          }`}
        >
          {scene ? <span className="mb-1 block type-caption-sm text-primary-600">예시 장면</span> : null}
          {children}
        </div>
      </div>
    </div>
  );
}

function MyBubble({ children, animate }: { children: React.ReactNode; animate?: boolean }) {
  return (
    <div className={`flex justify-end ${animate ? "animate-bubble" : ""}`}>
      <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-t-lg rounded-bl-lg rounded-br-[var(--space-2)] bg-primary-600 px-4 py-4 type-body text-white">
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

export function Messenger({ readingId, personaName, personaGlyph, topicTitles, scopeSummary, initialState }: Props) {
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
  const stickToBottom = useRef(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const started = useRef(false);

  const animating = animateReveal && !skipReveal && revealed < state.messages.length;

  const startGeneration = useCallback(
    async (retry: boolean) => {
      setStarting(true);
      setNotice(null);
      try {
        const next = await apiFetch<ReadingStateView>(`/api/readings/${readingId}/generate`, { method: "POST", json: { retry } });
        setState(next);
      } catch (failure) {
        setNotice(failure instanceof ClientApiError ? failure.message : "잠시 후 다시 시도해 주세요.");
      } finally {
        setStarting(false);
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

  // 다른 탭이나 요청에서 생성 중이면 저장 상태를 주기적으로 확인한다.
  useEffect(() => {
    if (state.status !== "running" && !(state.status === "queued" && !starting)) return;
    const timer = setInterval(() => {
      apiFetch<ReadingStateView>(`/api/readings/${readingId}/state`)
        .then((next) => {
          if (next.status === "queued") started.current = false;
          setState(next);
        })
        .catch(() => undefined);
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [state.status, starting, readingId]);

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

  useEffect(() => {
    if (!animating && sending === null) return;
    if (stickToBottom.current) bottomRef.current?.scrollIntoView({ block: "end" });
    else setShowJump(true);
  }, [revealed, animating, sending, state.followups.length]);

  const visible = useMemo(
    () => (animateReveal && !skipReveal ? state.messages.slice(0, revealed) : state.messages),
    [animateReveal, skipReveal, state.messages, revealed],
  );
  const remaining = Math.max(state.questionLimit - state.questionsUsed, 0);
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
              <Bubble glyph={personaGlyph} name={personaName} animate={animating} scene={message.kind === "creative-scene"}>
                {message.text}
              </Bubble>
            </div>
          );
        })}

        {state.status === "queued" || state.status === "running" ? (
          <div aria-live="polite" className="flex flex-col gap-3">
            <Bubble glyph={personaGlyph} name={personaName}>
              <TypingDots />
            </Bubble>
            <p className="self-center type-caption text-gray-600">{personaName}이 풀이를 쓰고 있어요. 1~2분 정도 걸려요.</p>
          </div>
        ) : null}

        {animating ? (
          <div className="flex flex-col gap-3">
            <Bubble glyph={personaGlyph} name={personaName}>
              <TypingDots />
            </Bubble>
            <button type="button" onClick={() => setSkipReveal(true)} className="self-center type-label text-primary-600">
              전체 바로 보기
            </button>
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
            {state.followups.map((followup) => (
              <div key={followup.id} className="flex flex-col gap-4">
                <MyBubble>{followup.question}</MyBubble>
                {followup.answer ? (
                  <Bubble glyph={personaGlyph} name={personaName}>
                    {followup.answer}
                  </Bubble>
                ) : null}
              </div>
            ))}
            {sending ? (
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
