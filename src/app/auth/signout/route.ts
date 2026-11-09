import { NextResponse } from "next/server";
import { requestOrigin } from "@/lib/request-origin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { route } from "@/server/api";

export const POST = route(async (request) => {
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut({ scope: "local" });
  return NextResponse.redirect(new URL("/login", requestOrigin(request)), { status: 303 });
});
