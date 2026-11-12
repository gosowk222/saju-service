# 문답 예시 조립 결과 (가상 사례, 모델 호출 없음)

실제 생성 요청에 문답 예시가 어디에 들어가는지 보여 주는 파일이다. 운영과 같은 함수로 만들었고 개인정보가 없는 가상 평가 사례만 쓴다.
다시 만들기: `node --conditions=react-server --import tsx scripts/llm-examples-sample.ts`. 설명은 [`docs/personas/examples.md`](../../personas/examples.md).

| 파일 | 요청 | 넣은 예시 |
| --- | --- | --- |
| [01-myomyo-reading-job-seeking.md](01-myomyo-reading-job-seeking.md) | 묘묘 최초 풀이 (가상 사례 job-seeking) | myomyo-c-07, myomyo-c-01, myomyo-a-02 |
| [02-myomyo-followup-praise.md](02-myomyo-followup-praise.md) | 묘묘 후속 답변 (칭찬과 질문이 함께 온 메시지) | myomyo-c-10, myomyo-c-07, myomyo-c-01 |
| [03-mujin-pass2-ch3.md](03-mujin-pass2-ch3.md) | 무진 Pass 2 — 3장 직업과 사회생활 (가상 사례 side-job-money) | mujin-rw-09, mujin-06 |
| [04-mujin-followup-tease.md](04-mujin-followup-tease.md) | 무진 후속 답변 (허세 지적과 질문이 함께 온 메시지) | mujin-14, mujin-09, mujin-03 |

모든 파일에서 예시는 지시(instructions) 맨 끝의 `[캐릭터 문답 예시: …]` ~ `[캐릭터 문답 예시 끝]` 블록에만 있고, 사용자 메시지(input)에는 없다. 블록 앞의 지시는 예시 없는 이전 버전과 글자까지 같다.
순서 값이 사례 ID라 운영(풀이·후속 질문 ID로 고름)과 고른 예시는 다를 수 있다. 블록의 모양과 위치는 같다.
