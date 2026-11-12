/**
 * 브라우저 테스트 전용 가짜 외부 서버. Supabase Auth, PostgREST, OpenAI, 토스 승인 API를 흉내 낸다.
 * 앱 코드는 실제와 같은 SDK와 경로로 호출하며, 데이터베이스는 실제 migration을 적용한 테스트용 Postgres다.
 *
 * 여기서 돌려주는 답변과 결제는 모두 고정된 테스트 값이다. 실제 OAuth, 실제 결제, 실제 모델 검증이 아니다.
 */
import { createHmac, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createTestDb, type DbRole } from "./test-db";

const PORT = Number(process.env.GATEWAY_PORT ?? 54399);
const JWT_SECRET = "e2e-test-secret";
export const SERVICE_KEY = "e2e-service-key";
const BASE = `http://127.0.0.1:${PORT}`;

/**
 * providers는 이 계정에 실제로 연결된 로그인 수단(identities)이다. 없으면 [provider].
 * 앱은 카카오로만 로그인을 시작하지만, 예전에 구글로 만든 계정·세션을 흉내 내려고 구글 연결도 만들 수 있다.
 */
type User = { id: string; email: string | null; provider: string; providers?: string[] };

const providersOf = (user: User) => user.providers ?? [user.provider];

/** 무진 장 하나를 일부러 실패시키는 설정. pass의 그 장 응답을 times번 망가뜨린 뒤 스스로 꺼진다. */
type MujinFailure = { section: string; pass: "pass1" | "pass2"; times: number };

const control = {
  loginUser: { id: "00000000-0000-4000-8000-00000000000a", email: null as string | null, provider: "kakao", providers: undefined as string[] | undefined },
  loginError: null as string | null,
  openai: "ok",
  tossFail: null as string | null,
  /** 스트리밍 응답에서 글자 묶음 사이의 간격. 주제별로 먼저 보이는지 확인할 때 늘린다. */
  streamDelayMs: 10,
  /**
   * 무진(족자 상품) 장 하나의 실패 주입. 그 장을 검사에 걸리는 빈 장(핵심 답·블록 없음)으로 돌려준다.
   * 실행기는 한 요청 안에서 걸린 장만 한 번 더 요청하므로, 화면에 그 장의 오류가 보이게 하려면 times를 2로 둔다.
   * 무진 브라우저 테스트가 beforeEach·afterEach에서 null로 되돌린다 (다른 테스트 파일은 이 키를 모른다).
   */
  mujinFail: null as MujinFailure | null,
  /** 무진 Pass 2(무진 문장) 응답을 늦추는 시간. Pass 2가 Pass 1 수신을 막지 않는지, 뒤 장이 먼저 끝나도 목차 순서가 유지되는지 볼 때 쓴다. */
  mujinVoiceDelayMs: 0,
  /** mujinVoiceDelayMs를 적용할 장. null이면 모든 장을 늦춘다. */
  mujinVoiceDelaySections: null as string[] | null,
};
const stats = {
  /** /auth/v1/authorize에 들어온 제공자. 앱이 카카오 외의 로그인을 시작하지 않았는지 확인한다. */
  authorizeProviders: [] as string[],
  openaiCalls: 0,
  /** 최초 풀이 호출 수와 마지막 입력. 이어 쓰기(alreadySent)를 확인할 때 쓴다. */
  narrationCalls: 0,
  lastNarrationInput: null as unknown,
  tossConfirms: 0,
  lastOpenaiBody: null as unknown,
  openaiModels: [] as string[],
  /**
   * 무진 호출 수와 마지막 입력 요약 (누적값이다. 테스트는 이전 값과의 차이로 본다).
   * calls: 스키마별 호출 수 (question = mujin_question_analysis, pass1 = mujin_draft, pass2 = mujin_voice).
   * sections: 장별 요청 수. Pass 1은 장 묶음 호출 안의 장을 하나씩 센다.
   * last: 마지막 입력의 구조 요약 (장 ID, 질문 ref, 표·기간 자료 유무 등). 생성 문장은 담지 않는다.
   */
  mujin: {
    calls: { question: 0, pass1: 0, pass2: 0 },
    sections: { pass1: {} as Record<string, number>, pass2: {} as Record<string, number> },
    last: {
      question: null as MujinQuestionSummary | null,
      pass1: null as MujinDraftSummary | null,
      pass2: null as MujinVoiceSummary | null,
      /** 기간 자료가 들어간 마지막 Pass 1 입력의 요약 (9·10장 묶음). 마지막 정리 묶음이 뒤에 와도 남는다. */
      timing: null as MujinDraftSummary["timing"],
    },
  },
};
const codes = new Map<string, User>();
/** 사용자별 연결된 로그인 수단. /auth/v1/user가 identities로 돌려준다. */
const userProviders = new Map<string, string[]>();
const refreshTokens = new Map<string, User>();
const payments = new Map<string, { orderId: string; amount: number }>();

const b64 = (value: string | Buffer) => Buffer.from(value).toString("base64url");

function signJwt(user: User, expiresInSeconds = 3600): string {
  const header = b64(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const now = Math.floor(Date.now() / 1000);
  const payload = b64(
    JSON.stringify({
      sub: user.id,
      role: "authenticated",
      aud: "authenticated",
      email: user.email,
      app_metadata: { provider: providersOf(user)[0], providers: providersOf(user) },
      exp: now + expiresInSeconds,
      iat: now,
      session_id: randomUUID(),
    }),
  );
  const signature = b64(createHmac("sha256", JWT_SECRET).update(`${header}.${payload}`).digest());
  return `${header}.${payload}.${signature}`;
}

function verifyJwt(token: string): { sub: string; role: string; email: string | null } | null {
  const [header, payload, signature] = token.split(".");
  if (!header || !payload || !signature) return null;
  if (b64(createHmac("sha256", JWT_SECRET).update(`${header}.${payload}`).digest()) !== signature) return null;
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString()) as { sub: string; role: string; email: string | null; exp: number };
  return claims.exp > Date.now() / 1000 ? claims : null;
}

function userJson(user: User) {
  const providers = providersOf(user);
  return {
    id: user.id,
    aud: "authenticated",
    role: "authenticated",
    email: user.email ?? undefined,
    app_metadata: { provider: providers[0], providers },
    user_metadata: {},
    identities: providers.map((provider) => ({
      identity_id: `${provider}-${user.id}`,
      id: `${provider}:${user.id}`,
      user_id: user.id,
      provider,
      identity_data: {},
      created_at: "2026-11-09T00:00:00Z",
    })),
    created_at: "2026-11-09T00:00:00Z",
  };
}

function sessionJson(user: User) {
  const refresh = randomUUID();
  refreshTokens.set(refresh, user);
  return {
    access_token: signJwt(user),
    token_type: "bearer",
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    refresh_token: refresh,
    user: userJson(user),
  };
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "*",
    "access-control-allow-methods": "*",
    ...headers,
  });
  res.end(body === undefined ? "" : JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw;
}

/** 테스트 전용 응답. 문장에 표시를 넣어 실제 풀이로 오해할 수 없게 한다. */
function fixtureNarration(input: { nickname: string; topics: { topicId: string; statements: { ref: string }[]; bubbles: { target: number } }[]; facts: { ref: string }[] }) {
  return {
    opening: `[테스트 응답] 안녕하세요, ${input.nickname} 님.`,
    closing: "[테스트 응답] 궁금한 점은 편하게 물어봐 주세요.",
    topics: input.topics.map((topic) => ({
      topicId: topic.topicId,
      bubbles: Array.from({ length: Math.max(topic.bubbles.target, 1) }, (_, index) => ({
        kind: "explanation",
        refs: [topic.statements[0]?.ref ?? input.facts[0]!.ref],
        text: `[테스트 응답] ${topic.topicId} 주제의 ${index + 1}번째 설명이에요. 긴 문장이 자연스럽게 줄바꿈되는지 확인하기 위한 문구도 함께 들어 있어요.`,
      })),
    })),
  };
}

/** 질문 정리 테스트 응답. 날씨·코드 질문은 범위 밖, 나머지는 원문을 그대로 요약으로 쓴다. */
function fixtureQuestion(input: { text: string }) {
  const outside = /날씨|코드/.test(input.text);
  // 질문 없이 칭찬이나 허세 지적만 보내면 반응만 돌려준다 (question-1.3.0).
  const reaction = /맞췄|소름|대박/.test(input.text) ? "praise" : /허세|잘난 척/.test(input.text) ? "tease" : "none";
  const onlyReaction = reaction !== "none" && !/[?？]|알려|어때|언제/.test(input.text);
  return {
    items: onlyReaction
      ? []
      : [{ summary: input.text, domain: outside ? "non-saju" : "general", intent: "general", options: [], period: { kind: "none", start: "", end: "" }, missingInfo: [] }],
    userFacts: [],
    needsClarification: false,
    reaction,
  };
}

type NarrationV2Input = {
  alreadySent?: { opening: string | null; focus: string[]; topics: { topicId: string }[] } | null;
  nickname: string;
  facts: { ref: string }[];
  questions: { ref: string; summary: string; timingId: string | null }[];
  timing: { id: string; months: { ref: string }[] }[];
  topics: { topicId: string; target: number; statements: { ref: string }[] }[];
};

/** 2.0.0 풀이 테스트 응답. 질문마다 답을 두고 주제마다 3개 이상 설명을 둔다. */
function fixtureNarrationV2(input: NarrationV2Input) {
  const firstRef = input.topics.find((topic) => topic.statements.length)?.statements[0]?.ref ?? input.facts[0]!.ref;
  // 이어 쓰기: 이미 보낸 부분은 비워 두고 나머지만 쓴다 (reading-2.4.0의 규칙).
  const sent = input.alreadySent;
  const sentTopics = new Set(sent?.topics.map((topic) => topic.topicId) ?? []);
  return {
    opening: sent?.opening ? "" : `[테스트 응답] 안녕하세요, ${input.nickname} 님.`,
    focus: sent?.focus.length ? [] : input.questions.flatMap((question) => {
      const ref = input.timing.find((entry) => entry.id === question.timingId)?.months[0]?.ref ?? firstRef;
      return [1, 2].map((index) => ({ kind: "explanation", refs: [question.ref, ref], text: `[테스트 응답] "${question.summary}"에 대한 ${index}번째 답이에요.` }));
    }),
    topics: input.topics.map((topic) => ({
      topicId: topic.topicId,
      bubbles: Array.from({ length: sentTopics.has(topic.topicId) ? 0 : Math.max(topic.target, 3) }, (_, index) => ({
        kind: "explanation",
        refs: [topic.statements[index % Math.max(topic.statements.length, 1)]?.ref ?? input.facts[0]!.ref],
        text:
          index === 0
            ? `[테스트 응답] ${topic.topicId} 주제의 첫 설명이에요. 강조 확인 문구는 굵게 보여야 해요.`
            : `[테스트 응답] ${topic.topicId} 주제의 ${index + 1}번째 설명이에요. 긴 문장이 자연스럽게 줄바꿈되는지 확인하기 위한 문구도 함께 들어 있어요.`,
        // narration-2.1.0: 굵게 보일 구절은 따로 받고 서버가 표시를 붙인다.
        highlight: index === 0 ? "강조 확인 문구" : "",
      })),
    })),
    closing: "[테스트 응답] 궁금한 점은 편하게 물어봐 주세요.",
  };
}

// ─── 무진의 종합 사주 (족자 상품) 테스트 응답 ─────────────────────────────
// 스키마 이름은 src/server/llm/mujin-prompts.ts의 mujin_question_analysis, mujin_draft(Pass 1), mujin_voice(Pass 2)다.
// 무진 후속 질문은 묘묘와 같은 saju_question_analysis·saju_followup_v2를 쓰므로 아래 기존 분기가 답한다.
// 응답은 요청 입력(장 ID, 질문 ID, 재료 ref)으로 조립해 앱 검사(src/domain/mujin/check.ts)를 통과하게 만든다.
// 문장마다 '[테스트 응답]'을 넣고, 날짜·비율·금액·확률·결과 단정처럼 검사에 걸리는 표현은 쓰지 않는다.

type MujinQuestionSummary = { items: number; facts: number; domains: string[] };
type MujinDraftSummary = {
  sectionIds: string[];
  tiers: string[];
  /** 입력에 넣은 사용자 질문 ref (무료 단계에는 무료 장에 이어진 질문만 들어가야 한다). */
  questionRefs: string[];
  hasTables: boolean;
  /** 기간 자료 (9·10장 묶음에만 들어간다). */
  timing: { luckStatus: string; luckReason: string | null; months: number } | null;
  /** 앞선 시도에서 검사에 걸린 문제 수 (다시 쓰기 요청이면 0보다 크다). */
  retryIssues: number;
};
type MujinVoiceSummary = { sectionId: string; draftBlocks: number; userFacts: number; retryIssues: number };

type MujinBlock = { type: string; questionIds: string[]; refs: string[]; text: string; items: { label: string; text: string }[] };

type MujinDraftInput = {
  questions: { ref: string }[];
  tables: unknown;
  timing: { luck: { status: string; reasonNote: string | null }; months: { months: unknown[] } } | null;
  sections: { sectionId: string; tier: string; questions: { id: string; refs: string[] }[] }[];
  fixTheseProblemsFromPreviousAttempt?: string[];
};

type MujinVoiceInput = {
  draft: { sectionId: string; coreAnswer: string; blocks: MujinBlock[] };
  userFacts: unknown[];
  fixTheseProblemsFromPreviousAttempt?: string[];
};

/** 궁금한 점 문장의 분야. 단어로 고른다 (테스트 응답이라 실제 분류기의 판단이 아니다). */
function mujinDomainOf(sentence: string): string {
  if (/날씨|코드/.test(sentence)) return "non-saju";
  if (/프리랜서|취업|이직|직장|회사|창업|사업|업무|진로/.test(sentence)) return "career";
  if (/돈|재물|저축|소비|월급|수입/.test(sentence)) return "wealth";
  if (/연애|결혼|애인|인연/.test(sentence)) return "romance";
  if (/가족|부모/.test(sentence)) return "family";
  return "temperament";
}

const MUJIN_OPTIONS = ["취업", "프리랜서", "사업", "창업", "이직"];

/**
 * 무진 질문 정리 테스트 응답 (mujin-question-1.0.0). 궁금한 점을 문장으로 나눠 범위 안 질문을 1~2개 만들고,
 * '~ 중인데'처럼 지금 상태를 말한 부분은 현재 사실(current), '~하고 싶다'는 계획(plan)으로 돌려준다.
 */
function fixtureMujinQuestion(input: { text: string }) {
  const sentences = input.text
    .split(/(?<=[?？.!])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  const items: { summary: string; domain: string; intent: string; options: string[]; period: { kind: string; start: string; end: string }; missingInfo: string[] }[] = [];
  const userFacts: { text: string; domain: string; kind: string }[] = [];
  for (const sentence of sentences) {
    const domain = mujinDomainOf(sentence);
    const options = MUJIN_OPTIONS.filter((option) => sentence.includes(option));
    const compare = options.length >= 2 && /나을까|중에|비교/.test(sentence);
    const timing = /언제|시기/.test(sentence);
    if (items.length < 2) {
      items.push({
        summary: sentence,
        domain,
        intent: timing ? "timing" : compare ? "compare" : "general",
        options: compare ? options : [],
        period: { kind: timing ? "default" : "none", start: "", end: "" },
        missingInfo: [],
      });
    }
    if (/(준비|다니는|활동|운영|쉬는)\s*중/.test(sentence)) {
      // '취업 준비 중인데 …' → '취업 준비 중이다'
      const clause = sentence
        .split(/인데|이지만|,/)[0]!
        .replace(/[?？.!]+$/, "")
        .replace(/(이에요|예요|입니다)$/, "")
        .trim();
      userFacts.push({ text: `${clause}이다`, domain, kind: "current" });
    } else if (/싶|계획/.test(sentence)) {
      userFacts.push({ text: sentence.replace(/[?？.!]+$/, ""), domain, kind: "plan" });
    }
  }
  stats.mujin.last.question = { items: items.length, facts: userFacts.length, domains: items.map((item) => item.domain) };
  return { items, userFacts, needsClarification: false, reaction: "none" };
}

/** 실패 주입: 이 Pass·장의 응답을 망가뜨릴 차례면 true를 돌려주고 남은 횟수를 줄인다. 다 쓰면 스스로 꺼진다. */
function takeMujinFailure(pass: MujinFailure["pass"], sectionId: string): boolean {
  const fail = control.mujinFail;
  if (!fail || fail.pass !== pass || fail.section !== sectionId || fail.times <= 0) return false;
  fail.times -= 1;
  if (fail.times <= 0) control.mujinFail = null;
  return true;
}

/** 1~10장은 생활 장면 블록을 하나 둔다 (기초 분석과 마지막 정리는 두지 않는다). */
const isMujinChapter = (sectionId: string) => /^ch\d+$/.test(sectionId);

/** 블록 종류를 돌아가며 쓴다. 비교·점검처럼 항목이 필요한 종류는 쓰지 않는다 (형식 검사가 항목 수를 본다). */
const MUJIN_TEXT_BLOCKS = ["paragraph", "basis", "condition", "apply"] as const;

/**
 * Pass 1 평문 초안 테스트 응답 (mujin-draft-1.0.0). 장마다 핵심 답과, 질문마다 그 질문 ID를 단 블록 하나를 둔다.
 * refs는 그 질문의 재료 ref 가운데 앞의 두 개만 쓴다 (모두 그 장에서 쓸 수 있는 ref다). 문장은 평서문(~다)이다.
 */
function fixtureMujinDraft(input: MujinDraftInput) {
  return {
    sections: input.sections.map((section) => {
      // 검사에 걸리는 빈 장. 실행기는 이 장만 다시 요청하고, 계속 걸리면 이 장만 실패로 남긴다.
      if (takeMujinFailure("pass1", section.sectionId)) return { sectionId: section.sectionId, coreAnswer: "", blocks: [], scenes: [] };
      const chapter = isMujinChapter(section.sectionId);
      const blocks: MujinBlock[] = section.questions.map((question, index) => ({
        type: MUJIN_TEXT_BLOCKS[index % MUJIN_TEXT_BLOCKS.length]!,
        questionIds: [question.id],
        refs: question.refs.slice(0, 2),
        text: `[테스트 응답] ${section.sectionId} 장 ${question.id} 질문의 초안 설명이다. 긴 문장이 자연스럽게 줄바꿈되는지 확인하는 문구도 함께 들어 있다.`,
        items: [],
      }));
      if (chapter) blocks.push({ type: "scene", questionIds: [], refs: [], text: "[테스트 응답] 바쁜 하루 끝에 할 일을 다시 고르는 날이 있다고 해 보자.", items: [] });
      return {
        sectionId: section.sectionId,
        coreAnswer: `[테스트 응답] ${section.sectionId} 장의 핵심 답이다. **강조 확인 문구**는 굵게 보여야 한다.`,
        blocks,
        scenes: chapter ? [`${section.sectionId} 장의 생활 장면`] : [],
      };
    }),
  };
}

/** 초안 문장을 존댓말로 옮긴다. 숫자·장 ID·질문 ID는 그대로 둔다 (최종문 검사가 초안에 없던 숫자를 잡는다). */
function politeMujin(text: string): string {
  return text
    .replace(/초안 /g, "")
    .replace(/이다\./g, "이에요.")
    .replace(/있다\./g, "있어요.")
    .replace(/한다\./g, "해요.")
    .replace(/해 보자\./g, "해 볼게요.");
}

/** Pass 2 무진 문장 테스트 응답 (mujin-voice-1.0.0). 초안을 거의 그대로 옮긴다: 질문 ID·ref·블록 수·장면 수를 보존하고 새 숫자를 넣지 않는다. */
function fixtureMujinVoice(input: MujinVoiceInput) {
  const sectionId = input.draft.sectionId;
  if (takeMujinFailure("pass2", sectionId)) return { section: { sectionId, coreAnswer: "", blocks: [] } };
  return {
    section: {
      sectionId,
      coreAnswer: politeMujin(input.draft.coreAnswer),
      blocks: input.draft.blocks.map((block) => ({
        ...block,
        text: politeMujin(block.text),
        items: block.items.map((item) => ({ label: item.label, text: politeMujin(item.text) })),
      })),
    },
  };
}

const bump = (counts: Record<string, number>, key: string) => {
  counts[key] = (counts[key] ?? 0) + 1;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 무진 스키마면 응답하고 true, 아니면 false (기존 분기로 넘긴다). */
function handleMujin(schema: string, input: Record<string, unknown>, body: { model: string; stream?: boolean }, res: ServerResponse): boolean {
  const reply = (text: string) => (body.stream ? void sendStream(res, text, body.model) : send(res, 200, openaiResponse(text, body.model)));
  if (schema === "mujin_question_analysis") {
    stats.mujin.calls.question += 1;
    reply(JSON.stringify(fixtureMujinQuestion(input as { text: string })));
    return true;
  }
  if (schema === "mujin_draft") {
    const draft = input as unknown as MujinDraftInput;
    stats.mujin.calls.pass1 += 1;
    for (const section of draft.sections) bump(stats.mujin.sections.pass1, section.sectionId);
    stats.mujin.last.pass1 = {
      sectionIds: draft.sections.map((section) => section.sectionId),
      tiers: [...new Set(draft.sections.map((section) => section.tier))],
      questionRefs: draft.questions.map((question) => question.ref),
      hasTables: draft.tables !== null && draft.tables !== undefined,
      timing: draft.timing ? { luckStatus: draft.timing.luck.status, luckReason: draft.timing.luck.reasonNote, months: draft.timing.months.months.length } : null,
      retryIssues: draft.fixTheseProblemsFromPreviousAttempt?.length ?? 0,
    };
    if (stats.mujin.last.pass1.timing) stats.mujin.last.timing = stats.mujin.last.pass1.timing;
    // 실행기는 스트림에서 장 원소가 닫힐 때마다 검사·저장하므로 실제처럼 글자를 나눠 보낸다 (sendStream).
    reply(JSON.stringify(fixtureMujinDraft(draft)));
    return true;
  }
  if (schema === "mujin_voice") {
    const voice = input as unknown as MujinVoiceInput;
    const sectionId = voice.draft.sectionId;
    stats.mujin.calls.pass2 += 1;
    bump(stats.mujin.sections.pass2, sectionId);
    stats.mujin.last.pass2 = {
      sectionId,
      draftBlocks: voice.draft.blocks.length,
      userFacts: voice.userFacts.length,
      retryIssues: voice.fixTheseProblemsFromPreviousAttempt?.length ?? 0,
    };
    const text = JSON.stringify(fixtureMujinVoice(voice));
    const delayed = control.mujinVoiceDelayMs > 0 && (!control.mujinVoiceDelaySections || control.mujinVoiceDelaySections.includes(sectionId));
    if (!delayed) reply(text);
    // 늦추는 동안 앱이 연결을 끊었으면(시간 초과 등) 보내지 않는다.
    else void sleep(control.mujinVoiceDelayMs).then(() => (res.writableEnded || res.destroyed ? undefined : reply(text)));
    return true;
  }
  return false;
}

function openaiResponse(text: string, model: string) {
  return {
    id: `resp_${randomUUID()}`,
    object: "response",
    status: "completed",
    model,
    output: [{ type: "message", id: "m", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] }],
    usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 10 } },
  };
}

/**
 * 스트리밍 응답(SSE). 실제 서버처럼 글자를 조금씩 나눠 보내 주제가 완성될 때마다 먼저 저장되는 흐름을 확인한다.
 * 이벤트 형식은 Responses API의 response.output_text.delta, response.completed를 따른다.
 */
/** 지금 흘려보내는 스트리밍 응답. 멈춰 세우면(frozen) 연결은 둔 채 더 보내지 않는다. 서버 요청이 멈춘 상황을 흉내 낼 때 쓴다. */
const activeStreams = new Set<{ frozen: boolean }>();

async function sendStream(res: ServerResponse, text: string, model: string) {
  const handle = { frozen: false };
  activeStreams.add(handle);
  res.on("close", () => activeStreams.delete(handle));
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  // 앱이 생성을 끊으면(검사 실패, 다른 요청이 이어받음) 더 보내지 않는다.
  let closed = false;
  res.on("close", () => (closed = true));
  res.on("error", () => (closed = true));
  let sequence = 0;
  const write = (event: Record<string, unknown>) => !closed && res.write(`event: ${String(event.type)}\ndata: ${JSON.stringify({ ...event, sequence_number: sequence++ })}\n\n`);
  write({ type: "response.created", response: { ...openaiResponse("", model), status: "in_progress", output: [] } });
  const size = 160;
  for (let index = 0; index < text.length && !closed; index += size) {
    while (handle.frozen && !closed) await new Promise((resolve) => setTimeout(resolve, 100));
    if (closed) return;
    write({ type: "response.output_text.delta", item_id: "m", output_index: 0, content_index: 0, delta: text.slice(index, index + size), logprobs: [] });
    await new Promise((resolve) => setTimeout(resolve, control.streamDelayMs));
  }
  if (closed) return;
  write({ type: "response.completed", response: openaiResponse(text, model) });
  res.end();
}

function handleOpenai(body: { model: string; input: string; stream?: boolean; text: { format: { name: string } } }, res: ServerResponse) {
  stats.openaiCalls += 1;
  stats.lastOpenaiBody = body;
  stats.openaiModels.push(body.model);
  const mode = control.openai;
  if (mode === "error-once") {
    control.openai = "ok";
    return send(res, 400, { error: { message: "fail", type: "invalid_request_error" } });
  }
  if (mode === "error") return send(res, 400, { error: { message: "fail" } });

  const input = JSON.parse(body.input) as Record<string, unknown>;
  const schema = body.text.format.name;
  // 무진(족자 상품) 스키마를 먼저 본다. 아래 이전 형식·기본값 분기는 묘묘 입력(topics, facts)을 전제로 해서 무진 입력이 떨어지면 예외가 난다.
  if (handleMujin(schema, input, body, res)) return;
  if (schema === "saju_question_analysis") {
    if (mode === "followup-error" && input.mode === "followup") return send(res, 400, { error: { message: "fail" } });
    return send(res, 200, openaiResponse(JSON.stringify(fixtureQuestion(input as { text: string })), body.model));
  }
  if (schema === "saju_narration_v2") {
    stats.narrationCalls += 1;
    stats.lastNarrationInput = input;
    const text = JSON.stringify(fixtureNarrationV2(input as unknown as NarrationV2Input));
    if (body.stream) return void sendStream(res, text, body.model);
    return send(res, 200, openaiResponse(text, body.model));
  }
  if (schema === "saju_followup_v2") {
    if (mode === "followup-error") return send(res, 400, { error: { message: "fail" } });
    const questions = input.questions as { ref: string; summary: string }[];
    // followup-output-2.1.0의 속성 순서(mode → sections[questionRef, refs, text] → clarifyQuestion)대로 쓴다.
    // 빈 줄로 나눈 문단은 화면에서 말풍선 하나씩으로 보인다.
    const text = JSON.stringify({
      mode: "answer",
      sections: questions.map((question) => ({
        questionRef: question.ref,
        refs: [],
        text: [
          `[테스트 응답] "${question.summary}"에 대한 답변이에요.`,
          "[테스트 응답] **두 번째 문단**은 다음 말풍선이에요.",
          "[테스트 응답] 세 번째 문단까지 차례로 보여요.",
        ].join("\n\n"),
      })),
      clarifyQuestion: "",
    });
    if (body.stream) return void sendStream(res, text, body.model);
    return send(res, 200, openaiResponse(text, body.model));
  }
  // 이전 형식(1.0.0) 응답. 이전 계획으로 시작된 작업을 확인할 때 쓴다.
  if ("question" in input) {
    const question = String(input.question);
    if (mode === "followup-error") return send(res, 400, { error: { message: "fail" } });
    const unrelated = /날씨|코드/.test(question);
    const statements = input.statements as { ref: string }[];
    return send(
      res,
      200,
      openaiResponse(
        JSON.stringify(
          unrelated
            ? { relevance: "unrelated", answer: "", refs: [] }
            : { relevance: "related", answer: `[테스트 응답] "${question}"에 대한 답변이에요.`, refs: [statements[0]!.ref] },
        ),
        body.model,
      ),
    );
  }
  return send(res, 200, openaiResponse(JSON.stringify(fixtureNarration(input as never)), body.model));
}

function handleToss(pathname: string, body: { paymentKey: string; orderId: string; amount: number }, res: ServerResponse) {
  if (pathname.endsWith("/confirm")) {
    stats.tossConfirms += 1;
    if (control.tossFail) {
      const code = control.tossFail;
      control.tossFail = null;
      return send(res, 400, { code, message: "테스트 거절" });
    }
    payments.set(body.paymentKey, { orderId: body.orderId, amount: body.amount });
    return send(res, 200, { paymentKey: body.paymentKey, orderId: body.orderId, status: "DONE", totalAmount: body.amount, currency: "KRW", method: "카드" });
  }
  return send(res, 404, { code: "NOT_FOUND", message: "x" });
}

async function main() {
  const db = await createTestDb();
  await db.addUser(control.loginUser.id);
  // 실제 기본값은 '관리자만'이다. 브라우저 테스트는 일반 회원 흐름이 대부분이라 '모든 회원'으로 시작하고,
  // 관리자 설정 테스트(admin.spec.ts)가 바꾼 뒤 되돌린다.
  await db.pg.query(`update public.app_settings set value = 'true'::jsonb where key = 'readings_open_to_all'`);

  /** 사용자와 연결된 로그인 수단을 데이터베이스(auth.identities)와 Auth 응답에 함께 등록한다. */
  async function register(user: User) {
    const providers = providersOf(user);
    userProviders.set(user.id, [...new Set([...(userProviders.get(user.id) ?? []), ...providers])]);
    await db.addUser(user.id, user.email, providers);
  }

  function identify(req: IncomingMessage): { role: DbRole; userId: string | null } {
    const apikey = String(req.headers.apikey ?? "");
    const bearer = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
    if (apikey === SERVICE_KEY || bearer === SERVICE_KEY) return { role: "service_role", userId: null };
    const claims = bearer ? verifyJwt(bearer) : null;
    return claims ? { role: "authenticated", userId: claims.sub } : { role: "anon", userId: null };
  }

  async function handleRpc(fn: string, body: Record<string, unknown>, req: IncomingMessage, res: ServerResponse) {
    const { role, userId } = identify(req);
    const keys = Object.keys(body);
    const args = keys.map((key, index) => `${key} := $${index + 1}`).join(", ");
    const params = keys.map((key) => {
      const value = body[key];
      return value !== null && typeof value === "object" ? JSON.stringify(value) : value;
    });
    try {
      const rows = await db.run<{ result: Record<string, unknown> }>(role, userId, `select row_to_json(s) as result from (select * from public.${fn}(${args})) s`, params);
      const row = rows[0]?.result ?? null;
      const rowKeys = row ? Object.keys(row) : [];
      if (row && rowKeys.length === 1 && rowKeys[0] === fn) return send(res, 200, row[fn] === "" ? null : row[fn]);
      return send(res, 200, row);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[gateway rpc]", fn, message);
      return send(res, message.includes("permission denied") ? 403 : 400, { message, code: "P0001" });
    }
  }

  /**
   * 이 흉내가 지원하는 조회 조건은 eq.와 in.(...)뿐이다. 그 밖의 연산자(is., neq., gt., lt., like., or=, offset 등)를
   * 조용히 무시하면 의도보다 많은 행을 읽거나 고쳐 테스트가 잘못 통과할 수 있으므로, 지원하지 않는 조건이면 null을 돌려
   * 호출한 쪽이 400으로 거부하게 한다 (앱 코드가 새 연산자를 쓰기 시작하면 브라우저 테스트가 바로 알려 준다).
   */
  function filterClause(key: string, value: string, params: unknown[]): string | null {
    if (value.startsWith("eq.")) {
      params.push(value.slice(3));
      return `${key}::text = $${params.length}`;
    }
    if (value.startsWith("in.(") && value.endsWith(")")) {
      params.push(value.slice(4, -1).split(",").map((item) => item.replace(/^"|"$/g, "")));
      return `${key}::text = any($${params.length}::text[])`;
    }
    return null;
  }

  /** order=열.asc|desc[.nullsfirst|.nullslast] (쉼표로 여러 열). 모양이 다르면 null. */
  function orderClause(value: string): string | null {
    const parts = value.split(",").map((part) => {
      const [column, ...modifiers] = part.split(".");
      if (!column || !/^[a-z_][a-z0-9_]*$/.test(column) || modifiers.some((modifier) => !["asc", "desc", "nullsfirst", "nullslast"].includes(modifier))) return null;
      const nulls = modifiers.includes("nullsfirst") ? " nulls first" : modifiers.includes("nullslast") ? " nulls last" : "";
      return `${column} ${modifiers.includes("desc") ? "desc" : "asc"}${nulls}`;
    });
    return parts.every((part) => part !== null) ? ` order by ${parts.join(", ")}` : null;
  }

  function unsupported(res: ServerResponse, what: string) {
    console.error("[gateway] unsupported PostgREST query", what);
    return send(res, 400, { message: `fake gateway does not support ${what}`, code: "FAKE_UNSUPPORTED" });
  }

  async function handleSelect(table: string, url: URL, req: IncomingMessage, res: ServerResponse) {
    const { role, userId } = identify(req);
    const clauses: string[] = [];
    const params: unknown[] = [];
    let order = "";
    let limit = "";
    for (const [key, value] of url.searchParams) {
      if (key === "select" || key === "columns") continue;
      if (key === "order") {
        const clause = orderClause(value);
        if (clause === null) return unsupported(res, `${table} order=${value}`);
        order = clause;
      } else if (key === "limit") {
        limit = ` limit ${Number(value)}`;
      } else {
        const clause = filterClause(key, value, params);
        if (clause === null) return unsupported(res, `${table} ${key}=${value}`);
        clauses.push(clause);
      }
    }
    const where = clauses.length ? ` where ${clauses.join(" and ")}` : "";
    try {
      const columns = url.searchParams.get("select") ?? "*";
      const sql = `select ${columns === "*" ? "t.*" : columns} from public.${table} t${where}${order}${limit}`;
      const rows = await db.run<Record<string, unknown>>(role, userId, sql, params);
      const headers = { "content-range": `0-${Math.max(rows.length - 1, 0)}/${rows.length}` };
      if (req.method === "HEAD") return send(res, 200, undefined, headers);
      if (String(req.headers.accept ?? "").includes("vnd.pgrst.object")) {
        return rows.length === 1 ? send(res, 200, rows[0]) : send(res, 406, { message: "not single", code: "PGRST116" });
      }
      return send(res, 200, rows, headers);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return send(res, message.includes("permission denied") ? 403 : 400, { message });
    }
  }

  /**
   * 서버 권한으로 행을 고친다 (후속 답변을 문단마다 먼저 저장). eq·in 조건만 지원하고, 고친 행을 돌려준다
   * (.update().select()의 select는 열을 고르지 않고 모든 열을 돌려준다). 지원하지 않는 조건은 무시하지 않고 400으로 거부한다.
   */
  async function handleUpdate(table: string, url: URL, body: Record<string, unknown>, req: IncomingMessage, res: ServerResponse) {
    const { role, userId } = identify(req);
    const params: unknown[] = [];
    const sets = Object.entries(body).map(([column, value]) => {
      params.push(value !== null && typeof value === "object" ? JSON.stringify(value) : value);
      return `${column} = $${params.length}`;
    });
    const clauses: string[] = [];
    for (const [key, value] of url.searchParams) {
      if (key === "select" || key === "columns") continue;
      const clause = filterClause(key, value, params);
      if (clause === null) return unsupported(res, `PATCH ${table} ${key}=${value}`);
      clauses.push(clause);
    }
    // 조건 없는 변경은 표 전체를 고친다. 앱이 그렇게 쓰지 않으므로 실수로 보고 거부한다.
    if (!clauses.length) return unsupported(res, `PATCH ${table} without filter`);
    try {
      const rows = await db.run<Record<string, unknown>>(
        role,
        userId,
        `update public.${table} set ${sets.join(", ")}${clauses.length ? ` where ${clauses.join(" and ")}` : ""} returning *`,
        params,
      );
      return send(res, 200, rows);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return send(res, message.includes("permission denied") ? 403 : 400, { message });
    }
  }

  /**
   * 서버 권한으로 행을 넣는다 (생성 중 완성된 주제의 메시지 저장). Prefer: return=minimal처럼 빈 본문으로 답한다.
   * upsert(on_conflict, resolution)와 insert().select()(return=representation)는 흉내 내지 않으므로, 그대로 넣거나 빈 본문을 주지 않고 거부한다.
   */
  async function handleInsert(table: string, url: URL, body: unknown, req: IncomingMessage, res: ServerResponse) {
    const prefer = String(req.headers.prefer ?? "");
    if (url.searchParams.has("on_conflict") || /resolution=/.test(prefer)) return unsupported(res, `upsert into ${table}`);
    if (url.searchParams.has("select") || /return=representation/.test(prefer)) return unsupported(res, `insert into ${table} with select`);
    const { role, userId } = identify(req);
    const rows = (Array.isArray(body) ? body : [body]) as Record<string, unknown>[];
    if (!rows.length) return send(res, 201, undefined);
    const columns = Object.keys(rows[0]!);
    const params: unknown[] = [];
    const values = rows.map(
      (row) =>
        `(${columns
          .map((column) => {
            const value = row[column];
            params.push(value !== null && typeof value === "object" ? JSON.stringify(value) : value);
            return `$${params.length}`;
          })
          .join(", ")})`,
    );
    try {
      await db.run(role, userId, `insert into public.${table} (${columns.join(", ")}) values ${values.join(", ")}`, params);
      return send(res, 201, undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return send(res, message.includes("permission denied") ? 403 : 409, { message, code: "23505" });
    }
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", BASE);
    const { pathname } = url;
    if (req.method === "OPTIONS") return send(res, 200, {});
    const raw = await readBody(req);
    const body = raw ? (JSON.parse(raw) as Record<string, never>) : {};

    if (pathname === "/__control") {
      const incoming = body as Partial<typeof control>;
      // providers를 보내지 않으면 이전 테스트의 값이 남지 않게 지운다 (기본은 provider 하나).
      if (incoming.loginUser) incoming.loginUser = { ...incoming.loginUser, providers: incoming.loginUser.providers ?? undefined };
      Object.assign(control, incoming);
      return send(res, 200, control);
    }
    /** 이미 발급된 세션을 흉내 낸다 (예: 구글 제공자를 끄기 전에 만든 구글 세션). 앱의 로그인 흐름을 거치지 않는다. */
    if (pathname === "/__session") {
      const user = body as unknown as User;
      await register(user);
      return send(res, 200, sessionJson(user));
    }
    /** 테스트에서 데이터베이스 상태를 직접 확인하거나 준비한다 (관리자 권한). */
    if (pathname === "/__sql") {
      const { sql, params } = body as unknown as { sql: string; params?: unknown[] };
      try {
        const result = await db.pg.query(sql, params ?? []);
        return send(res, 200, result.rows);
      } catch (error) {
        return send(res, 400, { message: error instanceof Error ? error.message : String(error) });
      }
    }
    if (pathname === "/__state") return send(res, 200, stats);
    // 서버 요청이 중간에 멈춘 상황을 흉내 낸다: 생성 작업의 점유 시간을 지난 것으로 바꿔 다음 요청이 이어받게 한다.
    if (pathname === "/__freeze_streams") {
      for (const handle of activeStreams) handle.frozen = true;
      return send(res, 200, { frozen: activeStreams.size });
    }
    if (pathname === "/__expire_generation") {
      const readingId = (body as unknown as { readingId: string }).readingId;
      await db.run("service_role", null, "update public.generation_jobs set lease_until = now() - interval '1 second' where reading_id = $1", [readingId]);
      return send(res, 200, { ok: true });
    }
    if (pathname === "/__expire") {
      refreshTokens.clear();
      return send(res, 200, { ok: true });
    }

    if (pathname === "/auth/v1/authorize") {
      const provider = url.searchParams.get("provider") ?? "";
      stats.authorizeProviders.push(provider);
      const redirect = new URL(url.searchParams.get("redirect_to")!);
      if (control.loginError) {
        redirect.searchParams.set("error", control.loginError);
        redirect.searchParams.set("error_description", "test");
      } else {
        // 로그인한 계정의 연결 정보는 control.loginUser가 정한다 (기본은 카카오 하나).
        const user: User = { ...control.loginUser, provider: control.loginUser.provider ?? provider };
        await register(user);
        const code = randomUUID();
        codes.set(code, user);
        redirect.searchParams.set("code", code);
      }
      res.writeHead(302, { location: redirect.toString() });
      return res.end();
    }
    if (pathname === "/auth/v1/token") {
      const grant = url.searchParams.get("grant_type");
      if (grant === "pkce") {
        const payload = body as unknown as { auth_code: string; code_verifier?: string };
        const user = codes.get(payload.auth_code);
        if (!user || !payload.code_verifier) return send(res, 400, { error: "invalid_grant", error_description: "bad code", code: "bad_code" });
        codes.delete(payload.auth_code);
        return send(res, 200, sessionJson(user));
      }
      const user = refreshTokens.get((body as unknown as { refresh_token: string }).refresh_token);
      if (!user) return send(res, 400, { error_code: "refresh_token_not_found", msg: "invalid" });
      return send(res, 200, sessionJson(user));
    }
    if (pathname === "/auth/v1/user") {
      const claims = verifyJwt(String(req.headers.authorization ?? "").replace(/^Bearer /, ""));
      if (!claims) return send(res, 401, { error_code: "bad_jwt", msg: "invalid" });
      const providers = userProviders.get(claims.sub) ?? ["kakao"];
      return send(res, 200, userJson({ id: claims.sub, email: claims.email, provider: providers[0]!, providers }));
    }
    if (pathname === "/auth/v1/logout") return send(res, 204, undefined);

    if (pathname.startsWith("/rest/v1/rpc/")) return handleRpc(pathname.split("/").pop()!, body, req, res);
    if (pathname.startsWith("/rest/v1/") && req.method === "PATCH") return handleUpdate(pathname.split("/").pop()!, url, body, req, res);
    if (pathname.startsWith("/rest/v1/") && req.method === "POST") return handleInsert(pathname.split("/").pop()!, url, JSON.parse(raw || "[]"), req, res);
    if (pathname.startsWith("/rest/v1/")) return handleSelect(pathname.split("/").pop()!, url, req, res);

    if (pathname.startsWith("/openai/v1/responses")) {
      try {
        return handleOpenai(body as never, res);
      } catch (error) {
        // 고정 응답을 만들다 예외가 나도 가짜 서버 프로세스가 멈추지 않게 한다 (멈추면 뒤의 모든 테스트가 실패한다). 앱은 서버 오류로 받는다.
        console.error("[gateway openai]", error instanceof Error ? error.message : String(error));
        return send(res, 500, { error: { message: "fake gateway fixture failed", type: "server_error" } });
      }
    }
    if (pathname.startsWith("/toss/v1/payments")) return handleToss(pathname, body as never, res);

    return send(res, 404, { message: `no route ${pathname}` });
  });

  server.listen(PORT, "127.0.0.1", () => console.log(`fake gateway on ${BASE}`));
}

void main();
