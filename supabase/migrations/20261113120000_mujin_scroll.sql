-- 무진의 종합 사주(mujin-overview): 족자 보고서의 장 단위 2-pass 생성 저장 구조.
--
-- 1) readings.situation_detail: 무진 '지금의 나' 입력 스냅샷. create_reading을 같은 인자·반환으로 교체해 함께 저장한다.
-- 2) generation_jobs.reference_date: 첫 유료 생성 때 고정하는 Asia/Seoul 기준일 (fix_reference_date).
--    release_generation: 시간 예산을 다 쓴 실행자가 스스로 멈출 때 작업을 반납해 다음 요청이 바로 이어받게 한다.
-- 3) reading_free_runs: 결제 전 무료 단계(기초 분석, 1장)의 실행 점유. 풀이당 한 행.
--    generation_jobs 행이 있으면 이용권 사용·주문 생성이 reading_closed로 막히므로 무료 단계는 이 표를 따로 쓴다.
-- 4) reading_units: 장 단위 진행 상태와 Pass 1 초안 (서버 전용, 브라우저 접근 불가).
--    reading_sections: Pass 2 최종문. 소유자가 읽되 유료 장은 구매 권한(entitlements)이 있을 때만 읽는다.
--    단위 저장 함수는 지금 점유한 실행자만 저장하게 한다 (무료: reading_free_runs, 유료: generation_jobs + 구매 권한).
-- 5) llm_calls: 실제 LLM 호출(HTTP 요청) 하나마다 한 줄. 단계·장·버전·사용량. 집계 뷰 llm_call_usage, 관리자 조회 admin_llm_usage.
--
-- 기존 행은 지우거나 바꾸지 않는다. 기존 함수는 같은 인자·같은 반환으로만 교체한다 (create_reading 하나).
-- 묘묘(first-overview)의 생성·이용권·사용량 기록(generation_attempts, generation_usage)은 그대로다.
-- 상품 ID는 SQL에 넣지 않는다. 어느 장이 무료·유료인지는 서버의 상품 설정이 정하고, DB는 단계(tier)별 점유와 권한을 확인한다.
--
-- 잠금 순서: generation_jobs(유료) 또는 reading_free_runs(무료) → reading_units → reading_sections → free_tickets.
-- 무료 단계 시작(claim_free_run)은 풀이 행을 for share로만 잠근다. 단위 저장의 외래 키 확인(풀이 행 key share)과
-- 충돌하지 않게 하려는 것이다. for update로 잠그면 '점유 확인 중인 시작 요청'과 '저장 중인 실행자'가 서로를 기다릴 수 있다.

----------------------------------------------------------------------
-- 1) 풀이 기록: 무진 '지금의 나' 스냅샷
----------------------------------------------------------------------
-- 일·학업 상태, 관심 장, 관계 상태, 가족 관심 선택과 응답 상태(미응답·비공개·관심 없음·응답)를 서버가 정리한 그대로 남긴다.
-- 묘묘 풀이와 이 migration 이전 행은 null이다. 소유자는 readings 행 전체를 읽을 수 있으므로 내부 판단은 넣지 않는다.
alter table public.readings add column situation_detail jsonb;
alter table public.readings add constraint readings_situation_detail_shape check (
  situation_detail is null or (jsonb_typeof(situation_detail) = 'object' and pg_column_size(situation_detail) < 8192)
);

-- 같은 인자와 반환으로 교체한다. situation_detail 키가 없으면(묘묘, 이전 앱 코드) null이고, JSON null도 SQL null로 저장한다.
-- 그 밖의 동작(시간당 생성 수 제한, 읽는 키, 작성 재료 저장)은 20261109120000의 함수와 같다.
create or replace function public.create_reading(p_user_id uuid, p_reading jsonb, p_internals jsonb, p_hourly_limit integer)
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
    chart, preview, persona_id, persona_version, ruleset_id, ruleset_version, engine_meta, situation_detail
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
    p_reading -> 'engine_meta',
    nullif(p_reading -> 'situation_detail', 'null'::jsonb)
  ) returning id into v_id;

  insert into public.reading_internals (reading_id, plan, trace)
  values (v_id, p_internals -> 'plan', p_internals -> 'trace');
  return v_id;
end;
$$;

----------------------------------------------------------------------
-- 2) 유료 생성 작업: 기준일 고정과 반납
----------------------------------------------------------------------
-- 무진 9·10장(대운, 앞으로 12개월)의 기준일. 첫 유료 생성 때 한 번 고정하고 재시도·재열람·후속 질문에서 그대로 쓴다.
-- 묘묘 작업과 이전 행은 null이다.
alter table public.generation_jobs add column reference_date date;

-- 작업이 있고 반환으로 닫히지(cancelled) 않았으면 고정된 기준일을 돌려준다. 아직 없으면 p_date로 고정한다.
-- 작업이 없거나 닫혔으면 null이다. 동시에 불러도 먼저 고정한 날짜 하나로 모인다 (행 잠금 뒤 조건을 다시 본다).
create function public.fix_reference_date(p_reading_id uuid, p_date date)
returns date language plpgsql security definer set search_path = '' as $$
declare
  v_date date;
begin
  update public.generation_jobs set reference_date = p_date, updated_at = now()
  where reading_id = p_reading_id and status <> 'cancelled' and reference_date is null and p_date is not null;

  select reference_date into v_date from public.generation_jobs
  where reading_id = p_reading_id and status <> 'cancelled';
  return v_date;
end;
$$;

-- 시간 예산을 다 쓴 실행자가 스스로 멈출 때 작업을 반납한다. 실행 중이고 같은 시도 번호일 때만 queued로 되돌리고
-- 점유를 풀어, 다음 요청이 점유 시간(lease)을 기다리지 않고 바로 이어받게 한다 (claim_generation이 시도 번호를 1 올린다).
-- 이미 다른 요청이 이어받았거나 끝났으면 false다. 반납도 claim 횟수에 들어가므로 무진은 p_max_attempts를 크게 준다.
create function public.release_generation(p_reading_id uuid, p_attempt integer)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  update public.generation_jobs set status = 'queued', lease_until = null, updated_at = now()
  where reading_id = p_reading_id and status = 'running' and attempts = p_attempt;
  return found;
end;
$$;

----------------------------------------------------------------------
-- 3) 무료 단계 점유
----------------------------------------------------------------------
-- 무진은 결제 전에 무료 범위(기초 분석 4개, 1장)를 만든다. 풀이당 한 행이며 generation_jobs와 같은 방식으로 점유한다.
-- generation_jobs 행을 만들지 않으므로 이 행이 있어도 이용권 사용·주문 생성은 막히지 않는다.
-- attempts는 실행 시작(claim) 횟수다. 반납·점유 만료로 이어받을 때도 1 늘어난다.
create table public.reading_free_runs (
  reading_id uuid primary key references public.readings (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  status text not null default 'queued',
  attempts integer not null default 0,
  lease_until timestamptz,
  model_id text,
  prompt_version text,
  schema_version text,
  reasoning_effort text,
  error_code text,
  error_retryable boolean,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint reading_free_runs_status_check check (status in ('queued', 'running', 'completed', 'failed')),
  constraint reading_free_runs_attempts_check check (attempts >= 0)
);
-- 회원당 하루 무료 생성 시작 수를 센다 (claim_free_run).
create index reading_free_runs_user_started_idx on public.reading_free_runs (user_id, started_at desc);

revoke all on table public.reading_free_runs from anon, authenticated, public;
grant select on table public.reading_free_runs to authenticated;
grant all on table public.reading_free_runs to service_role;
alter table public.reading_free_runs enable row level security;
-- 본인 행만 읽는다 (화면의 진행 상태). 바꾸는 경로는 아래 서버 함수뿐이다.
create policy "free_runs_owner_select" on public.reading_free_runs
  for select to authenticated using ((select auth.uid()) = user_id);

-- 무료 단계 실행을 시작하거나 이어받는다. claim_generation과 같은 상태 판정에 회원당 하루 시작 수 제한을 더했다.
-- 같은 회원의 시작 요청은 회원 단위 잠금으로 한 번에 하나씩 처리해, 동시에 여러 풀이를 시작해도 제한을 넘지 않는다.
-- 반환: { claimed, reason: claimed | completed | running | failed | exhausted | daily_limited, run: 행 또는 null }
create function public.claim_free_run(
  p_user_id uuid, p_reading_id uuid, p_retry boolean, p_model text, p_prompt_version text, p_schema_version text,
  p_reasoning_effort text, p_lease_seconds integer, p_max_attempts integer, p_daily_limit integer
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_run public.reading_free_runs;
  v_recent integer;
begin
  perform pg_advisory_xact_lock(hashtextextended('free_run_claim:' || p_user_id::text, 0));

  -- 풀이 소유자를 잠금으로 확인한다. for share라 단위 저장의 외래 키 확인과 서로 기다리지 않는다.
  perform 1 from public.readings where id = p_reading_id and user_id = p_user_id for share;
  if not found then
    raise exception 'not_found' using errcode = 'P0001';
  end if;

  select * into v_run from public.reading_free_runs where reading_id = p_reading_id for update;
  if not found then
    -- 새 풀이의 무료 단계를 시작하기 전에, 그 회원이 최근 24시간 안에 다른 풀이에서 시작한 무료 단계 수를 센다.
    select count(*) into v_recent from public.reading_free_runs
    where user_id = p_user_id and reading_id <> p_reading_id and started_at >= now() - interval '24 hours';
    if v_recent >= p_daily_limit then
      return jsonb_build_object('claimed', false, 'reason', 'daily_limited', 'run', null);
    end if;
    insert into public.reading_free_runs (reading_id, user_id) values (p_reading_id, p_user_id)
    returning * into v_run;
  end if;

  if v_run.status = 'completed' then
    return jsonb_build_object('claimed', false, 'reason', 'completed', 'run', to_jsonb(v_run));
  end if;
  if v_run.status = 'running' and v_run.lease_until > now() then
    return jsonb_build_object('claimed', false, 'reason', 'running', 'run', to_jsonb(v_run));
  end if;
  if v_run.status = 'failed' and not p_retry then
    return jsonb_build_object('claimed', false, 'reason', 'failed', 'run', to_jsonb(v_run));
  end if;
  if v_run.attempts >= p_max_attempts then
    update public.reading_free_runs set status = 'failed', error_code = 'attempts_exhausted', error_retryable = false,
      lease_until = null, updated_at = now()
    where reading_id = p_reading_id returning * into v_run;
    return jsonb_build_object('claimed', false, 'reason', 'exhausted', 'run', to_jsonb(v_run));
  end if;

  -- 처음 시작할 때 생성 설정을 고정한다. 이어받기와 재시도는 고정된 값을 그대로 쓴다.
  update public.reading_free_runs set
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
  returning * into v_run;

  return jsonb_build_object('claimed', true, 'reason', 'claimed', 'run', to_jsonb(v_run));
end;
$$;

-- 시간 예산을 다 쓴 무료 단계 실행자가 스스로 멈출 때 반납한다. 실행 중이고 같은 시도 번호일 때만 queued로 되돌린다.
create function public.release_free_run(p_reading_id uuid, p_attempt integer)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  update public.reading_free_runs set status = 'queued', lease_until = null, updated_at = now()
  where reading_id = p_reading_id and status = 'running' and attempts = p_attempt;
  return found;
end;
$$;

-- 무료 단계를 마친다. 실행 중이고 같은 시도 번호일 때만 completed로 바꾼다. 끝난 단계는 다시 시작하지 않는다.
create function public.complete_free_run(p_reading_id uuid, p_attempt integer)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  update public.reading_free_runs set status = 'completed', lease_until = null, completed_at = now(), updated_at = now()
  where reading_id = p_reading_id and status = 'running' and attempts = p_attempt;
  return found;
end;
$$;

-- 무료 단계 실행을 실패로 기록한다. 실행 중이고 같은 시도 번호일 때만 바꾼다. 다시 시도는 claim_free_run(p_retry => true)으로 한다.
create function public.fail_free_run(p_reading_id uuid, p_attempt integer, p_code text, p_retryable boolean)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  update public.reading_free_runs set
    status = 'failed', error_code = p_code, error_retryable = p_retryable, lease_until = null, updated_at = now()
  where reading_id = p_reading_id and status = 'running' and attempts = p_attempt;
  return found;
end;
$$;

----------------------------------------------------------------------
-- 4) 장 단위 상태(서버 전용)와 최종문(브라우저 읽기)
----------------------------------------------------------------------
-- 장(단위) 하나의 진행 상태와 Pass 1 초안. 초안은 화면에 보여 주지 않는 내부 자료라 브라우저 역할은 이 표에 접근할 수 없다.
-- pending: 아직 초안 없음 / drafted: 초안 저장, Pass 2 대기 / done: 최종문 저장 / failed: 실패 (error_stage가 단계, 초안은 남긴다).
-- draft_attempts·voice_attempts는 Pass 1·Pass 2를 시도한 횟수다 (성공한 저장과 실패 기록을 모두 센다).
create table public.reading_units (
  reading_id uuid not null references public.readings (id) on delete cascade,
  unit_id text not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  tier text not null,
  status text not null default 'pending',
  draft jsonb,
  draft_meta jsonb,
  draft_attempts integer not null default 0,
  voice_attempts integer not null default 0,
  error_stage text,
  error_code text,
  error_retryable boolean,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (reading_id, unit_id),
  constraint reading_units_tier_check check (tier in ('free', 'paid')),
  constraint reading_units_status_check check (status in ('pending', 'drafted', 'done', 'failed')),
  constraint reading_units_error_stage_check check (error_stage is null or error_stage in ('draft', 'voice')),
  constraint reading_units_attempts_check check (draft_attempts >= 0 and voice_attempts >= 0),
  constraint reading_units_unit_id_length check (char_length(unit_id) between 1 and 64),
  constraint reading_units_draft_size check (draft is null or pg_column_size(draft) < 65536),
  constraint reading_units_drafted_has_draft check (status <> 'drafted' or draft is not null)
);

revoke all on table public.reading_units from anon, authenticated, public;
grant all on table public.reading_units to service_role;
alter table public.reading_units enable row level security;
-- 정책을 만들지 않는다. RLS가 켜져 있어 브라우저 역할은 접근할 수 없고, 서버(service_role)만 읽는다.

-- 장 하나의 최종문(Pass 2 결과, 검사 통과). 한 번 저장하면 덮어쓰지 않는다.
-- 소유자는 무료 장을 언제나, 유료 장은 그 풀이에 구매 권한(결제 또는 이용권)이 있을 때만 읽는다.
-- 쓰기는 save_unit_final로만 한다 (서버 역할에도 읽기만 준다). meta는 소유자가 읽을 수 있으므로 초안·근거 원문을 넣지 않는다.
create table public.reading_sections (
  reading_id uuid not null references public.readings (id) on delete cascade,
  section_id text not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  tier text not null,
  content jsonb not null,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  primary key (reading_id, section_id),
  constraint reading_sections_tier_check check (tier in ('free', 'paid')),
  constraint reading_sections_section_id_length check (char_length(section_id) between 1 and 64),
  constraint reading_sections_content_size check (pg_column_size(content) < 65536)
);

-- 기본 권한이 service_role에도 모든 권한을 주므로 service_role에서도 걷어 낸 뒤 읽기만 준다.
revoke all on table public.reading_sections from anon, authenticated, service_role, public;
grant select on table public.reading_sections to authenticated;
grant select on table public.reading_sections to service_role;
alter table public.reading_sections enable row level security;
create policy "sections_owner_select" on public.reading_sections
  for select to authenticated
  using (
    (select auth.uid()) = user_id
    and (
      tier = 'free'
      or exists (
        select 1 from public.entitlements e
        where e.reading_id = reading_sections.reading_id and e.user_id = (select auth.uid())
      )
    )
  );

-- 단위 저장 함수가 함께 쓰는 확인. 지금 이 단계(tier)를 점유한 실행자(p_attempt)인지 실행 행을 잠근 뒤 확인하고,
-- 맞으면 풀이 소유자 ID를, 아니면 null을 돌려준다.
-- free: reading_free_runs가 running, 같은 시도 번호, 점유 시간 안.
-- paid: generation_jobs가 running, 같은 시도 번호, 점유 시간 안, 그리고 구매 권한(entitlements) 행이 있음.
-- 실행 행은 for share로 잠가 같은 풀이의 여러 장 저장이 함께 진행되게 하고, 그동안 이어받기·반환·완료가 끼어들지 못하게 한다.
create function public.lock_unit_writer(p_reading_id uuid, p_tier text, p_attempt integer)
returns uuid language plpgsql security invoker set search_path = '' as $$
declare
  v_free public.reading_free_runs;
  v_job public.generation_jobs;
begin
  if p_tier = 'free' then
    select * into v_free from public.reading_free_runs where reading_id = p_reading_id for share;
    if not found or v_free.status <> 'running' or v_free.attempts is distinct from p_attempt
      or v_free.lease_until is null or v_free.lease_until <= now() then
      return null;
    end if;
    return v_free.user_id;
  elsif p_tier = 'paid' then
    select * into v_job from public.generation_jobs where reading_id = p_reading_id for share;
    if not found or v_job.status <> 'running' or v_job.attempts is distinct from p_attempt
      or v_job.lease_until is null or v_job.lease_until <= now() then
      return null;
    end if;
    if not exists (select 1 from public.entitlements where reading_id = p_reading_id and user_id = v_job.user_id) then
      return null;
    end if;
    return v_job.user_id;
  end if;
  raise exception 'invalid_input' using errcode = 'P0001';
end;
$$;

-- Pass 1 초안을 저장한다. 점유한 실행자가 아니면 false이고 아무것도 저장하지 않는다.
-- 이미 최종문까지 끝난 장(done)이거나 다른 단계(tier)로 만든 장이면 바꾸지 않고 false다.
create function public.save_unit_draft(
  p_reading_id uuid, p_tier text, p_attempt integer, p_unit_id text, p_draft jsonb, p_meta jsonb
) returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid;
  v_unit public.reading_units;
begin
  v_user := public.lock_unit_writer(p_reading_id, p_tier, p_attempt);
  if v_user is null then
    return false;
  end if;

  insert into public.reading_units (reading_id, unit_id, user_id, tier)
  values (p_reading_id, p_unit_id, v_user, p_tier)
  on conflict (reading_id, unit_id) do nothing;
  select * into v_unit from public.reading_units
  where reading_id = p_reading_id and unit_id = p_unit_id
  for update;
  if v_unit.tier <> p_tier or v_unit.status = 'done' then
    return false;
  end if;

  update public.reading_units set
    status = 'drafted',
    draft = p_draft,
    draft_meta = p_meta,
    draft_attempts = draft_attempts + 1,
    error_stage = null,
    error_code = null,
    error_retryable = null,
    updated_at = now()
  where reading_id = p_reading_id and unit_id = p_unit_id;
  return true;
end;
$$;

-- Pass 2 최종문을 저장하고 장을 끝낸다. 최종문 저장과 장 상태 변경을 한 트랜잭션으로 한다.
-- 이미 최종문이 있으면 덮어쓰지 않는다 (처음 저장한 문장이 남는다). 그래도 장은 done이고 true다 (재전송에 안전).
-- 점유한 실행자가 아니거나 다른 단계(tier)로 만든 장이면 false이고 아무것도 저장하지 않는다.
create function public.save_unit_final(
  p_reading_id uuid, p_tier text, p_attempt integer, p_unit_id text, p_content jsonb, p_meta jsonb
) returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid;
  v_unit public.reading_units;
begin
  v_user := public.lock_unit_writer(p_reading_id, p_tier, p_attempt);
  if v_user is null then
    return false;
  end if;

  insert into public.reading_units (reading_id, unit_id, user_id, tier)
  values (p_reading_id, p_unit_id, v_user, p_tier)
  on conflict (reading_id, unit_id) do nothing;
  select * into v_unit from public.reading_units
  where reading_id = p_reading_id and unit_id = p_unit_id
  for update;
  if v_unit.tier <> p_tier then
    return false;
  end if;

  insert into public.reading_sections (reading_id, section_id, user_id, tier, content, meta)
  values (p_reading_id, p_unit_id, v_user, p_tier, p_content, coalesce(p_meta, '{}'::jsonb))
  on conflict (reading_id, section_id) do nothing;

  update public.reading_units set
    status = 'done',
    voice_attempts = voice_attempts + 1,
    error_stage = null,
    error_code = null,
    error_retryable = null,
    updated_at = now()
  where reading_id = p_reading_id and unit_id = p_unit_id;
  return true;
end;
$$;

-- 장 하나의 실패를 기록한다. p_stage가 draft면 Pass 1, voice면 Pass 2 시도 수를 1 늘리고 failed로 바꾼다 (초안은 남긴다).
-- 행이 없으면 만든다. 점유한 실행자가 아니거나, 이미 끝난 장(done)이거나, 다른 단계(tier)로 만든 장이면 saved false다.
-- 반환: { saved, draftAttempts, voiceAttempts } (저장하지 않았으면 지금 값, 행이 없으면 0)
create function public.fail_unit(
  p_reading_id uuid, p_tier text, p_attempt integer, p_unit_id text, p_stage text, p_code text, p_retryable boolean
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid;
  v_unit public.reading_units;
begin
  if p_stage is null or p_stage not in ('draft', 'voice') then
    raise exception 'invalid_input' using errcode = 'P0001';
  end if;

  v_user := public.lock_unit_writer(p_reading_id, p_tier, p_attempt);
  if v_user is null then
    select * into v_unit from public.reading_units where reading_id = p_reading_id and unit_id = p_unit_id;
    return jsonb_build_object(
      'saved', false,
      'draftAttempts', coalesce(v_unit.draft_attempts, 0),
      'voiceAttempts', coalesce(v_unit.voice_attempts, 0)
    );
  end if;

  insert into public.reading_units (reading_id, unit_id, user_id, tier)
  values (p_reading_id, p_unit_id, v_user, p_tier)
  on conflict (reading_id, unit_id) do nothing;
  select * into v_unit from public.reading_units
  where reading_id = p_reading_id and unit_id = p_unit_id
  for update;
  if v_unit.tier <> p_tier or v_unit.status = 'done' then
    return jsonb_build_object('saved', false, 'draftAttempts', v_unit.draft_attempts, 'voiceAttempts', v_unit.voice_attempts);
  end if;

  update public.reading_units set
    status = 'failed',
    draft_attempts = draft_attempts + case when p_stage = 'draft' then 1 else 0 end,
    voice_attempts = voice_attempts + case when p_stage = 'voice' then 1 else 0 end,
    error_stage = p_stage,
    error_code = p_code,
    error_retryable = p_retryable,
    updated_at = now()
  where reading_id = p_reading_id and unit_id = p_unit_id
  returning * into v_unit;
  return jsonb_build_object('saved', true, 'draftAttempts', v_unit.draft_attempts, 'voiceAttempts', v_unit.voice_attempts);
end;
$$;

----------------------------------------------------------------------
-- 5) 호출 단위 토큰 사용량
----------------------------------------------------------------------
-- 실제 LLM 호출(HTTP 요청) 하나마다 한 줄 (전송 재시도, 검사 실패 뒤 재작성, 중간에 끊은 스트림도 각각 한 줄).
-- 집계 규칙은 src/server/llm/usage.ts와 같다.
-- - input_tokens에는 cached_input_tokens가, output_tokens에는 reasoning_tokens가 포함되어 있다. 다시 더하지 않는다.
-- - API가 실제로 돌려준 0과 받지 못한 값(null)을 구분한다. 받지 못한 값을 0으로 채우거나 글자 수로 추정하지 않는다.
-- - outcome: usage(사용량을 받음), unknown(요청은 보냈지만 사용량을 받지 못함), rejected(오류 응답으로 생성하지 않음).
-- 재시도는 새 call_key로 남겨 이전 기록을 덮지 않는다. 같은 call_key를 다시 보내면 처음 기록을 둔다.
-- 서버 전용이다. 출생정보, 질문 원문, 프롬프트와 생성 문장은 넣지 않는다.
create table public.llm_calls (
  id bigint generated always as identity primary key,
  call_key text not null unique,
  reading_id uuid references public.readings (id) on delete cascade,
  user_id uuid references auth.users (id) on delete cascade,
  followup_id uuid references public.followups (id) on delete cascade,
  product_id text,
  tier text,
  step text not null,
  unit_id text,
  model_requested text,
  model_actual text,
  prompt_version text,
  schema_version text,
  persona_version text,
  reasoning_effort text,
  provider_response_id text,
  provider_request_id text,
  outcome text not null,
  error_code text,
  started_at timestamptz not null,
  ended_at timestamptz not null,
  input_tokens integer,
  output_tokens integer,
  cached_input_tokens integer,
  reasoning_tokens integer,
  usage_received boolean not null,
  created_at timestamptz not null default now(),
  constraint llm_calls_call_key_length check (char_length(call_key) between 1 and 200),
  constraint llm_calls_tier_check check (tier is null or tier in ('free', 'paid')),
  constraint llm_calls_step_check check (step in ('classify', 'pass1', 'pass2', 'followup')),
  constraint llm_calls_outcome_check check (outcome in ('usage', 'unknown', 'rejected')),
  constraint llm_calls_tokens_check check (
    (input_tokens is null or input_tokens >= 0)
    and (output_tokens is null or output_tokens >= 0)
    and (cached_input_tokens is null or cached_input_tokens >= 0)
    and (reasoning_tokens is null or reasoning_tokens >= 0)
  ),
  -- 둘 다 받았을 때만 비교한다 (하나라도 모르면 확인할 수 없다).
  constraint llm_calls_cached_subset check (cached_input_tokens is null or input_tokens is null or cached_input_tokens <= input_tokens),
  constraint llm_calls_reasoning_subset check (reasoning_tokens is null or output_tokens is null or reasoning_tokens <= output_tokens)
);
create index llm_calls_reading_idx on public.llm_calls (reading_id, started_at);
create index llm_calls_user_idx on public.llm_calls (user_id, started_at desc);
create index llm_calls_followup_idx on public.llm_calls (followup_id) where followup_id is not null;

revoke all on table public.llm_calls from anon, authenticated, public;
grant all on table public.llm_calls to service_role;
alter table public.llm_calls enable row level security;
-- 정책을 만들지 않는다. RLS가 켜져 있어 브라우저 역할은 읽을 수 없고, 서버(service_role)만 접근한다.

-- 호출 하나를 기록한다. 키는 callKey, readingId, userId, followupId, productId, tier, step, unitId, modelRequested,
-- modelActual, promptVersion, schemaVersion, personaVersion, reasoningEffort, providerResponseId, providerRequestId,
-- outcome, errorCode, startedAt, endedAt(ISO 8601), inputTokens, outputTokens, cachedInputTokens, reasoningTokens, usageReceived.
-- 토큰 값이 없거나 JSON null이면 null(모름)로 남는다. usageReceived가 없으면 outcome = 'usage'로 본다.
-- 같은 callKey가 이미 있으면 아무것도 바꾸지 않고 false다. 값이 규칙에 맞지 않으면(캐시 > 입력 등) 오류로 거부한다.
create function public.record_llm_call(p_call jsonb)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_count integer;
begin
  insert into public.llm_calls (
    call_key, reading_id, user_id, followup_id, product_id, tier, step, unit_id,
    model_requested, model_actual, prompt_version, schema_version, persona_version, reasoning_effort,
    provider_response_id, provider_request_id, outcome, error_code, started_at, ended_at,
    input_tokens, output_tokens, cached_input_tokens, reasoning_tokens, usage_received
  ) values (
    p_call ->> 'callKey',
    (p_call ->> 'readingId')::uuid,
    (p_call ->> 'userId')::uuid,
    (p_call ->> 'followupId')::uuid,
    p_call ->> 'productId',
    p_call ->> 'tier',
    p_call ->> 'step',
    p_call ->> 'unitId',
    p_call ->> 'modelRequested',
    p_call ->> 'modelActual',
    p_call ->> 'promptVersion',
    p_call ->> 'schemaVersion',
    p_call ->> 'personaVersion',
    p_call ->> 'reasoningEffort',
    p_call ->> 'providerResponseId',
    p_call ->> 'providerRequestId',
    p_call ->> 'outcome',
    p_call ->> 'errorCode',
    (p_call ->> 'startedAt')::timestamptz,
    (p_call ->> 'endedAt')::timestamptz,
    (p_call ->> 'inputTokens')::integer,
    (p_call ->> 'outputTokens')::integer,
    (p_call ->> 'cachedInputTokens')::integer,
    (p_call ->> 'reasoningTokens')::integer,
    coalesce((p_call ->> 'usageReceived')::boolean, (p_call ->> 'outcome') = 'usage')
  )
  on conflict (call_key) do nothing;
  get diagnostics v_count = row_count;
  return v_count = 1;
end;
$$;

-- 풀이·단계(무료/유료)·작업 종류(classify, pass1, pass2, followup)별 합계. 운영자와 관리자 조회가 쓴다.
-- 토큰 합계는 받은 값만 더하고, 받은 값이 하나도 없으면 null이다 (rejected 호출만 있는 칸도 null).
-- uncached_input_tokens = input - cached, total_tokens = input + output (캐시·추론을 다시 더하지 않는다).
-- usage_complete는 usage를 받지 못한 호출(unknown)이 없고, usage를 받은 호출의 입력·출력·캐시 값이 모두 있을 때만 true다.
create view public.llm_call_usage with (security_invoker = true) as
select
  c.reading_id,
  c.tier,
  c.step,
  count(*)::integer as calls,
  (count(*) filter (where c.outcome = 'usage'))::integer as calls_with_usage,
  (count(*) filter (where c.outcome = 'unknown'))::integer as calls_without_usage,
  sum(c.input_tokens) as input_tokens,
  sum(c.cached_input_tokens) as cached_input_tokens,
  sum(c.input_tokens) - sum(c.cached_input_tokens) as uncached_input_tokens,
  sum(c.output_tokens) as output_tokens,
  sum(c.reasoning_tokens) as reasoning_tokens,
  sum(c.input_tokens) + sum(c.output_tokens) as total_tokens,
  (
    count(*) filter (where c.outcome = 'unknown') = 0
    and coalesce(
      bool_and(c.input_tokens is not null and c.output_tokens is not null and c.cached_input_tokens is not null)
        filter (where c.outcome = 'usage'),
      true
    )
  ) as usage_complete,
  min(c.started_at) as started_at,
  max(c.ended_at) as ended_at,
  array_agg(distinct coalesce(c.model_actual, c.model_requested))
    filter (where coalesce(c.model_actual, c.model_requested) is not null) as models,
  array_agg(distinct c.prompt_version) filter (where c.prompt_version is not null) as prompt_versions
from public.llm_calls c
group by c.reading_id, c.tier, c.step;

revoke all on table public.llm_call_usage from anon, authenticated, public;
grant select on table public.llm_call_usage to service_role;

-- 관리자 화면의 호출 사용량. 최근 호출 순으로 p_limit개(1~200, 없으면 20) 풀이의 단계별 합계와 풀이별 합계,
-- 그리고 그 풀이들 전체의 합계를 돌려준다. 상품 ID·버전, 풀이 생성 시각, 호출 시각, 모델·프롬프트 버전, 토큰 수만 담는다.
-- 별명, 출생정보, 궁금한 점 원문, 생성 문장은 담지 않는다. 관리자 확인은 서버가 먼저 한다 (실행 권한은 service_role에만).
create function public.admin_llm_usage(p_limit integer)
returns jsonb language sql stable security invoker set search_path = '' as $$
  with recent as (
    select c.reading_id, min(c.started_at) as first_call_at, max(c.ended_at) as last_call_at
    from public.llm_calls c
    where c.reading_id is not null
    group by c.reading_id
    order by max(c.ended_at) desc, c.reading_id
    limit least(greatest(coalesce(p_limit, 20), 1), 200)
  ),
  steps as (
    select u.* from public.llm_call_usage u
    where u.reading_id in (select r.reading_id from recent r)
  ),
  -- 풀이별 합계(everything = 0)와 나열한 풀이 전체의 합계(everything = 1). 단계별 합계를 다시 더한다.
  totals as (
    select
      s.reading_id,
      grouping(s.reading_id) as everything,
      jsonb_build_object(
        'calls', coalesce(sum(s.calls), 0)::integer,
        'callsWithUsage', coalesce(sum(s.calls_with_usage), 0)::integer,
        'callsWithoutUsage', coalesce(sum(s.calls_without_usage), 0)::integer,
        'inputTokens', sum(s.input_tokens),
        'cachedInputTokens', sum(s.cached_input_tokens),
        'uncachedInputTokens', sum(s.input_tokens) - sum(s.cached_input_tokens),
        'outputTokens', sum(s.output_tokens),
        'reasoningTokens', sum(s.reasoning_tokens),
        'totalTokens', sum(s.input_tokens) + sum(s.output_tokens),
        'usageComplete', coalesce(bool_and(s.usage_complete), true),
        'startedAt', min(s.started_at),
        'endedAt', max(s.ended_at)
      ) as total
    from steps s
    group by grouping sets ((s.reading_id), ())
  )
  select jsonb_build_object(
    'limit', least(greatest(coalesce(p_limit, 20), 1), 200),
    'readings', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'readingId', r.reading_id,
          'userId', rd.user_id,
          'productId', rd.product_id,
          'productVersion', rd.product_version,
          'personaId', rd.persona_id,
          'personaVersion', rd.persona_version,
          'createdAt', rd.created_at,
          'firstCallAt', r.first_call_at,
          'lastCallAt', r.last_call_at,
          'steps', coalesce((
            select jsonb_agg(
              jsonb_build_object(
                'tier', s.tier,
                'step', s.step,
                'calls', s.calls,
                'callsWithUsage', s.calls_with_usage,
                'callsWithoutUsage', s.calls_without_usage,
                'inputTokens', s.input_tokens,
                'cachedInputTokens', s.cached_input_tokens,
                'uncachedInputTokens', s.uncached_input_tokens,
                'outputTokens', s.output_tokens,
                'reasoningTokens', s.reasoning_tokens,
                'totalTokens', s.total_tokens,
                'usageComplete', s.usage_complete,
                'startedAt', s.started_at,
                'endedAt', s.ended_at,
                'models', coalesce(to_jsonb(s.models), '[]'::jsonb),
                'promptVersions', coalesce(to_jsonb(s.prompt_versions), '[]'::jsonb)
              )
              order by
                coalesce(array_position(array['free', 'paid']::text[], s.tier), 3),
                array_position(array['classify', 'pass1', 'pass2', 'followup']::text[], s.step)
            )
            from steps s
            where s.reading_id = r.reading_id
          ), '[]'::jsonb),
          'total', (select t.total from totals t where t.everything = 0 and t.reading_id = r.reading_id)
        )
        order by r.last_call_at desc, r.reading_id
      )
      from recent r
      join public.readings rd on rd.id = r.reading_id
    ), '[]'::jsonb),
    'total', (select t.total from totals t where t.everything = 1)
  );
$$;

----------------------------------------------------------------------
-- 실행 권한: 기본 권한을 걷어 내고 서버(service_role)에만 준다
----------------------------------------------------------------------
revoke all on function public.create_reading(uuid, jsonb, jsonb, integer) from public, anon, authenticated;
revoke all on function public.fix_reference_date(uuid, date) from public, anon, authenticated;
revoke all on function public.release_generation(uuid, integer) from public, anon, authenticated;
revoke all on function public.claim_free_run(uuid, uuid, boolean, text, text, text, text, integer, integer, integer) from public, anon, authenticated;
revoke all on function public.release_free_run(uuid, integer) from public, anon, authenticated;
revoke all on function public.complete_free_run(uuid, integer) from public, anon, authenticated;
revoke all on function public.fail_free_run(uuid, integer, text, boolean) from public, anon, authenticated;
revoke all on function public.lock_unit_writer(uuid, text, integer) from public, anon, authenticated;
revoke all on function public.save_unit_draft(uuid, text, integer, text, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.save_unit_final(uuid, text, integer, text, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.fail_unit(uuid, text, integer, text, text, text, boolean) from public, anon, authenticated;
revoke all on function public.record_llm_call(jsonb) from public, anon, authenticated;
revoke all on function public.admin_llm_usage(integer) from public, anon, authenticated;

grant execute on function public.create_reading(uuid, jsonb, jsonb, integer) to service_role;
grant execute on function public.fix_reference_date(uuid, date) to service_role;
grant execute on function public.release_generation(uuid, integer) to service_role;
grant execute on function public.claim_free_run(uuid, uuid, boolean, text, text, text, text, integer, integer, integer) to service_role;
grant execute on function public.release_free_run(uuid, integer) to service_role;
grant execute on function public.complete_free_run(uuid, integer) to service_role;
grant execute on function public.fail_free_run(uuid, integer, text, boolean) to service_role;
grant execute on function public.lock_unit_writer(uuid, text, integer) to service_role;
grant execute on function public.save_unit_draft(uuid, text, integer, text, jsonb, jsonb) to service_role;
grant execute on function public.save_unit_final(uuid, text, integer, text, jsonb, jsonb) to service_role;
grant execute on function public.fail_unit(uuid, text, integer, text, text, text, boolean) to service_role;
grant execute on function public.record_llm_call(jsonb) to service_role;
grant execute on function public.admin_llm_usage(integer) to service_role;
