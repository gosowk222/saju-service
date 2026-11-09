/**
 * GeoNames 한국 출생지역 가져오기.
 *
 *   npm run places:import                공식 자료를 내려받아 다시 만든다
 *   npm run places:import -- --offline   data/geonames-raw 의 저장본으로 다시 만든다
 *
 * 포함·제외와 중복 처리 기준의 설명은 docs/GEONAMES_DATA.md 에 있다.
 * 검증을 통과하기 전에는 기존 결과 파일을 건드리지 않는다.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { strFromU8, unzipSync } from "fflate";

const BASE = "https://download.geonames.org/export/dump";
const SOURCES = {
  main: { url: `${BASE}/KR.zip`, file: "KR.zip" },
  alternates: { url: `${BASE}/alternatenames/KR.zip`, file: "alternatenames-KR.zip" },
  admin1: { url: `${BASE}/admin1CodesASCII.txt`, file: "admin1CodesASCII.txt" },
} as const;
type SourceKey = keyof typeof SOURCES;

const RAW_DIR = path.resolve("data/geonames-raw");
const OUT_DIR = path.resolve("src/data/places");
const OUT_DATA = path.join(OUT_DIR, "kr-places.json");
const OUT_META = path.join(OUT_DIR, "kr-places.meta.json");

/** 결과가 이보다 적으면 자료 이상으로 보고 중단한다. */
const MIN_RESULT_COUNT = 1500;
/** 대한민국 영역을 넉넉하게 감싼 범위. 위도·경도가 뒤바뀐 행을 잡아낸다. */
const KR_BOUNDS = { minLat: 32.5, maxLat: 39, minLon: 124, maxLon: 132 };
const HANGUL_NAME = /^[가-힣]+(?:[ ·][가-힣]+)*$/;

/** 포함할 분류 코드와 정렬 순위(낮을수록 앞). */
const FEATURE_RANK: Readonly<Record<string, number>> = {
  "P.PPLC": 0,
  "P.PPLA": 1,
  "A.ADM2": 2,
  "P.PPLA2": 3,
  "P.PPLA3": 4,
  "P.PPLA4": 4,
  "P.PPL": 5,
  "A.ADM3": 6,
};

/**
 * 자료의 한국어 이름을 바로잡아야 할 때만 쓰는 표. geonameId와 근거를 함께 적는다.
 * 현재 보정할 항목은 없다.
 */
const NAME_OVERRIDES: Readonly<Record<string, { name: string; reason: string }>> = {};

const COL = {
  id: 0,
  name: 1,
  ascii: 2,
  alternates: 3,
  lat: 4,
  lon: 5,
  fclass: 6,
  fcode: 7,
  country: 8,
  admin1: 10,
  admin2: 11,
  population: 14,
  timezone: 17,
} as const;
const ALT = { id: 1, lang: 2, name: 3, preferred: 4, short: 5, colloquial: 6, historic: 7 } as const;

export type PlaceRecord = {
  geonameId: number;
  name: string;
  admin1: string;
  admin2: string | null;
  aliases: string[];
  countryCode: "KR";
  latitudeDeg: number;
  longitudeDeg: number;
  timezoneId: string;
  featureCode: string;
  population: number;
};

type Ranked = PlaceRecord & { rank: number };
type KoreanNames = { preferred: string[]; others: string[] };

function fail(message: string): never {
  throw new Error(`[places:import] ${message}`);
}

async function loadSource(key: SourceKey, offline: boolean): Promise<Uint8Array> {
  const { url, file } = SOURCES[key];
  const cached = path.join(RAW_DIR, file);
  if (offline) {
    if (!existsSync(cached)) fail(`저장본이 없습니다: ${cached}`);
    return new Uint8Array(readFileSync(cached));
  }
  const response = await fetch(url, { signal: AbortSignal.timeout(180_000) });
  if (!response.ok) fail(`다운로드 실패 ${response.status}: ${url}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0) fail(`빈 파일: ${url}`);
  mkdirSync(RAW_DIR, { recursive: true });
  writeFileSync(cached, bytes);
  return bytes;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function readZipEntry(bytes: Uint8Array, entry: string): string {
  const files = unzipSync(bytes, { filter: (file) => file.name === entry });
  const data = files[entry];
  if (!data) fail(`압축 파일에 ${entry}가 없습니다.`);
  return strFromU8(data);
}

function table(text: string): string[][] {
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => line.split("\t"));
}

function collectKoreanNames(rows: string[][]): Map<string, KoreanNames> {
  const byId = new Map<string, KoreanNames>();
  for (const row of rows) {
    if (row[ALT.lang] !== "ko") continue;
    if (row[ALT.historic] === "1" || row[ALT.colloquial] === "1") continue;
    const name = (row[ALT.name] ?? "").trim();
    if (!HANGUL_NAME.test(name)) continue;
    const id = row[ALT.id]!;
    const entry = byId.get(id) ?? { preferred: [], others: [] };
    (row[ALT.preferred] === "1" ? entry.preferred : entry.others).push(name);
    byId.set(id, entry);
  }
  for (const entry of byId.values()) {
    entry.preferred = [...new Set(entry.preferred)].sort();
    entry.others = [...new Set(entry.others)].sort();
  }
  return byId;
}

/** 행정구역은 시·군·구 글자가 붙은 공식 이름을 먼저 고른다. */
function pickKoreanName(row: string[], korean: KoreanNames | undefined): string | null {
  const override = NAME_OVERRIDES[row[COL.id]!];
  if (override) return override.name;
  const candidates = [...(korean?.preferred ?? []), ...(korean?.others ?? [])];
  if (row[COL.fclass] === "A") {
    const official = candidates.find((name) => /[시군구읍면동]$/.test(name));
    if (official) return official;
  }
  if (candidates[0]) return candidates[0];
  // 언어 표시가 없는 기본 표의 대체 이름에서 한글 이름을 찾는다.
  const fromColumn = (row[COL.alternates] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => HANGUL_NAME.test(value))
    .sort((a, b) => a.length - b.length || a.localeCompare(b, "ko"));
  return fromColumn[0] ?? null;
}

/** 시·군·구·읍·면 글자를 뺀 이름. 동(洞)은 다른 지역과 겹치기 쉬워 그대로 둔다. */
function baseName(name: string): string {
  return name.replace(/(특별자치시|특별자치도|특별시|광역시|시|군|구|읍|면)$/u, "");
}

const compareAlias = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function buildAliases(row: string[], name: string, korean: KoreanNames | undefined): string[] {
  const values = new Set<string>();
  for (const value of [...(korean?.preferred ?? []), ...(korean?.others ?? [])]) values.add(value);
  for (const value of (row[COL.alternates] ?? "").split(",")) {
    const trimmed = value.trim();
    if (HANGUL_NAME.test(trimmed)) values.add(trimmed);
  }
  values.add(row[COL.ascii]!);
  values.delete(name);
  return [...values].sort(compareAlias).slice(0, 8);
}

function validate(records: readonly PlaceRecord[]): void {
  if (records.length < MIN_RESULT_COUNT) fail(`결과가 너무 적습니다: ${records.length}건`);
  const ids = new Set<number>();
  for (const record of records) {
    const where = `geonameId ${record.geonameId}`;
    if (record.countryCode !== "KR") fail(`${where}: KR이 아닙니다.`);
    if (ids.has(record.geonameId)) fail(`${where}: 중복입니다.`);
    ids.add(record.geonameId);
    if (!Number.isFinite(record.latitudeDeg) || !Number.isFinite(record.longitudeDeg)) {
      fail(`${where}: 좌표가 숫자가 아닙니다.`);
    }
    if (Math.abs(record.latitudeDeg) > 90 || Math.abs(record.longitudeDeg) > 180) {
      fail(`${where}: 좌표 범위를 벗어났습니다.`);
    }
    const inKorea =
      record.latitudeDeg >= KR_BOUNDS.minLat &&
      record.latitudeDeg <= KR_BOUNDS.maxLat &&
      record.longitudeDeg >= KR_BOUNDS.minLon &&
      record.longitudeDeg <= KR_BOUNDS.maxLon;
    if (!inKorea) fail(`${where}: 한국 범위 밖이거나 위도·경도가 뒤바뀌었습니다.`);
    if (!HANGUL_NAME.test(record.name)) fail(`${where}: 이름이 올바르지 않습니다.`);
    if (!record.admin1) fail(`${where}: 상위 행정구역이 없습니다.`);
    try {
      new Intl.DateTimeFormat("en", { timeZone: record.timezoneId });
    } catch {
      fail(`${where}: 시간대가 올바르지 않습니다.`);
    }
  }
}

async function main() {
  const offline = process.argv.includes("--offline");
  const [mainZip, altZip, admin1Bytes] = await Promise.all([
    loadSource("main", offline),
    loadSource("alternates", offline),
    loadSource("admin1", offline),
  ]);

  const rows = table(readZipEntry(mainZip, "KR.txt"));
  const altRows = table(readZipEntry(altZip, "KR.txt"));
  const koreanNames = collectKoreanNames(altRows);

  const admin1Names = new Map<string, string>();
  for (const [code, , , id] of table(strFromU8(admin1Bytes))) {
    if (!code!.startsWith("KR.")) continue;
    const names = koreanNames.get(id!);
    const name =
      names?.preferred[0] ?? names?.others.find((value) => /[시도]$/.test(value)) ?? names?.others[0];
    if (!name) fail(`시·도 이름을 찾지 못했습니다: ${code}`);
    admin1Names.set(code!.slice(3), name);
  }

  const admin2Names = new Map<string, string>();
  for (const row of rows) {
    if (row[COL.fclass] !== "A" || row[COL.fcode] !== "ADM2") continue;
    const name = pickKoreanName(row, koreanNames.get(row[COL.id]!));
    if (name) admin2Names.set(`${row[COL.admin1]}.${row[COL.admin2]}`, name);
  }

  const stats = {
    excludedByFeature: 0,
    excludedUnpopulatedPpl: 0,
    excludedNoKoreanName: 0,
    excludedNoAdmin: 0,
    mergedDuplicates: 0,
  };
  const selected: Ranked[] = [];

  for (const row of rows) {
    const featureKey = `${row[COL.fclass]}.${row[COL.fcode]}`;
    const rank = FEATURE_RANK[featureKey];
    if (rank === undefined) {
      stats.excludedByFeature += 1;
      continue;
    }
    const population = Number(row[COL.population] ?? 0);
    if (featureKey === "P.PPL" && population <= 0) {
      stats.excludedUnpopulatedPpl += 1;
      continue;
    }
    if (row[COL.country] !== "KR") fail(`KR이 아닌 행: ${row[COL.id]}`);
    const korean = koreanNames.get(row[COL.id]!);
    const name = pickKoreanName(row, korean);
    if (!name) {
      stats.excludedNoKoreanName += 1;
      continue;
    }
    const admin1 = admin1Names.get(row[COL.admin1]!);
    if (!admin1) {
      stats.excludedNoAdmin += 1;
      continue;
    }
    const admin2 = admin2Names.get(`${row[COL.admin1]}.${row[COL.admin2]}`) ?? null;
    selected.push({
      geonameId: Number(row[COL.id]),
      name,
      admin1,
      admin2: admin2 === name ? null : admin2,
      aliases: buildAliases(row, name, korean),
      countryCode: "KR",
      latitudeDeg: Number(row[COL.lat]),
      longitudeDeg: Number(row[COL.lon]),
      timezoneId: row[COL.timezone]!,
      featureCode: row[COL.fcode]!,
      population,
      rank,
    });
  }

  // 같은 곳을 가리키는 행을 하나로 합친다. 공식 이름이 있는 행정구역 행을 먼저 남기고,
  // 진 행의 이름은 별칭으로 옮긴다.
  const isAdmin = (record: Ranked) => (record.featureCode.startsWith("ADM") ? 0 : 1);
  selected.sort(
    (a, b) =>
      isAdmin(a) - isAdmin(b) ||
      a.rank - b.rank ||
      b.population - a.population ||
      a.geonameId - b.geonameId,
  );
  const seen = new Map<string, Ranked>();
  const unique: Ranked[] = [];
  for (const record of selected) {
    const key = `${record.admin1}|${record.admin2 ?? ""}|${baseName(record.name)}`;
    // 시·군 자체 행과 그 안의 같은 이름 중심지(PPL 계열)는 같은 곳으로 본다.
    const isSeatOfSameName =
      record.featureCode.startsWith("PPL") &&
      record.admin2 !== null &&
      baseName(record.admin2) === baseName(record.name);
    const winner =
      seen.get(key) ??
      (isSeatOfSameName ? seen.get(`${record.admin1}||${baseName(record.admin2!)}`) : undefined);
    if (winner) {
      stats.mergedDuplicates += 1;
      if (record.name !== winner.name) {
        winner.aliases = [...new Set([...winner.aliases, record.name])].sort(compareAlias).slice(0, 8);
      }
      continue;
    }
    seen.set(key, record);
    unique.push(record);
  }

  const records: PlaceRecord[] = unique
    .sort((a, b) => a.geonameId - b.geonameId)
    .map(({ rank: _rank, ...record }) => record);

  validate(records);

  const hashes = {
    "KR.zip": sha256(mainZip),
    "alternatenames/KR.zip": sha256(altZip),
    "admin1CodesASCII.txt": sha256(admin1Bytes),
  };
  const version = `geonames-kr-${createHash("sha256").update(JSON.stringify(hashes)).digest("hex").slice(0, 12)}`;

  const previous = existsSync(OUT_META)
    ? (JSON.parse(readFileSync(OUT_META, "utf8")) as { version?: string; downloadedOn?: string })
    : null;
  const downloadedOn =
    previous?.version === version && previous.downloadedOn
      ? previous.downloadedOn
      : new Date().toISOString().slice(0, 10);

  const byFeature: Record<string, number> = {};
  for (const record of records) byFeature[record.featureCode] = (byFeature[record.featureCode] ?? 0) + 1;

  const meta = {
    version,
    downloadedOn,
    license: "CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/)",
    attribution: "GeoNames (https://www.geonames.org/)",
    sources: Object.values(SOURCES).map((source) => source.url),
    sha256: hashes,
    counts: {
      rawRows: rows.length,
      alternateNameRows: altRows.length,
      finalRecords: records.length,
      ...stats,
      byFeature: Object.fromEntries(Object.entries(byFeature).sort()),
    },
    nameOverrides: NAME_OVERRIDES,
    rerun: "npm run places:import",
  };

  mkdirSync(OUT_DIR, { recursive: true });
  // 임시 파일에 모두 쓴 뒤 이름을 바꿔서, 중간 실패로 정상 자료가 망가지지 않게 한다.
  const dataTemp = `${OUT_DATA}.tmp`;
  const metaTemp = `${OUT_META}.tmp`;
  writeFileSync(dataTemp, `${JSON.stringify({ version, places: records })}\n`);
  writeFileSync(metaTemp, `${JSON.stringify(meta, null, 2)}\n`);
  renameSync(dataTemp, OUT_DATA);
  renameSync(metaTemp, OUT_META);
  console.log(JSON.stringify({ version, ...meta.counts }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  console.error("[places:import] 기존 자료는 변경하지 않았습니다.");
  process.exit(1);
});
