import { supabase } from './supabase.js';
import { getIgdbToken } from './igdbToken.js';

// --- Plataformas que nos interesan (id de IGDB -> nombre legible) ---
const PLATFORMS = {
  6: 'PC',
  48: 'PS4',
  49: 'Xbox One',
  130: 'Switch',
  167: 'PS5',
  169: 'Xbox Series',
  508: 'Switch 2',
};
const PLATFORM_IDS = Object.keys(PLATFORMS).join(',');

// Suelo de hype al traer datos: elimina de raíz la morralla de 0 hype.
// El filtro fino (tu deslizador de relevancia) lo aplica el navegador.
const HYPE_FLOOR = 1;

// Frescura de la caché de un mes.
const TTL_MS = 12 * 60 * 60 * 1000; // 12 horas

const IGDB_URL = 'https://api.igdb.com/v4/release_dates';
const PAGE = 500; // máximo de filas por petición en IGDB

// ------------------------------------------------------------
//  Helpers
// ------------------------------------------------------------

// "2026-07" -> ventana [start, end) en segundos Unix (UTC).
function monthWindow(month) {
  const [y, m] = month.split('-').map(Number);
  const start = Math.floor(Date.UTC(y, m - 1, 1) / 1000); // 1.º del mes
  const end = Math.floor(Date.UTC(y, m, 1) / 1000);       // 1.º del mes siguiente
  return { start, end };
}

// IGDB da las fechas exactas como "Dec 31, 2026" (coma + año) y las
// aproximadas como "Q4 2026", "2026" o "TBD". Nos apoyamos en el texto
// para no depender del enum de precisión (que IGDB ha ido cambiando).
function isPreciseDate(human) {
  return /\d{1,2},\s*\d{4}/.test(human || '');
}

// ------------------------------------------------------------
//  1) Traer un mes desde IGDB (con paginación)
// ------------------------------------------------------------

async function fetchMonthFromIgdb(token, start, end) {
  const all = [];
  let offset = 0;

  // Llamadas secuenciales: cada round-trip tarda bastante más de 250 ms,
  // así que nunca rozamos el límite de 4 peticiones/segundo de IGDB.
  while (true) {
    const body = `
      fields id, date, human, platform, region,
             game.id, game.name, game.cover.image_id,
             game.platforms.name, game.hypes;
      where date >= ${start} & date < ${end}
          & platform = (${PLATFORM_IDS})
          & game.hypes >= ${HYPE_FLOOR};
      sort game.hypes desc;
      limit ${PAGE};
      offset ${offset};
    `;

    const res = await fetch(IGDB_URL, {
      method: 'POST',
      headers: {
        'Client-ID': process.env.TWITCH_CLIENT_ID,
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
      body,
    });

    if (!res.ok) {
      throw new Error(`IGDB ${res.status}: ${await res.text()}`);
    }

    const page = await res.json();
    all.push(...page);

    // Si la página vino llena (500), asumimos que hay más y seguimos.
    if (page.length < PAGE) break;
    offset += PAGE;
  }

  return all;
}

// ------------------------------------------------------------
//  2) Transformar la respuesta cruda en filas para la caché
// ------------------------------------------------------------

function buildCacheRows(rows) {
  const gamesById = new Map(); // deduplica juegos
  const releases = [];

  for (const r of rows) {
    const g = r.game;
    if (!g) continue;

    if (!gamesById.has(g.id)) {
      gamesById.set(g.id, {
        igdb_game_id: g.id,
        name: g.name ?? 'Sin título',
        cover_image_id: g.cover?.image_id ?? null,
        platforms: (g.platforms ?? []).map((p) => p.name),
        hypes: g.hypes ?? 0,
      });
    }

    releases.push({
      igdb_release_id: r.id,
      igdb_game_id: g.id,
      release_date: r.date ? new Date(r.date * 1000).toISOString().slice(0, 10) : null,
      date_precision: isPreciseDate(r.human) ? 'exacta' : 'aproximada',
      platform: PLATFORMS[r.platform] ?? String(r.platform),
      region: r.region != null ? String(r.region) : null,
      human: r.human ?? null,
    });
  }

  return { games: [...gamesById.values()], releases };
}

// ------------------------------------------------------------
//  3) Guardar en Supabase (upsert: ni duplica ni borra)
// ------------------------------------------------------------

async function storeMonth(month, { games, releases }) {
  if (games.length) {
    await supabase.from('games_cache').upsert(games, { onConflict: 'igdb_game_id' });
  }
  if (releases.length) {
    await supabase.from('release_dates').upsert(releases, { onConflict: 'igdb_release_id' });
  }
  // Marcamos el mes como descargado (incluso si vino vacío, para no
  // volver a pegarle a IGDB dentro del TTL).
  await supabase
    .from('cache_meta')
    .upsert({ cache_key: month, fetched_at: new Date().toISOString() }, { onConflict: 'cache_key' });
}

// ------------------------------------------------------------
//  4) Leer un mes desde la caché y agruparlo por juego
// ------------------------------------------------------------

async function readMonthFromCache(start, end) {
  const startDate = new Date(start * 1000).toISOString().slice(0, 10);
  const endDate = new Date(end * 1000).toISOString().slice(0, 10);

  // El embebido games_cache(...) usa la relación FK release_dates -> games_cache.
  const { data, error } = await supabase
    .from('release_dates')
    .select(
      'igdb_game_id, release_date, date_precision, platform, region, human, games_cache(name, cover_image_id, hypes)'
    )
    .gte('release_date', startDate)
    .lt('release_date', endDate);

  if (error) throw error;
  return data ?? [];
}

function groupByGame(month, rows) {
  const games = new Map();

  for (const r of rows) {
    const meta = r.games_cache ?? {};

    if (!games.has(r.igdb_game_id)) {
      games.set(r.igdb_game_id, {
        igdbId: r.igdb_game_id,
        name: meta.name ?? 'Sin título',
        coverImageId: meta.cover_image_id ?? null,
        hypes: meta.hypes ?? 0,
        byDate: new Map(), // agrupa las plataformas que comparten la misma fecha
      });
    }

    const game = games.get(r.igdb_game_id);
    const key = r.release_date ?? r.human ?? 'tbd';

    if (!game.byDate.has(key)) {
      game.byDate.set(key, {
        date: r.release_date,
        human: r.human,
        precise: r.date_precision === 'exacta',
        platforms: new Set(),
      });
    }
    game.byDate.get(key).platforms.add(r.platform);
  }

  const list = [...games.values()].map((g) => ({
    igdbId: g.igdbId,
    name: g.name,
    coverImageId: g.coverImageId,
    hypes: g.hypes,
    releases: [...g.byDate.values()].map((rel) => ({
      date: rel.date,
      human: rel.human,
      precise: rel.precise,
      platforms: [...rel.platforms],
    })),
  }));

  list.sort((a, b) => b.hypes - a.hypes); // lo más esperado, primero

  return { month, fetchedAt: new Date().toISOString(), games: list };
}

async function isMonthFresh(month) {
  const { data } = await supabase
    .from('cache_meta')
    .select('fetched_at')
    .eq('cache_key', month)
    .maybeSingle();

  return Boolean(data) && Date.now() - new Date(data.fetched_at).getTime() < TTL_MS;
}

// ------------------------------------------------------------
//  Orquestación: el cache-aside completo
// ------------------------------------------------------------

export async function getCalendar(month) {
  const { start, end } = monthWindow(month);

  if (!(await isMonthFresh(month))) {
    try {
      const token = await getIgdbToken();
      const rows = await fetchMonthFromIgdb(token, start, end);
      await storeMonth(month, buildCacheRows(rows));
    } catch (err) {
      // Degradación elegante: si IGDB falla pero ya teníamos algo cacheado
      // (aunque esté caducado), servimos lo viejo en vez de romper.
      console.error('IGDB falló; intento servir la caché previa:', err);
      const stale = await readMonthFromCache(start, end);
      if (stale.length === 0) throw err; // no hay nada que rescatar
    }
  }

  const cached = await readMonthFromCache(start, end);
  return groupByGame(month, cached);
}
