-- 登記日攝影大賽：Supabase 資料庫
-- 用法：Supabase Dashboard → SQL Editor → New query → 貼上整份 → Run
-- 跑完後，再執行檔案最下面那一行來設定管理密碼。
-- 重複執行是安全的（不會清掉已經有的資料）。

create extension if not exists pgcrypto with schema extensions;

-- ═════════ 資料表 ═════════
create table if not exists public.participants (
  id          text primary key default encode(extensions.gen_random_bytes(8), 'hex'),
  name        text not null,
  key         text not null unique,          -- 比對重名用：全形半形、大小寫、空白都視為相同
  pin_hash    text not null,
  attending   boolean not null default true,
  created_at  timestamptz not null default clock_timestamp()
);

create table if not exists public.sessions (
  token_hash      text primary key,
  participant_id  text not null references public.participants(id) on delete cascade,
  created_at      timestamptz not null default clock_timestamp()
);

create table if not exists public.photos (
  id          text primary key check (id ~ '^[a-f0-9]{16}$'),
  owner_id    text not null references public.participants(id) on delete cascade,
  w           int not null check (w between 1 and 4000),
  h           int not null check (h between 1 and 4000),
  created_at  timestamptz not null default clock_timestamp()
);

create table if not exists public.votes (
  voter_id  text primary key references public.participants(id) on delete cascade,  -- 每人一票
  photo_id  text not null references public.photos(id) on delete cascade
);

create table if not exists public.favorites (
  photo_id  text primary key references public.photos(id) on delete cascade
);

create table if not exists public.settings (
  id          int primary key default 1 check (id = 1),
  phase       int not null default 1 check (phase in (1, 2, 3)),
  max_photos  int not null default 2,
  admin_hash  text
);
insert into public.settings (id) values (1) on conflict do nothing;

create table if not exists public.admin_sessions (
  token_hash  text primary key,
  expires_at  timestamptz not null
);

-- 密碼猜錯太多次就暫時鎖住
create table if not exists public.fails (
  key    text primary key,
  count  int not null default 0,
  until  timestamptz
);

-- 所有資料表都不開放直接讀寫，只能透過下面的函式
alter table public.participants   enable row level security;
alter table public.sessions       enable row level security;
alter table public.photos         enable row level security;
alter table public.votes          enable row level security;
alter table public.favorites      enable row level security;
alter table public.settings       enable row level security;
alter table public.admin_sessions enable row level security;
alter table public.fails          enable row level security;
revoke all on all tables in schema public from anon, authenticated;

-- ═════════ 內部小工具 ═════════
create or replace function public._err(p_msg text, p_status int)
returns jsonb language sql immutable as $$
  select jsonb_build_object('error', p_msg, 'status', p_status) $$;

create or replace function public._sha(p text)
returns text language sql immutable set search_path = extensions as $$
  select encode(digest(p, 'sha256'), 'hex') $$;

create or replace function public._clean_name(p text)
returns text language sql immutable as $$
  select btrim(regexp_replace(regexp_replace(normalize(coalesce(p, ''), NFC), '[[:cntrl:]]', '', 'g'), '\s+', ' ', 'g')) $$;

create or replace function public._name_key(p text)
returns text language sql immutable as $$
  select regexp_replace(lower(normalize(p, NFKC)), '\s+', '', 'g') $$;

create or replace function public._phase()
returns int language sql stable as $$ select phase from public.settings where id = 1 $$;

create or replace function public._uid(p_token text)
returns text language sql stable as $$
  select participant_id from public.sessions where token_hash = public._sha(coalesce(p_token, '')) $$;

create or replace function public._issue_token(p_uid text)
returns text language plpgsql set search_path = public, extensions as $$
declare v_token text := encode(gen_random_bytes(24), 'hex');
begin
  insert into sessions (token_hash, participant_id) values (_sha(v_token), p_uid);
  -- 最多同時 5 支裝置
  delete from sessions where participant_id = p_uid and token_hash not in (
    select token_hash from sessions where participant_id = p_uid order by created_at desc limit 5);
  return v_token;
end $$;

-- 被鎖住就回傳錯誤訊息，沒有就回傳 null
create or replace function public._locked(p_key text)
returns jsonb language plpgsql stable as $$
declare v_until timestamptz;
begin
  select until into v_until from public.fails where key = p_key;
  if v_until is not null and v_until > now() then
    return public._err(format('密碼錯太多次了，請 %s 分鐘後再試。',
      ceil(extract(epoch from v_until - now()) / 60)::int), 429);
  end if;
  return null;
end $$;

create or replace function public._note_fail(p_key text)
returns void language sql as $$
  insert into public.fails as f (key, count) values (p_key, 1)
  on conflict (key) do update set
    count = case when f.count + 1 >= 8 then 0 else f.count + 1 end,
    until = case when f.count + 1 >= 8 then now() + interval '5 minutes' else f.until end $$;

-- 對外的狀態：票數只有第 3 階段才會出現
create or replace function public._state(p_uid text)
returns jsonb language plpgsql stable set search_path = public as $$
declare
  v_phase int := _phase();
  v_state jsonb;
  v_photos jsonb;
  v_max int;
begin
  v_state := jsonb_build_object(
    'phase', v_phase,
    'maxPhotos', (select max_photos from settings where id = 1),
    'participants', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', p.id, 'name', p.name, 'attending', p.attending,
        'photos', coalesce((select jsonb_agg(jsonb_build_object('id', ph.id, 'w', ph.w, 'h', ph.h) order by ph.created_at)
                            from photos ph where ph.owner_id = p.id), '[]'::jsonb)
      ) order by p.created_at) from participants p), '[]'::jsonb),
    'me', (select jsonb_build_object('id', p.id, 'name', p.name, 'attending', p.attending,
                    'vote', case when v_phase >= 2 then (select photo_id from votes where voter_id = p.id) end)
           from participants p where p.id = p_uid)
  );

  if v_phase = 2 then
    -- 照片 id 是亂數，用 id 排序等於固定的隨機順序
    select coalesce(jsonb_agg(jsonb_build_object('id', ph.id, 'w', ph.w, 'h', ph.h,
             'ownerId', ph.owner_id, 'ownerName', p.name) order by ph.id), '[]'::jsonb)
      into v_photos from photos ph join participants p on p.id = ph.owner_id;
    v_state := v_state || jsonb_build_object('photos', v_photos);
  elsif v_phase = 3 then
    with c as (
      select ph.id, ph.w, ph.h, ph.owner_id, p.name, count(v.voter_id)::int as n
      from photos ph join participants p on p.id = ph.owner_id
      left join votes v on v.photo_id = ph.id
      group by ph.id, p.name)
    select coalesce(jsonb_agg(jsonb_build_object('id', id, 'w', w, 'h', h, 'ownerId', owner_id,
             'ownerName', name, 'votes', n) order by n desc, id), '[]'::jsonb),
           coalesce(max(n), 0)
      into v_photos, v_max from c;
    v_state := v_state || jsonb_build_object(
      'photos', v_photos,
      'result', jsonb_build_object(
        'popular', case when v_max = 0 then '[]'::jsonb else
          (select coalesce(jsonb_agg(e->'id'), '[]'::jsonb) from jsonb_array_elements(v_photos) e where (e->>'votes')::int = v_max) end,
        'favorites', coalesce((select jsonb_agg(photo_id) from favorites), '[]'::jsonb)));
  end if;
  return v_state;
end $$;

create or replace function public._admin_ok(p_token text)
returns boolean language sql stable as $$
  select exists (select 1 from public.admin_sessions
                 where token_hash = public._sha(coalesce(p_token, '')) and expires_at > now()) $$;

create or replace function public._admin_state()
returns jsonb language sql stable set search_path = public as $$
  select jsonb_build_object(
    'phase', _phase(),
    'participants', coalesce((select jsonb_agg(jsonb_build_object(
        'id', p.id, 'name', p.name, 'attending', p.attending,
        'hasVoted', exists (select 1 from votes v where v.voter_id = p.id),  -- 只知道投了沒，不知道投給誰
        'photoCount', (select count(*) from photos ph where ph.owner_id = p.id)
      ) order by p.created_at) from participants p), '[]'::jsonb),
    'photos', coalesce((select jsonb_agg(x order by (x->>'votes')::int desc, x->>'id') from (
        select jsonb_build_object('id', ph.id, 'ownerName', p.name,
          'votes', (select count(*) from votes v where v.photo_id = ph.id),
          'favorite', exists (select 1 from favorites f where f.photo_id = ph.id)) as x
        from photos ph join participants p on p.id = ph.owner_id) s), '[]'::jsonb)) $$;

-- ═════════ 朋友用的函式 ═════════
create or replace function public.get_state(p_token text default null)
returns jsonb language sql stable security definer set search_path = public as $$
  select _state(_uid(p_token)) $$;

create or replace function public.register(p_name text, p_pin text, p_attending boolean default true)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare v_name text := _clean_name(p_name); v_id text;
begin
  if _phase() <> 1 then return _err('報名已經截止了，謝謝你。', 409); end if;
  if v_name = '' then return _err('請填名字。', 400); end if;
  if char_length(v_name) > 12 then return _err('名字最多 12 個字。', 400); end if;
  if coalesce(p_pin, '') !~ '^\d{4,6}$' then return _err('密碼要是 4–6 位數字。', 400); end if;
  begin
    insert into participants (name, key, pin_hash, attending)
    values (v_name, _name_key(v_name), crypt(p_pin, gen_salt('bf', 8)), coalesce(p_attending, true))
    returning id into v_id;
  exception when unique_violation then
    return _err('這個名字已經有人報名了。如果是你，請切到「我報過了」登入；不是的話，換個名字試試。', 409);
  end;
  return jsonb_build_object('token', _issue_token(v_id), 'state', _state(v_id));
end $$;

create or replace function public.login(p_name text, p_pin text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  v_key text := 'user:' || _name_key(_clean_name(p_name));
  v_user participants;
  v_lock jsonb := _locked(v_key);
begin
  if _clean_name(p_name) = '' or p_pin is null then return _err('請填名字和密碼。', 400); end if;
  if v_lock is not null then return v_lock; end if;
  select * into v_user from participants where key = _name_key(_clean_name(p_name));
  -- 找不到人也照樣算一次雜湊，不透露「有沒有這個名字」
  if v_user.id is null or v_user.pin_hash <> crypt(p_pin, coalesce(v_user.pin_hash, gen_salt('bf', 8))) then
    perform _note_fail(v_key);
    return _err('名字或密碼不對，再試一次？', 401);
  end if;
  delete from fails where key = v_key;
  return jsonb_build_object('token', _issue_token(v_user.id), 'state', _state(v_user.id));
end $$;

create or replace function public.logout(p_token text)
returns jsonb language sql security definer set search_path = public as $$
  delete from sessions where token_hash = _sha(coalesce(p_token, ''));
  select jsonb_build_object('ok', true) $$;

create or replace function public.set_attending(p_token text, p_attending boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid text := _uid(p_token);
begin
  if v_uid is null then return _err('請先登入。', 401); end if;
  if _phase() <> 1 then return _err('現在不能改出席狀態了。', 409); end if;
  if p_attending is null then return _err('資料格式不對。', 400); end if;
  update participants set attending = p_attending where id = v_uid;
  return jsonb_build_object('state', _state(v_uid));
end $$;

-- 照片檔案先由瀏覽器傳到 Storage（{id}.jpg 和 {id}_t.jpg），再呼叫這個函式登記
create or replace function public.add_photo(p_token text, p_id text, p_w int, p_h int)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid text := _uid(p_token); v_max int;
begin
  if v_uid is null then return _err('請先登入。', 401); end if;
  if _phase() <> 1 then return _err('上傳已經截止了。', 409); end if;
  select max_photos into v_max from settings where id = 1;
  if (select count(*) from photos where owner_id = v_uid) >= v_max then
    return _err(format('每人最多 %s 張，想換的話先刪掉一張。', v_max), 409);
  end if;
  if coalesce(p_id, '') !~ '^[a-f0-9]{16}$' or coalesce(p_w, 0) not between 1 and 4000
     or coalesce(p_h, 0) not between 1 and 4000 then
    return _err('照片格式不對，請再試一次。', 400);
  end if;
  if (select count(*) from storage.objects where bucket_id = 'photos'
        and name in (p_id || '.jpg', p_id || '_t.jpg')) < 2 then
    return _err('照片資料不完整，請再試一次。', 400);
  end if;
  begin
    insert into photos (id, owner_id, w, h) values (p_id, v_uid, p_w, p_h);
  exception when unique_violation then
    return _err('照片資料不完整，請再試一次。', 400);
  end;
  return jsonb_build_object('id', p_id, 'state', _state(v_uid));
end $$;

create or replace function public.delete_photo(p_token text, p_id text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid text := _uid(p_token);
begin
  if v_uid is null then return _err('請先登入。', 401); end if;
  if _phase() <> 1 then return _err('投票開始後就不能改照片了。', 409); end if;
  delete from photos where id = p_id and owner_id = v_uid;
  if not found then return _err('找不到這張照片。', 404); end if;
  return jsonb_build_object('state', _state(v_uid));
end $$;

create or replace function public.cast_vote(p_token text, p_photo_id text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid text := _uid(p_token); v_owner text; v_phase int := _phase();
begin
  if v_uid is null then return _err('請先登入。', 401); end if;
  if v_phase <> 2 then
    return _err(case when v_phase = 1 then '投票還沒開始。' else '投票已經截止了。' end, 409);
  end if;
  select owner_id into v_owner from photos where id = p_photo_id;
  if v_owner is null then return _err('找不到這張照片。', 404); end if;
  if v_owner = v_uid then return _err('這張是你自己的作品，請投給別人的照片。', 403); end if;
  insert into votes (voter_id, photo_id) values (v_uid, p_photo_id)
  on conflict (voter_id) do update set photo_id = excluded.photo_id;  -- 重投就是改投
  return jsonb_build_object('state', _state(v_uid));
end $$;

-- ═════════ 主辦人用的函式 ═════════
create or replace function public.admin_login(p_password text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare v_hash text; v_token text; v_lock jsonb := _locked('admin');
begin
  if v_lock is not null then return v_lock; end if;
  select admin_hash into v_hash from settings where id = 1;
  if v_hash is null then return _err('還沒設定管理密碼，請先在 Supabase 執行設定指令。', 503); end if;
  if p_password is null or v_hash <> crypt(p_password, v_hash) then
    perform _note_fail('admin');
    return _err('管理密碼不對。', 401);
  end if;
  delete from fails where key = 'admin';
  delete from admin_sessions where expires_at < now();
  v_token := encode(gen_random_bytes(24), 'hex');
  insert into admin_sessions values (_sha(v_token), now() + interval '24 hours');
  return jsonb_build_object('token', v_token, 'state', _admin_state());
end $$;

create or replace function public.admin_state(p_token text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not _admin_ok(p_token) then return _err('請先輸入管理密碼。', 401); end if;
  return _admin_state();
end $$;

create or replace function public.admin_set_phase(p_token text, p_phase int)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not _admin_ok(p_token) then return _err('請先輸入管理密碼。', 401); end if;
  if p_phase is null or p_phase not in (1, 2, 3) then return _err('沒有這個階段。', 400); end if;
  update settings set phase = p_phase where id = 1;
  return _admin_state();
end $$;

create or replace function public.admin_set_favorite(p_token text, p_photo_id text, p_favorite boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not _admin_ok(p_token) then return _err('請先輸入管理密碼。', 401); end if;
  if not exists (select 1 from photos where id = p_photo_id) then return _err('找不到這張照片。', 404); end if;
  delete from favorites where photo_id = p_photo_id;
  if p_favorite then insert into favorites values (p_photo_id); end if;
  return _admin_state();
end $$;

create or replace function public.admin_remove_participant(p_token text, p_id text)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not _admin_ok(p_token) then return _err('請先輸入管理密碼。', 401); end if;
  delete from participants where id = p_id;   -- 照片、投票、登入狀態會一起刪掉
  if not found then return _err('找不到這個人。', 404); end if;
  return _admin_state();
end $$;

-- ═════════ 權限：只開放上面這些對外函式 ═════════
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function
  public.get_state(text), public.register(text, text, boolean), public.login(text, text),
  public.logout(text), public.set_attending(text, boolean), public.add_photo(text, text, int, int),
  public.delete_photo(text, text), public.cast_vote(text, text),
  public.admin_login(text), public.admin_state(text), public.admin_set_phase(text, int),
  public.admin_set_favorite(text, text, boolean), public.admin_remove_participant(text, text)
to anon, authenticated;

-- ═════════ 照片儲存空間 ═════════
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('photos', 'photos', true, 8388608, array['image/jpeg'])
on conflict (id) do update set public = true, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- 只能新增、不能覆蓋或刪除；檔名必須是 16 碼亂數
drop policy if exists "photo contest upload" on storage.objects;
create policy "photo contest upload" on storage.objects for insert to anon, authenticated
  with check (bucket_id = 'photos' and name ~ '^[a-f0-9]{16}(_t)?\.jpg$');

-- ═════════ 最後一步：設定管理密碼 ═════════
-- 把「換成你們的密碼」改掉，選取這一行單獨執行：
-- update public.settings set admin_hash = extensions.crypt('換成你們的密碼', extensions.gen_salt('bf', 8)) where id = 1;
