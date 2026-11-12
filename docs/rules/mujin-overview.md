# 무진의 종합 사주 규칙 (mujin-overview 1.0.0)

'무진의 종합 사주'(상품 `mujin-overview`)가 원국 계산값과 판단을 질문에 잇는 방법을 적는다. 명세는 [docs/implementation/mujin/02_DECISION_RULES.md](../implementation/mujin/02_DECISION_RULES.md), 결정 사항은 [00_START_HERE.md](../implementation/mujin/00_START_HERE.md)에 있다.

**검토 상태: 모두 `unreviewed`.** AI가 작성한 초안이며 명리 전문가의 검토를 받지 않았다. 사람이 실제로 검토하기 전에는 `human-reviewed`로 바꾸지 않는다. 기존 수치(25%, 18%, 12% 등)는 현재 구현값이며 통계적 확률이나 감수 완료 기준이 아니다.

| 항목 | 값 |
| --- | --- |
| 원국 작성 계획 | `mujin-plan-1.0.0` (`src/domain/mujin/plan.ts`의 `buildMujinPlan`) |
| 재사용한 판단 규칙 | `first-overview` 3.1.0 (`src/domain/rules/`, [docs/rules/first-overview.md](first-overview.md)) |
| 무진 연결 기준 | `mujin-overview` 1.0.0 (질문 배분·중립 문장·연결 문장, `src/domain/mujin/natal-links.ts`) |
| 의미 태그표 | `mujin-tags-1.0.0` (`src/domain/mujin/tags.ts`) |
| 기초 분석 사실 | `src/domain/mujin/basics.ts` |
| 지금의 나 반영 | `src/domain/mujin/now-context.ts` |
| 9·10장, 마지막 정리, 개인화 | 이 문서 11절 |

무진은 새 `InquiryRule`을 등록하지 않는다. 판단은 기존 `first-overview` 규칙이 내고, 무진 계획은 그 결론을 질문에 배분하고, 명세가 제외한 연결을 빼거나 중립 문장으로 바꾸고, 채택 판단의 의미 태그로 새 질문의 설명을 잇는다(신규 연결). 연결은 서비스 코드이며 새 계산 근거가 아니다.

## 1. 공통

### 재료 종류

| 종류 | 뜻 | 만드는 곳 |
| --- | --- | --- |
| `engine-fact` | 엔진 계산값 (원국 구성, 일간, 계절, 강약, 격국, 오행·십성 분포, 12운성, 십성 배치) | `basics.ts` |
| `judgment` | 기존 규칙의 원국 결론. 상태(candidate·deferred), 규칙 ID·버전, 결론 ID, 변형, 근거 ID를 그대로 보존 | `plan.ts` |
| `derived` | 채택 판단의 의미 태그에서 이은 설명. `parentRefs`로 부모 판단을 가리킨다 | `plan.ts` + `natal-links.ts` |
| `general` | 이 질문에 이을 판단이 없을 때의 일반 점검. "사주 판단이 아닌 일반 점검이다"라는 한계를 붙인다 | `natal-links.ts` |
| `user-fact` | '지금의 나'에서 고른 항목 (`source: now-selection`, `factKind: current`) | `now-context.ts` |

- 재료 ref는 `m1`, `m2` … 계획 전체에서 고유하다. 순서는 공용 사실(`plan.facts`) → 섹션(목차 순서) → 지금의 나(`plan.nowFacts`)다. 지금의 나가 바뀌어도 원국 재료의 ref는 그대로다.
- 질문의 `refs`는 그 섹션의 재료와 `plan.facts`를 가리킨다 (기초 분석 P02는 공용 사실만 쓴다).
- 같은 행동 문장(`action`, `weakness.change`)은 목차 순서에서 처음 나온 재료에만 남긴다 (`materialInputV2`와 같은 원리, 앞뒤 공백만 무시한 정확한 일치). 지운 `action`은 칸을 빼고, 지운 `weakness.change`는 빈 문자열로 둔다. 계획에 저장하므로 장 단위 생성·재시도·재개에서도 입력이 같다.
- 판단 재료는 엔진의 근거 ID(직접·반대·보조)를 `evidence`에 그대로 둔다. 바꾸는 것은 3-3의 강약 근거를 빼는 경우뿐이다(4절).
- 결론의 엔진 상태(candidate·deferred)를 바꾸지 않는다. 문장을 바꾼 판단도 같다.
- 한 질문에 같은 원인(같은 계열의 비중)에서 나온 판단이 둘 이상이면 뒤의 판단에 "근거는 한 번만 설명하고 겹치는 내용은 합쳐 쓴다"는 한계를 붙인다 (`SAME_CAUSE_FAMILY`: 기본 성향 core, 일하는 방식, 직업군, 친구 관계 이미지는 그 변형의 계열, 협력은 어울림·소수 → 비겁, 들어 주는 쪽 → 인성). 예: 6-1의 친구 관계 이미지(비겁)와 협력(어울림), 3-1의 일하는 방식과 직업 예시.
- 엔진 기본 규칙의 결론(`inquiry.natal.topics`)은 기술 문장이라 재료로 쓰지 않는다. 원국 질문은 `temperament`, `strengths`, `career`, `wealth`, `romance`, `social`, `friends` 분야만 묻는다. `family`(가족사 짐작)와 `place`(지역·행운)는 묻지 않는다.

### 질문 상태

| 상태 | 조건 |
| --- | --- |
| `adopted` | 앱 규칙의 candidate 판단이나 채택 판단에서 이은 연결이 있다 |
| `conditional` | 판단은 있으나 조건·한계를 함께 말해야 한다: ① 시각 미상(시주를 뺀 범위의 판단), ② 3-3처럼 비교(compare) 재료가 있다, ③ 그 질문의 candidate 판단이 모두 큰 조건을 가진다 (예외 메모 `counterNote`, 1·2위 계열 동률, 구조 검토 표지가 아닌 반대 근거) |
| `deferred` | 보류(deferred) 판단만 있다. 또는 4-1처럼 시주 미상이라 첫 분기를 확정하지 않았다 |
| `general` | 판단도 연결도 없다. 일반 점검 재료 하나와 "사주 판단처럼 말하지 않는다"는 note |
| `unavailable` | 계산 자료 자체가 없다 (예: 십성 계열 비율·강약·격국이 계산되지 않음). 결론과 일반 점검을 만들지 않는다 |

엔진의 구조 검토 표지(`m03.<분야>.context-review`, review-required)는 거의 모든 원국 결론에 반대 근거로 붙어 있어 이것만으로는 conditional로 보지 않는다 (결론의 한계 문장에는 그대로 있다).

질문 note에는 상태 안내와 명세 4~11절의 질문별 주의를 함께 넣는다 (`QUESTION_GUIDES`, `BASICS_CAUTIONS`). note는 지금의 나에 따라 바뀌지 않는다.

### 시각 미상

- `plan.coverageNotes`와 공용 사실(시주 미상 사실, 각 사실의 한계)에 남긴다. 기존 규칙의 시각 미상 보류(1·2위 차이, 기준값 ±3~5, 관측 부재)는 결론 상태 그대로 둔다.
- 관측된 기둥에서만 안 보이는 계열을 결핍으로 확정하지 않는다: P05 사실("원국에 없다고 확정하지 않습니다"), 4-1 보류, 2-4 보완 행동의 보류 상태 유지.
- 시각 미상에서 판단이 있는 질문은 모두 conditional이다.

### 지금의 나 반영

원국 재료(`facts`, 섹션 `materials`, 질문 `status`·`refs`·`note`)는 지금의 나에 따라 바뀌지 않는다. 바뀌는 것은 다음뿐이다.

| 칸 | 내용 |
| --- | --- |
| `nowFacts` | 고른 항목. 일·학업 상태는 선택지 목록 순서로 정리(선택 순서를 주업 순서로 보지 않음). 선택지 뜻(`context`)과 추정 금지(`avoid`), "이 선택 하나로 나이·소득·건강·가족 구성을 추정하지 않는다"를 caveats로. 관계·가족의 '답하고 싶지 않음', 가족의 '특별히 없음'도 사실로 남긴다. 미응답은 사실이 아니므로 넣지 않는다 |
| `situationNotes` | 일·학업 상태는 그 상태의 맥락이 맞는 장(2·3·4·6·8장)에만, 관계 상태는 5장, 가족 관심은 7장. 미응답·비공개·특별히 없음을 문장으로 구분한다. 두 상태를 고르면 "어느 쪽이 주업인지 정하지 않는다"를 한 번 넣는다. 돌봄 선택은 아픈 가족·자녀로, 독립 선택은 실제 독립 예정·불화로 바꾸지 않는다고 적는다 |
| `weight`, `targetChars` | 관심 장으로 고른 장만 `interest`. 편집 목표를 최소 1.2배·최대 1.25배(50자 단위)로 늘린다. 판단 강도는 바꾸지 않는다 |

## 2. 기초 분석 (P01~P05)

모두 엔진 계산값(`engine-fact`)이다. 이름은 엔진 표기를 따른다 (격국 편관격·월겁격, 강약 신강·약간 신강·중화·약간 신약·신약). 앱의 묘묘 표기(칠살격·양인격, 강한 편 등)와 다르며, 강약은 쉬운 말을 괄호로 함께 둔다.

| 질문 | 재료 | 상태 | 시주 미상 | 주의 (note·caveats) |
| --- | --- | --- | --- | --- |
| P01 원국 구성 | 원국표는 앱이 계산값으로 그리는 표라 글이 없어 섹션 계획에 넣지 않는다. 공용 사실 "원국은 연주 …입니다"(`questionIds` P01·P02)와 일간 사실에 남긴다 | 표시 연결 | 시주 칸 비움 사실 | — |
| P02 원국 전체에서 먼저 읽는 것 | 원국 구성, 일간(+ 전통 비유 `DAY_MASTER_IMAGE`), 계절(월지 → 엔진 `SEASON_OF_BRANCH`), 강약(`assessment.strength`), 격국(`assessment.pattern`, 월지 본기 십성이 격국과 같을 때만 그 근거를 덧붙임) | 재사용·표현 수정 | 강약·비율 사실에 "시주를 뺀 기둥으로 계산" | 엔진이 계산하지 않은 격국·용신을 고르지 않는다. 강약은 체력·건강·손실 감당 능력이 아니다. 용신은 1~8장 판단이 쓰지 않고 가장 적은 오행과 섞일 수 있어 P02 재료에 넣지 않았다 |
| P03 오행 분포 | 공용 사실 "오행 글자 수(단순 개수)"와 "오행 세력 비율(엔진 가중 비율: 천간 1, 지장간 1·0.5·0.3, 월지 지장간 2배)"을 다른 재료로. 섹션 재료: 두 기준의 1위 비교, 글자로 없는 오행(세력 비율은 따로 표시) | 재사용·표시 수정 | 여섯 글자만 셌다는 한계 | 동률은 "토(土)·금(金)이 각 3개로 공동". 가장 적거나 없는 오행을 용신·결핍·질병으로 잇지 않는다. 두 기준은 더하지 않는다 |
| P04 원국 12운성 | 표(`tables.stages`, 원국 항목만)의 일간 기준 줄, 자좌 줄, 나온 단계의 전통적 뜻(`STAGE_MEANING`) | 신규 표시·해설 연결 | 시주 항목 없음 | 기간 항목(대운·세운·월운)을 섞지 않는다. 병·사·절은 "질병·죽음·불운을 뜻하지 않는다"를 뜻 안에 적는다. 12운성 하나로 사건·길흉·성격을 정하지 않는다 (엔진 한계 문장) |
| P05 십성 구조 | 공용 사실 "십성 다섯 계열의 세력 비율"(동률 공동), 섹션 재료: 원국 글자의 십성(지지는 본기), 지장간 십성, 시각 미상이면 "관측되지 않은 계열을 없다고 확정하지 않는다", 완전한 원국에서 0%인 계열. 중심·보조 계열은 1장 판단(core·mix)과 같은 결론을 구조 설명으로만 쓴다(약점·행동·태그 없음) | 재사용·편집 연결 | 관측 부재 사실 | 가족사·사건으로 확장하지 않는다. 조합 판단이 없으면 보조 조합을 세우지 않는다 |

12운성 단계의 전통적 뜻 (서비스가 쉬운 말로 옮긴 초안):

| 단계 | 뜻 |
| --- | --- |
| 장생 | 새로 생겨나 자라기 시작하는 단계 |
| 목욕 | 아직 익숙하지 않은 것을 시험하며 변화가 많은 단계 |
| 관대 | 모양을 갖추고 자리를 잡아 가는 단계 |
| 건록 | 자기 힘으로 서는 단계 |
| 제왕 | 기세가 가장 높은 단계 |
| 쇠 | 정점을 지나 기세를 거두며 노련해지는 단계 |
| 병 | 기세가 누그러지고 속도를 늦추는 단계(질병을 뜻하지 않는다) |
| 사 | 움직임을 멈추고 정리하는 단계(죽음을 뜻하지 않는다) |
| 묘 | 거두어 갈무리하고 저장하는 단계 |
| 절 | 이전 흐름을 끊고 새로 바꾸는 전환 단계(불운을 뜻하지 않는다) |
| 태 | 새 흐름의 씨앗을 품는 단계 |
| 양 | 기르며 준비하는 단계 |

## 3. 1~8장 질문표

상태 칸: **재사용**(기존 조건·예외 그대로), **수정**(필요한 부분만 보존하고 잘못된 확장을 제외), **신규 연결**(기존 판단의 태그를 새 질문에 잇는 서비스 코드). 조건 원문은 `src/domain/rules/first-overview.ts`·`life.ts`의 코드 그대로다. `partial`은 시각 미상(`coverage` ≠ complete), `near(x, t, m)`은 `|x − t| ≤ m`이다.

### 1장 성향과 내면 (무료)

| 질문 | 쓰는 판단 (규칙.key) | 분기·조건 원문 | 상태 | 시주 미상 가드 |
| --- | --- | --- | --- | --- |
| 1-1 | `temperament.core` | `percents[first] >= 25` → `TEMPERAMENT_CORE[first]`, 아니면 `TEMPERAMENT_BALANCED` | 재사용 | 중심: `partial && percents[first] − percents[second] <= 10`. 균형: `partial && near(percents[first], 25, 4)` |
| 1-2 | `temperament.mix` | `percents[second] >= 18` 이고 `TEMPERAMENT_MIX[정렬한 두 계열]`이 있을 때 | 재사용 | `partial && near(percents[second], 18, 4)` |
| 1-3 | `temperament.reaction`, `temperament.condition` | reaction: `STRENGTH_REACTION[strengthBand(strength)]`. condition: 강약이 균형이 아닐 때 `TEMPERAMENT_CONDITION[${band}-${inner}]` (inner = 1위가 비겁·인성) | 수정 (5절의 중립 문장) | 둘 다 `partial && strength ∉ {strong, weak}` |
| 1-4 | `core`·`mix`의 장점·약점, `condition` | 위와 같음 | 재사용·설명 연결 | 위와 같음 |

1위 계열이 동률이면(`core`·`career.style`·`jobs.family`·`friends.image`) 규칙은 이름순으로 한쪽을 고른다. 무진은 그 판단에 "한 계열만의 성향으로 단정하지 않는다"는 한계를 더하고 conditional로 둔다. 2위가 동률이면 `mix`도 같다.

### 2장 재능·적성·배우는 방식

| 질문 | 쓰는 판단 | 분기·조건 원문 | 상태 | 시주 미상 가드 |
| --- | --- | --- | --- | --- |
| 2-1 | `strengths.ability` | `patternJudgment && pattern && PATTERN_ABILITY[pattern]` | 재사용 (근거 문장의 격국 이름을 엔진 표기로) | 보류 없음 (시주 미상 한계 문장) |
| 2-2 | `strengths.environment` | `SHINSAL_ENVIRONMENT_ORDER = [munchang, hakdang, hwagae, jangseong]` 중 원국에 있는 것 `.slice(0, 2)` | 재사용 | 보류 없음. 표지가 없으면 일반 점검 |
| 2-3 | 신규 연결: 능력 태그(`ability.*`)·환경 태그(`env.*`) → 연습 활동 | 7절 | 신규 연결 | — |
| 2-4 | `ability`의 약점 + `strengths.action`(보조) | action: 최약 계열 `<= 12` → `SCARCE_ACTION[scarce]`. 무진은 이 보완 행동이 보완하는 경향(`addresses`)이 채택된 능력의 태그와 겹칠 때만 쓴다 | 재사용·신규 연결 | action: `observedOnlyMissing(scarce)`이면 보류. 보류 상태 그대로 둔다 |

### 3장 직업과 사회생활

| 질문 | 쓰는 판단 | 분기·조건 원문 | 상태 | 시주 미상 가드 |
| --- | --- | --- | --- | --- |
| 3-1 | `career.style`, `career.orientation`, `jobs.family`, `jobs.industry` | style: `percents[first] >= 25`일 때만. orientation: 인성·비겁·식상 중 1위, 최하위 `<= 15`이면 약한 쪽. jobs.family: 1위 계열 직업군. jobs.industry: 용신 오행의 업종 | 재사용·표현 수정 (industry의 '덜 지쳐요' 연결을 뺌) | style: 1·2위 차이 `<= 10`. orientation: 1·2위 차이 `<= 5`. family: `near(top, second, 5)`. industry: `partial`이면 보류 |
| 3-2 | `career.org-fit` | `authority >= 20 && authority >= peer` → 조직형, `peer + output >= 50 && authority <= 12` → 자율형, 그 밖 혼합. 조직형이고 `output >= 30`이면 예외 메모(counterNote) | 재사용 | `partial && (near(authority, 20, 4) ∥ near(authority, 12, 4))` |
| 3-3 | `career.path-compare`(수정) + 신규 연결(역할 명확성·자율성·협업·성과 표현 태그) | 기준: 자율성과 업무 구조(org-fit과 같은 조건), 돈을 버는 방식(재성 `< 10` / 편재 > 정재 / 정재 > 편재), 협업과 책임(비겁 `>= 25`). **'안정성과 변동성'(강약) 기준과 강약 근거 ID를 무진 비교에서 뺀다.** 문장은 결론 없는 비교 안내로 바꾼다. 선택지는 "취업(조직에 들어가는 길)"과 "프리랜서·사업(스스로 일을 꾸리는 길)" | 수정·신규 비교 | 원래 결론 상태(기준이 갈리거나 우세가 2개 미만이면 deferred)를 그대로 둔다. 질문은 항상 conditional |
| 3-4 | 신규 연결: 강점·직업 판단의 태그 → 준비 항목 | 7절 | 신규 연결 | — |

### 4장 재물과 돈 관리

| 질문 | 쓰는 판단 | 분기·조건 원문 | 상태 | 시주 미상 가드 |
| --- | --- | --- | --- | --- |
| 4-1 | `wealth.income` | `wealth < 10 && !observedOnlyMissing(wealth)` → 의미 우선, `output >= 25 && wealth >= 10` → 결과물·기술, `편재 > 정재` → 기회형, `정재 > 0` → 꾸준한 관리형, 그 밖 결론 없음 | 재사용 | `partial && (near(wealth, 10, 3) ∥ near(output, 25, 3))`. **무진 추가:** 결론이 없고 시주 미상에 재성이 관측된 기둥에서만 안 보이면 deferred(첫 분기를 확정하지 않았다는 note) |
| 4-2 | `wealth.keeping` | `peer >= 25` 관계 지출 → `authority >= 20` 지키는 관리 → `resource >= 25` 학습·준비 지출 → 그 밖 구체적 관리 | 재사용·상황 연결 | `partial && (near(peer, 25, 3) ∥ near(authority, 20, 3))` |
| 4-3 | `wealth.relations` | `(peer >= 25 && 겁재 >= 1) ∥ (peer >= 20 && 겁재 >= 2)` → 관계로 새는 돈, `peer < 15` → 혼자 끌어안음, 그 밖 결론 없음(일반 점검) | 재사용 | `partial && near(peer, leaky ? 20 : 15, 3)` |
| 4-4 | `investment.investment` | `peer >= 25 && 겁재 >= 1` 따라 하기 → `편재 > 정재 && (output >= 20 ∥ wealth >= 20)` 기회형 → `resource >= 25` 신중형 → `(정재 > 0 && 정재 >= 편재) ∥ authority >= 20` 안정형 → 그 밖 분산형 | 재사용·표현 수정(관리 습관) | `partial && (near(peer, 25, 3) ∥ near(resource, 25, 3) ∥ near(authority, 20, 3))` |

### 5장 연애와 결혼

| 질문 | 쓰는 판단 | 분기·조건 원문 | 상태 | 시주 미상 가드 |
| --- | --- | --- | --- | --- |
| 5-1 | `romance.attraction` | `output >= 25` 직진, `output <= 12` 은근, 그 밖 조절. 원국 도화(함지)·홍염이 있으면 보조 문장 | 재사용 (근거 문장의 신살 영어 ID를 한국어로) | `partial && (near(output, 25, 3) ∥ near(output, 12, 3))` |
| 5-2 | `romance.comfort` | 일지 본기 십성의 계열 → `ROMANCE_COMFORT` | 재사용·표현 수정 | 보류 없음 (일지는 시주와 무관) |
| 5-3 | `romance.deepening`, `romance.conflict` | deepening: 일지에 걸린 대립·합이 모두 있으면 끌림과 마찰(둘 다 보존), 대립만, 합만, 고신·과숙. conflict: `output >= 25` 말로 풂 → `peer >= 25` 물러서지 않음 → `authority >= 20 ∥ resource >= 25` 참다 정리 → 강함 물러서지 않음 → 약함 참다 정리 | 재사용·충돌 처리 | deepening: 시주를 몰라 시주와 일지 관계는 못 봤다는 한계. conflict: `partial && near(output, 25, 3)` |
| 5-4 | 신규 연결: 자율성·혼자 있는 시간·표현 방식·역할 명확성(+ 재물 판단이 있을 때 돈 쓰는 기준) | 7절 | 신규 연결 | — |

### 6장 인간관계와 귀인

| 질문 | 쓰는 판단 | 분기·조건 원문 | 상태 | 시주 미상 가드 |
| --- | --- | --- | --- | --- |
| 6-1 | `friends.image`, `social.cooperation` | image: 1위 계열. cooperation: `peer >= 25` 어울림 → `peer <= 12` 소수와 깊게 → `resource >= 25` 들어 주는 쪽 → 그 밖 유연 | 재사용·중복 통합 (image는 5절 중립 문장) | image: 1·2위 차이 `<= 10`. cooperation: `partial && (near(peer, 25, 3) ∥ near(peer, 12, 3))` |
| 6-2 | `social.cooperation`, `social.competition`, `social.conflict` | competition: `(겁재 >= 1 && peer >= 25) ∥ (겁재 >= 2 && peer >= 20) ∥ 양인` → 비교 민감, `peer < 15` → 몫을 주장하지 못함. conflict: `상관 > 0 && output >= 25` 직언 → `authority >= 20` 절차 → 약함 회피 → 강함 정면 | 재사용·표현 수정 | competition: `partial && near(peer, rival ? 25 : 15, 3) && !양인`. conflict: 직언·절차만 `near(…, 3)` |
| 6-3 | `social.boundary` + 신규 연결(거절 어려움·혼자 해결함·책임 떠안음) | boundary: `band === weak && (resource >= 20 ∥ peer < 15)` 거절 어려움 → 화개·고신·과숙 혼자 회복 → `authority >= 20` 예의로 거리 | 재사용 + 신규 연결 | boundary 보류 없음 |
| 6-4 | `friends.fortune`(보조) + 신규 연결(혼자 해결함·협업·책임 떠안음) | fortune: 천을·천덕·월덕·태극귀인 중 하나 → 도움 표지, 없고 `peer >= 20` → 쌓는 만큼, 그 밖 소수의 깊은 인연 | 수정·신규 연결 (fortune은 5절 중립 문장) | `!귀인 && partial && near(peer, 20, 3)` |

### 7장 가족과 독립 / 8장 건강·생활 리듬·회복

7-1~7-4, 8-1~8-4는 모두 **신규 연결**이다. 기존 가족 규칙(`first-overview.family`)은 묻지 않는다. 판단은 1~6장의 채택 판단에 붙은 행동 경향 태그에서만 잇는다 (7절). 8장은 강약·오행 판단을 쓰지 않는다 (에너지 규칙 제외, 4절).

## 4. 제외한 기존 분기와 이유

| 규칙·결론 | 처리 | 이유 (명세) |
| --- | --- | --- |
| `first-overview.energy` 전체 (신약 → `conserve` 회복이 느림, 그 밖 → `steady` 회복이 빠름, 오행 35% 이상 → 오행별 리듬) | 무진 재료에서 뺀다 | 강약·오행으로 체력·회복을 판정한다 (P02, 1-3, 8-1) |
| `first-overview.career` path-compare의 '안정성과 변동성' 기준 (신약 → "수입 굴곡을 혼자 버티는 부담", 신강 → "변동을 버티는 힘") | 비교 기준과 그 근거(`m01.assessment.strength`)를 무진 비교에서 뺀다. 결론의 상태·나머지 기준은 그대로 | 강약으로 수입 변동을 견딜 능력을 판정하지 않는다 (3-3) |
| `first-overview.temperament` reaction weak, strong / condition weak-outer, strong-inner | 무진용 중립 문장 (5절) | 신약 → 체력 부족·회복, 신강 → 버티는 힘 연결을 뺀다 (1-3) |
| `first-overview.jobs` industry | 업종 예시 문장으로 바꿈 ("같은 일을 해도 덜 지쳐요"를 뺌) | 용신으로 피로를 판정하지 않는다 (3-1, 8-1) |
| `first-overview.friends` match, drain | 무진 재료에서 뺀다 | 본인의 용신·기신 오행으로 타인의 좋고 나쁨을 판정하지 않는다 (6-4) |
| `first-overview.friends` image, fortune(helped, few) | 무진용 중립 문장 (5절) | 주변 사람이 실제로 그렇게 평가했다고 쓰지 않는다 (6-1). 무진은 경향을 과거 사건으로 바꾸지 않는다 (04 문서 6절) |
| `first-overview.family` 전체 (부모·형제·자녀·성장기) | `family` 분야를 묻지 않는다 | 가족사 추정 문장을 이름만 바꿔 재사용하지 않는다 (7-1) |
| `first-overview.place` 전체 (지역·이동·행운) | `place` 분야를 묻지 않는다 | 무진 1~8장 질문에 없다 |
| `strengths.action` 중 고른 능력과 관련 없는 보완 행동 | 2-4에서 뺀다 | 최약 계열 보완은 능력과 관련될 때만 보조로 (2-4) |
| 명리 설명 줄 중 '월지 본기 십성'(patternLore) | 엔진 격국이 월지 본기로 정해지지 않은 원국에서만 뺀다 | 엔진 격국은 투출 기준이라 월지 본기 십성과 다를 수 있다 |
| 명리 설명 줄 중 '일간의 힘'(strengthLore) | 무진 재료에서 뺀다 | 그 %는 일간을 포함한 오행 비율의 합이라 엔진 강약 비율과 다른 숫자다. 무진은 강약을 엔진 표기로만 말한다 (P02) |
| 엔진 기본 규칙의 보류 결론 (`inquiry.natal.topics`) | 쓰지 않는다 | 기술 문장이다. 앱 규칙 결론이 없으면 그 질문은 일반 점검이나 unavailable이다 |

## 5. 무진용 중립 문장

원래 판단의 조건·근거·상태는 그대로 두고 문장만 바꾼다 (`NEUTRAL_OVERRIDES`, `neutralIndustryText`, `NEUTRAL_COMPARE_TEXT`). 묘묘의 문장표는 고치지 않는다.

| 규칙.key 변형 | 바꾼 칸 | 무진 문장 |
| --- | --- | --- |
| temperament.reaction `weak` | text, weakness | "주변 분위기와 사람의 기대에 영향을 많이 받는 쪽이에요. 혼자 정하기보다 함께 의논할 때 움직이기 쉬워요." / 약점: 남의 기대와 분위기에 끌려가는 것, 거절을 못 해 내 일이 밀림, 들어줄 수 있는 부탁의 기준(시간·횟수)을 미리 정하기 |
| temperament.reaction `strong` | text | "압박이 오면 물러서기보다 정면으로 밀어붙이는 쪽이에요. 막혀도 혼자 끝까지 해 보려는 마음이 강해요." |
| temperament.condition `weak-outer` | text, action | "해야 할 일과 바깥의 요구가 내 기준보다 커지기 쉬운 구조예요. …" / "한 번에 맡는 일의 수를 정하고, 도움을 청할 사람을 먼저 정해 두기" |
| temperament.condition `strong-inner` | action | "추진력을 쓸 곳(프로젝트, 맡은 역할, 표현할 자리)을 일정에 먼저 정해 두기" |
| jobs.industry (용신 오행) | text | "업종 예시로는 …을 꼽아요. 엔진이 계산한 용신 X 기운의 전통 오행 대응으로 고른 예시예요." |
| career.path-compare | text, compare, evidence | "취업·프리랜서·사업 가운데 하나를 사주가 정해 주지는 않아요. 같은 기준을 나란히 두고 …" |
| friends.image (계열 5개) | text | "관계에서는 …쪽에 서기 쉬운 경향이에요." ('친구들 눈에는', '…했을 거예요'를 뺌) |
| friends.fortune `helped`, `few` | text | 귀인 표지는 보조 표지로만, '…있었을 거예요'를 뺌 |

근거 문장(basis)도 무진 표기로 다시 만든다: 2-1 격국 이름(엔진 표기), 6-3 경계의 강약(영어 값 대신 "약간 신약(조금 약한 편)"), 5-1 신살 이름("도화(함지)", "홍염").

## 6. 의미 태그표 (mujin-tags-1.0.0)

태그는 규칙 작성자가 채택 판단에 붙인다. 규칙이 `RuleDetail.variant`에 기록한 변형 키와 (규칙 ID, 결론 key)로만 찾는다. 문장의 단어를 검색하지 않는다. 채택(candidate) 판단에만 태그를 붙이고, 보류 판단과 P05의 구조 설명 사본에는 붙이지 않는다. 표에 없는 변형은 태그가 없고, 그 질문은 연결 없이 일반 점검이 된다.

### 태그 목록 (고정 카탈로그 순서)

| 순서 | 태그 | 이름 |
| --- | --- | --- |
| 1 | `refusal-difficulty` | 거절 어려움 |
| 2 | `solo-solving` | 혼자 해결함 |
| 3 | `responsibility-burden` | 책임 떠안음 |
| 4 | `finish-delay` | 계속 준비함·완성 지연 |
| 5 | `over-expansion` | 과도한 확장 |
| 6 | `autonomy-need` | 자율성 필요 |
| 7 | `role-clarity` | 역할 명확성 |
| 8 | `alone-time` | 혼자 있는 시간 |
| 9 | `over-comparison` | 비교 과함 |
| 10 | `all-urgent` | 모든 상황을 긴급하게 다룸 |
| 11 | `hidden-opinion` | 기준이 불명확하면 의견을 숨김 |
| 12 | `collaboration` | 함께할 때 힘이 남(협업) |
| 13 | `output-expression` | 결과물로 드러냄(성과 표현) |
| 14~16 | `expression-direct` · `expression-reserved` · `expression-adaptive` | 마음을 바로 표현함 · 늦게 드러냄 · 상대에 맞춰 조절함 |
| 17~18 | `relational-spending` · `money-talk-avoid` | 관계·사람에게 쓰는 돈이 커짐 · 돈 이야기를 미룸 |
| 19~28 | `ability.<격국>` | 명세 14절 능력 (아래 표) |
| 29~32 | `env.munchang` · `env.hakdang` · `env.hwagae` · `env.jangseong` | 능력이 드러나는 환경 신살 |

상반된 경향: `autonomy-need`↔`role-clarity`, `solo-solving`↔`collaboration`, `expression-direct`↔`expression-reserved`.

### 명세 14절 능력 태그 (`strengths.ability` 변형 = 격국 ID)

| 격국 | 능력 / 약점 | 연결 활동 (2-3) | 함께 붙는 경향 |
| --- | --- | --- | --- |
| 식신 `eating-god` | 꾸준한 결과물 / 익숙한 방식에 머묾 | 반복 완성과 작은 변형 비교 | — |
| 상관 `hurting-officer` | 문제 발견·개선 / 비판 전달의 마찰 | 문제·대안·내 역할 구분 | — |
| 정재 `direct-wealth` | 일정·자원 관리 / 작은 오차에 과도하게 매임 | 계획과 조정 여지 | — |
| 편재 `indirect-wealth` | 기회 연결 / 넓히다 마무리하지 못함 | 작은 시도를 끝낸 뒤 다음 범위 결정 | 과도한 확장 |
| 정관 `direct-officer` | 기준·신뢰 / 기준이 불명확하면 자기 의견을 숨김 | 기준과 예외에서 자기 판단 설명 | 의견을 숨김, 역할 명확성 |
| 편관 `seven-killings` | 압박 속 판단 / 모든 상황을 긴급하게 다룸 | 긴급한 것과 일반 과제 구분 | 모든 상황을 긴급하게 다룸 |
| 정인 `direct-resource` | 정리·설명 / 준비가 길어짐 | 설명 자료와 작은 실습 연결 | 계속 준비함·완성 지연 |
| 편인 `indirect-resource` | 깊이·독특한 관점 / 완성 전 관심 전환 | 여러 관점을 결과물로 기록 | 계속 준비함·완성 지연 |
| 건록 `month-prosperity` | 스스로 시작 / 도움을 받지 않음 | 자율 과제와 나눌 역할 | 혼자 해결함, 자율성 필요 |
| 월겁 `month-robbery` | 경쟁 속 추진 / 비교가 과해짐 | 자신의 과정과 목표 기록 | 비교 과함 |

### 변형 → 태그

| 규칙.key | 변형 → 태그 |
| --- | --- |
| temperament.core | peer → 자율성 / output → 성과 표현, 완성 지연 / authority → 역할 명확성, 책임 떠안음 / resource → 완성 지연 (wealth, balanced: 없음) |
| temperament.mix | output\|peer → 자율성, 성과 표현 / peer\|wealth → 자율성 / authority\|peer → 자율성, 책임 / peer\|resource → 자율성 / output\|wealth → 성과 표현 / authority\|output → 의견을 숨김 / output\|resource, resource\|wealth → 완성 지연 / authority\|wealth → 책임 / authority\|resource → 역할 명확성 |
| temperament.reaction | strong → 혼자 해결함, 책임 / balanced → 의견을 숨김 / weak → 거절 어려움 |
| temperament.condition | strong-outer → 과도한 확장 / weak-inner → 완성 지연 / weak-outer → 책임 (strong-inner: 없음) |
| strengths.environment | munchang, hakdang → 환경 태그 / hwagae → 환경, 혼자 있는 시간 / jangseong → 환경, 역할 명확성 |
| strengths.action (보완 행동) | 태그 없음. 보완하는 경향(addresses)만: peer → 의견을 숨김 / output → 완성 지연, 의견을 숨김 / wealth → 완성 지연 / authority → 완성 지연, 과도한 확장 / resource → 긴급, 과도한 확장 |
| career.style | peer → 자율성 / output → 성과 표현, 완성 지연 / authority → 역할 명확성 / resource → 완성 지연 (wealth: 없음) |
| career.org-fit | structured → 역할 명확성 / autonomous → 자율성 / mixed → 역할 명확성 + 자율성(혼합) |
| career.orientation | strong:peer → 협업 / strong:output → 성과 표현 (그 밖: 없음) |
| wealth.income | opportunity → 과도한 확장 / detached → 돈 이야기를 미룸 |
| wealth.keeping | spend → 관계에 쓰는 돈 |
| wealth.relations | leaky → 거절 어려움, 관계에 쓰는 돈 / solo → 혼자 해결함 |
| investment.investment | follow → 비교 과함 / opportunity → 과도한 확장 / study → 완성 지연 |
| romance.attraction | direct / subtle / adaptive → 표현 태그 (charm:hamji·hongyeom: 없음) |
| romance.comfort | peer → 자율성 / authority → 역할 명확성 |
| romance.deepening | push-pull, solitude → 혼자 있는 시간 |
| romance.conflict | talk → 바로 표현함 / hold → 혼자 해결함 |
| social.cooperation | crew → 협업 / few → 혼자 해결함, 역할 명확성 / listener → 혼자 해결함 |
| social.competition | rival → 비교 과함 |
| social.boundary | porous → 거절 어려움, 책임 / recharge → 혼자 있는 시간 / formal → 역할 명확성 |
| social.conflict | procedural → 역할 명확성 |
| friends.image | resource → 혼자 해결함 |

변형 키 형식: 표의 키 그대로. 여러 갈래는 '+'로 잇는다 (환경 `munchang+hwagae`, 직업 방향 `strong:resource+weak:output`, 매력 `direct+charm:hamji`). 비교는 `first`·`second`·`even`(어느 쪽이 기준을 더 많이 얻었는지).

## 7. 신규 연결 규칙

| 질문 | 쓰는 태그 (부모로 쓸 수 있는 규칙) | 최대 |
| --- | --- | --- |
| 2-3 | 능력·환경 태그 (strengths) | 3 |
| 3-3 | 역할 명확성·자율성·협업·성과 표현 (temperament, strengths, career) | 4 |
| 3-4 | 완성 지연·과도한 확장·역할 명확성·자율성·의견을 숨김·성과 표현 (strengths, career) | 3 |
| 5-4 | 자율성·역할 명확성·혼자 있는 시간·표현 3종·관계에 쓰는 돈·돈 이야기를 미룸 (temperament, romance, social, wealth) | 4 |
| 6-3 | 거절 어려움·혼자 해결함·책임 떠안음 (모든 원국 판단) | 3 |
| 6-4 | 혼자 해결함·협업·책임 떠안음 (temperament, strengths, social, friends) | 3 |
| 7-1 | 거절 어려움·자율성·역할 명확성 | 3 |
| 7-2 | 거절 어려움·혼자 해결함·책임 떠안음 | 3 |
| 7-3 | 거절 어려움 → 경계 설정, 혼자 해결함 → 도움 요청, 자율성 → 선택권 | 3 |
| 7-4 | 대화 범주로 묶음: 시간(혼자 있는 시간), 돈(관계에 쓰는 돈·돈 이야기), 역할(거절·혼자 해결·책임·역할 명확성), 선택권(자율성) | 4 |
| 8-1 | 거절 어려움·책임 떠안음·완성 지연·과도한 확장·긴급 | 3 |
| 8-2 | 완성 지연 → 종료 기준, 거절 어려움 → 추가 요청, 혼자 해결함 → 분담 | 3 |
| 8-3 | 8-1·8-2에서 고른 원인만, 대응으로 묶음: 범위 협의·종료 기준·역할 분담·우선순위 | 4 |
| 8-4 | 8-1·8-2에서 고른 원인만, 자기 점검 질문 | 4 |

- 선택 순서: 질문에 맞는 태그를 가진 채택 판단 → 고정 카탈로그 순서(묶음 질문은 묶음 순서) → 부모는 목차 순서와 규칙 ID. 진짜 궁금한 점·관심 주제·상황에 따른 순서 조정은 개인화(12절)가 생성 단계에서 한다.
- 같은 원인(태그)은 질문마다 재료 하나로 합치고 부모를 모두 `parentRefs`에 둔다.
- 상반된 경향이 같은 판단(같은 조건)에서 나오면 한 재료로 합쳐 혼합으로 남기고("한쪽으로 정하지 않고 혼합으로 설명"), 다른 판단에서 나오면 따로 두고 "어느 판단의 조건에서 나오는지 나눠 설명"을 붙인다.
- 연결 재료에는 "채택된 판단의 의미 태그에서 이은 설명 연결이며 새 사주 판단이나 계산 근거가 아니다"와 질문별 주의를 붙인다.
- 연결할 판단이 없으면 일반 점검 재료 하나를 두고 질문을 general로 둔다.

## 8. 명세 요약과 실제 코드가 다른 곳

| 명세 요약 | 실제 코드 | 처리 |
| --- | --- | --- |
| 1-1 "시주 미상의 25% 근처 보류" | 중심 분기(25% 이상)에는 25% 근처 보류가 없고, 균형 분기에만 `near(percents[first], 25, 4)` 보류가 있다 | 코드 동작 유지 |
| 4-1 "재성 10% 미만 → 의미 우선" | `wealth < 10 && !observedOnlyMissing(wealth)` 조건이 더 있다 | 코드 동작 유지 + 무진은 그 경우 4-1을 deferred로 둔다 |
| 3-1 "기존 업무 스타일" | 1위 계열이 25% 이상일 때만 결론이 있다. 직업 예시는 jobs 규칙, 능력은 strengths 규칙에 있다 | 코드 동작 유지, 3-1에 style·orientation·jobs를 함께 둔다 |
| 5-3 "일지 관계 표지와 갈등 반응" | 갈등 반응(conflict)은 일지 관계가 아니라 식상·비겁·관성·인성 비중과 강약으로 정한다. 일지 합·충은 deepening에서만 쓴다 | 코드 동작 유지 |
| 2-2 환경 신살 (first-overview 문서 표는 천을귀인·역마 포함) | 코드 순서는 문창·학당·화개·장성 | 코드 동작 유지 |
| 격국 이름 편관·월겁 | 앱 묘묘 표기는 칠살격·양인격 | 무진 재료는 엔진 표기 |
| 강약을 체력·수입 변동과 연결 금지 | 기존 문장에 연결이 있다 | 4·5절 |
| 금전 관계 보류 기준 (first-overview 문서는 '기준 ±3') | leaky면 20을 쓴다(비겁 25 분기로 들어와도) | 코드 동작 유지 |
| 규칙별 버전 (first-overview 문서는 규칙마다 2.0.0·3.0.0) | 모든 규칙의 metadata.version은 3.1.0 | 계획에는 `first-overview` 3.1.0으로 남긴다 |

## 9. 버전과 변경 규칙

- 연결표·중립 문장·연결 문장을 바꾸면 `mujin-overview` 버전을, 태그표를 바꾸면 `TAG_CATALOG_VERSION`을, 계획 형식을 바꾸면 `MUJIN_PLAN_VERSION`을 올린다. 이미 만든 풀이의 계획은 저장된 버전 그대로 쓴다.
- 기존 규칙 파일(`first-overview.ts`, `life.ts`)은 `RuleDetail.variant` 기록만 더했다. 문장·조건·버전·결론·순서는 바꾸지 않았고, 묘묘의 작성 계획(`toStatement`)은 이 칸을 옮기지 않는다.

## 10. 검증 사례

`tests/unit/mujin-plan.test.ts` (엔진을 직접 실행한 가상 출생정보 5개와 가짜 reader):

- 기초 분석과 1~8장 질문 36개가 모두 계획에 있고 상태가 정해져 있다. P01은 원국표라 섹션 계획에 없고 공용 사실로 남는다 (합쳐 37개).
- 같은 원국에 다른 '지금의 나' → 재료·질문 상태가 같고 비중·상황 관점·사용자 사실만 다르다.
- 시각 미상 → coverage·보류 유지, 4-1 보류, 관측 부재를 결핍으로 확정하지 않는다. 보류 판단만 있으면 deferred.
- 오행 글자 수와 세력 비율은 다른 이름의 재료이고 동률은 공동으로 설명한다.
- 원국 12운성 재료에 기간 항목이 없고 병·사·절을 질병·죽음·불운으로 옮기지 않는다.
- 의미 태그는 채택 판단에만, 연결은 같은 태그의 채택 판단을 부모로. 태그표에 없는 변형이면 연결 없이 일반 점검. 혼합·조건별 처리. 2-4 보완 행동의 관련성.
- 가족 미응답·비공개·돌봄 관심에서 기존 가족 규칙 문장이 없다. 일·학업 상태 두 개 → situationNotes 중복·모순 없음, 고른 순서와 무관.
- 강약→체력·회복·수입 변동 감당 문장, 에너지 규칙, 용신으로 사람 고르기, 주변 평가 단정·과거 짐작 문장이 무진 재료에 없다.
- 한 질문에 같은 결론이 두 번 없고, 같은 행동 문장은 처음 나온 재료에만 남는다. 같은 원인의 판단은 근거를 한 번만 설명하라는 한계가 붙는다.
- 엔진 표기(격국·강약·계절) 표가 엔진 공개 값과 같다. 규칙은 변형 키를 `RuleDetail.variant`에 남기고 묘묘 계획에는 들어가지 않는다.

이 테스트는 코드가 문서대로 동작하는지 확인할 뿐, 명리적 타당성을 검증하지 않는다.

## 11. 9·10장, 마지막 정리, 개인화

9·10장, 마지막 정리, 개인화의 규칙이다. 코드:

- `src/domain/mujin/timing-plan.ts`: 9장(9-1~9-4)·10장(10-1~10-4) 작성 계획 `buildTimingSections`, 마지막 정리 `buildClosingSection`
- `src/domain/mujin/personalize.ts`: 질문이 이어질 장 `chaptersForQuestion`, 질문·관심·상황 반영 `personalizeSections`, 9·10장과 함께 쓰는 연결표
- 테스트: `tests/unit/mujin-timing-plan.test.ts`, `tests/unit/mujin-personalize.test.ts` (가짜 계획·기간 재료)

| 항목 | 값 |
| --- | --- |
| 계획 형식 버전 | `mujin-timing-plan-1.0.0`, `mujin-personalize-1.0.0` |
| 서비스 기준 | `mujin-overview.luck-theme` 1.0.0 (대운 활동 주제 대응과 9-4 연결) |
| 재사용한 판단 | 기간 판단 `first-overview.timing` 3.1.0 (월운 결론·근거·버전을 그대로 옮긴다) |
| 검토 상태 | 모두 `unreviewed`. AI가 작성한 초안이며 명리 전문가의 검토를 받지 않았다 |

이 규칙은 계산하지 않는다. 대운·월운과 판단 근거는 엔진과 기간 판단 규칙이 낸 값(유료 생성 때 고정한 `MujinTimingBundle`)을 작성 재료로 옮길 뿐이다. 모든 장은 `weight: standard`로 만들고 비중은 개인화가 정한다.

### 9장 인생의 큰 흐름과 전환점

#### 대운이 없을 때

`bundle.luck.status`가 `unavailable`이면 구간을 임의로 고르지 않는다.

| 이유 | 9-1~9-3 | 9-4 | 재료 |
| --- | --- | --- | --- |
| `hour-unknown` (시각 미상) | unavailable. "태어난 시간을 몰라 대운을 계산하지 않았다. 대운 구간·간지·나이를 만들지 않는다" | general. 활동 주제와 잇지 않고 일반 점검만 짧게 | 없음 |
| `outside-sequence` (기준일이 대운 범위 밖) | unavailable. "현재 대운 구간을 고르지 않았다" | general | 엔진이 준 첫 대운(또는 마지막 대운)만 계산 사실로 남긴다 |
| `engine-unavailable` | unavailable | general | 없음 |

자료가 없는 장은 분량을 채우려 반복하지 않도록 편집 목표를 상품 목표의 3분의 1로 줄인다 (850~1,100 → 283~367자).

#### 대운이 있을 때

| 질문 | 재료 | 상태 |
| --- | --- | --- |
| 9-1 현재 대운 구간 | engine-fact: 엔진 라벨(예: '23세부터 대운 갑자'), 구간(연도 무렵), 기준일, 천간 십성 | 경계가 근사값이면 conditional ("몇 년 무렵"으로만 말하고 날짜·월·오차 범위를 만들지 않는다) |
| 9-2 구간의 활동 주제 | period: 천간 십성 계열 → 중립 활동 주제 (아래 표). `parentRefs`는 9-1 계산 사실, `ruleId` `mujin-overview.luck-theme` | adopted. 십성 자료가 없으면 unavailable |
| 9-3 앞뒤 구간의 차이 | 직전·다음 대운 계산 사실 + 같은 항목(천간 십성·계열·활동 주제)끼리의 비교(derived) | 비교할 구간이 있으면 adopted. 없는 직전·다음 구간은 만들지 않는다 |
| 9-4 현재 상황의 준비 | 활동 주제와 닿는 원국 채택 판단의 연결(derived, 최대 3) + 9-2 활동 주제 + '지금의 나' 사실 | 연결 판단이 있으면 adopted, 없으면 general(활동 설명까지만) |

대운 경계는 엔진 계약상 항상 근사값이다. 대운 이름의 나이와 계산된 시작 시점은 몇 달 어긋날 수 있다는 조건을 함께 둔다. 구간 연도는 상품 시간대(Asia/Seoul) 기준이다.

#### 활동 주제 대응 (9-2)

| 대운 천간 십성 계열 | 활동 주제 | 따로 막는 해석 |
| --- | --- | --- |
| 비겁 | 주도성·동료·경쟁 | 경쟁에서 이기거나 사람과 다투는 10년으로 바꾸지 않는다 |
| 식상 | 표현·제작·공개 | 내놓은 결과물이 성공하는 10년으로 바꾸지 않는다 |
| 재성 | 수입 활동·거래·비용과 자원 관리 | 돈 버는 10년으로 바꾸지 않는다 |
| 관성 | 역할·책임·평가 | 합격·승진이 정해진 구간으로 바꾸지 않는다 |
| 인성 | 학습·문서·준비·도움 | 시험 합격이나 도움을 받는 일이 정해진 10년으로 바꾸지 않는다 |

공통 조건: "대운 천간의 십성 계열로 고른 활동 주제이며 개인별 길흉을 합친 판정 공식이 아니다", "재성 대운을 돈 버는 10년, 관성 대운을 합격 구간처럼 사건이나 결과로 바꾸지 않는다". 9-3은 과거 사건, 앞으로의 성취, 어느 구간이 더 좋은지 순위(전성기)를 만들지 않는다.

#### 9-4 연결 기준

원국 장의 재료 가운데 엔진 결론이 `candidate`이고 강점(upside)이나 약점(weakness)이 있는 판단만 잇는다. 보류(deferred) 판단은 잇지 않는다. 먼저 아래 질문에 답하는 판단을, 남으면 의미 태그(`src/domain/mujin/tags.ts`)가 맞는 판단을 고른다. 같은 결론은 한 번만 쓴다.

| 계열 | 원국 질문 (우선순위) | 의미 태그 (우선순위) |
| --- | --- | --- |
| 비겁 | 3-2, 6-2, 6-1, 4-3 | autonomy-need, collaboration, over-comparison, ability.month-prosperity, ability.month-robbery |
| 식상 | 2-1, 2-2, 3-1, 5-1 | output-expression, ability.eating-god, ability.hurting-officer |
| 재성 | 4-1, 4-2, 4-4, 4-3 | over-expansion, relational-spending, money-talk-avoid, ability.direct-wealth, ability.indirect-wealth |
| 관성 | 3-1, 3-2, 7-2, 1-3 | role-clarity, responsibility-burden, refusal-difficulty, all-urgent, hidden-opinion, ability.direct-officer, ability.seven-killings, env.jangseong |
| 인성 | 2-3, 2-4, 6-4, 7-3 | finish-delay, solo-solving, ability.direct-resource, ability.indirect-resource, env.munchang, env.hakdang |

연결 재료(derived)는 `parentRefs`로 9-2 활동 주제와 원국 판단을 가리키고, 원국 판단의 강점·약점을 함께 옮긴다(9·10장은 다른 장과 다른 묶음에서 생성되기 때문). 행동 문장(action)은 옮기지 않는다. 조건: "새 판단이 아니다", "원국 판단 자체는 해당 장에서 설명하므로 기간과 잇는 부분만 짧게", "이 구간에 반드시 드러난다는 뜻이 아니다".

'지금의 나' 사실(`plan.nowFacts`)은 계획 공용 재료 ref를 그대로 가리킨다. `questionIds`에 9-4가 있거나, 위 원국 질문 가운데 일·학업 맥락의 장(2·3·4·6·8장)에 닿는 사실만 잇는다. 관계·가족 선택('답하고 싶지 않음' 포함)과 계획·가정·타인에 대한 관찰은 지금 상황으로 잇지 않는다.

### 10장 앞으로 12개월

`bundle.months.status`가 `available`이 아니면 10-1~10-4를 unavailable로 두고 달·날짜·분야 판단을 만들지 않는다(편집 목표는 3분의 1).

| 질문 | 재료 | 상태 |
| --- | --- | --- |
| 10-1 실제 분석 기간과 월별 개요 | 분석 기간(engine-fact, 절기 기준 월 라벨과 번들 한계 문장) + 달마다 네 분야의 표지 구성(period, 12개) | adopted. 자료 부족 분야가 있으면 conditional |
| 10-2 관심 분야의 주목 구간 | 번들이 분야 안에서 고른 주목 구간(분야마다 최대 3) | 후보가 있으면 adopted, 없으면 general("억지로 고르지 않고 없다고 짧게") |
| 10-3 주의 조건 | 번들이 분야 안에서 고른 주의 우세 구간(분야마다 최대 2) | 후보가 있으면 adopted, 없으면 general |
| 10-4 질문에 연결한 활동 방향 | 분야별 기간 활동 재료(derived, variant `month-activity:<분야>`) | 활동 재료가 있으면 adopted, 없으면 general |

- 분야는 직업·재물·연애·인간관계 네 가지뿐이다. 건강·가족 월운은 만들지 않는다.
- 달마다 분야별 표지 구성을 다섯 가지로 구분한다: 긍정·주의 함께(mixed), 긍정 표지만, 주의 표지만, 중립(뚜렷한 긍정·주의 표지 없음), 자료 부족(그 분야를 계산하지 못함). 판정은 번들(`MujinMonthCell.tone`) 그대로다. 같은 달의 긍정과 주의는 함께 말하고, 자료 부족은 나쁜 달이 아니라고 적는다.
- 첫 달이 기준일보다 먼저 시작했으면 그 달 재료에 "이미 지난 날짜를 앞으로 올 일처럼 말하지 않는다"를 붙인다.
- 주목·주의 구간의 선택은 번들(기간 분석)의 결과를 그대로 쓴다. 이 계획은 다시 고르지 않고 순서만 정한다: 관심 주제로 고른 장(3장 직업, 4장 재물, 5장 연애, 6장 인간관계)의 분야를 먼저, 그다음 직업·재물·연애·인간관계 순서, 분야 안에서는 번들 순서(같은 분야 안의 선택 점수, 동점이면 이른 달). 분야끼리 점수를 합치거나 비교하지 않는다. 전체 상세 설명은 주목 최대 3개월·주의 최대 2개월을 편집 목표로 작성 조건에 적되 숫자를 채우지 않는다.
- 여러 분야가 같은 달을 고르면 그 달은 재료 하나로 두고 분야별 이유를 함께 적는다. 결론이 하나면 결론 ID와 상태(notable→candidate, mixed→deferred, careful·quiet→observation, 기간 규칙의 대응과 같다)를 옮기고, 여럿이면 결론 ID를 하나로 대표하지 않는다(분야별 원래 결론은 `bundle.analyses`에 있다).
- 주목 구간이어도 같은 달의 주의 표지와 반대 근거를 지우지 않는다(basis, counterNote, evidence.counter). 주의 우세 구간은 "실패·사고·손실이 생기는 날이라는 뜻이 아니다"를 붙인다.
- 근거: 직접 근거(evidence.supporting)와 반대 근거(counter)는 그 달 결론의 근거만 쓰고, 겹치는 세운·대운의 근거는 보조 근거(contextual)에만 둔다. 보조 근거 ID가 직접 근거에 섞여 들어와도 옮기지 않는다. 여러 분야를 한 달 재료로 묶을 때 한 분야의 직접 근거가 다른 분야의 반대 근거이면 supporting에만 두고 반대 역할은 문장(basis·counterNote)에 남긴다. 규칙 ID·버전은 결론에서 옮긴다.
- 쓰지 않는 것: monthSequence와 일반 rating(분야 점수로 바꾸지 않는다), 12운성(단독 길흉 근거로 쓰지 않으며 단계 메모도 넣지 않는다), 월 중간의 세운·대운 경계를 나누는 보조 해석(정확히 이을 수 없으므로 생략).
- 10-4 활동 재료는 분야마다 주목·주의 구간의 달 재료를 `parentRefs`로 묶는다. 이 단계에서는 원국 판단과 잇지 않는다. 질문과 원국 판단은 개인화가 활동 분야가 같을 때만 붙인다. 조건: "지원 자료 정비를 합격일로, 관계 활동을 만남 확정일로 바꾸지 않는다."
- 상황 메모(situationNotes): 고른 일·학업 상태의 선택지 맥락과 추정 금지 문장, 관계 상태(미응답·비공개·응답)에 따라 연애 활동을 조건부로 말하라는 메모. 선택지의 의미이며 사용자가 알려 준 사실이 아니다.

### 마지막 정리

- 재료는 앞 장의 핵심 답(derived, `parentRefs`는 그 장 ID, 9·10장 답은 scope period)과 질문뿐이다. 새 사주 판단·날짜·수치를 더하지 않는다. 비어 있는 핵심 답은 쓰지 않는다.
- 질문이 있으면 질문마다 소질문을 하나 둔다(ID는 질문 ref, 제목은 정리한 질문 문장). `chaptersForQuestion`이 잇는 장의 핵심 답만 모으고, 분야 없는 넓은 질문은 모든 장의 답을 쓴다. 같은 장의 답은 재료 하나로 두고 쓰는 질문을 모두 적는다. 결과 확정 질문은 conditional, 이어지는 장의 답이 없으면 general.
- 질문이 없으면 `closing-core`(핵심 선택 기준과 확인할 조건) 하나를 두고 편집 목표를 하한 쪽(350~400자)으로 둔다. 질문이 있으면 상품 목표(350~550자)이고 비중은 question이다.

### 개인화

설명 우선순위는 실제 자유 질문 → 관심 주제 → 관련 상황 → 기본 설명이다. 개인화는 비중(weight), 편집 목표(targetChars), 질문·사실 재료와 그 연결(refs)만 바꾼다. 소질문의 상태·작성 조건과 기존 재료의 문장·근거는 바꾸지 않는다. 범위 밖 분야의 질문·사실은 쓰지 않는다. 마지막 정리 칸이 들어오면 그대로 둔다.

#### 질문이 이어지는 장 (`chaptersForQuestion`)

| 질문 분야 | 장 | 시기 질문(intent timing)이면 더하는 장 |
| --- | --- | --- |
| 성향 temperament | 1장 | 9장 |
| 강점 strengths, 학업 study | 2장 | 9장 |
| 직업 career | 3장 | 10장 |
| 재물 wealth, 투자 investment | 4장 | 10장 |
| 연애 romance | 5장 | 10장 |
| 인간관계 social, 친구 friends | 6장 | 10장 (인간관계 월운) |
| 가족 family | 7장 | 9장 |
| 건강 health | 8장 | 9장 |
| 넓은 질문 general | 없음 (마지막 정리에서만) | 9장과 10장 |

'몇 년 뒤', '인생 흐름', '전환점'처럼 분류 결과만으로 기간을 알 수 없는 질문은 분야 없는 시기 질문(general·timing)으로 들어오므로 9장(큰 흐름)과 10장(12개월)을 함께 잇는다. 기간 규칙 4분야의 시기 질문은 10장, 그 밖의 분야의 시기 질문은 9장으로 답한다(월별 판단 규칙이 없어 날짜를 고르지 않는다).

#### 장 안에서 붙이는 소질문

| 장 | 설명·넓은 질문 | 적용·결과·시기 질문, 사용자 사실 | 비교 질문 |
| --- | --- | --- | --- |
| 1장 | 1-2 | 1-3 | 1-2 |
| 2장 | 2-1 (학업 2-3) | 2-3 (학업 2-4) | 2-1 (학업 2-3) |
| 3장 | 3-1 | 3-4 | 3-3 |
| 4장 | 4-1 (투자 4-4) | 4-4 | 4-1 (투자 4-4) |
| 5장 | 5-2 | 5-3 | 5-2 |
| 6장 | 6-1 (친구 6-4) | 6-3 (친구 6-4) | 6-2 (친구 6-4) |
| 7장 | 7-1 | 7-4 | 7-1 |
| 8장 | 8-1 (건강 8-4) | 8-3 | 8-1 (건강 8-4) |
| 9장 | 9-4 | 9-4 | 9-4 |
| 10장 | 10-4 | 10-4 | 10-4 |

그 소질문의 refs 앞에 질문 ref를 붙인다. 같은 질문이 여러 장에 이어지면 각 장에 붙고, 마지막 정리가 모두 모은다. 계획에 없는 장(예: 무료 단계의 2~10장)은 잇지 않는다.

#### 질문 재료

질문은 사용자 사실(user-fact)이 아니라 질문 재료(`MujinQuestionMaterial`, kind `question`)다. ref는 질문 ref 그대로이고, 이어진 장(`sectionIds`)과 소질문(`chapterQuestionIds`), 작성 조건(`notes`)을 가진다. 작성 조건:

- 결과 확정 질문(answerability limited 또는 intent outcome): 사건 결과나 다른 사람의 마음을 확정하지 않고 판단할 수 있는 성향·조건·활동 구간만 답한다.
- 건강: 진단·병명·치료 없이 생활 리듬과 일정 조절로만. 투자: 종목·시점·수익률 대신 돈을 움직이는 습관. 학업: 합격 여부 대신 배우고 준비하는 방식.
- 비교: 정답을 정하지 않고 선택마다의 조건과 확인할 점. 사용자가 말하지 않은 자금·경험·고객은 확인할 항목.
- 시기: 10장 분야는 실제 분석 기간 안의 주목·주의 구간과 활동으로만, 9장 분야는 대운의 큰 흐름과 원국 성향으로만. 활동 구간을 취업·합격·만남이 정해진 날로 바꾸지 않는다.
- 확인할 정보(missingInfo)는 모르는 조건을 사실처럼 채우지 않게 적는다.
- 이어진 소질문이 general·deferred·unavailable이면 그 상태에 맞게(일반 상황 제안으로 구분, 보류 이유, 자료 없음) 답하라고 적는다.

#### 10-4 연결

시기 질문이 10장에 이어지고 그 분야의 기간 활동 재료가 있을 때만, 그 분야의 원국 장에서 채택 판단을 최대 2개 골라 기간 활동과 잇는 설명 연결(derived)을 만든다. 분야 없는 시기 질문은 모든 활동 재료를 앞에 두되 원국 판단과 잇지 않는다. 활동 재료가 없는 분야의 질문은 원국 판단과 잇지 않는다.

| 월운 분야 | 원국 장 | 원국 질문 (우선순위) |
| --- | --- | --- |
| 직업 | 3장 | 3-1, 3-4, 3-2 |
| 재물 | 4장 | 4-4, 4-2, 4-1 |
| 연애 | 5장 | 5-1, 5-2, 5-3 |
| 인간관계 | 6장 | 6-2, 6-3, 6-1 |

10-4의 refs는 질문 ref → 같은 분야 활동 재료 → 연결 재료 → 사용자 사실 → 나머지 활동 재료 순서다. 기존 refs는 지우지 않고 순서만 바뀐다.

#### 사용자 사실

진짜 궁금한 점에서 정리한 사실은 user-fact(source `concern`, factKind 그대로)로 분야의 장의 적용 소질문에 붙인다. 장마다 따로 ref를 둔다(9·10장은 다른 묶음에서 생성되므로).

| 종류 | 붙는 곳 | 조건 |
| --- | --- | --- |
| current 지금의 사실 | 분야의 장, 현재 대운 활동 주제와 닿으면 9-4, 같은 월운 분야의 시기 질문이 있으면 10-4 | 사주를 이유로 부정하지 않는다 |
| past 지난 일 | 위와 같음 | 지금도 그렇다고 단정하지 않는다 |
| plan 계획·희망 | 위와 같음 (준비와 닿으므로) | 아직 일어난 사실이 아니다. 현재 사실처럼 쓰지 않는다 |
| hypothetical 가정 | 분야의 장만 | 사실이 아니다. 현재 사실처럼 쓰지 않는다 |
| about-others 타인에 대한 관찰 | 분야의 장만 | 그 사람의 속마음이나 사정을 아는 사실처럼 쓰지 않는다 |

- 계획·가정을 current로 올리지 않는다. factKind는 받은 그대로다.
- 지금·지난 일 사실이 '지금의 나'에서 고른 같은 영역의 항목(직업·학업 사실 ↔ 일·학업 상태, 연애 사실 ↔ 관계 상태)과 함께 있으면 조건을 붙인다: 사실이 최근 변화(예: 최근 퇴사)를 분명히 말하면 그 최근 사실을 지금 상황으로 쓰고, 시간 구분 없이 맞지 않으면 맞지 않는 부분만 단정하지 않고 중립으로 다룬다. 사실 문장의 단어를 읽어 충돌을 판정하지 않는다.
- 분야가 없는(general) 사실은 질문이 이어진 장에만 붙인다. 질문이 없으면 쓰지 않는다.
- 가족 이야기를 답하고 싶지 않거나 답하지 않았으면 가족 사실을 만들지 않는다. 사용자가 진짜 궁금한 점에 직접 쓴 가족 사실은 사용자가 알려 준 것이므로 7장에 붙인다.

#### 비중과 편집 목표

| 비중 | 정하는 기준 | 편집 목표 (상품 목표 기준) |
| --- | --- | --- |
| question | 질문이 직접 이어진 장 | 하한을 범위의 절반만큼 올리고, 상한을 20%까지 늘린다 (3장 1,000~1,300 → 1,150~1,560) |
| interest | 관심 주제로 고른 장 (최대 2) | 하한을 범위의 4분의 1만큼, 상한을 10%까지 (2장 650~900 → 713~990) |
| standard | 그 밖 | 상품 목표 그대로 |

다른 장을 줄이지 않는다. 강제 최소 글자 수가 아니다. 자료가 없어 줄여 둔 장(9·10장)은 줄인 값을 기준으로 삼고, 이미 비중을 올린 계획을 다시 넣어도 커지지 않는다. 글이 없는 칸(원국표)은 그대로다. 관심은 설명 비중만 바꾸며 판단의 강도를 바꾸지 않는다.

### 작성용 ref

- 재료 ref는 `m<번호>`이며 계획 전체에서 고유하다. 각 함수는 `startRef`부터 이어서 내고 `nextRef`를 돌려준다(원국 계획 → 9·10장 → 개인화 → 마지막 정리 순서로 이어 쓴다).
- 질문 ref는 질문 분류의 ref(예: `q1`)를 그대로 쓴다. 재료 ref와 겹치거나 중복되면 멈춘다.
- 소질문 refs가 가리키는 곳: 그 장의 materials, 계획 공용 재료(`plan.facts`, `plan.nowFacts`), 질문 ref. derived 재료의 `parentRefs`는 다른 장의 원국 판단을 가리킬 수 있고, 마지막 정리의 `parentRefs`는 장 ID다.

### 명세와 다르게 한 점

- 질문 재료를 `MujinMaterial`이 아닌 `MujinQuestionMaterial`(personalize.ts)로 둔다. `MaterialKind`에 질문 종류가 없어 `MujinMaterial`로는 사용자 사실과 구분되지 않기 때문이다(types.ts는 바꾸지 않았다).
- 사용자 사실과 '지금의 나'의 충돌은 문장 분석으로 판정하지 않고, 같은 영역일 때 처리 조건을 사실 재료에 붙인다.
- 9-4는 명세의 '활동 주제와 관련된 원국 강점·약점'을 위 질문표와 태그표로 정했다(서비스 편집 기준, unreviewed).
