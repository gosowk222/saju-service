import { z } from "zod";
import { requireApiAdmin } from "@/server/access";
import { setReadingsOpenToAll } from "@/server/admin";
import { ApiError, ok, readJson, route } from "@/server/api";

const BodySchema = z.object({ readingsOpenToAll: z.boolean() });

/** 풀이 상품 이용 범위를 바꾼다 (관리자만). 켜면 모든 회원, 끄면 관리자만 이용한다. */
export const POST = route(async (request) => {
  const { user } = await requireApiAdmin();
  const body = BodySchema.safeParse(await readJson(request));
  if (!body.success) throw new ApiError(400, "invalid_body", "요청 형식이 올바르지 않아요.");
  const readingsOpenToAll = await setReadingsOpenToAll(user.id, body.data.readingsOpenToAll);
  return ok({ readingsOpenToAll });
});
