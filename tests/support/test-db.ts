import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";

/**
 * 테스트 전용 Postgres. Supabase의 기본 권한(모든 역할에 넓게 허용)을 흉내 낸 뒤
 * 실제 migration을 적용하므로, migration의 권한 축소와 RLS가 실제로 동작하는지 확인할 수 있다.
 */
const BOOTSTRAP = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  create schema auth;
  create table auth.users (
    id uuid primary key,
    email text,
    raw_user_meta_data jsonb not null default '{}'::jsonb
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

const MIGRATIONS_DIR = path.resolve(process.cwd(), "supabase/migrations");

export type DbRole = "anon" | "authenticated" | "service_role";

export interface TestDb {
  readonly pg: PGlite;
  /** 해당 역할과 사용자로 한 트랜잭션을 실행한다. PostgREST의 요청 처리와 같은 방식이다. */
  run<T = Record<string, unknown>>(role: DbRole, userId: string | null, sql: string, params?: unknown[]): Promise<T[]>;
  addUser(id: string, email?: string | null): Promise<void>;
  close(): Promise<void>;
}

export async function createTestDb(): Promise<TestDb> {
  const pg = new PGlite();
  await pg.exec(BOOTSTRAP);
  for (const file of readdirSync(MIGRATIONS_DIR).sort()) {
    await pg.exec(readFileSync(path.join(MIGRATIONS_DIR, file), "utf8"));
  }

  return {
    pg,
    run: <T>(role: DbRole, userId: string | null, sql: string, params: unknown[] = []) =>
      pg.transaction(async (tx) => {
        await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [userId ?? ""]);
        await tx.exec(`set local role ${role}`);
        const result = await tx.query<T>(sql, params);
        return result.rows;
      }) as Promise<T[]>,
    addUser: async (id, email = null) => {
      await pg.query(`insert into auth.users (id, email) values ($1, $2) on conflict do nothing`, [id, email]);
    },
    close: () => pg.close(),
  };
}
