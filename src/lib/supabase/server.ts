import "server-only";
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { connection } from "next/server";
import { supabasePublishableKey, supabaseUrl } from "./env";

/** 요청마다 새로 만드는 사용자 권한 클라이언트. RLS가 그대로 적용된다. */
export async function createSupabaseServerClient() {
  // 개인 데이터를 다루므로 항상 요청 시점에 실행한다. 미리 렌더링하거나 공유 캐시에 넣지 않는다.
  await connection();
  const cookieStore = await cookies();
  return createServerClient(supabaseUrl(), supabasePublishableKey(), {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (cookiesToSet) => {
        try {
          for (const { name, value, options } of cookiesToSet) cookieStore.set(name, value, options);
        } catch {
          // 서버 컴포넌트에서는 쿠키를 쓸 수 없다. 세션 갱신은 proxy가 맡는다.
        }
      },
    },
  });
}

function supabaseSecretKey(): string {
  const value = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!value) throw new Error("SUPABASE_SECRET_KEY가 설정되지 않았습니다.");
  return value;
}

/**
 * RLS를 우회하는 서버 전용 클라이언트. 결제 확정, 풀이 저장, 질문 차감에만 쓴다.
 * 호출 전에 반드시 getUser로 검증한 사용자 ID를 함수에 넘긴다.
 */
export function createSupabaseAdminClient() {
  return createClient(supabaseUrl(), supabaseSecretKey(), {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}
