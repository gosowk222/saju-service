-- 회원 역할(user/admin), 서버 설정, 관리자 작업.
--
-- 1) user_roles: 회원 역할. 행이 없으면 user다. 역할은 DB에서만 바꾼다 (set_user_role 또는 표 편집).
-- 2) app_settings: 관리자 화면에서 바꾸는 서버 설정. 지금은 풀이 상품 이용 범위 하나다.
--    readings_open_to_all = false(기본): 관리자만 풀이 상품을 이용 / true: 모든 회원이 이용
-- 3) 관리자가 고른 회원에게 무료 이용권 한 장을 더 주는 기능. 캠페인 이용권(회원당 한 장)과 별도로 쌓인다.
-- 4) admin_actions: 관리자 작업 기록
--
-- 앞 migration(20261111120000)이 적용된 뒤에 적용한다. 기존 행은 지우거나 바꾸지 않는다.

----------------------------------------------------------------------
-- 회원 역할
----------------------------------------------------------------------
create table public.user_roles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  role text not null default 'user' check (role in ('user', 'admin')),
  note text,
  updated_at timestamptz not null default now()
);

revoke all on table public.user_roles from anon, authenticated, public;
grant select on table public.user_roles to authenticated;
grant all on table public.user_roles to service_role;
alter table public.user_roles enable row level security;
-- 본인 역할만 읽는다. 역할을 바꾸는 경로는 DB(관리자 SQL)뿐이다.
create policy "user_roles_owner_select" on public.user_roles
  for select to authenticated using ((select auth.uid()) = user_id);

create function public.is_admin(p_user_id uuid)
returns boolean language sql stable security invoker set search_path = '' as $$
  select exists (select 1 from public.user_roles where user_id = p_user_id and role = 'admin');
$$;

-- DB에서 역할을 바꿀 때 쓴다. 예: select public.set_user_role('<회원 ID>', 'admin', '운영자');
create function public.set_user_role(p_user_id uuid, p_role text, p_note text default null)
returns jsonb language plpgsql security invoker set search_path = '' as $$
begin
  if p_role not in ('user', 'admin') then
    raise exception 'invalid_role' using errcode = 'P0001';
  end if;
  insert into public.user_roles (user_id, role, note, updated_at)
  values (p_user_id, p_role, p_note, now())
  on conflict (user_id) do update set role = excluded.role, note = coalesce(excluded.note, public.user_roles.note), updated_at = now();
  return jsonb_build_object('userId', p_user_id, 'role', p_role);
end;
$$;

----------------------------------------------------------------------
-- 서버 설정
----------------------------------------------------------------------
create table public.app_settings (
  key text primary key check (key in ('readings_open_to_all')),
  value jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null
);
-- 개발 중 테스트 링크가 퍼져도 아무나 풀이를 받지 못하도록 기본은 관리자만이다.
insert into public.app_settings (key, value) values ('readings_open_to_all', 'false'::jsonb)
on conflict (key) do nothing;

revoke all on table public.app_settings from anon, authenticated, public;
grant all on table public.app_settings to service_role;
alter table public.app_settings enable row level security;
-- 정책을 만들지 않는다. 설정은 서버만 읽고 관리자 함수만 바꾼다.

create table public.admin_actions (
  id bigint generated always as identity primary key,
  admin_id uuid references auth.users (id) on delete set null,
  action text not null check (action in ('set_setting', 'grant_ticket')),
  target_user_id uuid,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
revoke all on table public.admin_actions from anon, authenticated, public;
grant all on table public.admin_actions to service_role;
alter table public.admin_actions enable row level security;

-- 서버가 요청마다 한 번 부른다: 이 회원의 역할과 풀이 상품 이용 가능 여부.
create function public.get_reading_access(p_user_id uuid)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare
  v_admin boolean := public.is_admin(p_user_id);
  v_open boolean;
begin
  select coalesce((value)::boolean, false) into v_open from public.app_settings where key = 'readings_open_to_all';
  v_open := coalesce(v_open, false);
  return jsonb_build_object(
    'role', case when v_admin then 'admin' else 'user' end,
    'openToAll', v_open,
    'allowed', v_open or v_admin
  );
end;
$$;

create function public.set_readings_open_to_all(p_admin_id uuid, p_open boolean)
returns jsonb language plpgsql security invoker set search_path = '' as $$
begin
  if not public.is_admin(p_admin_id) then
    raise exception 'not_admin' using errcode = 'P0001';
  end if;
  if p_open is null then
    raise exception 'invalid_input' using errcode = 'P0001';
  end if;
  insert into public.app_settings (key, value, updated_at, updated_by)
  values ('readings_open_to_all', to_jsonb(p_open), now(), p_admin_id)
  on conflict (key) do update set value = excluded.value, updated_at = now(), updated_by = p_admin_id;
  insert into public.admin_actions (admin_id, action, detail)
  values (p_admin_id, 'set_setting', jsonb_build_object('key', 'readings_open_to_all', 'value', p_open));
  return jsonb_build_object('openToAll', p_open);
end;
$$;

----------------------------------------------------------------------
-- 관리자 지급 이용권
----------------------------------------------------------------------
-- source = campaign: 캠페인 이용권 (회원·캠페인당 한 장, 기존 고유 제약 그대로)
-- source = admin: 관리자가 준 이용권. campaign_id가 비어 있어 고유 제약에 걸리지 않고 한 장씩 쌓인다.
--   같은 지급 요청(grant_request_id)은 한 번만 반영된다 (두 번 누르기, 재전송).
alter table public.free_tickets alter column campaign_id drop not null;
alter table public.free_tickets add column source text not null default 'campaign';
alter table public.free_tickets add column granted_by uuid references auth.users (id) on delete set null;
alter table public.free_tickets add column grant_request_id uuid unique;
alter table public.free_tickets add column note text;
alter table public.free_tickets add constraint free_tickets_source_check check (
  (source = 'campaign' and campaign_id is not null and grant_request_id is null)
  or (source = 'admin' and campaign_id is null and grant_request_id is not null)
);

create function public.admin_grant_free_ticket(p_admin_id uuid, p_user_id uuid, p_request_id uuid, p_note text default null)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_ticket public.free_tickets;
begin
  if not public.is_admin(p_admin_id) then
    raise exception 'not_admin' using errcode = 'P0001';
  end if;
  if p_request_id is null then
    raise exception 'invalid_input' using errcode = 'P0001';
  end if;
  -- 이용권은 카카오 회원만 쓸 수 있으므로 카카오 회원에게만 준다.
  if not public.is_kakao_member(p_user_id) then
    return jsonb_build_object('outcome', 'not_eligible');
  end if;

  insert into public.free_tickets (user_id, source, granted_by, grant_request_id, note)
  values (p_user_id, 'admin', p_admin_id, p_request_id, left(p_note, 200))
  on conflict (grant_request_id) do nothing
  returning * into v_ticket;

  if found then
    insert into public.free_ticket_events (ticket_id, user_id, kind, detail)
    values (v_ticket.id, p_user_id, 'granted', jsonb_build_object('source', 'admin', 'adminId', p_admin_id));
    insert into public.admin_actions (admin_id, action, target_user_id, detail)
    values (p_admin_id, 'grant_ticket', p_user_id, jsonb_build_object('ticketId', v_ticket.id, 'requestId', p_request_id));
    return jsonb_build_object('outcome', 'granted', 'ticketId', v_ticket.id);
  end if;

  select * into v_ticket from public.free_tickets where grant_request_id = p_request_id;
  if v_ticket.user_id <> p_user_id then
    raise exception 'request_conflict' using errcode = 'P0001';
  end if;
  return jsonb_build_object('outcome', 'exists', 'ticketId', v_ticket.id);
end;
$$;

-- 이용권이 여러 장일 수 있으므로 사용 함수를 바꾼다.
-- 같은 회원의 사용 요청은 회원 단위 잠금으로 한 번에 하나씩 처리하고, 사용 가능한 이용권 중 캠페인 → 먼저 받은 순으로 쓴다.
drop function public.redeem_free_ticket(uuid, uuid, uuid, text, text, text, integer, jsonb);

create function public.redeem_free_ticket(
  p_user_id uuid, p_reading_id uuid, p_request_id uuid,
  p_product_id text, p_product_version text, p_question_limit integer, p_binding jsonb
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_ticket public.free_tickets;
  v_reading_product text;
  v_entitlement public.entitlements;
  v_used_reading uuid;
begin
  if not public.is_kakao_member(p_user_id) then
    raise exception 'not_eligible' using errcode = 'P0001';
  end if;
  if p_question_limit is null or p_question_limit < 0 then
    raise exception 'invalid_input' using errcode = 'P0001';
  end if;

  -- 회원 단위 잠금. 요청 ID나 탭이 달라도 같은 회원의 사용은 한 번에 하나씩 처리된다 (트랜잭션이 끝나면 풀린다).
  perform pg_advisory_xact_lock(hashtextextended('free_ticket_redeem:' || p_user_id::text, 0));

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
      'outcome', case when v_entitlement.source = 'free_ticket' then 'already_redeemed' else 'already_entitled' end,
      'readingId', p_reading_id,
      'source', v_entitlement.source
    );
  end if;

  select * into v_ticket from public.free_tickets
  where user_id = p_user_id and status = 'available'
  order by (source = 'campaign') desc, granted_at, id
  limit 1
  for update;
  if not found then
    -- 쓸 수 있는 이용권이 없다. 이미 쓴 이용권이 있으면 가장 최근에 쓴 풀이를 알려 준다.
    select reading_id into v_used_reading from public.free_tickets
    where user_id = p_user_id and status <> 'available'
    order by redeemed_at desc nulls last, granted_at desc
    limit 1;
    if found then
      return jsonb_build_object('outcome', 'ticket_used', 'readingId', v_used_reading);
    end if;
    raise exception 'no_ticket' using errcode = 'P0001';
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
    jsonb_build_object('requestId', p_request_id, 'productId', p_product_id, 'productVersion', p_product_version, 'source', v_ticket.source));

  return jsonb_build_object('outcome', 'redeemed', 'readingId', p_reading_id, 'ticketId', v_ticket.id);
end;
$$;

----------------------------------------------------------------------
-- 관리자 화면의 회원 목록
----------------------------------------------------------------------
-- auth.users와 auth.identities를 읽어야 해서 소유자 권한으로 실행한다. 관리자 확인을 함수 안에서 다시 한다.
-- 이름은 카카오가 준 표시용 값이다. 권한 판단에는 쓰지 않는다.
create function public.admin_list_members(p_admin_id uuid, p_search text default null, p_limit integer default 50)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_search text := nullif(btrim(coalesce(p_search, '')), '');
  v_rows jsonb;
begin
  if not public.is_admin(p_admin_id) then
    raise exception 'not_admin' using errcode = 'P0001';
  end if;

  select coalesce(jsonb_agg(row_to_json(m) order by m.created_at desc), '[]'::jsonb) into v_rows
  from (
    select
      u.id,
      coalesce(u.raw_user_meta_data ->> 'name', u.raw_user_meta_data ->> 'full_name', u.raw_user_meta_data ->> 'preferred_username',
        u.raw_user_meta_data ->> 'user_name', u.raw_user_meta_data ->> 'nickname') as name,
      u.email,
      u.created_at,
      u.last_sign_in_at,
      coalesce(r.role, 'user') as role,
      exists (select 1 from auth.identities i where i.user_id = u.id and i.provider = 'kakao') as kakao,
      (select count(*) from public.free_tickets t where t.user_id = u.id and t.status = 'available')::integer as tickets_available,
      (select count(*) from public.free_tickets t where t.user_id = u.id and t.status <> 'available')::integer as tickets_used
    from auth.users u
    left join public.user_roles r on r.user_id = u.id
    where u.deleted_at is null
      and (
        v_search is null
        or u.id::text like v_search || '%'
        or u.email ilike '%' || v_search || '%'
        or coalesce(u.raw_user_meta_data ->> 'name', u.raw_user_meta_data ->> 'full_name', u.raw_user_meta_data ->> 'nickname', '') ilike '%' || v_search || '%'
      )
    order by u.created_at desc
    limit least(greatest(coalesce(p_limit, 50), 1), 200)
  ) m;
  return v_rows;
end;
$$;

----------------------------------------------------------------------
-- 실행 권한: 서버(service_role)에만 준다
----------------------------------------------------------------------
revoke all on function public.is_admin(uuid) from public, anon, authenticated;
revoke all on function public.set_user_role(uuid, text, text) from public, anon, authenticated;
revoke all on function public.get_reading_access(uuid) from public, anon, authenticated;
revoke all on function public.set_readings_open_to_all(uuid, boolean) from public, anon, authenticated;
revoke all on function public.admin_grant_free_ticket(uuid, uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.redeem_free_ticket(uuid, uuid, uuid, text, text, integer, jsonb) from public, anon, authenticated;
revoke all on function public.admin_list_members(uuid, text, integer) from public, anon, authenticated;

grant execute on function public.is_admin(uuid) to service_role;
grant execute on function public.set_user_role(uuid, text, text) to service_role;
grant execute on function public.get_reading_access(uuid) to service_role;
grant execute on function public.set_readings_open_to_all(uuid, boolean) to service_role;
grant execute on function public.admin_grant_free_ticket(uuid, uuid, uuid, text) to service_role;
grant execute on function public.redeem_free_ticket(uuid, uuid, uuid, text, text, integer, jsonb) to service_role;
grant execute on function public.admin_list_members(uuid, text, integer) to service_role;
