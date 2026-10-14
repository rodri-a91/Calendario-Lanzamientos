import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// releases.js es un script normal del navegador (sin export):
// lo ejecutamos en un contexto aislado y recogemos sus funciones.
const ctx = {};
vm.runInNewContext(readFileSync(new URL('../releases.js', import.meta.url), 'utf8'), ctx);
const { expandReleases, listGroups } = ctx;

const rel = (date, { regions = [], platforms = ['PS5'], precise = date != null, human } = {}) =>
  ({ date, human: human ?? date ?? 'Q4 2026', precise, platforms, regions });
const game = (igdbId, releases, name = `Juego ${igdbId}`) => ({ igdbId, name, releases });

// Resumen comparable: [id, fecha] para exactas, [id, texto] para aproximadas.
// JSON evita problemas al comparar arrays creados en otro contexto de vm.
function summary(games) {
  const { exact, approx } = expandReleases(games);
  return JSON.parse(JSON.stringify({
    exact: exact.map((e) => [e.game.igdbId, e.dateISO, e.platforms]),
    approx: approx.map((a) => [a.game.igdbId, a.human, a.platforms]),
  }));
}

test('una sola aparición por juego, con todas sus plataformas', () => {
  const out = summary([game(1, [rel('2026-10-20', { platforms: ['PS5', 'PC'] }), rel('2026-10-20', { platforms: ['Switch'] })])]);
  assert.deepEqual(out.exact, [[1, '2026-10-20', ['PS5', 'PC', 'Switch']]]);
  assert.deepEqual(out.approx, []);
});

test('fecha principal: la que sale en más plataformas', () => {
  const out = summary([game(1, [
    rel('2026-10-05', { platforms: ['PC'] }),
    rel('2026-10-20', { platforms: ['PS5', 'Xbox Series'] }),
  ])]);
  assert.equal(out.exact[0][1], '2026-10-20');
});

test('fecha principal: si empatan, la más tardía (no el acceso anticipado)', () => {
  const out = summary([game(1, [rel('2026-10-20'), rel('2026-10-17')])]);
  assert.equal(out.exact[0][1], '2026-10-20');
});

test('región: una fecha solo de Japón no gana a una europea', () => {
  const out = summary([game(1, [
    rel('2026-10-02', { regions: ['5'], platforms: ['PS5', 'Switch'] }),
    rel('2026-10-20', { regions: ['1'] }),
  ])]);
  assert.equal(out.exact[0][1], '2026-10-20');
});

test('región: si solo hay fechas asiáticas, se usan', () => {
  const out = summary([game(1, [rel('2026-10-05', { regions: ['5'] })])]);
  assert.deepEqual(out.exact, [[1, '2026-10-05', ['PS5']]]);
});

test('región: una fecha compartida con una región no asiática cuenta como local', () => {
  const out = summary([game(1, [
    rel('2026-10-05', { regions: ['5', '8'] }),
    rel('2026-10-20', { regions: ['2'] }),
  ])]);
  assert.equal(out.exact[0][1], '2026-10-20'); // empate de plataformas -> la más tardía
});

test('región: sin datos de región (respuestas antiguas) cuenta como local', () => {
  const out = summary([game(1, [{ date: '2026-10-09', human: 'Oct 9, 2026', precise: true, platforms: ['PC'] }])]);
  assert.deepEqual(out.exact, [[1, '2026-10-09', ['PC']]]);
});

test('región: exacta solo en Japón + aproximada mundial -> sin fecha exacta', () => {
  const out = summary([game(1, [
    rel('2026-10-07', { regions: ['5'] }),
    rel(null, { regions: ['8'], human: 'Q4 2026', platforms: ['PC'] }),
  ])]);
  assert.deepEqual(out.exact, []);
  assert.deepEqual(out.approx, [[1, 'Q4 2026', ['PS5', 'PC']]]);
});

test('sin ninguna fecha exacta: va a aproximadas con su texto o "Sin fecha"', () => {
  const out = summary([
    game(1, [rel(null, { human: '2027' })]),
    game(2, [{ date: null, human: null, precise: false, platforms: ['PC'] }]),
  ]);
  assert.deepEqual(out.approx, [[1, '2027', ['PS5']], [2, 'Sin fecha', ['PC']]]);
});

test('una fecha marcada exacta pero sin día no cuenta como exacta', () => {
  const out = summary([game(1, [rel(null, { precise: true, human: 'TBD' })])]);
  assert.deepEqual(out.approx, [[1, 'TBD', ['PS5']]]);
});

// --- listGroups (Mi lista) ---

const TODAY = '2026-10-14';
const statuses = (map) => (id) => map[id] ?? null;

// Resumen por grupo: [id, fecha o texto]
function groupsSummary(games, map) {
  const g = listGroups(games, statuses(map), TODAY);
  const pick = (list) => list.map((e) => [e.game.igdbId, e.dateISO ?? e.label]);
  return JSON.parse(JSON.stringify({
    released: pick(g.released), upcoming: pick(g.upcoming), reserved: pick(g.reserved), bought: pick(g.bought),
  }));
}

test('listGroups: "me interesa" se reparte entre ya a la venta (hoy incluido) y próximamente', () => {
  const out = groupsSummary(
    [game(1, [rel('2026-03-12')]), game(2, [rel('2026-10-14')]), game(3, [rel('2026-11-20')])],
    { 1: 'interesado', 2: 'interesado', 3: 'interesado' }
  );
  assert.deepEqual(out.released, [[1, '2026-03-12'], [2, '2026-10-14']]);
  assert.deepEqual(out.upcoming, [[3, '2026-11-20']]);
});

test('listGroups: ordena por fecha, con las aproximadas y sin fecha al final', () => {
  const out = groupsSummary(
    [
      game(1, [], 'Sin fechas'),
      game(2, [rel(null, { human: 'Q4 2026' })]),
      game(3, [rel('2027-02-01')]),
      game(4, [rel('2026-12-01')]),
    ],
    { 1: 'interesado', 2: 'interesado', 3: 'interesado', 4: 'interesado' }
  );
  assert.deepEqual(out.upcoming, [[4, '2026-12-01'], [3, '2027-02-01'], [2, 'Q4 2026'], [1, 'Sin fecha']]);
});

test('listGroups: reservados y comprados en su grupo; descartados y sin estado fuera', () => {
  const out = groupsSummary(
    [game(1, [rel('2026-01-01')]), game(2, [rel('2026-02-01')]), game(3, [rel('2026-03-01')]), game(4, [rel('2026-04-01')])],
    { 1: 'reservado', 2: 'comprado', 3: 'descartado' }
  );
  assert.deepEqual(out, { released: [], upcoming: [], reserved: [[1, '2026-01-01']], bought: [[2, '2026-02-01']] });
});

test('listGroups: misma fecha -> orden alfabético', () => {
  const out = groupsSummary(
    [game(1, [rel('2026-05-01')], 'Zelda'), game(2, [rel('2026-05-01')], 'Astro')],
    { 1: 'interesado', 2: 'interesado' }
  );
  assert.deepEqual(out.released, [[2, '2026-05-01'], [1, '2026-05-01']]);
});
