import { ok, requireApiUser, route } from "@/server/api";
import { searchPlaces } from "@/server/places/search";
import { enforceRateLimit } from "@/server/rate-limit";

export const GET = route(async (request) => {
  const { user } = await requireApiUser();
  enforceRateLimit(`places:${user.id}`, 60, 60_000);
  const query = request.nextUrl.searchParams.get("q") ?? "";
  return ok({ results: searchPlaces(query) });
});
