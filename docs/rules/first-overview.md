# 첫 상품 규칙 (first-overview 1.0.0)

코드는 `src/domain/rules/first-overview.ts`, 선택 기준은 `src/domain/reading/plan.ts`에 있다.

**검토 상태: 모두 `unreviewed`.** AI가 작성한 초안이며 명리 전문가의 검토를 받지 않았다. 사람이 실제로 검토하기 전에는 `human-reviewed`로 바꾸지 않는다. 출시 전 명리 전문가의 검토를 권장한다.

## 왜 앱 규칙이 필요한가

엔진의 기본 원국 규칙(`inquiry.natal.topics`)은 M03 후보를 돌려주지만, 개발 중 가상 입력 56건의 연애 주제를 확인했을 때 결론이 있는 46건은 전부 `deferred`였고 나머지 10건은 `insufficient-evidence`였다. 구조의 불확실성을 알리는 검토 표지(`review-required`)가 함께 나오면 기본 규칙이 결론을 보류하기 때문이다. 그 상태로는 상품 본문에 쓸 채택 해석이 없다. 그래서 M01이 `accepted confirmed`로 확정한 십성 분포를 기준으로, 이 상품이 쓸 해석을 앱에서 채택한다.

엔진의 기본 규칙은 그대로 두고, 앱 규칙을 `createInquiryReader`에 `rules`로 등록한다.

## 규칙 1: 두드러진 계열로 읽기

| 항목 | 내용 |
| --- | --- |
| 규칙 ID, 버전 | `first-overview.dominant-family-lens`, `1.0.0` |
| 질문 | 여섯 주제의 원국(natal) 질문, 주체는 본인 |
| 사용 필드 | `assessment.dominantFamily`, `assessment.familyPercent`, `assessment.coverage`, `evidence`의 `ruleId`, `disposition`, `tags` |
| 사용한 근거 | `m01.assessment.families` 판단의 근거 ID |
| 적용 조건 | 가장 두드러진 계열이 있고 그 비중이 25% 이상 (다섯 계열이 고르면 각 20%) |
| 비적용 | 25% 미만이거나 분포 자료가 없으면 결론을 내지 않음 |
| 반대 근거 | 해당 주제의 M03 `review-required` 판단을 `counterEvidenceIds`로 연결하고, 단정하지 않고 경향으로 전달하도록 caveat을 붙임 |
| 보류 조건 | 시주를 몰라 분포가 일부이고 1위와 2위의 차이가 10점 이하이면 `deferred` |
| 출력 | 주제별 해석 후보 1개 (`candidate` 또는 `deferred`) |
| 출처 | 서비스 자체 정책 (이 문서) |

## 규칙 2: 비중이 낮은 계열 보완

| 항목 | 내용 |
| --- | --- |
| 규칙 ID, 버전 | `first-overview.scarce-family-balance`, `1.0.0` |
| 질문 | 강점, 일, 돈 주제의 원국 질문 |
| 사용 필드 | `assessment.familyPercent`, `missingFamilies`, `observedMissingFamilies`, `coverage` |
| 사용한 근거 | `m01.assessment.families` 판단의 근거 ID |
| 적용 조건 | 비중이 가장 낮은 계열이 12% 이하 |
| 비적용 | 모든 계열이 12%를 넘으면 결론을 내지 않음 |
| 반대 근거 | 없음. 보완 제안이므로 결과를 판정하지 않음 |
| 보류 조건 | 시주를 모르고 그 계열이 관측된 기둥에서만 없는 경우 `deferred`. 안 보인다고 없다고 단정하지 않는다 |
| 출력 | 행동 제안 후보 1개 |
| 출처 | 서비스 자체 정책 (이 문서) |

## 상품 선택 기준

주제별로 엔진 응답을 작성 재료로 옮기는 기준이다.

1. 앱 규칙의 `candidate` 결론을 먼저 쓴다. 이 주제는 `adopted`다.
2. `candidate`가 없고 `deferred`만 있으면 `tentative`다. 경향과 한계를 함께 말한다.
3. 엔진 응답이 `insufficient-evidence`나 `unsupported`이고 앱 규칙 결론도 없으면 `limited`다. 무엇을 알 수 없는지 짧게 말하고 결론을 지어내지 않는다.
4. 엔진 기본 규칙의 `deferred` 결론은 주제당 1개까지 보조 재료로 넘긴다.

## 하지 않는 것

- 일반 길흉이나 `rating`을 연애·재물 점수로 바꾸지 않는다.
- 실제 수입, 금액, 합격, 재회, 만남 날짜를 판정하지 않는다.
- `assertion` 문장을 파싱해서 의미를 추측하지 않는다.
- 건강 주제는 다루지 않는다.

## 검증 사례

`tests/unit/rules.test.ts`에서 적용, 비적용, 반대 근거, 시주 미상 보류를 확인한다. 이 테스트는 코드가 문서대로 동작하는지 확인할 뿐, 명리적 타당성을 검증하지 않는다.
