/**
 * 결과 문장에 캐릭터 예시 답변의 문장 조각이 그대로 들어갔는지 찾는다. 사람이 두 버전(예시 사용·미사용)을 비교할 때 쓰는 참고 표다
 * (llm:render 보고서). 생성 검사나 다시 쓰기 조건에는 쓰지 않는다. 겹침이 없다고 문체가 좋다는 뜻도, 있다고 실패라는 뜻도 아니다.
 *
 * 비교는 공백과 문장부호를 뺀 글자로 한다. 예시 답의 연속된 size글자(기본 16글자)가 결과에 그대로 있으면 겹침으로 본다.
 * 짧은 조각(예: '사주로 볼 수 있는')은 흔한 말이라 세지 않도록 기본 길이를 길게 둔다.
 */

const squash = (text: string) => text.replace(/[\s.,!?~'"“”‘’()…·\-*]/g, "");

export interface ExampleEcho {
  readonly exampleId: string;
  /** 결과에 그대로 나온 예시 답의 조각 (이어진 조각은 하나로 합친다, 공백·문장부호 없이). */
  readonly fragments: readonly string[];
}

export function exampleEchoes(texts: readonly string[], examples: readonly { readonly id: string; readonly answer: string }[], size = 16): ExampleEcho[] {
  const output = squash(texts.join("\n"));
  const echoes: ExampleEcho[] = [];
  for (const example of examples) {
    const answer = squash(example.answer);
    const fragments: string[] = [];
    let start = -1;
    let end = -1;
    for (let index = 0; index + size <= answer.length; index += 1) {
      if (!output.includes(answer.slice(index, index + size))) continue;
      if (start >= 0 && index <= end) {
        end = index + size;
      } else {
        if (start >= 0) fragments.push(answer.slice(start, end));
        start = index;
        end = index + size;
      }
    }
    if (start >= 0) fragments.push(answer.slice(start, end));
    if (fragments.length) echoes.push({ exampleId: example.id, fragments });
  }
  return echoes;
}

/** 보고서용 Markdown 줄. 겹침이 없으면 한 줄로 알린다. */
export function echoLines(echoes: readonly ExampleEcho[], catalogVersion: string): string[] {
  if (!echoes.length) return [`카탈로그 \`${catalogVersion}\`의 예시 답과 16글자 이상 그대로 겹치는 조각이 없다.`];
  return [
    `카탈로그 \`${catalogVersion}\`의 예시 답과 16글자 이상 그대로 겹치는 조각 (공백·문장부호를 뺀 글자). 판정 기준이 아니라 읽을 때 참고한다.`,
    "",
    "| 예시 ID | 겹친 조각 |",
    "| --- | --- |",
    ...echoes.map((echo) => `| ${echo.exampleId} | ${echo.fragments.map((fragment) => fragment.replace(/\|/g, "\\|")).join(" / ")} |`),
  ];
}
