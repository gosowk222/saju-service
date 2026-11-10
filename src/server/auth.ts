import "server-only";
import type { User } from "@supabase/supabase-js";
import { redirect } from "next/navigation";
import { cache } from "react";
import { hasLoginIdentity } from "@/domain/auth/providers";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * Supabase Auth에 다시 물어 검증한 사용자. 세션 쿠키 값만으로 판단하지 않는다.
 * 한 번의 화면 렌더링 안에서 중복 호출을 줄인다. 요청 사이에는 공유되지 않는다.
 */
export const getVerifiedUser = cache(async (): Promise<User | null> => {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.getUser();
  if (error) return null;
  return data.user;
});

/**
 * 이 앱의 회원: 검증된 사용자 정보의 실제 연결(identities)에 카카오가 있는 사용자.
 * 구글만 연결된 예전 세션은 회원이 아니다. Supabase에서 구글 제공자를 꺼도 이미 발급된 세션은 남을 수 있어 여기서 다시 막는다.
 */
export function isMember(user: User): boolean {
  return hasLoginIdentity(user);
}

export const getVerifiedMember = cache(async (): Promise<User | null> => {
  const user = await getVerifiedUser();
  return user && isMember(user) ? user : null;
});

export async function requirePageUser(nextPath: string): Promise<User> {
  const user = await getVerifiedUser();
  const next = encodeURIComponent(nextPath);
  if (!user) redirect(`/login?next=${next}`);
  if (!isMember(user)) redirect(`/login?error=kakao_required&next=${next}`);
  return user;
}
