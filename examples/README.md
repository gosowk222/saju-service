# sajuengine 서비스 연결 예제

현재 `sajuengine 0.1.0`과 inquiry 정책 `1.1.0`의 실제 공개 API를 사용하는 Node.js 서버 예제다. 패키지 버전이 같더라도 이전에 만든 tgz에는 최신 inquiry 변경이 없을 수 있으므로, 안내서에 지정된 소스 커밋에서 만든 파일을 사용한다.

이 예제는 계산과 서비스 규칙의 연결을 보여 준다. LLM 호출, 결제, 저장, 웹 화면은 포함하지 않는다. 예제의 날짜와 출생 정보는 실행 확인용이다.

## 설치와 실행

Node.js 24 이상을 준비한다. 새 서비스 저장소의 `vendor/`에 직접 빌드한 `sajuengine-0.1.0.tgz`를 두고, 이 `examples/` 폴더도 저장소로 복사한다.

```sh
cd examples
npm install ../vendor/sajuengine-0.1.0.tgz --ignore-scripts
npm run typecheck
npm run smoke
```

`npm install`은 예제의 TypeScript 개발 도구와 패키지를 설치하고 `package-lock.json`을 만든다. 재현을 위해 이 잠금 파일도 보관한다. 설치 파일의 위치가 다르면 첫 명령의 tgz 경로만 바꾼다. 엔진에 필요한 API 키나 `.env`는 없다.

`smoke`는 TypeScript를 `dist/`로 빌드한 뒤 계산을 실행한다. 성공하면 `checks: "passed"`, `monthlyPeriods: 12`, `inquiryPolicyVersion: "1.1.0"` 등이 출력된다. 모델 호출은 하지 않으므로 `LIVE_NOT_RUN`이다.

## 파일 읽는 순서

1. `01-engine-materials.ts`: 공개 출생 입력 검증 → 서비스의 계산 기능 정의 → 요청 안의 계산 세션 → 원국·12개월 질문.
2. `02-custom-rule.ts`: 서비스가 소유하는 `InquiryRule` → 대상 월의 12운성만 선택 → 원래 근거 ID를 연결.
3. `03-run-smoke.ts`: 결과 상태, 출처·원본 위치, 월별 흐름 맥락, 다른 달의 12운성 제외를 확인.

## 반드시 지킬 사용 규칙

- `defineFeatureSet`의 개별 기능에는 `selection`이 필요하다. `children`을 묶는 상위 기능에는 자체 `selection`을 넣지 않는다. 검증 오류는 `FeatureDefinitionError.issues`에서 확인한다.
- `selection`은 이미 계산한 판단을 고르는 설정이다. 새 상품의 의미를 정하는 `InquiryRule`과 구분한다.
- `createFeatureSession`은 한 요청 동안 사용하고 `finally`에서 `dispose()`한다. 이것을 출생 정보 전역 캐시로 만들지 않는다.
- `reader.periods`에서 실제 존재하는 기간 ID를 선택한다. 월운은 절기 기준이므로 양력 달이나 오늘부터 30일과 같다고 가정하지 않는다.
- `monthlyStageObservationRule`은 12운성 관측을 전달하는 연결 예제다. 단계 하나로 연애·재물 점수 또는 사건 발생일을 정하는 검증된 공식이 아니다.
- `twelveStages`에는 원국과 대상 기간만 들어간다. 별도로 요청한 상위 기간은 `contextTwelveStages`와 `contextEvidence`를 사용하고 `contextualEvidenceIds`로 연결한다.
- `monthSequence`와 일반 길흉은 맥락 자료다. 이를 연애·재물 점수로 바꾸거나 직접 지지 근거 ID로 넣지 않는다.
- 결과의 `supportingEvidence`·`counterEvidence`·`contextualEvidence`·`rule`·`provenance`를 보관한다. 문장만 저장하면 어떤 계산과 규칙에서 나왔는지 확인할 수 없다.
- `available`은 해석할 근거가 있다는 뜻이다. 미래 사건의 확률이나 정확도가 아니다. `unsupported`와 `insufficient-evidence`를 긍정 또는 부정의 운세로 바꿔 말하지 않는다.
- `FeatureResult` 전체에는 출생 정보가 포함될 수 있다. 전체 결과와 사용자 입력을 일반 로그에 남기지 않는다.

## 웹 서비스에 옮길 때

계산 함수와 규칙 파일을 서버 전용 폴더로 옮긴다. Next.js라면 Node.js 서버 경로에서 호출하고, 클라이언트 컴포넌트에는 화면에 필요한 결과만 전달한다. 예제의 `console.log` 대신 접근 권한이 있는 저장소에 결과를 저장한다. 실제 사용자 입력은 서버에서 `PublicBirthInputSchema`로 검증한다.

메신저 말풍선, 캐릭터 말투, 글 생성 프롬프트, 창작 장면 표시, 생성 문장 검사, 재시도는 새 앱의 기능으로 추가한다.
