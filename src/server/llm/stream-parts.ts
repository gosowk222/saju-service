/**
 * 스트리밍으로 받는 풀이 JSON의 앞부분에서 이미 끝난 부분을 찾는다.
 *
 * 구조화 출력은 형식에 적은 속성 순서대로 나온다 (opening → focus → topics → closing).
 * 최상위 객체의 문자열 값과 배열 값, topics 배열의 각 원소가 닫히는 순간을 찾아 그 조각만 JSON으로 읽는다.
 * 아직 닫히지 않은 부분은 돌려주지 않는다.
 */
export interface StreamedParts {
  readonly opening?: string;
  readonly focus?: unknown;
  /** 다 받은 주제만 순서대로. */
  readonly topics: readonly unknown[];
  readonly closing?: string;
}

function parse(slice: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(slice) };
  } catch {
    return { ok: false };
  }
}

export function completedParts(text: string): StreamedParts {
  const result: { opening?: string; focus?: unknown; topics: unknown[]; closing?: string } = { topics: [] };
  const assign = (key: string | null, slice: string) => {
    const parsed = parse(slice);
    if (!parsed.ok) return;
    if (key === "opening" && typeof parsed.value === "string") result.opening = parsed.value;
    if (key === "closing" && typeof parsed.value === "string") result.closing = parsed.value;
    if (key === "focus") result.focus = parsed.value;
  };

  let depth = 0;
  let inString = false;
  let escaped = false;
  let stringStart = -1;
  /** 최상위 객체에서 지금 값을 읽고 있는 속성 이름. */
  let key: string | null = null;
  let expectingValue = false;
  let valueStart = -1;
  let elementStart = -1;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') {
        inString = false;
        if (depth === 1) {
          const token = text.slice(stringStart, index + 1);
          if (expectingValue) {
            assign(key, token);
            expectingValue = false;
          } else {
            const name = parse(token);
            key = name.ok && typeof name.value === "string" ? name.value : null;
          }
        }
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      stringStart = index;
    } else if (char === ":") {
      if (depth === 1) expectingValue = true;
    } else if (char === "{" || char === "[") {
      depth += 1;
      if (depth === 2 && expectingValue) valueStart = index;
      if (depth === 3 && key === "topics") elementStart = index;
    } else if (char === "}" || char === "]") {
      if (depth === 3 && key === "topics" && elementStart >= 0) {
        const element = parse(text.slice(elementStart, index + 1));
        if (element.ok) result.topics.push(element.value);
        elementStart = -1;
      }
      if (depth === 2 && expectingValue && valueStart >= 0) {
        if (key !== "topics") assign(key, text.slice(valueStart, index + 1));
        expectingValue = false;
        valueStart = -1;
      }
      depth -= 1;
    }
  }
  return result;
}
