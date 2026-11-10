# Claude Code 작업 안내

@AGENTS.md

@docs/SAJUENGINE_SERVICE_GUIDE.md

위 파일을 읽고 작업한다. 이 저장소는 sajuengine을 설치해 사용하는 서비스다. 상품 규칙과 캐릭터, 설명 생성, 메신저 화면을 이 앱에 구현한다. 설치된 패키지의 공개 타입을 확인한 뒤 API를 사용한다.

서비스의 풀이 생성은 OpenAI API를 사용한다. Claude Code로 개발하더라도 앱의 LLM 호출을 다른 제공자로 바꾸지 않는다.

## 실제 API 호출 금지

작업 중에 실제 OpenAI API를 절대 호출하지 않는다. `npm run llm:compare`, `npm run llm:check`, 실제 키로 띄운 앱에서의 풀이 생성·후속 질문이 모두 포함된다. 비용은 사용자가 내므로 실제 모델 확인은 사용자가 직접 실행하고 결과를 알려 준다. 필요하면 실행할 명령과 확인할 항목만 안내하고, 보고에는 `LIVE_NOT_RUN`으로 쓴다. 검증은 단위 테스트와 가짜 서버를 쓰는 브라우저 테스트(`npm run test:e2e`)로 한다.

코드로도 막혀 있다. `src/server/llm/config.ts`의 `liveCallBlockReason`이 Next 서버(사용자가 직접 연 `npm run dev`나 배포 서버) 밖에서 실제 OpenAI 주소로 가는 호출을 막는다. 스크립트와 테스트는 `OPENAI_BASE_URL`이 가짜 서버를 가리킬 때만 호출한다. 이 제한을 풀거나 우회하지 않는다.
