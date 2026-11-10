# 로그인 정책과 회원 구조

기준일 2026-11-11. 출시 버전까지 유지하는 제품 정책이다. 결제 모드(`CHECKOUT_MODE`)와 관계없다.

## 정책

| 항목 | 정책 |
| --- | --- |
| 지원 로그인 | 카카오만 |
| 지원하지 않음 | 구글, 이메일 가입·비밀번호, 이메일 OTP·매직 링크, 애플 등 그 밖의 제공자 |
| 유지 기간 | 출시 버전까지 동일 |
| 결제 모드와의 관계 | 무료 테스트(`free_trial`)와 결제(`payment`) 어느 쪽이든 카카오만. 모드를 바꿔도 로그인 수단은 바뀌지 않는다 |
| 다른 로그인 재도입 | 별도 요구사항이 있을 때만 검토한다 |
| 카카오·구글 계정 연결 | 2026-11-11 요구사항에서 철회. 구현하지 않는다 (아래 "철회 기록") |

카카오로 처음 로그인하면 Supabase Auth가 회원을 만들고, 이후에는 같은 회원으로 다시 로그인한다. 카카오가 이메일을 주지 않는 회원도 가입할 수 있고, 이메일을 따로 입력받는 화면은 없다.

## 앱의 로그인 흐름

| 단계 | 위치 | 하는 일 |
| --- | --- | --- |
| 지원 제공자 목록 | `src/domain/auth/providers.ts` (`LOGIN_PROVIDERS = ["kakao"]`) | 아래 모든 단계가 이 목록 하나를 쓴다 |
| 로그인 버튼 | `src/components/login-buttons.tsx` | "카카오로 시작하기" 하나. 폼으로 `/auth/login`에 보낸다 |
| 로그인 시작 | `POST /auth/login` (`src/app/auth/login/route.ts`) | 앱의 유일한 OAuth 시작 경로. 지원 제공자가 아니면 OAuth를 시작하지 않고 `/login?error=unsupported_provider`로 보낸다. PKCE 확인값은 Supabase 서버 클라이언트가 쿠키에 둔다. `GET`은 405 |
| 콜백 | `GET /auth/callback` | 코드를 세션으로 바꾼 뒤 `getUser()`로 다시 확인한다. 카카오 연결이 없으면 바로 로그아웃하고 `/login?error=kakao_required`. 회원이면 무료 이용권 지급(무료 테스트 모드)을 시도하고 원래 화면으로 돌아간다 |
| 화면 분기 | `src/proxy.ts` | Supabase가 서명한 토큰의 `app_metadata.providers`로 회원 화면 진입만 나눈다. 권한 판단에 쓰지 않는다 |
| 화면 권한 | `requirePageUser` (`src/server/auth.ts`) | `getUser()` 결과의 identities에 카카오가 없으면 `/login?error=kakao_required` |
| API 권한 | `requireApiUser` (`src/server/api.ts`) | 같은 판정. 아니면 403 `kakao_login_required` |
| 로그아웃 | `POST /auth/signout` | 이 기기의 세션만 끝낸다 |

복귀 주소는 `safeNextPath`가 앱 내부 경로로만 제한한다. 로그인 취소(`access_denied`)와 오류는 로그인 화면에 안내한다.

## 회원 판정 기준

- 서버가 Supabase Auth에 다시 물어 받은 사용자(`getUser()`)의 실제 연결(`identities`)에 카카오가 있으면 회원이다.
- 데이터베이스 함수에서는 `public.is_kakao_member(user_id)`가 `auth.identities`로 같은 판정을 한다. 탈퇴(`deleted_at`), 익명, 이용 정지 계정은 회원이 아니다.
- 최초 가입 제공자(`app_metadata.provider`) 하나만 보지 않는다. 처음 구글로 가입했어도 카카오가 연결되어 있으면 회원이다.
- 사용자가 바꿀 수 있는 `user_metadata`, 요청 본문의 `user_id`·`isFree`·`amount` 같은 값은 판정에 쓰지 않는다.
- 소유권과 이용 권한의 기준은 Supabase `user.id`다. 이메일 문자열, 이름, 생년월일이 같다는 이유로 다른 계정의 기록을 합치지 않는다.

## Supabase 설정 (프로젝트 `traayhzfrjlvgmwvhbth`)

2026-11-11 Management API와 공개 설정(`/auth/v1/settings`)으로 확인했다. 이 프로젝트에는 이 앱의 테이블과 Redirect URL만 있어 다른 서비스와 공유하지 않는다.

| 설정 | 값 | 비고 |
| --- | --- | --- |
| Kakao | 켜짐 | 기존 카카오 앱과 키를 그대로 쓴다 |
| Kakao "Allow users without an email" (`external_kakao_email_optional`) | 켜짐 | 2026-11-11 변경. 이메일을 주지 않는 카카오 회원도 가입한다 |
| Google | 꺼짐 | 확인 시점에 이미 꺼져 있었다. `/auth/v1/authorize?provider=google`은 400 `provider is not enabled` |
| Email (가입·비밀번호·OTP·매직 링크) | 꺼짐 | `/auth/v1/otp`는 422 `email_provider_disabled` |
| Phone, Anonymous | 꺼짐 | |
| Manual linking (`security_manual_linking_enabled`) | 꺼짐 | 계정 연결 기능을 쓰지 않는다 |
| Redirect URL | `http://localhost:3000/auth/callback`, `http://127.0.0.1:3000/auth/callback`, `https://saju-service-pi.vercel.app/auth/callback` | |

설정 위치: Supabase 대시보드 Authentication > Sign In / Providers (Kakao, Google, Email), Authentication > URL Configuration (Redirect URL).

구글 제공자를 꺼도 이미 발급된 구글 세션이 자동으로 끝난다고 가정하지 않는다. 그런 세션은 위의 회원 판정에서 걸러져 화면·API·무료 지급·이용권 사용·풀이 생성·결제 경로를 쓰지 못하고 카카오로 다시 로그인해야 한다.

## 기존 계정 점검 결과 (2026-11-11)

| 항목 | 결과 |
| --- | --- |
| 전체 회원 | 1명 |
| 카카오 연결 회원 | 1명 (최초 가입도 카카오) |
| 구글만 연결된 회원 | 0명 |
| 구글 identity가 있는 회원 | 0명 |
| 남아 있는 세션 | 카카오 회원의 세션만 있음 |

구글만 연결된 회원이 없어 이관하거나 지원할 기록이 없다. 앞으로 발견되면 회원과 기록을 지우거나 자동으로 합치지 않고, 영향 범위(풀이·주문 수)를 확인해 지원 절차로 처리한다. 기록은 데이터베이스에 그대로 남는다.

## 철회 기록

- 이전 논의에서 카카오·구글 계정 연결 기능을 검토했으나 2026-11-11 요구사항에서 철회했다. 연결 코드, 연결 메뉴, 연결 API는 만들지 않았고 지금도 없다.
- 2026-11-09~10 기록(`docs/PROGRESS.md`)의 "카카오·구글 로그인"은 당시 사실로 남겨 두되, 현재 정책이 아니다.
