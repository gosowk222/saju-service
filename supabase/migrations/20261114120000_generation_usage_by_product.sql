-- 상품(묘묘·무진)을 함께 보는 생성 사용량과 묘묘 2-pass의 호출 단위 기록.
--
-- 왜: 관리자 사용량(admin_llm_usage)은 호출 단위 표 llm_calls만 읽었다. 묘묘 최초 풀이는 시도 합계(generation_attempts),
-- 묘묘 후속 질문은 followups.usage에만 남아서 기록은 있는데도 관리자 화면에 묘묘가 보이지 않았다.
-- 이 migration은 기존 기록을 옮기거나 다시 쓰지 않는다 (같은 사용량을 다른 표에 다시 저장하지 않는다). 조회가 세 출처를 함께 읽는다.
--
-- 1) llm_calls에 attempt(생성 작업의 시도 번호), persona_id(풀이의 캐릭터), policy_version(생성 묶음 ID) 칸을 더한다.
--    이전 행은 null로 남는다 (모르는 값을 채우지 않는다). record_llm_call은 같은 인자·같은 반환으로 바꿔 새 키도 저장한다.
-- 2) generation_attempts.outcome에 released(시간 예산이 끝나 남은 일을 반납하고 다음 요청이 이어 씀)를 더한다. 2-pass 묘묘가 쓴다.
-- 3) admin_generation_usage(p_limit, p_product): 최근 활동 순 풀이마다 최초 풀이·질문 정리·후속 질문 사용량을 단계별로 돌려준다.
--    출처 고르기 (같은 사용량을 두 번 세지 않는다):
--    - 최초 풀이 시도(generation_attempts 한 줄)는 같은 풀이·같은 시도 번호의 호출 기록(llm_calls, 후속 질문 아님)이 시도의 호출 수와
--      같으면 호출 기록을 쓰고, 없거나 수가 맞지 않으면(기록 일부 실패, 이전 1-pass) 시도 합계를 쓴다. 그 시도의 호출 기록은 빼고 센다.
--    - 시도 기록이 없는 호출 기록(무진, 아직 끝나지 않은 시도)은 호출 기록을 쓴다.
--    - 후속 질문은 그 질문의 호출 기록 수가 followups.usage의 호출 수와 같으면 호출 기록을, 아니면 followups.usage 합계를 쓴다.
--    - 토큰 합계는 받은 값만 더한다. 받은 값이 하나도 없으면 null(모름)이다. 캐시 입력은 입력에 포함된 값이라 합계(입력 + 출력)에 다시 더하지 않는다.
--    - 완전성: 사용량을 받지 못한 호출이 없고, 시도마다 기록이 있고, 기록 없는 후속 질문이 없을 때만 true다.
--    포함 범위: 생성을 시작했거나 사용량 기록이 있는 풀이 가운데 마지막 활동(호출·시도 기록·후속 질문·작업 상태 변경)이 최근인 p_limit개(1~200).
--    p_product가 있으면 그 상품의 풀이만 고른다. 상품별·전체 합계는 고른 풀이들만 더한다 (같은 범위).
--    별명, 출생정보, 궁금한 점·후속 질문 원문, 생성 문장은 담지 않는다. 관리자 확인은 서버가 먼저 하고, 실행 권한은 service_role에만 준다.
--
-- 기존 admin_llm_usage는 그대로 둔다. 상품 ID와 버전 이름은 SQL에 넣지 않는다 (생성 방식의 이름은 서버가 버전으로 붙인다).

----------------------------------------------------------------------
-- 1) llm_calls: 시도 번호, 캐릭터, 생성 묶음
----------------------------------------------------------------------
alter table public.llm_calls
  add column attempt integer,
  add column persona_id text,
  add column policy_version text,
  add constraint llm_calls_attempt_check check (attempt is null or attempt > 0),
  add constraint llm_calls_persona_id_length check (persona_id is null or char_length(persona_id) between 1 and 64),
  add constraint llm_calls_policy_version_length check (policy_version is null or char_length(policy_version) between 1 and 80);

create index llm_calls_reading_attempt_idx on public.llm_calls (reading_id, attempt) where followup_id is null;

-- 같은 인자·같은 반환으로 바꾼다. 새 키(attempt, personaId, policyVersion)가 없으면 null이다 (이전 서버가 보낸 행도 그대로 받는다).
create or replace function public.record_llm_call(p_call jsonb)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_count integer;
begin
  insert into public.llm_calls (
    call_key, reading_id, user_id, followup_id, product_id, tier, step, unit_id,
    model_requested, model_actual, prompt_version, schema_version, persona_version, reasoning_effort,
    provider_response_id, provider_request_id, outcome, error_code, started_at, ended_at,
    input_tokens, output_tokens, cached_input_tokens, reasoning_tokens, usage_received,
    attempt, persona_id, policy_version
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
    coalesce((p_call ->> 'usageReceived')::boolean, (p_call ->> 'outcome') = 'usage'),
    (p_call ->> 'attempt')::integer,
    p_call ->> 'personaId',
    p_call ->> 'policyVersion'
  )
  on conflict (call_key) do nothing;
  get diagnostics v_count = row_count;
  return v_count = 1;
end;
$$;

----------------------------------------------------------------------
-- 2) generation_attempts: 반납(released)
----------------------------------------------------------------------
alter table public.generation_attempts drop constraint generation_attempts_outcome_check;
alter table public.generation_attempts
  add constraint generation_attempts_outcome_check check (outcome in ('completed', 'failed', 'handed_over', 'released'));

----------------------------------------------------------------------
-- 3) 상품을 함께 보는 생성 사용량
----------------------------------------------------------------------
create function public.admin_generation_usage(p_limit integer, p_product text)
returns jsonb language sql stable security invoker set search_path = '' as $$
  with
  -- 최초 풀이 시도마다 같은 시도 번호의 호출 기록 수 (후속 질문 제외).
  attempt_cover as (
    select a.reading_id, a.attempt, a.llm_calls,
      (select count(*)::integer from public.llm_calls c
        where c.reading_id = a.reading_id and c.attempt = a.attempt and c.followup_id is null) as logged
    from public.generation_attempts a
  ),
  -- 시도 합계로 셀 시도: 호출 기록이 없거나(이전 1-pass) 수가 맞지 않는다(기록 일부 실패).
  summary_attempts as (
    select ac.reading_id, ac.attempt, case when ac.logged = 0 then 'attempt' else 'attempt-partial' end as source
    from attempt_cover ac
    where ac.logged = 0 or ac.logged <> ac.llm_calls
  ),
  followup_cover as (
    select f.id, f.reading_id, f.usage,
      (select count(*)::integer from public.llm_calls c where c.followup_id = f.id) as logged
    from public.followups f
  ),
  -- followups.usage 합계로 셀 후속 질문: 호출이 있었는데 호출 기록이 없거나 수가 맞지 않는다 (묘묘 후속 질문은 이 기록만 있다).
  summary_followups as (
    select fc.id, fc.reading_id, fc.usage from followup_cover fc
    where fc.usage is not null and coalesce((fc.usage ->> 'calls')::integer, 0) > 0
      and (fc.logged = 0 or fc.logged <> (fc.usage ->> 'calls')::integer)
  ),
  -- 사용량 기록도 호출 기록도 없는 후속 질문 (사용량 기록 전에 만든 질문 등). 사용량을 모른다.
  unrecorded_followups as (
    select fc.reading_id, count(*)::integer as n from followup_cover fc
    where fc.usage is null and fc.logged = 0
    group by fc.reading_id
  ),
  counted_calls as (
    select c.* from public.llm_calls c
    where c.reading_id is not null
      and not exists (select 1 from summary_attempts s where c.followup_id is null and s.reading_id = c.reading_id and s.attempt = c.attempt)
      and not exists (select 1 from summary_followups s where s.id = c.followup_id)
  ),
  activity as (
    select x.reading_id, max(x.at) as last_at from (
      select c.reading_id, c.ended_at as at from public.llm_calls c where c.reading_id is not null
      union all select a.reading_id, a.created_at from public.generation_attempts a
      union all select f.reading_id, coalesce(f.answered_at, f.created_at) from public.followups f where f.usage is not null
      union all select j.reading_id, j.updated_at from public.generation_jobs j where j.attempts > 0
      union all select r.reading_id, r.updated_at from public.reading_free_runs r where r.attempts > 0
    ) x
    group by x.reading_id
  ),
  recent as (
    select a.reading_id, a.last_at
    from activity a
    join public.readings rd on rd.id = a.reading_id
    where p_product is null or rd.product_id = p_product
    order by a.last_at desc, a.reading_id
    limit least(greatest(coalesce(p_limit, 20), 1), 200)
  ),
  parts as (
    -- 호출 단위 기록 (무진, 묘묘 2-pass, 무진 후속 질문).
    select c.reading_id,
      case when c.followup_id is null then 'initial' else 'followup' end as scope,
      c.tier, c.step, 'calls'::text as source,
      count(*)::integer as calls,
      (count(*) filter (where c.outcome = 'usage'))::integer as calls_with_usage,
      (count(*) filter (where c.outcome = 'unknown'))::integer as calls_without_usage,
      (count(*) filter (where c.outcome = 'rejected'))::integer as calls_rejected,
      sum(c.input_tokens)::bigint as input_tokens,
      sum(c.cached_input_tokens)::bigint as cached_input_tokens,
      sum(c.output_tokens)::bigint as output_tokens,
      sum(c.reasoning_tokens)::bigint as reasoning_tokens,
      (
        count(*) filter (where c.outcome = 'unknown') = 0
        and coalesce(
          bool_and(c.input_tokens is not null and c.output_tokens is not null and c.cached_input_tokens is not null) filter (where c.outcome = 'usage'),
          true
        )
      ) as usage_complete,
      min(c.started_at) as started_at,
      max(c.ended_at) as ended_at,
      array_agg(distinct coalesce(c.model_actual, c.model_requested)) filter (where coalesce(c.model_actual, c.model_requested) is not null) as models,
      array_agg(distinct c.prompt_version) filter (where c.prompt_version is not null) as prompt_versions,
      array_agg(distinct c.policy_version) filter (where c.policy_version is not null) as policy_versions,
      array_agg(distinct c.attempt) filter (where c.attempt is not null) as attempts
    from counted_calls c
    where c.reading_id in (select r.reading_id from recent r)
    group by c.reading_id, case when c.followup_id is null then 'initial' else 'followup' end, c.tier, c.step
    union all
    -- 최초 풀이 시도 합계 (이전 1-pass 묘묘, 호출 기록이 일부 빠진 시도). 단계를 나눌 수 없다.
    select a.reading_id, 'initial', null, 'attempt', s.source,
      sum(a.llm_calls)::integer,
      null,
      sum(a.calls_without_usage)::integer,
      null,
      sum(a.input_tokens)::bigint,
      sum(a.cached_input_tokens)::bigint,
      sum(a.output_tokens)::bigint,
      sum(a.reasoning_tokens)::bigint,
      bool_and(a.usage_complete),
      min(a.created_at - make_interval(secs => (coalesce(a.duration_ms, 0) / 1000.0)::double precision)),
      max(a.created_at),
      array_agg(distinct coalesce(a.actual_model, a.model_id)) filter (where coalesce(a.actual_model, a.model_id) is not null),
      array_agg(distinct a.prompt_version) filter (where a.prompt_version is not null),
      null::text[],
      array_agg(distinct a.attempt)
    from public.generation_attempts a
    join summary_attempts s on s.reading_id = a.reading_id and s.attempt = a.attempt
    where a.reading_id in (select r.reading_id from recent r)
    group by a.reading_id, s.source
    union all
    -- 후속 질문 합계 (followups.usage). 질문 정리와 답변을 나눌 수 없다.
    select fo.reading_id, 'followup', null, 'followup', 'followup-summary',
      sum(coalesce((fo.usage ->> 'calls')::integer, 0))::integer,
      sum(coalesce((fo.usage ->> 'callsWithUsage')::integer, 0))::integer,
      sum(coalesce((fo.usage ->> 'callsWithoutUsage')::integer, 0))::integer,
      null,
      sum((fo.usage ->> 'inputTokens')::bigint),
      sum((fo.usage ->> 'cachedInputTokens')::bigint),
      sum((fo.usage ->> 'outputTokens')::bigint),
      sum((fo.usage ->> 'reasoningTokens')::bigint),
      bool_and(coalesce((fo.usage ->> 'complete')::boolean, false)),
      min(fo.created_at),
      max(coalesce(fo.answered_at, fo.created_at)),
      array_agg(distinct coalesce(fo.actual_model, fo.model_id)) filter (where coalesce(fo.actual_model, fo.model_id) is not null),
      array_agg(distinct fo.prompt_version) filter (where fo.prompt_version is not null),
      null::text[],
      null::integer[]
    from summary_followups sf
    join public.followups fo on fo.id = sf.id
    where sf.reading_id in (select r.reading_id from recent r)
    group by fo.reading_id
  ),
  -- 풀이별 시도 정보. 시도 기록(generation_attempts)이 있는 풀이(묘묘)는 시작한 시도마다 시도 기록이나 호출 기록이 있는지 본다.
  readings_info as (
    select r.reading_id, r.last_at,
      j.status as job_status, j.attempts as job_attempts, j.prompt_version as job_prompt_version, j.started_at as job_started_at, j.completed_at as job_completed_at,
      fr.status as free_status, fr.attempts as free_attempts,
      (select jsonb_object_agg(o.outcome, o.n) from (
        select a.outcome, count(*)::integer as n from public.generation_attempts a where a.reading_id = r.reading_id group by a.outcome
      ) o) as attempt_outcomes,
      case when exists (select 1 from public.generation_attempts a where a.reading_id = r.reading_id) then greatest(
        coalesce(j.attempts, 0) - (
          select count(distinct x.attempt)::integer from (
            select a.attempt from public.generation_attempts a where a.reading_id = r.reading_id
            union select c.attempt from public.llm_calls c
              where c.reading_id = r.reading_id and c.followup_id is null and c.attempt is not null and coalesce(c.tier, '') <> 'free'
          ) x
        ),
        0
      ) end as missing_attempts,
      coalesce((select u.n from unrecorded_followups u where u.reading_id = r.reading_id), 0) as unrecorded_followups,
      (select min(m.created_at) from public.reading_messages m where m.reading_id = r.reading_id) as first_message_at
    from recent r
    left join public.generation_jobs j on j.reading_id = r.reading_id
    left join public.reading_free_runs fr on fr.reading_id = r.reading_id
  ),
  reading_totals as (
    select i.reading_id,
      (
        coalesce(bool_and(p.usage_complete), true)
        and coalesce(i.missing_attempts, 0) = 0
        and i.unrecorded_followups = 0
        -- 생성을 시작했는데 최초 풀이 기록이 하나도 없으면 사용량을 모른다.
        and not ((coalesce(i.job_attempts, 0) > 0 or coalesce(i.free_attempts, 0) > 0) and count(p.reading_id) filter (where p.scope = 'initial') = 0)
      ) as complete,
      jsonb_build_object(
        'calls', coalesce(sum(p.calls), 0)::integer,
        'callsWithUsage', case when count(p.reading_id) = 0 then 0 when bool_and(p.calls_with_usage is not null) then sum(p.calls_with_usage)::integer end,
        'callsWithoutUsage', coalesce(sum(p.calls_without_usage), 0)::integer,
        'inputTokens', sum(p.input_tokens),
        'cachedInputTokens', sum(p.cached_input_tokens),
        'uncachedInputTokens', sum(p.input_tokens) - sum(p.cached_input_tokens),
        'outputTokens', sum(p.output_tokens),
        'reasoningTokens', sum(p.reasoning_tokens),
        'totalTokens', sum(p.input_tokens) + sum(p.output_tokens),
        'startedAt', min(p.started_at),
        'endedAt', max(p.ended_at)
      ) as total,
      sum(p.calls) as calls_sum,
      sum(p.calls_with_usage) as with_sum,
      (count(p.reading_id) = 0 or bool_and(p.calls_with_usage is not null)) as with_known,
      sum(p.calls_without_usage) as without_sum,
      sum(p.input_tokens) as input_sum,
      sum(p.cached_input_tokens) as cached_sum,
      sum(p.output_tokens) as output_sum,
      sum(p.reasoning_tokens) as reasoning_sum
    from readings_info i
    left join parts p on p.reading_id = i.reading_id
    group by i.reading_id, i.missing_attempts, i.unrecorded_followups, i.job_attempts, i.free_attempts
  ),
  -- 상품별 합계(everything = 0)와 고른 풀이 전체의 합계(everything = 1). 풀이 합계를 다시 더한다 (단계 합계와 풀이 합계를 함께 더하지 않는다).
  grouped as (
    select rd.product_id, grouping(rd.product_id) as everything,
      jsonb_build_object(
        'readings', count(*)::integer,
        'calls', coalesce(sum(t.calls_sum), 0)::integer,
        'callsWithUsage', case when bool_and(coalesce(t.with_known, true)) then coalesce(sum(t.with_sum), 0)::integer end,
        'callsWithoutUsage', coalesce(sum(t.without_sum), 0)::integer,
        'inputTokens', sum(t.input_sum),
        'cachedInputTokens', sum(t.cached_sum),
        'uncachedInputTokens', sum(t.input_sum) - sum(t.cached_sum),
        'outputTokens', sum(t.output_sum),
        'reasoningTokens', sum(t.reasoning_sum),
        'totalTokens', sum(t.input_sum) + sum(t.output_sum),
        'usageComplete', coalesce(bool_and(t.complete), true)
      ) as total
    from reading_totals t
    join public.readings rd on rd.id = t.reading_id
    group by grouping sets ((rd.product_id), ())
  )
  select jsonb_build_object(
    'limit', least(greatest(coalesce(p_limit, 20), 1), 200),
    'product', p_product,
    'readings', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'readingId', i.reading_id,
          'productId', rd.product_id,
          'productVersion', rd.product_version,
          'personaId', rd.persona_id,
          'personaVersion', rd.persona_version,
          'createdAt', rd.created_at,
          'lastActivityAt', i.last_at,
          'job', case when i.job_status is null then null else jsonb_build_object(
            'status', i.job_status,
            'attempts', i.job_attempts,
            'promptVersion', i.job_prompt_version,
            'startedAt', i.job_started_at,
            'completedAt', i.job_completed_at
          ) end,
          'freeRun', case when i.free_status is null then null else jsonb_build_object('status', i.free_status, 'attempts', i.free_attempts) end,
          'attemptOutcomes', coalesce(i.attempt_outcomes, '{}'::jsonb),
          'missingAttempts', i.missing_attempts,
          'unrecordedFollowups', i.unrecorded_followups,
          'firstMessageAt', i.first_message_at,
          'parts', coalesce((
            select jsonb_agg(
              jsonb_build_object(
                'scope', p.scope,
                'tier', p.tier,
                'step', p.step,
                'source', p.source,
                'calls', p.calls,
                'callsWithUsage', p.calls_with_usage,
                'callsWithoutUsage', p.calls_without_usage,
                'callsRejected', p.calls_rejected,
                'inputTokens', p.input_tokens,
                'cachedInputTokens', p.cached_input_tokens,
                'uncachedInputTokens', p.input_tokens - p.cached_input_tokens,
                'outputTokens', p.output_tokens,
                'reasoningTokens', p.reasoning_tokens,
                'totalTokens', p.input_tokens + p.output_tokens,
                'usageComplete', p.usage_complete,
                'startedAt', p.started_at,
                'endedAt', p.ended_at,
                'models', coalesce(to_jsonb(p.models), '[]'::jsonb),
                'promptVersions', coalesce(to_jsonb(p.prompt_versions), '[]'::jsonb),
                'policyVersions', coalesce(to_jsonb(p.policy_versions), '[]'::jsonb),
                'attempts', coalesce(to_jsonb(p.attempts), '[]'::jsonb)
              )
              order by
                case p.scope when 'initial' then 0 else 1 end,
                coalesce(array_position(array['free', 'paid']::text[], p.tier), 3),
                array_position(array['attempt', 'classify', 'pass1', 'pass2', 'followup']::text[], p.step),
                p.source
            )
            from parts p
            where p.reading_id = i.reading_id
          ), '[]'::jsonb),
          'total', t.total || jsonb_build_object('usageComplete', t.complete)
        )
        order by i.last_at desc, i.reading_id
      )
      from readings_info i
      join public.readings rd on rd.id = i.reading_id
      join reading_totals t on t.reading_id = i.reading_id
    ), '[]'::jsonb),
    'products', coalesce((
      select jsonb_agg(jsonb_build_object('productId', g.product_id, 'total', g.total) order by g.product_id)
      from grouped g where g.everything = 0
    ), '[]'::jsonb),
    'total', coalesce(
      (select g.total from grouped g where g.everything = 1),
      jsonb_build_object('readings', 0, 'calls', 0, 'callsWithUsage', 0, 'callsWithoutUsage', 0, 'inputTokens', null, 'cachedInputTokens', null,
        'uncachedInputTokens', null, 'outputTokens', null, 'reasoningTokens', null, 'totalTokens', null, 'usageComplete', true)
    )
  );
$$;

revoke all on function public.admin_generation_usage(integer, text) from public, anon, authenticated;
grant execute on function public.admin_generation_usage(integer, text) to service_role;
