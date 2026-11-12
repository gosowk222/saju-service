# OpenAI 운영 안내

서비스의 풀이 생성과 후속 질문은 OpenAI API를 사용한다. 호출은 `src/server/llm/client.ts` 한곳에서만 하고, 설정은 `src/server/llm/config.ts`의 `LLM_SETTINGS` 한곳에서 관리한다.

## 현재 설정

| 항목 | 값 | 위치 |
| --- | --- | --- |
| 개발 기본 모델 | `gpt-5.6-luna` | `config.ts` |
| 호출 모델 | `OPENAI_MODEL` 환경변수 | 서버 환경 |
| API | Responses API, 구조화 출력 (`json_schema`, strict) | `client.ts` |
| 추론 설정 | 최초 풀이 `medium` (2026-11-11 low에서 올림), 질문 정리·후속 답변 `low`. 작업을 시작할 때 고정 | `LLM_SETTINGS.tasks` |
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
| `question-1.3.0` | 현재 질문 정리. 1.2.0에 풀이에 대한 반응(`reaction`: 칭찬·놀림/허세 지적·의심)을 더했다. 반응만 있고 묻는 것이 없으면 캐릭터의 고정 반응 문장으로 답하고 차감하지 않는다 (호출은 질문 정리 1회뿐) |
| `question-1.2.0` | 기록용. 궁금한 점과 후속 질문의 구조화 (분야·의도·선택지·기간·사용자 사실). 1.2.0에서 지쳤다·힘들다 같은 지금 마음 상태도 사용자 사실로 남기게 했다 (출력 형식은 1.1.0과 같다. 1.0.0·1.1.0은 기록용) |
| `reading-3.2.0` / `narration-2.2.0` | 현재 최초 풀이. reading-3.1.0과 같은 지시·입력·출력 형식(캐릭터 묘묘 2.1.0, guide-1.0.0, 추론 medium) 끝에 묘묘 문답 예시 블록(`[캐릭터 문답 예시: 묘묘]`, `src/server/llm/example-block.ts`)을 더했다. 예시는 카탈로그 `myomyo-examples-1.0.0`(27개)에서 선택 정책 `example-select-1.0.0`이 작성 재료(질문 분야·의도, 비중 큰 주제, 사용자가 쓴 말)와 풀이 ID로 3개를 고른다 (긴 예시 하나 이상). 재시도·이어 쓰기도 같은 예시다. 실제로 넣은 ID는 `generation_meta.exampleIds`. 설명 `docs/personas/examples.md` |
| `reading-3.1.0` / `narration-2.2.0` | 3.2.0 이전에 이 버전으로 시작한 작업과 예시 미사용 비교용 (캐릭터 묘묘 2.1.0, 명리 해석 지침 guide-1.0.0, 추론 medium). 지시를 역할별로 나눴다: `[캐릭터: 묘묘]`(`characterBlock`) → `[역할과 우선순위]` → `[명리 해석 지침]`(`READING_GUIDE`, `docs/READING_GUIDE.md`) → 출력 조건. 계산값과 판단은 입력 재료, 말투는 캐릭터, 형식은 출력 조건과 스키마를 따른다. 말투 견본, 말버릇 목록과 횟수, '묘묘다운 순간' 의무, 상품 표현 강도 문구를 뺐다. 입력은 2.9.0과 같고 같은 행동 문장은 처음 나온 해석에만 둔다 (`materialInputV2`). 지시 약 11,000자 (2.9.0과 비슷) |
| `reading-3.0.0` | 쓰지 않음. 되돌린 작업(`refactor/myomyo-persona-rebuild`)에서 쓴 번호라 등록하지 않는다. 그 번호에 고정된 작업은 `prompt_version_unavailable`(재시도 불가)로 정리된다 |
| `reading-2.9.0` / `narration-2.2.0` | 3.1.0 이전에 이 버전으로 시작한 작업만 (캐릭터 묘묘 1.4.0, 추론 medium). 프롬프트 다이어트: 판단에 묶인 비교 예시와 재료 시범을 빼고 주제와 상관없는 말투 견본만 넣는다 (`personaBlockV5`). 2.8.0 결과에서 예시 문장이 같은 판단의 주제에 옮겨 쓰였다 (`docs/READING_QUALITY.md` 22절). 캐릭터 블록 약 5,900자 → 2,500자. 그 밖은 2.8.0과 같다 |
| `reading-2.8.0` / `narration-2.2.0` | 2.9.0 이전에 이 버전으로 시작한 작업만 (캐릭터 묘묘 1.3.0, 추론 medium). 2.7.0 결과가 짧아지고 으스대기·놀리기가 없어서 (`docs/READING_QUALITY.md` 21절) 중심 주제·질문 답은 깊게, 설명 말풍선은 세네 문장까지, 반응 말풍선은 목표와 따로, 주제마다 '묘묘다운 순간', 말버릇은 어울리는 자리에 자연스럽게. 입력·출력 형식은 2.7.0과 같고 규칙은 2.7.0에서 구절만 바꿔 만든다 (`revise`) |
| `reading-2.7.0` / `narration-2.2.0` | 2.8.0 이전에 이 버전으로 시작한 작업만 (캐릭터 묘묘 1.2.0). 2.6.0 결과가 재료 문장을 반말로 옮겨 적은 것이라 (`docs/READING_QUALITY.md` 20절) 재료를 옮겨 적지 않기와 시범, 중복을 덜어 낸 입력(`materialInput`: 같은 근거·이유는 한 번, 공통 주의사항은 `commonCaveats`), light 주제는 핵심 한두 개, 말풍선 한두 문장, 약점은 주제마다 하나 이상. 출력 형식 2.2.0은 주제마다 bubbles 앞에 화면에 나가지 않는 메모 `angle`, 답변 영역 앞에 `focusAngle`을 받는다 (해석기가 버리고 저장하지 않는다) |
| `reading-2.6.0` / `narration-2.1.0` | 2.7.0 이전에 이 버전으로 시작한 작업만 (캐릭터 묘묘 1.1.0). 캐릭터 설정을 지시 맨 앞에 두고 지시를 사실과 판단 / 답할 내용 / 전달 방식 세 층으로 나눴다. 설명 본문에서도 성격이 드러나게 하는 방식과 같은 판단의 비교 예시, 주제마다 정해진 횟수를 채우게 하던 할당 제거, 상황 맥락과 사용자 감정의 구분(입력 `userContext[].from`), 다시 쓸 때 말투를 순화하지 않기. 재료와 출력 형식은 2.5.0과 같다. 주제별로 먼저 보여 주는 생성을 쓴다 (`docs/READING_QUALITY.md` 19절) |
| `reading-2.5.0` / `narration-2.1.0` | 2.6.0 이전에 이 버전으로 시작한 작업만 (캐릭터 묘묘 1.0.0, 상품 3.2.0). 2.4.0에서 존댓말과 '님' 호칭을 가정한 문구를 빼고 말씨·호칭을 캐릭터 설정에 맡겼다. 캐릭터와 판단의 역할 구분, 진지한 순간, 놀림 뒤 설명을 규칙으로 두었다. 입력에 부르는 말(`address`)을 더했다 |
| `reading-2.4.0` / `narration-2.1.0` | 2.5.0 이전에 이 버전으로 시작한 작업만. 2.3.0과 같고 이어서 쓰기 규칙(이미 화면에 보낸 부분은 비워 두고 나머지만 쓰기)을 더했다. 주제가 완성될 때마다 먼저 보여 주는 생성에서 쓴다 (아래 "주제별로 먼저 보여 주기") |
| `reading-2.3.0` / `narration-2.1.0` | 2.4.0 이전에 이 버전으로 시작한 작업만 (상품 3.1.0, 한 번에 받음). 2.2.0에 명리 설명 재료(lore)를 짧게 소개하기, 약점·강점을 선언하지 않고 알아맞히듯 말하기, 어울리는 직업과 업종을 더했다. 입력은 해석마다 lore가 붙는 것만 다르다 |
| `reading-2.2.0` / `narration-2.1.0` | 2.3.0 이전에 이 버전으로 시작한 작업만 (상품 3.0.0). 2.1.0에 가족·친구·지역 주제와 행운 값(place 주제의 값만 옮기기), 재미로 과거를 짐작하는 말투, 건강·투자·미래의 완곡한 표현을 더했다 |
| `reading-2.1.0` / `narration-2.1.0` | 2.2.0 이전에 이미 이 버전으로 시작한 작업을 이어서 생성할 때만. 시작 → 궁금한 점에 대한 답(`focus`) → 주제별 설명 → 마무리. 메신저 말투, 장면을 가정형으로 녹이기('예를 들면'은 풀이 전체에서 한 번까지), 주제마다 약점 하나 이상을 흐리지 않고 말하기. 출력 형식 2.1.0은 말풍선마다 굵게 보일 구절(`highlight`)을 따로 받는다 |
| `reading-2.0.0` / `narration-2.0.0` | 2.1.0 이전에 이미 이 버전으로 시작한 작업을 이어서 생성할 때만 |
| `reading-1.0.0` / `narration-1.0.0` | 작성 재료 1.0.0으로 만든 이전 풀이를 이어서 생성할 때만 |
| `followup-3.2.0` / `followup-output-2.2.0` | 현재 후속 질문. followup-3.1.0 지시 끝에 묘묘 문답 예시 블록을 더했다. 이번 메시지의 질문 분야·의도·반응·직전 대화 유무와 후속 질문 ID로 3개를 고른다 (칭찬·놀림·의심 예시는 그 반응이 담긴 메시지에만). 넣은 ID는 `followups.analysis.examples` |
| `followup-3.1.0` / `followup-output-2.2.0` | 예시 미사용 비교용 (캐릭터 묘묘 2.1.0, guide-1.0.0). reading-3.1.0과 같은 구성. 판단 규칙·입력·출력 형식은 2.9.0과 같다 |
| `mujin-voice-1.1.0` / `mujin-voice-schema-1.0.0` | 무진 Pass 2 (묶음 `mujin-1.1.0`). mujin-voice-1.0.0 지시 끝에 무진 문답 예시 블록을 더했다: 장 주제로 고른 재작성 예시 하나(원문 05·07·09·10을 참조하는 중립 초안 → 원문 답)와 원문 문답 하나. seed는 풀이 ID·장 ID라 장마다 고르게 다르고 재시도는 같다. 넣은 ID는 `reading_sections.meta.examples`. Pass 1(`mujin-draft-1.0.0`)과 질문 정리에는 예시가 없다 |
| `mujin-followup-1.1.0` / `followup-output-2.2.0` | 현재 무진 후속 질문 (묶음 `mujin-1.1.0`). mujin-followup-1.0.0 끝에 무진 문답 예시 블록을 더했다 (질문·반응·이어진 장으로 고른 원문 문답 2~3개). 원문 01·18·21은 넣지 않는다. 넣은 ID는 `followups.analysis.examples` |
| `mujin-followup-1.0.0` / `followup-output-2.2.0` | 무진의 종합 사주 후속 질문, 예시 없음 (캐릭터 무진 1.0.0, guide-1.0.0, 묶음 `mujin-1.0.0`의 `followupPrompt`). `[캐릭터: 무진 도사]`(`characterBlock`) → `[역할과 우선순위]` → `[명리 해석 지침]` → 출력 조건. 묘묘 지시의 반말 전제 문구는 없다. 재료는 질문 분야와 이어지는 장(질문마다 한 장 이상, 모두 4개까지)의 작성 재료와 그 장 최종문 일부(장마다 1,200자까지), 기간 질문이면 첫 유료 생성 때 고정한 기준일의 기간 자료. 질문 정리는 묘묘와 같은 `question-1.3.0`. 횟수·범위·차감·무료 반응·되묻기 정책과 출력 형식은 묘묘와 같다 (`src/server/scroll/followup.ts`, `src/server/llm/mujin-followup-prompt.ts`) |
| `followup-2.9.0` / `followup-output-2.2.0` | 기록용 (캐릭터 묘묘 1.4.0). 2.8.0과 같고 예시·시범 대신 말투 견본 |
| `followup-2.8.0` / `followup-output-2.2.0` | 기록용 (캐릭터 묘묘 1.3.0). 답마다 '묘묘다운 순간', 문단 3~5개(설명 문단은 두세 문장까지) |
| `followup-2.7.0` / `followup-output-2.2.0` | 기록용 (캐릭터 묘묘 1.2.0). 2.6.0에 재료를 옮겨 적지 않기와 시범, 중복을 덜어 낸 입력을 더했다. 출력 형식 2.2.0은 질문마다 refs 앞에 화면에 나가지 않는 메모 `angle`을 받는다 |
| `followup-2.6.0` / `followup-output-2.1.0` | 기록용 (캐릭터 묘묘 1.1.0). 최초 풀이 2.6.0과 같은 세 층 구성. 방금 한 말에 먼저 반응하고 답하기, 칭찬·놀림과 질문이 함께 올 때 짧게 반응한 뒤 본론, 지금의 마음은 이번 메시지(`userContext[].from = "message"`)로만 판단하기. 출력 형식은 2.5.0과 같다 |
| `followup-2.5.0` / `followup-output-2.1.0` | 기록용. 2.4.0에 반응 받기와 이어 쓰기를 더했다. 출력은 질문마다 refs를 text보다 먼저 받아, 근거 연결을 확인한 뒤 문단이 완성될 때마다 먼저 보여 준다 (아래 "후속 답변도 문단마다 먼저 보여 주기") |
| `followup-2.4.0` / `followup-output-2.0.0` | 기록용. 최초 풀이와 같은 캐릭터·호칭, 캐릭터와 판단의 구분, 진지한 순간, 실제 오류의 인정과 정정, 말버릇 횟수 |
| `followup-2.3.0` / `followup-output-2.0.0` | 기록용. 2.2.0에 알아맞히는 말투, 명리 설명 재료 소개, 직업·업종 예시를 더했다 |
| `followup-2.2.0` / `followup-output-2.0.0` | 기록용. 후속 질문. 2.1.0에 과거 짐작 말투, 행운 값의 일관성, 건강·투자·미래의 완곡한 표현을 더했다 |
| `followup-2.1.0` / `followup-output-2.0.0` | 기록용. 후속 질문. 소질문마다 답하거나 되묻기(`clarify`). 답을 빈 줄로 나눈 짧은 문단 2~4개로 쓰고, 화면은 문단마다 말풍선 하나로 보여 준다. `N년 후` 같은 기간 숫자 금지 |
| `followup-2.0.0` | 기록용 (2.1.0 이전 답변) |

굵게 보일 구절은 최초 풀이에서는 `highlight` 필드로 받아 저장 직전에 서버가 문장 안의 `**…**` 표시로 바꾸고, 후속 답변에서는 문장 안에 `**…**`로 받는다. 모델이 구절을 요약해서 적으면 같은 말풍선에서 가장 비슷한 문장을 굵게 만들고, 비슷한 문장이 없으면 표시하지 않는다. 짝이 맞지 않는 표시는 별표를 지운다. 강조 때문에 다시 생성하지 않는다(호출이 늘지 않는다). 경위는 `docs/READING_QUALITY.md` 14절. 생성 기록(`generation_meta`)에는 프롬프트·출력 형식·작성 재료 버전과 함께 실제로 쓴 캐릭터 버전(`personaVersion`)과 풀이 기록을 만들 때의 캐릭터 버전(`planPersonaVersion`)을 남긴다. 2026-11-11 이전 기록의 `personaVersion`은 작성 재료의 값이 덮어써 풀이 기록을 만들 때의 버전이다.

생성을 시작할 때 모델과 프롬프트 버전을 작업에 고정하고, 재시도는 고정된 값을 쓴다. 캐릭터 설정은 고정된 프롬프트 버전으로 고른다 (`personaVersionFor` → `findPersona(id, version)`). 그래서 이전 프롬프트로 시작한 작업을 새 배포 뒤에 이어 써도 그때의 캐릭터 설정을 쓴다 (reading-2.5.0 → 묘묘 1.0.0, reading-2.6.0 → 1.1.0, reading-2.7.0 → 1.2.0, reading-2.8.0 → 1.3.0, reading-2.9.0 → 1.4.0, reading-3.1.0·3.2.0 → 2.1.0). 문답 예시도 같다: 예시를 쓰는 버전과 그 카탈로그·선택 정책은 `example-block.ts`의 `PROMPT_EXAMPLES` 한 표에만 있고, 이전 버전에 고정된 작업은 예시 없이 이어 쓴다. 예시는 고정된 작성 재료와 풀이·장·후속 질문 ID로만 고르므로 재시도와 이어 쓰기에서도 같다. 예시를 쓰는 버전에서 고른 예시가 0개면 조용히 보내지 않고 `examples_unavailable` 오류로 멈춘다 (테스트가 카탈로그·선택·조립을 확인한다). 추론 설정도 작업을 시작할 때 고정된다 (`claim_generation`의 `reasoning_effort`). 출력 형식도 작업에 고정된다 (2.6.0 작업은 narration-2.1.0). 프롬프트나 캐릭터 설정을 바꿀 때는 기존 항목을 고치지 않고 새 버전을 추가한다. 작업의 프롬프트 버전은 저장된 작성 재료의 버전(`PROMPTS_FOR_PLAN`)으로 고른다. 후속 답변은 요청 하나 안에서 끝나므로 현재 프롬프트와 그에 맞는 캐릭터 설정을 쓰고, 버전은 `followups.prompt_version`에 남는다.

## 주제별로 먼저 보여 주기 (reading-2.4.0)

최초 풀이는 여전히 호출 한 번으로 전체를 받는다. 다만 응답을 스트리밍으로 받으면서 인사 → 궁금한 점에 대한 답 → 주제 순서로 완성된 부분을 바로 검사하고, 통과하면 `reading_messages`에 먼저 저장한다. 화면은 생성 중에도 2초마다 상태를 읽어 저장된 말풍선을 보여 주고, 다음 부분을 쓰는 동안 입력 중 표시를 띄운다. 마무리 말풍선은 완료 저장(`complete_generation`) 때 함께 저장한다.

| 상황 | 처리 |
| --- | --- |
| 한 부분이 검사에 걸림 | 그 자리에서 생성을 끊는다 (뒤쪽 글자는 받지 않는다). 다음 호출은 이미 보낸 부분(`alreadySent`)과 문제 목록을 넣어 나머지만 이어 쓰게 한다. 재시도 횟수는 그대로다 (`validationRetries`) |
| 글자를 받다가 연결이 끊김 | 보낸 부분은 두고 이어 쓴다 |
| 요청이 끊겨 다른 요청이 이어받음 | 새 요청은 저장된 메시지를 읽어 그 뒤부터 이어 쓴다. 이전 요청은 저장 직전에 작업 번호를 확인하고 멈춘다 |
| 재시도 횟수를 다 씀 | 보낸 말풍선은 남고, 화면에 다시 시도 버튼이 나온다. 다시 시도하면 남은 부분부터 이어 쓴다 |

- 같은 문장 반복, 말버릇 횟수(1.x로 시작한 작업만. 묘묘 2.1.0은 세지 않는다), 범위 밖 주제, 원국 글자·신살, 근거 연결은 부분마다 검사기(`narrationChecker`)로 확인한다. 검사기는 시도마다 새로 만들고 실제로 보낸 문장만 기억한다. 검사에 걸려 보내지 않은 문장은 다음 시도의 반복·말버릇 기준에 남지 않는다 (2026-11-11 수정. 이전에는 근거 ID만 고친 같은 문장이 '같은 문장 반복'으로 다시 거부되었다). 전체 말풍선 수는 이미 보낸 뒤라 고칠 수 없어 범위를 벗어나면 `checked_issue_count`에만 남긴다.
- 중간에 끊은 호출은 OpenAI가 사용량을 돌려주지 않는다. 그 호출은 '사용량을 모르는 호출'(`calls_without_usage`)로 세고 합계를 불완전(`usage_complete = false`)으로 표시한다. 0으로 채우지 않는다 (아래 "토큰 사용량 기록").
- 데이터베이스 구조는 바꾸지 않았다. 서버 권한으로 `reading_messages`에 행을 먼저 넣고, 상태 조회는 생성 중에도 메시지를 돌려준다.

### 후속 답변도 문단마다 먼저 보여 주기 (followup-2.5.0부터)

후속 답변도 호출 한 번을 스트리밍으로 받는다. 질문마다 근거 연결(refs)을 먼저 확인하고, 문단(화면의 말풍선 하나)이 완성될 때마다 검사해서 `followups.answer`에 그때까지의 답을 저장한다. 상태는 `answering` 그대로이고, 횟수 차감과 완료는 끝에 `complete_followup`이 한 번에 한다. 화면은 답을 기다리는 동안 1.5초마다 상태를 읽어 받은 문단을 보여 주고, 다음 문단을 쓰는 동안 입력 중 표시를 띄운다.

- 검사에 걸리면 생성을 끊고, 보낸 문단은 둔 채 남은 부분만 이어 쓰게 한다 (`alreadySent`). 재시도 횟수는 같다.
- 되묻기(clarify)는 짧아서 끝까지 받은 뒤 한 번에 보낸다.
- 답이 실패하면 차감하지 않고, 그때까지 보인 문단은 화면에서 사라진다 (실패한 질문은 목록에 보이지 않는다).
- 데이터베이스 구조는 바꾸지 않았다. 서버 권한으로 `followups.answer`를 먼저 고친다.
- 화면은 받은 문단을 바로 띄우지 않고, 사람이 입력하듯 말풍선 길이에 맞춰 0.8~2.6초 입력 중 표시를 보여 준 뒤 띄운다 (`src/lib/typing-delay.ts`). 최초 풀이도 같다. 화면을 열 때 이미 있던 답은 바로 보여 준다.
- 질문 없이 반응만 보낸 메시지는 질문 정리 1회만 호출하고 캐릭터의 고정 반응 문장으로 답한다. 풀이마다 처음 한 번만 차감하지 않고, 그다음부터는 질문 1회로 센다 (상품 `freeReactions`).

### 생성 중에 사용자가 떠나거나 연결이 끊길 때

생성은 브라우저가 아니라 서버의 생성 요청 안에서 돈다. 서버는 브라우저 연결이 끊긴 것을 보고 멈추지 않는다.

| 상황 | 결과 | 브라우저 테스트 (`tests/e2e/resume.spec.ts`) |
| --- | --- | --- |
| 생성 중에 창·탭을 닫음, 다른 앱으로 감, 화면이 꺼짐 | 서버가 끝까지 쓴다. 다시 열면 완성된 풀이가 보인다 | 창을 닫고 다시 열기 |
| 사용자 쪽 인터넷이 끊김 | 서버가 계속 쓴다. 화면은 "연결되면 이어서 보여 드릴게요"를 띄우고, 연결이 돌아오면 새로고침 없이 이어서 보여 준다. 새로고침해도 된다 | 오프라인으로 바꿨다가 되돌리기 |
| 서버의 생성 요청 자체가 멈춤 (아래) | 그때까지 저장된 부분은 남는다. 점유 시간(5분)이 지난 뒤 사용자가 그 풀이를 열면 저장된 부분 다음부터 이어 쓴다 | 응답을 멈춰 세우고 점유 시간을 지난 것으로 바꾼 뒤 다시 열기 |

서버의 생성 요청이 멈추는 경우: 서버 프로그램 재시작·종료(개발 서버를 끄거나 새 버전 배포), 서버 장애나 메모리 부족, 호스팅의 요청 시간 제한(`maxDuration` 300초)을 넘김, 브라우저 연결이 끊기면 요청 처리도 끝내는 호스팅 설정. 앞의 둘은 자동으로 다시 시작하지 않으므로 사용자가 풀이를 다시 열어야 이어진다.

## 실제 호출 제한

실제 OpenAI 호출은 Next 서버 안에서만 한다. 사용자가 직접 연 개발 서버(`npm run dev`)와 배포 서버가 여기에 해당한다. `src/server/llm/config.ts`의 `liveCallBlockReason`이 그 밖(개발 스크립트, 테스트)에서 실제 OpenAI 주소로 가는 호출을 요청 전에 막고 `live_call_blocked` 설정 오류로 끝낸다. 스크립트와 테스트는 `OPENAI_BASE_URL`이 가짜 서버를 가리킬 때만 호출한다. Next는 서버 코드를 만들 때 `process.env.NEXT_RUNTIME`을 넣어 주므로 이 값으로 구분한다. Claude Code가 띄운 프로세스(`CLAUDECODE`·`CLAUDE_CODE_ENTRYPOINT` 환경 변수가 있음)는 Next 서버라도 막는다. 그래서 개발 서버는 Claude Code 안(`!npm run dev` 포함)이 아니라 직접 연 터미널에서 실행해야 실제 호출이 된다.

2026-11-10 17:53~18:15(한국 시각)에 찍힌 요청 29회는 에이전트가 실제 키로 실행한 `llm:compare` 6번(4·8·7·6·2·2회)이다. 그 뒤 에이전트는 실제 환경 파일(`.env`)에 접근하지 않고, 브라우저 테스트는 환경 파일 없는 복사본에서 돌린다 (`npm run test:e2e:clean`, CLAUDE.md).

그래서 `npm run llm:check`, `npm run llm:compare`는 실제 키가 있어도 `LIVE_NOT_RUN`을 출력하고 끝난다. 실제 모델 확인은 개발 서버를 직접 열어 화면에서 풀이와 후속 질문을 만들어 보고, 아래 "토큰 사용량 기록"의 SQL(또는 서버 로그 `[generation] done`·`[followup] done`)로 호출 수와 토큰을 확인한다. 에이전트는 실제 호출을 하지 않는다 (AGENTS.md, CLAUDE.md).

같은 입력으로 프롬프트 버전만 바꿔 비교하려면 모델을 부르지 않는 `npm run llm:export`로 지시·입력·출력 형식 파일을 만들어 플레이그라운드에서 실행하고, 결과를 `npm run llm:render`로 말풍선과 검사 결과로 읽는다 (`docs/personas/myomyo-evaluation.md` 0-2절). 무진의 종합 사주는 `--product=mujin-overview`로 장 묶음별 Pass 1·장별 Pass 2 요청을 만들고 초안·최종문 비교 문서를 읽는다 (아래 "무진 모델 비교").

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

## 토큰 사용량 기록 (2026-11-12, migration `20261112120000_generation_usage.sql`)

최초 풀이의 토큰은 생성 시도(attempt)마다 `generation_attempts`에 한 줄로 남고, 풀이별 합계는 `generation_usage` 뷰로 본다. 후속 질문의 토큰은 질문마다 `followups.usage`에 따로 남는다 (최초 풀이와 섞지 않는다).

이전 구조의 문제와 고친 점:

| 이전 | 지금 |
| --- | --- |
| `generation_jobs.usage`에 완료한 시도의 사용량만 남았다. 실패한 시도(검사 실패, 형식 오류, 시간 초과)와 다른 요청이 이어받은 시도의 토큰은 사라졌다 | 시도가 끝나는 방식(완료 `completed`, 실패 `failed`, 이어받음 `handed_over`)과 관계없이 그 시도의 사용량을 `record_generation_attempt`로 남긴다 |
| 응답을 받은 뒤 JSON 해석·형식 검증에 실패하거나 응답이 미완료면 그 호출의 usage를 버렸다 | 응답을 받으면 형식 확인 전에 usage부터 기록한다 (`client.ts`의 `requestLedger`) |
| usage를 받지 못한 호출(중간에 끊은 스트림)을 0으로 더했다 | 모르는 값으로 두고 `calls_without_usage`, `usage_complete = false`로 표시한다 |
| `llm_calls`는 시도를 모두 더하는데 `usage`는 마지막 시도만이라 서로 맞지 않았다 | 시도별 기록의 합이 호출 수와 토큰을 함께 보여 준다 |

집계 규칙 (`src/server/llm/usage.ts`):

- API가 돌려준 usage를 그대로 쓴다. 글자 수로 추정하지 않는다.
- `cached_input_tokens`는 `input_tokens`에 포함된 값이다. 캐시되지 않은 입력은 `input_tokens - cached_input_tokens`.
- `reasoning_tokens`는 `output_tokens`에 포함된 값이다.
- `total_tokens = input_tokens + output_tokens`. 캐시·추론 토큰을 다시 더하지 않는다. 예: input 1000, output 200, cached 600 → total 1200, 캐시되지 않은 입력 400.
- API가 실제로 돌려준 0과 받지 못한 값(null)을 구분한다. 오류 응답(4xx·5xx)으로 생성하지 않은 호출은 호출 수에만 넣는다.
- 한 시도 안의 질문 분석, 본문 작성, 검사 실패 뒤 재작성 호출을 모두 더한다. 새 시도(다시 시도하기, 점유 시간이 지나 이어받기)는 시도 번호가 달라 다른 줄로 남는다. 같은 시도를 다시 기록하면(재전송) 처음 기록을 둔다.
- 저장된 질문 분석을 다시 쓰거나, 끝난 풀이를 다시 열거나 PDF로 내보내면 호출이 없어 기록할 것도 없다.
- 기록이 실패해도(예: migration 미적용) 풀이 생성 결과는 바뀌지 않고 서버 로그에 `[generation] usage not recorded`만 남는다.

`generation_attempts` 칸: `reading_id`, `attempt`, `outcome`, `error_code`, `issues`(마지막 검사에서 걸린 문제의 종류. 생성 문장과 질문 원문은 빼고 남긴다), `model_id`(요청 모델), `actual_model`(응답의 실제 모델), `prompt_version`, `schema_version`, `persona_version`, `reasoning_effort`, `llm_calls`, `calls_without_usage`, `input_tokens`, `cached_input_tokens`, `output_tokens`, `reasoning_tokens`, `total_tokens`(자동 계산), `usage_complete`, `duration_ms`, `created_at`.

권한: 테이블·뷰·함수 모두 서버 전용이다. 브라우저 역할(anon, authenticated)은 본인 것도 읽을 수 없다 (테스트로 확인). 출생정보, 대화, 프롬프트 원문은 넣지 않는다. Supabase 대시보드의 SQL Editor(관리자 권한)에서 아래 SQL로 본다.

```sql
-- 1) 풀이 하나의 최초 풀이 합계 (모든 시도 포함)
select reading_id, status, attempts, recorded_attempts, model_id, actual_model, prompt_version, persona_version, reasoning_effort,
       llm_calls, calls_without_usage, input_tokens, cached_input_tokens, uncached_input_tokens, output_tokens, reasoning_tokens,
       total_tokens, usage_complete
from public.generation_usage
where reading_id = '<풀이 ID>';

-- 2) 시도별 내역 (실패 이유와 검사 문제 종류 포함)
select attempt, outcome, error_code, issues, prompt_version, persona_version, llm_calls, calls_without_usage,
       input_tokens, cached_input_tokens, output_tokens, reasoning_tokens, total_tokens, usage_complete, duration_ms, created_at
from public.generation_attempts
where reading_id = '<풀이 ID>'
order by attempt;

-- 3) 최근 풀이 20개
select u.reading_id, r.created_at, u.status, u.prompt_version, u.attempts, u.llm_calls, u.input_tokens, u.cached_input_tokens,
       u.output_tokens, u.total_tokens, u.usage_complete
from public.generation_usage u join public.readings r on r.id = u.reading_id
order by r.created_at desc
limit 20;

-- 4) 후속 질문 토큰 (질문마다, 최초 풀이와 별도)
select id, status, prompt_version, usage ->> 'inputTokens' as input_tokens, usage ->> 'cachedInputTokens' as cached_input_tokens,
       usage ->> 'outputTokens' as output_tokens, usage ->> 'totalTokens' as total_tokens, usage ->> 'complete' as usage_complete,
       usage ->> 'calls' as llm_calls, analysis -> 'examples' as examples, created_at
from public.followups
where reading_id = '<풀이 ID>'
order by created_at;

-- 5) 문답 예시 전후 비교: 프롬프트 버전별 최초 풀이 시도의 평균 토큰 (reading-3.1.0 예시 없음, reading-3.2.0 예시 있음)
select prompt_version, count(*) as attempts, round(avg(input_tokens)) as avg_input, round(avg(cached_input_tokens)) as avg_cached,
       round(avg(output_tokens)) as avg_output, round(avg(duration_ms)) as avg_ms
from public.generation_attempts
where prompt_version in ('reading-3.1.0', 'reading-3.2.0') and usage_complete
group by prompt_version;

-- 6) 풀이 하나에 실제로 넣은 문답 예시 (카탈로그·정책 버전과 ID)
select generation_meta ->> 'promptVersion' as prompt, generation_meta ->> 'exampleCatalog' as catalog,
       generation_meta ->> 'examplePolicy' as policy, generation_meta -> 'exampleIds' as example_ids
from public.generation_jobs
where reading_id = '<풀이 ID>';
```

문답 예시를 넣으면 지시가 길어져 입력 토큰이 는다. 모델 없이 지시 글자 수만 잰 값 (2026-11-13, 평가 사례): 묘묘 최초 풀이 +1,824~2,692자 (3.1.0 지시 10,730자의 약 17~25%), 묘묘 후속 답변 +1,757~2,414자, 무진 Pass 2 장마다 +1,340~2,547자 (1.0.0 지시 약 4,200자), `docs/personas/examples.md` 4절. 토큰 수는 재지 않았다 (실제 호출 없음). 예시 블록은 지시 맨 끝이라 그 앞의 같은 지시는 입력 캐시에 그대로 걸린다. 실제 증가분은 위 5)와 무진의 `llm_call_usage`(아래)를 프롬프트 버전으로 나눠 비교한다.

이 migration 전에 끝난 풀이는 시도 기록이 없어 `recorded_attempts = 0`, `usage_complete = false`로 보인다. 그 풀이는 `generation_jobs.usage`(완료한 시도 하나의 값. 예전 규칙이라 받지 못한 호출이 0으로 더해졌을 수 있다)만 있다. 없는 값을 0으로 채우거나 다시 생성하지 않는다.

```sql
-- 5) 이전 풀이: 완료한 시도의 사용량만
select reading_id, status, attempts, llm_calls, usage ->> 'inputTokens' as input_tokens, usage ->> 'cachedInputTokens' as cached_input_tokens,
       usage ->> 'outputTokens' as output_tokens, usage ->> 'totalTokens' as total_tokens
from public.generation_jobs
where reading_id = '<풀이 ID>';
```

적용: 이 migration을 먼저 적용하고 새 코드를 띄운다 (`supabase db push` 또는 SQL Editor에서 파일 내용 실행). 순서가 바뀌어도 풀이 생성은 되지만 그동안의 사용량 기록은 남지 않는다. 실제 운영 DB에 적용했는지는 이 문서의 작성 시점에 확인하지 않았다 (`NOT_RUN`).

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

오류가 나도 다른 모델로 바꾸지 않는다. 이용 권한(결제 또는 무료 이용권)은 유지되며 같은 풀이로 추가 차감 없이 재시도한다 (`docs/FREE_TRIAL.md`). 후속 질문의 생성·저장 실패는 차감하지 않는다.

## 저장되는 정보

풀이는 `generation_jobs`에 요청 모델, 응답의 실제 모델, 프롬프트 버전, 출력 형식 버전, 추론 설정, 토큰 사용량(완료한 시도), 처리 시간, 호출 수(모든 시도), 그리고 `generation_meta`(작성 재료·규칙·상품·캐릭터 버전, 질문 분석 버전과 질문 수, 기간 분석 버전과 기간)를 남긴다. 생성 시도마다의 토큰 사용량은 `generation_attempts`에 남는다 (위 "토큰 사용량 기록"). 후속 질문은 답변마다 `followups`에 모델·버전·사용량(실패한 질문도 이미 쓴 사용량은 남긴다)과 질문 분석 요약(`analysis`: 분야, 의도, 범위, 기간)을 남긴다. 서버 로그에는 풀이 ID, 버전, 호출 수, 처리 시간, 토큰 수만 남기고 출생정보, 질문 원문, 답변 원문, 키는 남기지 않는다.

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

## 무진 호출 단위 사용량 (migration `20261113120000_mujin_scroll.sql`)

무진의 종합 사주는 실제 LLM 호출(HTTP 요청) 하나마다 `llm_calls`에 한 줄을 남긴다. 전송 재시도, 검사 실패 뒤 재작성, 중간에 끊은 스트림도 각각 한 줄이다. 칸: 풀이(`reading_id`), 회원, 후속 질문(`followup_id`), 상품, 단계(`tier` free·paid, `step` classify·pass1·pass2·followup), 장·묶음(`unit_id`), 요청·실제 모델, 지시·출력 형식·캐릭터 버전, 추론 설정, 공급자 응답·요청 ID, 결과(`outcome`)와 오류 코드, 시작·끝 시각, 입력·캐시 입력·출력·추론 토큰, 사용량 수신 여부. 집계 뷰는 `llm_call_usage`, 관리자 조회 함수는 `admin_llm_usage(p_limit)`다. 묘묘 최초 풀이는 지금처럼 `generation_attempts`에만 남는다.

- 집계 규칙은 위 "토큰 사용량 기록"과 같다. 캐시 입력은 입력에, 추론 토큰은 출력에 이미 들어 있어 다시 더하지 않는다 (합계 = 입력 + 출력). 받지 못한 값은 null이고 `usage_complete = false`로 표시한다.
- 무진 후속 질문은 질문마다 `followups.usage`(합계)에 남기고, 호출마다 `llm_calls`(step classify·followup, tier paid, `unit_id` 없음, `followup_id`)에도 남긴다. 두 합계는 같아야 한다 (아래 SQL 3). 캐릭터 버전과 묶음, 기간 기준일은 `followups.analysis`의 `personaVersion`, `bundle`, `timingReferenceDate`에 있다.
- 기록 저장은 기다리지 않고 시작하며, 저장에 실패해도 생성과 답변은 바뀌지 않는다 (서버 로그 `[llm-call] not recorded`에 오류 코드만 남는다).
- 무진 실행기는 모든 호출에 `guardStart`를 준다. 프로세스 전역 동시 호출 자리(4)를 기다린 뒤 요청 하나의 남은 시간(270초 예산)이 호출 제한 시간보다 적으면 보내지 않고(`deadline_reached`) 점유를 반납한다. 보내지 않은 호출은 `llm_calls`에 남지 않고 장 시도 수로도 세지 않는다. `guardStart`가 없는 호출(묘묘)은 이전과 같다.
- 무진 후속 질문이 고정 12개월 밖의 기간을 물으면(기간 규칙 분야, 사용자가 기간을 말함, 상품 최대 개월 안) 그 기간만 고정 기준일로 계산해 `reading_analyses`의 `mujin-timing-extra:{분야}:{시작}..{끝}@{기준일}` 키에 저장하고 다시 쓴다. 묘묘의 추가 기간 분석과 같은 정책이다.
- 관리자 화면(`/admin`)의 "무진 생성 사용량"은 `admin_llm_usage(20)`을 서버 권한으로 불러 최근 호출 순 풀이 20개의 단계별 호출 수, 사용량 받은 호출 수, 입력·캐시 입력·출력 토큰, 합계, 완전 여부를 보여 준다. 관리자만 열리고(다른 사람에게는 404), 서버 함수도 관리자 역할을 DB에서 다시 확인한다. 별명·질문 원문·생성 문장은 담지 않는다.
- 생성 시간은 DB에 저장된 시각으로 계산할 수 있는 것만 보여 준다: 무료 첫 칸 완성(무료 단계 시작 `reading_free_runs.started_at` → 첫 무료 최종문 `reading_sections.created_at`), 무료 단계 완료(→ `reading_free_runs.completed_at`), 유료 권한 뒤 첫 장 완성(구매 권한 `entitlements.created_at` → 첫 유료 최종문), 유료 권한 뒤 전체 완료(→ `generation_jobs.completed_at`). 유료 권한 뒤 시간에는 앞의 무료 단계가 끝나기를 기다린 시간도 들어 있다.
- 실제 화면에 보이기까지의 시간은 서버가 알 수 없어 보여 주지 않는다. 화면은 2초마다 저장 상태를 받아 그리므로 최종문 저장 시각보다 그만큼 늦게 보일 수 있고, 브라우저가 그린 시각은 서버로 보내지 않는다. 측정하려면 브라우저 쪽 계측이 따로 필요하다.

```sql
-- 1) 풀이 하나의 단계별 합계 (무료/유료 × 질문 정리/Pass 1/Pass 2/후속 질문)
select tier, step, calls, calls_with_usage, calls_without_usage, input_tokens, cached_input_tokens, uncached_input_tokens,
       output_tokens, reasoning_tokens, total_tokens, usage_complete, started_at, ended_at, models, prompt_versions
from public.llm_call_usage
where reading_id = '<풀이 ID>'
order by tier, step;

-- 2) 호출별 내역 (재시도와 재작성도 각각 한 줄)
select step, tier, unit_id, followup_id, model_requested, model_actual, prompt_version, schema_version, persona_version,
       outcome, error_code, input_tokens, cached_input_tokens, output_tokens, reasoning_tokens, usage_received, started_at, ended_at
from public.llm_calls
where reading_id = '<풀이 ID>'
order by started_at, id;

-- 3) 후속 질문별 호출 합계 (followups.usage에 남긴 합계와 같아야 한다)
select f.id, f.status, f.prompt_version, count(c.id) as calls, sum(c.input_tokens) as input_tokens,
       sum(c.cached_input_tokens) as cached_input_tokens, sum(c.output_tokens) as output_tokens,
       f.usage ->> 'inputTokens' as recorded_input_tokens, f.usage ->> 'outputTokens' as recorded_output_tokens, f.created_at
from public.followups f
left join public.llm_calls c on c.followup_id = f.id
where f.reading_id = '<풀이 ID>'
group by f.id, f.status, f.prompt_version, f.usage, f.created_at
order by f.created_at;

-- 4) 생성 시간 (DB에 저장된 시각으로 계산할 수 있는 것만. 실제 화면 표시 시각은 없다)
select r.id as reading_id,
       (select min(s.created_at) from public.reading_sections s where s.reading_id = r.id and s.tier = 'free') - fr.started_at as free_first_section,
       fr.completed_at - fr.started_at as free_done,
       (select min(s.created_at) from public.reading_sections s where s.reading_id = r.id and s.tier = 'paid') - e.created_at as paid_first_section,
       case when j.status = 'completed' then j.completed_at - e.created_at end as paid_done
from public.readings r
left join public.reading_free_runs fr on fr.reading_id = r.id
left join public.entitlements e on e.reading_id = r.id
left join public.generation_jobs j on j.reading_id = r.id
where r.id = '<풀이 ID>';

-- 5) 관리자 화면과 같은 묶음 (최근 호출 순 풀이 20개의 단계별·풀이별·전체 합계)
select public.admin_llm_usage(20);

-- 6) 문답 예시 전후 비교: Pass 2 호출의 프롬프트 버전별 평균 토큰 (mujin-voice-1.0.0 예시 없음, mujin-voice-1.1.0 예시 있음)
select prompt_version, count(*) as calls, round(avg(input_tokens)) as avg_input, round(avg(cached_input_tokens)) as avg_cached,
       round(avg(output_tokens)) as avg_output
from public.llm_calls
where step = 'pass2' and outcome = 'usage'
group by prompt_version;

-- 7) 장마다 Pass 2 지시에 넣은 문답 예시 ID
select section_id, tier, meta -> 'examples' as examples
from public.reading_sections
where reading_id = '<풀이 ID>'
order by created_at;
```

적용: 이 migration을 앱 배포 전에 먼저 적용한다. 실제 운영 DB에 적용했는지는 이 문서의 작성 시점에 확인하지 않았다 (`NOT_RUN`). 위 SQL은 테스트용 Postgres(PGlite)에 실제 migration을 적용해 실행되는지 확인한다 (`tests/unit/mujin-admin-usage.test.ts`).

## 무진 모델 비교 (`llm:export`·`llm:render`, 모델 호출 없음)

무진의 종합 사주를 실제 모델로 평가할 때 쓴다. 실제 모델 실행은 사용자가 플레이그라운드에서 직접 한다 (비용은 사용자가 낸다). 에이전트는 실행 결과를 확인하지 못했다 (`LIVE_NOT_RUN`). 가짜 결과 파일로 파일 형식과 검사·비교 문서만 확인했다.

- 두 명령은 모델을 부르지 않고 API 키와 OPENAI 환경 변수를 읽지 않는다 (요청 본문의 model 칸은 자리 표시다). `--product`를 주지 않으면(또는 `first-overview`) 묘묘 내보내기·읽기가 예전 그대로 돈다.
- 운영 실행기(`src/server/scroll/runner.ts`)와 같은 함수와 순서로 계획과 요청을 만든다 (`scripts/mujin-llm.ts`): `analyzeMujinBirth` → 질문 정리(사례의 고정 가상 값을 `prepareScrollQuestionsWith`로 판정) → `computeMujinTiming`(기준일 고정) → `buildTimingSections` → `personalizeSections` → `buildDraftRequest`·`buildVoiceRequest`, 마지막 정리는 `buildClosingSection`. 같은 사례·같은 초안이면 운영 실행기가 보내는 지시·입력과 글자까지 같다 (`tests/unit/mujin-llm-scripts.test.ts`가 실행기를 가짜 LLM으로 돌려 비교한다).
- 사례: `scripts/llm-cases.ts`의 `MUJIN_EVALUATION_CASES` (명세 07 4절 대표 평가 입력 8개를 사례 9개로, `docs/personas/mujin-evaluation.md` 2절). 질문 정리는 모델이 필요하므로 사례마다 정리 결과를 가상 값으로 고정해 쓰고, 그 사실을 사례 폴더의 `00-guide.md`와 `comparison.md` 머리말에 적는다.
- 기준일: `--reference=YYYY-MM-DD`(기본 2026-11-12)가 9·10장 기간 재료와 질문 정리의 기준이다. 실행하는 날과 관계없이 같은 계획이 나온다.

```powershell
npm run llm:export '--' --product=mujin-overview --case=heavy-loss    # 요청 파일 (결과를 저장할 때마다 다시 실행)
npm run llm:render '--' --product=mujin-overview --case=heavy-loss    # 저장한 결과로 비교 문서
```

| 순서 | 할 일 | 파일 (`docs/model-comparison/prompts/mujin/<기준일>_<사례>/`, git에 올리지 않음) |
| --- | --- | --- |
| 1 | `llm:export` 실행 | Pass 1 묶음 요청 `p1-<묶음>.instructions.txt`·`.input.json`·`.schema.json`·`.request.json`, 안내 `00-guide.md`(지금 실행할 요청), 궁금한 점이 있으면 참고용 `p0-question.*` |
| 2 | 플레이그라운드에서 Pass 1 묶음 실행: 운영과 같은 모델, 추론 medium, 출력 한도 16,000. 지시에 `*.instructions.txt`, 입력에 `*.input.json`, 출력 형식(JSON schema)에 `*.schema.json` | 결과를 `p1-<묶음>.output.json`으로 저장. 묶음 하나를 저장할 때마다 1을 다시 실행하면 다음 묶음 입력에 앞 묶음의 장면 요약이 운영처럼 들어간다 |
| 3 | `llm:export` 다시 실행 | 장별 Pass 2 요청 `p2-<장>.*`, 2~10장 초안이 모두 있으면 마지막 정리 Pass 1 요청 `p1-paid-closing.*` |
| 4 | Pass 2 실행: 추론 medium, 출력 한도 8,000 | 결과를 `p2-<장>.output.json`으로 저장 |
| 5 | `llm:render` 실행 | `comparison.md`: 장마다 초안과 최종문을 나란히 놓은 표, 운영 검사(`checkDraftSection`, `checkVoiceSection`) 문제 목록, 장별 글자 수와 편집 목표(실패 기준 아님), 평가 기록 표 |

확인할 항목은 명세 07 4절의 무진 품질 평가 항목 9개다 (`docs/personas/mujin-evaluation.md` 1절, 초안과 최종문의 보존 항목은 3절). 검사 통과는 형식·근거·숫자 확인일 뿐 문체 품질 판정이 아니다.

운영과 다른 점: 질문 정리는 고정 가상 값, 기준일은 하나로 고정, Pass 1은 스트림 대신 한 번에 받음, 앞 묶음 결과를 저장하지 않고 실행하면 장면 요약(usedScenes)이 비어 있음, 검사에 걸린 장의 다시 쓰기 요청은 만들지 않음 (비교를 위해 그 초안의 Pass 2 요청은 만든다). 자세한 순서는 `docs/personas/mujin-evaluation.md` 3절 '모델 없이 파일 만들기'.
