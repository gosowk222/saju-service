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

/** 후속 답변의 질문 하나. 문단은 빈 줄로 나뉘며, 다 받은 문단만 담는다. */
export interface StreamedFollowupSection {
  readonly questionRef?: string;
  readonly refs?: readonly string[];
  readonly paragraphs: readonly string[];
  /** text 문자열이 닫혔는지 (닫히면 마지막 문단도 다 받은 것이다). */
  readonly closed: boolean;
}

export interface StreamedFollowup {
  readonly mode?: string;
  readonly sections: readonly StreamedFollowupSection[];
}

/** 아직 닫히지 않은 JSON 문자열의 앞부분을 읽는다. 끝에 걸친 이스케이프(\, \u12)는 떼고 읽는다. */
function decodePartialString(raw: string): string {
  let body = raw.replace(/\\u[0-9a-fA-F]{0,3}$/, "");
  const trailing = body.match(/\\+$/)?.[0].length ?? 0;
  if (trailing % 2 === 1) body = body.slice(0, -1);
  const parsed = parse(`"${body}"`);
  return parsed.ok && typeof parsed.value === "string" ? parsed.value : "";
}

function paragraphsOf(text: string, closed: boolean): string[] {
  const segments = text.split(/\n\s*\n/);
  // 닫히지 않았으면 마지막 조각은 아직 쓰는 중이다.
  if (!closed) segments.pop();
  return segments.map((segment) => segment.trim()).filter(Boolean);
}

/**
 * 스트리밍으로 받는 후속 답변(followup-output-2.1.0: mode → sections[{questionRef, refs, text}] → clarifyQuestion)에서
 * 질문마다 근거 연결과 다 받은 문단을 찾는다. text가 아직 들어오는 중이어도 끝난 문단은 돌려준다.
 */
export function followupParts(text: string): StreamedFollowup {
  let mode: string | undefined;
  const sections: { questionRef?: string; refs?: string[]; text?: string; partial?: string; closed: boolean }[] = [];
  let depth = 0;
  let inString = false;
  let escaped = false;
  let stringStart = -1;
  let topKey: string | null = null;
  let topExpecting = false;
  let sectionKey: string | null = null;
  let sectionExpecting = false;
  let refsStart = -1;
  const current = () => sections[sections.length - 1];

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') {
        inString = false;
        const token = text.slice(stringStart, index + 1);
        if (depth === 1) {
          if (topExpecting) {
            const value = parse(token);
            if (topKey === "mode" && value.ok && typeof value.value === "string") mode = value.value;
            topExpecting = false;
          } else {
            const name = parse(token);
            topKey = name.ok && typeof name.value === "string" ? name.value : null;
          }
        } else if (depth === 3 && topKey === "sections" && current()) {
          if (sectionExpecting) {
            const value = parse(token);
            if (value.ok && typeof value.value === "string") {
              if (sectionKey === "questionRef") current()!.questionRef = value.value;
              if (sectionKey === "text") {
                current()!.text = value.value;
                current()!.closed = true;
              }
            }
            sectionExpecting = false;
          } else {
            const name = parse(token);
            sectionKey = name.ok && typeof name.value === "string" ? name.value : null;
          }
        }
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      stringStart = index;
    } else if (char === ":") {
      if (depth === 1) topExpecting = true;
      if (depth === 3) sectionExpecting = true;
    } else if (char === "{" || char === "[") {
      depth += 1;
      if (depth === 3 && topKey === "sections" && char === "{") sections.push({ closed: false });
      if (depth === 4 && sectionExpecting && sectionKey === "refs") refsStart = index;
    } else if (char === "}" || char === "]") {
      if (depth === 4 && refsStart >= 0 && current()) {
        const refs = parse(text.slice(refsStart, index + 1));
        if (refs.ok && Array.isArray(refs.value)) current()!.refs = refs.value.filter((ref): ref is string => typeof ref === "string");
        refsStart = -1;
        sectionExpecting = false;
      }
      if (depth === 2 && topKey === "sections") topExpecting = false;
      depth -= 1;
    }
  }
  // 마지막 문자열이 아직 열려 있고 그게 답 문단(text)이면 그때까지 받은 글자를 읽는다.
  if (inString && depth === 3 && topKey === "sections" && sectionExpecting && sectionKey === "text" && current()) {
    current()!.partial = decodePartialString(text.slice(stringStart + 1));
  }

  return {
    mode,
    sections: sections.map((section) => ({
      questionRef: section.questionRef,
      refs: section.refs,
      paragraphs: paragraphsOf(section.text ?? section.partial ?? "", section.closed),
      closed: section.closed,
    })),
  };
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
