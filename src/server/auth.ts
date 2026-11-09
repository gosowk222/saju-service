import "server-only";
import type { User } from "@supabase/supabase-js";
import { redirect } from "next/navigation";
import { cache } from "react";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/** 한 번의 화면 렌더링 안에서 중복 호출을 줄인다. 요청 사이에는 공유되지 않는다. */
export const getVerifiedUser = cache(async (): Promise<User | null> => {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.getUser();
  if (error) return null;
  return data.user;
});

export async function requirePageUser(nextPath: string): Promise<User> {
  const user = await getVerifiedUser();
  if (!user) redirect(`/login?next=${encodeURIComponent(nextPath)}`);
  return user;
}
