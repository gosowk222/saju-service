"use client";

/**
 * 출생 입력 화면이 함께 쓰는 부품. 묘묘의 단계형 입력(birth-wizard.tsx)과 무진의 대화형 입력(mujin/intake.tsx)이 쓴다.
 * birth-wizard.tsx 안에 있던 비공개 부품을 그대로 옮겼다. 묘묘 화면의 모양과 동작은 바뀌지 않는다.
 * 무진 화면을 위해 더한 선택 속성(ChoiceCard의 disabled·describedBy, DateStep의 onEnter)은 넘기지 않으면 예전과 같다.
 */

import { Check, Search } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { ResolvedBirthDate } from "@/domain/birth/date";
import { BRANCH_OPTIONS, type Draft } from "@/domain/birth/input";
import { apiFetch, ClientApiError } from "@/lib/client-api";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/layout";

export interface PlaceResult {
  readonly geonameId: number;
  readonly name: string;
  readonly admin: string;
}

export type BranchRanges = Readonly<Record<string, { readonly start: string; readonly end: string }>> | null;

export const INPUT =
  "motion-fast h-input w-full rounded-lg border border-gray-300 bg-gray-50 px-5 type-body-lg text-gray-900 outline-none focus:border-primary-600 focus:shadow-(--focus-ring)";

/**
 * 고르는 카드. disabled는 개수 제한 때문에 지금 더 고를 수 없는 선택지다. 누를 수 있게 두고(aria-disabled)
 * 누르면 이유를 알려 주도록 화면이 처리한다. describedBy는 그 이유 문장의 id다.
 */
export function ChoiceCard({
  selected,
  onClick,
  title,
  description,
  disabled = false,
  describedBy,
}: {
  selected: boolean;
  onClick: () => void;
  title: string;
  description?: string;
  disabled?: boolean;
  describedBy?: string;
}) {
  const muted = disabled && !selected;
  return (
    <button
      type="button"
      aria-pressed={selected}
      aria-disabled={muted || undefined}
      aria-describedby={describedBy}
      onClick={onClick}
      className={`motion-fast pressable flex min-h-button-lg w-full flex-col items-start justify-center gap-1 rounded-lg border px-5 py-3 text-left ${
        selected
          ? "border-primary-600 bg-primary-50 outline-1 outline-primary-600"
          : muted
            ? "border-gray-200 bg-gray-50"
            : "border-gray-200 bg-white hover:border-gray-300"
      }`}
    >
      <span className={`type-label font-semibold ${muted ? "text-gray-500" : "text-gray-900"}`}>{title}</span>
      {description ? <span className="type-caption text-gray-600">{description}</span> : null}
    </button>
  );
}

export function Segment<T extends string>({
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

export function useDraftAutosave(draft: Draft) {
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

export function useResolvedDate(draft: Draft) {
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

/** markFocus: 단계를 옮겼을 때 화면이 검색칸에 포커스를 줄 수 있게 표시한다 (무진 입력). 주지 않으면 예전과 같다. */
export function PlaceStep({
  value,
  onChange,
  markFocus = false,
}: {
  value: Draft["place"];
  onChange: (place: Draft["place"]) => void;
  markFocus?: boolean;
}) {
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
          data-autofocus={markFocus ? "" : undefined}
          className={`${INPUT} pl-10${markFocus ? " scroll-mb-11" : ""}`}
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

/**
 * 생년월일 단계. onEnter를 주면 날짜 입력칸에서 Enter로 다음 단계로 넘어간다 (한글 조합 중 Enter는 화면이 거른다).
 * 주지 않으면 예전처럼 Enter에 반응하지 않는다.
 */
export function DateStep({
  draft,
  update,
  resolved,
  onEnter,
}: {
  draft: Draft;
  update: (patch: Partial<Draft>) => void;
  resolved: ResolvedBirthDate | null;
  onEnter?: (event: KeyboardEvent<HTMLInputElement>) => void;
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
          onKeyDown={onEnter}
          enterKeyHint={onEnter ? "next" : undefined}
          data-autofocus={onEnter ? "" : undefined}
          inputMode="numeric"
          pattern="[0-9]*"
          autoComplete="off"
          placeholder="예: 980919"
          aria-label="생년월일 여섯 자리"
          aria-describedby="date-result"
          className={`${INPUT} type-price${onEnter ? " scroll-mb-11" : ""}`}
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

export function TimeStep({
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

export function ReviewRow({ label, value, onEdit }: { label: string; value: string; onEdit: () => void }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-gray-100 py-4 last:border-b-0">
      <div className="min-w-0">
        <p className="type-caption text-gray-600">{label}</p>
        <p className="wrap-break-word type-label font-semibold text-gray-900">{value}</p>
      </div>
      <Button variant="ghost" onClick={onEdit} aria-label={`${label} 수정`} className="shrink-0 px-4">
        수정
      </Button>
    </div>
  );
}

export function timeLabel(time: Draft["birthTime"]): string {
  if (!time) return "선택 전";
  if (time.status === "unknown") return "시간 모름";
  return BRANCH_OPTIONS.find((option) => option.value === time.branch)?.label ?? "";
}
