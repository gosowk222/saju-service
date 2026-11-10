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

type User = { id: string; email: string | null; provider: string };

const control = {
  loginUser: { id: "00000000-0000-4000-8000-00000000000a", email: null as string | null, provider: "kakao" },
  loginError: null as string | null,
  openai: "ok",
  tossFail: null as string | null,
};
const stats = { openaiCalls: 0, tossConfirms: 0, lastOpenaiBody: null as unknown, openaiModels: [] as string[] };
const codes = new Map<string, User>();
const refreshTokens = new Map<string, User>();
const payments = new Map<string, { orderId: string; amount: number }>();

const b64 = (value: string | Buffer) => Buffer.from(value).toString("base64url");

function signJwt(user: User, expiresInSeconds = 3600): string {
  const header = b64(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const now = Math.floor(Date.now() / 1000);
  const payload = b64(
    JSON.stringify({ sub: user.id, role: "authenticated", aud: "authenticated", email: user.email, exp: now + expiresInSeconds, iat: now, session_id: randomUUID() }),
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
  return {
    id: user.id,
    aud: "authenticated",
    role: "authenticated",
    email: user.email ?? undefined,
    app_metadata: { provider: user.provider, providers: [user.provider] },
    user_metadata: {},
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
  return {
    items: [{ summary: input.text, domain: outside ? "non-saju" : "general", intent: "general", options: [], period: { kind: "none", start: "", end: "" }, missingInfo: [] }],
    userFacts: [],
    needsClarification: false,
  };
}

type NarrationV2Input = {
  nickname: string;
  facts: { ref: string }[];
  questions: { ref: string; summary: string; timingId: string | null }[];
  timing: { id: string; months: { ref: string }[] }[];
  topics: { topicId: string; target: number; statements: { ref: string }[] }[];
};

/** 2.0.0 풀이 테스트 응답. 질문마다 답을 두고 주제마다 3개 이상 설명을 둔다. */
function fixtureNarrationV2(input: NarrationV2Input) {
  const firstRef = input.topics.find((topic) => topic.statements.length)?.statements[0]?.ref ?? input.facts[0]!.ref;
  return {
    opening: `[테스트 응답] 안녕하세요, ${input.nickname} 님.`,
    focus: input.questions.flatMap((question) => {
      const ref = input.timing.find((entry) => entry.id === question.timingId)?.months[0]?.ref ?? firstRef;
      return [1, 2].map((index) => ({ kind: "explanation", refs: [question.ref, ref], text: `[테스트 응답] "${question.summary}"에 대한 ${index}번째 답이에요.` }));
    }),
    topics: input.topics.map((topic) => ({
      topicId: topic.topicId,
      bubbles: Array.from({ length: Math.max(topic.target, 3) }, (_, index) => ({
        kind: "explanation",
        refs: [topic.statements[index % Math.max(topic.statements.length, 1)]?.ref ?? input.facts[0]!.ref],
        text: `[테스트 응답] ${topic.topicId} 주제의 ${index + 1}번째 설명이에요. 긴 문장이 자연스럽게 줄바꿈되는지 확인하기 위한 문구도 함께 들어 있어요.`,
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

function handleOpenai(body: { model: string; input: string; text: { format: { name: string } } }, res: ServerResponse) {
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
    return send(res, 200, openaiResponse(JSON.stringify(fixtureNarrationV2(input as unknown as NarrationV2Input)), body.model));
  }
  if (schema === "saju_followup_v2") {
    if (mode === "followup-error") return send(res, 400, { error: { message: "fail" } });
    const questions = input.questions as { ref: string; summary: string }[];
    return send(
      res,
      200,
      openaiResponse(
        JSON.stringify({ mode: "answer", clarifyQuestion: "", sections: questions.map((question) => ({ questionRef: question.ref, text: `[테스트 응답] "${question.summary}"에 대한 답변이에요.`, refs: [] })) }),
        body.model,
      ),
    );
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

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", BASE);
    const { pathname } = url;
    if (req.method === "OPTIONS") return send(res, 200, {});
    const raw = await readBody(req);
    const body = raw ? (JSON.parse(raw) as Record<string, never>) : {};

    if (pathname === "/__control") {
      const incoming = body as Partial<typeof control>;
      if (incoming.loginUser) await db.addUser(incoming.loginUser.id, incoming.loginUser.email);
      Object.assign(control, incoming);
      return send(res, 200, control);
    }
    if (pathname === "/__state") return send(res, 200, stats);
    if (pathname === "/__expire") {
      refreshTokens.clear();
      return send(res, 200, { ok: true });
    }

    if (pathname === "/auth/v1/authorize") {
      const redirect = new URL(url.searchParams.get("redirect_to")!);
      if (control.loginError) {
        redirect.searchParams.set("error", control.loginError);
        redirect.searchParams.set("error_description", "test");
      } else {
        const code = randomUUID();
        codes.set(code, { ...control.loginUser, provider: url.searchParams.get("provider") ?? "kakao" });
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
      const email = claims.email;
      return send(res, 200, userJson({ id: claims.sub, email, provider: "kakao" }));
    }
    if (pathname === "/auth/v1/logout") return send(res, 204, undefined);

    if (pathname.startsWith("/rest/v1/rpc/")) return handleRpc(pathname.split("/").pop()!, body, req, res);
    if (pathname.startsWith("/rest/v1/")) return handleSelect(pathname.split("/").pop()!, url, req, res);

    if (pathname.startsWith("/openai/v1/responses")) return handleOpenai(body as never, res);
    if (pathname.startsWith("/toss/v1/payments")) return handleToss(pathname, body as never, res);

    return send(res, 404, { message: `no route ${pathname}` });
  });

  server.listen(PORT, "127.0.0.1", () => console.log(`fake gateway on ${BASE}`));
}

void main();
