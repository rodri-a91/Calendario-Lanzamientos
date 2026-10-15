import { supabase } from './supabase.js';
import { getIgdbToken } from './igdbToken.js';
import { PLATFORMS, monthWindow, buildCacheRows, groupByGame, buildGameDetails } from './transform.js';

const PLATFORM_IDS = Object.keys(PLATFORMS).join(',');

// Suelo de hype al traer datos: elimina de raíz la morralla de 0 hype.
const HYPE_FLOOR = 1;

// Frescura de la caché de un mes.
const TTL_MS = 12 * 60 * 60 * 1000; // 12 horas
// Frescura de la ficha de un juego (resumen, géneros…: cambian poco).
const DETAILS_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 días

const IGDB_URL = 'https://api.igdb.com/v4/release_dates';
const IGDB_GAMES_URL = 'https://api.igdb.com/v4/games';
const PAGE = 500; // máximo de filas por petición en IGDB
const DB_PAGE = 1000; // máximo de filas por petición en Supabase (max-rows)
const ID_BATCH = 200; // ids por petición con .in(...) (mantiene la URL corta)

// Columnas de una fecha en caché + datos del juego (embebido por la FK
// release_dates -> games_cache).
const RELEASE_SELECT =
  'igdb_release_id, igdb_game_id, release_date, date_precision, platform, region, human, games_cache(name, cover_image_id, hypes, url)';

// ------------------------------------------------------------
//  Helpers
// ------------------------------------------------------------

// supabase-js no lanza excepciones: devuelve { error }. Lo convertimos
// en throw para que un fallo de escritura corte el proceso a tiempo.
function check({ error }, what) {
  if (error) throw new Error(`Supabase (${what}): ${error.message}`);
}

// ------------------------------------------------------------
//  1) Traer un mes desde IGDB (con paginación)
// ------------------------------------------------------------

async function fetchMonthFromIgdb(token, start, end) {
  const all = [];
  let offset = 0;

  // Llamadas secuenciales: cada round-trip tarda bastante más de 250 ms,
  // así que nunca rozamos el límite de 4 peticiones/segundo de IGDB.
  // Ordenamos por id (único) para que la paginación con offset sea estable;
  // el orden por hype se aplica después, al agrupar.
  while (true) {
    const body = `
      fields id, date, human, platform, release_region,
             game.id, game.name, game.cover.image_id,
             game.hypes, game.url;
      where date >= ${start} & date < ${end}
          & platform = (${PLATFORM_IDS})
          & game.hypes >= ${HYPE_FLOOR};
      sort id asc;
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
//  2) Guardar en Supabase
//     Upsert de lo nuevo + borrado de lo que ya no viene en la
//     respuesta (fechas viejas que IGDB reemplazó por otras, como
//     un retraso o un adelanto de lanzamiento).
// ------------------------------------------------------------

async function storeMonth(month, start, end, { games, releases }) {
  // Si alguna escritura falla, check() lanza y NO llegamos ni al borrado
  // ni a marcar el mes como fresco: la caché anterior queda intacta.
  if (games.length) {
    // updated_at solo tiene default en el INSERT: en un upsert que actualiza
    // hay que mandarlo para que refleje la última descarga.
    const updatedAt = new Date().toISOString();
    check(
      await supabase
        .from('games_cache')
        .upsert(games.map((g) => ({ ...g, updated_at: updatedAt })), { onConflict: 'igdb_game_id' }),
      'upsert games_cache'
    );
  }
  if (releases.length) {
    check(await supabase.from('release_dates').upsert(releases, { onConflict: 'igdb_release_id' }), 'upsert release_dates');
  }

  // Limpieza: cualquier release_date que cayera en la ventana de este mes
  // y no esté entre los ids que acabamos de recibir, ya no es válido
  // (IGDB lo movió a otra fecha o lo retiró). Lo borramos.
  // Si IGDB devolvió el mes vacío no borramos nada: es mucho más probable
  // una respuesta anómala que un mes que de repente se queda sin juegos.
  // Calculamos los ids obsoletos aquí y los borramos por lotes, en vez de
  // mandar un "NOT IN (todos los ids frescos)" que podría desbordar la URL.
  if (releases.length) {
    const freshIds = new Set(releases.map((r) => r.igdb_release_id));
    const cached = await readMonthFromCache(start, end);
    const staleIds = cached.map((r) => r.igdb_release_id).filter((id) => !freshIds.has(id));

    for (let i = 0; i < staleIds.length; i += ID_BATCH) {
      check(
        await supabase
          .from('release_dates')
          .delete()
          .in('igdb_release_id', staleIds.slice(i, i + ID_BATCH)),
        'limpieza release_dates'
      );
    }
  }

  // Marcamos el mes como descargado (incluso si vino vacío, para no
  // volver a pegarle a IGDB dentro del TTL).
  const fetchedAt = new Date().toISOString();
  check(
    await supabase
      .from('cache_meta')
      .upsert({ cache_key: month, fetched_at: fetchedAt }, { onConflict: 'cache_key' }),
    'upsert cache_meta'
  );
  return fetchedAt;
}

// ------------------------------------------------------------
//  3) Leer un mes desde la caché
// ------------------------------------------------------------

async function readMonthFromCache(start, end) {
  const startDate = new Date(start * 1000).toISOString().slice(0, 10);
  const endDate = new Date(end * 1000).toISOString().slice(0, 10);

  // Supabase corta cada respuesta en DB_PAGE filas, así que paginamos
  // (ordenando por la PK para que las páginas no se solapen).
  const all = [];
  for (let from = 0; ; from += DB_PAGE) {
    const { data, error } = await supabase
      .from('release_dates')
      .select(RELEASE_SELECT)
      .gte('release_date', startDate)
      .lt('release_date', endDate)
      .order('igdb_release_id')
      .range(from, from + DB_PAGE - 1);

    if (error) throw error;
    all.push(...(data ?? []));
    if (!data || data.length < DB_PAGE) break;
  }
  return all;
}

// Hora de la última descarga del mes, o null si nunca se descargó.
async function monthFetchedAt(month) {
  const { data, error } = await supabase
    .from('cache_meta')
    .select('fetched_at')
    .eq('cache_key', month)
    .maybeSingle();

  if (error) throw error;
  return data?.fetched_at ?? null;
}

function isFresh(fetchedAt, ttl = TTL_MS) {
  return fetchedAt != null && Date.now() - new Date(fetchedAt).getTime() < ttl;
}

// ------------------------------------------------------------
//  4) Juegos concretos (para "Mi lista"), con todas sus fechas en caché
// ------------------------------------------------------------

export async function getGamesByIds(ids) {
  const all = [];
  for (let i = 0; i < ids.length; i += ID_BATCH) {
    const batch = ids.slice(i, i + ID_BATCH);
    for (let from = 0; ; from += DB_PAGE) {
      const { data, error } = await supabase
        .from('release_dates')
        .select(RELEASE_SELECT)
        .in('igdb_game_id', batch)
        .order('igdb_release_id')
        .range(from, from + DB_PAGE - 1);

      if (error) throw error;
      all.push(...(data ?? []));
      if (!data || data.length < DB_PAGE) break;
    }
  }
  // Un juego que no esté en caché (IGDB lo movió a un mes aún no
  // descargado) simplemente no aparece: el navegador usa lo que guardó.
  return groupByGame(null, all).games;
}

// ------------------------------------------------------------
//  5) Ficha de un juego (resumen, géneros, compañías, capturas…)
//     Se pide bajo demanda al abrir la ficha y se guarda en game_details.
// ------------------------------------------------------------

async function fetchDetailsFromIgdb(token, id) {
  const body = `
    fields summary, genres.name, game_modes.name,
           involved_companies.company.name, involved_companies.developer,
           involved_companies.publisher, screenshots.image_id,
           videos.video_id, videos.name, aggregated_rating, total_rating;
    where id = ${id};
  `;
  const res = await fetch(IGDB_GAMES_URL, {
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
  const [game] = await res.json();
  return buildGameDetails(game);
}

// Devuelve los detalles, o null si el juego no está en la caché. Solo
// atendemos juegos que ya salen en algún calendario: así el endpoint
// público no sirve para descargar de IGDB cualquier id.
export async function getGameDetails(id) {
  const [{ data: known, error: knownError }, { data: cached, error: cachedError }] = await Promise.all([
    supabase.from('games_cache').select('igdb_game_id').eq('igdb_game_id', id).maybeSingle(),
    supabase.from('game_details').select('data, fetched_at').eq('igdb_game_id', id).maybeSingle(),
  ]);
  if (knownError) throw knownError;
  if (cachedError) throw cachedError;
  if (!known) return null;
  if (cached && isFresh(cached.fetched_at, DETAILS_TTL_MS)) return cached.data;

  try {
    const token = await getIgdbToken();
    const data = await fetchDetailsFromIgdb(token, id);
    check(
      await supabase
        .from('game_details')
        .upsert({ igdb_game_id: id, data, fetched_at: new Date().toISOString() }, { onConflict: 'igdb_game_id' }),
      'upsert game_details'
    );
    return data;
  } catch (err) {
    // Igual que con los meses: mejor una ficha caducada que ninguna.
    if (cached) {
      console.error('IGDB falló; sirvo la ficha previa:', err);
      return cached.data;
    }
    throw err;
  }
}

// ------------------------------------------------------------
//  Orquestación: el cache-aside completo
// ------------------------------------------------------------

export async function getCalendar(month) {
  const { start, end } = monthWindow(month);
  let fetchedAt = await monthFetchedAt(month);

  if (!isFresh(fetchedAt)) {
    try {
      const token = await getIgdbToken();
      const rows = await fetchMonthFromIgdb(token, start, end);
      fetchedAt = await storeMonth(month, start, end, buildCacheRows(rows));
    } catch (err) {
      // Degradación elegante: si IGDB falla pero ya teníamos algo cacheado
      // (aunque esté caducado), servimos lo viejo en vez de romper.
      console.error('IGDB falló; intento servir la caché previa:', err);
      const stale = await readMonthFromCache(start, end);
      if (stale.length === 0) throw err; // no hay nada que rescatar
      return groupByGame(month, stale, fetchedAt);
    }
  }

  const cached = await readMonthFromCache(start, end);
  return groupByGame(month, cached, fetchedAt);
}
