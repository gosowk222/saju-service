"use client";

import { Download, Send } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { apiFetch, ClientApiError } from "@/lib/client-api";
import type { PersonaFace } from "@/domain/personas";
import type { ReadingStateView } from "@/server/readings/store";
import { RichText } from "@/components/rich-text";
import { buttonClass } from "@/components/ui/button";
import { Notice, PersonaAvatar, TypingDots } from "@/components/ui/layout";
import { isSubmitEnter } from "./intake-model";
import { FOLLOWUP_POLL_INTERVAL_MS, followupSnapshotOf, mergeFollowups, paragraphs, type FollowupSnapshot } from "./scroll-model";

/**
 * 족자 아래의 후속 질문 패널. 메신저와 같은 API(POST /followups, GET /state)와 같은 횟수·범위·차감 정책을 쓴다.
 * 답은 서버가 문단을 저장하는 대로 보여 주고, 말풍선마다 일부러 기다리는 연출(typing delay)은 넣지 않는다.
 * 입력칸은 화면 아래에 고정하지 않고 패널 안에 두어, 족자를 읽는 동안 본문을 가리지 않는다.
 */

function UserBubble({ children }: { children: ReactNode }) {
  return (
    <div className="flex justify-end">
      <p className="max-w-[85%] whitespace-pre-wrap wrap-break-word rounded-t-lg rounded-bl-lg rounded-br-(--space-2) bg-primary-600 px-4 py-4 type-body text-white">
        {children}
      </p>
    </div>
  );
}

function PersonaBubble({ face, name, children }: { face: PersonaFace; name: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <PersonaAvatar persona={face} />
      <div className="flex min-w-0 max-w-[85%] flex-col gap-1">
        <span className="type-caption-sm text-gray-600">{name}</span>
        <div className="flex flex-col gap-3 rounded-t-lg rounded-br-lg rounded-bl-(--space-2) bg-gray-100 px-4 py-4 type-body text-gray-900">{children}</div>
      </div>
    </div>
  );
}

export function FollowupPanel({
  readingId,
  face,
  personaName,
  initial,
  scopeSummary,
}: {
  readingId: string;
  face: PersonaFace;
  personaName: string;
  /** 서버가 처음 그릴 때 읽은 후속 질문. 이 화면에서 풀이가 끝났으면 없으므로 처음에 한 번 불러온다. */
  initial: FollowupSnapshot | null;
  scopeSummary: string;
}) {
  const [data, setData] = useState<FollowupSnapshot | null>(initial);
  const [question, setQuestion] = useState("");
  const [sending, setSending] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    const next = await apiFetch<ReadingStateView>(`/api/readings/${readingId}/state`);
    setData((current) => mergeFollowups(current, followupSnapshotOf(next)));
  }, [readingId]);

  // 이 화면에서 풀이가 끝났으면 서버가 처음 그릴 때 읽은 기록이 없으므로 한 번 불러온다.
  useEffect(() => {
    if (initial) return;
    let cancelled = false;
    apiFetch<ReadingStateView>(`/api/readings/${readingId}/state`)
      .then((next) => {
        if (!cancelled) setData((current) => mergeFollowups(current, followupSnapshotOf(next)));
      })
      .catch((failure: unknown) => {
        if (!cancelled) setNotice(failure instanceof ClientApiError ? failure.message : "질문 기록을 불러오지 못했어요.");
      });
    return () => {
      cancelled = true;
    };
  }, [initial, readingId]);

  // 답을 쓰는 동안 저장 상태를 확인해, 완성된 문단을 먼저 보여 준다.
  const inflight = data?.followups.find((followup) => followup.status === "answering");
  const answering = sending !== null || inflight !== undefined;
  useEffect(() => {
    if (!answering) return;
    const timer = setInterval(() => {
      load().catch(() => undefined);
    }, FOLLOWUP_POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [answering, load]);

  const remaining = data ? Math.max(data.questionLimit - data.questionsUsed, 0) : 0;

  async function ask() {
    const text = question.trim();
    if (!text || sending !== null || remaining === 0 || !data) return;
    setSending(text);
    setNotice(null);
    setQuestion("");
    try {
      await apiFetch(`/api/readings/${readingId}/followups`, {
        method: "POST",
        json: { clientRequestId: crypto.randomUUID(), question: text },
      });
      await load();
    } catch (failure) {
      setQuestion(text);
      setNotice(failure instanceof ClientApiError ? failure.message : "잠시 후 다시 시도해 주세요.");
    } finally {
      setSending(null);
    }
  }

  return (
    <section aria-labelledby="followup-title" className="flex flex-col gap-5 rounded-lg border border-gray-200 bg-white p-5">
      <div className="flex flex-col gap-1">
        <h2 id="followup-title" className="type-title text-gray-900">
          {personaName}에게 더 묻기
        </h2>
        <p className="type-caption text-gray-600">{data ? (remaining > 0 ? `남은 질문 ${remaining}회 · ${scopeSummary}` : "질문을 모두 사용했어요") : "질문 기록을 불러오는 중이에요"}</p>
      </div>

      {data?.followups.length ? (
        <ol className="flex flex-col gap-4">
          {data.followups.map((followup) => {
            const parts = paragraphs(followup.answer ?? "");
            const writing = followup.status === "answering";
            return (
              <li key={followup.id} className="flex flex-col gap-3">
                <UserBubble>{followup.question}</UserBubble>
                <div aria-live={writing ? "polite" : undefined}>
                  {parts.length || writing ? (
                    <PersonaBubble face={face} name={personaName}>
                      {parts.map((part, index) => (
                        <p key={index} className="whitespace-pre-wrap wrap-break-word">
                          <RichText text={part} />
                        </p>
                      ))}
                      {writing ? (
                        <span className="flex items-center gap-2">
                          <TypingDots />
                          <span className="sr-only">답을 쓰고 있어요</span>
                        </span>
                      ) : null}
                    </PersonaBubble>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ol>
      ) : null}

      {/* 서버가 질문을 받기 전까지만 보낸 질문을 따로 보여 준다. 받은 뒤에는 위 목록에 나온다. */}
      {sending && !inflight ? (
        <div className="flex flex-col gap-3">
          <UserBubble>{sending}</UserBubble>
          <PersonaBubble face={face} name={personaName}>
            <TypingDots />
            <span className="sr-only">답을 쓰고 있어요</span>
          </PersonaBubble>
        </div>
      ) : null}

      {notice ? <Notice tone="danger">{notice}</Notice> : null}

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
          onKeyDown={(event) => {
            // 한글 조합을 끝내는 Enter로 질문이 보내지지 않게 한다.
            if (event.key === "Enter" && !isSubmitEnter(event)) event.preventDefault();
          }}
          enterKeyHint="send"
          maxLength={200}
          disabled={!data || remaining === 0 || sending !== null}
          placeholder={remaining > 0 || !data ? "궁금한 점을 물어보세요" : "질문을 모두 사용했어요"}
          aria-label="후속 질문"
          className="motion-fast h-button min-w-0 flex-1 scroll-mb-11 rounded-xl border border-gray-300 bg-gray-50 px-5 type-body text-gray-900 outline-none focus:border-primary-600"
        />
        <button
          type="submit"
          aria-label="보내기"
          disabled={!question.trim() || !data || remaining === 0 || sending !== null}
          className="motion-fast inline-flex h-button w-button shrink-0 items-center justify-center rounded-full bg-primary-600 text-white hover:bg-primary-700 disabled:bg-gray-100 disabled:text-gray-500"
        >
          <Send size={18} aria-hidden />
        </button>
      </form>
    </section>
  );
}

/** 전체 풀이가 끝난 뒤의 PDF 내려받기. 서버가 권한과 완료를 다시 확인한다. */
export function PdfCard({ readingId }: { readingId: string }) {
  const [includeFollowups, setIncludeFollowups] = useState(false);
  return (
    <section aria-label="PDF로 저장하기" className="flex flex-col gap-3 rounded-lg border border-gray-200 bg-white p-5">
      <p className="type-label font-semibold text-gray-900">PDF로 저장하기</p>
      <label className="flex min-h-button items-center gap-3 type-label font-normal text-gray-700">
        <input type="checkbox" className="h-5 w-5 accent-primary-600" checked={includeFollowups} onChange={(event) => setIncludeFollowups(event.target.checked)} />
        후속 질문과 답변도 포함하기
      </label>
      <a className={buttonClass("secondary", "md")} href={`/api/readings/${readingId}/pdf${includeFollowups ? "?followups=1" : ""}`} download>
        <Download size={18} aria-hidden />
        PDF 내려받기
      </a>
    </section>
  );
}
