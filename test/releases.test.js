import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// releases.js es un script normal del navegador (sin export):
// lo ejecutamos en un contexto aislado y recogemos sus funciones.
const ctx = {};
vm.runInNewContext(readFileSync(new URL('../releases.js', import.meta.url), 'utf8'), ctx);
const { expandReleases } = ctx;

const rel = (date, { regions = [], platforms = ['PS5'], precise = date != null, human } = {}) =>
  ({ date, human: human ?? date ?? 'Q4 2026', precise, platforms, regions });
const game = (igdbId, releases) => ({ igdbId, releases });

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
