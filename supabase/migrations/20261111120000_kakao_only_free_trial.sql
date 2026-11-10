-- 카카오 단일 로그인 회원에게 무료 이용권 한 장 (캠페인 free-trial-2026-11).
--
-- 1) 이용권(free_tickets)과 지급·사용·반환 기록(free_ticket_events)
-- 2) 구매 권한(entitlements)과 생성 작업(generation_jobs)의 출처를 결제 또는 이용권 중 하나로 구분
-- 3) 이용권 사용: 이용권 연결, 구매 권한, 생성 작업을 한 트랜잭션으로 만든다
-- 4) 생성 완료와 이용권 완료를 한 트랜잭션으로 기록한다
-- 5) 복구할 수 없는 실패의 이용권 반환 (서버 관리용)
--
-- 기존 행은 지우거나 바꾸지 않는다. 기존 결제 권한은 source = 'payment'로 읽힌다.
-- 이전 앱 코드(결제만 아는 코드)도 그대로 동작하도록 열과 상태 값만 추가한다.

----------------------------------------------------------------------
-- 이용권
----------------------------------------------------------------------
create table public.free_tickets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  -- 캠페인 식별자는 고정한다. 재배포, 문구 변경, 결제 모드 전환으로 새 캠페인이 생겨 다시 지급되지 않게 한다.
  campaign_id text not null,
  -- available: 사용 가능 / redeemed: 풀이 하나에 연결됨(생성 중·실패 후 재시도) / completed: 생성 완료
  status text not null default 'available',
  reading_id uuid references public.readings (id),
  redeem_request_id uuid,
  -- 사용 시점의 상품·계산·규칙 버전. 출생정보와 질문은 연결한 readings 행에 고정되어 있다.
  binding jsonb,
  restore_count integer not null default 0,
  granted_at timestamptz not null default now(),
  redeemed_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint free_tickets_status_check check (status in ('available', 'redeemed', 'completed')),
  constraint free_tickets_campaign_check check (campaign_id in ('free-trial-2026-11')),
  -- 회원과 캠페인 조합당 한 장. 동시 지급 요청도 이 제약으로 한 장만 남는다.
  constraint free_tickets_one_per_campaign unique (user_id, campaign_id),
  constraint free_tickets_link_check check ((status = 'available') = (reading_id is null))
);
create unique index free_tickets_one_per_reading on public.free_tickets (reading_id) where reading_id is not null;

create table public.free_ticket_events (
  id bigint generated always as identity primary key,
  ticket_id uuid references public.free_tickets (id) on delete cascade,
  user_id uuid references auth.users (id) on delete cascade,
  kind text not null check (kind in ('granted', 'redeemed', 'completed', 'restored', 'backfill')),
  reading_id uuid,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index free_ticket_events_ticket_idx on public.free_ticket_events (ticket_id, created_at);

revoke all on table public.free_tickets, public.free_ticket_events from anon, authenticated, public;
grant select on table public.free_tickets to authenticated;
grant all on table public.free_tickets, public.free_ticket_events to service_role;
alter table public.free_tickets enable row level security;
alter table public.free_ticket_events enable row level security;

-- 본인 이용권만 읽는다. 지급 여부, 상태, 소유자, 연결된 풀이는 서버 함수만 바꾼다.
create policy "free_tickets_owner_select" on public.free_tickets
  for select to authenticated using ((select auth.uid()) = user_id);
-- free_ticket_events에는 정책을 만들지 않는다. 운영 기록이라 브라우저 역할은 접근할 수 없다.

----------------------------------------------------------------------
-- 구매 권한과 생성 작업의 출처
----------------------------------------------------------------------
alter table public.entitlements alter column order_id drop not null;
alter table public.entitlements add column source text not null default 'payment';
alter table public.entitlements add column ticket_id uuid unique references public.free_tickets (id);
alter table public.entitlements add constraint entitlements_source_check check (source in ('payment', 'free_ticket'));
alter table public.entitlements add constraint entitlements_one_source check (
  (source = 'payment' and order_id is not null and ticket_id is null)
  or (source = 'free_ticket' and ticket_id is not null and order_id is null)
);

alter table public.generation_jobs alter column order_id drop not null;
alter table public.generation_jobs add column ticket_id uuid references public.free_tickets (id);
alter table public.generation_jobs add constraint generation_jobs_one_source check ((order_id is null) <> (ticket_id is null));
-- cancelled: 이용권을 반환하며 닫은 작업. 늦게 끝난 이전 요청이 완료로 바꾸지 못한다.
alter table public.generation_jobs drop constraint generation_jobs_status_check;
alter table public.generation_jobs add constraint generation_jobs_status_check
  check (status in ('queued', 'running', 'completed', 'failed', 'cancelled'));

----------------------------------------------------------------------
-- 회원 판정: 이 앱의 정상 카카오 로그인 회원인가
----------------------------------------------------------------------
-- auth.identities는 Supabase Auth만 쓰는 공식 연결 정보다. user_metadata처럼 사용자가 바꿀 수 있는 값은 보지 않는다.
-- 최초 가입 제공자(app_metadata.provider) 하나가 아니라 실제 연결된 identity 전체에서 카카오를 찾는다.
-- service_role에는 auth.identities 읽기 권한이 없으므로, 이 함수 하나만 소유자 권한(security definer)으로 실행하고
-- 실행 권한은 service_role에만 준다. 결과는 참·거짓 하나만 돌려준다.
create function public.is_kakao_member(p_user_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from auth.users u
    join auth.identities i on i.user_id = u.id
    where u.id = p_user_id
      and i.provider = 'kakao'
      and u.deleted_at is null
      and coalesce(u.is_anonymous, false) = false
      and (u.banned_until is null or u.banned_until <= now())
  );
$$;

----------------------------------------------------------------------
-- 지급: 신규 가입, 로그인 후 누락 복구, 기존 회원 일괄 지급이 모두 이 함수를 쓴다
----------------------------------------------------------------------
create function public.grant_free_ticket(p_user_id uuid, p_campaign_id text)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_ticket public.free_tickets;
begin
  if not public.is_kakao_member(p_user_id) then
    return jsonb_build_object('outcome', 'not_eligible');
  end if;

  -- 조회 후 생성이 아니라 고유 제약에 맡긴다. 동시에 들어온 두 번째 요청은 첫 요청이 끝날 때까지 기다렸다가 아무것도 넣지 않는다.
  insert into public.free_tickets (user_id, campaign_id)
  values (p_user_id, p_campaign_id)
  on conflict (user_id, campaign_id) do nothing
  returning * into v_ticket;

  if found then
    insert into public.free_ticket_events (ticket_id, user_id, kind)
    values (v_ticket.id, p_user_id, 'granted');
    return jsonb_build_object('outcome', 'granted', 'ticket', to_jsonb(v_ticket));
  end if;

  select * into v_ticket from public.free_tickets
  where user_id = p_user_id and campaign_id = p_campaign_id;
  return jsonb_build_object('outcome', 'exists', 'ticket', to_jsonb(v_ticket));
end;
$$;

-- 기존 회원 일괄 지급. 여러 번 실행해도 회원당 한 장이다. 회원 판정은 grant_free_ticket과 같다.
-- auth.users 전체를 훑어야 하므로 소유자 권한으로 실행하고, 실행 권한은 service_role에만 준다.
create function public.grant_free_tickets_to_kakao_members(p_campaign_id text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_user_id uuid;
  v_result jsonb;
  v_total integer := 0;
  v_granted integer := 0;
  v_skipped integer := 0;
  v_not_eligible integer := 0;
  v_failed integer := 0;
  v_summary jsonb;
begin
  for v_user_id in select id from auth.users order by created_at, id loop
    v_total := v_total + 1;
    begin
      v_result := public.grant_free_ticket(v_user_id, p_campaign_id);
      case v_result ->> 'outcome'
        when 'granted' then v_granted := v_granted + 1;
        when 'exists' then v_skipped := v_skipped + 1;
        else v_not_eligible := v_not_eligible + 1;
      end case;
    exception when others then
      v_failed := v_failed + 1;
    end;
  end loop;

  v_summary := jsonb_build_object(
    'campaignId', p_campaign_id,
    'users', v_total,
    'granted', v_granted,
    'skippedExisting', v_skipped,
    'notEligible', v_not_eligible,
    'failed', v_failed
  );
  insert into public.free_ticket_events (kind, detail) values ('backfill', v_summary);
  return v_summary;
end;
$$;

----------------------------------------------------------------------
-- 사용: 이용권 한 장을 풀이 한 건에 연결하고 구매 권한과 생성 작업을 함께 만든다
----------------------------------------------------------------------
create function public.redeem_free_ticket(
  p_user_id uuid, p_reading_id uuid, p_request_id uuid, p_campaign_id text,
  p_product_id text, p_product_version text, p_question_limit integer, p_binding jsonb
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_ticket public.free_tickets;
  v_reading_product text;
  v_entitlement public.entitlements;
begin
  if not public.is_kakao_member(p_user_id) then
    raise exception 'not_eligible' using errcode = 'P0001';
  end if;
  if p_question_limit is null or p_question_limit < 0 then
    raise exception 'invalid_input' using errcode = 'P0001';
  end if;

  -- 이용권 행을 먼저 잠근다. 같은 회원의 사용 요청은 요청 ID나 탭이 달라도 한 번에 하나씩 처리된다.
  select * into v_ticket from public.free_tickets
  where user_id = p_user_id and campaign_id = p_campaign_id
  for update;
  if not found then
    raise exception 'no_ticket' using errcode = 'P0001';
  end if;

  -- 입력 정보와 맛보기(readings 행)의 소유자를 확인한다.
  select product_id into v_reading_product from public.readings
  where id = p_reading_id and user_id = p_user_id
  for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  if v_reading_product <> p_product_id then
    raise exception 'product_mismatch' using errcode = 'P0001';
  end if;

  -- 이미 이용 권한이 있는 풀이면 추가로 쓰지 않고 그대로 돌려준다 (재전송, 다시 열기).
  select * into v_entitlement from public.entitlements where reading_id = p_reading_id;
  if found then
    return jsonb_build_object(
      'outcome', case when v_entitlement.ticket_id = v_ticket.id then 'already_redeemed' else 'already_entitled' end,
      'readingId', p_reading_id,
      'source', v_entitlement.source
    );
  end if;

  -- 이미 다른 풀이에 쓴 이용권이면 그 풀이를 알려 준다.
  if v_ticket.status <> 'available' then
    return jsonb_build_object('outcome', 'ticket_used', 'readingId', v_ticket.reading_id, 'ticketStatus', v_ticket.status);
  end if;

  -- 이용권을 반환하며 닫은 풀이에는 다시 쓰지 않는다. 입력을 새로 만들어 쓴다.
  if exists (select 1 from public.generation_jobs where reading_id = p_reading_id) then
    raise exception 'reading_closed' using errcode = 'P0001';
  end if;

  -- 결제 모드에서 만들어 둔 대기 주문은 닫는다. 같은 풀이를 이용권과 결제로 두 번 받지 않게 한다.
  update public.orders set status = 'cancelled', failure_code = 'redeemed_with_free_ticket', updated_at = now()
  where reading_id = p_reading_id and status = 'pending';

  update public.free_tickets set
    status = 'redeemed',
    reading_id = p_reading_id,
    redeem_request_id = p_request_id,
    binding = p_binding,
    redeemed_at = now(),
    updated_at = now()
  where id = v_ticket.id;

  insert into public.entitlements (reading_id, user_id, source, ticket_id, question_limit)
  values (p_reading_id, p_user_id, 'free_ticket', v_ticket.id, p_question_limit)
  on conflict (reading_id) do nothing;
  if not found then
    -- 같은 순간에 결제 완료가 먼저 기록됐다. 이 트랜잭션 전체를 되돌려 이용권을 보존한다.
    raise exception 'already_entitled' using errcode = 'P0001';
  end if;

  insert into public.generation_jobs (reading_id, user_id, ticket_id)
  values (p_reading_id, p_user_id, v_ticket.id);

  insert into public.free_ticket_events (ticket_id, user_id, kind, reading_id, detail)
  values (v_ticket.id, p_user_id, 'redeemed', p_reading_id,
    jsonb_build_object('requestId', p_request_id, 'productId', p_product_id, 'productVersion', p_product_version));

  return jsonb_build_object('outcome', 'redeemed', 'readingId', p_reading_id);
end;
$$;

----------------------------------------------------------------------
-- 생성: 반환으로 닫은 작업은 다시 시작하지 않고, 완료하면 이용권도 완료로 기록한다
----------------------------------------------------------------------
create or replace function public.claim_generation(
  p_user_id uuid, p_reading_id uuid, p_retry boolean, p_model text, p_prompt_version text, p_schema_version text,
  p_reasoning_effort text, p_lease_seconds integer, p_max_attempts integer
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_job public.generation_jobs;
begin
  select * into v_job from public.generation_jobs
  where reading_id = p_reading_id and user_id = p_user_id for update;
  if not found or v_job.status = 'cancelled' then
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

  if v_job.ticket_id is not null then
    update public.free_tickets set status = 'completed', completed_at = now(), updated_at = now()
    where id = v_job.ticket_id and reading_id = p_reading_id and status = 'redeemed';
    if found then
      insert into public.free_ticket_events (ticket_id, user_id, kind, reading_id)
      values (v_job.ticket_id, v_job.user_id, 'completed', p_reading_id);
    end if;
  end if;
  return true;
end;
$$;

-- 이용권을 반환하며 닫은 풀이(작업만 남고 권한이 없는 풀이)로는 결제 주문도 만들지 않는다.
create or replace function public.create_order(
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
  if exists (select 1 from public.generation_jobs where reading_id = p_reading_id) then
    raise exception 'reading_closed' using errcode = 'P0001';
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

----------------------------------------------------------------------
-- 반환: 복구할 수 없는 생성 실패에서만 서버 관리자가 실행한다
----------------------------------------------------------------------
-- 정상 제공된 풀이(완료)와 점유 시간이 남은 실행 중 작업은 반환하지 않는다.
-- 작업을 cancelled로 닫아 늦게 끝난 이전 요청이 완료로 바꾸지 못하게 하고, 이용권은 같은 행을 사용 가능으로 되돌린다.
-- 이미 사용 가능이면 아무것도 바꾸지 않는다 (중복 반환 방지).
-- 잠금 순서는 complete_generation과 같게 생성 작업 → 이용권이다. 순서가 반대면 늦은 완료와 반환이 겹칠 때 교착 상태가 생긴다
-- (실제 Postgres 동시성 테스트에서 확인).
create function public.restore_free_ticket(p_ticket_id uuid, p_reason text)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_reading_id uuid;
  v_ticket public.free_tickets;
  v_job public.generation_jobs;
  v_job_found boolean := false;
begin
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'reason_required' using errcode = 'P0001';
  end if;

  -- 연결된 풀이를 먼저 확인하고(잠그지 않음), 그 작업 → 이용권 순서로 잠근 뒤 다시 확인한다.
  select reading_id into v_reading_id from public.free_tickets where id = p_ticket_id;
  if not found then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  if v_reading_id is not null then
    select * into v_job from public.generation_jobs where reading_id = v_reading_id for update;
    v_job_found := found;
  end if;

  select * into v_ticket from public.free_tickets where id = p_ticket_id for update;
  if v_ticket.status = 'available' then
    return jsonb_build_object('outcome', 'already_available', 'ticketId', p_ticket_id);
  end if;
  if v_ticket.status = 'completed' then
    raise exception 'already_delivered' using errcode = 'P0001';
  end if;
  if v_ticket.reading_id is distinct from v_reading_id then
    -- 확인하는 사이에 반환되고 다른 풀이에 다시 쓰였다. 상태를 다시 확인한 뒤 실행한다.
    raise exception 'ticket_changed' using errcode = 'P0001';
  end if;

  if v_job_found then
    if v_job.status = 'completed' then
      raise exception 'already_delivered' using errcode = 'P0001';
    end if;
    if v_job.status = 'running' and v_job.lease_until > now() then
      raise exception 'still_running' using errcode = 'P0001';
    end if;
    update public.generation_jobs set
      status = 'cancelled', error_code = 'ticket_restored', error_retryable = false, lease_until = null, updated_at = now()
    where reading_id = v_ticket.reading_id;
  end if;

  delete from public.entitlements where reading_id = v_ticket.reading_id and ticket_id = v_ticket.id;

  update public.free_tickets set
    status = 'available',
    reading_id = null,
    redeem_request_id = null,
    binding = null,
    redeemed_at = null,
    restore_count = restore_count + 1,
    updated_at = now()
  where id = p_ticket_id;

  insert into public.free_ticket_events (ticket_id, user_id, kind, reading_id, detail)
  values (p_ticket_id, v_ticket.user_id, 'restored', v_ticket.reading_id, jsonb_build_object(
    'reason', left(p_reason, 300),
    'jobStatus', case when v_job_found then v_job.status end,
    'attempts', case when v_job_found then v_job.attempts end,
    'errorCode', case when v_job_found then v_job.error_code end,
    'llmCalls', case when v_job_found then v_job.llm_calls end
  ));

  return jsonb_build_object('outcome', 'restored', 'ticketId', p_ticket_id, 'readingId', v_ticket.reading_id);
end;
$$;

----------------------------------------------------------------------
-- 실행 권한: 기본 권한을 걷어 내고 서버(service_role)에만 준다
----------------------------------------------------------------------
revoke all on function public.is_kakao_member(uuid) from public, anon, authenticated;
revoke all on function public.grant_free_ticket(uuid, text) from public, anon, authenticated;
revoke all on function public.grant_free_tickets_to_kakao_members(text) from public, anon, authenticated;
revoke all on function public.redeem_free_ticket(uuid, uuid, uuid, text, text, text, integer, jsonb) from public, anon, authenticated;
revoke all on function public.restore_free_ticket(uuid, text) from public, anon, authenticated;
revoke all on function public.claim_generation(uuid, uuid, boolean, text, text, text, text, integer, integer) from public, anon, authenticated;
revoke all on function public.complete_generation(uuid, integer, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.create_order(uuid, uuid, text, text, integer, text, text, jsonb) from public, anon, authenticated;

grant execute on function public.is_kakao_member(uuid) to service_role;
grant execute on function public.grant_free_ticket(uuid, text) to service_role;
grant execute on function public.grant_free_tickets_to_kakao_members(text) to service_role;
grant execute on function public.redeem_free_ticket(uuid, uuid, uuid, text, text, text, integer, jsonb) to service_role;
grant execute on function public.restore_free_ticket(uuid, text) to service_role;
grant execute on function public.claim_generation(uuid, uuid, boolean, text, text, text, text, integer, integer) to service_role;
grant execute on function public.complete_generation(uuid, integer, jsonb, jsonb) to service_role;
grant execute on function public.create_order(uuid, uuid, text, text, integer, text, text, jsonb) to service_role;
