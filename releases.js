// ============================================================
//  Funciones puras del frontend: se cargan antes de app.js como
//  script normal y se prueban aisladas (ver test/releases.test.js).
// ============================================================

// Regiones de IGDB exclusivas de Asia (5 Japón, 6 China, 7 Asia, 9 Corea).
// Una fecha que solo vale ahí no debería ser la principal si hay otra.
const ASIAN_REGIONS = new Set(['5', '6', '7', '9']);
function isLocalRelease(r) {
  const regions = r.regions ?? [];
  return regions.length === 0 || regions.some((id) => !ASIAN_REGIONS.has(id));
}

// Una "aparición" por juego al mes: lo colocamos en su fecha principal
// y juntamos todas sus plataformas en una sola tarjeta.
function expandReleases(games) {
  const exact = [];
  const approx = [];
  for (const g of games) {
    const platforms = [...new Set(g.releases.flatMap((r) => r.platforms))];
    // Preferimos las fechas válidas para nuestra región; si el juego
    // solo tiene fechas asiáticas, usamos esas.
    const local = g.releases.filter(isLocalRelease);
    const releases = local.length ? local : g.releases;
    const precisos = releases.filter((r) => r.precise && r.date);
    if (precisos.length) {
      // Fecha representativa: la que sale en más plataformas; si empatan,
      // la más tardía (suele ser la edición estándar, no el acceso anticipado).
      const rep = precisos.reduce((best, r) => {
        if (!best) return r;
        if (r.platforms.length !== best.platforms.length)
          return r.platforms.length > best.platforms.length ? r : best;
        return r.date > best.date ? r : best;
      }, null);
      exact.push({ dateISO: rep.date, game: g, platforms });
    } else {
      const human = releases.find((r) => r.human)?.human ?? 'Sin fecha';
      approx.push({ game: g, human, platforms });
    }
  }
  return { exact, approx };
}

// Agrupa tus juegos para "Mi lista" (today: 'YYYY-MM-DD'). Cada entrada
// lleva su fecha principal (dateISO) o, si no es exacta, el texto (label).
// Dentro de cada grupo se ordena por fecha; las que no la tienen, al final.
function listGroups(games, statusOf, today) {
  const { exact, approx } = expandReleases(games);
  const entries = [
    ...exact.map((e) => ({ game: e.game, dateISO: e.dateISO, label: null, platforms: e.platforms })),
    ...approx.map((a) => ({ game: a.game, dateISO: null, label: a.human, platforms: a.platforms })),
  ];
  entries.sort((a, b) => {
    if (a.dateISO !== b.dateISO) {
      if (!a.dateISO) return 1;
      if (!b.dateISO) return -1;
      return a.dateISO < b.dateISO ? -1 : 1;
    }
    return a.game.name.localeCompare(b.game.name, 'es');
  });

  const groups = { released: [], upcoming: [], reserved: [], bought: [] };
  for (const e of entries) {
    const s = statusOf(e.game.igdbId);
    if (s === 'interesado') (e.dateISO && e.dateISO <= today ? groups.released : groups.upcoming).push(e);
    else if (s === 'reservado') groups.reserved.push(e);
    else if (s === 'comprado') groups.bought.push(e);
  }
  return groups;
}
