"use client";

export class ClientApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** 세션이 끝났으면 지금 화면으로 돌아오도록 표시하고 로그인으로 보낸다. */
function redirectToLogin(): never {
  const next = `${window.location.pathname}${window.location.search}`;
  // 세션이 끝난 상태의 클라이언트 상태를 모두 버리기 위해 전체 페이지를 다시 연다.
  // eslint-disable-next-line @next/next/no-location-assign-relative-destination
  window.location.assign(`/login?next=${encodeURIComponent(next)}&error=expired`);
  throw new ClientApiError(401, "unauthenticated", "로그인이 필요해요.");
}

export async function apiFetch<T>(url: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, headers, ...rest } = init ?? {};
  let response: Response;
  try {
    response = await fetch(url, {
      ...rest,
      headers: { ...(json !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
      body: json !== undefined ? JSON.stringify(json) : rest.body,
    });
  } catch {
    throw new ClientApiError(0, "network", "인터넷 연결을 확인하고 다시 시도해 주세요.");
  }
  if (response.status === 401) redirectToLogin();
  const body = (await response.json().catch(() => null)) as { error?: { code: string; message: string } } | null;
  if (!response.ok) {
    throw new ClientApiError(response.status, body?.error?.code ?? "unknown", body?.error?.message ?? "잠시 후 다시 시도해 주세요.");
  }
  return body as T;
}
