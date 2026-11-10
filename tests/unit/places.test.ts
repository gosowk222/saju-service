import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import dataset from "@/data/places/kr-places.json";
import { MAX_RESULTS, findPlace, placeLabel, searchPlaces } from "@/server/places/search";

const meta = JSON.parse(readFileSync("src/data/places/kr-places.meta.json", "utf8"));

describe("출생지역 자료", () => {
  it("모든 항목이 한국 지역이고 값이 유효하다", () => {
    const ids = new Set<number>();
    for (const place of dataset.places) {
      expect(place.countryCode).toBe("KR");
      expect(ids.has(place.geonameId)).toBe(false);
      ids.add(place.geonameId);
      expect(place.latitudeDeg).toBeGreaterThan(32.5);
      expect(place.latitudeDeg).toBeLessThan(39);
      expect(place.longitudeDeg).toBeGreaterThan(124);
      expect(place.longitudeDeg).toBeLessThan(132);
      expect(place.timezoneId).toBe("Asia/Seoul");
      expect(place.name).toMatch(/[가-힣]/);
    }
    expect(dataset.places.length).toBe(meta.counts.finalRecords);
  });

  it("원본 정보와 재실행 방법을 기록한다", () => {
    expect(meta.version).toBe(dataset.version);
    expect(meta.sources[0]).toBe("https://download.geonames.org/export/dump/KR.zip");
    expect(meta.sha256["KR.zip"]).toMatch(/^[0-9a-f]{64}$/);
    expect(meta.downloadedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(meta.rerun).toContain("places:import");
    expect(meta.counts.rawRows).toBeGreaterThan(meta.counts.finalRecords);
    expect(meta.license).toContain("CC BY 4.0");
  });
});

describe("지역 검색", () => {
  it.each(["서울", "부산", "대구", "인천", "광주", "대전", "울산", "세종", "제주", "수원", "창원", "청주"])(
    "주요 도시 %s를 찾는다",
    (query) => {
      expect(searchPlaces(query).length).toBeGreaterThan(0);
    },
  );

  it.each(["강남구", "해운대구", "춘천", "안동", "남원", "김천", "청송", "의성", "완도", "보은", "양평", "평창", "울릉", "단양", "강진", "왜관"])(
    "중소 지역 %s를 찾는다",
    (query) => {
      expect(searchPlaces(query).length).toBeGreaterThan(0);
    },
  );

  it("이름이 맞는 곳을 앞에 둔다", () => {
    expect(searchPlaces("서울")[0]!.name).toBe("서울특별시");
    expect(searchPlaces("해운대")[0]!.name).toBe("해운대구");
  });

  it("같은 이름의 지역을 상위 행정구역으로 구분한다", () => {
    const results = searchPlaces("고성군");
    expect(results.map((place) => place.admin)).toEqual(expect.arrayContaining(["강원도", "경상남도"]));
    const admins = results.filter((place) => place.name === "고성군").map((place) => place.admin);
    expect(new Set(admins).size).toBe(admins.length);
  });

  it("상위 행정구역과 함께 검색할 수 있다", () => {
    expect(searchPlaces("경상남도 고성")[0]).toMatchObject({ name: "고성군", admin: "경상남도" });
  });

  it("결과가 없으면 빈 목록을 돌려주고 다른 곳을 고르지 않는다", () => {
    expect(searchPlaces("뉴욕")).toEqual([]);
    expect(searchPlaces("   ")).toEqual([]);
  });

  it("결과 수를 제한하고 좌표는 브라우저로 보내지 않는다", () => {
    const results = searchPlaces("동");
    expect(results.length).toBeLessThanOrEqual(MAX_RESULTS);
    expect(Object.keys(results[0]!).sort()).toEqual(["admin", "geonameId", "name"]);
  });
});

describe("서버의 지역 조회", () => {
  it("존재하지 않는 ID는 찾지 못한다", () => {
    expect(findPlace(1)).toBeUndefined();
    expect(findPlace(99999999)).toBeUndefined();
  });

  it("한국 이외 지역 ID는 자료에 없다 (도쿄 1850147)", () => {
    expect(findPlace(1850147)).toBeUndefined();
  });

  it("자료의 위도와 경도를 그대로 돌려준다", () => {
    const seoul = findPlace(1835848)!;
    expect(seoul).toMatchObject({ latitudeDeg: 37.566, longitudeDeg: 126.9784, timezoneId: "Asia/Seoul" });
    expect(placeLabel(seoul)).toBe("서울특별시");
  });
});
