/**
 * 사용자가 준 원문 문답을 읽는 함수. 원문 텍스트는 mujin-originals.ts, myomyo-references.ts에 받은 그대로 두고,
 * 이 함수가 번호·제목·입력 전제·질문·답변으로 나눈다. 원문을 고치지 않고 메타데이터는 카탈로그 파일에서 따로 붙인다.
 *
 * 형식 (받은 원문 그대로):
 *   [무진 05 — 강점을 설명할 때]
 *
 *   입력 전제:            (있을 때만)
 *   한 줄에 하나씩
 *
 *   사용자:
 *   질문
 *
 *   무진:
 *   답변 (문단은 빈 줄로 나뉜다)
 */

export interface ParsedOriginal {
  /** 원문의 번호 (예: "05"). */
  readonly number: string;
  readonly title: string;
  /** "입력 전제:" 아래 줄. 없으면 빈 배열. */
  readonly premise: readonly string[];
  readonly question: string;
  /** 답변. 문단은 빈 줄 하나로 나뉜다. */
  readonly answer: string;
}

function linesUntilBlank(lines: readonly string[], start: number): { readonly taken: string[]; readonly next: number } {
  const taken: string[] = [];
  let index = start;
  while (index < lines.length && lines[index]!.trim() !== "") {
    taken.push(lines[index]!.trim());
    index += 1;
  }
  return { taken, next: index };
}

/**
 * label: 머리말의 이름 (예: "무진", "묘묘 참고"), speaker: 답변을 여는 이름 (예: "무진", "묘묘").
 * 형식이 맞지 않으면 예외를 던진다 (원문을 옮기다 깨진 것을 테스트가 바로 찾게).
 */
export function parseOriginals(raw: string, label: string, speaker: string): ParsedOriginal[] {
  const text = raw.replace(/\r\n/g, "\n").trim();
  const header = new RegExp(`^\\[${label} (\\d{2}) — (.+)\\]$`, "gm");
  const heads = [...text.matchAll(header)];
  if (!heads.length) throw new Error(`원문 머리말을 찾지 못했습니다: ${label}`);
  return heads.map((head, position) => {
    const start = head.index! + head[0].length;
    const end = position + 1 < heads.length ? heads[position + 1]!.index! : text.length;
    const lines = text.slice(start, end).split("\n");
    let index = 0;
    const skipBlank = () => {
      while (index < lines.length && lines[index]!.trim() === "") index += 1;
    };
    const expect = (name: string) => {
      skipBlank();
      if (lines[index]?.trim() !== `${name}:`) throw new Error(`[${label} ${head[1]}] '${name}:' 줄이 없습니다.`);
      index += 1;
    };

    skipBlank();
    let premise: string[] = [];
    if (lines[index]?.trim() === "입력 전제:") {
      const read = linesUntilBlank(lines, index + 1);
      premise = read.taken;
      index = read.next;
    }
    expect("사용자");
    const question = linesUntilBlank(lines, index);
    index = question.next;
    expect(speaker);
    // 답변은 끝까지 읽고, 문단 사이의 빈 줄은 하나로 맞춘다 (원문의 문단 구분은 빈 줄 하나다).
    const answer = lines
      .slice(index)
      .join("\n")
      .trim()
      .split(/\n\s*\n/)
      .map((paragraph) => paragraph.trim())
      .join("\n\n");
    if (!question.taken.length || !answer) throw new Error(`[${label} ${head[1]}] 질문이나 답변이 비어 있습니다.`);
    return { number: head[1]!, title: head[2]!.trim(), premise, question: question.taken.join("\n"), answer };
  });
}

/**
 * 구분선 형식의 원문을 읽는다 (묘묘 기준 문답 2.0.0, myomyo-originals-2.ts). 원문을 고치지 않고 칸만 나눈다.
 *
 *   ────────────────
 *   예시 04. 신중한 연애 성향을 풀이하는 경우
 *   ────────────────
 *
 *   입력 전제:            (있을 때만, 줄마다 "- ")
 *   - 한 줄에 하나씩
 *
 *   사용자:
 *   질문
 *
 *   묘묘:
 *   답변 (문단은 빈 줄로 나뉜다)
 *
 * 입력 전제 줄의 앞머리 "- "만 떼어 낸다. 형식이 맞지 않으면 예외를 던진다.
 */
export function parseDividedOriginals(raw: string, speaker: string): ParsedOriginal[] {
  const text = raw.replace(/\r\n/g, "\n");
  const header = /^─+\n예시 (\d{2})\. (.+)\n─+$/gm;
  const heads = [...text.matchAll(header)];
  if (!heads.length) throw new Error("원문 머리말(예시 NN.)을 찾지 못했습니다.");
  return heads.map((head, position) => {
    const label = `예시 ${head[1]}`;
    const start = head.index! + head[0].length;
    const end = position + 1 < heads.length ? heads[position + 1]!.index! : text.length;
    const lines = text.slice(start, end).split("\n");
    let index = 0;
    const skipBlank = () => {
      while (index < lines.length && lines[index]!.trim() === "") index += 1;
    };
    const expect = (name: string) => {
      skipBlank();
      if (lines[index]?.trim() !== `${name}:`) throw new Error(`[${label}] '${name}:' 줄이 없습니다.`);
      index += 1;
    };

    skipBlank();
    let premise: string[] = [];
    if (lines[index]?.trim() === "입력 전제:") {
      const read = linesUntilBlank(lines, index + 1);
      premise = read.taken.map((line) => {
        if (!line.startsWith("- ")) throw new Error(`[${label}] 입력 전제 줄이 '- '로 시작하지 않습니다.`);
        return line.slice(2).trim();
      });
      index = read.next;
    }
    expect("사용자");
    const question = linesUntilBlank(lines, index);
    index = question.next;
    expect(speaker);
    const answer = lines
      .slice(index)
      .join("\n")
      .trim()
      .split(/\n\s*\n/)
      .map((paragraph) => paragraph.trim())
      .join("\n\n");
    if (!question.taken.length || !answer) throw new Error(`[${label}] 질문이나 답변이 비어 있습니다.`);
    return { number: head[1]!, title: head[2]!.trim(), premise, question: question.taken.join("\n"), answer };
  });
}
