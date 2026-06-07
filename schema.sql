-- ============================================================
--  Calendario de lanzamientos de videojuegos — esquema Supabase
--  Ejecútalo en el SQL Editor de Supabase (de una sola vez).
-- ============================================================

-- ------------------------------------------------------------
--  CACHÉ DE IGDB
--  Datos globales. Solo los escribe la función de Vercel
--  usando la service_role key.
-- ------------------------------------------------------------

-- Metadatos de cada juego (deduplicado por juego)
create table public.games_cache (
  igdb_game_id   bigint primary key,
  name           text not null,
  cover_image_id text,
  platforms      text[],             -- ej. {'PC','PS5','Xbox Series'}
  hypes          integer default 0,  -- para el filtro de relevancia
  summary        text,
  updated_at     timestamptz not null default now()
);

-- Fechas de lanzamiento: una fila por release de IGDB
-- (un juego en 3 plataformas puede generar hasta 3 filas)
create table public.release_dates (
  igdb_release_id bigint primary key,
  igdb_game_id    bigint not null
                    references public.games_cache(igdb_game_id)
                    on delete cascade,
  release_date    date,
  date_precision  text,   -- exacta / mes / trimestre / año / tbd
  platform        text,
  region          text,
  human           text    -- texto ya formateado por IGDB ("Q4 2026")
);
create index release_dates_date_idx on public.release_dates (release_date);
create index release_dates_game_idx on public.release_dates (igdb_game_id);

-- Cuaderno del cache-aside: qué meses se han descargado y cuándo
create table public.cache_meta (
  cache_key  text primary key,            -- ej. "2026-07"
  fetched_at timestamptz not null default now()
);

-- Token de Twitch/IGDB: una única fila (id siempre = 1)
create table public.igdb_token (
  id           integer primary key default 1,
  access_token text not null,
  expires_at   timestamptz not null,
  constraint single_row check (id = 1)
);

-- ------------------------------------------------------------
--  DATOS PERSONALES
--  Protegidos con RLS: cada usuario solo accede a sus filas.
-- ------------------------------------------------------------

create table public.tracked_games (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users(id) on delete cascade,
  igdb_game_id   bigint not null,   -- referencia "blanda" a games_cache (sin FK)
  status         text not null
                   check (status in ('interesado','reservado','comprado','descartado')),
  note           text,
  game_name      text,              -- copia estable para que tu lista se pinte
  cover_image_id text,              -- aunque la caché esté vacía o caducada
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (user_id, igdb_game_id)    -- un único estado por juego y usuario
);

-- ------------------------------------------------------------
--  ROW LEVEL SECURITY
-- ------------------------------------------------------------

-- Tus juegos: solo el dueño ve y modifica sus filas
alter table public.tracked_games enable row level security;

create policy "select_propios" on public.tracked_games
  for select using (auth.uid() = user_id);
create policy "insert_propios" on public.tracked_games
  for insert with check (auth.uid() = user_id);
create policy "update_propios" on public.tracked_games
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "delete_propios" on public.tracked_games
  for delete using (auth.uid() = user_id);

-- Tablas de caché: RLS activado SIN políticas.
-- Quedan inaccesibles desde el navegador (anon/authenticated).
-- Solo la función de Vercel las toca con la service_role key,
-- que ignora RLS. Esto protege sobre todo a igdb_token.
alter table public.games_cache   enable row level security;
alter table public.release_dates enable row level security;
alter table public.cache_meta    enable row level security;
alter table public.igdb_token    enable row level security;
