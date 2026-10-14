import { test } from 'node:test';
import assert from 'node:assert/strict';
import { monthWindow, isPreciseDate, regionOf, buildCacheRows, groupByGame } from '../lib/transform.js';

// Segundos Unix de una fecha UTC (como los da IGDB)
const unix = (iso) => Date.parse(iso + 'T00:00:00Z') / 1000;

// Fila de release_dates tal como la devuelve IGDB
function igdbRow(overrides = {}) {
  return {
    id: 1,
    date: unix('2026-10-20'),
    human: 'Oct 20, 2026',
    platform: 167,
    release_region: 1,
    game: { id: 100, name: 'Juego', cover: { image_id: 'abc' }, hypes: 50, url: 'https://www.igdb.com/games/juego' },
    ...overrides,
  };
}

// --- monthWindow ---

test('monthWindow: ventana [1.º del mes, 1.º del siguiente) en UTC', () => {
  assert.deepEqual(monthWindow('2026-10'), { start: unix('2026-10-01'), end: unix('2026-11-01') });
});

test('monthWindow: diciembre pasa al año siguiente', () => {
  assert.equal(monthWindow('2026-12').end, unix('2027-01-01'));
});

// --- isPreciseDate ---

test('isPreciseDate: solo las fechas con día son exactas', () => {
  assert.equal(isPreciseDate('Oct 20, 2026'), true);
  assert.equal(isPreciseDate('Q4 2026'), false);
  assert.equal(isPreciseDate('2026'), false);
  assert.equal(isPreciseDate('TBD'), false);
  assert.equal(isPreciseDate(null), false);
});

// --- regionOf ---

test('regionOf: usa release_region (el campo region está obsoleto)', () => {
  assert.equal(regionOf({ release_region: 8 }), '8');
  assert.equal(regionOf({ region: 5 }), null);
  assert.equal(regionOf({}), null);
});

// --- buildCacheRows ---

test('buildCacheRows: deduplica juegos y crea una fila por release', () => {
  const { games, releases } = buildCacheRows([
    igdbRow({ id: 1, platform: 167 }),
    igdbRow({ id: 2, platform: 6 }),
  ]);
  assert.equal(games.length, 1);
  assert.deepEqual(games[0], {
    igdb_game_id: 100,
    name: 'Juego',
    cover_image_id: 'abc',
    platforms: [],
    hypes: 50,
    url: 'https://www.igdb.com/games/juego',
  });
  assert.deepEqual(releases, [
    { igdb_release_id: 1, igdb_game_id: 100, release_date: '2026-10-20', date_precision: 'exacta', platform: 'PS5', region: '1', human: 'Oct 20, 2026' },
    { igdb_release_id: 2, igdb_game_id: 100, release_date: '2026-10-20', date_precision: 'exacta', platform: 'PC', region: '1', human: 'Oct 20, 2026' },
  ]);
});

test('buildCacheRows: fechas aproximadas, valores ausentes y plataformas desconocidas', () => {
  const { games, releases } = buildCacheRows([
    igdbRow({ date: undefined, human: 'Q4 2026', platform: 999, release_region: undefined, game: { id: 7 } }),
  ]);
  assert.deepEqual(games[0], { igdb_game_id: 7, name: 'Sin título', cover_image_id: null, platforms: [], hypes: 0, url: null });
  assert.equal(releases[0].release_date, null);
  assert.equal(releases[0].date_precision, 'aproximada');
  assert.equal(releases[0].platform, '999');
  assert.equal(releases[0].region, null);
});

test('buildCacheRows: ignora filas sin juego', () => {
  assert.deepEqual(buildCacheRows([igdbRow({ game: undefined })]), { games: [], releases: [] });
});

// --- groupByGame ---

// Fila de la caché tal como la devuelve readMonthFromCache
function cacheRow(overrides = {}) {
  return {
    igdb_release_id: 1,
    igdb_game_id: 100,
    release_date: '2026-10-20',
    date_precision: 'exacta',
    platform: 'PS5',
    region: '1',
    human: 'Oct 20, 2026',
    games_cache: { name: 'Juego', cover_image_id: 'abc', hypes: 50, url: null },
    ...overrides,
  };
}

test('groupByGame: junta plataformas y regiones que comparten fecha', () => {
  const { games } = groupByGame('2026-10', [
    cacheRow({ igdb_release_id: 1, platform: 'PS5', region: '1' }),
    cacheRow({ igdb_release_id: 2, platform: 'PC', region: '2' }),
    cacheRow({ igdb_release_id: 3, platform: 'PS5', region: '5', release_date: '2026-10-02', human: 'Oct 2, 2026' }),
  ]);
  assert.equal(games.length, 1);
  assert.deepEqual(games[0].releases, [
    { date: '2026-10-20', human: 'Oct 20, 2026', precise: true, platforms: ['PS5', 'PC'], regions: ['1', '2'] },
    { date: '2026-10-02', human: 'Oct 2, 2026', precise: true, platforms: ['PS5'], regions: ['5'] },
  ]);
});

test('groupByGame: fechas sin día se agrupan por su texto', () => {
  const { games } = groupByGame('2026-10', [
    cacheRow({ igdb_release_id: 1, release_date: null, date_precision: 'aproximada', human: 'Q4 2026', region: null }),
    cacheRow({ igdb_release_id: 2, release_date: null, date_precision: 'aproximada', human: 'Q4 2026', platform: 'PC', region: null }),
  ]);
  assert.deepEqual(games[0].releases, [
    { date: null, human: 'Q4 2026', precise: false, platforms: ['PS5', 'PC'], regions: [] },
  ]);
});

test('groupByGame: ordena por hype descendente', () => {
  const { games } = groupByGame('2026-10', [
    cacheRow({ igdb_release_id: 1, igdb_game_id: 1, games_cache: { name: 'Poco', hypes: 5 } }),
    cacheRow({ igdb_release_id: 2, igdb_game_id: 2, games_cache: { name: 'Mucho', hypes: 500 } }),
    cacheRow({ igdb_release_id: 3, igdb_game_id: 3, games_cache: null }),
  ]);
  assert.deepEqual(games.map((g) => [g.name, g.hypes]), [['Mucho', 500], ['Poco', 5], ['Sin título', 0]]);
});

test('groupByGame: devuelve la hora real de descarga, o null', () => {
  assert.equal(groupByGame('2026-10', [], '2026-10-13T08:00:00.000Z').fetchedAt, '2026-10-13T08:00:00.000Z');
  assert.equal(groupByGame('2026-10', []).fetchedAt, null);
  assert.equal(groupByGame('2026-10', []).month, '2026-10');
});
