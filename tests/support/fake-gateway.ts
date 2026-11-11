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

const control = {
  loginUser: { id: "00000000-0000-4000-8000-00000000000a", email: null as string | null, provider: "kakao", providers: undefined as string[] | undefined },
  loginError: null as string | null,
  openai: "ok",
  tossFail: null as string | null,
  /** 스트리밍 응답에서 글자 묶음 사이의 간격. 주제별로 먼저 보이는지 확인할 때 늘린다. */
  streamDelayMs: 10,
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

/** 현재 지시는 readings(작성 재료 3.0.0), 이전 지시는 statements로 해석을 넘긴다. */
type MaterialTopic = { readings?: { ref: string }[]; statements?: { ref: string }[] };
const refsOf = (topic: MaterialTopic) => (topic.readings ?? topic.statements ?? []).map((item) => item.ref);

type NarrationV2Input = {
  alreadySent?: { opening: string | null; focus: string[]; topics: { topicId: string }[] } | null;
  nickname: string;
  facts: { ref: string }[];
  questions: { ref: string; summary: string; timingId: string | null }[];
  timing: { id: string; months: { ref: string }[] }[];
  topics: ({ topicId: string; target: number } & MaterialTopic)[];
};

/** 2.0.0 풀이 테스트 응답. 질문마다 답을 두고 주제마다 3개 이상 설명을 둔다. */
function fixtureNarrationV2(input: NarrationV2Input) {
  const firstRef = input.topics.map(refsOf).find((refs) => refs.length)?.[0] ?? input.facts[0]!.ref;
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
        refs: [refsOf(topic)[index % Math.max(refsOf(topic).length, 1)] ?? input.facts[0]!.ref],
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

  async function handleSelect(table: string, url: URL, req: IncomingMessage, res: ServerResponse) {
    const { role, userId } = identify(req);
    const clauses: string[] = [];
    const params: unknown[] = [];
    let order = "";
    let limit = "";
    for (const [key, value] of url.searchParams) {
      if (key === "select" || key === "columns") continue;
      if (key === "order") {
        const [column, direction] = value.split(".");
        order = ` order by ${column} ${direction === "desc" ? "desc" : "asc"}`;
      } else if (key === "limit") {
        limit = ` limit ${Number(value)}`;
      } else if (value.startsWith("eq.")) {
        params.push(value.slice(3));
        clauses.push(`${key}::text = $${params.length}`);
      } else if (value.startsWith("in.(")) {
        const list = value.slice(4, -1).split(",").map((item) => item.replace(/^"|"$/g, ""));
        params.push(list);
        clauses.push(`${key}::text = any($${params.length}::text[])`);
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

  /** 서버 권한으로 행을 고친다 (후속 답변을 문단마다 먼저 저장). eq 조건만 지원하고, 고친 행을 돌려준다. */
  async function handleUpdate(table: string, url: URL, body: Record<string, unknown>, req: IncomingMessage, res: ServerResponse) {
    const { role, userId } = identify(req);
    const params: unknown[] = [];
    const sets = Object.entries(body).map(([column, value]) => {
      params.push(value !== null && typeof value === "object" ? JSON.stringify(value) : value);
      return `${column} = $${params.length}`;
    });
    const clauses: string[] = [];
    for (const [key, value] of url.searchParams) {
      if (!value.startsWith("eq.")) continue;
      params.push(value.slice(3));
      clauses.push(`${key}::text = $${params.length}`);
    }
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

  /** 서버 권한으로 행을 넣는다 (생성 중 완성된 주제의 메시지 저장). Prefer: return=minimal처럼 빈 본문으로 답한다. */
  async function handleInsert(table: string, body: unknown, req: IncomingMessage, res: ServerResponse) {
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
    if (pathname.startsWith("/rest/v1/") && req.method === "POST") return handleInsert(pathname.split("/").pop()!, JSON.parse(raw || "[]"), req, res);
    if (pathname.startsWith("/rest/v1/")) return handleSelect(pathname.split("/").pop()!, url, req, res);

    if (pathname.startsWith("/openai/v1/responses")) return handleOpenai(body as never, res);
    if (pathname.startsWith("/toss/v1/payments")) return handleToss(pathname, body as never, res);

    return send(res, 404, { message: `no route ${pathname}` });
  });

  server.listen(PORT, "127.0.0.1", () => console.log(`fake gateway on ${BASE}`));
}

void main();
