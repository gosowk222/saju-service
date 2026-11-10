-- 풀이 품질 고도화.
-- 1) 질문 분석과 기간 재료를 풀이별로 저장해 재시도와 후속 질문에서 다시 쓴다.
-- 2) 후속 질문의 되묻기(clarify)는 횟수를 차감하지 않는다.
-- 3) 생성에 쓴 계획·질문 분석·기간 분석 버전을 작업에 남긴다.
-- 기존 행과 함수의 동작은 바꾸지 않고, 상태 값과 열을 추가한다.

----------------------------------------------------------------------
-- 질문 분석과 기간 재료. 작성 재료와 같은 내부 자료라 브라우저에는 내보내지 않는다.
----------------------------------------------------------------------
create table public.reading_analyses (
  reading_id uuid not null references public.readings (id) on delete cascade,
  cache_key text not null,
  kind text not null check (kind in ('question', 'timing')),
  version text not null,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  primary key (reading_id, cache_key),
  constraint reading_analyses_key_length check (char_length(cache_key) <= 120),
  constraint reading_analyses_payload_size check (pg_column_size(payload) < 262144)
);

revoke all on table public.reading_analyses from anon, authenticated, public;
grant all on table public.reading_analyses to service_role;
alter table public.reading_analyses enable row level security;
-- 정책을 만들지 않는다. RLS가 켜져 있어 브라우저 역할은 접근할 수 없다.

-- 같은 키가 이미 있으면 덮어쓰지 않고 저장된 값을 돌려준다. 동시에 계산해도 한 값으로 모인다.
create function public.save_reading_analysis(
  p_reading_id uuid, p_cache_key text, p_kind text, p_version text, p_payload jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_payload jsonb;
begin
  insert into public.reading_analyses (reading_id, cache_key, kind, version, payload)
  values (p_reading_id, p_cache_key, p_kind, p_version, p_payload)
  on conflict (reading_id, cache_key) do nothing;

  select payload into v_payload from public.reading_analyses
  where reading_id = p_reading_id and cache_key = p_cache_key;
  return v_payload;
end;
$$;

revoke all on function public.save_reading_analysis(uuid, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.save_reading_analysis(uuid, text, text, text, jsonb) to service_role;

----------------------------------------------------------------------
-- 후속 질문: 되묻기 상태와 질문 분석 기록
----------------------------------------------------------------------
alter table public.followups drop constraint followups_status_check;
alter table public.followups add constraint followups_status_check
  check (status in ('answering', 'answered', 'clarify', 'off_topic', 'failed'));
alter table public.followups add column analysis jsonb;

-- 정상 답변(answered)만 같은 트랜잭션에서 한 번 차감한다. 범위 밖 안내와 되묻기는 차감하지 않는다.
create or replace function public.complete_followup(
  p_followup_id uuid, p_user_id uuid, p_status text, p_answer text, p_refs jsonb, p_meta jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_followup public.followups;
  v_limit integer;
  v_used integer;
begin
  if p_status not in ('answered', 'off_topic', 'clarify') then
    raise exception 'invalid_state' using errcode = 'P0001';
  end if;

  select f.* into v_followup from public.followups f
  where f.id = p_followup_id and f.user_id = p_user_id;
  if not found then
    raise exception 'not_found' using errcode = 'P0001';
  end if;

  select question_limit into v_limit from public.entitlements
  where reading_id = v_followup.reading_id for update;

  select * into v_followup from public.followups where id = p_followup_id for update;
  select count(*) into v_used from public.question_usage where reading_id = v_followup.reading_id;

  if v_followup.status <> 'answering' then
    return jsonb_build_object('saved', false, 'used', v_used, 'limit', v_limit);
  end if;

  if p_status = 'answered' and v_used >= v_limit then
    update public.followups set status = 'failed', error_code = 'limit_reached', lease_until = null
    where id = p_followup_id;
    return jsonb_build_object('saved', false, 'used', v_used, 'limit', v_limit);
  end if;

  update public.followups set
    status = p_status,
    answer = p_answer,
    refs = coalesce(p_refs, '[]'::jsonb),
    model_id = p_meta ->> 'modelId',
    actual_model = p_meta ->> 'actualModel',
    prompt_version = p_meta ->> 'promptVersion',
    schema_version = p_meta ->> 'schemaVersion',
    usage = p_meta -> 'usage',
    duration_ms = (p_meta ->> 'durationMs')::integer,
    analysis = p_meta -> 'analysis',
    lease_until = null,
    answered_at = now()
  where id = p_followup_id;

  if p_status = 'answered' then
    insert into public.question_usage (reading_id, user_id, followup_id)
    values (v_followup.reading_id, p_user_id, p_followup_id)
    on conflict (followup_id) do nothing;
    v_used := v_used + 1;
  end if;

  return jsonb_build_object('saved', true, 'used', v_used, 'limit', v_limit);
end;
$$;

----------------------------------------------------------------------
-- 생성 작업: 쓰인 버전 기록
----------------------------------------------------------------------
alter table public.generation_jobs add column generation_meta jsonb;

create or replace function public.complete_generation(p_reading_id uuid, p_attempt integer, p_messages jsonb, p_meta jsonb)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_job public.generation_jobs;
begin
  select * into v_job from public.generation_jobs where reading_id = p_reading_id for update;
  if not found or v_job.status <> 'running' or v_job.attempts <> p_attempt then
    return false;
  end if;

  insert into public.reading_messages (reading_id, user_id, seq, topic_id, kind, text, refs)
  select p_reading_id, v_job.user_id, (m ->> 'seq')::integer, m ->> 'topicId', m ->> 'kind', m ->> 'text', coalesce(m -> 'refs', '[]'::jsonb)
  from jsonb_array_elements(p_messages) as m;

  update public.generation_jobs set
    status = 'completed',
    lease_until = null,
    actual_model = p_meta ->> 'actualModel',
    usage = p_meta -> 'usage',
    duration_ms = (p_meta ->> 'durationMs')::integer,
    llm_calls = llm_calls + (p_meta ->> 'llmCalls')::integer,
    checked_issue_count = (p_meta ->> 'issueCount')::integer,
    generation_meta = p_meta -> 'versions',
    completed_at = now(),
    updated_at = now()
  where reading_id = p_reading_id;
  return true;
end;
$$;
