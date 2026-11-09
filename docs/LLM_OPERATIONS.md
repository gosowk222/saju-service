# OpenAI 운영 안내

서비스의 풀이 생성과 후속 질문은 OpenAI API를 사용한다. 호출은 `src/server/llm/client.ts` 한곳에서만 한다.

## 현재 설정

| 항목 | 값 | 위치 |
| --- | --- | --- |
| 개발 기본 모델 | `gpt-5.6-luna` | `src/server/llm/config.ts` |
| 호출 모델 | `OPENAI_MODEL` 환경변수 | 서버 환경 |
| API | Responses API, 구조화 출력 (`json_schema`, strict) | `client.ts` |
| 추론 설정 | `reasoning.effort = low` | `LLM_SETTINGS` |
| 출력 토큰 한도 | 풀이 9000, 후속 질문 2500 (추론 토큰 포함) | `LLM_SETTINGS` |
| 요청 제한 시간 | 120초 | `LLM_SETTINGS` |
| 네트워크·일시 오류 재시도 | 2회 | `LLM_SETTINGS` |
| 검사 실패 재생성 | 1회 | `LLM_SETTINGS` |
| 풀이당 실행 횟수 상한 | 4회 | `LLM_SETTINGS` |
| 인스턴스당 동시 호출 | 4개 | `LLM_SETTINGS` |

`temperature`, `top_p`는 보내지 않는다. 두 모델의 공식 문서에서 지원 여부를 확인하지 못했고, 이 서비스에 필요하지도 않다.

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
| `timeout`, `connection`, `server_error` | 일시 오류 | 자동 재시도 후 실패 기록 |
| `refused`, `incomplete`, `empty_response`, `invalid_output` | 응답 이상 | 실패 기록 |
| `validation_failed` | 앱의 내용 검사 실패 | 1회 재생성 후 실패 기록 |

오류가 나도 다른 모델로 바꾸지 않는다. 결제는 유지되며 같은 주문으로 재시도한다.

## 저장되는 정보

풀이는 `generation_jobs`에 요청 모델, 응답의 실제 모델, 프롬프트 버전, 출력 형식 버전, 추론 설정, 토큰 사용량, 처리 시간, 호출 수를 남긴다. 상품·규칙 버전은 `readings`에 있다. 후속 질문은 답변마다 `followups`에 따로 남긴다.

생성을 시작할 때 모델과 프롬프트 버전을 작업에 고정하고, 재시도는 고정된 값을 쓴다. 프롬프트를 바꿀 때는 `prompts.ts`의 기존 항목을 고치지 않고 새 버전을 추가한다.

저장된 풀이는 모델을 바꿔도 다시 생성하거나 덮어쓰지 않는다.

## 출시 전 gpt-6-luna 전환 절차

코드 수정 없이 환경변수만 바꾼다.

1. 권한 확인: `npm run llm:check -- gpt-6-luna`
2. 비교 실행: `npm run llm:compare` (가상 사례 6개, 실제 비용 발생)
3. `docs/model-comparison/<날짜>.md`의 본문을 읽고 체크리스트를 채운다.
4. 문제가 없으면 운영 환경의 `OPENAI_MODEL=gpt-6-luna`로 바꾸고 재배포한다.
5. 문제가 생기면 `OPENAI_MODEL=gpt-5.6-luna`로 되돌리고 재배포한다.

`NODE_ENV=production`이라는 이유로 모델이 바뀌지 않는다. 운영에서 `OPENAI_MODEL`이 비어 있으면 임의의 모델을 쓰지 않고 설정 오류로 처리한다.
