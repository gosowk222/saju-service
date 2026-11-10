import type { InquiryConclusionDraft, InquiryEvidence, InquiryRule } from "sajuengine";
import { detailKey, ruleMetadata, type MarkerTone, type RuleDetailSink, type TimingMarker } from "./common";
import { FAMILY_LABEL, OPPOSING_RELATIONS, periodEvidence, periodStageEvidence, relationEvidence, shinsalEvidence, withJosa, type Family } from "./materials";

/**
 * 기간 판단 규칙. 대상 기간(세운·월운)에 들어온 표지를 주제별 의미로 읽는다.
 *
 * - 직접 근거는 그 기간의 근거(periodId가 같은 period·relation·shinsal)만 쓴다. 다른 기간의 근거는 섞지 않는다.
 * - 일반 rating과 monthSequence는 분야별 점수로 쓰지 않는다. 12운성은 보조 설명으로만 둔다.
 * - 결과는 "전통 해석상 주목할 활동 기간"이다. 합격, 만남, 수입 같은 사건이 생긴다는 뜻이 아니다.
 */

export const TIMING_DOMAINS = ["career", "wealth", "romance", "social"] as const;
export type TimingDomain = (typeof TIMING_DOMAINS)[number];

interface MarkerText {
  readonly tone: MarkerTone;
  readonly text: string;
  readonly activity: string;
}

const FAMILY_MARKERS: Readonly<Record<Exclude<TimingDomain, "romance">, Readonly<Record<Family, MarkerText>>>> = {
  career: {
    authority: { tone: "positive", text: "역할·평가·조직과 연결해 읽는 관성의 기운", activity: "지원서 제출, 면접, 조직 안에서 역할을 넓히는 시도" },
    resource: { tone: "positive", text: "문서·자격·준비와 연결해 읽는 인성의 기운", activity: "서류와 포트폴리오 정비, 자격·공부, 추천 요청" },
    output: { tone: "positive", text: "표현과 결과물의 식상 기운", activity: "작업물 공개, 면접이나 발표처럼 실력을 보여 주는 자리" },
    wealth: { tone: "neutral", text: "성과와 실무를 다루는 재성의 기운", activity: "실무 경험, 단기 프로젝트, 조건과 보수 협상" },
    peer: { tone: "caution", text: "경쟁과 독립 욕구가 커지는 비겁의 기운", activity: "경쟁이 붙는 때라 남과 비교하기보다 내 준비에 집중하기" },
  },
  wealth: {
    wealth: { tone: "positive", text: "돈의 흐름과 직접 연결해 읽는 재성의 기운", activity: "수입 활동을 늘리고 정산·가격을 협상하되, 나가는 돈도 커질 수 있어 지출 상한을 함께 정하기" },
    output: { tone: "positive", text: "만든 것이 수입으로 이어지는 식상의 기운", activity: "작업물 판매, 부업, 단가 올리기" },
    peer: { tone: "caution", text: "돈이 나가거나 나뉘기 쉬운 비겁의 기운", activity: "동업, 돈 빌려주기, 충동 지출을 조심하기" },
    resource: { tone: "neutral", text: "문서와 계약을 살피는 인성의 기운", activity: "계약서와 조건을 꼼꼼히 확인하고, 공부에 쓰는 돈을 점검하기" },
    authority: { tone: "neutral", text: "의무와 고정 지출을 정비하는 관성의 기운", activity: "고정비, 세금, 의무 지출 정리하기" },
  },
  social: {
    peer: { tone: "positive", text: "동료·친구와 어울리는 비겁의 기운", activity: "모임, 스터디, 협업 제안. 다만 비교와 경쟁도 같이 올라오니 조심하기" },
    resource: { tone: "positive", text: "도움과 조언을 받는 인성의 기운", activity: "선배나 멘토에게 조언 구하기" },
    output: { tone: "neutral", text: "말과 표현이 많아지는 식상의 기운", activity: "의견을 낼 기회는 살리되 말실수 조심하기" },
    authority: { tone: "neutral", text: "윗사람·평가 관계가 두드러지는 관성의 기운", activity: "예의와 역할을 분명히 하기" },
    wealth: { tone: "neutral", text: "주고받는 실리를 따지게 되는 재성의 기운", activity: "관계에서 주고받는 균형 점검하기" },
  },
};

/** 연애는 성별에 따라 전통 관법이 이성 인연을 읽는 계열이 다르다. 그 계열만 인연 표지로 보고 나머지는 생활 표지로 둔다. */
const ROMANCE_FAMILY: Readonly<Record<Family, MarkerText>> = {
  output: { tone: "positive", text: "표현과 적극성이 커지는 식상의 기운", activity: "먼저 연락하고 마음을 표현해 보기, 새로운 모임에 나가 보기" },
  peer: { tone: "caution", text: "비교와 경쟁이 커지는 비겁의 기운", activity: "주변과 비교하며 조급해지지 않기" },
  resource: { tone: "neutral", text: "생각이 많아지고 받는 쪽이 되는 인성의 기운", activity: "관계에서 원하는 것을 정리해 보는 시간 갖기" },
  authority: { tone: "neutral", text: "책임과 약속을 의식하는 관성의 기운", activity: "관계의 약속과 기준을 함께 정하기" },
  wealth: { tone: "neutral", text: "현실적으로 챙기는 재성의 기운", activity: "데이트 비용이나 생활 방식을 현실적으로 맞추기" },
};

const PARTNER_FAMILY: Readonly<Record<string, Family>> = { female: "authority", male: "wealth" };
const PARTNER_MARKER: MarkerText = {
  tone: "positive",
  text: "전통 관법에서 이성 인연과 연결해 읽는 기운",
  activity: "소개나 모임처럼 새 만남의 자리에 나가 보기, 만나는 사람이 있다면 관계를 분명히 하는 대화",
};

const SHINSAL_MARKERS: Readonly<Record<TimingDomain, Readonly<Record<string, MarkerText>>>> = {
  career: {
    yeokma: { tone: "positive", text: "이동과 변화의 역마 표지", activity: "지원 범위를 넓히거나 이동이 따르는 기회 살피기" },
    munchang: { tone: "positive", text: "문서와 표현의 문창 표지", activity: "서류와 시험 준비" },
    hakdang: { tone: "positive", text: "배움의 학당 표지", activity: "교육, 자격, 공부 마무리" },
    "cheonul-gwiin": { tone: "positive", text: "도움을 주는 사람의 천을귀인 표지", activity: "추천과 네트워킹 요청" },
    jangseong: { tone: "positive", text: "앞에 서는 장성 표지", activity: "맡은 일에서 주도권 잡기" },
  },
  wealth: {
    "cheonul-gwiin": { tone: "positive", text: "도움을 주는 사람의 천을귀인 표지", activity: "돈 문제는 혼자 끌어안지 말고 조언 구하기" },
    geopsal: { tone: "caution", text: "빼앗김을 뜻하는 전통 표지인 겁살", activity: "분실, 사기성 제안, 충동 결제 조심하기" },
  },
  romance: {
    hamji: { tone: "positive", text: "매력과 주목을 뜻하는 도화(함지) 표지", activity: "새로운 모임에 나가거나 분위기에 변화를 줘 보기" },
    hongyeom: { tone: "positive", text: "감성적인 끌림을 뜻하는 홍염 표지", activity: "마음이 가는 사람에게 한 걸음 다가가 보기" },
  },
  social: {
    "cheonul-gwiin": { tone: "positive", text: "도움을 주는 사람의 천을귀인 표지", activity: "도움이 필요하면 먼저 요청하기" },
    hamji: { tone: "neutral", text: "사람이 모이는 도화(함지) 표지", activity: "새 인맥을 넓히되 가벼운 말로 오해 사지 않기" },
  },
};

const STAGE_NOTE: Readonly<Record<string, string>> = {
  jangsaeng: "새로 시작하는 단계",
  mogyok: "들뜨고 변화가 많은 단계",
  gwandae: "자리를 잡아 가는 단계",
  geonrok: "자기 힘이 서는 단계",
  jewang: "기운이 가장 센 단계",
  soe: "힘을 거두기 시작하는 단계",
  byeong: "기운이 약해지는 단계",
  sa: "멈춰서 정리하는 단계",
  myo: "갈무리하는 단계",
  jeol: "끊고 새로 바꾸는 단계",
  tae: "새 씨앗을 품는 단계",
  yang: "준비하며 기르는 단계",
};

export const TIMING_CAVEAT = "전통 해석상 주목할 활동 기간이며 합격, 만남, 수입 같은 사건이 생긴다는 뜻이 아니다.";
const MONTH_CAVEAT = "절기 기준 월이라 달력의 1일과 경계가 다르다.";

function familyMarker(domain: TimingDomain, family: Family, gender: string | null): MarkerText & { code: string } {
  if (domain === "romance") {
    if (gender && PARTNER_FAMILY[gender] === family) return { ...PARTNER_MARKER, text: `${PARTNER_MARKER.text}(${FAMILY_LABEL[family]})`, code: "family:partner" };
    return { ...ROMANCE_FAMILY[family], code: `family:${family}` };
  }
  return { ...FAMILY_MARKERS[domain][family], code: `family:${family}` };
}

function collectMarkers(
  domain: TimingDomain,
  periodId: string,
  family: Family | null,
  evidence: readonly InquiryEvidence[],
  gender: string | null,
): TimingMarker[] {
  const markers: TimingMarker[] = [];
  const period = periodEvidence(evidence, periodId);
  if (family && period) markers.push({ ...familyMarker(domain, family, gender), evidenceId: period.id });

  for (const [shinsalId, marker] of Object.entries(SHINSAL_MARKERS[domain])) {
    const entry = shinsalEvidence(evidence, shinsalId, periodId)[0];
    if (entry) markers.push({ ...marker, code: `shinsal:${shinsalId}`, evidenceId: entry.id });
  }

  const opposing = relationEvidence(evidence, { periodId, dayBranch: true, types: OPPOSING_RELATIONS })[0];
  if (opposing) {
    markers.push({
      code: "relation:day-branch-opposing",
      tone: "caution",
      text: "원국의 일지(생활의 기반)와 부딪히는 충·형 같은 표지",
      activity: domain === "romance" ? "서운함은 작을 때 말하고, 큰 결정은 서두르지 않기" : "큰 결정은 한 번 더 검토하고, 컨디션과 가까운 관계의 마찰 관리하기",
      evidenceId: opposing.id,
    });
  }
  if (domain === "romance") {
    const combination = relationEvidence(evidence, {
      periodId,
      dayBranch: true,
      types: ["branch-six-combination", "branch-three-combination", "branch-directional-combination"],
    })[0];
    if (combination) {
      markers.push({
        code: "relation:day-branch-combination",
        tone: "positive",
        text: "원국의 일지와 묶이는 합 표지",
        activity: "관계를 한 단계 진전시키는 대화 해 보기",
        evidenceId: combination.id,
      });
    }
  }
  return markers;
}

function describe(markers: readonly TimingMarker[]): { statement: string; status: InquiryConclusionDraft["status"] } {
  const positives = markers.filter((marker) => marker.tone === "positive");
  const cautions = markers.filter((marker) => marker.tone === "caution");
  const neutrals = markers.filter((marker) => marker.tone === "neutral");
  const join = (items: readonly TimingMarker[]) => items.map((item) => item.text).join(", ");
  if (positives.length && !cautions.length) {
    return {
      status: "candidate",
      statement: `이 기간에는 ${withJosa(join(positives), "이/가")} 들어와 이 주제의 활동에 힘을 실어 볼 만한 때로 읽어요.`,
    };
  }
  if (positives.length && cautions.length) {
    return {
      status: "deferred",
      statement: `이 기간에는 ${withJosa(join(positives), "과/와")} 함께 ${withJosa(join(cautions), "이/가")} 같이 들어와, 기회와 조심할 점이 섞인 때로 읽어요.`,
    };
  }
  if (cautions.length) {
    return { status: "observation", statement: `이 기간에는 ${withJosa(join(cautions), "이/가")} 있어 이 주제는 서두르기보다 점검이 필요한 때로 읽어요.` };
  }
  return { status: "observation", statement: `이 기간에는 ${withJosa(join(neutrals), "이/가")} 들어와요. 뚜렷하게 밀어 줄 표지는 아니에요.` };
}

/** 상품 안에서 달을 고르는 선택 기준. 같은 근거를 두 번 더하지 않도록 표지마다 한 번만 센다. */
export function selectionScore(markers: readonly TimingMarker[]): number {
  return markers.filter((marker) => marker.tone === "positive").length - markers.filter((marker) => marker.tone === "caution").length;
}

export function createTimingRule(sink?: RuleDetailSink): InquiryRule {
  const meta = ruleMetadata("timing");
  return {
    metadata: meta,
    domains: [...TIMING_DOMAINS],
    kinds: ["timing"],
    evaluate: (context) => {
      const { period, periodId, evidence } = context;
      if (!period || !periodId) return [];
      const domain = context.question.domain as TimingDomain;
      const gender = typeof context.question.context.gender === "string" ? context.question.context.gender : null;
      const family = (period.stemTenGodFamily as Family | null) ?? null;
      const markers = collectMarkers(domain, periodId, family, evidence, gender);
      if (!markers.length) return [];

      const { statement, status } = describe(markers);
      const positiveIds = markers.filter((marker) => marker.tone !== "caution").map((marker) => marker.evidenceId);
      const cautionIds = markers.filter((marker) => marker.tone === "caution").map((marker) => marker.evidenceId);
      const support = status === "observation" ? [...new Set(markers.map((marker) => marker.evidenceId))] : [...new Set(positiveIds)];
      const counter = status === "observation" ? [] : [...new Set(cautionIds)].filter((id) => !support.includes(id));
      const contextual = context.contextEvidence.filter((entry) => entry.kind === "period").map((entry) => entry.id);
      const stage = periodStageEvidence(evidence, periodId);
      const stageCode = stage?.tags.find((tag) => tag.startsWith("stage:"))?.slice("stage:".length) ?? null;

      sink?.set(detailKey(meta.ruleId, periodId, statement), {
        aspect: "기간 분석",
        basis: markers.map((marker) => marker.text),
        timing: {
          periodId,
          periodKind: period.kind,
          label: period.label,
          startsAt: period.range?.startsAt ?? null,
          endsAt: period.range?.endsAt ?? null,
          tenGod: period.stemTenGod ?? null,
          markers,
          stageNote: stageCode ? (STAGE_NOTE[stageCode] ?? null) : null,
          selectionScore: selectionScore(markers),
        },
      });

      return [
        {
          key: "markers",
          statement,
          status,
          supportingEvidenceIds: support,
          counterEvidenceIds: counter,
          contextualEvidenceIds: [...new Set(contextual)],
          caveats: [TIMING_CAVEAT, ...(period.kind === "monthly" ? [MONTH_CAVEAT] : []), ...(stageCode ? ["12운성은 보조 설명으로만 썼다."] : [])],
        },
      ];
    },
  };
}
