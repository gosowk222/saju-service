-- 첫 상품 MVP 스키마.
-- 쓰기는 서버(service_role)가 호출하는 함수로만 일어나고, 브라우저 역할은 자기 행을 읽기만 한다.
-- 입력 초안만 예외로 본인이 직접 저장할 수 있다.

create table public.reading_drafts (
  user_id uuid not null references auth.users (id) on delete cascade,
  product_id text not null,
  payload jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, product_id),
  constraint reading_drafts_payload_size check (pg_column_size(payload) < 8192)
);

create table public.readings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  product_id text not null,
  product_version text not null,
  nickname text not null,
  birth_input jsonb not null,
  place_snapshot jsonb not null,
  situation_id text,
  concern text not null default '',
  chart jsonb not null,
  preview jsonb not null,
  persona_id text not null,
  persona_version text not null,
  ruleset_id text not null,
  ruleset_version text not null,
  engine_meta jsonb not null,
  created_at timestamptz not null default now()
);
create index readings_user_created_idx on public.readings (user_id, created_at desc);

-- 작성 재료와 판단 기록. 브라우저에는 어떤 경로로도 내보내지 않는다.
create table public.reading_internals (
  reading_id uuid primary key references public.readings (id) on delete cascade,
  plan jsonb not null,
  trace jsonb not null,
  created_at timestamptz not null default now()
);

create table public.orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  reading_id uuid not null references public.readings (id) on delete cascade,
  product_id text not null,
  product_version text not null,
  amount integer not null check (amount > 0),
  currency text not null default 'KRW',
  status text not null default 'pending' check (status in ('pending', 'paid', 'failed', 'cancelled')),
  provider text not null,
  payment_key text unique,
  method text,
  binding jsonb not null,
  failure_code text,
  failure_message text,
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index orders_one_pending_per_reading on public.orders (reading_id) where status = 'pending';
create unique index orders_one_paid_per_reading on public.orders (reading_id) where status = 'paid';
create index orders_user_idx on public.orders (user_id, created_at desc);

create table public.entitlements (
  reading_id uuid primary key references public.readings (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  order_id uuid not null unique references public.orders (id),
  question_limit integer not null check (question_limit >= 0),
  created_at timestamptz not null default now()
);
create index entitlements_user_idx on public.entitlements (user_id, created_at desc);

create table public.generation_jobs (
  reading_id uuid primary key references public.readings (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  order_id uuid not null unique references public.orders (id),
  status text not null default 'queued' check (status in ('queued', 'running', 'completed', 'failed')),
  attempts integer not null default 0,
  lease_until timestamptz,
  model_id text,
  prompt_version text,
  schema_version text,
  reasoning_effort text,
  actual_model text,
  error_code text,
  error_retryable boolean,
  usage jsonb,
  duration_ms integer,
  llm_calls integer not null default 0,
  checked_issue_count integer,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.reading_messages (
  reading_id uuid not null references public.readings (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  seq integer not null,
  topic_id text,
  kind text not null check (kind in ('explanation', 'creative-scene', 'transition')),
  text text not null,
  refs jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  primary key (reading_id, seq)
);

create table public.followups (
  id uuid primary key default gen_random_uuid(),
  reading_id uuid not null references public.readings (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  client_request_id text not null,
  question text not null,
  answer text,
  status text not null default 'answering' check (status in ('answering', 'answered', 'off_topic', 'failed')),
  refs jsonb not null default '[]'::jsonb,
  model_id text,
  actual_model text,
  prompt_version text,
  schema_version text,
  usage jsonb,
  duration_ms integer,
  error_code text,
  lease_until timestamptz,
  created_at timestamptz not null default now(),
  answered_at timestamptz,
  unique (reading_id, client_request_id)
);
create unique index followups_one_inflight on public.followups (reading_id) where status = 'answering';
create index followups_reading_idx on public.followups (reading_id, created_at);
create index followups_user_recent_idx on public.followups (user_id, created_at desc);

create table public.question_usage (
  id bigint generated always as identity primary key,
  reading_id uuid not null references public.readings (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  followup_id uuid not null unique references public.followups (id) on delete cascade,
  created_at timestamptz not null default now()
);
create index question_usage_reading_idx on public.question_usage (reading_id);

-- 권한: Supabase 기본값은 넓으므로 명시적으로 줄인다.
revoke all on table
  public.reading_drafts, public.readings, public.reading_internals, public.orders, public.entitlements,
  public.generation_jobs, public.reading_messages, public.followups, public.question_usage
  from anon, authenticated, public;

grant select, insert, update, delete on table public.reading_drafts to authenticated;
grant select on table
  public.readings, public.orders, public.entitlements, public.generation_jobs,
  public.reading_messages, public.followups, public.question_usage
  to authenticated;
grant all on table
  public.reading_drafts, public.readings, public.reading_internals, public.orders, public.entitlements,
  public.generation_jobs, public.reading_messages, public.followups, public.question_usage
  to service_role;

alter table public.reading_drafts enable row level security;
alter table public.readings enable row level security;
alter table public.reading_internals enable row level security;
alter table public.orders enable row level security;
alter table public.entitlements enable row level security;
alter table public.generation_jobs enable row level security;
alter table public.reading_messages enable row level security;
alter table public.followups enable row level security;
alter table public.question_usage enable row level security;

create policy "drafts_owner_all" on public.reading_drafts
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "readings_owner_select" on public.readings
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "orders_owner_select" on public.orders
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "entitlements_owner_select" on public.entitlements
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "jobs_owner_select" on public.generation_jobs
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "followups_owner_select" on public.followups
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "question_usage_owner_select" on public.question_usage
  for select to authenticated using ((select auth.uid()) = user_id);

-- 유료 본문은 소유자이면서 구매 권한이 있을 때만 읽는다.
create policy "messages_entitled_owner_select" on public.reading_messages
  for select to authenticated
  using (
    (select auth.uid()) = user_id
    and exists (
      select 1 from public.entitlements e
      where e.reading_id = reading_messages.reading_id and e.user_id = (select auth.uid())
    )
  );

-- reading_internals에는 정책을 만들지 않는다. RLS가 켜져 있어 브라우저 역할은 접근할 수 없다.

----------------------------------------------------------------------
-- 초안: 본인 권한으로 실행되는 함수
----------------------------------------------------------------------
create function public.save_my_draft(p_product_id text, p_payload jsonb)
returns void language sql security invoker set search_path = '' as $$
  insert into public.reading_drafts (user_id, product_id, payload, updated_at)
  values ((select auth.uid()), p_product_id, p_payload, now())
  on conflict (user_id, product_id)
  do update set payload = excluded.payload, updated_at = now();
$$;

create function public.delete_my_draft(p_product_id text)
returns void language sql security invoker set search_path = '' as $$
  delete from public.reading_drafts
  where user_id = (select auth.uid()) and product_id = p_product_id;
$$;

----------------------------------------------------------------------
-- 이하 서버 전용 함수. 호출하는 서버가 검증한 사용자 ID를 넘긴다.
----------------------------------------------------------------------
create function public.create_reading(p_user_id uuid, p_reading jsonb, p_internals jsonb, p_hourly_limit integer)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
  v_recent integer;
begin
  select count(*) into v_recent from public.readings
  where user_id = p_user_id and created_at > now() - interval '1 hour';
  if v_recent >= p_hourly_limit then
    raise exception 'rate_limited' using errcode = 'P0001';
  end if;

  insert into public.readings (
    user_id, product_id, product_version, nickname, birth_input, place_snapshot, situation_id, concern,
    chart, preview, persona_id, persona_version, ruleset_id, ruleset_version, engine_meta
  ) values (
    p_user_id,
    p_reading ->> 'product_id',
    p_reading ->> 'product_version',
    p_reading ->> 'nickname',
    p_reading -> 'birth_input',
    p_reading -> 'place_snapshot',
    p_reading ->> 'situation_id',
    coalesce(p_reading ->> 'concern', ''),
    p_reading -> 'chart',
    p_reading -> 'preview',
    p_reading ->> 'persona_id',
    p_reading ->> 'persona_version',
    p_reading ->> 'ruleset_id',
    p_reading ->> 'ruleset_version',
    p_reading -> 'engine_meta'
  ) returning id into v_id;

  insert into public.reading_internals (reading_id, plan, trace)
  values (v_id, p_internals -> 'plan', p_internals -> 'trace');
  return v_id;
end;
$$;

create function public.create_order(
  p_user_id uuid, p_reading_id uuid, p_product_id text, p_product_version text,
  p_amount integer, p_currency text, p_provider text, p_binding jsonb
) returns public.orders language plpgsql security definer set search_path = '' as $$
declare
  v_order public.orders;
begin
  perform 1 from public.readings where id = p_reading_id and user_id = p_user_id for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.entitlements where reading_id = p_reading_id) then
    raise exception 'already_paid' using errcode = 'P0001';
  end if;

  select * into v_order from public.orders where reading_id = p_reading_id and status = 'pending';
  if found then
    if v_order.amount = p_amount and v_order.product_version = p_product_version and v_order.provider = p_provider then
      return v_order;
    end if;
    update public.orders set status = 'cancelled', failure_code = 'superseded', updated_at = now()
    where id = v_order.id;
  end if;

  insert into public.orders (user_id, reading_id, product_id, product_version, amount, currency, provider, binding)
  values (p_user_id, p_reading_id, p_product_id, p_product_version, p_amount, p_currency, p_provider, p_binding)
  returning * into v_order;
  return v_order;
end;
$$;

create function public.mark_order_paid(
  p_order_id uuid, p_user_id uuid, p_payment_key text, p_amount integer, p_currency text,
  p_method text, p_question_limit integer
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_order public.orders;
begin
  select * into v_order from public.orders where id = p_order_id and user_id = p_user_id for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  if v_order.status = 'paid' then
    if v_order.payment_key is distinct from p_payment_key then
      raise exception 'payment_key_mismatch' using errcode = 'P0001';
    end if;
    return jsonb_build_object('readingId', v_order.reading_id, 'newlyPaid', false);
  end if;
  if v_order.status <> 'pending' then
    raise exception 'invalid_state' using errcode = 'P0001';
  end if;
  if v_order.amount <> p_amount or v_order.currency <> p_currency then
    raise exception 'amount_mismatch' using errcode = 'P0001';
  end if;

  update public.orders set
    status = 'paid', payment_key = p_payment_key, method = p_method, paid_at = now(), updated_at = now()
  where id = p_order_id;

  insert into public.entitlements (reading_id, user_id, order_id, question_limit)
  values (v_order.reading_id, p_user_id, p_order_id, p_question_limit)
  on conflict (reading_id) do nothing;

  insert into public.generation_jobs (reading_id, user_id, order_id)
  values (v_order.reading_id, p_user_id, p_order_id)
  on conflict (reading_id) do nothing;

  return jsonb_build_object('readingId', v_order.reading_id, 'newlyPaid', true);
end;
$$;

create function public.close_order(p_order_id uuid, p_user_id uuid, p_status text, p_code text, p_message text)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if p_status not in ('failed', 'cancelled') then
    raise exception 'invalid_state' using errcode = 'P0001';
  end if;
  update public.orders
  set status = p_status, failure_code = p_code, failure_message = left(p_message, 300), updated_at = now()
  where id = p_order_id and user_id = p_user_id and status = 'pending';
  return found;
end;
$$;

create function public.claim_generation(
  p_user_id uuid, p_reading_id uuid, p_retry boolean, p_model text, p_prompt_version text, p_schema_version text,
  p_reasoning_effort text, p_lease_seconds integer, p_max_attempts integer
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_job public.generation_jobs;
begin
  select * into v_job from public.generation_jobs
  where reading_id = p_reading_id and user_id = p_user_id for update;
  if not found then
    raise exception 'not_entitled' using errcode = 'P0001';
  end if;

  if v_job.status = 'completed' then
    return jsonb_build_object('claimed', false, 'reason', 'completed', 'job', to_jsonb(v_job));
  end if;
  if v_job.status = 'running' and v_job.lease_until > now() then
    return jsonb_build_object('claimed', false, 'reason', 'running', 'job', to_jsonb(v_job));
  end if;
  if v_job.status = 'failed' and not p_retry then
    return jsonb_build_object('claimed', false, 'reason', 'failed', 'job', to_jsonb(v_job));
  end if;
  if v_job.attempts >= p_max_attempts then
    update public.generation_jobs set status = 'failed', error_code = 'attempts_exhausted', error_retryable = false,
      lease_until = null, updated_at = now()
    where reading_id = p_reading_id returning * into v_job;
    return jsonb_build_object('claimed', false, 'reason', 'exhausted', 'job', to_jsonb(v_job));
  end if;

  -- 처음 시작할 때 생성 설정을 고정한다. 재시도는 고정된 값을 그대로 쓴다.
  update public.generation_jobs set
    status = 'running',
    attempts = attempts + 1,
    lease_until = now() + make_interval(secs => p_lease_seconds),
    model_id = coalesce(model_id, p_model),
    prompt_version = coalesce(prompt_version, p_prompt_version),
    schema_version = coalesce(schema_version, p_schema_version),
    reasoning_effort = coalesce(reasoning_effort, p_reasoning_effort),
    started_at = coalesce(started_at, now()),
    error_code = null,
    error_retryable = null,
    updated_at = now()
  where reading_id = p_reading_id
  returning * into v_job;

  return jsonb_build_object('claimed', true, 'reason', 'claimed', 'job', to_jsonb(v_job));
end;
$$;

create function public.complete_generation(p_reading_id uuid, p_attempt integer, p_messages jsonb, p_meta jsonb)
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
    completed_at = now(),
    updated_at = now()
  where reading_id = p_reading_id;
  return true;
end;
$$;

create function public.fail_generation(p_reading_id uuid, p_attempt integer, p_code text, p_retryable boolean, p_llm_calls integer)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  update public.generation_jobs set
    status = 'failed', error_code = p_code, error_retryable = p_retryable, lease_until = null,
    llm_calls = llm_calls + p_llm_calls, updated_at = now()
  where reading_id = p_reading_id and status = 'running' and attempts = p_attempt;
  return found;
end;
$$;

create function public.begin_followup(
  p_user_id uuid, p_reading_id uuid, p_client_request_id text, p_question text,
  p_lease_seconds integer, p_rate_per_minute integer
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_limit integer;
  v_used integer;
  v_recent integer;
  v_followup public.followups;
begin
  -- 구매 권한 행을 잠가 같은 풀이의 질문 처리를 한 번에 하나로 줄인다.
  select question_limit into v_limit from public.entitlements
  where reading_id = p_reading_id and user_id = p_user_id for update;
  if not found then
    raise exception 'not_entitled' using errcode = 'P0001';
  end if;

  select count(*) into v_used from public.question_usage where reading_id = p_reading_id;

  select * into v_followup from public.followups
  where reading_id = p_reading_id and client_request_id = p_client_request_id;
  if found then
    return jsonb_build_object('outcome', 'duplicate', 'used', v_used, 'limit', v_limit, 'followup', to_jsonb(v_followup));
  end if;

  if not exists (select 1 from public.generation_jobs where reading_id = p_reading_id and status = 'completed') then
    raise exception 'not_ready' using errcode = 'P0001';
  end if;

  update public.followups set status = 'failed', error_code = 'lease_expired', lease_until = null
  where reading_id = p_reading_id and status = 'answering' and lease_until < now();

  if exists (select 1 from public.followups where reading_id = p_reading_id and status = 'answering') then
    return jsonb_build_object('outcome', 'busy', 'used', v_used, 'limit', v_limit);
  end if;

  select count(*) into v_recent from public.followups
  where user_id = p_user_id and created_at > now() - interval '1 minute';
  if v_recent >= p_rate_per_minute then
    return jsonb_build_object('outcome', 'rate_limited', 'used', v_used, 'limit', v_limit);
  end if;

  if v_used >= v_limit then
    return jsonb_build_object('outcome', 'exhausted', 'used', v_used, 'limit', v_limit);
  end if;

  insert into public.followups (reading_id, user_id, client_request_id, question, lease_until)
  values (p_reading_id, p_user_id, p_client_request_id, p_question, now() + make_interval(secs => p_lease_seconds))
  returning * into v_followup;

  return jsonb_build_object('outcome', 'started', 'used', v_used, 'limit', v_limit, 'followup', to_jsonb(v_followup));
end;
$$;

-- 정상 답변이 저장될 때 같은 트랜잭션에서 한 번만 차감한다.
create function public.complete_followup(
  p_followup_id uuid, p_user_id uuid, p_status text, p_answer text, p_refs jsonb, p_meta jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_followup public.followups;
  v_limit integer;
  v_used integer;
begin
  if p_status not in ('answered', 'off_topic') then
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

create function public.fail_followup(p_followup_id uuid, p_user_id uuid, p_code text)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  update public.followups set status = 'failed', error_code = p_code, lease_until = null
  where id = p_followup_id and user_id = p_user_id and status = 'answering';
  return found;
end;
$$;

-- 실행 권한: 기본 권한을 걷어 내고 필요한 역할에만 준다.
revoke all on function public.save_my_draft(text, jsonb) from public, anon;
revoke all on function public.delete_my_draft(text) from public, anon;
grant execute on function public.save_my_draft(text, jsonb) to authenticated, service_role;
grant execute on function public.delete_my_draft(text) to authenticated, service_role;

revoke all on function public.create_reading(uuid, jsonb, jsonb, integer) from public, anon, authenticated;
revoke all on function public.create_order(uuid, uuid, text, text, integer, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.mark_order_paid(uuid, uuid, text, integer, text, text, integer) from public, anon, authenticated;
revoke all on function public.close_order(uuid, uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.claim_generation(uuid, uuid, boolean, text, text, text, text, integer, integer) from public, anon, authenticated;
revoke all on function public.complete_generation(uuid, integer, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.fail_generation(uuid, integer, text, boolean, integer) from public, anon, authenticated;
revoke all on function public.begin_followup(uuid, uuid, text, text, integer, integer) from public, anon, authenticated;
revoke all on function public.complete_followup(uuid, uuid, text, text, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.fail_followup(uuid, uuid, text) from public, anon, authenticated;

grant execute on function public.create_reading(uuid, jsonb, jsonb, integer) to service_role;
grant execute on function public.create_order(uuid, uuid, text, text, integer, text, text, jsonb) to service_role;
grant execute on function public.mark_order_paid(uuid, uuid, text, integer, text, text, integer) to service_role;
grant execute on function public.close_order(uuid, uuid, text, text, text) to service_role;
grant execute on function public.claim_generation(uuid, uuid, boolean, text, text, text, text, integer, integer) to service_role;
grant execute on function public.complete_generation(uuid, integer, jsonb, jsonb) to service_role;
grant execute on function public.fail_generation(uuid, integer, text, boolean, integer) to service_role;
grant execute on function public.begin_followup(uuid, uuid, text, text, integer, integer) to service_role;
grant execute on function public.complete_followup(uuid, uuid, text, text, jsonb, jsonb) to service_role;
grant execute on function public.fail_followup(uuid, uuid, text) to service_role;
