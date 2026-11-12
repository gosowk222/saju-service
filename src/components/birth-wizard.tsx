"use client";

import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import { CONCERN_MAX, NICKNAME_MAX, NicknameSchema, type Draft } from "@/domain/birth/input";
import type { ProductDefinition } from "@/domain/products";
import { apiFetch, ClientApiError } from "@/lib/client-api";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/layout";
import { ChoiceCard, DateStep, INPUT, PlaceStep, ReviewRow, TimeStep, timeLabel, useDraftAutosave, useResolvedDate } from "@/components/intake-parts";

const STEP_TITLES = ["별명", "성별", "생년월일", "출생지역", "출생시간", "현재 상황", "궁금한 점"] as const;
const REVIEW_STEP = STEP_TITLES.length;

export function BirthWizard({ initialDraft, product }: { initialDraft: Draft; product: ProductDefinition }) {
  const router = useRouter();
  const [draft, setDraft] = useState<Draft>(initialDraft);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = useDraftAutosave(draft);
  const { resolved, branchRanges } = useResolvedDate(draft);

  const update = useCallback((patch: Partial<Draft>) => setDraft((current) => ({ ...current, ...patch })), []);

  const step = Math.min(draft.step, REVIEW_STEP);
  const goTo = (next: number) => {
    setError(null);
    update({ step: next });
    void save();
    window.scrollTo({ top: 0 });
  };

  const nickname = NicknameSchema.safeParse(draft.nickname);
  const stepValid = [
    nickname.success,
    draft.gender !== null,
    resolved?.ok === true,
    draft.place !== null,
    draft.birthTime !== null,
    !product.situation.required || draft.situationId !== null,
    !product.concern.required || draft.concern.trim().length > 0,
  ];
  const canProceed = step === REVIEW_STEP ? stepValid.every(Boolean) : stepValid[step];

  async function submit() {
    if (!resolved?.ok || !draft.place || !draft.birthTime || !draft.gender) return;
    setSubmitting(true);
    setError(null);
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
          situationId: draft.situationId,
          concern: draft.concern,
        },
      });
      router.replace(`/readings/${readingId}/preview`);
    } catch (failure) {
      setError(failure instanceof ClientApiError ? failure.message : "잠시 후 다시 시도해 주세요.");
      setSubmitting(false);
    }
  }

  const situationLabel = product.situation.options.find((option) => option.id === draft.situationId)?.label ?? "알려 주지 않음";

  return (
    <div className="flex flex-1 flex-col">
      <main className="flex flex-1 flex-col gap-7 px-5 py-6">
        {step < REVIEW_STEP ? (
          <>
            <div className="flex flex-col gap-3">
              <p className="type-caption-sm text-primary-600">
                {step + 1} / {STEP_TITLES.length}
              </p>
              <div className="h-1 w-full overflow-hidden rounded-full bg-gray-100">
                <div className="motion-fast h-full bg-primary-600" style={{ width: `${((step + 1) / STEP_TITLES.length) * 100}%` }} />
              </div>
            </div>
            {step === 0 ? (
              <section className="flex flex-col gap-5">
                <h1 className="type-h2">뭐라고 불러 드릴까요?</h1>
                <p className="type-body text-gray-600">풀이에서 부를 이름이에요. 로그인 계정 이름과는 별개예요.</p>
                <input
                  value={draft.nickname}
                  onChange={(event) => update({ nickname: event.target.value })}
                  maxLength={NICKNAME_MAX + 8}
                  placeholder="별명"
                  aria-label="별명"
                  className={INPUT}
                />
                {draft.nickname && !nickname.success ? <Notice tone="danger">{nickname.error.issues[0]?.message}</Notice> : null}
              </section>
            ) : null}
            {step === 1 ? (
              <section className="flex flex-col gap-5">
                <h1 className="type-h2">성별을 알려 주세요</h1>
                <div className="grid grid-cols-2 gap-3">
                  <ChoiceCard selected={draft.gender === "male"} onClick={() => update({ gender: "male" })} title="남성" />
                  <ChoiceCard selected={draft.gender === "female"} onClick={() => update({ gender: "female" })} title="여성" />
                </div>
              </section>
            ) : null}
            {step === 2 ? (
              <section className="flex flex-col gap-5">
                <h1 className="type-h2">언제 태어났나요?</h1>
                <DateStep draft={draft} update={update} resolved={resolved} />
              </section>
            ) : null}
            {step === 3 ? (
              <section className="flex flex-col gap-5">
                <h1 className="type-h2">어디서 태어났나요?</h1>
                <p className="type-body text-gray-600">지금 사는 곳이 아니라 태어난 지역을 골라 주세요. 그 지역의 대표 좌표로 계산해요.</p>
                <PlaceStep value={draft.place} onChange={(place) => update({ place })} />
                <p className="type-caption text-gray-600">
                  지역 자료 출처:{" "}
                  <a href="https://www.geonames.org/" target="_blank" rel="noreferrer">
                    GeoNames
                  </a>{" "}
                  (CC BY 4.0)
                </p>
              </section>
            ) : null}
            {step === 4 ? (
              <section className="flex flex-col gap-5">
                <h1 className="type-h2">몇 시쯤 태어났나요?</h1>
                <TimeStep value={draft.birthTime} onChange={(birthTime) => update({ birthTime })} branchRanges={branchRanges} />
              </section>
            ) : null}
            {step === 5 ? (
              <section className="flex flex-col gap-5">
                <h1 className="type-h2">{product.situation.title}</h1>
                <p className="type-body text-gray-600">풀이를 읽기 편하게 맞추는 데만 써요. 사주로 알아낸 내용처럼 말하지 않아요.</p>
                <div className="grid grid-cols-2 gap-3">
                  {product.situation.options.map((option) => (
                    <ChoiceCard
                      key={option.id}
                      selected={draft.situationId === option.id}
                      onClick={() => update({ situationId: draft.situationId === option.id ? null : option.id })}
                      title={option.label}
                    />
                  ))}
                </div>
              </section>
            ) : null}
            {step === 6 ? (
              <section className="flex flex-col gap-5">
                <h1 className="type-h2">{product.concern.title}</h1>
                <p className="type-body text-gray-600">{product.concern.hint}</p>
                <textarea
                  value={draft.concern}
                  onChange={(event) => update({ concern: event.target.value.slice(0, CONCERN_MAX) })}
                  rows={4}
                  placeholder={product.concern.placeholder}
                  aria-label="궁금한 점"
                  className="motion-fast w-full resize-none rounded-lg border border-gray-300 bg-gray-50 p-5 type-body text-gray-900 outline-none focus:border-primary-600 focus:shadow-(--focus-ring)"
                />
                <p className="text-right type-caption text-gray-600">
                  {draft.concern.length} / {CONCERN_MAX}
                </p>
              </section>
            ) : null}
          </>
        ) : (
          <section className="flex flex-col gap-5">
            <h1 className="type-h2">입력한 내용을 확인해 주세요</h1>
            <div className="rounded-lg border border-gray-200 px-5">
              <ReviewRow label="별명" value={draft.nickname} onEdit={() => goTo(0)} />
              <ReviewRow label="성별" value={draft.gender === "male" ? "남성" : draft.gender === "female" ? "여성" : "선택 전"} onEdit={() => goTo(1)} />
              <ReviewRow label="생년월일" value={resolved?.ok ? resolved.display : "다시 입력해 주세요"} onEdit={() => goTo(2)} />
              <ReviewRow label="출생지역" value={draft.place ? `${draft.place.admin} ${draft.place.name}`.trim() : "선택 전"} onEdit={() => goTo(3)} />
              <ReviewRow label="출생시간" value={timeLabel(draft.birthTime)} onEdit={() => goTo(4)} />
              <ReviewRow label="현재 상황" value={situationLabel} onEdit={() => goTo(5)} />
              <ReviewRow label="궁금한 점" value={draft.concern.trim() || "없음"} onEdit={() => goTo(6)} />
            </div>
            {error ? <Notice tone="danger">{error}</Notice> : null}
          </section>
        )}
      </main>
      <div className="sticky bottom-0 flex gap-3 border-t border-gray-100 bg-white px-5 py-4 pb-safe">
        {step > 0 ? (
          <Button variant="secondary" size="md" className="h-button-lg" onClick={() => goTo(step - 1)}>
            이전
          </Button>
        ) : null}
        {step < REVIEW_STEP ? (
          <Button size="lg" className="flex-1" disabled={!canProceed} onClick={() => goTo(step + 1)}>
            {(step === 5 && !draft.situationId) || (step === 6 && !draft.concern.trim()) ? "건너뛰기" : "다음"}
          </Button>
        ) : (
          <Button size="lg" className="flex-1" disabled={!canProceed || submitting} onClick={submit}>
            {submitting ? "계산하는 중이에요" : "내 사주 보기"}
          </Button>
        )}
      </div>
    </div>
  );
}
