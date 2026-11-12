/**
 * 2-pass 의미 보존 검사(Pass 2가 초안에 없던 숫자를 더하지 않았는지)에 쓰는 숫자 읽기. 무진 족자(src/domain/mujin/check.ts)와
 * 묘묘 2-pass(src/domain/reading/two-pass-check.ts)가 함께 쓴다.
 */

/** 천 단위 쉼표(1,000)는 한 숫자로, 그 밖의 쉼표('1,2번')는 나눠 읽는다. */
const NUMBER = /\d{1,3}(?:,\d{3})+(?!\d)|\d+(?:\.\d+)?/g;

const normalizeNumber = (raw: string) => {
  const plain = raw.replace(/,/g, "");
  const value = Number(plain);
  return Number.isFinite(value) ? String(value) : plain;
};

/** 문장에 나온 모든 숫자 (허용 출처를 만들 때). */
export function numbersOf(texts: readonly string[]): Set<string> {
  const values = new Set<string>();
  for (const text of texts) for (const match of text.matchAll(NUMBER)) values.add(normalizeNumber(match[0]));
  return values;
}

/**
 * 최종문에서 새로 나왔는지 볼 숫자. 날짜(4자리 연도+년, 1~2자리+월)와 비율(%)은 문장 검사가 허용 목록으로 따로 보므로 뺀다.
 * '3개월', '10분', '1년', '주 2회' 같은 기간·횟수는 여기서 본다.
 */
export function claimedNumbers(text: string): string[] {
  const values: string[] = [];
  for (const match of text.matchAll(NUMBER)) {
    const raw = match[0];
    const after = text.slice((match.index ?? 0) + raw.length);
    if (/^\s*%/.test(after)) continue;
    if (/^\d{4}$/.test(raw) && /^\s*년/.test(after)) continue;
    if (/^\d{1,2}$/.test(raw) && /^\s*월/.test(after)) continue;
    values.push(normalizeNumber(raw));
  }
  return values;
}
