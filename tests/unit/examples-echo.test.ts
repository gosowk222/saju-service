import { describe, expect, it } from "vitest";
import { echoLines, exampleEchoes } from "@/domain/personas/examples";

/** 결과 문장과 예시 답의 겹침 표 (llm:render 참고 표). 판정 기준이 아니다. */
describe("예시 문장 겹침", () => {
  const examples = [
    { id: "mujin-21", answer: "차를 마십니다. 보통은 식은 걸로요. 남의 사정을 듣다 보면 제 찻잔은 늘 순서가 밀리더군요." },
    { id: "mujin-13", answer: "칭찬은 받겠습니다. 굳이 사양할 이유는 없으니까요." },
  ];

  it("공백·문장부호를 빼고 16글자 이상 그대로 이어진 조각만 찾고, 이어진 조각은 하나로 합친다", () => {
    const echoes = exampleEchoes(["오늘도 남의 사정을 듣다 보면, 제 찻잔은 늘 순서가 밀리더군요!"], examples);
    expect(echoes).toEqual([{ exampleId: "mujin-21", fragments: ["남의사정을듣다보면제찻잔은늘순서가밀리더군요"] }]);
    // 흔한 짧은 말은 세지 않는다.
    expect(exampleEchoes(["칭찬은 받겠습니다."], examples)).toEqual([]);
  });

  it("보고서 줄: 겹침이 없으면 한 줄로 알리고, 있으면 예시 ID와 조각 표를 만든다", () => {
    expect(echoLines([], "mujin-examples-1.0.0")).toEqual(["카탈로그 `mujin-examples-1.0.0`의 예시 답과 16글자 이상 그대로 겹치는 조각이 없다."]);
    const lines = echoLines([{ exampleId: "mujin-21", fragments: ["가|나"] }], "mujin-examples-1.0.0");
    expect(lines.at(-1)).toBe("| mujin-21 | 가\\|나 |");
  });
});
