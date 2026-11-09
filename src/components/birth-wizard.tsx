"use client";

import { Check, Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ResolvedBirthDate } from "@/domain/birth/date";
import { BRANCH_OPTIONS, CONCERN_MAX, NICKNAME_MAX, NicknameSchema, type Draft } from "@/domain/birth/input";
import type { ProductDefinition } from "@/domain/products";
import { apiFetch, ClientApiError } from "@/lib/client-api";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/layout";

interface PlaceResult {
  readonly geonameId: number;
  readonly name: string;
  readonly admin: string;
}

type BranchRanges = Readonly<Record<string, { readonly start: string; readonly end: string }>> | null;

const STEP_TITLES = ["별명", "성별", "생년월일", "출생지역", "출생시간", "현재 상황", "궁금한 점"] as const;
const REVIEW_STEP = STEP_TITLES.length;

const INPUT =
  "motion-fast h-input w-full rounded-lg border border-gray-300 bg-gray-50 px-5 type-body-lg text-gray-900 outline-none focus:border-primary-600 focus:shadow-[var(--focus-ring)]";

function ChoiceCard({
  selected,
  onClick,
  title,
  description,
}: {
  selected: boolean;
  onClick: () => void;
  title: string;
  description?: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={`motion-fast pressable flex min-h-button-lg w-full flex-col items-start justify-center gap-1 rounded-lg border px-5 py-3 text-left ${
        selected ? "border-primary-600 bg-primary-50 outline outline-1 outline-primary-600" : "border-gray-200 bg-white hover:border-gray-300"
      }`}
    >
      <span className="type-label font-semibold text-gray-900">{title}</span>
      {description ? <span className="type-caption text-gray-600">{description}</span> : null}
    </button>
  );
}

function Segment<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="grid auto-cols-fr grid-flow-col gap-1 rounded-lg bg-gray-100 p-1">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          onClick={() => onChange(option.value)}
          className={`motion-fast h-button rounded-md type-label ${value === option.value ? "bg-white font-semibold text-gray-900" : "text-gray-600"}`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function useDraftAutosave(draft: Draft) {
  const latest = useRef(draft);
  const lastSaved = useRef(JSON.stringify(draft));

  useEffect(() => {
    latest.current = draft;
  }, [draft]);

  const save = useCallback(async () => {
    const serialized = JSON.stringify(latest.current);
    if (serialized === lastSaved.current) return;
    lastSaved.current = serialized;
    await apiFetch("/api/drafts", { method: "PUT", json: latest.current }).catch(() => {
      lastSaved.current = "";
    });
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => void save(), 500);
    return () => clearTimeout(timer);
  }, [draft, save]);

  // 화면을 떠날 때 남은 변경을 저장한다.
  useEffect(() => {
    const flush = () => {
      if (document.visibilityState === "hidden") void save();
    };
    document.addEventListener("visibilitychange", flush);
    return () => document.removeEventListener("visibilitychange", flush);
  }, [save]);

  return save;
}

function useResolvedDate(draft: Draft) {
  const { yymmdd, calendar, isLeapMonth } = draft;
  const geonameId = draft.place?.geonameId ?? null;
  const requestKey = `${yymmdd}|${calendar}|${isLeapMonth}|${geonameId}`;
  const [fetched, setFetched] = useState<{ key: string; resolved: ResolvedBirthDate; branchRanges: BranchRanges } | null>(null);

  useEffect(() => {
    if (yymmdd.length !== 6) return;
    const controller = new AbortController();
    apiFetch<{ resolved: ResolvedBirthDate; branchRanges?: BranchRanges }>("/api/birth/resolve", {
      method: "POST",
      signal: controller.signal,
      json: { yymmdd, calendar, isLeapMonth, geonameId },
    })
      .then((result) => setFetched({ key: requestKey, resolved: result.resolved, branchRanges: result.branchRanges ?? null }))
      .catch(() => undefined);
    return () => controller.abort();
  }, [yymmdd, calendar, isLeapMonth, geonameId, requestKey]);

  // 입력이 바뀌면 이전 결과를 보여 주지 않는다.
  const current = yymmdd.length === 6 && fetched?.key === requestKey ? fetched : null;
  return { resolved: current?.resolved ?? null, branchRanges: current?.branchRanges ?? null };
}

function PlaceStep({ value, onChange }: { value: Draft["place"]; onChange: (place: Draft["place"]) => void }) {
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<{ query: string; results: readonly PlaceResult[] } | null>(null);
  const [searching, setSearching] = useState(!value);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!query.trim()) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      apiFetch<{ results: PlaceResult[] }>(`/api/places/search?q=${encodeURIComponent(query)}`, { signal: controller.signal })
        .then((data) => {
          setFound({ query, results: data.results });
          setError(null);
        })
        .catch((failure: unknown) => {
          if (failure instanceof ClientApiError) setError(failure.message);
        });
    }, 200);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  const results = query.trim() && found?.query === query ? found.results : null;

  if (value && !searching) {
    return (
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-3 rounded-lg border border-primary-600 bg-primary-50 px-5 py-4">
          <div className="min-w-0">
            <p className="type-label font-semibold text-gray-900">{value.name}</p>
            {value.admin ? <p className="type-caption text-gray-600">{value.admin}</p> : null}
          </div>
          <Check size={18} className="shrink-0 text-primary-600" aria-hidden />
        </div>
        <Button variant="secondary" onClick={() => setSearching(true)}>
          다른 지역 찾기
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="relative">
        <Search size={18} className="absolute left-5 top-1/2 -translate-y-1/2 text-gray-500" aria-hidden />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="예: 부산 해운대, 안동, 양평"
          aria-label="출생지역 검색"
          maxLength={40}
          className={`${INPUT} pl-10`}
        />
      </div>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {results && results.length === 0 ? (
        <p className="rounded-md bg-gray-50 px-4 py-4 type-label font-normal text-gray-700">
          찾는 지역이 없어요. 시나 군, 읍면 이름으로 다시 검색해 보세요.
        </p>
      ) : null}
      {results && results.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {results.map((place) => (
            <li key={place.geonameId}>
              <button
                type="button"
                onClick={() => {
                  onChange({ geonameId: place.geonameId, name: place.name, admin: place.admin });
                  setSearching(false);
                  setQuery("");
                }}
                className="motion-fast flex min-h-button-lg w-full flex-col justify-center rounded-md border border-gray-200 px-5 py-3 text-left hover:border-gray-300"
              >
                <span className="type-label font-semibold text-gray-900">{place.name}</span>
                {place.admin ? <span className="type-caption text-gray-600">{place.admin}</span> : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function DateStep({
  draft,
  update,
  resolved,
}: {
  draft: Draft;
  update: (patch: Partial<Draft>) => void;
  resolved: ResolvedBirthDate | null;
}) {
  return (
    <div className="flex flex-col gap-5">
      <Segment
        label="달력"
        value={draft.calendar}
        options={[
          { value: "solar", label: "양력" },
          { value: "lunar", label: "음력" },
        ]}
        onChange={(calendar) => update({ calendar, isLeapMonth: calendar === "solar" ? false : draft.isLeapMonth })}
      />
      <div className="flex flex-col gap-2">
        <input
          value={draft.yymmdd}
          onChange={(event) => update({ yymmdd: event.target.value.replace(/\D/g, "").slice(0, 6) })}
          inputMode="numeric"
          pattern="[0-9]*"
          autoComplete="off"
          placeholder="예: 980919"
          aria-label="생년월일 여섯 자리"
          aria-describedby="date-result"
          className={`${INPUT} type-price`}
        />
        <p id="date-result" aria-live="polite" className="min-h-5 type-label font-normal">
          {resolved?.ok ? <span className="font-semibold text-primary-600">{resolved.display}</span> : null}
          {resolved && !resolved.ok ? <span className="text-rose-600">{resolved.message}</span> : null}
          {!resolved ? <span className="text-gray-600">연도 앞 두 자리는 입력하지 않아도 돼요.</span> : null}
        </p>
      </div>
      {draft.calendar === "lunar" ? (
        <label className="flex min-h-button items-center gap-3 type-label text-gray-900">
          <input
            type="checkbox"
            checked={draft.isLeapMonth}
            onChange={(event) => update({ isLeapMonth: event.target.checked })}
            className="h-5 w-5 accent-primary-600"
          />
          윤달이에요
        </label>
      ) : null}
    </div>
  );
}

function TimeStep({
  value,
  onChange,
  branchRanges,
}: {
  value: Draft["birthTime"];
  onChange: (value: Draft["birthTime"]) => void;
  branchRanges: BranchRanges;
}) {
  return (
    <div className="flex flex-col gap-4">
      <ChoiceCard
        selected={value?.status === "unknown"}
        onClick={() => onChange({ status: "unknown" })}
        title="시간을 몰라요"
        description="시주를 빼고 볼 수 있는 범위만 읽어요"
      />
      <div className="grid grid-cols-2 gap-3">
        {BRANCH_OPTIONS.map((option) => {
          const range = branchRanges?.[option.value];
          return (
            <ChoiceCard
              key={option.value}
              selected={value?.status === "branch" && value.branch === option.value}
              onClick={() => onChange({ status: "branch", branch: option.value })}
              title={option.label}
              description={range ? `${range.start} ~ ${range.end}` : option.hint}
            />
          );
        })}
      </div>
      <p className="type-caption text-gray-600">
        표시된 시각은 태어난 지역의 시계로 본 대략적인 범위예요. 정확한 분까지 몰라도 괜찮아요. 고른 시간대를 그 시간대의 대표 시각으로 계산해요.
      </p>
    </div>
  );
}

function ReviewRow({ label, value, onEdit }: { label: string; value: string; onEdit: () => void }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-gray-100 py-4 last:border-b-0">
      <div className="min-w-0">
        <p className="type-caption text-gray-600">{label}</p>
        <p className="break-words type-label font-semibold text-gray-900">{value}</p>
      </div>
      <Button variant="ghost" onClick={onEdit} aria-label={`${label} 수정`} className="shrink-0 px-4">
        수정
      </Button>
    </div>
  );
}

function timeLabel(time: Draft["birthTime"]): string {
  if (!time) return "선택 전";
  if (time.status === "unknown") return "시간 모름";
  return BRANCH_OPTIONS.find((option) => option.value === time.branch)?.label ?? "";
}

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
                <p className="type-body text-gray-600">없으면 건너뛰어도 돼요.</p>
                <textarea
                  value={draft.concern}
                  onChange={(event) => update({ concern: event.target.value.slice(0, CONCERN_MAX) })}
                  rows={4}
                  placeholder={product.concern.placeholder}
                  aria-label="궁금한 점"
                  className="motion-fast w-full resize-none rounded-lg border border-gray-300 bg-gray-50 p-5 type-body text-gray-900 outline-none focus:border-primary-600 focus:shadow-[var(--focus-ring)]"
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
