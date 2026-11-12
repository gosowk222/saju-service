# 회원 역할과 관리자 화면

기준일 2026-11-11. migration: `supabase/migrations/20261111130000_admin_roles_and_settings.sql` (앞의 `20261111120000_kakao_only_free_trial.sql` 다음에 적용).

## 역할

| 역할 | 뜻 |
| --- | --- |
| `user` | 일반 회원. `user_roles`에 행이 없으면 `user`다 |
| `admin` | 관리자. 관리자 화면(`/admin`)에 들어가고, 풀이 상품 이용이 "관리자만"일 때도 이용한다 |

역할은 관리자 화면에서 바꾸지 않는다. Supabase SQL Editor(또는 Table Editor의 `user_roles`)에서 바꾼다.

```sql
-- 회원 ID 찾기 (카카오 이름·이메일은 표시용)
select id, email, raw_user_meta_data ->> 'name' as name, created_at from auth.users order by created_at desc;

-- 관리자로 지정 / 일반 회원으로 되돌리기
select public.set_user_role('<회원 ID>', 'admin', '메모(선택)');
select public.set_user_role('<회원 ID>', 'user');

-- 현재 관리자 목록
select user_id, role, note, updated_at from public.user_roles where role = 'admin';
```

관리자도 카카오 로그인 회원이어야 들어올 수 있다 (`docs/AUTH_POLICY.md`). 브라우저는 자기 역할만 읽을 수 있고 바꾸지 못한다.

## 관리자 화면 (`/admin`)

마이 화면의 "관리자 화면" 버튼으로 들어간다 (관리자에게만 보인다). 관리자가 아니면 화면과 API가 404로 보인다.

| 항목 | 내용 |
| --- | --- |
| 풀이 상품 이용 | "관리자만"(기본) 또는 "모든 회원". 바꿀 때 확인 창이 뜬다 |
| 이용 방식 | 현재 `CHECKOUT_MODE` (읽기 전용, 배포 환경 변수로 바꾼다) |
| 회원과 무료 이용권 | 이름·이메일·회원 ID 앞자리로 찾고, 회원마다 "무료 이용권 1장 주기" |
| 역할 바꾸기 | 위 SQL 안내 |
| 생성 사용량 (묘묘·무진) | 2026-11-14 migration `20261114120000_generation_usage_by_product.sql`부터 `admin_generation_usage`로 묘묘와 무진을 함께 본다. 상품 필터(모든 상품·상품마다, `/admin?usage=<상품 ID>`), 나열한 풀이의 상품별·전체 합계, 풀이마다 상품·캐릭터·생성 방식(2-pass·족자 2-pass·기존 단일 생성)·생성 시도(시작 수, 시도 결과)·단계별 호출 수·사용량 받은 호출·오류·미수신·입력·캐시 입력·출력·합계·완전 여부, 메신저는 생성 시작 뒤 첫 말풍선 저장·전체 완료까지 시간. 같은 사용량은 호출 기록과 시도·후속 질문 합계 가운데 하나만 센다. 기록이 없는 시도·후속 질문은 '모름'으로 표시한다. 이전에 묘묘가 보이지 않던 까닭은 조회가 무진이 쓰는 호출 기록(`llm_calls`)만 읽었기 때문이다 (묘묘 기록은 `generation_attempts`·`followups.usage`에 있었다). 조회 SQL은 `docs/LLM_OPERATIONS.md` |
| (이전) 무진 생성 사용량 | 최근 무진 풀이별로 단계(무료·유료 × 질문 분류·Pass 1·Pass 2·후속 질문)마다 호출 수, 사용량을 받은 호출 수, 입력·캐시 입력·출력 토큰과 합계, 사용량 완전 여부. 캐시 입력은 입력에 포함된 값이라 따로 더하지 않는다. DB 시각으로 계산한 생성 시간(무료 첫 칸·무료 완료·권한 뒤 첫 유료 칸·권한 뒤 전체 완료까지)도 함께 보인다. '화면에 실제로 보인 시각'은 서버가 알 수 없어 없다. 별명·질문·생성 문장은 보이지 않는다. 자료: `admin_llm_usage`(migration 20261113120000), 조회 SQL은 `docs/LLM_OPERATIONS.md` |

### 풀이 상품 이용 범위 (`app_settings.readings_open_to_all`)

개발 중 실제 테스트를 할 때 테스트 링크가 퍼져도 아무나 풀이를 받지 못하게 하는 설정이다.

| 설정 | 이용할 수 있는 회원 |
| --- | --- |
| 끔 = 관리자만 (기본값, migration이 넣음) | 관리자 역할 회원만 |
| 켬 = 모든 회원 | 로그인한 카카오 회원 모두 |

설정이 꺼져 있을 때 일반 회원에게 막히는 것과 열려 있는 것:

| 막힘 (서버에서 403 `readings_closed`) | 열림 |
| --- | --- |
| 출생정보 입력·초안 저장, 맛보기 만들기 | 홈, 상품 둘러보기, 로그인 |
| 무료 이용권 사용 | 무료 이용권 지급 (무료 테스트 모드) |
| 결제 주문과 결제 승인 (결제 모드) | 이미 받은 풀이 다시 보기, 보관함, PDF |
| 풀이 생성·재시도, 후속 질문 | 마이 |

판단은 서버가 요청마다 DB에서 다시 읽는다 (`get_reading_access`). 설정을 읽지 못하면 막는 쪽으로 정한다. 바뀐 기록은 `admin_actions`에 남는다.

SQL로 바꿀 수도 있다: `update public.app_settings set value = 'true'::jsonb, updated_at = now() where key = 'readings_open_to_all';`

### 무료 이용권 주기

- 고른 회원에게 관리자 지급 이용권(`free_tickets.source = 'admin'`)을 한 장 만든다. 캠페인 이용권(회원당 한 장)과 따로 쌓인다.
- 카카오 회원에게만 준다.
- 버튼을 두 번 누르거나 요청이 다시 와도 같은 요청 ID는 한 번만 반영된다 (`grant_request_id` 고유).
- 회원은 이용권이 여러 장이면 캠페인 이용권 → 먼저 받은 이용권 순으로 한 장씩 풀이에 쓴다. 사용·실패·재시도·반환 규칙은 캠페인 이용권과 같다 (`docs/FREE_TRIAL.md`).
- 지급 기록은 `free_ticket_events`(`granted`, `detail.source = 'admin'`)와 `admin_actions`(`grant_ticket`)에 남는다.

## 데이터와 권한

| 대상 | 브라우저(로그인 사용자) | 서버(`service_role`) |
| --- | --- | --- |
| `user_roles` | 본인 행 읽기 | 읽기·쓰기 |
| `app_settings` | 접근 불가 | 읽기·쓰기 |
| `admin_actions` | 접근 불가 | 읽기·쓰기 |

| 함수 | 실행 권한 | 실행 권한 모드 | 하는 일 |
| --- | --- | --- | --- |
| `is_admin` | `service_role` | invoker | 관리자 여부 |
| `set_user_role` | `service_role` (SQL Editor) | invoker | 역할 지정 |
| `get_reading_access` | `service_role` | invoker | 역할, 설정, 이용 가능 여부 |
| `set_readings_open_to_all` | `service_role` | invoker | 설정 변경. 함수 안에서 관리자 확인 |
| `admin_grant_free_ticket` | `service_role` | invoker | 이용권 지급. 함수 안에서 관리자·카카오 회원 확인 |
| `admin_list_members` | `service_role` | definer | `auth.users`를 읽어야 해서 소유자 권한. 함수 안에서 관리자 확인 |
| `redeem_free_ticket` | `service_role` | invoker | 이용권이 여러 장일 수 있게 바꿈. 회원 단위 잠금으로 한 번에 하나씩 처리 |

관리자 API: `POST /api/admin/settings` `{ "readingsOpenToAll": true | false }`, `POST /api/admin/tickets` `{ "userId", "requestId", "note"? }`. 서버가 로그인한 카카오 회원의 역할을 DB에서 확인하고, DB 함수가 한 번 더 확인한다.

## 적용 순서

1. `20261111130000_admin_roles_and_settings.sql` 적용. 적용 직후 설정은 "관리자만"이다.
2. 본인 계정을 관리자로 지정: `select public.set_user_role('<내 회원 ID>', 'admin');`
3. 앱 배포 뒤 마이 → 관리자 화면에서 테스트할 때만 "모든 회원"으로 켠다.
