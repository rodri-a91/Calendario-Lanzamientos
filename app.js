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

// --- Estado de la aplicación ---
const state = {
  date: new Date(),          // apunta a un día del mes mostrado
  view: 'agenda',            // 'agenda' | 'grid'
  scope: 'general',          // 'general' | 'mine'
  minHypes: 0,
};
let currentUserId = null;
let gamesById = new Map();    // igdbId -> juego (de la API)
let trackedMap = new Map();   // igdbId -> { status }
let undoTimer = null;

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

function show(which) {
  document.getElementById('login').classList.toggle('hidden', which !== 'login');
  document.getElementById('app').classList.toggle('hidden', which !== 'app');
}

function showApp() {
  show('app');
  loadAll();
}

// ============================================================
//  CARGA DE DATOS
// ============================================================

function monthKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

async function loadAll() {
  const content = document.getElementById('content');
  content.innerHTML = '<p class="empty-msg">Cargando…</p>';
  try {
    const [calendar] = await Promise.all([fetchCalendar(monthKey(state.date)), loadTracked()]);

    gamesById = new Map();
    for (const g of calendar.games) gamesById.set(g.igdbId, g);

    render();
  } catch (err) {
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
  const { data, error } = await db.from('tracked_games').select('igdb_game_id, status');
  if (error) throw error;
  trackedMap = new Map();
  for (const row of data) trackedMap.set(row.igdb_game_id, { status: row.status });
}

// ============================================================
//  FILTRADO (todo en el navegador)
// ============================================================

function statusOf(igdbId) {
  return trackedMap.get(igdbId)?.status ?? null;
}

function visibleGames() {
  const all = [...gamesById.values()];

  if (state.scope === 'mine') {
    // Solo míos: los que tengo en un estado positivo este mes.
    return all.filter((g) => ESTADOS_POSITIVOS.includes(statusOf(g.igdbId)));
  }

  // General: oculto descartados; aplico el deslizador de hype,
  // pero los juegos que sigo se muestran siempre, tengan el hype que tengan.
  return all.filter((g) => {
    const s = statusOf(g.igdbId);
    if (s === 'descartado') return false;
    if (ESTADOS_POSITIVOS.includes(s)) return true;
    return g.hypes >= state.minHypes;
  });
}

// ============================================================
//  RENDER
// ============================================================

function render() {
  // Etiquetas de la cabecera
  document.getElementById('month-label').textContent =
    `${MESES[state.date.getMonth()]} ${state.date.getFullYear()}`;
  document.getElementById('hype-out').textContent =
    state.minHypes === 0 ? 'todo' : `hype > ${state.minHypes}`;

  const games = visibleGames();
  const content = document.getElementById('content');

  if (games.length === 0) {
    content.innerHTML = '<p class="empty-msg">No hay juegos que mostrar con estos filtros.</p>';
    return;
  }

  content.innerHTML = state.view === 'agenda' ? renderAgenda(games) : renderGrid(games);
}

// Una "aparición" = un juego en una fecha concreta
function expandReleases(games) {
  const exact = [];   // { dateISO, day, game }
  const approx = [];  // { game, human }
  for (const g of games) {
    for (const rel of g.releases) {
      if (rel.precise && rel.date) {
        exact.push({ dateISO: rel.date, game: g, platforms: rel.platforms });
      } else {
        approx.push({ game: g, human: rel.human });
      }
    }
  }
  return { exact, approx };
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
    html += `<div class="day-head">${dow} · ${d.getDate()} ${MESES[d.getMonth()]}</div>`;
    html += '<div class="cards">';
    for (const r of byDate.get(iso)) html += cardHTML(r.game, r.platforms);
    html += '</div>';
  }

  if (approx.length) {
    html += `<div class="day-head">Sin fecha exacta</div><div class="cards">`;
    for (const r of approx) html += cardHTML(r.game, null, r.human);
    html += '</div>';
  }
  return html;
}

function cardHTML(game, platforms, humanLabel) {
  const s = statusOf(game.igdbId);
  const cover = game.coverImageId
    ? `<img class="cover" loading="lazy" src="https://images.igdb.com/igdb/image/upload/t_cover_big/${game.coverImageId}.jpg" alt="">`
    : `<div class="cover placeholder">sin carátula</div>`;

  const plats = (platforms ?? game.releases[0]?.platforms ?? [])
    .map((p) => `<span class="chip">${p}</span>`).join('');

  const label = humanLabel ? `<div class="hype">${humanLabel}</div>` : '';
  const cardClass = s && ESTADOS_POSITIVOS.includes(s) ? ` s-${s}` : '';

  const btn = (action, on, extra = '') =>
    `<button data-id="${game.igdbId}" data-action="${action}" aria-label="${LABELS[action]}" title="${LABELS[action]}" class="${on ? 'on-' + action : ''} ${extra}">${ICONS[action]}</button>`;

  return `
    <div class="card${cardClass}">
      ${cover}
      <div class="name">${escapeHtml(game.name)}</div>
      <div class="platforms">${plats}</div>
      ${label}
      <div class="hype">♦ ${game.hypes}</div>
      <div class="actions">
        ${btn('interesado', s === 'interesado')}
        ${btn('reservado', s === 'reservado')}
        ${btn('comprado', s === 'comprado')}
        ${btn('descartado', false, 'dismiss')}
      </div>
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

  let html = '<div class="grid">';
  for (const d of DOW) html += `<div class="dow">${d}</div>`;
  for (let i = 0; i < firstDow; i++) html += '<div class="cell empty"></div>';

  for (let day = 1; day <= daysInMonth; day++) {
    const list = byDay.get(day) ?? [];
    let mini = '';
    for (const g of list.slice(0, 3)) mini += `<span>${escapeHtml(g.name)}</span>`;
    const more = list.length > 3 ? `<div class="more">+${list.length - 3} más</div>` : '';
    html += `<div class="cell"><div class="num">${day}</div><div class="mini">${mini}</div>${more}</div>`;
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

// ============================================================
//  MUTACIONES (clic en los botones de estado)
// ============================================================

document.getElementById('content').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;

  const igdbId = Number(btn.dataset.id);
  const action = btn.dataset.action;
  const game = gamesById.get(igdbId);
  if (!game) return;

  const current = statusOf(igdbId);

  if (action === 'descartado') {
    await setStatus(game, 'descartado');
    showUndo(game);
  } else if (current === action) {
    // Clic en el estado ya activo => lo quito
    await removeStatus(game);
  } else {
    await setStatus(game, action);
  }
  render();
});

async function setStatus(game, status) {
  trackedMap.set(game.igdbId, { status }); // optimista
  const { error } = await db.from('tracked_games').upsert({
    user_id: currentUserId,
    igdb_game_id: game.igdbId,
    status,
    game_name: game.name,
    cover_image_id: game.coverImageId,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'user_id,igdb_game_id' });
  if (error) console.error('Error al guardar estado:', error);
}

async function removeStatus(game) {
  trackedMap.delete(game.igdbId);
  const { error } = await db.from('tracked_games')
    .delete()
    .eq('user_id', currentUserId)
    .eq('igdb_game_id', game.igdbId);
  if (error) console.error('Error al quitar estado:', error);
}

// ============================================================
//  DESHACER (tras descartar)
// ============================================================

function showUndo(game) {
  const undo = document.getElementById('undo');
  document.getElementById('undo-text').textContent = `"${game.name}" descartado`;
  undo.classList.remove('hidden');
  clearTimeout(undoTimer);
  undoTimer = setTimeout(() => undo.classList.add('hidden'), 6000);

  document.getElementById('undo-btn').onclick = async () => {
    await removeStatus(game);  // borrar la fila 'descartado' lo restaura
    undo.classList.add('hidden');
    render();
  };
}

// ============================================================
//  CONTROLES DE LA CABECERA
// ============================================================

document.getElementById('prev-month').addEventListener('click', () => {
  state.date = new Date(state.date.getFullYear(), state.date.getMonth() - 1, 1);
  loadAll();
});
document.getElementById('next-month').addEventListener('click', () => {
  state.date = new Date(state.date.getFullYear(), state.date.getMonth() + 1, 1);
  loadAll();
});

document.querySelectorAll('[data-view]').forEach((b) => {
  b.addEventListener('click', () => {
    state.view = b.dataset.view;
    document.querySelectorAll('[data-view]').forEach((x) => x.classList.toggle('active', x === b));
    render();
  });
});

document.querySelectorAll('[data-scope]').forEach((b) => {
  b.addEventListener('click', () => {
    state.scope = b.dataset.scope;
    document.querySelectorAll('[data-scope]').forEach((x) => x.classList.toggle('active', x === b));
    render();
  });
});

document.getElementById('hype').addEventListener('input', (e) => {
  state.minHypes = Number(e.target.value);
  render(); // filtrado instantáneo, sin tocar la red
});

// Arrancar
init();
