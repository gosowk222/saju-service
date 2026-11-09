import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { route } from "@/server/api";

export const POST = route(async (request) => {
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut({ scope: "local" });
  return NextResponse.redirect(new URL("/login", request.nextUrl.origin), { status: 303 });
});
