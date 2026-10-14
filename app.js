// ============================================================
//  Calendario de lanzamientos — lógica del frontend
// ============================================================

const { createClient } = window.supabase;
const db = createClient(window.APP_CONFIG.SUPABASE_URL, window.APP_CONFIG.SUPABASE_ANON_KEY);

// --- Constantes de presentación ---
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const DOW = ['lun', 'mar', 'mié', 'jue', 'vie', 'sáb', 'dom']; // semana de lunes a domingo
const ESTADOS_POSITIVOS = ['interesado', 'reservado', 'comprado'];

// Iconos (SVG en línea, heredan el color del botón vía currentColor)
const LABELS = { interesado: 'Me interesa', reservado: 'Reservado', comprado: 'Comprado', descartado: 'No me interesa' };
const svgIcon = (p) => `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
const ICONS = {
  interesado: svgIcon('<path d="M12 17.75l-6.172 3.245l1.179 -6.873l-5 -4.867l6.9 -1l3.086 -6.253l3.086 6.253l6.9 1l-5 4.867l1.179 6.873z"/>'),
  reservado: svgIcon('<path d="M9 4h6a2 2 0 0 1 2 2v14l-5 -3l-5 3v-14a2 2 0 0 1 2 -2"/>'),
  comprado: svgIcon('<path d="M5 12l5 5l10 -10"/>'),
  descartado: svgIcon('<path d="M18 6l-12 12"/><path d="M6 6l12 12"/>'),
};

// Juegos con este hype o más se destacan
const HOT_THRESHOLD = 30;
const FLAME = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 12c2 -2.96 0 -7 -1 -8c0 3.038 -1.773 4.741 -3 6c-1.226 1.26 -2 3.24 -2 5a6 6 0 1 0 12 0c0 -1.532 -1.056 -3.94 -2 -5c-1.786 3 -2.791 3 -4 2z"/></svg>';

// Familia de plataforma -> clase de color para el chip
function platClass(name) {
  if (name.startsWith('PS')) return 'plat-ps';
  if (name.startsWith('Xbox')) return 'plat-xbox';
  if (name.startsWith('Switch')) return 'plat-nintendo';
  return 'plat-pc';
}

// --- Estado de la aplicación ---
const state = {
  section: 'calendar',       // 'calendar' | 'list' (Mi lista)
  date: new Date(),          // apunta a un día del mes mostrado
  view: 'agenda',            // 'agenda' | 'grid'
  scope: 'general',          // 'general' | 'mine'
};
let currentUserId = null;
let gamesById = new Map();    // igdbId -> juego del mes mostrado (de la API)
let trackedMap = new Map();   // igdbId -> { status, name, coverImageId }
let listGamesById = new Map(); // igdbId -> juego con todas sus fechas (Mi lista)
let listFetched = new Set();   // ids ya pedidos a /api/games en esta sesión
let loadedMonth = null;        // mes que hay en gamesById
let undoTimer = null;
let loadSeq = 0;               // descarta respuestas de meses que ya no se muestran
let trackedLoaded = false;     // tus estados se cargan una vez por sesión, no por mes

// Rango de meses que acepta la API (ver MAX_YEARS_AWAY en api/calendar.js)
const YEARS_AWAY = 3;
const MIN_MONTH = new Date(new Date().getFullYear() - YEARS_AWAY, 0, 1);
const MAX_MONTH = new Date(new Date().getFullYear() + YEARS_AWAY, 11, 1);

// ============================================================
//  AUTENTICACIÓN
// ============================================================

async function init() {
  const { data: { session } } = await db.auth.getSession();
  if (session) {
    currentUserId = session.user.id;
    showApp();
  } else {
    show('login');
  }
}

document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = document.getElementById('email').value.trim();
  const password = document.getElementById('password').value;
  const errEl = document.getElementById('login-error');
  errEl.textContent = '';

  const { data, error } = await db.auth.signInWithPassword({ email, password });
  if (error) {
    errEl.textContent = 'No se pudo entrar. Revisa el email y la contraseña.';
    return;
  }
  currentUserId = data.user.id;
  showApp();
});

document.getElementById('logout').addEventListener('click', async () => {
  await db.auth.signOut();
  currentUserId = null;
  show('login');
});

// Si la sesión se cierra por otra vía (otra pestaña, refresh token caducado
// o revocado), volvemos al login en vez de fallar con errores de RLS.
db.auth.onAuthStateChange((event, session) => {
  if (event === 'SIGNED_OUT' || (!session && currentUserId)) {
    currentUserId = null;
    gamesById = new Map();
    trackedMap = new Map();
    listGamesById = new Map();
    listFetched = new Set();
    loadedMonth = null;
    trackedLoaded = false;
    show('login');
  }
});

function show(which) {
  document.getElementById('login').classList.toggle('hidden', which !== 'login');
  document.getElementById('app').classList.toggle('hidden', which !== 'app');
}

function showApp() {
  show('app');
  if (state.section === 'list') loadList();
  else loadAll({ jump: true }); // al abrir, saltar al próximo lanzamiento
}

// ============================================================
//  CARGA DE DATOS
// ============================================================

function monthKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

async function loadAll({ jump = false } = {}) {
  // Si el usuario cambia de mes antes de que llegue la respuesta,
  // la petición antigua queda obsoleta y no debe pisar a la nueva.
  const seq = ++loadSeq;
  updateMonthNav();
  const content = document.getElementById('content');
  content.innerHTML = '<p class="empty-msg">Cargando…</p>';
  try {
    // trackedMap ya se mantiene al día con cada cambio local: solo hace
    // falta pedirlo a Supabase la primera vez de la sesión.
    const [calendar] = await Promise.all([
      fetchCalendar(monthKey(state.date)),
      trackedLoaded ? null : loadTracked(),
    ]);
    if (seq !== loadSeq) return;

    gamesById = new Map();
    for (const g of calendar.games) gamesById.set(g.igdbId, g);
    loadedMonth = monthKey(state.date);

    render();
    if (jump && state.view === 'agenda') scrollToNextRelease();
  } catch (err) {
    if (seq !== loadSeq) return;
    console.error(err);
    content.innerHTML = '<p class="empty-msg">No se pudo cargar el calendario.</p>';
  }
}

async function fetchCalendar(month) {
  const res = await fetch(`/api/calendar?month=${month}`);
  if (!res.ok) throw new Error('API ' + res.status);
  return res.json();
}

async function loadTracked() {
  // Gracias al RLS, esto solo devuelve TUS filas.
  const { data, error } = await db.from('tracked_games').select('igdb_game_id, status, game_name, cover_image_id');
  if (error) throw error;
  trackedMap = new Map();
  for (const row of data) {
    trackedMap.set(row.igdb_game_id, { status: row.status, name: row.game_name, coverImageId: row.cover_image_id });
  }
  trackedLoaded = true;
}

// Mi lista: pide a /api/games los juegos seguidos que aún no tenemos
// (con todas sus fechas, sean del mes que sean) y pinta la lista.
async function loadList() {
  const seq = ++loadSeq;
  const content = document.getElementById('content');
  try {
    if (!trackedLoaded) {
      content.innerHTML = '<p class="empty-msg">Cargando…</p>';
      await loadTracked();
    }
    const missing = myIds().filter((id) => !listFetched.has(id));
    if (missing.length) {
      content.innerHTML = '<p class="empty-msg">Cargando…</p>';
      const chunks = [];
      for (let i = 0; i < missing.length; i += 200) chunks.push(missing.slice(i, i + 200));
      const results = await Promise.all(chunks.map(fetchGames));
      for (const g of results.flat()) listGamesById.set(g.igdbId, g);
      for (const id of missing) listFetched.add(id);
    }
    if (seq !== loadSeq) return;
    render();
  } catch (err) {
    if (seq !== loadSeq) return;
    console.error(err);
    content.innerHTML = '<p class="empty-msg">No se pudo cargar tu lista.</p>';
  }
}

async function fetchGames(ids) {
  const res = await fetch(`/api/games?ids=${ids.join(',')}`);
  if (!res.ok) throw new Error('API ' + res.status);
  return (await res.json()).games;
}

// ============================================================
//  FILTRADO (todo en el navegador)
// ============================================================

function statusOf(igdbId) {
  return trackedMap.get(igdbId)?.status ?? null;
}

// Ids de los juegos que sigo (cualquier estado menos descartado)
function myIds() {
  return [...trackedMap].filter(([, t]) => ESTADOS_POSITIVOS.includes(t.status)).map(([id]) => id);
}

// Busca un juego en lo cargado. Si no está en la caché (p. ej. IGDB lo
// movió a un mes aún no descargado), lo montamos con lo que guardaste.
function findGame(igdbId) {
  const g = listGamesById.get(igdbId) ?? gamesById.get(igdbId);
  if (g) return g;
  const t = trackedMap.get(igdbId);
  if (!t) return null;
  return { igdbId, name: t.name ?? 'Sin título', coverImageId: t.coverImageId ?? null, hypes: 0, url: null, releases: [] };
}

function visibleGames() {
  const all = [...gamesById.values()];

  if (state.scope === 'mine') {
    // Solo míos: los que tengo en un estado positivo este mes.
    return all.filter((g) => ESTADOS_POSITIVOS.includes(statusOf(g.igdbId)));
  }

  // General: todo menos los descartados.
  return all.filter((g) => statusOf(g.igdbId) !== 'descartado');
}

// ============================================================
//  RENDER
// ============================================================

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Desplaza la página hasta la primera cabecera de día igual o posterior a hoy.
// Usa la altura real de la barra para no esconder el día tras ella.
function scrollToNextRelease() {
  scrollToDay(todayISO());
}

// Desplaza la Agenda hasta el primer día con lanzamientos igual o posterior
// a iso. Medimos la <section> del día y no su cabecera, que al ser sticky
// puede estar "pegada" arriba y dar una posición engañosa.
function scrollToDay(iso, behavior = 'smooth') {
  let target = null;
  for (const h of document.querySelectorAll('#content .day-head[data-date]')) {
    if (h.dataset.date >= iso) { target = h.closest('.day') ?? h; break; }
  }
  if (!target) return; // no hay nada desde ese día: nos quedamos donde estamos
  // La barra se queda visible durante el salto, así su altura cuenta.
  showTopbar(800);
  const headerH = document.querySelector('.topbar')?.offsetHeight ?? 0;
  const y = target.getBoundingClientRect().top + window.scrollY - headerH - 8;
  window.scrollTo({ top: y, behavior });
}

function render() {
  // Etiquetas de la cabecera
  document.getElementById('month-picker').value = monthKey(state.date);

  // Repintar destruye los botones: si el foco estaba en uno de estado
  // (teclado), lo devolvemos al mismo botón de la tarjeta nueva.
  const focused = document.activeElement?.closest?.('#content button[data-action]');
  const focusKey = focused && { id: focused.dataset.id, action: focused.dataset.action };

  const content = document.getElementById('content');
  if (state.section === 'list') {
    content.innerHTML = renderList();
  } else {
    const games = visibleGames();
    content.innerHTML = games.length === 0
      ? '<p class="empty-msg">No hay juegos que mostrar con estos filtros.</p>'
      : state.view === 'agenda' ? renderAgenda(games) : renderGrid(games);
  }

  if (focusKey) {
    content.querySelector(`button[data-id="${focusKey.id}"][data-action="${focusKey.action}"]`)?.focus();
  }
}

function renderAgenda(games) {
  const { exact, approx } = expandReleases(games);

  // Agrupar por fecha
  const byDate = new Map();
  for (const r of exact) {
    if (!byDate.has(r.dateISO)) byDate.set(r.dateISO, []);
    byDate.get(r.dateISO).push(r);
  }
  const fechas = [...byDate.keys()].sort();

  let html = '';
  for (const iso of fechas) {
    const d = new Date(iso + 'T00:00:00');
    const dow = DOW[(d.getDay() + 6) % 7];
    // Cada día en su <section>: así su cabecera (sticky) se queda arriba
    // mientras haya tarjetas de ese día y la empuja la del siguiente.
    html += `<section class="day"><div class="day-head" data-date="${iso}">${dow} · ${d.getDate()} ${MESES[d.getMonth()]}</div>`;
    html += '<div class="cards">';
    for (const r of byDate.get(iso)) html += cardHTML(r.game, r.platforms);
    html += '</div></section>';
  }

  if (approx.length) {
    html += `<section class="day"><div class="day-head">Sin fecha exacta</div><div class="cards">`;
    for (const r of approx) html += cardHTML(r.game, r.platforms, r.human);
    html += '</div></section>';
  }
  return html;
}

function cardHTML(game, platforms, humanLabel) {
  const s = statusOf(game.igdbId);
  // Todo lo que viene de IGDB se escapa: es una fuente externa editable.
  const coverInner = game.coverImageId
    ? `<img class="cover" loading="lazy" src="https://images.igdb.com/igdb/image/upload/t_cover_big/${encodeURIComponent(game.coverImageId)}.jpg" alt="">`
    : `<div class="cover placeholder">sin carátula</div>`;
  const url = safeUrl(game.url);
  const cover = url
    ? `<a class="cover-link" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" title="Ver ficha en IGDB">${coverInner}</a>`
    : coverInner;

  const plats = chipsHTML(platforms ?? game.releases[0]?.platforms);

  const label = humanLabel ? `<div class="date-approx">${escapeHtml(humanLabel)}</div>` : '';
  const hot = game.hypes >= HOT_THRESHOLD;
  const hypeBadge = `<div class="hype-badge${hot ? ' hot' : ''}">${FLAME} ${game.hypes}</div>`;
  const cardClass = (s && ESTADOS_POSITIVOS.includes(s) ? ` s-${s}` : '') + (hot ? ' hot' : '');

  return `
    <div class="card${cardClass}">
      ${cover}
      <div class="name">${escapeHtml(game.name)}</div>
      <div class="platforms">${plats}</div>
      ${label}
      ${hypeBadge}
      ${statusButtons(game)}
    </div>`;
}

function chipsHTML(platforms) {
  return (platforms ?? [])
    .map((p) => `<span class="chip ${platClass(p)}">${escapeHtml(p)}</span>`).join('');
}

// Botones de estado de un juego (tarjeta del calendario y fila de Mi lista).
// Los estados son interruptores (aria-pressed); descartar es una acción.
function statusButtons(game) {
  const s = statusOf(game.igdbId);
  const btn = (action, on, extra = '') => {
    const pressed = action === 'descartado' ? '' : ` aria-pressed="${on}"`;
    return `<button data-id="${game.igdbId}" data-action="${action}"${pressed} aria-label="${LABELS[action]}" title="${LABELS[action]}" class="${on ? 'on-' + action : ''} ${extra}">${ICONS[action]}</button>`;
  };
  return `
      <div class="actions">
        ${btn('interesado', s === 'interesado')}
        ${btn('reservado', s === 'reservado')}
        ${btn('comprado', s === 'comprado')}
        ${btn('descartado', false, 'dismiss')}
      </div>`;
}

// ------------------------------------------------------------
//  Mi lista: tus juegos de todos los meses, agrupados por estado
// ------------------------------------------------------------

function renderList() {
  const games = myIds().map(findGame).filter(Boolean);
  if (games.length === 0) {
    return '<p class="empty-msg">Aún no sigues ningún juego. Márcalo con la estrella en el calendario y aparecerá aquí.</p>';
  }

  const g = listGroups(games, statusOf, todayISO());
  const group = (title, entries, collapsed = false) => {
    if (!entries.length) return '';
    const head = `${escapeHtml(title)} <span class="count">${entries.length}</span>`;
    const rows = `<div class="rows">${entries.map(listRowHTML).join('')}</div>`;
    return collapsed
      ? `<details class="day"><summary class="day-head">${head}</summary>${rows}</details>`
      : `<section class="day"><div class="day-head">${head}</div>${rows}</section>`;
  };

  return group('Me interesa · ya a la venta', g.released)
    + group('Me interesa · próximamente', g.upcoming)
    + group('Reservado', g.reserved)
    + group('Comprado', g.bought, true);
}

function listRowHTML({ game, dateISO, label, platforms }) {
  const s = statusOf(game.igdbId);
  const cover = game.coverImageId
    ? `<img class="row-cover" loading="lazy" src="https://images.igdb.com/igdb/image/upload/t_cover_small/${encodeURIComponent(game.coverImageId)}.jpg" alt="">`
    : '<div class="row-cover placeholder"></div>';
  const url = safeUrl(game.url);
  const name = url
    ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(game.name)}</a>`
    : escapeHtml(game.name);
  let when = escapeHtml(label ?? 'Sin fecha');
  if (dateISO) {
    const d = new Date(dateISO + 'T00:00:00');
    when = `${d.getDate()} ${MESES[d.getMonth()].slice(0, 3)} ${d.getFullYear()}`;
  }
  return `
    <div class="row s-${s}">
      ${cover}
      <div class="row-main">
        <div class="name">${name}</div>
        <div class="row-meta"><span class="when">${when}</span>${chipsHTML(platforms)}</div>
      </div>
      ${statusButtons(game)}
    </div>`;
}

function renderGrid(games) {
  const { exact, approx } = expandReleases(games);

  // Mapa día-del-mes -> juegos
  const byDay = new Map();
  for (const r of exact) {
    const d = new Date(r.dateISO + 'T00:00:00');
    if (d.getMonth() !== state.date.getMonth()) continue;
    const day = d.getDate();
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(r.game);
  }

  const year = state.date.getFullYear();
  const month = state.date.getMonth();
  const firstDow = (new Date(year, month, 1).getDay() + 6) % 7; // lunes = 0
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  const now = new Date();
  const todayDay = now.getFullYear() === year && now.getMonth() === month ? now.getDate() : null;

  let html = '<div class="grid">';
  for (const d of DOW) html += `<div class="dow">${d}</div>`;
  for (let i = 0; i < firstDow; i++) html += '<div class="cell empty"></div>';

  for (let day = 1; day <= daysInMonth; day++) {
    const list = byDay.get(day) ?? [];
    let mini = '';
    for (const g of list.slice(0, 3)) {
      if (g.hypes >= HOT_THRESHOLD) mini += `<span class="hot">${FLAME} ${escapeHtml(g.name)}</span>`;
      else mini += `<span>${escapeHtml(g.name)}</span>`;
    }
    const more = list.length > 3 ? `<div class="more">+${list.length - 3} más</div>` : '';
    const today = day === todayDay ? ' today" aria-current="date' : '';
    if (!list.length) {
      html += `<div class="cell${today}"><div class="num">${day}</div></div>`;
      continue;
    }
    // Los días con juegos son botones: llevan a ese día en la Agenda.
    // En móvil no caben nombres, así que se ve solo el número de juegos.
    const iso = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const hot = list.some((g) => g.hypes >= HOT_THRESHOLD);
    const label = `${day} de ${MESES[month]}: ${list.length} ${list.length === 1 ? 'juego' : 'juegos'}`;
    html += `<button type="button" class="cell has-games${today}" data-goto="${iso}" aria-label="${label}">`
      + `<div class="num">${day}</div><div class="mini">${mini}</div>${more}`
      + `<div class="count${hot ? ' hot' : ''}">${hot ? FLAME : ''}${list.length}</div></button>`;
  }
  html += '</div>';

  if (approx.length) {
    html += `<p class="approx">${approx.length} juego(s) este mes sin fecha exacta (míralos en la vista de agenda).</p>`;
  }
  return html;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Solo aceptamos enlaces http(s): evita cosas como "javascript:..." en el href.
function safeUrl(url) {
  return typeof url === 'string' && /^https?:\/\//i.test(url) ? url : null;
}

// ============================================================
//  MUTACIONES (clic en los botones de estado)
// ============================================================

document.getElementById('content').addEventListener('click', async (e) => {
  // Día de la vista Mes -> ese día en la Agenda
  const cell = e.target.closest('[data-goto]');
  if (cell) {
    state.view = 'agenda';
    setPressed('[data-view]', document.querySelector('[data-view="agenda"]'));
    render();
    scrollToDay(cell.dataset.goto, 'auto');
    return;
  }

  const btn = e.target.closest('button[data-action]');
  if (!btn) return;

  const igdbId = Number(btn.dataset.id);
  const action = btn.dataset.action;
  const game = findGame(igdbId);
  if (!game) return;

  const prev = statusOf(igdbId);

  if (action === 'descartado') {
    const ok = await changeStatus(game, 'descartado');
    // Deshacer devuelve el juego al estado que tenía (p. ej. 'reservado'),
    // no solo lo "des-descarta".
    if (ok) showToast(`"${game.name}" descartado`, () => changeStatus(game, prev));
  } else {
    // Clic en el estado ya activo => lo quito
    await changeStatus(game, prev === action ? null : action);
  }
});

// Cambia el estado de un juego (null = sin estado). Es optimista de verdad:
// pinta al instante y guarda después. Si el guardado falla, vuelve atrás
// y avisa. Devuelve true si se guardó.
async function changeStatus(game, status) {
  const prev = statusOf(game.igdbId);
  setLocalStatus(game, status);
  render();

  const { error } = status ? await saveStatus(game, status) : await deleteStatus(game);
  if (!error) return true;

  console.error('Error al guardar estado:', error);
  // Solo revertimos si nadie ha vuelto a cambiar el juego mientras tanto.
  if (statusOf(game.igdbId) === status) {
    setLocalStatus(game, prev);
    render();
  }
  showToast('No se pudo guardar el cambio. Inténtalo de nuevo.');
  return false;
}

function setLocalStatus(game, status) {
  if (status) trackedMap.set(game.igdbId, { status, name: game.name, coverImageId: game.coverImageId });
  else trackedMap.delete(game.igdbId);
}

function saveStatus(game, status) {
  return db.from('tracked_games').upsert({
    user_id: currentUserId,
    igdb_game_id: game.igdbId,
    status,
    game_name: game.name,
    cover_image_id: game.coverImageId,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'user_id,igdb_game_id' });
}

function deleteStatus(game) {
  return db.from('tracked_games')
    .delete()
    .eq('user_id', currentUserId)
    .eq('igdb_game_id', game.igdbId);
}

// ============================================================
//  AVISOS (deshacer tras descartar, errores al guardar)
// ============================================================

// Muestra un aviso temporal. Si se pasa onUndo, aparece el botón "Deshacer".
function showToast(text, onUndo) {
  const toast = document.getElementById('undo');
  const btn = document.getElementById('undo-btn');
  document.getElementById('undo-text').textContent = text;
  btn.classList.toggle('hidden', !onUndo);
  btn.onclick = onUndo
    ? () => { toast.classList.add('hidden'); onUndo(); }
    : null;
  toast.classList.remove('hidden');
  clearTimeout(undoTimer);
  undoTimer = setTimeout(() => toast.classList.add('hidden'), 6000);
}

// ============================================================
//  CONTROLES DE LA CABECERA
// ============================================================

// Cambia de mes sin salirse del rango que acepta la API.
function goToMonth(date) {
  const d = new Date(date.getFullYear(), date.getMonth(), 1);
  state.date = d < MIN_MONTH ? MIN_MONTH : d > MAX_MONTH ? MAX_MONTH : d;
  loadAll();
}

// Desactiva las flechas en los extremos del rango.
function updateMonthNav() {
  const y = state.date.getFullYear();
  const m = state.date.getMonth();
  document.getElementById('prev-month').disabled =
    y === MIN_MONTH.getFullYear() && m === MIN_MONTH.getMonth();
  document.getElementById('next-month').disabled =
    y === MAX_MONTH.getFullYear() && m === MAX_MONTH.getMonth();
}

document.getElementById('prev-month').addEventListener('click', () => {
  goToMonth(new Date(state.date.getFullYear(), state.date.getMonth() - 1, 1));
});
document.getElementById('next-month').addEventListener('click', () => {
  goToMonth(new Date(state.date.getFullYear(), state.date.getMonth() + 1, 1));
});

// Salto directo a cualquier mes con el selector
// En iOS la rueda del selector dispara "change" con cada giro, así que allí
// esperamos a que se cierre (al pulsar "Aceptar" el campo pierde el foco).
// En el resto, "change" solo llega al confirmar.
const IS_IOS = /iP(hone|ad|od)/.test(navigator.platform) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); // iPadOS
{
  const picker = document.getElementById('month-picker');
  picker.addEventListener(IS_IOS ? 'blur' : 'change', () => {
    const current = monthKey(state.date);
    if (!picker.value) { picker.value = current; return; } // "Restablecer" lo vacía
    if (picker.value === current) return;
    const [y, m] = picker.value.split('-').map(Number);
    goToMonth(new Date(y, m - 1, 1));
  });
}

// Volver al mes actual y saltar al próximo lanzamiento. Si ya está
// cargado, basta con desplazarse: no hace falta volver a pedirlo.
document.getElementById('today').addEventListener('click', () => {
  const now = new Date();
  if (monthKey(state.date) === monthKey(now) && loadedMonth === monthKey(now)) {
    if (state.view === 'agenda') scrollToNextRelease();
    else window.scrollTo({ top: 0, behavior: 'smooth' }); // la vista Mes cabe casi entera
    return;
  }
  state.date = now;
  loadAll({ jump: true });
});

// Marca el botón elegido de un grupo (visual y para lectores de pantalla)
function setPressed(selector, chosen) {
  document.querySelectorAll(selector).forEach((x) => {
    x.classList.toggle('active', x === chosen);
    x.setAttribute('aria-pressed', String(x === chosen));
  });
}

// Calendario <-> Mi lista. En la lista se ocultan los controles del
// calendario (CSS: body[data-section="list"] .calendar-only).
document.querySelectorAll('[data-section]').forEach((b) => {
  b.addEventListener('click', () => {
    if (state.section === b.dataset.section) return;
    state.section = b.dataset.section;
    document.body.dataset.section = state.section;
    setPressed('[data-section]', b);
    window.scrollTo(0, 0);
    if (state.section === 'list') {
      loadList();
    } else if (loadedMonth === monthKey(state.date)) {
      loadSeq++; // descarta una carga de la lista que siga en vuelo
      render();
    } else {
      loadAll();
    }
  });
});

document.querySelectorAll('[data-view]').forEach((b) => {
  b.addEventListener('click', () => {
    state.view = b.dataset.view;
    setPressed('[data-view]', b);
    render();
  });
});

document.querySelectorAll('[data-scope]').forEach((b) => {
  b.addEventListener('click', () => {
    state.scope = b.dataset.scope;
    setPressed('[data-scope]', b);
    render();
  });
});

// El selector solo ofrece los meses que acepta la API
{
  const picker = document.getElementById('month-picker');
  picker.min = monthKey(MIN_MONTH);
  picker.max = monthKey(MAX_MONTH);
}

// Altura real de la barra (cambia según el ancho) para que las cabeceras
// sticky se peguen justo debajo.
{
  const topbar = document.querySelector('.topbar');
  new ResizeObserver(() => {
    document.documentElement.style.setProperty('--topbar-h', `${topbar.offsetHeight}px`);
  }).observe(topbar);
}

// Móvil: la barra se esconde al bajar y vuelve al subir (CSS:
// body.topbar-hidden). Cerca del principio, o con el foco dentro (p. ej.
// el selector de mes abierto), se queda visible.
let topbarHoldUntil = 0;

// Muestra la barra y no deja esconderla durante holdMs (saltos programados).
function showTopbar(holdMs = 0) {
  document.body.classList.remove('topbar-hidden');
  topbarHoldUntil = Date.now() + holdMs;
}

{
  const topbar = document.querySelector('.topbar');
  const mobile = matchMedia('(max-width: 600px)');
  let lastY = window.scrollY;
  let ticking = false;

  const update = () => {
    ticking = false;
    const y = window.scrollY;
    const delta = y - lastY;
    if (!mobile.matches || y < topbar.offsetHeight || topbar.contains(document.activeElement)) {
      document.body.classList.remove('topbar-hidden');
    } else if (delta > 6) {
      if (Date.now() >= topbarHoldUntil) document.body.classList.add('topbar-hidden');
    } else if (delta < -6) {
      document.body.classList.remove('topbar-hidden');
    } else {
      return; // movimiento pequeño (rebote de iOS): no tocamos lastY
    }
    lastY = y;
  };

  window.addEventListener('scroll', () => {
    if (!ticking) { ticking = true; requestAnimationFrame(update); }
  }, { passive: true });
}

// Arrancar
init();
