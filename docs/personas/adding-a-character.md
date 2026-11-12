# 새 캐릭터 추가하기

공통 생성 코드(2-pass 실행기, 예시 블록 조립, 후속 답변, 관리자 집계)를 고치지 않고 새 캐릭터를 더하는 절차다. 실제로 이 절차만으로 연결되는지는 테스트용 캐릭터 '선배'(`tests/unit/persona-registry.test.ts`)와 관리자 집계 테스트의 `test-product`(`tests/unit/admin-generation-usage.test.ts`)가 확인한다. 테스트용 캐릭터는 서비스 레지스트리와 상품 목록에 등록하지 않는다.

## 책임 나누기

| 무엇 | 정하는 것 | 위치 |
| --- | --- | --- |
| 상품 | 주제·질문, 판단 규칙과 작성 재료, 분량, 무료·유료, 가격, 결과 형식(메신저·족자), 기본 캐릭터(`personaId`), 생성 묶음(`generation.bundle`) | `src/domain/products/` |
| 캐릭터(페르소나) | ID와 버전, 이름·정체성·사용자와의 관계, 성격·말하는 방식, 상황별 반응, 호칭(말씨), 모델 없이 보내는 고정 안내(`lines`), 화면 표시(이름, 아바타 그림) | `src/domain/personas/index.ts` |
| 예시 카탈로그 | 캐릭터의 질문–답변 예시와 재작성 예시, 런타임 메타데이터 | `src/domain/personas/examples/` |
| 생성 묶음(생성 정책) | 1-pass·2-pass, 단계별 지시·출력 형식 버전, 캐릭터 설정 버전, 예시 연결(카탈로그·선택 정책·안내 버전), 묶음 나누기, 동시 호출·재시도·시간 예산, 작업 시작 상한, 후속 답변 지시 | `src/server/generation/bundles.ts` (메신저), `src/server/llm/mujin-prompts.ts` (족자) |
| 화면 | 메신저(`src/components/messenger.tsx`)·족자(`src/components/mujin/`) 표현, 저장된 결과 그리기 | 상품의 `format`으로 고른다 |

규칙:
- 상품 ID와 캐릭터 ID는 다른 개념이다. 실행 방식은 작업에 고정된 묶음 ID로만 정하고, 캐릭터 이름이나 말씨로 정하지 않는다.
- `findPersona(id, version)`은 모르는 캐릭터·버전이면 `undefined`다. 다른 캐릭터나 현재 설정으로 조용히 바꾸지 않는다.
- 브라우저 컴포넌트에는 `PersonaFace`(아바타 글자·그림), 이름, 화면용 안내 문장만 넘긴다. 예시 카탈로그와 생성 지시는 서버 모듈(`server-only`)에서만 읽는다.

## 절차 (메신저 상품 예)

1. **캐릭터 정의**: `src/domain/personas/index.ts`에 `Persona`를 만든다 (`id`, `version`, `name`, `role`, `relationship`, `speech`(casual·polite), `tone`, `speaking`, `moments`, `teasing`, `sceneStyle`, `lines`, `avatarGlyph`, 있으면 `avatar`). 설정 안에 완성 대사·말버릇 목록·횟수를 두지 않는다 (AGENTS.md 상품과 문장). 그리고 `PERSONA_REGISTRY`에 `{ current: 새 캐릭터, earlier: [] }`를 더한다.
2. **예시 카탈로그 등록**: `src/domain/personas/examples/<캐릭터>.ts`에 `ExampleCatalog`를 만든다 (버전 예: `<캐릭터>-examples-1.0.0`). 사용자가 준 원문은 원문 파일에 받은 그대로 두고 메타데이터(경로 `voice`·`followup`, 주제, 표현 목적, 길이, 진지함·반응·조건, 전제 줄의 종류)만 따로 붙인다. Pass 2에 쓰려면 원문을 참조하는 재작성 예시(중립 초안 → 같은 뜻의 답변)를 하나 이상 둔다. `examples/index.ts`의 `CATALOGS`에 더한다. 설명은 `docs/personas/examples.md`.
3. **생성 묶음 고르기**: 메신저 2-pass라면 `src/server/generation/bundles.ts`의 `MESSENGER_BUNDLES`에 묶음을 더한다. 지시·출력 형식(`messenger-draft-1.0.0`, `messenger-voice-1.0.0`, `followup-3.3.0`)은 캐릭터 이름이 없어 그대로 쓸 수 있다. 바꾸는 것은 `id`, `personaId`, `personaVersion`, `examples`(경로 voice), `followup.examples`(경로 followup)다. 지원하는 생성 정책은 지금 메신저 2-pass와 족자 2-pass다. 1-pass(`reading-x.y.z`)는 이전 묘묘 작업을 이어 쓰는 용도라 새 캐릭터에 쓰지 않는다.
4. **상품 연결**: 상품 정의에 `personaId: "<캐릭터 ID>"`, `generation: { bundle: "<묶음 ID>" }`를 둔다. 묶음의 `personaId`와 같아야 한다 (`tests/unit/persona-registry.test.ts`의 상품·묶음 검사가 확인한다). `src/domain/products/index.ts`의 `PRODUCTS`에 더한다. 무료 이용권 대상이면 `FREE_TRIAL.productIds`도 본다.
5. **화면 리소스**: 아바타 그림을 `public/images/personas/`에 두고 `avatar`에 연결한다. 상품 포스터·배너는 상품 `art`에 둔다. 디자인 값은 `saju-design-system/`의 토큰을 쓴다.
6. **검증**: `npm run typecheck`, `npm run lint`, `npm test`. 실제 문체는 `npm run llm:export '--' --case=<사례> --task=two-pass`로 예시 사용·미사용 비교 자료를 만들어 사용자가 플레이그라운드에서 확인한다 (`docs/LLM_OPERATIONS.md`). 에이전트는 실제 모델을 부르지 않는다.

관리자 사용량(`admin_generation_usage`)은 상품 ID·캐릭터 ID·묶음 ID를 기록에서 읽으므로 따로 고칠 것이 없다. 이름표는 상품 설정(`PRODUCTS`)과 캐릭터 레지스트리에서 읽는다.

## 버전을 바꿀 때

캐릭터 설정·카탈로그·선택 정책·지시·묶음은 이미 쓴 번호를 다른 내용으로 고치지 않는다. 새 번호를 더하고 상품의 `generation.bundle`을 새 묶음으로 바꾼다. 이미 시작한 생성 작업은 시작할 때 고정한 묶음으로 끝까지 쓴다. 이전 캐릭터 설정이 필요한 묶음이 남아 있으면 그 설정을 `earlier`에 남긴다.
