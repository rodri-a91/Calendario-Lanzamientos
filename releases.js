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
