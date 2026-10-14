// ============================================================
//  Funciones puras del backend: sin red ni Supabase, para poder
//  probarlas aisladas (ver test/transform.test.js).
// ============================================================

// --- Plataformas que nos interesan (id de IGDB -> nombre legible) ---
export const PLATFORMS = {
  6: 'PC',
  48: 'PS4',
  49: 'Xbox One',
  130: 'Switch',
  167: 'PS5',
  169: 'Xbox Series',
  508: 'Switch 2',
};

// "2026-07" -> ventana [start, end) en segundos Unix (UTC).
export function monthWindow(month) {
  const [y, m] = month.split('-').map(Number);
  const start = Math.floor(Date.UTC(y, m - 1, 1) / 1000); // 1.º del mes
  const end = Math.floor(Date.UTC(y, m, 1) / 1000);       // 1.º del mes siguiente
  return { start, end };
}

// IGDB da las fechas exactas como "Dec 31, 2026" (coma + año) y las
// aproximadas como "Q4 2026", "2026" o "TBD". Nos apoyamos en el texto
// para no depender del enum de precisión (que IGDB ha ido cambiando).
export function isPreciseDate(human) {
  return /\d{1,2},\s*\d{4}/.test(human || '');
}

// Región de la fecha (release_date_regions de IGDB: 1 Europa, 2 Norteamérica,
// 5 Japón, 8 mundial…). El antiguo campo "region" ya no viene relleno.
export function regionOf(r) {
  return r.release_region != null ? String(r.release_region) : null;
}

// ------------------------------------------------------------
//  Respuesta cruda de IGDB -> filas para la caché
// ------------------------------------------------------------

export function buildCacheRows(rows) {
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
        hypes: g.hypes ?? 0,
        url: g.url ?? null,
      });
    }

    releases.push({
      igdb_release_id: r.id,
      igdb_game_id: g.id,
      release_date: r.date ? new Date(r.date * 1000).toISOString().slice(0, 10) : null,
      date_precision: isPreciseDate(r.human) ? 'exacta' : 'aproximada',
      platform: PLATFORMS[r.platform] ?? String(r.platform),
      region: regionOf(r),
      human: r.human ?? null,
    });
  }

  return { games: [...gamesById.values()], releases };
}

// ------------------------------------------------------------
//  Filas de la caché -> calendario del mes agrupado por juego
// ------------------------------------------------------------

export function groupByGame(month, rows, fetchedAt) {
  const games = new Map();

  for (const r of rows) {
    const meta = r.games_cache ?? {};

    if (!games.has(r.igdb_game_id)) {
      games.set(r.igdb_game_id, {
        igdbId: r.igdb_game_id,
        name: meta.name ?? 'Sin título',
        coverImageId: meta.cover_image_id ?? null,
        hypes: meta.hypes ?? 0,
        url: meta.url ?? null,
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
        regions: new Set(),
      });
    }
    const rel = game.byDate.get(key);
    rel.platforms.add(r.platform);
    if (r.region != null) rel.regions.add(r.region);
  }

  const list = [...games.values()].map((g) => ({
    igdbId: g.igdbId,
    name: g.name,
    coverImageId: g.coverImageId,
    hypes: g.hypes,
    url: g.url,
    releases: [...g.byDate.values()].map((rel) => ({
      date: rel.date,
      human: rel.human,
      precise: rel.precise,
      platforms: [...rel.platforms],
      regions: [...rel.regions],
    })),
  }));

  list.sort((a, b) => b.hypes - a.hypes); // lo más esperado, primero

  // fetchedAt: cuándo se descargó de verdad el mes de IGDB (null si no consta).
  return { month, fetchedAt: fetchedAt ?? null, games: list };
}
