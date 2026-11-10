# 무료 테스트 모드와 무료 이용권

기준일 2026-11-11. 로그인 정책(카카오만)은 `docs/AUTH_POLICY.md`에 있고 이 문서의 모드와 관계없다.

## 현재 운영 상태

풀이 상품 이용 범위(관리자만 / 모든 회원)와 관리자 이용권 지급은 `docs/ADMIN.md`에 있다. 이용 범위가 "관리자만"이면 일반 회원은 이용권을 가지고 있어도 쓰지 못한다 (이용권은 그대로 남는다).

| 항목 | 값 |
| --- | --- |
| 이용 방식 | `CHECKOUT_MODE` 미설정 = `free_trial` (기본값) |
| 캠페인 | `free-trial-2026-11` (고정) |
| 대상 상품 | 묘묘의 사주 참견 (`first-overview`). 상품 ID, 가격 설정(990원), 구성, 후속 질문 3회는 그대로다 |
| 결제 | 새 결제를 서버에서 막는다. 결제 연동 코드와 기존 거래 기록은 지우지 않았다 |

## 정책

| 항목 | 기준 |
| --- | --- |
| 대상 | 이 앱의 정상 카카오 로그인 회원 (`is_kakao_member`) |
| 지급 수 | 캠페인 이용권은 회원 계정당 한 장 (신규·기존 회원 모두). 관리자가 고른 회원에게 한 장씩 더 줄 수 있다 (`docs/ADMIN.md`) |
| 다시 지급하지 않는 경우 | 재로그인, 새로고침, 다른 기기, 사용 완료 뒤, 재배포, 문구 변경, 결제 모드 전환 |
| 만료 | 없음 (이번 단계) |
| 대상이 아닌 계정 | 구글만 연결된 계정, 탈퇴·익명·이용 정지 계정, 비로그인 |
| 본인확인 | 하지 않는다. 카카오 계정 하나당 한 장이다 |
| 사용 시점 | 맛보기의 "무료 이용권 1장으로 풀이받기"를 누를 때. 로그인, 상품 보기, 출생정보 입력·수정, 원국 계산, 맛보기에서는 쓰지 않는다 |
| 이용권으로 받는 것 | 결제한 풀이와 같다. 실제 사주 풀이, 묘묘 페르소나, 질문 반영, 후속 질문 3회, 보관함, PDF |
| 입력 | 카드 번호, 결제 수단, 이용권 코드를 받지 않는다 |

## 상태

| 이용권 (`free_tickets.status`) | 생성 작업 (`generation_jobs.status`) | 화면 상태 | 동선 |
| --- | --- | --- | --- |
| `available` | 없음 | 사용 가능 | 무료 이용권으로 시작하기 |
| `redeemed` | `queued`, `running` | 특정 풀이에 연결되어 생성 중 | 이어서 보기 |
| `redeemed` | `failed` | 생성 실패, 재시도 가능 | 추가 차감 없이 다시 시도 |
| `completed` | `completed` | 생성 완료 | 내 풀이 보기, 보관함 |

이용권을 다 쓴 회원이 새 맛보기를 만들면 기존 풀이와 보관함으로 안내한다. 결제 모드라면 결제 버튼도 함께 보인다.

## 지급

세 경로가 같은 함수 `grant_free_ticket(user_id, campaign_id)`를 쓴다. 회원 판정도 그 안의 `is_kakao_member`가 한다.

| 경로 | 시점 | 실패하면 |
| --- | --- | --- |
| 신규 가입 | 카카오 로그인 콜백 (`/auth/callback`) | 로그인은 계속한다. 다음 조회에서 다시 지급한다 |
| 누락 복구 | 이용권 조회 (홈, 마이, 맛보기, 사용 직전) | 안내 문구를 보여 주고 다음 조회에서 다시 시도한다 |
| 기존 회원 일괄 | `grant_free_tickets_to_kakao_members(campaign_id)` (서버 관리자) | 회원별로 실패 수를 센다 |

지급은 무료 테스트 모드에서만 한다. 결제 모드에서는 세 경로 모두 새로 지급하지 않는다 (일괄 지급은 관리자가 실행할 때만).

### 기존 회원 일괄 지급

Supabase SQL Editor 또는 `supabase db query --linked`로 실행한다. 여러 번 실행해도 회원당 한 장이다.

```sql
select public.grant_free_tickets_to_kakao_members('free-trial-2026-11');
-- {"users": 전체, "granted": 새로 지급, "skippedExisting": 이미 있음, "notEligible": 대상 아님, "failed": 실패, "campaignId": ...}
```

결과는 `free_ticket_events`에 `kind = 'backfill'`로 남는다.

실제 Supabase에서의 적용·실행 여부는 `docs/PROGRESS.md`의 이번 작업 기록에 있다 (2026-11-11 기준 migration 적용 대기).

## 중복 방지

| 위험 | 막는 방법 |
| --- | --- |
| 같은 회원에게 두 장 | `free_tickets`의 `unique (user_id, campaign_id)`. 조회 후 생성이 아니라 `insert ... on conflict do nothing`이다 |
| 새 캠페인으로 재지급 | `campaign_id` 검사 제약 (`free-trial-2026-11`만 허용). 바꾸려면 새 migration이 필요하다 |
| 한 장을 두 풀이에 사용 | 사용 함수가 회원 단위 잠금(`pg_advisory_xact_lock`)을 먼저 잡는다. 요청 ID나 탭이 달라도 같은 회원의 사용은 한 번에 하나씩 처리된다. 이용권 ↔ 풀이는 서로 하나씩만 연결된다 (`free_tickets_one_per_reading`, `entitlements.ticket_id unique`) |
| 관리자 지급 두 번 누르기 | 같은 지급 요청 ID(`grant_request_id` 고유)는 한 번만 반영된다 |
| 같은 요청 재전송, 다시 열기 | 이미 권한이 있는 풀이면 추가로 쓰지 않고 `already_redeemed`로 같은 풀이를 돌려준다 |
| 결제와 이용권으로 같은 풀이를 두 번 | 권한은 풀이당 하나(`entitlements` 기본 키). 사용할 때 그 풀이의 대기 주문을 닫는다. 결제 완료가 먼저면 이용권은 그대로 남는다 |
| 사용 완료 기록 삭제로 재지급 | 앱과 브라우저에는 이용권을 지우는 경로가 없다. 반환도 같은 행을 되돌리고 기록을 남긴다 |
| 브라우저에서 상태 조작 | `free_tickets`는 본인 행 읽기만 허용. 쓰기와 함수 실행은 `service_role`만 |

동시 요청은 실제 Postgres 17.11에서 확인했다 (`npm run test:db-concurrency`, 아래 "검증").

## 사용

`POST /api/readings/{readingId}/redeem` 본문 `{ "requestId": "<uuid>" }`. 서버가 로그인한 카카오 회원, 풀이 소유자, 대상 상품, 이용권 상태를 확인하고 `redeem_free_ticket`을 부른다. 한 트랜잭션 안에서 다음을 한다.

1. 회원 단위 잠금 → 풀이(입력 정보와 맛보기) 소유자 확인 → 이미 권한이 있는지 확인 → 사용 가능한 이용권 한 장 고르기 (캠페인 이용권 → 먼저 받은 순)
2. 이용권을 풀이에 연결 (`status = 'redeemed'`, 사용 시점의 상품·규칙·계산 버전 `binding`)
3. 이용 권한 (`entitlements`, `source = 'free_ticket'`, 질문 횟수 = 상품 설정)
4. 생성 작업 (`generation_jobs`, `ticket_id`)
5. 기록 (`free_ticket_events`, `redeemed`)

출생정보와 질문은 연결된 `readings` 행에 저장되어 있고 수정하지 않는다 (입력 수정은 새 행을 만든다). 결제 기록이나 결제 승인 번호를 만들지 않는다.

응답: `redeemed`, `already_redeemed`, `already_entitled`(이미 결제한 풀이), `ticket_used`(다른 풀이에 이미 사용, 그 풀이 ID). 오류: `no_ticket`(409), `reading_closed`(409), `not_found`(404), `kakao_login_required`(403).

본문, 후속 질문, 보관함, PDF는 결제와 같은 이용 권한(`entitlements`) 경로로 확인한다. 권한 출처는 `entitlements.source`(`payment` / `free_ticket`)로 구분한다.

## 생성 실패와 재시도

- 사용 전 단계(입력 검증, 사용 트랜잭션)에서 실패하면 트랜잭션 전체가 되돌아가 이용권이 그대로 남는다.
- 생성 중 오류가 나면 이용권은 그 풀이에 연결된 채(`redeemed`) 남고, 같은 풀이를 추가 차감 없이 다시 시도한다 (화면의 "추가 차감 없이 다시 시도하기", 사용자 재시도 상한 4회).
- 생성 작업은 서버에 기록되어 있다. 서버가 중간에 멈추면 점유 시간(300초)이 지난 뒤 다음 요청(풀이 화면 진입, 상태 조회)이 같은 작업을 이어받는다. 이미 저장된 주제는 다시 쓰지 않는다.
- 같은 풀이를 여러 요청이 동시에 생성하지 않는다 (`claim_generation`의 행 잠금과 점유 시간).
- OpenAI 호출 중에는 DB 트랜잭션을 열어 두지 않는다. 주제·완료 저장 때마다 짧은 트랜잭션을 쓴다.
- 타임아웃만으로 이용권을 반환하지 않는다. 이전 요청이 아직 실행 중일 수 있다.
- 홈·마이의 이용권 카드와 보관함에서 진행 중이거나 실패한 풀이로 돌아갈 수 있다.
- 후속 질문 사용 횟수는 `question_usage`에 쌓이므로 재시도·재로그인으로 초기화되지 않는다.

## 복구할 수 없는 실패의 반환 (서버 관리용)

시도 상한을 다 썼거나(`attempts_exhausted`) 설정 오류처럼 다시 시도해도 안 되는 실패에만 쓴다. 관리자 화면은 없고 SQL로 실행한다.

```sql
-- 1) 대상 확인
select t.id as ticket_id, t.user_id, t.status, t.reading_id, j.status as job_status, j.attempts, j.error_code, j.lease_until
from public.free_tickets t
left join public.generation_jobs j on j.reading_id = t.reading_id
where t.user_id = '<회원 ID>';

-- 2) 반환 (사유 필수)
select public.restore_free_ticket('<ticket_id>', '<사유: 예) 생성 시도 소진, 문의 #번호>');
```

| 조건 | 결과 |
| --- | --- |
| 생성 완료된 풀이 | 반환하지 않음 (`already_delivered`) |
| 점유 시간이 남은 실행 중 작업 | 반환하지 않음 (`still_running`). 점유 시간이 지난 뒤 다시 확인한다 |
| 이미 사용 가능 상태 | 아무것도 바꾸지 않음 (`already_available`, 중복 반환 방지) |
| 그 밖의 연결된 이용권 | 생성 작업을 `cancelled`로 닫고, 그 풀이의 이용 권한을 회수하고, 같은 이용권 행을 사용 가능으로 되돌린다 (`restore_count + 1`) |

- 닫힌 작업은 늦게 끝난 이전 요청이 완료로 바꾸지 못한다 (`complete_generation`이 `running`만 완료). 반환과 늦은 완료가 겹쳐도 둘 중 하나만 반영된다.
- 닫힌 풀이에는 이용권도 결제도 다시 쓰지 않는다 (`reading_closed`). 맛보기 화면이 "새로 만들기"(같은 정보가 채워진 입력 확인)로 안내한다.
- 사유와 당시 작업 상태는 `free_ticket_events`(`restored`)에 남는다.

## 결제 모드로 돌아가기

1. 배포 환경 변수에 `CHECKOUT_MODE=payment`를 넣는다.
2. 토스 키(`NEXT_PUBLIC_TOSS_CLIENT_KEY`, `TOSS_SECRET_KEY`)가 있는지 확인한다. 테스트 키(`test_`)만 허용되며, 실결제는 `PAYMENTS_ALLOW_LIVE=true`를 따로 넣어야 한다. 모드만 바꿔서 실결제가 되지 않는다.
3. 다시 배포한다. 코드나 데이터베이스는 바꾸지 않는다.

| 항목 | 결제 모드에서 |
| --- | --- |
| 로그인 | 카카오만 (변화 없음) |
| 새 무료 지급 | 멈춤 |
| 이미 지급한 미사용 이용권 | 그대로 사용 가능 |
| 이용권으로 받은 풀이, 결제로 받은 풀이 | 그대로 열람, 후속 질문, PDF |
| 이용권 재지급 | 없음 (같은 캠페인, 같은 행) |

무료 테스트 모드로 다시 돌아가려면 `CHECKOUT_MODE`를 지우거나 `free_trial`로 둔다. 잘못된 값이면 새 지급과 새 결제를 모두 막는다.

무료 테스트 모드에서 막는 결제 경로: 주문 생성 API(403 `payments_disabled`), 결제 화면(`/checkout/{orderId}`는 안내만 보이고 결제창과 키를 불러오지 않음), 결제 완료 주소(`/checkout/{orderId}/complete`는 결제사 승인을 요청하지 않고 대기 주문을 `cancelled`로 닫음). 앱 코드에는 테스트용 결제 완료나 구매 우회 경로가 없다 (가짜 결제는 `tests/support/fake-gateway.ts`에만 있다).

## 데이터와 권한

| 대상 | 브라우저(로그인 사용자) | 서버(`service_role`) |
| --- | --- | --- |
| `free_tickets` | 본인 행 읽기 | 읽기·쓰기 |
| `free_ticket_events` | 접근 불가 | 읽기·쓰기 |
| `entitlements.source`, `ticket_id` | 본인 행 읽기 | 함수로만 쓰기 |
| `generation_jobs.ticket_id` | 본인 행 읽기 | 함수로만 쓰기 |

| 함수 | 실행 권한 | 실행 권한 모드 | 이유 |
| --- | --- | --- | --- |
| `is_kakao_member` | `service_role` | `security definer` | `service_role`에 `auth.identities` 읽기 권한이 없다. 참·거짓만 돌려준다 |
| `grant_free_ticket` | `service_role` | `security invoker` | |
| `grant_free_tickets_to_kakao_members` | `service_role` | `security definer` | `auth.users` 전체를 훑는다 |
| `redeem_free_ticket` | `service_role` | `security invoker` | 20261111130000에서 여러 장 이용권에 맞게 바뀜 (캠페인 인자 제거) |
| `restore_free_ticket` | `service_role` | `security invoker` | |

`claim_generation`, `complete_generation`, `create_order`는 기존처럼 `security definer`이고 반환 상태(`cancelled`)와 이용권 완료 기록만 더했다. migration: `supabase/migrations/20261111120000_kakao_only_free_trial.sql`.

## 운영 조회

```sql
-- 캠페인 현황
select status, count(*) from public.free_tickets where campaign_id = 'free-trial-2026-11' group by status;
-- 최근 기록
select kind, ticket_id, user_id, reading_id, detail, created_at from public.free_ticket_events order by id desc limit 50;
```

## QA 체크리스트

자동 검증은 `docs/PROGRESS.md`의 이번 작업 검증표에 결과가 있다. 실제 카카오 로그인과 실제 모델 문장은 사람이 확인한다.

| 항목 | 확인 방법 |
| --- | --- |
| 로그인 화면에 "카카오로 시작하기"만 있음 | 브라우저 테스트 + 실제 화면 |
| 실제 카카오 첫 로그인 → 무료 이용권 1장 | 실제 카카오 계정 (수동) |
| 이메일 동의를 하지 않은 카카오 계정 가입 | 실제 카카오 계정 (수동) |
| 재로그인, 다른 기기 로그인 후 이용권 1장 그대로 | 브라우저 테스트 + 수동 |
| 맛보기까지 이용권 그대로, 사용 후 풀이 연결 | 브라우저 테스트 |
| 생성 실패 → 추가 차감 없이 재시도 | 브라우저 테스트 (가짜 오류) |
| 후속 질문 3회, 보관함, PDF | 브라우저 테스트 + 실제 모델 문장(수동) |
| 결제 주소·API로 결제 시작 불가 | 브라우저 테스트 |
| 결제 모드 전환 시 지급 중단·기존 이용권 유지·카카오만 | 브라우저 테스트 (결제 모드 앱) |

## 실제 사용자 테스트 시작 절차

1. Supabase에 `20261111120000_kakao_only_free_trial.sql`과 `20261111130000_admin_roles_and_settings.sql`을 순서대로 적용한다 (앱 배포 전). 두 번째 파일 적용 직후 풀이 상품 이용은 "관리자만"이다.
   - 본인 계정을 관리자로 지정한다: `select public.set_user_role('<내 회원 ID>', 'admin');`
2. 기존 회원 일괄 지급을 한 번 실행한다: `select public.grant_free_tickets_to_kakao_members('free-trial-2026-11');`
3. 배포 환경의 `CHECKOUT_MODE`를 비워 두거나 `free_trial`로 둔다. 토스 키는 없어도 된다.
4. 이 브랜치를 배포한다.
5. 테스트할 사람에게 링크를 줄 때만 마이 → 관리자 화면에서 "모든 회원"으로 켜고, 끝나면 "관리자만"으로 끈다. 특정 회원에게 한 번 더 받게 하려면 관리자 화면에서 무료 이용권을 1장 준다.
6. 실제 카카오 계정으로 확인한다: 첫 로그인 → 홈의 "무료 이용권 1장" → 상품 → 출생정보 → 맛보기 → "무료 이용권 1장으로 풀이받기" → 메신저 풀이 → 후속 질문 → 보관함·PDF. 로그아웃 후 다시 로그인해도 이용권이 늘지 않는지 본다.
7. 이메일 제공에 동의하지 않은 카카오 계정, 로그인 취소도 한 번씩 확인한다.
8. 문제가 생긴 회원은 위 "운영 조회"로 상태를 보고, 복구할 수 없는 실패만 반환한다.

## 출시 체크리스트 (로그인·이용권 관련)

- [ ] Supabase Providers: Kakao만 켜짐, Kakao "Allow users without an email" 켜짐, Google·Email·Phone·Anonymous 꺼짐
- [ ] Redirect URL에 배포 주소의 `/auth/callback`
- [ ] 배포 환경의 `CHECKOUT_MODE` 값 (무료 테스트 유지 또는 `payment`)
- [ ] 결제 모드라면 토스 키와 `PAYMENTS_ALLOW_LIVE` 결정
- [ ] migration `20261111120000_kakao_only_free_trial.sql`이 앱 배포 전에 적용됨
- [ ] 실제 카카오 로그인 확인 (첫 로그인, 재로그인, 이메일 없는 계정, 취소)
- [ ] 관리자 화면의 "풀이 상품 이용"을 출시 때 "모든 회원"으로 켬 (기본은 관리자만)
- [ ] 관리자 역할 회원 목록 확인 (`select * from public.user_roles where role = 'admin'`)
