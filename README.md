# 사주풀이 서비스

캐릭터가 메신저로 사주를 풀어 주는 서비스입니다. 계산은 `sajuengine` 패키지가 하고, 상품 규칙과 설명 생성, 로그인, 이용권과 결제, 화면은 이 앱에 있습니다.

- 로그인: 카카오만 지원합니다. 출시 버전까지 유지하는 정책이며 결제 모드와 관계없습니다 ([docs/AUTH_POLICY.md](docs/AUTH_POLICY.md)).
- 이용 범위: 관리자 화면의 "풀이 상품 이용" 설정으로 관리자만 또는 모든 회원이 이용합니다. 기본은 관리자만입니다 ([docs/ADMIN.md](docs/ADMIN.md)).
- 이용 방식: 지금은 무료 테스트 모드입니다. 카카오 회원에게 무료 이용권 1장을 드리고, 결제 없이 '묘묘의 사주 참견'을 한 번 받습니다 ([docs/FREE_TRIAL.md](docs/FREE_TRIAL.md)).

## 기술 구성

| 영역 | 사용 |
| --- | --- |
| 앱 | Next.js 16 (App Router, Cache Components), React 19, Tailwind 4 |
| 사주 계산 | `sajuengine` (`vendor/sajuengine-0.1.0.tgz`) |
| 인증과 데이터 | Supabase (카카오 로그인, Postgres, RLS) |
| 풀이 생성 | OpenAI Responses API (`OPENAI_MODEL`) |
| 이용권과 결제 | 무료 이용권 (`CHECKOUT_MODE=free_trial`, 기본값), 토스페이먼츠 결제 위젯 (`CHECKOUT_MODE=payment`, 테스트 키) |
| 출생지역 | GeoNames 가공 자료 (CC BY 4.0) |

Node.js 24 이상이 필요합니다.

## 로컬 실행

```sh
npm ci --ignore-scripts
cp .env.example .env.local   # 값을 채웁니다
npm run dev
```

환경변수의 이름과 용도는 [.env.example](.env.example)에 있습니다.

Supabase 대시보드의 Authentication > URL Configuration에서 Redirect URL에 `http://localhost:3000/auth/callback`을 추가해야 합니다. 배포 주소가 생기면 `https://<배포 주소>/auth/callback`도 추가합니다.

Authentication > Sign In / Providers에서는 Kakao만 켜고 "Allow users without an email"을 켭니다. Google, Email, Phone, Anonymous는 끕니다. 현재 프로젝트의 확인 결과는 [docs/AUTH_POLICY.md](docs/AUTH_POLICY.md)에 있습니다.

### 데이터베이스

마이그레이션은 `supabase/migrations/`에 있습니다.

파일 이름 순서대로 적용합니다. 새 migration은 앱을 배포하기 전에 적용해야 합니다.

```sh
supabase db query --linked --project-ref <프로젝트 ref> -f supabase/migrations/20261109120000_first_product_mvp.sql
supabase db query --linked --project-ref <프로젝트 ref> -f supabase/migrations/20261110120000_reading_quality.sql
supabase db query --linked --project-ref <프로젝트 ref> -f supabase/migrations/20261111120000_kakao_only_free_trial.sql
supabase db query --linked --project-ref <프로젝트 ref> -f supabase/migrations/20261111130000_admin_roles_and_settings.sql
```

세 번째 파일(카카오 회원 무료 이용권)을 적용한 뒤 기존 회원에게 이용권을 주려면 `select public.grant_free_tickets_to_kakao_members('free-trial-2026-11');`을 한 번 실행합니다. 여러 번 실행해도 회원당 한 장입니다.

네 번째 파일(역할과 서버 설정)을 적용하면 풀이 상품 이용이 "관리자만"으로 시작합니다. 본인 계정을 `select public.set_user_role('<회원 ID>', 'admin');`로 관리자로 지정한 뒤, 마이 → 관리자 화면에서 바꿉니다.

### 이용 방식 (무료 테스트와 결제)

`CHECKOUT_MODE`를 비워 두면 무료 테스트 모드(`free_trial`)입니다. 토스 키가 없어도 로그인과 무료 풀이가 동작하고, 새 결제는 서버에서 막힙니다. 결제를 다시 열려면 `CHECKOUT_MODE=payment`로 바꾸고 아래 테스트 키를 넣습니다. 자세한 절차는 [docs/FREE_TRIAL.md](docs/FREE_TRIAL.md)에 있습니다.

### 테스트 결제 (결제 모드)

토스페이먼츠 개발자센터의 테스트 키(`test_gck_`, `test_gsk_`)를 `.env.local`에 넣습니다. [결제위젯 연동 문서](https://docs.tosspayments.com/guides/v2/payment-widget/integration)에서 공개 테스트 키를 확인할 수 있습니다. 테스트 키로는 실제로 청구되지 않습니다. `live_` 키는 `PAYMENTS_ALLOW_LIVE=true` 없이는 차단됩니다.

## 검사

```sh
npm run typecheck
npm run lint
npm test             # 단위 테스트와 테스트용 Postgres로 권한 검증
TEST_PG_URL=postgres://postgres:<비밀번호>@127.0.0.1:5432/postgres npm run test:db-concurrency  # 로컬 Postgres로 동시 지급·사용 검증
npm run build
npm run test:e2e     # 브라우저 테스트
npm run test:e2e:clean  # .env 없이 임시 복사본에서 브라우저 테스트 (Claude Code는 이것만 사용)
```

`test:e2e`는 시스템의 Chrome을 사용하고, Supabase, OpenAI, 토스 API를 `tests/support/fake-gateway.ts`로 대신합니다. 같은 빌드로 무료 테스트 모드 앱(3100)과 결제 모드 앱(3101)을 띄워 두 모드를 모두 확인합니다. 실제 OAuth, 실제 결제, 실제 모델 품질을 검증하지 않습니다. Claude Code에서는 `.env`가 있는 폴더의 `test:e2e`가 거부되고, 실제 OpenAI 호출도 막힙니다 (CLAUDE.md).

## 자주 쓰는 명령

| 명령 | 용도 |
| --- | --- |
| `npm run places:import` | GeoNames 자료를 내려받아 지역 목록을 다시 만듭니다 |
| `npm run llm:check -- gpt-6-luna` | 현재 키로 해당 모델을 쓸 수 있는지 확인합니다 |
| `npm run llm:compare` | 가상 사례로 두 모델을 비교합니다. 실제 호출은 개발 서버 안에서만 허용되어 지금은 `LIVE_NOT_RUN`으로 끝납니다 (`docs/LLM_OPERATIONS.md`) |

## 문서

| 문서 | 내용 |
| --- | --- |
| [docs/PROGRESS.md](docs/PROGRESS.md) | 결정 사항과 남은 작업 |
| [docs/AUTH_POLICY.md](docs/AUTH_POLICY.md) | 로그인 정책(카카오만), 회원 판정, Supabase 설정 |
| [docs/FREE_TRIAL.md](docs/FREE_TRIAL.md) | 무료 이용권 정책, 실패와 반환, 결제 모드 전환, QA·출시 체크리스트 |
| [docs/ADMIN.md](docs/ADMIN.md) | 회원 역할(user/admin), 관리자 화면, 풀이 상품 이용 범위, 관리자 이용권 지급 |
| [docs/LLM_OPERATIONS.md](docs/LLM_OPERATIONS.md) | 모델 설정, 오류 처리, gpt-6-luna 전환 |
| [docs/GEONAMES_DATA.md](docs/GEONAMES_DATA.md) | 출생지역 자료의 출처와 기준 |
| [docs/rules/first-overview.md](docs/rules/first-overview.md) | 첫 상품의 해석 규칙 |
| [docs/DESIGN_NOTES.md](docs/DESIGN_NOTES.md) | 디자인 시스템 적용 메모 |
| [docs/SAJUENGINE_SERVICE_GUIDE.md](docs/SAJUENGINE_SERVICE_GUIDE.md) | 엔진 활용 안내 |

## 새 상품 추가

1. `src/domain/products/`에 상품 정의를 추가하고 `index.ts`에 등록합니다.
2. 필요하면 `src/domain/rules/`에 규칙을 추가합니다. 규칙에는 적용·반대·보류 조건과 검토 상태를 남깁니다.
3. 계산 재료가 다르면 `src/server/engine/analyze.ts`의 기능 정의를 추가합니다.

## 출처

- 출생지역: [GeoNames](https://www.geonames.org/), [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)
- PDF 글꼴: Noto Sans KR, SIL Open Font License 1.1 (`assets/fonts/OFL.txt`)
