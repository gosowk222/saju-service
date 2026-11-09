/** 브라우저와 서버가 함께 읽는 공개 설정. 비밀 값은 이 파일에 두지 않는다. */
export function supabaseUrl(): string {
  const value = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!value) throw new Error("NEXT_PUBLIC_SUPABASE_URL이 설정되지 않았습니다.");
  return value;
}

/** 새 형식의 publishable key를 우선하고, 기존 anon key도 그대로 받는다. */
export function supabasePublishableKey(): string {
  const value = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!value) throw new Error("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY가 설정되지 않았습니다.");
  return value;
}
