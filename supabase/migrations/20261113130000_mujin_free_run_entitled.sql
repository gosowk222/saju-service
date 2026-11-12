-- 무진의 종합 사주: 구매 권한이 있는 풀이는 무료 단계의 회원당 하루 시작 수 제한을 받지 않는다.
--
-- 하루 시작 수 제한(claim_free_run의 p_daily_limit)은 결제 전 LLM 비용 상한이다. 그런데 이용권·결제로 구매 권한(entitlements)이
-- 생긴 풀이도 새 무료 단계를 시작하지 못해, 유료 단계가 '무료 단계가 아직 끝나지 않음'(not_ready)으로 최대 24시간 막혔다.
-- 구매한 풀이에는 이 상한이 필요하지 않으므로, 그 풀이에 entitlements 행이 있으면 하루 시작 수를 세지 않고 시작한다.
--
-- 같은 인자·같은 반환으로만 교체한다. 그 밖의 동작은 20261113120000_mujin_scroll.sql의 함수와 같다:
-- 회원 단위 잠금(advisory lock), 풀이 소유 확인(readings for share, 단위 저장과 서로 기다리지 않게), 실행 행 잠금(for update),
-- 상태 판정(completed·running·failed·exhausted), 시도 상한, 처음 시작할 때 생성 설정 고정, 반환 모양.
-- 권한 없는 풀이의 하루 제한 계산(다른 풀이에서 최근 24시간 안에 시작한 무료 단계 수)도 그대로다.
-- entitlements는 잠그지 않고 읽기만 하므로 잠금 순서(generation_jobs 또는 reading_free_runs → reading_units → reading_sections → free_tickets)는 바뀌지 않는다.
-- 기존 행은 바꾸지 않는다.

create or replace function public.claim_free_run(
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
    -- 구매 권한이 있는 풀이는 세지 않는다 (결제 전 비용 상한이라 구매한 풀이에는 적용하지 않는다).
    if not exists (select 1 from public.entitlements where reading_id = p_reading_id and user_id = p_user_id) then
      select count(*) into v_recent from public.reading_free_runs
      where user_id = p_user_id and reading_id <> p_reading_id and started_at >= now() - interval '24 hours';
      if v_recent >= p_daily_limit then
        return jsonb_build_object('claimed', false, 'reason', 'daily_limited', 'run', null);
      end if;
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

-- 실행 권한: 교체 전과 같이 기본 권한을 걷어 내고 서버(service_role)에만 준다.
revoke all on function public.claim_free_run(uuid, uuid, boolean, text, text, text, text, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.claim_free_run(uuid, uuid, boolean, text, text, text, text, integer, integer, integer) to service_role;
