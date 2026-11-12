import { Suspense } from "react";
import { GrantTicketButton, ReadingAccessControl } from "@/components/admin-controls";
import { Button } from "@/components/ui/button";
import { Badge, Card, LoadingScreen, Notice, PageHeader } from "@/components/ui/layout";
import { getReadingAccess, requirePageAdmin } from "@/server/access";
import {
  formatDuration,
  listMembers,
  loadLlmUsage,
  usageCells,
  usageStepLabel,
  type LlmUsageReading,
  type LlmUsageReport,
  type LlmUsageTotals,
} from "@/server/admin";
import { ApiError } from "@/server/api";
import { checkoutMode } from "@/server/checkout/mode";

const MODE_LABEL = {
  free_trial: "무료 테스트 (무료 이용권으로 이용, 새 결제 막힘)",
  payment: "결제 (토스페이먼츠, 새 무료 지급 멈춤)",
  misconfigured: "설정 오류 (새 지급과 새 결제가 모두 막힘)",
} as const;

const INPUT =
  "motion-fast h-input w-full min-w-0 rounded-lg border border-gray-300 bg-gray-50 px-5 type-body text-gray-900 outline-none focus:border-primary-600 focus:shadow-(--focus-ring)";

function formatDate(iso: string | null): string {
  if (!iso) return "없음";
  return new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(
    new Date(iso),
  );
}

const USAGE_COLUMNS = ["단계", "호출", "사용량 받음", "입력", "캐시 입력", "출력", "합계", "완전"] as const;
const TH = "border-b border-gray-200 px-3 py-2 text-left type-caption-sm text-gray-600";
const TD = "border-b border-gray-100 px-3 py-2 text-right type-caption tabular-nums text-gray-900";
const TD_LABEL = "border-b border-gray-100 px-3 py-2 text-left type-caption text-gray-900";

/** 사용량을 읽지 못하면(migration 미적용 등) 이 칸만 안내하고 나머지 관리 기능은 그대로 보여 준다. 로그에는 코드만 남긴다. */
async function loadUsageSafely(adminId: string): Promise<LlmUsageReport | null> {
  try {
    return await loadLlmUsage(adminId);
  } catch (error) {
    console.warn("[admin] usage unavailable", { code: error instanceof ApiError ? error.code : "internal" });
    return null;
  }
}

function UsageRow({ label, totals, strong = false }: { label: string; totals: LlmUsageTotals; strong?: boolean }) {
  const cells = usageCells(totals);
  const weight = strong ? " font-semibold" : "";
  return (
    <tr>
      <th scope="row" className={`${TD_LABEL}${weight}`}>
        {label}
      </th>
      <td className={`${TD}${weight}`}>{cells.calls}</td>
      <td className={`${TD}${weight}`}>{cells.callsWithUsage}</td>
      <td className={`${TD}${weight}`}>{cells.inputTokens}</td>
      <td className={`${TD}${weight}`}>{cells.cachedInputTokens}</td>
      <td className={`${TD}${weight}`}>{cells.outputTokens}</td>
      <td className={`${TD}${weight}`}>{cells.totalTokens}</td>
      <td className={`${TD}${weight}`}>{cells.usageComplete}</td>
    </tr>
  );
}

function UsageReading({ reading }: { reading: LlmUsageReading }) {
  const models = [...new Set(reading.steps.flatMap((step) => step.models))];
  const prompts = [...new Set(reading.steps.flatMap((step) => step.promptVersions))];
  const { timings } = reading;
  return (
    <Card className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="type-label font-semibold text-gray-900">
          {reading.productId ?? "상품 모름"} {reading.productVersion ?? ""}
        </span>
        <Badge tone={reading.total.usageComplete ? "neutral" : "warning"}>{reading.total.usageComplete ? "사용량 완전" : "사용량 일부 모름"}</Badge>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 type-caption text-gray-600">
        <dt>풀이 ID</dt>
        <dd className="min-w-0 truncate">{reading.readingId}</dd>
        <dt>풀이 생성</dt>
        <dd>{formatDate(reading.createdAt)}</dd>
        <dt>첫 호출 · 마지막 호출</dt>
        <dd>
          {formatDate(reading.firstCallAt)} · {formatDate(reading.lastCallAt)}
        </dd>
        <dt>모델</dt>
        <dd className="min-w-0 break-all">{models.join(", ") || "없음"}</dd>
        <dt>지시 버전</dt>
        <dd className="min-w-0 break-all">{prompts.join(", ") || "없음"}</dd>
        <dt>캐릭터 버전</dt>
        <dd>{reading.personaId ? `${reading.personaId} ${reading.personaVersion ?? ""}` : "없음"}</dd>
      </dl>
      <div role="region" aria-label="단계별 호출과 토큰" tabIndex={0} className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
        <table className="w-full min-w-max border-collapse">
          <caption className="sr-only">단계별 호출 수와 토큰</caption>
          <thead>
            <tr>
              {USAGE_COLUMNS.map((column) => (
                <th key={column} scope="col" className={TH}>
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {reading.steps.map((step) => (
              <UsageRow key={`${step.tier ?? "none"}-${step.step}`} label={usageStepLabel(step)} totals={step} />
            ))}
            <UsageRow label="풀이 합계" totals={reading.total} strong />
          </tbody>
        </table>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 type-caption text-gray-600">
        <dt>무료 첫 칸 완성까지</dt>
        <dd>{formatDuration(timings.freeFirstMs)}</dd>
        <dt>무료 단계 완료까지</dt>
        <dd>{formatDuration(timings.freeDoneMs)}</dd>
        <dt>유료 권한 뒤 첫 장 완성까지</dt>
        <dd>{formatDuration(timings.paidFirstMs)}</dd>
        <dt>유료 권한 뒤 전체 완료까지</dt>
        <dd>{formatDuration(timings.paidDoneMs)}</dd>
      </dl>
    </Card>
  );
}

function UsageTotal({ total }: { total: LlmUsageTotals }) {
  const cells = usageCells(total);
  return (
    <Card className="flex flex-col gap-2">
      <p className="type-label font-semibold text-gray-900">나열한 풀이 전체</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 type-caption text-gray-600">
        <dt>호출</dt>
        <dd className="tabular-nums">
          {cells.calls}회 (사용량 받음 {cells.callsWithUsage}회)
        </dd>
        <dt>입력 · 캐시 입력</dt>
        <dd className="tabular-nums">
          {cells.inputTokens} · {cells.cachedInputTokens}
        </dd>
        <dt>출력</dt>
        <dd className="tabular-nums">{cells.outputTokens}</dd>
        <dt>합계 (입력 + 출력)</dt>
        <dd className="tabular-nums">{cells.totalTokens}</dd>
        <dt>완전</dt>
        <dd>{cells.usageComplete}</dd>
      </dl>
    </Card>
  );
}

/** 무진 생성 사용량. 호출 단위 기록(llm_calls)을 단계별로 더한 값과 DB 시각으로 계산한 생성 시간만 보여 준다. 원문은 없다. */
function UsageSection({ usage }: { usage: LlmUsageReport | null }) {
  return (
    <section className="flex flex-col gap-4" aria-label="무진 생성 사용량">
      <div className="flex flex-col gap-1">
        <h2 className="type-title">무진 생성 사용량</h2>
        <p className="type-caption text-gray-600">
          최근에 호출한 풀이 {usage?.limit ?? 0}개까지, 실제 LLM 호출 하나마다 남긴 기록을 무료·유료와 단계(질문 정리, 초안, 무진 문장, 후속 질문)별로 더했어요.
          토큰은 API가 돌려준 값이에요. 캐시 입력은 입력에 이미 들어 있는 값이라 합계에 다시 더하지 않아요 (합계 = 입력 + 출력). 받지 못한 값은 0이 아니라 모름으로 보여요.
          질문 원문과 생성 문장은 이 화면에 없어요.
        </p>
      </div>
      {usage === null ? (
        <Notice tone="warning">사용량을 불러오지 못했어요. 무진 migration(20261113120000_mujin_scroll.sql)이 적용됐는지 확인해 주세요.</Notice>
      ) : usage.readings.length === 0 ? (
        <Notice>아직 기록된 호출이 없어요.</Notice>
      ) : (
        <>
          <UsageTotal total={usage.total} />
          <ul className="flex flex-col gap-3">
            {usage.readings.map((reading) => (
              <li key={reading.readingId}>
                <UsageReading reading={reading} />
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="type-caption text-gray-600">
        생성 시간은 DB에 저장된 시각으로 계산했어요: 무료 단계 시작과 완료, 칸마다 최종문을 저장한 시각, 구매 권한을 받은 시각, 유료 단계 완료 시각.
        유료 권한 뒤 시간에는 앞의 무료 단계가 끝나기를 기다린 시간도 들어 있어요. 실제 화면에 보이기까지의 시간은 서버가 알 수 없어 보여 주지 않아요.
        화면은 2초마다 저장 상태를 받아 그리므로 그만큼 늦게 보일 수 있어요.
      </p>
    </section>
  );
}

/**
 * 관리자 화면. 관리자 역할(user_roles.role = 'admin')인 카카오 회원만 들어온다. 다른 사람에게는 404로 보인다.
 * 역할은 이 화면이 아니라 DB에서 바꾼다 (docs/ADMIN.md).
 */
async function AdminContent({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const admin = await requirePageAdmin("/admin");
  const search = typeof params.q === "string" ? params.q.trim().slice(0, 100) : "";
  const [access, members, usage] = await Promise.all([getReadingAccess(admin.id), listMembers(admin.id, search || null), loadUsageSafely(admin.id)]);

  return (
    <main className="flex flex-1 flex-col gap-7 px-5 py-6">
      <Card className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h2 className="type-title">풀이 상품 이용</h2>
          <p className="type-label font-normal text-gray-600">
            관리자만: 관리자 역할 회원만 새 풀이, 이용권 사용, 후속 질문을 할 수 있어요. 모든 회원: 로그인한 카카오 회원 누구나 이용해요.
            이미 받은 풀이 다시 보기와 PDF는 설정과 관계없이 열려요.
          </p>
        </div>
        <ReadingAccessControl openToAll={access.openToAll} />
        <p className="type-caption text-gray-600">지금: {access.openToAll ? "모든 회원이 이용할 수 있어요" : "관리자만 이용할 수 있어요"}</p>
      </Card>

      <Card className="flex flex-col gap-2">
        <h2 className="type-title">이용 방식</h2>
        <p className="type-label font-normal text-gray-700">{MODE_LABEL[checkoutMode()]}</p>
        <p className="type-caption text-gray-600">배포 환경 변수 CHECKOUT_MODE로 바꿔요. 로그인은 어느 쪽이든 카카오만이에요.</p>
      </Card>

      <UsageSection usage={usage} />

      <section className="flex flex-col gap-4" aria-label="회원과 무료 이용권">
        <div className="flex flex-col gap-1">
          <h2 className="type-title">회원과 무료 이용권</h2>
          <p className="type-caption text-gray-600">고른 회원에게 무료 이용권을 1장씩 줄 수 있어요. 카카오 회원에게만 줄 수 있어요.</p>
        </div>
        <form method="get" className="flex gap-3">
          <label htmlFor="member-search" className="sr-only">
            회원 검색
          </label>
          <input id="member-search" name="q" defaultValue={search} placeholder="이름, 이메일, 회원 ID 앞자리" className={INPUT} />
          <Button type="submit" variant="secondary">
            검색
          </Button>
        </form>
        {members.length === 0 ? <Notice>찾는 회원이 없어요.</Notice> : null}
        <ul className="flex flex-col gap-3">
          {members.map((member) => {
            const label = member.name ?? member.email ?? `회원 ${member.id.slice(0, 8)}`;
            return (
              <li key={member.id}>
                <Card className="flex flex-col gap-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="min-w-0 truncate type-label font-semibold text-gray-900">{label}</span>
                    {member.role === "admin" ? <Badge tone="progress">관리자</Badge> : null}
                    {member.kakao ? null : <Badge tone="danger">카카오 연결 없음</Badge>}
                  </div>
                  <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 type-caption text-gray-600">
                    <dt>이메일</dt>
                    <dd className="min-w-0 truncate">{member.email ?? "없음"}</dd>
                    <dt>회원 ID</dt>
                    <dd className="min-w-0 truncate">{member.id}</dd>
                    <dt>가입</dt>
                    <dd>{formatDate(member.created_at)}</dd>
                    <dt>최근 로그인</dt>
                    <dd>{formatDate(member.last_sign_in_at)}</dd>
                    <dt>무료 이용권</dt>
                    <dd>
                      사용 가능 {member.tickets_available}장 · 사용 {member.tickets_used}장
                    </dd>
                  </dl>
                  {member.kakao ? <GrantTicketButton userId={member.id} label={label} /> : null}
                </Card>
              </li>
            );
          })}
        </ul>
      </section>

      <Card className="flex flex-col gap-2">
        <h2 className="type-title">역할 바꾸기</h2>
        <p className="type-label font-normal text-gray-600">
          역할(일반 회원, 관리자)은 이 화면에서 바꾸지 않아요. Supabase SQL Editor에서 회원 ID로 바꿔요.
        </p>
        <code className="block rounded-md bg-gray-100 px-4 py-3 type-caption break-all text-gray-900">
          select public.set_user_role(&apos;회원 ID&apos;, &apos;admin&apos;);
        </code>
      </Card>
    </main>
  );
}

export default function AdminPage(props: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return (
    <>
      <PageHeader title="관리자" backHref="/my" />
      <Suspense fallback={<LoadingScreen />}>
        <AdminContent searchParams={props.searchParams} />
      </Suspense>
    </>
  );
}
