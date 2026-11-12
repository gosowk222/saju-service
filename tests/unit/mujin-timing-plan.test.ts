import { describe, expect, it } from "vitest";
import { EMPTY_NOW, type MujinNow } from "@/domain/mujin/now";
import { buildClosingSection, buildTimingSections, CLOSING_CORE_QUESTION, LUCK_THEMES, LUCK_THEME_RULE } from "@/domain/mujin/timing-plan";
import { LUCK_THEME_TAGS, type MujinQuestionInput } from "@/domain/mujin/personalize";
import { MUJIN_TAGS } from "@/domain/mujin/tags";
import type {
  MonthDomain,
  MonthTone,
  MujinLuck,
  MujinLuckPeriod,
  MujinMaterial,
  MujinMonth,
  MujinPlan,
  MujinSectionPlan,
  MujinTimingBundle,
} from "@/domain/mujin/types";
import { MUJIN_OVERVIEW } from "@/domain/products/mujin-overview";
import type { TimingAnalysis } from "@/domain/reading/types";
import { FAMILIES, type Family } from "@/domain/rules/materials";
import { TIMING_CAVEAT } from "@/domain/rules/timing";

// 모두 가상 입력이다. 엔진을 부르지 않고 작성 계획 변환만 확인한다.
const product = MUJIN_OVERVIEW;
const REF_DATE = "2026-11-12";
const REF_AT = `${REF_DATE}T12:00:00+09:00`;
const specOf = (id: string) => product.scroll.sections.find((section) => section.id === id)!;

// ─── 원국 계획 (가짜) ─────────────────────────────────────────────────────

const weakness = { what: "약점", when: "조건", cost: "비용", change: "조정" };
function judgment(ref: string, questionIds: string[], extra: Partial<MujinMaterial> = {}): MujinMaterial {
  return {
    ref,
    kind: "judgment",
    questionIds,
    text: `원국 판단 ${ref}`,
    scope: "natal",
    status: "candidate",
    ruleId: "first-overview.wealth",
    ruleVersion: "3.1.0",
    conclusionId: `first-overview.wealth:natal:${ref}`,
    upside: `강점 ${ref}`,
    weakness,
    ...extra,
  };
}

function chapter(sectionId: string, materials: MujinMaterial[]): MujinSectionPlan {
  const spec = specOf(sectionId);
  return {
    sectionId,
    tier: spec.tier,
    title: spec.title,
    questions: spec.questions.map((question) => ({
      id: question.id,
      title: question.title,
      status: "adopted",
      refs: materials.filter((material) => material.questionIds.includes(question.id)).map((material) => material.ref),
      note: null,
    })),
    materials,
    weight: "standard",
    targetChars: spec.targetChars,
    situationNotes: [],
  };
}

const NATAL_SECTIONS = [
  chapter("ch3", [judgment("m1", ["3-1"], { ruleId: "first-overview.career" }), judgment("m2", ["3-2"], { ruleId: "first-overview.career" })]),
  chapter("ch4", [
    judgment("m3", ["4-1"]),
    judgment("m4", ["4-2"], { status: "deferred" }),
    judgment("m5", ["4-4"], { upside: undefined, weakness: undefined }),
  ]),
  chapter("ch6", [judgment("m6", ["6-2"], { ruleId: "first-overview.social" })]),
];

function planOf(input: { readonly now?: MujinNow; readonly nowFacts?: MujinMaterial[]; readonly sections?: MujinSectionPlan[] } = {}): MujinPlan {
  return {
    planVersion: "mujin-plan-1.0.0",
    productId: product.id,
    productVersion: product.version,
    personaId: "mujin",
    personaVersion: "1.0.0",
    rulesets: [],
    tagCatalogVersion: "test",
    nickname: "가람",
    gender: "female",
    hourKnown: true,
    coverageNotes: [],
    now: input.now ?? EMPTY_NOW,
    nowFacts: input.nowFacts ?? [],
    facts: [],
    tables: { elements: { counts: { 목: 0, 화: 0, 토: 0, 금: 0, 수: 0 }, percents: null }, stages: [], tenGods: { cells: [], families: null } },
    sections: input.sections ?? NATAL_SECTIONS,
  };
}

// ─── 기간 재료 (가짜) ─────────────────────────────────────────────────────

const decade = (age: number, ganzhi: string, tenGod: string | null, family: Family | null, startYear: number): MujinLuckPeriod => ({
  periodId: `decade:${age}`,
  label: `${age}세부터 대운 ${ganzhi}`,
  startsAt: `${startYear}-03-05T10:00:00.000Z`,
  endsAt: `${startYear + 10}-03-05T10:00:00.000Z`,
  approximate: true,
  ganzhi,
  stemTenGod: tenGod,
  stemFamily: family,
});

const PREVIOUS = decade(13, "계해", "정인", "resource", 2011);
const CURRENT = decade(23, "갑자", "편재", "wealth", 2021);
const NEXT = decade(33, "을축", "정관", "authority", 2031);

const availableLuck = (overrides: Partial<MujinLuck> = {}): MujinLuck => ({
  status: "available",
  reason: null,
  referenceAt: REF_AT,
  previous: PREVIOUS,
  current: CURRENT,
  next: NEXT,
  ...overrides,
});
const missingLuck = (reason: NonNullable<MujinLuck["reason"]>, extra: Partial<MujinLuck> = {}): MujinLuck => ({
  status: "unavailable",
  reason,
  referenceAt: REF_AT,
  previous: null,
  current: null,
  next: null,
  ...extra,
});

type Marker = { readonly tone: string; readonly text: string; readonly activity: string };
const POS = (text = "관성 기운"): Marker => ({ tone: "positive", text, activity: `${text}을 살린 활동` });
const CAU = (text = "비겁 기운"): Marker => ({ tone: "caution", text, activity: `${text} 점검` });
const NEU = (text = "재성 기운"): Marker => ({ tone: "neutral", text, activity: `${text} 정리` });

const DOMAINS: readonly MonthDomain[] = ["career", "wealth", "romance", "social"];
const MONTH_IDS = Array.from({ length: 12 }, (_, index) => {
  const value = 10 + index;
  return `monthly:${2026 + Math.floor(value / 12)}-${String((value % 12) + 1).padStart(2, "0")}`;
});
const CONTEXT_IDS = ["primary:period:annual:2026", "primary:period:decade:23"];

function toneOf(markers: readonly Marker[], computed: boolean): MonthTone {
  if (!computed) return "no-data";
  const positive = markers.some((marker) => marker.tone === "positive");
  const caution = markers.some((marker) => marker.tone === "caution");
  return positive && caution ? "mixed" : positive ? "positive" : caution ? "caution" : "neutral";
}

/** 기간 규칙(rules/timing.ts)이 근거를 나누는 방식 그대로: 혼합이면 주의 표지 근거만 반대 근거, 관측이면 모두 직접 근거. */
function statementOf(domain: MonthDomain, periodId: string, markers: readonly Marker[], extra: Partial<TimingAnalysis["months"][number]> = {}) {
  const ids = markers.map((_, index) => (index === 0 ? `primary:period:${periodId}` : `primary:shinsal:${periodId}:${domain}:${index}`));
  const positive = markers.some((marker) => marker.tone === "positive");
  const caution = markers.some((marker) => marker.tone === "caution");
  const verdict = positive && caution ? "mixed" : positive ? "notable" : caution ? "careful" : "quiet";
  const observation = verdict === "careful" || verdict === "quiet";
  const supporting = observation ? ids : ids.filter((_, index) => markers[index]!.tone !== "caution");
  const counter = observation ? [] : ids.filter((_, index) => markers[index]!.tone === "caution");
  return {
    kind: "timing" as const,
    periodId,
    periodKind: "monthly",
    label: periodId,
    engineLabel: periodId,
    startsOn: null,
    endsOn: null,
    verdict,
    statement: `${domain} ${periodId} 결론 문장`,
    markers,
    stageNote: "새로 시작하는 단계",
    selectionScore: markers.filter((marker) => marker.tone === "positive").length - markers.filter((marker) => marker.tone === "caution").length,
    conclusionId: `first-overview.timing:${periodId}:${domain}:markers`,
    ruleId: "first-overview.timing",
    ruleVersion: "3.1.0",
    supportingEvidenceIds: supporting,
    counterEvidenceIds: counter,
    contextualEvidenceIds: CONTEXT_IDS,
    caveats: [TIMING_CAVEAT, "절기 기준 월이라 달력의 1일과 경계가 다르다.", "12운성은 보조 설명으로만 썼다."],
    ...extra,
  } satisfies TimingAnalysis["months"][number];
}

interface BundleOptions {
  readonly luck?: MujinLuck;
  /** 달(0~11)·분야의 표지. 없으면 표지 없음. */
  readonly markers?: (index: number, domain: MonthDomain) => readonly Marker[];
  readonly computed?: readonly MonthDomain[];
  readonly notable?: Partial<Record<MonthDomain, readonly number[]>>;
  readonly careful?: Partial<Record<MonthDomain, readonly number[]>>;
  readonly firstStartedBeforeReference?: boolean;
  readonly status?: "available" | "insufficient";
  readonly statementExtra?: (index: number, domain: MonthDomain) => Partial<TimingAnalysis["months"][number]>;
}

function bundleOf(options: BundleOptions = {}): MujinTimingBundle {
  const computed = options.computed ?? DOMAINS;
  const markersOf = options.markers ?? (() => []);
  const months: MujinMonth[] = MONTH_IDS.map((periodId, index) => {
    const month = periodId.slice("monthly:".length);
    const [year, value] = month.split("-").map(Number) as [number, number];
    return {
      periodId,
      label: `${year}년 ${value}월`,
      startsOn: `${month}-07`,
      endsOn: `${index === 11 ? `${year + (value === 12 ? 1 : 0)}-${String((value % 12) + 1).padStart(2, "0")}` : MONTH_IDS[index + 1]!.slice("monthly:".length)}-06`,
      startedBeforeReference: index === 0 && (options.firstStartedBeforeReference ?? true),
      cells: DOMAINS.map((domain) => {
        const markers = computed.includes(domain) ? markersOf(index, domain) : [];
        return { domain, tone: toneOf(markers, computed.includes(domain)), markers };
      }),
    };
  });
  const analyses: TimingAnalysis[] = computed.map((domain) => ({
    version: "timing-analysis-1.0.0",
    domain,
    window: { kind: "default", startMonth: "2026-11", endMonth: "2027-10", label: "2026년 11월부터 2027년 10월까지 (절기 기준 월)" },
    status: "available",
    months: MONTH_IDS.flatMap((periodId, index) => {
      const markers = markersOf(index, domain);
      return markers.length ? [statementOf(domain, periodId, markers, options.statementExtra?.(index, domain))] : [];
    }),
    years: [],
    decade: null,
    notable: (options.notable?.[domain] ?? []).map((index) => MONTH_IDS[index]!),
    careful: (options.careful?.[domain] ?? []).map((index) => MONTH_IDS[index]!),
    limitations: [TIMING_CAVEAT],
    referenceDate: REF_DATE,
  }));
  return {
    version: "mujin-timing-1.0.0",
    referenceDate: REF_DATE,
    luck: options.luck ?? availableLuck(),
    months: {
      status: options.status ?? "available",
      window: { startMonth: "2026-11", endMonth: "2027-10", label: "2026년 11월부터 2027년 10월까지 (절기 기준 월)" },
      months: options.status === "insufficient" ? [] : months,
      notable: computed.map((domain) => ({ domain, periodIds: (options.notable?.[domain] ?? []).map((index) => MONTH_IDS[index]!) })),
      careful: computed.map((domain) => ({ domain, periodIds: (options.careful?.[domain] ?? []).map((index) => MONTH_IDS[index]!) })),
      limitations: ["절기 기준 월이라 달력의 1일과 경계가 다르다.", "테스트 한계 문장"],
    },
    analyses,
  };
}

function build(bundle: MujinTimingBundle, plan: MujinPlan = planOf(), startRef = 100) {
  const result = buildTimingSections({ plan, bundle, product, startRef });
  const ch9 = result.sections.find((section) => section.sectionId === "ch9")!;
  const ch10 = result.sections.find((section) => section.sectionId === "ch10")!;
  return { ...result, ch9, ch10 };
}

const questionOf = (section: MujinSectionPlan, id: string) => section.questions.find((question) => question.id === id)!;
const materialOf = (section: MujinSectionPlan, ref: string) => section.materials.find((material) => material.ref === ref)!;
const materialsFor = (section: MujinSectionPlan, id: string) => questionOf(section, id).refs.map((ref) => materialOf(section, ref));

// ─── 9장 ────────────────────────────────────────────────────────────────

describe("9장 인생의 큰 흐름과 전환점", () => {
  it("태어난 시간을 모르면 대운을 고르지 않고 9-1~9-3은 unavailable, 9-4는 활동 설명 없이 한계만 남긴다", () => {
    const { ch9 } = build(bundleOf({ luck: missingLuck("hour-unknown") }));
    expect(ch9.questions.map((question) => [question.id, question.status])).toEqual([
      ["9-1", "unavailable"],
      ["9-2", "unavailable"],
      ["9-3", "unavailable"],
      ["9-4", "general"],
    ]);
    expect(questionOf(ch9, "9-1").note).toContain("태어난 시간을 몰라 대운을 계산하지 않았다");
    expect(questionOf(ch9, "9-4").note).toContain("활동 주제와 잇지 않는다");
    expect(ch9.materials).toEqual([]);
    expect(ch9.questions.every((question) => question.refs.length === 0)).toBe(true);
    // 자료가 없는 장은 분량을 채우지 않도록 편집 목표를 줄인다.
    expect(ch9.targetChars.max).toBeLessThan(specOf("ch9").targetChars.min);
  });

  it("기준일이 대운 범위 밖이면 현재 구간을 고르지 않고, 엔진이 준 첫 대운만 계산 사실로 남긴다", () => {
    const { ch9 } = build(bundleOf({ luck: missingLuck("outside-sequence", { next: decade(7, "병인", "식신", "output", 2030) }) }));
    expect(ch9.questions.map((question) => question.status)).toEqual(["unavailable", "unavailable", "unavailable", "general"]);
    expect(questionOf(ch9, "9-1").note).toContain("대운 범위 밖");
    const [fact] = materialsFor(ch9, "9-1");
    expect(fact).toMatchObject({ kind: "engine-fact", periodId: "decade:7", scope: "period" });
    expect(fact!.text).toContain("첫 대운");
    expect(fact!.text).toContain("2030년 무렵부터");
    // 활동 주제·비교·원국 연결을 만들지 않는다.
    expect(ch9.materials.map((material) => material.kind)).toEqual(["engine-fact"]);
    expect(questionOf(ch9, "9-2").refs).toEqual([]);
    expect(questionOf(ch9, "9-3").refs).toEqual([]);
  });

  it("정상이면 직전·현재·다음 대운을 엔진 구간 그대로 쓰고 경계가 근사값이라는 조건을 붙인다", () => {
    const { ch9 } = build(bundleOf());
    const current = questionOf(ch9, "9-1");
    expect(current.status).toBe("conditional");
    expect(current.note).toContain("근사값");
    const [fact] = materialsFor(ch9, "9-1");
    expect(fact).toMatchObject({ kind: "engine-fact", periodId: "decade:23" });
    expect(fact!.text).toContain("23세부터 대운 갑자");
    expect(fact!.text).toContain("2021년 무렵부터 2031년 무렵까지");
    expect(fact!.text).toContain(REF_DATE);
    expect(fact!.caveats!.some((caveat) => caveat.includes("근사값"))).toBe(true);

    const compare = questionOf(ch9, "9-3");
    expect(compare.status).toBe("adopted");
    const [comparison, ...neighbors] = materialsFor(ch9, "9-3");
    expect(neighbors.map((material) => material.periodId)).toEqual(["decade:13", "decade:33"]);
    expect(comparison).toMatchObject({ kind: "derived", ruleId: LUCK_THEME_RULE.id });
    expect(comparison!.text).toContain(LUCK_THEMES.resource.label);
    expect(comparison!.text).toContain(LUCK_THEMES.wealth.label);
    expect(comparison!.text).toContain(LUCK_THEMES.authority.label);
    expect(comparison!.caveats!.join(" ")).toContain("전성기");
    expect(comparison!.caveats!.join(" ")).toContain("과거에 실제로 있었던 일");
    // 비교 재료는 9-2 활동 주제와 앞뒤 대운 계산 사실을 이어 받는다.
    const theme = materialsFor(ch9, "9-2")[0]!;
    expect(comparison!.parentRefs).toEqual([theme.ref, ...neighbors.map((material) => material.ref)]);
  });

  it("9-2는 대운 천간 십성 계열을 중립 활동 주제로만 읽고, 돈·합격 같은 결과로 바꾸지 않는 조건을 붙인다", () => {
    for (const family of FAMILIES) {
      const { ch9 } = build(bundleOf({ luck: availableLuck({ current: { ...CURRENT, stemFamily: family, stemTenGod: null } }) }));
      const question = questionOf(ch9, "9-2");
      expect(question.status).toBe("adopted");
      const [theme] = materialsFor(ch9, "9-2");
      // derived가 아니라 엔진 계산값(9-1)을 근거로 둔 서비스 해설이다.
      expect(theme).toMatchObject({ kind: "period", periodId: "decade:23", ruleId: LUCK_THEME_RULE.id, ruleVersion: LUCK_THEME_RULE.version, variant: `luck-theme:${family}` });
      expect(theme!.parentRefs).toEqual(materialsFor(ch9, "9-1").map((material) => material.ref));
      expect(theme!.text).toContain(LUCK_THEMES[family].label);
      const caveats = theme!.caveats!.join(" ");
      expect(caveats).toContain("개인별 길흉을 합친 판정 공식이 아니다");
      expect(caveats).toContain("재성 대운을 돈 버는 10년, 관성 대운을 합격 구간처럼");
      expect(caveats).toContain(LUCK_THEMES[family].caveat);
    }
    const labels = FAMILIES.map((family) => LUCK_THEMES[family].label);
    expect(labels).toEqual(["주도성·동료·경쟁", "표현·제작·공개", "수입 활동·거래·비용과 자원 관리", "역할·책임·평가", "학습·문서·준비·도움"]);
  });

  it("천간 십성 자료가 없으면 9-2를 unavailable로 두고 활동 주제를 만들지 않는다", () => {
    const { ch9 } = build(bundleOf({ luck: availableLuck({ current: { ...CURRENT, stemFamily: null, stemTenGod: null } }) }));
    expect(questionOf(ch9, "9-2")).toMatchObject({ status: "unavailable", refs: [] });
    expect(questionOf(ch9, "9-3").status).toBe("unavailable");
    expect(questionOf(ch9, "9-4").status).toBe("general");
    expect(ch9.materials.some((material) => material.kind === "period" || material.kind === "derived")).toBe(false);
  });

  it("9-3은 같은 계열이면 활동 주제가 이어진다고 하고 십성만 바뀐 차이를 말하며, 없는 직전 구간은 만들지 않는다", () => {
    const sameFamily = build(bundleOf({ luck: availableLuck({ previous: { ...PREVIOUS, stemFamily: "wealth", stemTenGod: "정재" } }) })).ch9;
    const comparison = materialsFor(sameFamily, "9-3")[0]!;
    expect(comparison.text).toContain("이어진다");
    expect(comparison.text).toContain("정재에서 편재로");

    const first = build(bundleOf({ luck: availableLuck({ previous: null }) })).ch9;
    expect(questionOf(first, "9-3").note).toContain("직전 구간은 계산된 대운 목록에 없어");
    expect(materialsFor(first, "9-3").map((material) => material.periodId).filter(Boolean)).toEqual(["decade:33"]);
  });

  it("9-4는 활동 주제와 닿는 원국 채택 판단만 잇고, 보류·강약점 없는 판단은 잇지 않는다", () => {
    const { ch9 } = build(bundleOf());
    const prepare = questionOf(ch9, "9-4");
    expect(prepare.status).toBe("adopted");
    const links = materialsFor(ch9, "9-4").filter((material) => material.kind === "derived");
    // 재성 활동 주제 → 4장 질문. m4(보류)와 m5(강점·약점 없음)는 잇지 않는다.
    expect(links.map((material) => material.parentRefs)).toEqual([[materialsFor(ch9, "9-2")[0]!.ref, "m3"]]);
    expect(links[0]).toMatchObject({ upside: "강점 m3", weakness, scope: "period" });
    expect(links[0]!.caveats!.join(" ")).toContain("새 판단이 아니다");
  });

  it("9-4는 질문으로 고른 판단 다음에 활동 주제와 닿는 의미 태그가 붙은 채택 판단도 잇는다", () => {
    // 재성 활동 주제: 4장 질문(m3) 다음에 2장의 편재 능력 판단(태그 over-expansion)을 잇는다. 태그 없는 판단은 잇지 않는다.
    const ch2 = chapter("ch2", [
      judgment("m7", ["2-1"], { tags: ["ability.indirect-wealth", "over-expansion"] }),
      judgment("m8", ["2-3"], { tags: ["finish-delay"] }),
    ]);
    const { ch9 } = build(bundleOf(), planOf({ sections: [...NATAL_SECTIONS, ch2] }));
    const parents = materialsFor(ch9, "9-4")
      .filter((material) => material.kind === "derived")
      .map((material) => material.parentRefs![1]);
    expect(parents).toEqual(["m3", "m7"]);
  });

  it("9-4의 대운 연결 태그는 모두 의미 태그 카탈로그에 있다", () => {
    const catalog = new Set(MUJIN_TAGS.map((tag) => tag.id));
    for (const family of FAMILIES) for (const tag of LUCK_THEME_TAGS[family]) expect(catalog.has(tag)).toBe(true);
  });

  it("9-4에 이을 원국 판단이 없으면 활동 설명까지만 하는 general로 둔다", () => {
    const { ch9 } = build(bundleOf(), planOf({ sections: [] }));
    const prepare = questionOf(ch9, "9-4");
    expect(prepare.status).toBe("general");
    expect(prepare.note).toContain("활동 주제 설명까지만");
    expect(materialsFor(ch9, "9-4").map((material) => material.kind)).toEqual(["period"]);
  });

  it("9-4는 '지금의 나' 사실 중 활동 주제와 닿는 것만 계획 공용 재료 ref 그대로 가리킨다", () => {
    const nowFact = (ref: string, questionIds: string[], factKind: MujinMaterial["factKind"] = "current"): MujinMaterial => ({
      ref,
      kind: "user-fact",
      questionIds,
      text: `지금의 나 ${ref}`,
      scope: "user",
      source: "now-selection",
      factKind,
    });
    const plan = planOf({ nowFacts: [nowFact("m90", ["4-4"]), nowFact("m91", ["5-1"]), nowFact("m92", ["9-4"]), nowFact("m93", ["4-1"], "plan")] });
    const { ch9 } = build(bundleOf(), plan);
    const refs = questionOf(ch9, "9-4").refs;
    expect(refs).toContain("m90");
    expect(refs).toContain("m92");
    expect(refs).not.toContain("m91");
    expect(refs).not.toContain("m93");

    // 관성 활동 주제(역할·책임·평가)는 7-2와도 닿지만, 가족 선택('답하고 싶지 않음' 포함)은 지금 상황으로 잇지 않는다.
    const authority = availableLuck({ current: { ...CURRENT, stemTenGod: "정관", stemFamily: "authority" } });
    const family = planOf({ nowFacts: [nowFact("m94", ["7-1", "7-2", "7-3", "7-4"]), nowFact("m95", ["3-1", "3-4"])] });
    const authorityRefs = questionOf(build(bundleOf({ luck: authority }), family).ch9, "9-4").refs;
    expect(authorityRefs).toContain("m95");
    expect(authorityRefs).not.toContain("m94");
  });
});

// ─── 10장 ───────────────────────────────────────────────────────────────

describe("10장 앞으로 12개월", () => {
  it("10-1은 실제 분석 기간과 달마다 분야별 표지 구성 다섯 가지를 구분한다", () => {
    const markers = (index: number, domain: MonthDomain): readonly Marker[] => {
      if (index === 0) return { career: [POS(), CAU()], wealth: [POS("재성 기운")], romance: [CAU("충 표지")], social: [] }[domain];
      if (index === 1 && domain === "career") return [NEU()];
      return [];
    };
    const { ch10 } = build(bundleOf({ markers, computed: ["career", "wealth", "romance"] }));
    const overview = questionOf(ch10, "10-1");
    // 인간관계 분야를 계산하지 못해 자료 부족 칸이 있으므로 조건부다.
    expect(overview.status).toBe("conditional");
    const [window, ...months] = materialsFor(ch10, "10-1");
    expect(window!.text).toContain("2026년 11월부터 2027년 10월까지 (절기 기준 월)");
    expect(window!.caveats).toContain("테스트 한계 문장");
    expect(months).toHaveLength(12);
    expect(months[0]!.text).toBe(
      "2026년 11월(11월 7일~12월 6일): 직업 긍정·주의 함께, 재물 긍정 표지만, 연애 주의 표지만, 인간관계 자료 부족.",
    );
    expect(months[1]!.text).toContain("직업 중립(뚜렷한 긍정·주의 표지 없음)");
    expect(months[1]!.text).toContain("재물 중립");
    expect(months[0]!.caveats!.join(" ")).toContain("긍정과 주의 표지가 함께 있으면 둘을 함께 말한다");
    expect(months[0]!.caveats!.join(" ")).toContain("나쁜 달이라는 뜻이 아니다");
    // 건강·가족 월운은 만들지 않는다.
    expect(ch10.materials.some((material) => /건강|가족/.test(material.text))).toBe(false);
  });

  it("첫 달이 기준일 전에 시작했으면 지난 날짜를 앞으로 올 일처럼 말하지 않는다는 조건을 그 달에 붙인다", () => {
    const { ch10 } = build(bundleOf({ markers: (index, domain) => (index === 0 && domain === "career" ? [POS()] : []), notable: { career: [0] } }));
    const [, first, second] = materialsFor(ch10, "10-1");
    expect(first!.caveats!.join(" ")).toContain(`기준일(${REF_DATE})보다 먼저 시작한 달`);
    expect(second!.caveats ?? []).not.toContainEqual(expect.stringContaining("먼저 시작한 달"));
    const [detail] = materialsFor(ch10, "10-2");
    expect(detail!.caveats!.join(" ")).toContain("이미 지난 날짜를 앞으로 올 일처럼 말하지 않는다");

    const later = build(bundleOf({ firstStartedBeforeReference: false })).ch10;
    expect(materialsFor(later, "10-1")[1]!.caveats ?? []).not.toContainEqual(expect.stringContaining("먼저 시작한 달"));
  });

  it("주목·주의 후보가 없으면 10-2·10-3·10-4를 비워 두고 억지로 채우지 않는다", () => {
    const { ch10 } = build(bundleOf({ markers: () => [NEU()] }));
    for (const id of ["10-2", "10-3", "10-4"]) {
      expect(questionOf(ch10, id)).toMatchObject({ status: "general", refs: [] });
    }
    expect(questionOf(ch10, "10-2").note).toContain("억지로 고르지 않고");
    expect(questionOf(ch10, "10-3").note).toContain("억지로 만들지 않고");
    expect(ch10.materials.some((material) => material.questionIds.some((id) => id !== "10-1"))).toBe(false);
  });

  it("여러 분야가 같은 달을 고르면 달은 한 재료로 두고 분야별 이유를 함께 적는다", () => {
    const markers = (index: number, domain: MonthDomain) => (index === 2 && (domain === "career" || domain === "wealth") ? [POS(`${domain} 기운`)] : []);
    const { ch10 } = build(bundleOf({ markers, notable: { career: [2], wealth: [2] } }));
    const notable = materialsFor(ch10, "10-2");
    expect(notable).toHaveLength(1);
    const [month] = notable;
    expect(month).toMatchObject({ kind: "period", periodId: MONTH_IDS[2], ruleId: "first-overview.timing", ruleVersion: "3.1.0" });
    expect(month!.text).toContain("직업 주목 구간");
    expect(month!.text).toContain("재물 주목 구간");
    expect(month!.basis).toEqual(["직업 긍정 표지: career 기운", "재물 긍정 표지: wealth 기운"]);
    // 결론이 둘이므로 하나의 결론 ID로 대표하지 않는다.
    expect(month!.conclusionId).toBeUndefined();
    // 활동 재료는 분야마다 따로 두고 같은 달 재료를 함께 가리킨다.
    const activities = materialsFor(ch10, "10-4");
    expect(activities.map((material) => material.variant)).toEqual(["month-activity:career", "month-activity:wealth"]);
    expect(activities.every((material) => material.parentRefs?.length === 1 && material.parentRefs[0] === month!.ref)).toBe(true);
  });

  it("주목 구간이어도 같은 달의 주의 근거와 표지를 지우지 않는다", () => {
    const markers = (index: number, domain: MonthDomain) => (index === 4 && domain === "career" ? [POS("관성 기운"), POS("문창 표지"), CAU("충 표지")] : []);
    const { ch10 } = build(bundleOf({ markers, notable: { career: [4] } }));
    const [month] = materialsFor(ch10, "10-2");
    expect(month!.status).toBe("deferred");
    expect(month!.conclusionId).toBe(`first-overview.timing:${MONTH_IDS[4]}:career:markers`);
    expect(month!.evidence!.counter).toEqual([`primary:shinsal:${MONTH_IDS[4]}:career:2`]);
    expect(month!.basis).toContain("직업 주의 표지: 충 표지");
    expect(month!.counterNote).toContain("주의 표지(충 표지)");
  });

  it("관심 분야를 먼저 둔다. 바뀌는 것은 순서뿐이다", () => {
    const markers = (index: number, domain: MonthDomain) => ((index === 5 && domain === "career") || (index === 1 && domain === "romance") ? [POS()] : []);
    const options = { markers, notable: { career: [5], romance: [1] } } as const;
    const plain = build(bundleOf(options)).ch10;
    const romanceFirst = build(bundleOf(options), planOf({ now: { ...EMPTY_NOW, interests: ["ch5"] } })).ch10;
    const periods = (section: MujinSectionPlan) => materialsFor(section, "10-2").map((material) => material.periodId);
    expect(periods(plain)).toEqual([MONTH_IDS[5], MONTH_IDS[1]]);
    expect(periods(romanceFirst)).toEqual([MONTH_IDS[1], MONTH_IDS[5]]);
    expect(materialsFor(romanceFirst, "10-4").map((material) => material.variant)).toEqual(["month-activity:romance", "month-activity:career"]);
    const texts = (section: MujinSectionPlan) => section.materials.map((material) => material.text).sort();
    expect(texts(romanceFirst)).toEqual(texts(plain));
  });

  it("주의 구간은 번들이 고른 것(분야마다 최대 2)만 쓰고 실패·사고가 정해진 날로 말하지 않는다", () => {
    const markers = (index: number, domain: MonthDomain) => ((index === 3 || index === 8) && domain === "wealth" ? [CAU()] : []);
    const { ch10 } = build(bundleOf({ markers, careful: { wealth: [3, 8] } }));
    const careful = materialsFor(ch10, "10-3");
    expect(careful.map((material) => material.periodId)).toEqual([MONTH_IDS[3], MONTH_IDS[8]]);
    // 번들이 고른 순서(분야 안 우선순위)가 늦은 달 먼저여도 refs는 그 순서를 지키고, 활동 문장의 달 목록만 시간 순이다.
    const reversed = build(bundleOf({ markers, careful: { wealth: [8, 3] } })).ch10;
    expect(materialsFor(reversed, "10-3").map((material) => material.periodId)).toEqual([MONTH_IDS[8], MONTH_IDS[3]]);
    expect(materialsFor(reversed, "10-4")[0]!.text).toContain("주의 구간 2027년 2월, 2027년 7월");
    for (const material of careful) {
      expect(material.status).toBe("observation");
      expect(material.caveats).toContain("주의 우세 구간은 조건을 더 점검할 달이며 실패·사고·손실이 생기는 날이라는 뜻이 아니다.");
    }
    expect(questionOf(ch10, "10-3").note).toContain("실패·사고·손실이 생기는 날로 말하지 않는다");
    expect(questionOf(ch10, "10-2").refs).toEqual([]);
  });

  it("보조 기간(세운·대운) 근거는 contextual에만 두고 직접 근거에 섞지 않는다", () => {
    const markers = (index: number, domain: MonthDomain) => (index === 6 && (domain === "career" || domain === "social") ? [POS(), CAU()] : []);
    // 저장된 결론에 보조 근거 ID가 직접 근거로 잘못 섞여 들어와도 직접 근거로 옮기지 않는다.
    const statementExtra = (index: number, domain: MonthDomain) =>
      index === 6 && domain === "social" ? { supportingEvidenceIds: [`primary:period:${MONTH_IDS[6]}`, CONTEXT_IDS[0]!] } : {};
    const { ch10 } = build(bundleOf({ markers, notable: { career: [6] }, careful: { social: [6] }, statementExtra }));
    const periods = ch10.materials.filter((material) => material.evidence);
    expect(periods.length).toBeGreaterThan(0);
    for (const material of periods) {
      for (const id of CONTEXT_IDS) {
        expect(material.evidence!.supporting).not.toContain(id);
        expect(material.evidence!.counter).not.toContain(id);
      }
      expect(material.evidence!.contextual).toEqual(CONTEXT_IDS);
    }
    const [month] = materialsFor(ch10, "10-2");
    expect(month!.questionIds).toEqual(["10-2", "10-3"]);
    expect(materialsFor(ch10, "10-3")[0]!.ref).toBe(month!.ref);
  });

  it("10-4는 분야별 기간 활동 재료만 만들고 원국 판단과는 잇지 않는다", () => {
    const markers = (index: number, domain: MonthDomain) => (index === 2 && domain === "career" ? [POS()] : index === 9 && domain === "career" ? [CAU()] : []);
    const { ch10 } = build(bundleOf({ markers, notable: { career: [2] }, careful: { career: [9] } }));
    const activity = questionOf(ch10, "10-4");
    expect(activity.status).toBe("adopted");
    const [career] = materialsFor(ch10, "10-4");
    expect(career).toMatchObject({ kind: "derived", variant: "month-activity:career" });
    expect(career!.text).toContain("주목 구간 2027년 1월");
    expect(career!.text).toContain("주의 구간 2027년 8월");
    expect(career!.caveats).toContain("지원 자료 정비를 합격일로, 관계 활동을 만남 확정일로 바꾸지 않는다.");
    const natalRefs = new Set(NATAL_SECTIONS.flatMap((section) => section.materials.map((material) => material.ref)));
    expect(ch10.materials.some((material) => material.parentRefs?.some((ref) => natalRefs.has(ref)))).toBe(false);
  });

  it("monthSequence·일반 rating·12운성은 작성 재료에 넣지 않는다", () => {
    const { ch10 } = build(bundleOf({ markers: (index) => (index < 3 ? [POS()] : []), notable: { career: [0, 1, 2] } }));
    const all = ch10.materials.flatMap((material) => [material.text, ...(material.caveats ?? []), ...(material.basis ?? [])]).join(" ");
    expect(all).not.toContain("12운성");
    expect(all).not.toContain("새로 시작하는 단계");
    expect(all).not.toMatch(/rating|monthSequence|점수/);
  });

  it("월운 자료가 없으면 10장을 unavailable로 두고 달이나 날짜를 만들지 않는다", () => {
    const { ch10 } = build(bundleOf({ status: "insufficient" }));
    expect(ch10.questions.map((question) => question.status)).toEqual(["unavailable", "unavailable", "unavailable", "unavailable"]);
    expect(ch10.materials).toEqual([]);
    expect(ch10.targetChars.max).toBeLessThan(specOf("ch10").targetChars.min);
  });

  it("작성용 ref는 startRef부터 계획 안에서 고유하게 이어서 내고, 같은 입력이면 같은 계획을 만든다", () => {
    const bundle = bundleOf({ markers: (index) => (index % 4 === 0 ? [POS()] : []), notable: { career: [0, 4, 8] } });
    const first = build(bundle, planOf(), 200);
    const refs = first.sections.flatMap((section) => section.materials.map((material) => material.ref));
    expect(new Set(refs).size).toBe(refs.length);
    expect(refs[0]).toBe("m200");
    expect(first.nextRef).toBe(200 + refs.length);
    expect(build(bundle, planOf(), 200).sections).toEqual(first.sections);
    // 소질문 refs는 그 장 재료나 계획 공용 재료만 가리킨다.
    for (const section of first.sections) {
      const own = new Set(section.materials.map((material) => material.ref));
      for (const question of section.questions) for (const ref of question.refs) expect(own.has(ref)).toBe(true);
      expect(section.weight).toBe("standard");
    }
  });

  it("고른 일·학업 상태와 관계 상태는 선택지의 의미로만 남기고 추정하지 않는다", () => {
    const now: MujinNow = { ...EMPTY_NOW, work: ["employed", "student"], relationship: "single" };
    const { ch9, ch10 } = build(bundleOf(), planOf({ now }));
    expect(ch9.situationNotes.join(" ")).toContain("안정된 월급을 받는다고 추정하지 않는다");
    expect(ch9.situationNotes.join(" ")).toContain("선택 순서를 주업 순서로 보지 않고");
    expect(ch10.situationNotes.join(" ")).toContain("연애를 원한다고 추정하지 않는다");
    const unanswered = build(bundleOf()).ch10;
    expect(unanswered.situationNotes.join(" ")).toContain("연애 여부를 전제하지 않고");
  });
});

// ─── 마지막 정리 ─────────────────────────────────────────────────────────

const chapterAnswers = ["ch1", "ch2", "ch3", "ch4", "ch5", "ch6", "ch7", "ch8", "ch9", "ch10"].map((sectionId) => ({
  sectionId,
  title: specOf(sectionId).title,
  coreAnswer: `${sectionId} 핵심 답`,
}));

const ask = (ref: string, domain: MujinQuestionInput["domain"], intent: MujinQuestionInput["intent"], extra: Partial<MujinQuestionInput> = {}): MujinQuestionInput => ({
  ref,
  summary: `${ref} ${domain} ${intent} 질문`,
  domain,
  topicDomain: null,
  intent,
  answerability: "full",
  missingInfo: [],
  timingSupported: false,
  ...extra,
});

describe("마지막 정리", () => {
  it("질문이 없으면 핵심 선택 기준 하나를 하한 쪽 분량으로 간결하게 정리한다", () => {
    const { section, nextRef } = buildClosingSection({ product, questions: [], chapterAnswers, startRef: 300 });
    const spec = specOf("closing");
    expect(section.questions).toHaveLength(1);
    expect(section.questions[0]).toMatchObject({ id: CLOSING_CORE_QUESTION.id, status: "adopted" });
    expect(section.questions[0]!.refs).toEqual(section.materials.map((material) => material.ref));
    expect(section.weight).toBe("standard");
    expect(section.targetChars.min).toBe(spec.targetChars.min);
    expect(section.targetChars.max).toBeLessThan(spec.targetChars.max);
    expect(nextRef).toBe(300 + section.materials.length);
  });

  it("질문마다 이어진 장의 핵심 답만 모으고, 넓은 질문은 모든 장의 답을 쓴다", () => {
    const questions = [
      ask("q1", "career", "compare"),
      ask("q2", "wealth", "timing", { timingSupported: true }),
      ask("q3", "general", "general"),
    ];
    const { section } = buildClosingSection({ product, questions, chapterAnswers, startRef: 1 });
    expect(section.weight).toBe("question");
    expect(section.targetChars).toEqual(specOf("closing").targetChars);
    expect(section.questions.map((question) => question.id)).toEqual(["q1", "q2", "q3"]);
    const parentsOf = (id: string) =>
      questionOf(section, id).refs.slice(1).map((ref) => materialOf(section, ref).parentRefs);
    expect(questionOf(section, "q1").refs[0]).toBe("q1");
    expect(parentsOf("q1")).toEqual([["ch3"]]);
    expect(parentsOf("q2")).toEqual([["ch4"], ["ch10"]]);
    expect(parentsOf("q3")).toHaveLength(10);
    // 같은 장의 답은 한 재료로 두고 쓰는 질문을 모두 적는다.
    expect(materialOf(section, questionOf(section, "q1").refs[1]!).questionIds).toEqual(["q1", "q3"]);
    expect(questionOf(section, "q1").note).toContain("정답을 고르지 않고");
    expect(questionOf(section, "q2").note).toContain("새 날짜를 만들지 않는다");
  });

  it("새 사주 판단 재료를 만들지 않고 앞 장의 핵심 답만 옮긴다", () => {
    const { section } = buildClosingSection({ product, questions: [ask("q1", "romance", "outcome", { answerability: "limited" })], chapterAnswers, startRef: 1 });
    for (const material of section.materials) {
      expect(material.kind).toBe("derived");
      expect(material.ruleId).toBeUndefined();
      expect(material.evidence).toBeUndefined();
      expect(material.parentRefs).toHaveLength(1);
      expect(material.text).toBe(`${material.parentRefs![0]} 핵심 답`);
    }
    expect(questionOf(section, "q1").status).toBe("conditional");
    expect(questionOf(section, "q1").note).toContain("확정하지 않고");
  });

  it("빈 핵심 답은 쓰지 않고, 이어진 장의 답이 없으면 general로 둔다", () => {
    const answers = chapterAnswers.map((answer) => (answer.sectionId === "ch7" ? { ...answer, coreAnswer: "  " } : answer));
    const { section } = buildClosingSection({ product, questions: [ask("q1", "family", "apply")], chapterAnswers: answers, startRef: 1 });
    expect(section.materials).toEqual([]);
    expect(questionOf(section, "q1")).toMatchObject({ status: "general", refs: ["q1"] });
    expect(questionOf(section, "q1").note).toContain("핵심 답이 없어");
  });

  it("범위 밖 분야의 질문은 모으지 않고, 질문 ref가 겹치면 멈춘다", () => {
    const { section } = buildClosingSection({ product, questions: [ask("q1", "non-saju", "general")], chapterAnswers, startRef: 1 });
    expect(section.questions.map((question) => question.id)).toEqual([CLOSING_CORE_QUESTION.id]);
    expect(() => buildClosingSection({ product, questions: [ask("q1", "career", "apply"), ask("q1", "wealth", "apply")], chapterAnswers, startRef: 1 })).toThrow();
  });
});
