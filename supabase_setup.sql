-- =============================================================
--  memo-app : Supabase 설정 SQL  (기본값 = 로그인 필수 + 비공개 사진)
--
--  Supabase 대시보드 → SQL Editor 에 이 파일 전체를 붙여넣고 RUN 하세요.
--  한 번만 실행하면 되고, 다시 실행해도 안전하게 작성했습니다.
--  (예전 버전의 'anon 전체 허용 / 공개 버킷' 설정도 이 스크립트가 정리합니다)
--
--  실행 후 대시보드에서 한 번만 해 주세요:
--   1) Authentication → Sign In / Providers → Email
--        · "Allow new users to sign up"  →  OFF     (회원가입 막기)
--   2) Authentication → Users → "Add user"
--        · 본인 이메일 + 비밀번호로 계정 1개만 추가   (Auto Confirm User 체크)
--   3) Project Settings → API 의 Project URL / anon public key 를
--        memo-app/config.js 에 붙여넣기
--
--  왜 이렇게 하나요?
--   · anon 키는 웹앱 소스에 그대로 노출되는 공개 키입니다. 로그인 없이 anon 에
--     권한을 주면 URL+키를 아는 누구나 메모를 읽을 수 있습니다.
--   · 그래서 모든 행/파일을 auth.uid() 소유자에게만 열고, 사진 버킷은 비공개로 둡니다.
-- =============================================================

-- 0) 확장
create extension if not exists "pgcrypto";

-- -------------------------------------------------------------
-- 1) 메모 테이블
--    · id 는 앱에서 만든 uuid (폰/PC 가 같은 메모를 같은 id 로 다룸)
--    · user_id 는 로그인한 사용자 (기본값 auth.uid()) — RLS 의 기준
--    · images / links 는 jsonb 배열, deleted 는 소프트 삭제
-- -------------------------------------------------------------
create table if not exists public.memos (
  id          uuid primary key,
  user_id     uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  content     text        not null default '',
  tags        text[]      not null default '{}'::text[],
  links       jsonb       not null default '[]'::jsonb,
  images      jsonb       not null default '[]'::jsonb,
  pinned      boolean     not null default false,
  deleted     boolean     not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- 예전(공개 모드) 버전에서 만든 테이블이라면 user_id 컬럼을 추가한다
alter table public.memos
  add column if not exists user_id uuid default auth.uid() references auth.users (id) on delete cascade;

-- 예전 행이 남아 있으면 '계정 1개' 전제로 그 사용자에게 귀속시킨다
do $$
declare
  first_uid uuid;
begin
  if exists (select 1 from public.memos where user_id is null) then
    select id into first_uid from auth.users order by created_at asc limit 1;
    if first_uid is not null then
      update public.memos set user_id = first_uid where user_id is null;
    end if;
  end if;
end $$;

-- 모든 행에 소유자가 있을 때만 NOT NULL 로 승격 (계정을 아직 안 만들었으면 알림만)
do $$
begin
  if not exists (select 1 from public.memos where user_id is null) then
    alter table public.memos alter column user_id set not null;
  else
    raise notice 'memos 에 소유자(user_id) 없는 행이 있어 NOT NULL 승격을 건너뜁니다. 대시보드에서 계정을 만든 뒤 이 파일을 다시 실행하세요.';
  end if;
end $$;

comment on table  public.memos           is '레퍼런스 메모장 메모 (memo-app)';
comment on column public.memos.user_id   is '소유자 (auth.users.id) — RLS: auth.uid() = user_id';
comment on column public.memos.tags      is '#태그 배열';
comment on column public.memos.links     is '본문에서 추출한 링크 [{url, ...}]';
comment on column public.memos.images    is '사진 [{key,w,h,type,size,name,path}] — path=<user_id>/<memo_id>/<file>';
comment on column public.memos.deleted   is '소프트 삭제 플래그 (동기화 전파용)';

-- 동기화(pull)는 updated_at 기준이라 인덱스가 필요
create index if not exists memos_updated_at_idx on public.memos (updated_at);
create index if not exists memos_created_at_idx on public.memos (created_at desc);
create index if not exists memos_tags_idx       on public.memos using gin (tags);
create index if not exists memos_pinned_idx     on public.memos (pinned) where pinned = true;
create index if not exists memos_user_upd_idx   on public.memos (user_id, updated_at);

-- 테이블 권한 (authenticated 역할)
--   RLS 가 어떤 '행'을 볼지 결정하고, GRANT 는 그 테이블에 '접근'할 수 있는지를 정한다.
--   둘 중 GRANT 가 빠지면 로그인해도 permission denied 가 난다.
--   이 파일을 다시 실행해도 안전하도록 매번 실행한다.
grant usage on schema public to authenticated;
grant all   on table  public.memos to authenticated;

-- -------------------------------------------------------------
-- 2) RLS (행 수준 보안) — "내 행만" 읽고 쓰기
--    · 예전 anon 전체 허용 정책은 지운다 (다시 실행해도 안전)
--    · 로그인한 사용자(authenticated)만, 그리고 user_id 가 본인인 행만
-- -------------------------------------------------------------
alter table public.memos enable row level security;

drop policy if exists "memos_single_user_all" on public.memos;   -- 예전 공개 모드 정책
drop policy if exists "memos_anon_all"        on public.memos;
drop policy if exists "memos_own"             on public.memos;
drop policy if exists "memos_select_own"      on public.memos;
drop policy if exists "memos_insert_own"      on public.memos;
drop policy if exists "memos_update_own"      on public.memos;
drop policy if exists "memos_delete_own"      on public.memos;

create policy "memos_select_own"
  on public.memos for select
  to authenticated
  using (auth.uid() = user_id);

create policy "memos_insert_own"
  on public.memos for insert
  to authenticated
  with check (auth.uid() = user_id);

create policy "memos_update_own"
  on public.memos for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "memos_delete_own"
  on public.memos for delete
  to authenticated
  using (auth.uid() = user_id);

-- -------------------------------------------------------------
-- 3) 사진 저장 버킷 (memo-images) — 비공개
--    · public = false : 공개 URL 로는 절대 읽히지 않는다
--    · 앱은 GET /storage/v1/object/authenticated/memo-images/<path> + Bearer 토큰
--    · 파일 경로는 <user_id>/<memo_id>/<파일명> → 사용자별 폴더 격리
-- -------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'memo-images',
  'memo-images',
  false,     -- ★ 비공개
  10485760,  -- 10MB
  array['image/jpeg','image/png','image/webp','image/gif','image/heic']
)
on conflict (id) do update
  set public             = false,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- 예전 정책(공개 읽기 / anon 허용) 정리
drop policy if exists "memo_images_read"          on storage.objects;
drop policy if exists "memo_images_insert"        on storage.objects;
drop policy if exists "memo_images_update"        on storage.objects;
drop policy if exists "memo_images_delete"        on storage.objects;
drop policy if exists "memo_images_own_read"      on storage.objects;
drop policy if exists "memo_images_own_insert"    on storage.objects;
drop policy if exists "memo_images_own_update"    on storage.objects;
drop policy if exists "memo_images_own_delete"    on storage.objects;

-- 첫 폴더명 = auth.uid() 인 파일만 (사용자별 격리)
create policy "memo_images_own_read"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'memo-images'
    and auth.uid() is not null
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "memo_images_own_insert"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'memo-images'
    and auth.uid() is not null
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "memo_images_own_update"
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'memo-images'
    and auth.uid() is not null
    and (storage.foldername(name))[1] = auth.uid()::text
  )
  with check (
    bucket_id = 'memo-images'
    and auth.uid() is not null
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "memo_images_own_delete"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'memo-images'
    and auth.uid() is not null
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- -------------------------------------------------------------
-- 4) (선택) Realtime — 폴링 대신 즉시 반영하고 싶을 때만
--    앱은 기본적으로 8초 폴링으로 동작합니다.
-- -------------------------------------------------------------
-- alter publication supabase_realtime add table public.memos;

-- -------------------------------------------------------------
-- 5) 설치 확인 (실행 후 결과를 눈으로 확인하세요)
--    bucket_public = false, memo_policies = 4, storage_policies = 4 이면 정상
-- -------------------------------------------------------------
select
  (select count(*) from public.memos)                                        as memo_rows,
  (select count(*) from public.memos where user_id is null)                  as rows_without_owner,
  (select public from storage.buckets where id = 'memo-images')              as bucket_public,
  (select count(*) from pg_policies
     where schemaname = 'public' and tablename = 'memos')                    as memo_policies,
  (select count(*) from pg_policies
     where schemaname = 'storage' and tablename = 'objects'
       and policyname like 'memo_images_own_%')                              as storage_policies;
