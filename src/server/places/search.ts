import "server-only";
import dataset from "@/data/places/kr-places.json";

export interface PlaceRecord {
  readonly geonameId: number;
  readonly name: string;
  readonly admin1: string;
  readonly admin2: string | null;
  readonly aliases: readonly string[];
  readonly countryCode: string;
  readonly latitudeDeg: number;
  readonly longitudeDeg: number;
  readonly timezoneId: string;
  readonly featureCode: string;
  readonly population: number;
}

/** 브라우저로 보내는 최소 정보. 좌표와 시간대는 보내지 않는다. */
export interface PlaceSummary {
  readonly geonameId: number;
  readonly name: string;
  readonly admin: string;
}

const places = dataset.places as readonly PlaceRecord[];
export const PLACES_VERSION: string = dataset.version;
export const PLACE_SOURCE_PREFIX = "geonames";
export const MAX_RESULTS = 20;

const byId = new Map(places.map((place) => [place.geonameId, place]));

const normalize = (value: string) => value.toLowerCase().replace(/[\s·]/g, "");

function featureRank(code: string): number {
  if (code === "PPLC" || code === "PPLA" || code === "ADM2") return 0;
  if (code.startsWith("PPL")) return 1;
  return 2;
}

const indexed = places.map((place) => ({
  place,
  name: normalize(place.name),
  admin: normalize(`${place.admin1}${place.admin2 ?? ""}`),
  aliases: place.aliases.map(normalize),
  rank: featureRank(place.featureCode),
}));

export function adminLabel(place: Pick<PlaceRecord, "admin1" | "admin2" | "name">): string {
  if (place.admin2) return `${place.admin1} ${place.admin2}`;
  return place.admin1 === place.name ? "" : place.admin1;
}

export function placeLabel(place: PlaceRecord): string {
  const admin = adminLabel(place);
  return admin ? `${admin} ${place.name}` : place.name;
}

export function findPlace(geonameId: number): PlaceRecord | undefined {
  return byId.get(geonameId);
}

/** 이름을 먼저 맞추고, 여러 단어이면 상위 행정구역까지 함께 찾는다. */
export function searchPlaces(query: string, limit = MAX_RESULTS): PlaceSummary[] {
  const tokens = query.trim().split(/\s+/).map(normalize).filter(Boolean);
  if (tokens.length === 0 || query.length > 40) return [];

  const scored: { entry: (typeof indexed)[number]; score: number }[] = [];
  for (const entry of indexed) {
    const haystack = `${entry.name} ${entry.admin} ${entry.aliases.join(" ")}`;
    if (!tokens.every((token) => haystack.includes(token))) continue;

    const main = tokens[tokens.length - 1]!;
    let score = 9;
    if (entry.name === main) score = 0;
    else if (entry.name.startsWith(main)) score = 1;
    else if (entry.aliases.includes(main)) score = 2;
    else if (entry.aliases.some((alias) => alias.startsWith(main))) score = 3;
    else if (entry.name.includes(main)) score = 4;
    else if (entry.admin.includes(main)) score = 5;
    scored.push({ entry, score });
  }

  scored.sort(
    (a, b) =>
      a.score - b.score ||
      a.entry.rank - b.entry.rank ||
      b.entry.place.population - a.entry.place.population ||
      a.entry.place.geonameId - b.entry.place.geonameId,
  );

  return scored.slice(0, limit).map(({ entry }) => ({
    geonameId: entry.place.geonameId,
    name: entry.place.name,
    admin: adminLabel(entry.place),
  }));
}
