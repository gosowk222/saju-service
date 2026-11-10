import { Suspense } from "react";
import { GrantTicketButton, ReadingAccessControl } from "@/components/admin-controls";
import { Button } from "@/components/ui/button";
import { Badge, Card, LoadingScreen, Notice, PageHeader } from "@/components/ui/layout";
import { getReadingAccess, requirePageAdmin } from "@/server/access";
import { listMembers } from "@/server/admin";
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

/**
 * 관리자 화면. 관리자 역할(user_roles.role = 'admin')인 카카오 회원만 들어온다. 다른 사람에게는 404로 보인다.
 * 역할은 이 화면이 아니라 DB에서 바꾼다 (docs/ADMIN.md).
 */
async function AdminContent({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const admin = await requirePageAdmin("/admin");
  const search = typeof params.q === "string" ? params.q.trim().slice(0, 100) : "";
  const [access, members] = await Promise.all([getReadingAccess(admin.id), listMembers(admin.id, search || null)]);

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
