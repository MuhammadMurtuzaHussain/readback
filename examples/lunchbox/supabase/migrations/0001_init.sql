create table public.orders (
  id uuid primary key default gen_random_uuid(),
  office_id text not null,
  item text not null,
  price numeric not null,
  email text not null,
  paid boolean default false
);

create table public.profiles (
  id uuid primary key,
  email text,
  phone text
);

create table public.menu_items (
  id uuid primary key default gen_random_uuid(),
  name text not null
);

alter table public.menu_items enable row level security;
