-- Клієнтська база салону «Модерн»
-- Виконайте цей файл один раз у Supabase: SQL Editor → New query → вставити → Run.

-- ───────────── Таблиці ─────────────

-- Працівники (адміністратор і майстри). Рядок створюється автоматично,
-- коли в Supabase → Authentication додають нового користувача.
create table if not exists public.profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  email      text,
  full_name  text not null default '',
  role       text not null default 'master' check (role in ('admin', 'master')),
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.services (
  id         bigint generated always as identity primary key,
  name       text not null unique,
  price_from numeric(10, 2) not null default 0,
  active     boolean not null default true
);

create table if not exists public.clients (
  id               bigint generated always as identity primary key,
  full_name        text not null,
  phone            text not null unique,
  birthday         date,
  notes            text not null default '',
  preferred_master uuid references public.profiles (id) on delete set null,
  created_by       uuid references public.profiles (id) on delete set null default auth.uid(),
  created_at       timestamptz not null default now()
);

create table if not exists public.visits (
  id           bigint generated always as identity primary key,
  client_id    bigint not null references public.clients (id) on delete cascade,
  master_id    uuid references public.profiles (id) on delete set null,
  service_id   bigint references public.services (id) on delete set null,
  service_name text not null,
  price        numeric(10, 2) not null default 0 check (price >= 0),
  visited_at   timestamptz not null default now(),
  comment      text not null default '',
  created_at   timestamptz not null default now()
);

create index if not exists visits_client_idx on public.visits (client_id);
create index if not exists visits_master_idx on public.visits (master_id);
create index if not exists visits_date_idx   on public.visits (visited_at);
create index if not exists clients_pref_idx  on public.clients (preferred_master);

-- ───────────── Допоміжні функції ─────────────

create or replace function public.is_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and active);
$$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and active and role = 'admin');
$$;

-- Чи має клієнт хоч один візит до поточного майстра.
create or replace function public.has_my_visit(cid bigint) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from visits v where v.client_id = cid and v.master_id = auth.uid());
$$;

-- Пошук клієнта за телефоном серед УСІЄЇ бази, щоб майстер не створив дубль.
-- Повертає лише id та ім'я — без нотаток і історії.
create or replace function public.find_client_by_phone(p text)
returns table (id bigint, full_name text)
language sql stable security definer set search_path = public as $$
  select c.id, c.full_name from clients c
  where public.is_staff() and c.phone = p;
$$;

-- Новий користувач Authentication → профіль майстра.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (id, email, full_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data ->> 'full_name', ''))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Майстер не може змінити собі роль чи статус. (Без auth.uid() — це SQL Editor
-- власника бази; анонімних відвідувачів до profiles не пускає RLS.)
create or replace function public.protect_profile() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and not public.is_admin()
     and (new.role <> old.role or new.active <> old.active) then
    raise exception 'Лише адміністратор може змінювати роль і доступ';
  end if;
  return new;
end;
$$;

drop trigger if exists protect_profile on public.profiles;
create trigger protect_profile before update on public.profiles
  for each row execute function public.protect_profile();

-- ───────────── Права доступу (Row Level Security) ─────────────

alter table public.profiles enable row level security;
alter table public.services enable row level security;
alter table public.clients  enable row level security;
alter table public.visits   enable row level security;

-- profiles: усі працівники бачать список колег (для вибору майстра),
-- змінювати — адміністратор або сам працівник своє ім'я.
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select
  using (public.is_staff() or id = auth.uid());
drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles for update
  using (public.is_admin() or id = auth.uid())
  with check (public.is_admin() or id = auth.uid());

-- services: бачать усі працівники, редагує адміністратор.
drop policy if exists services_select on public.services;
create policy services_select on public.services for select using (public.is_staff());
drop policy if exists services_write on public.services;
create policy services_write on public.services for all
  using (public.is_admin()) with check (public.is_admin());

-- clients: майстер бачить клієнта, якщо він його улюблений майстер,
-- сам його додав, або в клієнта є візит до нього.
drop policy if exists clients_select on public.clients;
create policy clients_select on public.clients for select
  using (public.is_admin() or (public.is_staff() and (
    preferred_master = auth.uid() or created_by = auth.uid() or public.has_my_visit(id))));
drop policy if exists clients_insert on public.clients;
create policy clients_insert on public.clients for insert
  with check (public.is_admin() or (public.is_staff() and created_by = auth.uid()));
drop policy if exists clients_update on public.clients;
create policy clients_update on public.clients for update
  using (public.is_admin() or (public.is_staff() and (
    preferred_master = auth.uid() or created_by = auth.uid() or public.has_my_visit(id))))
  with check (public.is_admin() or public.is_staff());
drop policy if exists clients_delete on public.clients;
create policy clients_delete on public.clients for delete using (public.is_admin());

-- visits: майстер бачить і додає лише свої візити, адміністратор — усі.
drop policy if exists visits_select on public.visits;
create policy visits_select on public.visits for select
  using (public.is_admin() or (public.is_staff() and master_id = auth.uid()));
drop policy if exists visits_insert on public.visits;
create policy visits_insert on public.visits for insert
  with check (public.is_admin() or (public.is_staff() and master_id = auth.uid()));
drop policy if exists visits_update on public.visits;
create policy visits_update on public.visits for update
  using (public.is_admin() or (public.is_staff() and master_id = auth.uid()))
  with check (public.is_admin() or (public.is_staff() and master_id = auth.uid()));
drop policy if exists visits_delete on public.visits;
create policy visits_delete on public.visits for delete
  using (public.is_admin() or (public.is_staff() and master_id = auth.uid()));

-- ───────────── Послуги з прайс-листа сайту ─────────────

insert into public.services (name, price_from) values
  ('Стрижка чоловіча наголо', 150),
  ('Стрижка чоловіча під насадки', 250),
  ('Стрижка чоловіча модельна', 300),
  ('Стрижка бороди', 100),
  ('Стрижка жіноча коротка', 300),
  ('Стрижка жіноча друга довжина', 350),
  ('Стрижка жіноча третя довжина', 400),
  ('Укладка', 300),
  ('Зачіска', 500),
  ('Фарбування в один тон', 300),
  ('Складне фарбування', 0),
  ('Манікюр', 450)
on conflict (name) do nothing;

-- ───────────── Перший адміністратор ─────────────
-- 1. Authentication → Users → Add user → ваш email і пароль.
-- 2. Замініть email нижче на свій і виконайте ці два рядки:
--
-- update public.profiles set role = 'admin', full_name = 'Адміністратор'
-- where email = 'ваш@email.com';
