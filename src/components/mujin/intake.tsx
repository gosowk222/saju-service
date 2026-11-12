"use client";

import { ChevronDown } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { CONCERN_MAX, NICKNAME_MAX, NicknameSchema, type Draft } from "@/domain/birth/input";
import {
  EMPTY_NOW,
  FAMILY_OPTIONS,
  NOW_LIMITS,
  RELATIONSHIP_OPTIONS,
  WORK_OPTIONS,
  type InterestChapterId,
  type MujinNow,
} from "@/domain/mujin/now";
import type { PersonaFace, PersonaIntakeLines } from "@/domain/personas";
import type { ScrollProductDefinition } from "@/domain/products";
import { apiFetch, ClientApiError } from "@/lib/client-api";
import { ChoiceCard, DateStep, INPUT, PlaceStep, ReviewRow, TimeStep, timeLabel, useDraftAutosave, useResolvedDate } from "@/components/intake-parts";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/layout";
import {
  familyDisabled,
  fillName,
  isSubmitEnter,
  limitedDisabled,
  limitNotice,
  nowAnswered,
  nowSummary,
  REVIEW_STEP,
  STEP_LINE,
  STEP_TITLES,
  stepAt,
  stepValid,
  toggleFamily,
  toggleInterest,
  toggleRelationship,
  toggleWork,
} from "./intake-model";
import { ConsultScene } from "./scene";

interface Props {
  readonly initialDraft: Draft;
  readonly product: ScrollProductDefinition;
  /** 캐릭터 설정의 lines.intake. 함수가 없는 문자열만 브라우저로 넘긴다. */
  readonly lines: PersonaIntakeLines;
  readonly face: PersonaFace;
  readonly personaName: string;
}

const TEXTAREA =
  "motion-fast w-full resize-none rounded-lg border border-gray-300 bg-gray-50 p-5 type-body text-gray-900 outline-none focus:border-primary-600 focus:shadow-(--focus-ring)";

/** 개수 제한 안내. 제한에 닿으면 나타나고, 막힌 선택지가 이 문장을 설명으로 읽게 한다. */
function LimitHint({ id, text }: { id: string; text: string | null }) {
  return (
    <p id={id} aria-live="polite" className="type-caption text-gray-600">
      {text ?? ""}
    </p>
  );
}

/** 관계·가족처럼 펼쳐서 고르는 영역. 처음 열린 상태만 정하고 그 뒤에는 사용자가 여닫는다. */
function Disclosure({ title, summary, defaultOpen, children }: { title: string; summary: string; defaultOpen: boolean; children: ReactNode }) {
  const [initiallyOpen] = useState(defaultOpen);
  return (
    <details open={initiallyOpen} className="group rounded-lg border border-gray-200 bg-white">
      <summary className="flex min-h-button-lg cursor-pointer list-none items-center justify-between gap-3 px-5 py-3 [&::-webkit-details-marker]:hidden">
        <span className="flex min-w-0 flex-col gap-1">
          <span className="type-label font-semibold text-gray-900">{title}</span>
          <span className="type-caption text-gray-600">{summary}</span>
        </span>
        <ChevronDown size={18} aria-hidden className="motion-fast shrink-0 text-gray-600 group-open:rotate-180" />
      </summary>
      <div className="flex flex-col gap-3 px-5 pb-5">{children}</div>
    </details>
  );
}

function NowStep({
  now,
  onChange,
  chapters,
}: {
  now: MujinNow;
  onChange: (now: MujinNow) => void;
  chapters: readonly { readonly id: InterestChapterId; readonly number: number; readonly title: string }[];
}) {
  const summary = nowSummary(now, (id) => chapters.find((chapter) => chapter.id === id)?.title ?? id);
  const workHint = limitNotice("work", now);
  const interestHint = limitNotice("interests", now);
  const familyHint = limitNotice("family", now);

  return (
    <div className="flex flex-col gap-7">
      <fieldset className="flex flex-col gap-3">
        <legend className="mb-3 type-label font-semibold text-gray-900">
          일·학업 상태 <span className="type-caption font-normal text-gray-600">최대 {NOW_LIMITS.work}개</span>
        </legend>
        <div className="grid grid-cols-2 gap-3">
          {WORK_OPTIONS.map((option) => {
            const disabled = limitedDisabled(now.work, option.id, NOW_LIMITS.work);
            return (
              <ChoiceCard
                key={option.id}
                selected={now.work.includes(option.id)}
                disabled={disabled}
                describedBy={disabled ? "now-work-limit" : undefined}
                onClick={() => {
                  if (!disabled) onChange({ ...now, work: toggleWork(now.work, option.id) });
                }}
                title={option.label}
              />
            );
          })}
        </div>
        <LimitHint id="now-work-limit" text={workHint} />
      </fieldset>

      <fieldset className="flex flex-col gap-3">
        <legend className="mb-3 type-label font-semibold text-gray-900">
          특히 궁금한 장 <span className="type-caption font-normal text-gray-600">최대 {NOW_LIMITS.interests}개 · 고르지 않으면 골고루 봐요</span>
        </legend>
        <div className="grid grid-cols-2 gap-3">
          {chapters.map((chapter) => {
            const disabled = limitedDisabled(now.interests, chapter.id, NOW_LIMITS.interests);
            return (
              <ChoiceCard
                key={chapter.id}
                selected={now.interests.includes(chapter.id)}
                disabled={disabled}
                describedBy={disabled ? "now-interest-limit" : undefined}
                onClick={() => {
                  if (!disabled) onChange({ ...now, interests: toggleInterest(now.interests, chapter.id) });
                }}
                title={chapter.title}
                description={`${chapter.number}장`}
              />
            );
          })}
        </div>
        <LimitHint id="now-interest-limit" text={interestHint} />
      </fieldset>

      <Disclosure title="지금의 연애·결혼 상태" summary={summary.relationship} defaultOpen={now.relationship !== null}>
        <div role="group" aria-label="지금의 연애·결혼 상태" className="grid grid-cols-2 gap-3">
          {RELATIONSHIP_OPTIONS.map((option) => (
            <ChoiceCard
              key={option.id}
              selected={now.relationship === option.id}
              onClick={() => onChange({ ...now, relationship: toggleRelationship(now.relationship, option.id) })}
              title={option.label}
            />
          ))}
        </div>
        <p className="type-caption text-gray-600">하나만 골라요. 고른 것을 다시 누르면 선택이 풀려요.</p>
      </Disclosure>

      <Disclosure title="가족 이야기에서 다루고 싶은 부분이 있나요?" summary={summary.family} defaultOpen={now.family.length > 0}>
        <div role="group" aria-label="가족 이야기에서 다루고 싶은 부분" className="grid grid-cols-2 gap-3">
          {FAMILY_OPTIONS.map((option) => {
            const disabled = familyDisabled(now.family, option.id);
            return (
              <ChoiceCard
                key={option.id}
                selected={now.family.includes(option.id)}
                disabled={disabled}
                describedBy={disabled ? "now-family-limit" : undefined}
                onClick={() => {
                  if (!disabled) onChange({ ...now, family: toggleFamily(now.family, option.id) });
                }}
                title={option.label}
              />
            );
          })}
        </div>
        <p className="type-caption text-gray-600">
          위 다섯 가지는 {NOW_LIMITS.family}개까지 고를 수 있어요. &apos;특별히 다루고 싶은 내용 없음&apos;과 &apos;답하고 싶지 않음&apos;은 다른 항목과 함께 고를 수 없어요.
        </p>
        <LimitHint id="now-family-limit" text={familyHint} />
      </Disclosure>
    </div>
  );
}

/**
 * 무진의 대화형 입력. 상담 장면(무진의 말) 아래에서 한 단계씩 받는다.
 * 순서: 별명 → 성별 → 생년월일 → 출생지역 → 출생시각 → 지금의 나 → 진짜 궁금한 점 → 확인.
 * 초안은 묘묘 입력과 같은 방식으로 자동 저장한다(/api/drafts). 제출하면 족자 화면(/readings/{id})으로 간다.
 */
export function MujinIntake({ initialDraft, product, lines, face, personaName }: Props) {
  const router = useRouter();
  const [draft, setDraft] = useState<Draft>(initialDraft);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 확인 화면에서 고치러 왔으면 다음 버튼이 확인 화면으로 돌아간다. */
  const [returnToReview, setReturnToReview] = useState(false);
  const save = useDraftAutosave(draft);
  const { resolved, branchRanges } = useResolvedDate(draft);
  const stepRef = useRef<HTMLDivElement>(null);
  /** 사용자가 단계를 옮겼을 때만 포커스를 옮긴다 (처음 열 때는 옮기지 않는다). */
  const moved = useRef(false);

  const update = useCallback((patch: Partial<Draft>) => setDraft((current) => ({ ...current, ...patch })), []);

  const stepIndex = Math.min(Math.max(draft.step, 0), REVIEW_STEP);
  const step = stepAt(stepIndex);
  const now = draft.now ?? EMPTY_NOW;
  const chapters = product.scroll.sections.flatMap((section) =>
    section.kind === "chapter" && section.number !== null ? [{ id: section.id as InterestChapterId, number: section.number, title: section.title }] : [],
  );
  const validity = {
    nickname: draft.nickname,
    gender: draft.gender,
    resolvedOk: resolved?.ok === true,
    hasPlace: draft.place !== null,
    hasTime: draft.birthTime !== null,
    concern: draft.concern,
    concernRequired: product.concern.required,
  };
  const canProceed = stepValid(step, validity);

  // 단계를 옮기면 그 단계의 입력칸(없으면 제목)으로 포커스를 옮겨 키보드와 화면 읽기 프로그램이 이어서 쓸 수 있게 한다.
  useEffect(() => {
    if (!moved.current) return;
    moved.current = false;
    const root = stepRef.current;
    const target = root?.querySelector<HTMLElement>("[data-autofocus]") ?? root?.querySelector<HTMLElement>("h1");
    target?.focus();
  }, [stepIndex]);

  const goTo = (next: number) => {
    setError(null);
    if (next === REVIEW_STEP) setReturnToReview(false);
    update({ step: next });
    void save();
    moved.current = true;
    window.scrollTo({ top: 0 });
  };
  const goNext = () => goTo(returnToReview ? REVIEW_STEP : stepIndex + 1);
  const edit = (target: number) => {
    setReturnToReview(true);
    goTo(target);
  };

  /** 입력칸에서 Enter를 누르면 다음 단계로. 한글 조합을 끝내는 Enter는 거른다. */
  const onEnterNext = (event: KeyboardEvent<HTMLInputElement>) => {
    if (!isSubmitEnter(event)) return;
    event.preventDefault();
    if (canProceed) goNext();
  };

  async function submit() {
    if (!resolved?.ok || !draft.place || !draft.birthTime || !draft.gender) return;
    setSubmitting(true);
    setError(null);
    // 저장이 늦게 끝나 제출 뒤 지워진 초안을 다시 만들지 않도록, 남은 변경을 먼저 저장한다.
    await save();
    try {
      const { readingId } = await apiFetch<{ readingId: string }>("/api/readings", {
        method: "POST",
        json: {
          productId: draft.productId,
          nickname: draft.nickname,
          gender: draft.gender,
          yymmdd: draft.yymmdd,
          calendar: draft.calendar,
          isLeapMonth: draft.isLeapMonth,
          geonameId: draft.place.geonameId,
          birthTime: draft.birthTime,
          situationId: null,
          concern: draft.concern,
          now,
        },
      });
      router.replace(`/readings/${readingId}`);
    } catch (failure) {
      setError(failure instanceof ClientApiError ? failure.message : "잠시 후 다시 시도해 주세요.");
      setSubmitting(false);
    }
  }

  const nickname = NicknameSchema.safeParse(draft.nickname);
  const line = fillName(lines[submitting ? "computing" : STEP_LINE[step]], draft.nickname);
  const summary = nowSummary(now, (id) => chapters.find((chapter) => chapter.id === id)?.title ?? id);
  const range = draft.birthTime?.status === "branch" ? branchRanges?.[draft.birthTime.branch] : undefined;
  const nextLabel = returnToReview
    ? "확인 화면으로"
    : (step === "now" && !nowAnswered(now)) || (step === "concern" && !draft.concern.trim())
      ? "건너뛰기"
      : "다음";

  return (
    <div className="flex flex-1 flex-col">
      <main className="flex flex-1 flex-col gap-6 px-5 py-6">
        <ConsultScene
          face={face}
          name={personaName}
          mode={submitting ? "computing" : "idle"}
          line={line}
          badge={submitting ? "계산 중" : null}
        />

        <div ref={stepRef} className="flex flex-col gap-5">
          <div className="flex flex-col gap-1">
            {step !== "review" ? (
              <p className="type-caption-sm text-primary-600">
                {stepIndex + 1} / {REVIEW_STEP}
              </p>
            ) : null}
            <h1 tabIndex={-1} className="type-title text-gray-900 outline-none">
              {STEP_TITLES[step]}
            </h1>
          </div>

          {step === "nickname" ? (
            <section className="flex flex-col gap-3">
              <input
                value={draft.nickname}
                onChange={(event) => update({ nickname: event.target.value })}
                onKeyDown={onEnterNext}
                enterKeyHint="next"
                maxLength={NICKNAME_MAX + 8}
                placeholder="별명"
                aria-label="별명"
                aria-describedby="mujin-nickname-hint"
                data-autofocus=""
                className={`${INPUT} scroll-mb-11`}
              />
              <p id="mujin-nickname-hint" className="type-caption text-gray-600">
                풀이에서 부를 이름이에요. 로그인 계정 이름과는 별개이고, {NICKNAME_MAX}자까지 쓸 수 있어요.
              </p>
              {draft.nickname && !nickname.success ? <Notice tone="danger">{nickname.error.issues[0]?.message}</Notice> : null}
            </section>
          ) : null}

          {step === "gender" ? (
            <div role="group" aria-label="성별" className="grid grid-cols-2 gap-3">
              <ChoiceCard selected={draft.gender === "male"} onClick={() => update({ gender: "male" })} title="남성" />
              <ChoiceCard selected={draft.gender === "female"} onClick={() => update({ gender: "female" })} title="여성" />
            </div>
          ) : null}

          {step === "birthDate" ? <DateStep draft={draft} update={update} resolved={resolved} onEnter={onEnterNext} /> : null}

          {step === "place" ? (
            <section className="flex flex-col gap-4">
              <p className="type-body text-gray-600">지금 사는 곳이 아니라 태어난 곳이에요. 고른 지역의 대표 좌표와 시간대로 계산해요.</p>
              <PlaceStep value={draft.place} onChange={(place) => update({ place })} markFocus />
              <p className="type-caption text-gray-600">
                지역 자료 출처:{" "}
                <a href="https://www.geonames.org/" target="_blank" rel="noreferrer">
                  GeoNames
                </a>{" "}
                (CC BY 4.0)
              </p>
            </section>
          ) : null}

          {step === "time" ? <TimeStep value={draft.birthTime} onChange={(birthTime) => update({ birthTime })} branchRanges={branchRanges} /> : null}

          {step === "now" ? <NowStep now={now} onChange={(next) => update({ now: next })} chapters={chapters} /> : null}

          {step === "concern" ? (
            <section className="flex flex-col gap-3">
              <p className="type-body text-gray-600">{product.concern.hint}</p>
              <textarea
                value={draft.concern}
                onChange={(event) => update({ concern: event.target.value.slice(0, CONCERN_MAX) })}
                rows={4}
                placeholder={product.concern.placeholder}
                aria-label={product.concern.title}
                data-autofocus=""
                className={`${TEXTAREA} scroll-mb-11`}
              />
              <p className="text-right type-caption text-gray-600">
                {draft.concern.length} / {CONCERN_MAX}
              </p>
            </section>
          ) : null}

          {step === "review" ? (
            <section className="flex flex-col gap-5">
              <div className="rounded-lg border border-gray-200 px-5">
                <ReviewRow label="별명" value={draft.nickname} onEdit={() => edit(0)} />
                <ReviewRow label="성별" value={draft.gender === "male" ? "남성" : draft.gender === "female" ? "여성" : "선택 전"} onEdit={() => edit(1)} />
                <ReviewRow
                  label="생년월일"
                  value={resolved?.ok ? resolved.display : draft.yymmdd.length === 6 && !resolved ? "확인하는 중이에요" : "다시 입력해 주세요"}
                  onEdit={() => edit(2)}
                />
                <ReviewRow label="출생지역" value={draft.place ? `${draft.place.admin} ${draft.place.name}`.trim() : "선택 전"} onEdit={() => edit(3)} />
                <ReviewRow
                  label="출생시각"
                  value={range ? `${timeLabel(draft.birthTime)} (${range.start} ~ ${range.end})` : timeLabel(draft.birthTime)}
                  onEdit={() => edit(4)}
                />
                <ReviewRow label="일·학업 상태" value={summary.work} onEdit={() => edit(5)} />
                <ReviewRow label="특히 궁금한 장" value={summary.interests} onEdit={() => edit(5)} />
                <ReviewRow label="연애·결혼 상태" value={summary.relationship} onEdit={() => edit(5)} />
                <ReviewRow label="가족 이야기" value={summary.family} onEdit={() => edit(5)} />
                <ReviewRow label={product.concern.title} value={draft.concern.trim() || "없음"} onEdit={() => edit(6)} />
              </div>
              {error ? <Notice tone="danger">{error}</Notice> : null}
            </section>
          ) : null}
        </div>
      </main>

      <div className="sticky bottom-0 flex gap-3 border-t border-gray-100 bg-white px-5 py-4 pb-safe">
        {stepIndex > 0 ? (
          <Button variant="secondary" size="md" className="h-button-lg" disabled={submitting} onClick={() => goTo(stepIndex - 1)}>
            이전
          </Button>
        ) : null}
        {step !== "review" ? (
          <Button size="lg" className="flex-1" disabled={!canProceed} onClick={goNext}>
            {nextLabel}
          </Button>
        ) : (
          <Button size="lg" className="flex-1" disabled={!canProceed || submitting} onClick={submit}>
            {submitting ? "원국을 계산하는 중이에요" : "이 내용으로 풀이 받기"}
          </Button>
        )}
      </div>
    </div>
  );
}
