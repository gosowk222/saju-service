import { ApiError, ok, requireApiUser, route } from "@/server/api";
import { loadReadingState } from "@/server/readings/store";

export const GET = route<{ readingId: string }>(async (_request, { readingId }) => {
  const { supabase } = await requireApiUser();
  const state = await loadReadingState(supabase, readingId);
  if (!state) throw new ApiError(403, "not_entitled", "구매 후 이용할 수 있어요.");
  return ok(state);
});
