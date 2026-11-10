# OpenAI 운영 안내

서비스의 풀이 생성과 후속 질문은 OpenAI API를 사용한다. 호출은 `src/server/llm/client.ts` 한곳에서만 하고, 설정은 `src/server/llm/config.ts`의 `LLM_SETTINGS` 한곳에서 관리한다.

## 현재 설정

| 항목 | 값 | 위치 |
| --- | --- | --- |
| 개발 기본 모델 | `gpt-5.6-luna` | `config.ts` |
| 호출 모델 | `OPENAI_MODEL` 환경변수 | 서버 환경 |
| API | Responses API, 구조화 출력 (`json_schema`, strict) | `client.ts` |
| 추론 설정 | `reasoning.effort = low` (작업별로 설정) | `LLM_SETTINGS.tasks` |
| 출력 토큰 한도 (추론 포함) | 질문 정리 2,000 · 최초 풀이 24,000 · 후속 답변 6,000 | `LLM_SETTINGS.tasks` |
| 요청 제한 시간 | 질문 정리 30초 · 최초 풀이 200초 · 후속 답변 90초 | `LLM_SETTINGS.tasks` |
| 요청 전체 예산 | 생성 280초 (route `maxDuration` 300초) · 후속 질문 170초 (route 180초) | `generationBudgetMs`, `followupBudgetMs` |
| 네트워크·일시 오류 재시도 | 2회. 남은 예산이 부족하면 재시도하지 않음 | `transportRetries`, `deadlineAt` |
| 검사 실패 재생성 | 1회 (문제 목록을 붙여 다시 요청) | `validationRetries` |
| 풀이당 실행 횟수 상한 | 4회 | `generationMaxAttempts` |
| 인스턴스당 동시 호출 | 4개 | `concurrency` |

`temperature`, `top_p`는 보내지 않는다. 두 모델의 공식 문서에서 지원 여부를 확인하지 못했고, 이 서비스에 필요하지도 않다. 응답이 `incomplete`(출력 한도 도달 등)면 성공으로 저장하지 않고 `incomplete` 오류로 처리한다.

## 프롬프트와 출력 형식 버전

| 버전 | 쓰는 곳 |
| --- | --- |
| `question-1.1.0` | 궁금한 점과 후속 질문의 구조화 (분야·의도·선택지·기간·사용자 사실). 1.1.0에서 가족·친구·지역 분야와 건강·투자 구분을 더했다 (1.0.0은 기록용) |
| `reading-2.2.0` / `narration-2.1.0` | 현재 최초 풀이 (상품 3.0.0). 2.1.0에 가족·친구·지역 주제와 행운 값(place 주제의 값만 옮기기), 재미로 과거를 짐작하는 말투, 건강·투자·미래의 완곡한 표현을 더했다 |
| `reading-2.1.0` / `narration-2.1.0` | 2.2.0 이전에 이미 이 버전으로 시작한 작업을 이어서 생성할 때만. 시작 → 궁금한 점에 대한 답(`focus`) → 주제별 설명 → 마무리. 메신저 말투, 장면을 가정형으로 녹이기('예를 들면'은 풀이 전체에서 한 번까지), 주제마다 약점 하나 이상을 흐리지 않고 말하기. 출력 형식 2.1.0은 말풍선마다 굵게 보일 구절(`highlight`)을 따로 받는다 |
| `reading-2.0.0` / `narration-2.0.0` | 2.1.0 이전에 이미 이 버전으로 시작한 작업을 이어서 생성할 때만 |
| `reading-1.0.0` / `narration-1.0.0` | 작성 재료 1.0.0으로 만든 이전 풀이를 이어서 생성할 때만 |
| `followup-2.2.0` / `followup-output-2.0.0` | 현재 후속 질문. 2.1.0에 과거 짐작 말투, 행운 값의 일관성, 건강·투자·미래의 완곡한 표현을 더했다 |
| `followup-2.1.0` / `followup-output-2.0.0` | 기록용. 후속 질문. 소질문마다 답하거나 되묻기(`clarify`). 답을 빈 줄로 나눈 짧은 문단 2~4개로 쓰고, 화면은 문단마다 말풍선 하나로 보여 준다. `N년 후` 같은 기간 숫자 금지 |
| `followup-2.0.0` | 기록용 (2.1.0 이전 답변) |

굵게 보일 구절은 최초 풀이에서는 `highlight` 필드로 받아 저장 직전에 서버가 문장 안의 `**…**` 표시로 바꾸고, 후속 답변에서는 문장 안에 `**…**`로 받는다. 모델이 구절을 요약해서 적으면 같은 말풍선에서 가장 비슷한 문장을 굵게 만들고, 비슷한 문장이 없으면 표시하지 않는다. 짝이 맞지 않는 표시는 별표를 지운다. 강조 때문에 다시 생성하지 않는다(호출이 늘지 않는다). 경위는 `docs/READING_QUALITY.md` 14절. 생성 기록(`generation_meta.versions`)에는 프롬프트·출력 형식·작성 재료 버전과 함께 실제로 쓴 캐릭터 버전(`personaVersion`)을 남긴다.

생성을 시작할 때 모델과 프롬프트 버전을 작업에 고정하고, 재시도는 고정된 값을 쓴다. 프롬프트를 바꿀 때는 `prompts.ts`의 기존 항목을 고치지 않고 새 버전을 추가한다. 작업의 프롬프트 버전은 저장된 작성 재료의 버전(`PROMPTS_FOR_PLAN`)으로 고른다.

## 실제 호출 제한

실제 OpenAI 호출은 Next 서버 안에서만 한다. 사용자가 직접 연 개발 서버(`npm run dev`)와 배포 서버가 여기에 해당한다. `src/server/llm/config.ts`의 `liveCallBlockReason`이 그 밖(개발 스크립트, 테스트)에서 실제 OpenAI 주소로 가는 호출을 요청 전에 막고 `live_call_blocked` 설정 오류로 끝낸다. 스크립트와 테스트는 `OPENAI_BASE_URL`이 가짜 서버를 가리킬 때만 호출한다. Next는 서버 코드를 만들 때 `process.env.NEXT_RUNTIME`을 넣어 주므로 이 값으로 구분한다. Claude Code가 띄운 프로세스(`CLAUDECODE`·`CLAUDE_CODE_ENTRYPOINT` 환경 변수가 있음)는 Next 서버라도 막는다. 그래서 개발 서버는 Claude Code 안(`!npm run dev` 포함)이 아니라 직접 연 터미널에서 실행해야 실제 호출이 된다.

2026-11-10 17:53~18:15(한국 시각)에 찍힌 요청 29회는 에이전트가 실제 키로 실행한 `llm:compare` 6번(4·8·7·6·2·2회)이다. 그 뒤 에이전트는 실제 환경 파일(`.env`)에 접근하지 않고, 브라우저 테스트는 환경 파일 없는 복사본에서 돌린다 (`npm run test:e2e:clean`, CLAUDE.md).

그래서 `npm run llm:check`, `npm run llm:compare`는 실제 키가 있어도 `LIVE_NOT_RUN`을 출력하고 끝난다. 실제 모델 확인은 개발 서버를 직접 열어 화면에서 풀이와 후속 질문을 만들어 보고, 서버 로그의 `[generation] done`·`[followup] done`으로 호출 수와 토큰을 확인한다. 에이전트는 실제 호출을 하지 않는다 (AGENTS.md, CLAUDE.md).

## 호출 구조와 비용

| 흐름 | 호출 |
| --- | --- |
| 최초 풀이, 궁금한 점 없음 | 풀이 1회 (검사 실패 시 +1) |
| 최초 풀이, 궁금한 점 있음 | 질문 정리 1회 + 풀이 1회 (+1). 질문 정리 결과와 기간 재료는 `reading_analyses`에 저장해 재시도에서 다시 부르지 않는다 |
| 후속 질문 | 질문 정리 1회 + 답변 1회 (+1). 범위 밖이면 질문 정리 1회로 끝난다 |
| PDF, 다시 보기, 보관함 | 호출 없음 (저장된 결과만 사용) |

OpenAI 대시보드의 요청 수는 같은 API 키를 쓰는 모든 실행을 합친 값이다. `npm run llm:compare` 같은 개발 확인도 사례마다 3~8회를 쓴다(2026-11-10에는 앱 4회, 개발 확인 약 130회). 앱이 쓴 호출만 보려면 서버 로그 `[generation] done`·`[followup] done`의 `calls`나 최초 풀이 작업의 `generation_jobs.llm_calls`를 본다. 개발 확인용 키를 따로 쓰면 대시보드에서 나눠 볼 수 있다.

말풍선마다 호출하지 않는다. 고전 자료 전체나 대화 전체를 보내지 않는다. 후속 질문에는 질문 주제의 이전 말풍선 최대 14개와 직전 대화 한 번만 보낸다.

가상 사례 8개를 `gpt-5.6-luna`로 실행한 실측(2026-11-10, `npm run llm:compare`)은 `docs/READING_QUALITY.md`와 `docs/model-comparison/`에 있다.

## 공식 문서 확인 결과 (2026-11-09)

| 항목 | gpt-5.6-luna | gpt-6-luna |
| --- | --- | --- |
| Responses API | 지원 | 지원 |
| 구조화 출력 | 지원 | 지원 |
| `reasoning.effort` | none, low, medium(기본), high, xhigh, max | 동일 |
| 최대 출력 토큰 | 128,000 | 128,000 |
| 입력/출력 가격 (1M 토큰) | $0.2 / $1.2 | $0.1 / $0.5 |

문서에 모델이 있다는 것과 현재 API 프로젝트에서 쓸 수 있다는 것은 다르다. 프로젝트의 접근 권한은 아래 명령으로 확인한다.

```sh
# 실제 호출 제한 때문에 지금은 LIVE_NOT_RUN을 출력한다. 모델 확인은 개발 서버를 열어 풀이 하나를 만들어 본다.
npm run llm:check                  # OPENAI_MODEL 확인
npm run llm:check -- gpt-6-luna    # 특정 모델 확인
```

ChatGPT나 코딩 도구 구독은 API 사용 권한과 별개다.

## 오류 처리

| 코드 | 의미 | 처리 |
| --- | --- | --- |
| `model_not_configured` | 키 또는 모델 설정 없음 | 설정 오류, 다른 모델로 바꾸지 않음 |
| `model_not_found` | 모델 ID 오류 또는 접근 불가 | 설정 오류 |
| `permission_denied` | 프로젝트 권한 없음 | 설정 오류 |
| `auth_failed` | 키 오류 | 설정 오류 |
| `quota_exceeded` | 사용 한도 초과 | 실패 기록, 사용자가 재시도 가능 |
| `rate_limited` | 요청 한도 | 자동 재시도 후 실패 기록 |
| `timeout`, `connection`, `server_error` | 일시 오류 | 남은 예산 안에서 자동 재시도 후 실패 기록 |
| `refused`, `incomplete`, `empty_response`, `invalid_output` | 응답 이상 | 실패 기록 |
| `validation_failed` | 앱의 내용 검사 실패 | 1회 재생성 후 실패 기록 |

오류가 나도 다른 모델로 바꾸지 않는다. 결제는 유지되며 같은 주문으로 재시도한다. 후속 질문의 생성·저장 실패는 차감하지 않는다.

## 저장되는 정보

풀이는 `generation_jobs`에 요청 모델, 응답의 실제 모델, 프롬프트 버전, 출력 형식 버전, 추론 설정, 토큰 사용량, 처리 시간, 호출 수, 그리고 `generation_meta`(작성 재료·규칙·상품·캐릭터 버전, 질문 분석 버전과 질문 수, 기간 분석 버전과 기간)를 남긴다. 후속 질문은 답변마다 `followups`에 모델·버전·사용량과 질문 분석 요약(`analysis`: 분야, 의도, 범위, 기간)을 남긴다. 서버 로그에는 풀이 ID, 버전, 호출 수, 처리 시간, 토큰 수만 남기고 출생정보, 질문 원문, 답변 원문, 키는 남기지 않는다.

저장된 풀이는 모델을 바꿔도 다시 생성하거나 덮어쓰지 않는다.

## 출시 전 gpt-6-luna 전환 절차

코드 수정 없이 환경변수만 바꾼다.

실제 호출 제한(위) 때문에 아래 스크립트는 지금 `LIVE_NOT_RUN`으로 끝난다. 모델을 바꿔 볼 때는 `OPENAI_MODEL`을 바꾼 개발 서버에서 같은 입력으로 풀이를 만들어 비교한다.

1. 권한 확인: `npm run llm:check -- gpt-6-luna`
2. 비교 실행: `npm run llm:compare -- --models=gpt-5.6-luna,gpt-6-luna --date=<기준일>` (가상 사례 8개 × 모델 2개, 실제 비용 발생. `--cases=career-jobseeker,romance-mixed`로 일부만 실행 가능)
3. `docs/model-comparison/<기준일>-<모델>.md`의 본문을 읽고 체크리스트를 채운다. 같은 기준일을 쓰면 기간 분석 재료가 같아 두 모델을 같은 조건으로 비교할 수 있다.
4. 문제가 없으면 운영 환경의 `OPENAI_MODEL=gpt-6-luna`로 바꾸고 재배포한다.
5. 문제가 생기면 `OPENAI_MODEL=gpt-5.6-luna`로 되돌리고 재배포한다.

`NODE_ENV=production`이라는 이유로 모델이 바뀌지 않는다. 운영에서 `OPENAI_MODEL`이 비어 있으면 임의의 모델을 쓰지 않고 설정 오류로 처리한다.
