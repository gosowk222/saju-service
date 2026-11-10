import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";

/**
 * 테스트 전용 Postgres. Supabase의 기본 권한(모든 역할에 넓게 허용)을 흉내 낸 뒤
 * 실제 migration을 적용하므로, migration의 권한 축소와 RLS가 실제로 동작하는지 확인할 수 있다.
 */
/** 역할은 클러스터 전체에 하나라 이미 있으면 다시 만들지 않는다 (실제 Postgres로 반복 실행할 때). */
export const ROLES_SQL = `
  do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
    if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
  end $$;
`;

export const SCHEMA_SQL = `
  create schema auth;
  create table auth.users (
    id uuid primary key,
    email text,
    raw_user_meta_data jsonb not null default '{}'::jsonb,
    raw_app_meta_data jsonb not null default '{}'::jsonb,
    is_anonymous boolean not null default false,
    banned_until timestamptz,
    deleted_at timestamptz,
    created_at timestamptz not null default now()
  );
  -- Supabase Auth의 공식 연결 정보. 실제와 같이 service_role에는 읽기 권한을 주지 않는다.
  create table auth.identities (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users (id) on delete cascade,
    provider text not null,
    provider_id text not null,
    created_at timestamptz not null default now(),
    unique (provider, provider_id)
  );
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;
  grant usage on schema public to anon, authenticated, service_role;
  grant usage on schema auth to anon, authenticated, service_role;
  grant execute on function auth.uid() to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
`;

export const BOOTSTRAP = `${ROLES_SQL}\n${SCHEMA_SQL}`;

const MIGRATIONS_DIR = path.resolve(process.cwd(), "supabase/migrations");

export type DbRole = "anon" | "authenticated" | "service_role";

export interface TestDb {
  readonly pg: PGlite;
  /** 해당 역할과 사용자로 한 트랜잭션을 실행한다. PostgREST의 요청 처리와 같은 방식이다. */
  run<T = Record<string, unknown>>(role: DbRole, userId: string | null, sql: string, params?: unknown[]): Promise<T[]>;
  /** 사용자와 로그인 연결(identity)을 만든다. 기본은 카카오 하나다. 이미 있으면 빠진 연결만 더한다. */
  addUser(id: string, email?: string | null, providers?: readonly string[]): Promise<void>;
  close(): Promise<void>;
}

/** 실제 migration 파일을 이름 순서대로 읽는다. 실제 Postgres로 돌리는 동시성 테스트도 같은 목록을 쓴다. */
export function migrationSql(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .sort()
    .map((file) => readFileSync(path.join(MIGRATIONS_DIR, file), "utf8"));
}

/** 사용자와 identity를 넣는 SQL. provider_id는 테스트용 고정 형식이다. */
export const ADD_USER_SQL = `
  with u as (
    insert into auth.users (id, email) values ($1, $2) on conflict (id) do nothing returning id
  )
  insert into auth.identities (user_id, provider, provider_id)
  select $1, p, p || ':' || $1 from unnest($3::text[]) as p
  on conflict (provider, provider_id) do nothing`;

export async function createTestDb(): Promise<TestDb> {
  const pg = new PGlite();
  await pg.exec(BOOTSTRAP);
  for (const sql of migrationSql()) await pg.exec(sql);

  return {
    pg,
    run: <T>(role: DbRole, userId: string | null, sql: string, params: unknown[] = []) =>
      pg.transaction(async (tx) => {
        await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [userId ?? ""]);
        await tx.exec(`set local role ${role}`);
        const result = await tx.query<T>(sql, params);
        return result.rows;
      }) as Promise<T[]>,
    addUser: async (id, email = null, providers = ["kakao"]) => {
      await pg.query(ADD_USER_SQL, [id, email, providers]);
    },
    close: () => pg.close(),
  };
}
