/**
 * 풀이 문장의 강조 표시. 화면과 PDF는 **이렇게** 감싼 구절을 같은 규칙으로 굵게 그린다.
 * 이전 풀이에는 강조 표시가 없으므로 영향이 없다.
 */
export interface TextRun {
  readonly text: string;
  readonly strong: boolean;
}

const EMPHASIS = /\*\*([^*\n]+?)\*\*/g;

export function splitEmphasis(text: string): TextRun[] {
  const runs: TextRun[] = [];
  let last = 0;
  for (const match of text.matchAll(EMPHASIS)) {
    if (match.index > last) runs.push({ text: text.slice(last, match.index), strong: false });
    runs.push({ text: match[1]!, strong: true });
    last = match.index + match[0].length;
  }
  if (last < text.length) runs.push({ text: text.slice(last), strong: false });
  return runs.length ? runs : [{ text, strong: false }];
}

/**
 * 저장하기 전에 강조 표시를 정리한다. 짝이 맞지 않으면 별표가 화면에 그대로 보이므로 표시를 모두 지운다.
 * 강조는 꾸밈이라 이 때문에 다시 생성하지 않는다 (호출 비용을 쓰지 않는다).
 */
export function tidyEmphasis(text: string): string {
  const trimmed = text.trim().replace(/\*{4,}/g, "");
  const marks = trimmed.match(/\*\*/g)?.length ?? 0;
  return marks % 2 === 1 ? trimmed.replace(/\*\*/g, "") : trimmed;
}

const SENTENCE = /[^.!?]+[.!?]+["”’']?|[^.!?]+$/g;
/** 요약 구절의 글자 두 개 묶음 가운데 이 비율 이상, 이 개수 이상이 문장에 있을 때만 그 문장을 강조한다. */
const MIN_OVERLAP = 0.25;
const MIN_SHARED = 3;

function pairs(text: string): Set<string> {
  const squashed = text.replace(/[\s.,!?~'"“”‘’()*]/g, "");
  const result = new Set<string>();
  for (let index = 0; index < squashed.length - 1; index += 1) result.add(squashed.slice(index, index + 2));
  return result;
}

/** 구절(phrase)의 묶음 가운데 문장(sentence)에 들어 있는 비율. 짧은 구절이 우연히 겹치지 않게 겹친 개수가 적으면 0으로 본다. */
function overlap(phrase: Set<string>, sentence: Set<string>): number {
  let shared = 0;
  for (const pair of phrase) if (sentence.has(pair)) shared += 1;
  return shared >= MIN_SHARED ? shared / phrase.size : 0;
}

/**
 * narration-2.1.0의 강조 구절(highlight)을 문장 안의 강조 표시로 바꾼다.
 * 구절이 문장에 그대로 있으면 그 구절을, 모델이 요약해서 적었으면 같은 말풍선에서 가장 많이 겹치는 문장 하나를 굵게 만든다
 * (실제 모델은 28개 중 28개를 요약으로 적었다, 2026-11-10). 겹치는 문장이 없거나 문장에 이미 표시가 있으면 그대로 둔다.
 */
export function applyHighlight(text: string, highlight: string | undefined): string {
  const phrase = highlight?.replaceAll("*", "").trim();
  if (!phrase || phrase.includes("\n") || text.includes("**")) return text;
  const index = text.indexOf(phrase);
  if (index !== -1) return `${text.slice(0, index)}**${phrase}**${text.slice(index + phrase.length)}`;

  const target = pairs(phrase);
  let best: { start: number; sentence: string; score: number } | null = null;
  for (const match of text.matchAll(SENTENCE)) {
    const sentence = match[0].trim();
    if (!sentence) continue;
    const score = overlap(target, pairs(sentence));
    if (!best || score > best.score) best = { start: match.index + match[0].indexOf(sentence), sentence, score };
  }
  // 줄바꿈이 섞인 문장은 화면 규칙(한 줄 안의 강조)과 맞지 않아 강조하지 않는다.
  if (!best || best.score < MIN_OVERLAP || best.sentence.includes("\n")) return text;
  return `${text.slice(0, best.start)}**${best.sentence}**${text.slice(best.start + best.sentence.length)}`;
}

/**
 * 한 묶음(답변 영역 또는 주제 하나)의 말풍선 문장을 저장용으로 만든다. 강조는 설명 말풍선에만, 묶음마다 limit개까지만 적용한다.
 * 창작 장면과 짧은 반응은 굵게 만들지 않는다. 모델이 문장 안에 직접 표시한 강조도 개수에 넣는다.
 */
export function emphasizeGroup(bubbles: readonly { readonly kind: string; readonly text: string; readonly highlight?: string }[], limit: number): string[] {
  let used = 0;
  return bubbles.map((bubble) => {
    const text = tidyEmphasis(bubble.text);
    if (text.includes("**")) {
      used += 1;
      return text;
    }
    if (used >= limit || bubble.kind !== "explanation") return text;
    const applied = applyHighlight(text, bubble.highlight);
    if (applied !== text) used += 1;
    return applied;
  });
}
