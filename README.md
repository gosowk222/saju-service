# 사주풀이 서비스

캐릭터가 메신저로 사주를 풀어 주는 서비스입니다. 계산은 `sajuengine` 패키지가 하고, 상품 규칙과 설명 생성, 로그인, 결제, 화면은 이 앱에 있습니다.

## 기술 구성

| 영역 | 사용 |
| --- | --- |
| 앱 | Next.js 16 (App Router, Cache Components), React 19, Tailwind 4 |
| 사주 계산 | `sajuengine` (`vendor/sajuengine-0.1.0.tgz`) |
| 인증과 데이터 | Supabase (카카오·구글 로그인, Postgres, RLS) |
| 풀이 생성 | OpenAI Responses API (`OPENAI_MODEL`) |
| 결제 | 토스페이먼츠 결제 위젯 (테스트 키) |
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

### 데이터베이스

마이그레이션은 `supabase/migrations/`에 있습니다.

파일 이름 순서대로 적용합니다. 두 번째 파일(풀이 품질 고도화)은 앱을 배포하기 전에 적용해야 합니다.

```sh
supabase db query --linked --project-ref <프로젝트 ref> -f supabase/migrations/20261109120000_first_product_mvp.sql
supabase db query --linked --project-ref <프로젝트 ref> -f supabase/migrations/20261110120000_reading_quality.sql
```

### 테스트 결제

토스페이먼츠 개발자센터의 테스트 키(`test_gck_`, `test_gsk_`)를 `.env.local`에 넣습니다. [결제위젯 연동 문서](https://docs.tosspayments.com/guides/v2/payment-widget/integration)에서 공개 테스트 키를 확인할 수 있습니다. 테스트 키로는 실제로 청구되지 않습니다. `live_` 키는 `PAYMENTS_ALLOW_LIVE=true` 없이는 차단됩니다.

## 검사

```sh
npm run typecheck
npm run lint
npm test             # 단위 테스트와 테스트용 Postgres로 권한 검증
npm run build
npm run test:e2e     # 브라우저 테스트
```

`test:e2e`는 시스템의 Chrome을 사용하고, Supabase, OpenAI, 토스 API를 `tests/support/fake-gateway.ts`로 대신합니다. 실제 OAuth, 실제 결제, 실제 모델 품질을 검증하지 않습니다.

## 자주 쓰는 명령

| 명령 | 용도 |
| --- | --- |
| `npm run places:import` | GeoNames 자료를 내려받아 지역 목록을 다시 만듭니다 |
| `npm run llm:check -- gpt-6-luna` | 현재 키로 해당 모델을 쓸 수 있는지 확인합니다 |
| `npm run llm:compare` | 가상 사례로 두 모델을 비교합니다 (실제 비용 발생) |

## 문서

| 문서 | 내용 |
| --- | --- |
| [docs/PROGRESS.md](docs/PROGRESS.md) | 결정 사항과 남은 작업 |
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
