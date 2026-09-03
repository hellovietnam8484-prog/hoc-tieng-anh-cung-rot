-- Base vocabulary table. This must exist before the account/link migration below.
create extension if not exists pgcrypto;

create table if not exists public.user_vocab (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  word_id text not null,
  word text not null,
  meaning text,
  part_of_speech text,
  ipa text,
  audio text,
  collocations jsonb not null default '[]'::jsonb,
  examples jsonb not null default '[]'::jsonb,
  definition_en text,
  synonyms jsonb not null default '[]'::jsonb,
  learned_at timestamptz not null default now(),
  reps integer not null default 0,
  topic text not null default 'Chưa phân loại',
  unique(user_id, word_id)
);

-- Học tiếng anh cùng rốt: tài khoản, chủ đề và liên kết kho từ
create table if not exists public.vocab_groups (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now()
);

create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  link_code text not null unique,
  username text,
  created_at timestamptz not null default now()
);

alter table public.profiles add column if not exists username text;
create unique index if not exists profiles_username_lower_idx on public.profiles (lower(username)) where username is not null;

create table if not exists public.vocab_group_members (
  group_id uuid not null references public.vocab_groups(id) on delete cascade,
  user_id uuid primary key references auth.users(id) on delete cascade,
  joined_at timestamptz not null default now()
);

alter table public.user_vocab add column if not exists topic text not null default 'Chưa phân loại';

alter table public.user_vocab enable row level security;
alter table public.profiles enable row level security;
alter table public.vocab_groups enable row level security;
alter table public.vocab_group_members enable row level security;

drop policy if exists "Users can read own vocabulary" on public.user_vocab;
drop policy if exists "Users can insert own vocabulary" on public.user_vocab;
drop policy if exists "Users can update own vocabulary" on public.user_vocab;
drop policy if exists "Users can delete own vocabulary" on public.user_vocab;
create policy "Users can read own vocabulary" on public.user_vocab for select using (auth.uid() = user_id);
create policy "Users can insert own vocabulary" on public.user_vocab for insert with check (auth.uid() = user_id);
create policy "Users can update own vocabulary" on public.user_vocab for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "Users can delete own vocabulary" on public.user_vocab for delete using (auth.uid() = user_id);

drop policy if exists "Users can read own profile" on public.profiles;
create policy "Users can read own profile" on public.profiles for select using (auth.uid() = user_id);

drop policy if exists "Users can read own group membership" on public.vocab_group_members;
create policy "Users can read own group membership" on public.vocab_group_members for select using (auth.uid() = user_id);

-- Create a private profile and a private sharing group for each account.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  g uuid;
  requested_username text;
  final_username text;
begin
  requested_username := lower(trim(coalesce(new.raw_user_meta_data->>'username', '')));
  if requested_username !~ '^[a-z0-9._-]{3,30}$' then
    requested_username := lower(split_part(coalesce(new.email, 'user'), '@', 1));
  end if;
  final_username := requested_username;
  if exists (select 1 from public.profiles where lower(username) = lower(final_username)) then
    raise exception 'Tên đăng nhập đã được sử dụng.';
  end if;
  insert into public.vocab_groups default values returning id into g;
  insert into public.vocab_group_members(group_id, user_id) values(g, new.id) on conflict (user_id) do nothing;
  insert into public.profiles(user_id, link_code, username) values(new.id, upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8)), final_username) on conflict (user_id) do update set username = excluded.username;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_rot on auth.users;
create trigger on_auth_user_created_rot
after insert on auth.users
for each row execute function public.handle_new_user();

-- Backfill profiles/groups for accounts created before this migration.
do $$
declare r record; g uuid; candidate text; final_username text;
begin
  for r in select id, email, raw_user_meta_data from auth.users loop
    candidate := lower(trim(coalesce(r.raw_user_meta_data->>'username', split_part(coalesce(r.email, 'user'), '@', 1))));
    if candidate !~ '^[a-z0-9._-]{3,30}$' then candidate := 'user_' || substr(replace(r.id::text, '-', ''), 1, 8); end if;
    final_username := candidate;
    if exists (select 1 from public.profiles where user_id <> r.id and lower(username) = lower(final_username)) then
      final_username := left(candidate, 24) || '_' || substr(replace(r.id::text, '-', ''), 1, 5);
    end if;
    if not exists (select 1 from public.profiles where user_id = r.id) then
      insert into public.vocab_groups default values returning id into g;
      insert into public.vocab_group_members(group_id, user_id) values(g, r.id) on conflict (user_id) do nothing;
      insert into public.profiles(user_id, link_code, username) values(r.id, upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8)), final_username);
    else
      update public.profiles set username = coalesce(username, final_username) where user_id = r.id;
    end if;
    if not exists (select 1 from public.vocab_group_members where user_id = r.id) then
      insert into public.vocab_groups default values returning id into g;
      insert into public.vocab_group_members(group_id, user_id) values(g, r.id) on conflict (user_id) do nothing;
    end if;
  end loop;
end $$;

-- Public-safe lookup helpers used only to resolve a username at login time.
create or replace function public.username_available(wanted_username text)
returns boolean
language sql
security definer
set search_path = public
as $$
  select not exists (select 1 from public.profiles where lower(username) = lower(trim(wanted_username)));
$$;

revoke execute on function public.username_available(text) from public;
grant execute on function public.username_available(text) to anon, authenticated;

-- Save vocabulary through a SECURITY DEFINER RPC. The authenticated user's id is
-- always taken from auth.uid(), never trusted from the browser payload. This avoids
-- PostgREST upsert/RLS/trigger edge cases that can make a valid insert look like a failure.
create or replace function public.save_user_vocab(vocab_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
  result public.user_vocab;
  p_word_id text;
  p_word text;
begin
  if me is null then
    raise exception 'Bạn cần đăng nhập để lưu từ.';
  end if;
  if vocab_payload is null or jsonb_typeof(vocab_payload) <> 'object' then
    raise exception 'Dữ liệu từ vựng không hợp lệ.';
  end if;

  p_word_id := lower(trim(coalesce(vocab_payload->>'word_id', '')));
  p_word := trim(coalesce(vocab_payload->>'word', ''));
  if p_word_id = '' or p_word = '' then
    raise exception 'Thiếu từ tiếng Anh cần lưu.';
  end if;

  insert into public.user_vocab(
    user_id, word_id, word, meaning, part_of_speech, ipa, audio,
    collocations, examples, definition_en, synonyms, learned_at, reps, topic
  ) values (
    me,
    p_word_id,
    p_word,
    nullif(trim(vocab_payload->>'meaning'), ''),
    nullif(trim(vocab_payload->>'part_of_speech'), ''),
    nullif(trim(vocab_payload->>'ipa'), ''),
    nullif(trim(vocab_payload->>'audio'), ''),
    case when jsonb_typeof(vocab_payload->'collocations') = 'array' then vocab_payload->'collocations' else '[]'::jsonb end,
    case when jsonb_typeof(vocab_payload->'examples') = 'array' then vocab_payload->'examples' else '[]'::jsonb end,
    nullif(trim(vocab_payload->>'definition_en'), ''),
    case when jsonb_typeof(vocab_payload->'synonyms') = 'array' then vocab_payload->'synonyms' else '[]'::jsonb end,
    coalesce(nullif(vocab_payload->>'learned_at', '')::timestamptz, now()),
    greatest(coalesce(nullif(vocab_payload->>'reps', '')::integer, 0), 0),
    coalesce(nullif(trim(vocab_payload->>'topic'), ''), 'Chưa phân loại')
  )
  on conflict (user_id, word_id) do update set
    word = excluded.word,
    meaning = excluded.meaning,
    part_of_speech = excluded.part_of_speech,
    ipa = excluded.ipa,
    audio = excluded.audio,
    collocations = excluded.collocations,
    examples = excluded.examples,
    definition_en = excluded.definition_en,
    synonyms = excluded.synonyms
  returning * into result;

  return to_jsonb(result);
end;
$$;

revoke execute on function public.save_user_vocab(jsonb) from public;
grant execute on function public.save_user_vocab(jsonb) to authenticated;

create or replace function public.get_login_email(login_value text)
returns text
language sql
security definer
set search_path = public
as $$
  select u.email::text
  from public.profiles p
  join auth.users u on u.id = p.user_id
  where lower(p.username) = lower(trim(login_value))
  limit 1;
$$;

revoke execute on function public.get_login_email(text) from public;
grant execute on function public.get_login_email(text) to anon, authenticated;

-- Linking merges the two sharing groups. Existing vocabulary is copied both ways.
create or replace function public.link_account(target_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid(); target uuid; my_group uuid; target_group uuid; final_group uuid;
begin
  if me is null then raise exception 'Bạn cần đăng nhập.'; end if;
  select user_id into target from public.profiles where upper(link_code) = upper(trim(target_code));
  if target is null then raise exception 'Không tìm thấy mã liên kết này.'; end if;
  if target = me then raise exception 'Bạn không thể liên kết với chính tài khoản của mình.'; end if;
  select group_id into my_group from public.vocab_group_members where user_id = me;
  select group_id into target_group from public.vocab_group_members where user_id = target;
  if my_group is null then insert into public.vocab_groups default values returning id into my_group; insert into public.vocab_group_members values(my_group, me, now()); end if;
  if target_group is null then insert into public.vocab_group_members values(my_group, target, now()); target_group := my_group; end if;
  if my_group <> target_group then
    final_group := my_group;
    update public.vocab_group_members set group_id = final_group where group_id = target_group;
    delete from public.vocab_groups where id = target_group;
  else
    final_group := my_group;
  end if;
  -- Copy the union of both vaults to every member of the merged group.
  insert into public.user_vocab(user_id, word_id, word, meaning, part_of_speech, ipa, audio, collocations, examples, definition_en, synonyms, learned_at, reps, topic)
  select m.user_id, v.word_id, v.word, v.meaning, v.part_of_speech, v.ipa, v.audio, v.collocations, v.examples, v.definition_en, v.synonyms, v.learned_at, v.reps, v.topic
  from public.vocab_group_members m cross join public.user_vocab v
  where m.group_id = final_group
  on conflict (user_id, word_id) do update set
    word = excluded.word, meaning = excluded.meaning, part_of_speech = excluded.part_of_speech,
    ipa = excluded.ipa, audio = excluded.audio, collocations = excluded.collocations, examples = excluded.examples,
    definition_en = excluded.definition_en, synonyms = excluded.synonyms, learned_at = excluded.learned_at,
    reps = excluded.reps, topic = excluded.topic;
  return jsonb_build_object('ok', true, 'message', 'Đã liên kết. Kho từ và chủ đề của hai tài khoản đã được đồng bộ.');
end;
$$;

-- Any newly added/updated word is mirrored to every member of the same group.
create or replace function public.sync_group_vocab()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if pg_trigger_depth() > 1 then return new; end if;
  insert into public.user_vocab(user_id, word_id, word, meaning, part_of_speech, ipa, audio, collocations, examples, definition_en, synonyms, learned_at, reps, topic)
  select m.user_id, new.word_id, new.word, new.meaning, new.part_of_speech, new.ipa, new.audio, new.collocations, new.examples, new.definition_en, new.synonyms, new.learned_at, new.reps, new.topic
  from public.vocab_group_members m
  join public.vocab_group_members source on source.user_id = new.user_id and source.group_id = m.group_id
  where m.user_id <> new.user_id
  on conflict (user_id, word_id) do update set
    word = excluded.word, meaning = excluded.meaning, part_of_speech = excluded.part_of_speech,
    ipa = excluded.ipa, audio = excluded.audio, collocations = excluded.collocations, examples = excluded.examples,
    definition_en = excluded.definition_en, synonyms = excluded.synonyms, learned_at = excluded.learned_at,
    reps = excluded.reps, topic = excluded.topic;
  return new;
end;
$$;

drop trigger if exists user_vocab_sync_group on public.user_vocab;
create trigger user_vocab_sync_group
after insert or update of word, meaning, part_of_speech, ipa, audio, collocations, examples, definition_en, synonyms, learned_at, reps, topic
on public.user_vocab for each row execute function public.sync_group_vocab();

-- Allow the client to read group members' basic identity without exposing link codes.
drop policy if exists "Users can read linked members" on public.vocab_group_members;
create policy "Users can read linked members" on public.vocab_group_members for select using (
  exists (select 1 from public.vocab_group_members mine where mine.user_id = auth.uid() and mine.group_id = vocab_group_members.group_id)
);
