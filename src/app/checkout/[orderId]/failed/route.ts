import { NextResponse, type NextRequest } from "next/server";
import { requestOrigin } from "@/lib/request-origin";
import { createSupabaseAdminClient, createSupabaseServerClient } from "@/lib/supabase/server";

const CANCEL_CODES = new Set(["PAY_PROCESS_CANCELED", "USER_CANCEL"]);

/** 결제사가 실패나 취소 후 돌려보내는 주소. 대기 중인 본인 주문만 닫는다. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await params;
  const { searchParams, pathname, search } = request.nextUrl;
  const origin = requestOrigin(request);

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) {
    return NextResponse.redirect(new URL(`/login?next=${encodeURIComponent(`${pathname}${search}`)}`, origin));
  }

  const code = searchParams.get("code") ?? "UNKNOWN";
  const message = searchParams.get("message") ?? "";
  const status = CANCEL_CODES.has(code) ? "cancelled" : "failed";

  await createSupabaseAdminClient().rpc("close_order", {
    p_order_id: orderId,
    p_user_id: data.user.id,
    p_status: status,
    p_code: code,
    p_message: message,
  });

  return NextResponse.redirect(new URL(`/checkout/${orderId}?result=${status}`, origin));
}
