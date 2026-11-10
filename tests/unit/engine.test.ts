import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { BIRTH_BRANCH_VALUES, PublicBirthInputSchema } from "sajuengine";
import { describe, expect, it } from "vitest";
import { BRANCH_OPTIONS } from "@/domain/birth/input";
import { FIRST_OVERVIEW } from "@/domain/products/first-overview";
import { ENGINE_PACKAGE, analyzeBirth, branchRangesFor, toPublicBirthInput, type AnalyzeInput } from "@/server/engine/analyze";

const place = { timezoneId: "Asia/Seoul", longitudeDeg: 126.9784, latitudeDeg: 37.566, label: "서울특별시", source: "geonames:1835848" };

const base: AnalyzeInput = {
  birthDate: "1998-09-19",
  calendar: "solar",
  isLeapMonth: false,
  gender: "female",
  birthTime: { status: "branch", branch: "신" },
  birthPlace: place,
};

function analyze(input: AnalyzeInput = base) {
  return analyzeBirth({
    birth: toPublicBirthInput(input),
    product: FIRST_OVERVIEW,
    nickname: "달빛",
    situationId: "employee",
  });
}

describe("sajuengine 연결", () => {
  it("설치 파일이 기록한 해시와 같다", () => {
    const hash = createHash("sha256").update(readFileSync("vendor/sajuengine-0.1.0.tgz")).digest("hex");
    expect(hash).toBe(ENGINE_PACKAGE.tarballSha256);
    expect(JSON.parse(readFileSync("package.json", "utf8")).dependencies.sajuengine).toBe("file:vendor/sajuengine-0.1.0.tgz");
  });

  it("시진 선택지가 엔진의 공개 값과 일치한다", () => {
    expect(BRANCH_OPTIONS.map((option) => option.value)).toEqual([...BIRTH_BRANCH_VALUES]);
  });

  it("자시 새벽과 밤을 다른 값으로 전달한다", () => {
    const dawn = toPublicBirthInput({ ...base, birthTime: { status: "branch", branch: "자-새벽" } });
    const night = toPublicBirthInput({ ...base, birthTime: { status: "branch", branch: "자-밤" } });
    expect(dawn.birthTime).toEqual({ status: "branch", branch: "자-새벽" });
    expect(night.birthTime).toEqual({ status: "branch", branch: "자-밤" });
    expect(analyze({ ...base, birthTime: { status: "branch", branch: "자-새벽" } }).engineMeta.fingerprint).not.toBe(
      analyze({ ...base, birthTime: { status: "branch", branch: "자-밤" } }).engineMeta.fingerprint,
    );
  });

  it("시간 모름을 임의의 시각으로 바꾸지 않고 시주를 비운다", () => {
    const birth = toPublicBirthInput({ ...base, birthTime: { status: "unknown" } });
    expect(birth.birthTime).toEqual({ status: "unknown" });
    const result = analyze({ ...base, birthTime: { status: "unknown" } });
    const hour = result.chart.pillars.find((pillar) => pillar.key === "hour")!;
    expect(hour.stem).toBeNull();
    expect(hour.branch).toBeNull();
    expect(result.chart.hourKnown).toBe(false);
    expect(result.plan.hourKnown).toBe(false);
    expect(result.preview.limitNotes.length).toBeGreaterThan(0);
  });

  it("birthPlace에는 공개 스키마의 값만 넣는다", () => {
    const birth = toPublicBirthInput(base);
    expect(Object.keys(birth.birthPlace).sort()).toEqual(["label", "latitudeDeg", "longitudeDeg", "source", "timezoneId"]);
    expect(() =>
      PublicBirthInputSchema.parse({
        birthDate: "1998-09-19",
        birthTime: { status: "unknown" },
        gender: "female",
        calendar: { type: "solar" },
        birthPlace: { ...place, geonameId: 1835848 },
      }),
    ).toThrow();
  });

  it("위도는 기록용이라 계산 결과에 영향을 주지 않는다", () => {
    const moved = analyze({ ...base, birthPlace: { ...place, latitudeDeg: 33.1 } });
    expect(moved.engineMeta.fingerprint).toBe(analyze().engineMeta.fingerprint);
  });

  it("음력 입력을 음력 날짜와 윤달 값으로 전달한다", () => {
    const birth = toPublicBirthInput({ ...base, birthDate: "2023-02-15", calendar: "lunar", isLeapMonth: true });
    expect(birth.calendar).toEqual({ type: "lunar", isLeapMonth: true });
    expect(birth.birthDate).toBe("2023-02-15");
    expect(analyze({ ...base, birthDate: "2023-02-15", calendar: "lunar", isLeapMonth: true }).chart.dayMaster).not.toBeNull();
  });

  it("시진 범위를 엔진의 공개 함수로 계산한다", () => {
    const ranges = branchRangesFor({ birthDate: "1998-09-19", calendar: "solar", isLeapMonth: false, timezoneId: "Asia/Seoul", longitudeDeg: 126.978 });
    expect(Object.keys(ranges)).toHaveLength(13);
    expect(ranges["자-새벽"]).toEqual({ start: "00:32", end: "01:32" });
  });
});

describe("작성 재료", () => {
  it("여섯 주제를 만들고 계산, 해석, 사용자 상황을 구분한다", () => {
    const { plan, trace } = analyze();
    expect(plan.planVersion).toBe("2.0.0");
    expect(plan.topics.map((topic) => topic.topicId)).toEqual(FIRST_OVERVIEW.topics.map((topic) => topic.id));
    expect(plan.facts.every((fact) => fact.kind === "engine-fact")).toBe(true);
    // 궁금한 점의 원문은 작성 재료에 넣지 않는다. 범위를 판정한 뒤 생성 단계에서 정리된 값만 더한다.
    expect(plan.userContext).toEqual([{ ref: "u1", kind: "user-context", text: "사용자가 고른 현재 상황: 직장인", source: "situation" }]);
    expect(plan.situation?.context).toContain("회사");
    expect(trace).toHaveLength(6);
    for (const topic of trace) {
      expect(topic.policyVersion).toBe("1.1.0");
      for (const conclusion of topic.conclusions) {
        expect(conclusion.supportingEvidenceIds.length).toBeGreaterThan(0);
      }
    }
  });

  it("앱 규칙의 판단을 채택 근거로 남긴다", () => {
    const { plan, trace } = analyze();
    const adopted = plan.topics.filter((topic) => topic.status === "adopted");
    expect(adopted.length).toBeGreaterThan(0);
    expect(adopted[0]!.statements[0]!.ruleId).toBe("first-overview.temperament");
    expect(trace[0]!.conclusions.some((conclusion) => conclusion.adopted)).toBe(true);
  });

  it("맛보기는 계산 결과에 따라 달라지고 유료 본문을 담지 않는다", () => {
    const first = analyze();
    const other = analyze({ ...base, birthDate: "1990-03-02", birthTime: { status: "branch", branch: "오" } });
    expect(first.preview.bubbles[0]).not.toBe(other.preview.bubbles[0]);
    expect(first.preview.bubbles.length).toBeLessThanOrEqual(2);
  });

  it("같은 입력은 같은 결과를 낸다", () => {
    expect(analyze().engineMeta.fingerprint).toBe(analyze().engineMeta.fingerprint);
  });

  it("캐릭터는 계산과 판단 재료를 바꾸지 않는다", () => {
    const { plan } = analyze();
    expect(plan.topics[0]!.statements[0]!.text).not.toContain("여울");
  });

  it("판단마다 상품 항목, 이유, 근거가 있는 약점을 함께 남긴다", () => {
    const { plan } = analyze();
    for (const topic of plan.topics) {
      expect(topic.statements.length).toBeGreaterThanOrEqual(2);
      for (const statement of topic.statements) {
        expect(topic.outline).toContain(statement.aspect);
        expect(statement.basis?.length).toBeGreaterThan(0);
      }
    }
    expect(plan.topics.flatMap((topic) => topic.statements).filter((statement) => statement.weakness).length).toBeGreaterThanOrEqual(6);
  });

  it("상황을 바꾸면 같은 사주라도 주제 비중과 관점이 바뀌고 판단은 그대로다", () => {
    const employee = analyze().plan;
    const seeking = analyzeBirth({ birth: toPublicBirthInput(base), product: FIRST_OVERVIEW, nickname: "달빛", situationId: "job-seeking" }).plan;
    expect(employee.topics.map((topic) => topic.statements.map((item) => item.text))).toEqual(seeking.topics.map((topic) => topic.statements.map((item) => item.text)));
    expect(employee.topics.map((topic) => topic.weight)).not.toEqual(seeking.topics.map((topic) => topic.weight));
    expect(employee.topics.find((topic) => topic.topicId === "work")!.situationAngle).not.toBe(seeking.topics.find((topic) => topic.topicId === "work")!.situationAngle);
  });
});
