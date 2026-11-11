-- 최초 풀이 토큰 사용량을 생성 시도마다 남긴다.
--
-- 이전에는 generation_jobs.usage에 완료한 시도의 사용량만 남았다. 실패한 시도(검사 실패, 형식 오류, 시간 초과)와
-- 다른 요청이 이어받은 시도의 토큰은 어디에도 남지 않았고, usage를 받지 못한 호출(중간에 끊은 스트림)은 0으로 더해졌다.
-- 이제 서버가 시도 하나가 끝날 때마다(완료·실패·이어받음) record_generation_attempt로 한 줄을 남긴다.
--
-- 집계 규칙 (src/server/llm/usage.ts)
-- - input_tokens에는 cached_input_tokens가 포함되어 있다. 캐시되지 않은 입력 = input_tokens - cached_input_tokens.
-- - output_tokens에는 reasoning_tokens가 포함되어 있다.
-- - total_tokens = input_tokens + output_tokens (캐시·추론을 다시 더하지 않는다).
-- - usage를 받지 못한 호출이 있으면 calls_without_usage > 0, usage_complete = false다. 받지 못한 값은 0이 아니라 모르는 값이다.
--
-- 이 테이블은 서버 전용이다. 브라우저 역할(anon, authenticated)은 읽을 수 없다. 출생정보, 대화, 프롬프트 원문은 넣지 않는다.

create table public.generation_attempts (
  reading_id uuid not null references public.readings (id) on delete cascade,
  attempt integer not null check (attempt > 0),
  user_id uuid not null references auth.users (id) on delete cascade,
  outcome text not null check (outcome in ('completed', 'failed', 'handed_over')),
  error_code text,
  -- 마지막 검사에서 걸린 문제의 종류 (생성 문장과 질문 원문은 서버가 빼고 보낸다).
  issues jsonb not null default '[]'::jsonb,
  model_id text,
  actual_model text,
  prompt_version text,
  schema_version text,
  persona_version text,
  reasoning_effort text,
  llm_calls integer not null default 0 check (llm_calls >= 0),
  calls_without_usage integer not null default 0 check (calls_without_usage >= 0),
  input_tokens bigint check (input_tokens >= 0),
  cached_input_tokens bigint check (cached_input_tokens >= 0),
  output_tokens bigint check (output_tokens >= 0),
  reasoning_tokens bigint check (reasoning_tokens >= 0),
  total_tokens bigint generated always as (input_tokens + output_tokens) stored,
  usage_complete boolean not null,
  duration_ms integer,
  created_at timestamptz not null default now(),
  primary key (reading_id, attempt),
  constraint generation_attempts_complete_check check (
    not usage_complete or (calls_without_usage = 0 and input_tokens is not null and output_tokens is not null)
  )
);

revoke all on table public.generation_attempts from anon, authenticated, public;
grant all on table public.generation_attempts to service_role;
-- 정책을 만들지 않는다. RLS가 켜져 있어 브라우저 역할은 읽을 수 없고, 서버(service_role)만 접근한다.
alter table public.generation_attempts enable row level security;

-- 시도 하나의 사용량을 남긴다. 같은 시도를 다시 보내면(재전송, 중복 요청) 처음 기록을 그대로 두어 두 번 더해지지 않는다.
-- 실제로 새 호출을 한 재시도는 claim_generation이 attempts를 올리므로 다른 줄로 남는다.
create function public.record_generation_attempt(p_reading_id uuid, p_attempt integer, p_outcome text, p_record jsonb)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_job public.generation_jobs;
  v_usage jsonb := coalesce(p_record -> 'usage', '{}'::jsonb);
  v_count integer;
begin
  select * into v_job from public.generation_jobs where reading_id = p_reading_id;
  -- 시작하지 않은 시도 번호는 받지 않는다.
  if not found or p_attempt < 1 or p_attempt > v_job.attempts then
    return false;
  end if;

  insert into public.generation_attempts (
    reading_id, attempt, user_id, outcome, error_code, issues, model_id, actual_model, prompt_version, schema_version,
    persona_version, reasoning_effort, llm_calls, calls_without_usage, input_tokens, cached_input_tokens, output_tokens,
    reasoning_tokens, usage_complete, duration_ms
  ) values (
    p_reading_id, p_attempt, v_job.user_id, p_outcome, p_record ->> 'errorCode',
    case when jsonb_typeof(p_record -> 'issues') = 'array' then p_record -> 'issues' else '[]'::jsonb end,
    p_record ->> 'modelId', p_record ->> 'actualModel', p_record ->> 'promptVersion', p_record ->> 'schemaVersion',
    p_record ->> 'personaVersion', p_record ->> 'reasoningEffort',
    coalesce((v_usage ->> 'calls')::integer, 0),
    coalesce((v_usage ->> 'callsWithoutUsage')::integer, 0),
    (v_usage ->> 'inputTokens')::bigint,
    (v_usage ->> 'cachedInputTokens')::bigint,
    (v_usage ->> 'outputTokens')::bigint,
    (v_usage ->> 'reasoningTokens')::bigint,
    coalesce((v_usage ->> 'complete')::boolean, false),
    (p_record ->> 'durationMs')::integer
  )
  on conflict (reading_id, attempt) do nothing;
  get diagnostics v_count = row_count;
  return v_count = 1;
end;
$$;

revoke all on function public.record_generation_attempt(uuid, integer, text, jsonb) from public, anon, authenticated;
grant execute on function public.record_generation_attempt(uuid, integer, text, jsonb) to service_role;

-- 풀이 하나의 최초 풀이 사용량 합계. 운영자가 reading_id로 조회한다 (docs/LLM_OPERATIONS.md의 조회 SQL).
-- usage_complete는 모든 시도가 기록됐고(attempts와 기록 수가 같고) 모든 호출의 usage를 받았을 때만 true다.
-- 이 기록을 만들기 전(이 migration 이전)에 끝난 풀이는 시도 기록이 없어 recorded_attempts가 0이다. 그 풀이는
-- generation_jobs.usage(완료한 시도만)로 따로 본다. 없는 값을 0으로 채우지 않는다.
create view public.generation_usage with (security_invoker = true) as
select
  j.reading_id,
  j.status,
  j.attempts,
  count(a.attempt)::integer as recorded_attempts,
  j.model_id,
  j.prompt_version,
  j.reasoning_effort,
  (array_agg(a.persona_version order by a.attempt desc) filter (where a.persona_version is not null))[1] as persona_version,
  (array_agg(a.actual_model order by a.attempt desc) filter (where a.actual_model is not null))[1] as actual_model,
  coalesce(sum(a.llm_calls), 0)::integer as llm_calls,
  coalesce(sum(a.calls_without_usage), 0)::integer as calls_without_usage,
  sum(a.input_tokens) as input_tokens,
  sum(a.cached_input_tokens) as cached_input_tokens,
  sum(a.input_tokens) - sum(a.cached_input_tokens) as uncached_input_tokens,
  sum(a.output_tokens) as output_tokens,
  sum(a.reasoning_tokens) as reasoning_tokens,
  sum(a.total_tokens) as total_tokens,
  (count(a.attempt) = j.attempts and coalesce(bool_and(a.usage_complete), false)) as usage_complete,
  j.completed_at
from public.generation_jobs j
left join public.generation_attempts a on a.reading_id = j.reading_id
group by j.reading_id, j.status, j.attempts, j.model_id, j.prompt_version, j.reasoning_effort, j.completed_at;

revoke all on table public.generation_usage from anon, authenticated, public;
grant select on table public.generation_usage to service_role;
