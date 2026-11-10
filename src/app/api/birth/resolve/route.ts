import { z } from "zod";
import { ApiError, ok, readJson, requireApiUser, route } from "@/server/api";
import { branchRangesFor, resolveBirthDateNow } from "@/server/engine/analyze";
import { findPlace } from "@/server/places/search";
import { enforceRateLimit } from "@/server/rate-limit";

const BodySchema = z.object({
  yymmdd: z.string().max(6),
  calendar: z.enum(["solar", "lunar"]),
  isLeapMonth: z.boolean(),
  geonameId: z.number().int().positive().nullable().optional(),
});

/** 입력 중인 생년월일을 해석해 바로 보여 주기 위한 API. 달력 계산은 서버의 엔진만 한다. */
export const POST = route(async (request) => {
  const { user } = await requireApiUser();
  enforceRateLimit(`birth:${user.id}`, 120, 60_000);
  const parsed = BodySchema.safeParse(await readJson(request));
  if (!parsed.success) throw new ApiError(400, "invalid_body", "요청 형식이 올바르지 않아요.");

  const { yymmdd, calendar, isLeapMonth, geonameId } = parsed.data;
  const resolved = resolveBirthDateNow(yymmdd, calendar, isLeapMonth);
  if (!resolved.ok) return ok({ resolved });

  const place = geonameId ? findPlace(geonameId) : undefined;
  const branchRanges = place
    ? branchRangesFor({
        birthDate: resolved.birthDate,
        calendar,
        isLeapMonth: resolved.isLeapMonth,
        timezoneId: place.timezoneId,
        longitudeDeg: place.longitudeDeg,
      })
    : null;
  return ok({ resolved, branchRanges });
});
