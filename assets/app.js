import * as S from './stats.js';
import { esc, durHTML, LEAGUE_NAME } from './card.js';

const REPO = '72-o/forest';
const DATA_PATH = 'data/db.json';
const API = `https://api.github.com/repos/${REPO}`;
const LS_TOKEN = 'forest.token';
const DAYS_PREVIEW = 20;
const HISTORY_PREVIEW = 30;

const view = document.getElementById('view');
const today = S.todayISO();

const state = {
  db: emptyDb(),
  build: null,
  loaded: false,
  loadError: null,
  sort: {},
  pendingData: null,   // blob sha of data/db.json the build has not caught up with yet
  pendingStuck: false,
  pollTimer: null,
  png: {},             // prefetched share images, keyed by scope id + data sha
  showDeleted: false,
  daysAll: false,
  historyAll: false,
  confirmDelete: null,
  playerEdit: null,    // key of the roster row being edited
  playerMsg: null,
  playerBusy: false,
  form: blankForm(),
  points: null,        // draft of the points system on the Ayarlar page
  pointsMsg: null,
};

function emptyDb() {
  return { version: 1, players: [], games: [], log: [] };
}

// rows: one per person, in ranking order, with the hours and minutes as typed.
function blankForm() {
  return { editId: null, date: today, rows: [], busy: false, msg: null };
}

// ---------- small helpers ----------

function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* storage blocked */ } }
function token() { return lsGet(LS_TOKEN); }

async function getJSON(url) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json();
}

let toastTimer;
function toast(text) {
  const el = document.getElementById('toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 4200);
}

function fmtDateTime(iso) {
  const d = new Date(iso);
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function nicks() {
  return S.nickMap(state.db);
}

function rules() {
  return S.pointRules(state.db);
}

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function b64encode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function b64decode(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
}

function userError(message) {
  return Object.assign(new Error(message), { userMessage: message });
}

// ---------- GitHub API (admin only) ----------

async function gh(path, opts = {}) {
  let r;
  try {
    r = await fetch(API + path, {
      ...opts,
      cache: 'no-store',
      headers: {
        Authorization: `Bearer ${token()}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      },
    });
  } catch {
    throw Object.assign(new Error('network'), { status: 0 });
  }
  if (!r.ok) throw Object.assign(new Error(`GitHub ${r.status}`), { status: r.status });
  return r.json();
}

async function readRemote() {
  const j = await gh(`/contents/${DATA_PATH}?ref=main`);
  return { db: { ...emptyDb(), ...JSON.parse(b64decode(j.content)) }, sha: j.sha };
}

// Applies the change to the newest file on GitHub, so two edits never overwrite each other.
async function mutate(change, messageOf) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    const { db, sha } = await readRemote();
    const info = change(db);
    const body = { message: messageOf(info), content: b64encode(S.serializeDb(db)), sha, branch: 'main' };
    try {
      const r = await gh(`/contents/${DATA_PATH}`, { method: 'PUT', body: JSON.stringify(body) });
      state.db = db;
      waitForBuild(r.content.sha);
      return info;
    } catch (e) {
      lastErr = e;
      if (e.status === 409 || e.status === 422) continue;
      throw e;
    }
  }
  throw lastErr;
}

function errorText(e) {
  if (e.userMessage) return e.userMessage;
  switch (e.status) {
    case 0: return 'Bağlantı kurulamadı. İnternetini kontrol edip tekrar dene.';
    case 401: return 'Anahtar geçersiz ya da süresi dolmuş. Yardım sekmesindeki adımlarla yeni bir anahtar oluştur.';
    case 403: return 'Anahtarın yazma izni yok. Anahtarda "Contents: Read and write" izni olmalı.';
    case 404: return 'Anahtar bu repoya erişemiyor. Anahtarı oluştururken 72-o/forest reposunu seçtiğinden emin ol.';
    case 409: case 422: return 'Aynı anda başka bir değişiklik yapıldı. Sayfayı yenileyip tekrar dene.';
    default: return `Kaydedilemedi (${e.message}). Tekrar dene.`;
  }
}

// ---------- build polling ----------

function waitForBuild(dataSha) {
  state.pendingData = dataSha;
  state.pendingStuck = false;
  clearTimeout(state.pollTimer);
  let tries = 0;
  const tick = async () => {
    tries++;
    const b = await getJSON(`build.json?t=${Date.now()}`).catch(() => null);
    if (b && b.dataSha === state.pendingData) {
      state.build = b;
      state.pendingData = null;
      if (!isTyping()) render();
      return;
    }
    if (tries < 60) state.pollTimer = setTimeout(tick, 10000);
    else { state.pendingStuck = true; if (!isTyping()) render(); }
  };
  state.pollTimer = setTimeout(tick, 12000);
}

function isTyping() {
  const el = document.activeElement;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && view.contains(el);
}

// When the admin opens the site, prefer the newest data on GitHub over the deployed copy.
async function syncAdmin() {
  if (!token()) return;
  try {
    const { db, sha } = await readRemote();
    if (!state.build || state.build.dataSha !== sha) {
      state.db = db;
      waitForBuild(sha);
      render();
    }
  } catch { /* the deployed copy is still fine to show */ }
}

// ---------- routing ----------

function currentRoute() {
  return decodeURIComponent(location.hash.slice(1)) || 'ana';
}

function render() {
  const route = currentRoute();
  renderNav(route);
  if (!state.loaded) return;
  if (state.loadError) {
    view.innerHTML = `<div class="empty"><strong>Veri yüklenemedi</strong>Sayfayı yenilemeyi dene.</div>`;
    return;
  }
  if (route === 'yeni') return renderYeni();
  if (route === 'yardim') return renderYardim();
  if (route === 'gunler') return renderGunler();
  if (route === 'ayarlar') return renderAyarlar();
  const scope = S.findScope(state.db, route, today);
  if (!scope) {
    view.innerHTML = `<div class="empty"><strong>Sayfa bulunamadı</strong><a href="#ana">Ana Tablo'ya dön</a></div>`;
    return;
  }
  renderBoard(scope);
}

function renderNav(route) {
  const scopes = S.scopeList(state.db, today).filter(s => s.type === 'lig');
  const onLig = route.startsWith('lig-');
  document.querySelectorAll('.tab').forEach(t => {
    const tab = t.dataset.tab;
    t.classList.toggle('active', tab === route || (tab === 'lig' && onLig));
  });
  // On phones the tab row scrolls sideways; keep the active tab in view.
  const tabsEl = document.querySelector('.tabs');
  const activeTab = tabsEl.querySelector('.tab.active');
  if (activeTab && tabsEl.scrollWidth > tabsEl.clientWidth) {
    const a = activeTab.getBoundingClientRect(), t = tabsEl.getBoundingClientRect();
    if (a.left < t.left || a.right > t.right) tabsEl.scrollLeft += a.left - t.left - (t.width - a.width) / 2;
  }
  const current = scopes.find(s => s.id === route);
  document.getElementById('lig-btn-label').textContent = current ? current.label : 'Ligler';
  document.getElementById('lig-menu').innerHTML = scopes.map(s =>
    `<a href="#${s.id}" class="${s.id === route ? 'active' : ''}">${esc(s.label)}${s.current ? '<small>güncel</small>' : ''}</a>`).join('');
}

function setMenu(open) {
  document.getElementById('lig-menu').hidden = !open;
  document.getElementById('lig-btn').setAttribute('aria-expanded', String(open));
}

document.getElementById('lig-btn').addEventListener('click', e => {
  e.stopPropagation();
  setMenu(document.getElementById('lig-menu').hidden);
});
document.addEventListener('click', () => setMenu(false));
document.addEventListener('keydown', e => { if (e.key === 'Escape') setMenu(false); });
window.addEventListener('hashchange', () => {
  setMenu(false);
  state.confirmDelete = null;
  state.points = null;
  state.pointsMsg = null;
  render();
  window.scrollTo(0, 0);
});

// ---------- board pages ----------

const COLS = [
  { key: 'points', label: 'Puan', cell: p => p.points },
  { key: 'minutes', label: 'Toplam süre', cell: p => durHTML(p.minutes) },
  { key: 'perDay', label: 'Gün başına', cell: p => durHTML(p.perDay) },
];
const SORT_LABEL = { name: 'isim', points: 'puan', minutes: 'toplam süre', perDay: 'gün başına süre' };

function sortOf(scope) {
  return state.sort[scope.id] || { key: S.DEFAULT_SORT, dir: 'desc' };
}

function boardTable(players, scope) {
  const sort = sortOf(scope);
  const aria = key => (sort.key === key ? ` aria-sort="${sort.dir === 'asc' ? 'ascending' : 'descending'}"` : '');
  const head = `<tr>
      <th class="name" scope="col"${aria('name')}><span class="rk">#</span><button type="button" data-sort="name">İsim</button></th>
      ${COLS.map(c => `<th scope="col"${aria(c.key)}><button type="button" data-sort="${c.key}">${c.label}</button></th>`).join('')}
    </tr>`;
  const rows = players.map((p, i) => `<tr class="${i === 0 ? 'lead' : ''}">
      <td class="name"><span class="rk${i < 3 ? ` r${i + 1}` : ''}">${i + 1}</span>${esc(p.name)}</td>
      ${COLS.map(c => `<td class="${c.key === sort.key ? 'key' : ''}">${c.cell(p)}</td>`).join('')}
    </tr>`).join('');
  return `<div class="table-wrap"><table class="board"><thead>${head}</thead><tbody>${rows}</tbody></table></div>`;
}

function fileBase(scope) {
  return scope.type === 'ana' ? 'forest-ligi-ana-tablo' : `forest-ligi-${scope.key}`;
}

function renderBoard(scope) {
  const games = S.gamesFor(state.db, scope);
  const board = S.buildBoard(games, scope, nicks(), rules());
  const sort = sortOf(scope);
  const isAna = scope.type === 'ana';
  const players = S.sortPlayers(board.players, sort.key, sort.dir);
  const eyebrow = isAna ? 'Tüm zamanlar' : `${scope.current ? 'Güncel lig' : 'Geçmiş lig'} · ${S.ligRange(scope.key)}`;
  const title = isAna ? 'Ana Tablo' : scope.label;

  const hero = `<section class="hero">
      <div><p class="eyebrow">${eyebrow}</p><h1>${esc(title)}</h1></div>
      <dl class="kpis">
        <div><dt>Gün</dt><dd>${board.dayCount}</dd></div>
        <div><dt>Kişi</dt><dd>${board.playerCount}</dd></div>
        ${board.last ? `<div><dt>Son gün</dt><dd class="date">${S.formatDate(board.last.date)}</dd></div>` : ''}
      </dl>
    </section>`;

  if (!board.dayCount) {
    view.innerHTML = `${hero}<div class="empty"><strong>Henüz kayıt yok</strong>
      ${isAna ? 'İlk gün kaydedildiğinde tablo burada oluşur.' : 'Bu ligin ilk günü kaydedildiğinde tablo burada oluşur.'}
      <br><a href="#yeni">Yeni Veri sekmesine git</a></div>`;
    return;
  }

  const last = `<section class="last"><span class="last-label">Son gün · ${S.formatDate(board.last.date)}</span>
      <ol>${board.last.players.map((n, i) => `<li><b>${i + 1}</b>${esc(n)} ${durHTML(board.last.minutes[i])}</li>`).join('')}</ol></section>`;

  const sortedNote = sort.key === S.DEFAULT_SORT && sort.dir === 'desc'
    ? 'Sıralama: puan · başka bir sütuna göre sıralamak için başlığına dokun'
    : `Sıralama: ${SORT_LABEL[sort.key]} · <button type="button" class="link" data-act="reset-sort">puana dön</button>`;

  view.innerHTML = `${hero}${last}${sharePanel(scope)}
    <div class="toolbar"><p class="sorted">${sortedNote}</p></div>
    ${boardTable(players, scope)}`;

  view.querySelectorAll('[data-sort]').forEach(b => b.addEventListener('click', () => {
    const key = b.dataset.sort;
    const cur = sortOf(scope);
    const dir = cur.key === key ? (cur.dir === 'desc' ? 'asc' : 'desc') : key === 'name' ? 'asc' : 'desc';
    state.sort[scope.id] = { key, dir };
    render();
  }));
  view.querySelector('[data-act="reset-sort"]')?.addEventListener('click', () => { delete state.sort[scope.id]; render(); });
  bindShare(scope, games);
}

function sharePanel(scope) {
  const b = state.build;
  const has = !!b?.images?.includes(scope.id);
  const pending = !!state.pendingData;
  const ready = has && !pending;
  const src = has ? `out/${scope.id}.png?v=${b.dataSha.slice(0, 10)}` : '';
  let status;
  if (pending && state.pendingStuck) {
    status = `Görsel uzun süredir güncellenmedi. <a href="https://github.com/${REPO}/actions" target="_blank" rel="noopener">GitHub'daki çalışmalara bak</a>.`;
  } else if (pending) {
    status = 'Görsel güncelleniyor, 1–2 dakika içinde hazır olur.';
  } else if (!has) {
    status = 'Bu tablonun görseli henüz yok. Bir sonraki veri girişinde üretilecek.';
  } else {
    status = `Görsel güncel · ${fmtDateTime(b.builtAt)}`;
  }
  const canShare = typeof navigator.canShare === 'function';
  return `<section class="share">
      ${has ? `<a class="thumb" href="${src}" target="_blank" rel="noopener" aria-label="Görseli tam boyut aç"><img src="${src}" alt="${esc(scope.label)} görseli"></a>`
            : `<span class="thumb empty">Görsel yok</span>`}
      <div class="share-body">
        <p class="share-status${pending && !state.pendingStuck ? ' busy' : ''}">${status}</p>
        <div class="share-actions">
          <a class="btn${ready ? ' primary' : ''}" ${ready ? `href="${src}" download="${fileBase(scope)}.png"` : 'aria-disabled="true"'}>Görseli indir</a>
          <button type="button" class="btn" data-act="csv">CSV indir</button>
          ${canShare ? `<button type="button" class="btn" data-act="share">Paylaş</button>` : ''}
        </div>
      </div>
    </section>`;
}

function bindShare(scope, games) {
  const csvName = `${fileBase(scope)}.csv`;
  const csv = () => S.gamesCsv(games, nicks(), rules());
  view.querySelector('[data-act="csv"]')?.addEventListener('click', () => download(csvName, csv(), 'text/csv;charset=utf-8'));

  const b = state.build;
  const ready = b?.images?.includes(scope.id) && !state.pendingData;
  const pngKey = ready ? `${scope.id}@${b.dataSha}` : null;
  // Prefetch the image so the share sheet opens straight from the tap (iOS requires that).
  if (pngKey && !state.png[pngKey]) {
    state.png[pngKey] = 'loading';
    fetch(`out/${scope.id}.png?v=${b.dataSha.slice(0, 10)}`)
      .then(r => (r.ok ? r.blob() : Promise.reject()))
      .then(blob => { state.png[pngKey] = new File([blob], `${fileBase(scope)}.png`, { type: 'image/png' }); })
      .catch(() => { delete state.png[pngKey]; });
  }

  view.querySelector('[data-act="share"]')?.addEventListener('click', () => {
    const files = [];
    const png = pngKey && state.png[pngKey];
    if (png instanceof File) files.push(png);
    files.push(new File([csv()], csvName, { type: 'text/csv' }));
    let data = { files, title: `${LEAGUE_NAME} · ${scope.label}` };
    if (!navigator.canShare(data)) data = { files: files.filter(f => f.type === 'image/png') };
    if (!data.files.length || !navigator.canShare(data)) {
      toast(ready ? 'Bu cihaz dosya paylaşmayı desteklemiyor. İndir butonlarını kullan.' : 'Görsel hazır olunca paylaşabilirsin.');
      return;
    }
    navigator.share(data).catch(e => { if (e.name !== 'AbortError') toast('Paylaşılamadı. İndir butonlarını kullan.'); });
  });
}

// ---------- Yeni Veri ----------

function renderYeni() {
  const admin = !!token();
  view.innerHTML = `<section class="page-head">
      <p class="eyebrow">Veri</p><h1>Yeni Veri</h1>
      <p class="lede">Önce üyeleri ekle, sonra her gün için kimin ne kadar çalıştığını kaydet. Ana Tablo ve ilgili lig hemen güncellenir, görseller 1–2 dakika içinde hazır olur.</p>
    </section>
    ${admin ? '' : tokenHTML()}
    ${playersHTML(admin)}
    ${admin ? entryHTML() : ''}
    ${daysHTML(admin)}
    ${historyHTML()}
    ${admin ? `<p class="token-line">Yönetici anahtarı bu tarayıcıda kayıtlı. <button type="button" class="link" data-act="forget-token">Anahtarı bu cihazdan kaldır</button></p>` : ''}`;
  if (admin) {
    bindPlayers();
    bindEntry();
    view.querySelector('[data-act="forget-token"]').addEventListener('click', () => {
      lsSet(LS_TOKEN, null);
      toast('Anahtar bu cihazdan kaldırıldı.');
      render();
    });
  } else {
    bindToken();
  }
  bindDays(admin);
}

function tokenHTML() {
  return `<section class="panel">
      <h2>Yönetici anahtarı</h2>
      <p class="dim" style="margin:10px 0 0">Üye ve gün eklemek için bu cihazda bir kez yönetici anahtarını girmen gerekiyor. Anahtar sadece bu tarayıcıda saklanır. Nasıl alınacağı <a href="#yardim">Yardım</a> sekmesinde anlatılıyor.</p>
      <form class="token-form" id="token-form">
        <input type="password" id="t-input" autocomplete="off" spellcheck="false" placeholder="github_pat_…" aria-label="Yönetici anahtarı">
        <button class="btn primary" type="submit" id="t-save">Anahtarı kaydet</button>
      </form>
      <div id="t-msg"></div>
    </section>`;
}

function bindToken() {
  document.getElementById('token-form').addEventListener('submit', async e => {
    e.preventDefault();
    const val = document.getElementById('t-input').value.trim();
    if (!val) return;
    const btn = document.getElementById('t-save');
    btn.disabled = true;
    lsSet(LS_TOKEN, val);
    try {
      await readRemote();
      toast('Anahtar kaydedildi.');
      render();
      syncAdmin();
    } catch (err) {
      lsSet(LS_TOKEN, null);
      document.getElementById('t-msg').innerHTML = `<p class="msg err">${esc(errorText(err))}</p>`;
      btn.disabled = false;
    }
  });
}

// ----- members (roster and nicknames) -----

function rosterSorted() {
  return S.playerList(state.db).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'tr'));
}

// Returns an error message, or null when the name/nick pair can be saved.
function validatePlayer(db, name, nick, selfKey) {
  const roster = S.playerList(db).filter(p => p.key !== selfKey);
  const nameK = S.nameKey(name);
  const nickK = S.nameKey(nick);
  if (!nameK) return 'İsim boş olamaz.';
  if (name.length > 30) return 'İsim en fazla 30 karakter olabilir.';
  if (nick.length > 24) return 'Nick en fazla 24 karakter olabilir.';
  const sameName = roster.find(p => p.key === nameK);
  if (sameName) return `"${sameName.name}" adında bir üye zaten var.`;
  if (nickK) {
    const clash = roster.find(p => S.nameKey(p.nick) === nickK || p.key === nickK);
    if (clash) return `"${nick}" zaten ${clash.name} için kullanılıyor.`;
  }
  return null;
}

function playersHTML(admin) {
  const roster = rosterSorted();
  const msg = state.playerMsg ? `<p class="msg ${state.playerMsg.ok ? 'ok' : 'err'}">${esc(state.playerMsg.text)}</p>` : '';
  const rows = roster.map(p => {
    if (admin && state.playerEdit === p.key) {
      return `<tr class="editing-row">
          <td><input type="text" id="pe-name" value="${esc(p.name)}" maxlength="30" aria-label="İsim"${p.count ? ' disabled title="Kaydı olan üyenin ismi değiştirilemez"' : ''}></td>
          <td><input type="text" id="pe-nick" value="${esc(p.nick)}" maxlength="24" placeholder="Nick" aria-label="Nick"></td>
          <td class="num">${p.count}</td>
          <td><span class="acts"><button type="button" class="btn small primary" data-p-save="${esc(p.key)}">Kaydet</button>
            <button type="button" class="btn small" data-p-cancel>Vazgeç</button></span></td>
        </tr>`;
    }
    const acts = admin
      ? `<td><span class="acts"><button type="button" class="btn small" data-p-edit="${esc(p.key)}">Düzenle</button>
          ${p.count === 0 && p.registered ? `<button type="button" class="btn small" data-p-del="${esc(p.key)}">Sil</button>` : ''}</span></td>`
      : '';
    return `<tr><td class="pname">${esc(p.name)}</td><td class="pnick">${p.nick ? esc(p.nick) : '<span class="dim">–</span>'}</td><td class="num">${p.count}</td>${acts}</tr>`;
  }).join('');
  return `<section class="block" id="players">
      <div class="block-head"><h2>Üyeler</h2><span class="dim">${roster.length} üye</span></div>
      <p class="dim" style="margin:0">Tablolarda ve görsellerde nick görünür, nick boşsa isim görünür. Gerçek adıyla görünmek isteyenin nick kısmı boş kalabilir.</p>
      ${admin ? `<form class="add-row" id="p-add">
          <input type="text" id="p-name" maxlength="30" placeholder="İsim" aria-label="Yeni üyenin ismi" autocapitalize="words">
          <input type="text" id="p-nick" maxlength="24" placeholder="Nick (isteğe bağlı)" aria-label="Yeni üyenin nicki">
          <button type="submit" class="btn primary" id="p-add-btn"${state.playerBusy ? ' disabled' : ''}>Üye ekle</button>
        </form>` : ''}
      <div id="p-msg">${msg}</div>
      ${roster.length ? `<div class="table-wrap"><table class="players">
          <thead><tr><th>İsim</th><th>Nick</th><th>Gün</th>${admin ? '<th></th>' : ''}</tr></thead>
          <tbody>${rows}</tbody></table></div>`
        : `<div class="empty" style="margin-top:0">Henüz üye yok.${admin ? ' Yukarıdan ilk üyeyi ekle.' : ''}</div>`}
    </section>`;
}

async function playerChange(change, message, success) {
  state.playerBusy = true;
  view.querySelectorAll('#players .btn').forEach(b => { b.disabled = true; });
  try {
    await mutate(change, () => message);
    state.playerMsg = { ok: true, text: success };
    state.playerEdit = null;
  } catch (e) {
    state.playerMsg = { ok: false, text: errorText(e) };
  }
  state.playerBusy = false;
  render();
}

function bindPlayers() {
  document.getElementById('p-add').addEventListener('submit', e => {
    e.preventDefault();
    const name = S.cleanName(document.getElementById('p-name').value);
    const nick = S.cleanName(document.getElementById('p-nick').value);
    const err = validatePlayer(state.db, name, nick, null);
    if (err) {
      document.getElementById('p-msg').innerHTML = `<p class="msg err">${esc(err)}</p>`;
      return;
    }
    playerChange(db => {
      const again = validatePlayer(db, name, nick, null);
      if (again) throw userError(again);
      db.players.push(nick ? { name, nick } : { name });
      db.log.push({ at: new Date().toISOString(), action: 'player-add', after: { name, nick } });
    }, `Üye eklendi: ${name}`, `${name} eklendi.`);
  });

  view.querySelectorAll('[data-p-edit]').forEach(b => b.addEventListener('click', () => {
    state.playerEdit = b.dataset.pEdit;
    state.playerMsg = null;
    render();
    document.getElementById('pe-nick')?.focus();
  }));
  view.querySelector('[data-p-cancel]')?.addEventListener('click', () => { state.playerEdit = null; render(); });

  view.querySelector('[data-p-save]')?.addEventListener('click', e => {
    const key = e.currentTarget.dataset.pSave;
    const current = S.playerList(state.db).find(p => p.key === key);
    if (!current) return;
    const nameEl = document.getElementById('pe-name');
    const name = current.count ? current.name : S.cleanName(nameEl.value);
    const nick = S.cleanName(document.getElementById('pe-nick').value);
    if (name === current.name && nick === current.nick) { state.playerEdit = null; render(); return; }
    const err = validatePlayer(state.db, name, nick, key);
    if (err) {
      document.getElementById('p-msg').innerHTML = `<p class="msg err">${esc(err)}</p>`;
      return;
    }
    playerChange(db => {
      const fresh = S.playerList(db).find(p => p.key === key);
      if (!fresh) throw userError('Üye bulunamadı. Sayfayı yenile.');
      const newName = fresh.count ? fresh.name : name;
      const again = validatePlayer(db, newName, nick, key);
      if (again) throw userError(again);
      let entry = db.players.find(p => S.nameKey(p.name) === key);
      if (!entry) { entry = { name: fresh.name }; db.players.push(entry); }
      entry.name = newName;
      if (nick) entry.nick = nick; else delete entry.nick;
      db.log.push({ at: new Date().toISOString(), action: 'player-edit', before: { name: fresh.name, nick: fresh.nick }, after: { name: newName, nick } });
    }, `Üye düzeltildi: ${current.name}`, `${name} güncellendi.`);
  });

  view.querySelectorAll('[data-p-del]').forEach(b => b.addEventListener('click', () => {
    const key = b.dataset.pDel;
    const p = S.playerList(state.db).find(x => x.key === key);
    if (!p) return;
    playerChange(db => {
      const fresh = S.playerList(db).find(x => x.key === key);
      if (!fresh) throw userError('Üye bulunamadı. Sayfayı yenile.');
      if (fresh.count) throw userError('Kaydı olan üye silinemez.');
      db.players = db.players.filter(x => S.nameKey(x.name) !== key);
      db.log.push({ at: new Date().toISOString(), action: 'player-delete', before: { name: fresh.name, nick: fresh.nick } });
    }, `Üye silindi: ${p.name}`, `${p.name} silindi.`);
  }));
}

// ----- day entry -----
// The form keeps one row per person with the hours and minutes exactly as typed. The ranking is
// never entered by hand: it is the rows sorted by time worked, longest first. Only people with
// exactly the same time can be swapped.

let sortTimer;

// Minutes typed into a row: null while both boxes are empty, NaN when it is not a whole number.
function rowMinutes(r) {
  const h = r.h.trim();
  const m = r.m.trim();
  if (!h && !m) return null;
  if (!/^\d*$/.test(h) || !/^\d*$/.test(m)) return NaN;
  return Number(h || 0) * 60 + Number(m || 0);
}

function sortedRows() {
  const val = r => { const m = rowMinutes(r); return Number.isFinite(m) && m !== null ? m : -1; };
  return state.form.rows.map((r, i) => ({ r, i })).sort((a, b) => val(b.r) - val(a.r) || a.i - b.i).map(x => x.r);
}

function sameTime(a, b) {
  const x = rowMinutes(a);
  return x !== null && Number.isFinite(x) && x === rowMinutes(b);
}

function analyzeDay() {
  const f = state.form;
  const rl = rules();
  const errors = [];
  const warnings = [];
  if (!S.isValidISODate(f.date)) errors.push('Geçerli bir tarih seç.');
  else if (f.date > today) errors.push('Gelecekteki bir tarih seçilemez.');
  else {
    const same = (state.db.games || []).find(g => !g.deleted && g.date === f.date && g.id !== f.editId);
    if (same) errors.push(`${S.formatDate(f.date)} zaten kayıtlı. Aşağıdaki listeden "Düzelt" ile değiştirebilirsin.`);
  }
  if (!f.rows.length) errors.push('En az bir kişi seç.');

  const missing = [];
  for (const r of f.rows) {
    const m = rowMinutes(r);
    if (m === null) missing.push(r.name);
    else if (!Number.isFinite(m)) errors.push(`${r.name}: süre sadece rakam olmalı.`);
    else if (m === 0) errors.push(`${r.name}: süre 0 olamaz. Çalışmadıysa listeden çıkar.`);
    else if (m > S.MAX_DAY_MINUTES) errors.push(`${r.name}: bir gün 24 saatten uzun olamaz.`);
  }
  if (missing.length) errors.push(`Süre gir: ${missing.join(', ')}.`);

  const order = sortedRows();
  order.forEach((r, i) => {
    const next = order[i + 1];
    if (next && sameTime(r, next) && S.pointsFor(i + 1, rl) !== S.pointsFor(i + 2, rl)) {
      warnings.push(`${r.name} ve ${next.name} aynı süreyi çalışmış. Üstteki önde sayılır; ↑ ↓ ile değiştirebilirsin.`);
    }
  });

  if (f.editId && !errors.length) {
    const g = state.db.games.find(x => x.id === f.editId);
    const same = g && g.date === f.date && g.players.length === order.length
      && order.every((r, i) => r.name === g.players[i] && rowMinutes(r) === S.minutesOf(g, i));
    if (same) errors.push('Henüz bir değişiklik yapmadın.');
  }
  return { errors, warnings };
}

function entryHTML() {
  const f = state.form;
  const msg = f.msg ? `<p class="msg ${f.msg.ok ? 'ok' : 'err'}">${f.msg.html}</p>` : '';
  return `<section class="block" id="entry">
      <div class="block-head"><h2>${f.editId ? `${S.formatDate(editingDate())} düzenleniyor` : 'Gün kaydet'}</h2>
        ${f.editId ? '<button type="button" class="btn small" data-act="cancel-edit">Düzenlemeden çık</button>' : ''}</div>
      <div class="panel">
        <div class="entry-grid">
          <div>
            <div class="field">
              <label for="f-date">Tarih</label>
              <input type="date" id="f-date" value="${esc(f.date)}" max="${today}">
            </div>
            <div class="field">
              <span class="label">Üyeler <span class="hint">· o gün çalışanlara dokun</span></span>
              <div class="chips" id="f-chips"></div>
            </div>
          </div>
          <div>
            <span class="label">Çalışma süreleri <span class="hint">· en çok çalışan 1. olur</span></span>
            <ol class="ranking" id="f-rank"></ol>
            <ul class="issues" id="f-issues"></ul>
            <div class="save-row">
              <button type="button" class="btn primary" id="f-save">${f.editId ? 'Değişikliği kaydet' : 'Günü kaydet'}</button>
              <button type="button" class="btn" data-act="clear-rows">Listeyi temizle</button>
            </div>
            <div id="f-msg">${msg}</div>
          </div>
        </div>
      </div>
    </section>`;
}

function editingDate() {
  return state.db.games.find(g => g.id === state.form.editId)?.date || state.form.date;
}

function nameLabel(name) {
  const nick = nicks()[S.nameKey(name)];
  return nick ? `${esc(nick)} <small>${esc(name)}</small>` : esc(name);
}

function bindEntry() {
  const f = state.form;
  const touched = () => { f.msg = null; document.getElementById('f-msg').innerHTML = ''; };
  const dateEl = document.getElementById('f-date');
  dateEl.addEventListener('input', () => { f.date = dateEl.value; touched(); refreshEntry(); });
  document.getElementById('f-save').addEventListener('click', saveDay);
  view.querySelector('[data-act="clear-rows"]').addEventListener('click', () => { f.rows = []; touched(); drawEntry(); });
  view.querySelector('[data-act="cancel-edit"]')?.addEventListener('click', () => { state.form = blankForm(); render(); });

  document.getElementById('f-chips').addEventListener('click', e => {
    const chip = e.target.closest('[data-add]');
    if (!chip) return;
    const row = { name: chip.dataset.add, h: '', m: '' };
    f.rows.push(row);
    touched();
    drawEntry();
    document.querySelector(`#f-rank [data-h="${f.rows.indexOf(row)}"]`)?.focus();
  });

  const rankEl = document.getElementById('f-rank');
  rankEl.addEventListener('input', e => {
    const el = e.target;
    if (el.dataset.h !== undefined) f.rows[+el.dataset.h].h = el.value;
    else if (el.dataset.m !== undefined) f.rows[+el.dataset.m].m = el.value;
    else return;
    touched();
    refreshEntry();
  });
  rankEl.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    const swap = (i, j) => { [f.rows[i], f.rows[j]] = [f.rows[j], f.rows[i]]; };
    if (b.dataset.up !== undefined) swap(+b.dataset.up, +b.dataset.up - 1);
    else if (b.dataset.down !== undefined) swap(+b.dataset.down, +b.dataset.down + 1);
    else if (b.dataset.rm !== undefined) f.rows.splice(+b.dataset.rm, 1);
    else return;
    touched();
    drawEntry();
  });
  // Rows only move once typing has stopped and the focus has left the list, never under the cursor.
  rankEl.addEventListener('focusin', () => clearTimeout(sortTimer));
  rankEl.addEventListener('focusout', () => {
    clearTimeout(sortTimer);
    sortTimer = setTimeout(() => {
      const el = document.getElementById('f-rank');
      if (!el || el.contains(document.activeElement)) return;
      if (sortedRows().some((r, i) => r !== state.form.rows[i])) drawEntry();
    }, 250);
  });
  drawEntry();
}

// Rebuilds the chips and the sorted list. Not called while someone is typing in the list.
function drawEntry() {
  clearTimeout(sortTimer);
  const f = state.form;
  f.rows = sortedRows();
  const roster = rosterSorted();
  const used = new Set(f.rows.map(r => S.nameKey(r.name)));

  document.getElementById('f-chips').innerHTML = roster.length
    ? roster.map(p => `<button type="button" class="chip" data-add="${esc(p.name)}"${used.has(p.key) ? ' disabled' : ''}>${nameLabel(p.name)}</button>`).join('')
    : '<span class="hint">Önce yukarıdaki Üyeler bölümünden üye ekle.</span>';

  document.getElementById('f-rank').innerHTML = f.rows.length
    ? f.rows.map((r, i) => `<li>
        <span class="pl"></span>
        <span class="nm">${nameLabel(r.name)}<span class="pt"></span></span>
        <span class="durin">
          <input type="text" inputmode="numeric" maxlength="2" data-h="${i}" value="${esc(r.h)}" placeholder="0" aria-label="${esc(r.name)} saat"><span>sa</span>
          <input type="text" inputmode="numeric" maxlength="3" data-m="${i}" value="${esc(r.m)}" placeholder="0" aria-label="${esc(r.name)} dakika"><span>dk</span>
        </span>
        <span class="mv">
          ${i > 0 && sameTime(r, f.rows[i - 1]) ? `<button type="button" class="icon" data-up="${i}" aria-label="${esc(r.name)} yukarı">↑</button>` : ''}
          ${i < f.rows.length - 1 && sameTime(r, f.rows[i + 1]) ? `<button type="button" class="icon" data-down="${i}" aria-label="${esc(r.name)} aşağı">↓</button>` : ''}
          <button type="button" class="icon" data-rm="${i}" aria-label="${esc(r.name)} çıkar">✕</button>
        </span></li>`).join('')
    : '<li class="placeholder">Üyelere dokun, sonra herkesin çalışma süresini yaz. Sıralama süreye göre kendiliğinden oluşur.</li>';
  refreshEntry();
}

// Updates everything that depends on the typed values without touching the inputs themselves.
function refreshEntry() {
  const f = state.form;
  const rl = rules();
  const order = sortedRows();
  const items = document.getElementById('f-rank').children;
  f.rows.forEach((r, i) => {
    const li = items[i];
    const m = rowMinutes(r);
    const place = Number.isFinite(m) && m !== null && m > 0 ? order.indexOf(r) + 1 : 0;
    const pts = place ? S.pointsFor(place, rl) : 0;
    li.querySelector('.pl').textContent = place || '–';
    li.querySelector('.pt').textContent = pts ? `+${pts} puan` : '';
  });

  const a = analyzeDay();
  const shown = a.errors.filter(e => f.rows.length > 0 || !e.startsWith('En az'));
  document.getElementById('f-issues').innerHTML =
    shown.map(e => `<li class="err">${esc(e)}</li>`).join('') + a.warnings.map(w => `<li class="warn">${esc(w)}</li>`).join('');
  document.getElementById('f-save').disabled = f.busy || a.errors.length > 0;
}

async function saveDay() {
  const f = state.form;
  if (analyzeDay().errors.length || f.busy) return;
  const order = sortedRows();
  const players = order.map(r => r.name);
  const minutes = order.map(rowMinutes);
  const date = f.date;
  const editId = f.editId;
  f.busy = true;
  const btn = document.getElementById('f-save');
  btn.disabled = true;
  btn.textContent = 'Kaydediliyor…';
  try {
    const info = await mutate(db => {
      const roster = new Set(S.playerList(db).map(p => p.key));
      const missing = players.filter(n => !roster.has(S.nameKey(n)));
      if (missing.length) throw userError(`Üye listesinde yok: ${missing.join(', ')}. Sayfayı yenile.`);
      if (db.games.some(g => !g.deleted && g.date === date && g.id !== editId)) {
        throw userError(`${S.formatDate(date)} zaten kayıtlı. Sayfayı yenile.`);
      }
      const at = new Date().toISOString();
      if (editId) {
        const g = db.games.find(x => x.id === editId);
        if (!g) throw userError('Bu gün bulunamadı. Sayfayı yenile.');
        const before = daySnap(g);
        g.date = date;
        g.players = players;
        g.minutes = minutes;
        db.log.push({ at, action: 'edit', id: editId, before, after: { date, players, minutes } });
        return { text: 'Gün düzeltildi' };
      }
      const id = db.games.reduce((m, g) => Math.max(m, g.id), 0) + 1;
      db.games.push({ id, date, players, minutes });
      db.log.push({ at, action: 'add', id, after: { date, players, minutes } });
      return { text: 'Gün eklendi' };
    }, info => `${info.text} (${S.formatDate(date)})`);
    const key = S.ligKey(date);
    state.form = blankForm();
    state.form.msg = { ok: true, html: `${S.formatDate(date)} kaydedildi. Tablolar güncellendi, görseller 1–2 dakika içinde hazır olur. <a href="#lig-${key}">${esc(S.ligLabel(key))}</a> · <a href="#ana">Ana Tablo</a>` };
  } catch (e) {
    f.busy = false;
    f.msg = { ok: false, html: esc(errorText(e)) };
  }
  render();
  document.getElementById('entry')?.scrollIntoView({ block: 'start' });
}

// ---------- day list and history ----------

function daySnap(g) {
  return { date: g.date, players: g.players, minutes: g.players.map((_, i) => S.minutesOf(g, i)) };
}

// "1. Ayşe 5 sa 30 dk  2. Can 4 sa": works for a day and for a snapshot kept in the log.
function orderText(day, nk) {
  return day.players.map((name, i) =>
    `<span class="who"><b>${i + 1}.</b> ${esc(nk ? S.displayName(name, nk) : name)} ${durHTML(S.minutesOf(day, i))}</span>`).join(' ');
}

function daysHTML(admin) {
  const nk = nicks();
  const all = (state.db.games || [])
    .filter(g => state.showDeleted || !g.deleted)
    .slice()
    .sort((a, b) => (a.date > b.date ? -1 : a.date < b.date ? 1 : b.id - a.id));
  const days = state.daysAll ? all : all.slice(0, DAYS_PREVIEW);
  const deletedCount = (state.db.games || []).filter(g => g.deleted).length;
  const rows = days.map(g => {
    let acts = '';
    if (admin) {
      if (state.confirmDelete === g.id) {
        acts = `<span class="confirm">Silinsin mi? <button type="button" class="btn small danger" data-del-yes="${g.id}">Evet, sil</button>
          <button type="button" class="btn small" data-del-no>Vazgeç</button></span>`;
      } else if (g.deleted) {
        acts = `<span class="acts"><button type="button" class="btn small" data-restore="${g.id}">Geri al</button></span>`;
      } else {
        acts = `<span class="acts"><button type="button" class="btn small" data-edit="${g.id}">Düzelt</button>
          <button type="button" class="btn small" data-del="${g.id}">Sil</button></span>`;
      }
    }
    return `<tr class="${g.deleted ? 'deleted' : ''}">
        <td>${S.formatDate(g.date)}</td>
        <td>${esc(S.ligShort(S.ligKey(g.date)))}</td>
        <td>${g.players.length}</td>
        <td class="order">${orderText(g, nk)}${g.deleted ? ' <span class="tag dup">silindi</span>' : ''}</td>
        ${admin ? `<td>${acts}</td>` : ''}
      </tr>`;
  }).join('');
  return `<section class="block" id="days">
      <div class="block-head">
        <h2>Tüm günler</h2>
        <div class="share-actions">
          ${deletedCount ? `<label class="check"><input type="checkbox" id="g-deleted"${state.showDeleted ? ' checked' : ''}> Silinenleri göster (${deletedCount})</label>` : ''}
          <button type="button" class="btn small" data-act="csv-all"${all.length ? '' : ' disabled'}>CSV indir</button>
        </div>
      </div>
      ${all.length ? `<div class="table-wrap"><table class="games">
        <thead><tr><th>Tarih</th><th>Lig</th><th>Kişi</th><th style="text-align:left">Sıralama ve süreler</th>${admin ? '<th></th>' : ''}</tr></thead>
        <tbody>${rows}</tbody></table></div>`
        : '<div class="empty" style="margin-top:0">Henüz gün kaydedilmedi.</div>'}
      ${all.length > days.length ? `<div><button type="button" class="btn small" data-act="days-all">Tümünü göster (${all.length})</button></div>` : ''}
    </section>`;
}

const ACT = {
  add: ['add', 'Gün eklendi'], edit: ['edit', 'Gün düzeltildi'], delete: ['delete', 'Gün silindi'], restore: ['restore', 'Gün geri alındı'],
  'player-add': ['add', 'Üye eklendi'], 'player-edit': ['edit', 'Üye düzeltildi'], 'player-delete': ['delete', 'Üye silindi'],
  settings: ['edit', 'Ayar değişti'],
};

function personText(p) {
  return p ? `${esc(p.name)}${p.nick ? ` · nick: ${esc(p.nick)}` : ''}` : '';
}

function historyHTML() {
  const log = (state.db.log || []).slice().reverse();
  const list = state.historyAll ? log : log.slice(0, HISTORY_PREVIEW);
  const items = list.map(l => {
    const [cls, label] = ACT[l.action] || ['edit', l.action];
    let what;
    let detail;
    if (l.action === 'settings') {
      what = 'Puan sistemi';
      detail = `<s>${esc(S.rulesText(S.normalizePoints(l.before?.points)))}</s> → ${esc(S.rulesText(S.normalizePoints(l.after?.points)))}`;
    } else if (l.action.startsWith('player-')) {
      what = esc((l.after || l.before).name);
      detail = l.action === 'player-edit'
        ? `<s>${personText(l.before)}</s> → ${personText(l.after)}`
        : personText(l.after || l.before);
    } else {
      const snap = l.after || l.before;
      what = snap ? S.formatDate(snap.date) : '';
      detail = snap ? orderText(snap) : '';
      if (l.action === 'edit' && l.before) {
        detail = `<s>${S.formatDate(l.before.date)} · ${orderText(l.before)}</s><br>${S.formatDate(l.after.date)} · ${orderText(l.after)}`;
      }
    }
    return `<li><time datetime="${esc(l.at)}">${fmtDateTime(l.at)}</time>
        <span class="what"><span class="act ${cls}">${label}</span>${what}</span>
        <span class="detail">${detail}</span></li>`;
  }).join('');
  return `<section class="block" id="history">
      <div class="block-head"><h2>Değişiklik geçmişi</h2></div>
      <p class="dim" style="margin:0">Her ekleme, düzeltme ve silme kalıcı olarak kaydedilir. Bağımsız kanıt için
        <a href="https://github.com/${REPO}/commits/main/${DATA_PATH}" target="_blank" rel="noopener">GitHub'daki kayıtlara</a> bakılabilir.</p>
      ${log.length ? `<ol class="history">${items}</ol>` : '<div class="empty" style="margin-top:0">Henüz değişiklik yok.</div>'}
      ${log.length > list.length ? `<div><button type="button" class="btn small" data-act="history-all">Tümünü göster (${log.length})</button></div>` : ''}
    </section>`;
}

function bindDays(admin) {
  view.querySelector('#g-deleted')?.addEventListener('change', e => { state.showDeleted = e.target.checked; render(); });
  view.querySelector('[data-act="csv-all"]')?.addEventListener('click', () =>
    download('forest-ligi-tum-gunler.csv', S.gamesCsv(S.activeGames(state.db), nicks(), rules()), 'text/csv;charset=utf-8'));
  view.querySelector('[data-act="days-all"]')?.addEventListener('click', () => { state.daysAll = true; render(); });
  view.querySelector('[data-act="history-all"]')?.addEventListener('click', () => { state.historyAll = true; render(); });
  if (!admin) return;

  view.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => {
    const g = state.db.games.find(x => x.id === Number(b.dataset.edit));
    const rows = g.players.map((name, i) => {
      const min = S.minutesOf(g, i);
      return { name, h: min ? String(Math.floor(min / 60)) : '', m: min ? String(min % 60) : '' };
    });
    state.form = { ...blankForm(), editId: g.id, date: g.date, rows };
    render();
    document.getElementById('entry').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));
  view.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => { state.confirmDelete = Number(b.dataset.del); render(); }));
  view.querySelector('[data-del-no]')?.addEventListener('click', () => { state.confirmDelete = null; render(); });
  view.querySelector('[data-del-yes]')?.addEventListener('click', e => setDeleted(Number(e.currentTarget.dataset.delYes), true));
  view.querySelectorAll('[data-restore]').forEach(b => b.addEventListener('click', () => setDeleted(Number(b.dataset.restore), false)));
}

async function setDeleted(id, deleted) {
  view.querySelectorAll('.games .btn').forEach(b => { b.disabled = true; });
  try {
    const info = await mutate(db => {
      const g = db.games.find(x => x.id === id);
      if (!g) throw userError('Bu gün bulunamadı. Sayfayı yenile.');
      const day = S.formatDate(g.date);
      if (deleted) {
        g.deleted = true;
        db.log.push({ at: new Date().toISOString(), action: 'delete', id, before: daySnap(g) });
      } else {
        if (db.games.some(x => !x.deleted && x.date === g.date)) throw userError(`${day} için yeni bir kayıt var. Önce onu sil.`);
        delete g.deleted;
        db.log.push({ at: new Date().toISOString(), action: 'restore', id, after: daySnap(g) });
      }
      return { day, text: deleted ? `Gün silindi (${day})` : `Gün geri alındı (${day})` };
    }, info => info.text);
    toast(deleted ? `${info.day} silindi. "Silinenleri göster" ile geri alabilirsin.` : `${info.day} geri alındı.`);
  } catch (e) {
    toast(errorText(e));
  }
  state.confirmDelete = null;
  if (state.form.editId === id) state.form = blankForm();
  render();
}

// ---------- Günler ----------

const PLACE_CLASS = ['win', 'second', 'third'];

function renderGunler() {
  const nk = nicks();
  const rl = rules();
  const days = S.activeGames(state.db).slice().reverse();

  const head = `<section class="page-head">
      <p class="eyebrow">Geçmiş</p><h1>Günler</h1>
      <p class="lede">Kayıtlı her günün sıralaması: kim ne kadar çalıştı, günü kim kazandı.</p>
    </section>`;

  if (!days.length) {
    view.innerHTML = `${head}<div class="empty"><strong>Henüz kayıt yok</strong>İlk gün kaydedildiğinde burada listelenir.</div>`;
    return;
  }

  const rows = days.map(g => {
    const total = g.players.reduce((a, _, i) => a + S.minutesOf(g, i), 0);
    const items = g.players.map((name, i) => {
      const pts = S.pointsFor(i + 1, rl);
      return `<li class="${PLACE_CLASS[i] || ''}"><span class="pl">${i + 1}</span>
          <span class="nm">${esc(S.displayName(name, nk))}${pts ? `<span class="tag win">+${pts} puan</span>` : ''}</span>
          <span class="pt">${durHTML(S.minutesOf(g, i))}</span></li>`;
    }).join('');
    return `<tr>
        <td>${S.formatDate(g.date)}</td>
        <td>${esc(S.ligShort(S.ligKey(g.date)))}</td>
        <td class="total">${durHTML(total)}</td>
        <td class="order"><ol class="glist">${items}</ol></td>
      </tr>`;
  }).join('');

  view.innerHTML = `${head}
    <div class="toolbar"><p class="sorted">${days.length} gün · en yenisi üstte</p></div>
    <div class="table-wrap"><table class="games gunler-table">
      <thead><tr><th>Tarih</th><th>Lig</th><th>Toplam</th><th style="text-align:left">Sıralama</th></tr></thead>
      <tbody>${rows}</tbody></table></div>`;
}

// ---------- Ayarlar ----------

function pointsDraft() {
  const places = state.points.places.map(v => (/^\d{1,2}$/.test(v.trim()) ? Number(v) : NaN));
  const errors = [];
  const warnings = [];
  places.forEach((p, i) => {
    if (Number.isNaN(p)) errors.push(`${i + 1}. sıranın puanı 0–${S.MAX_POINT_VALUE} arası bir tam sayı olmalı.`);
    else if (i > 0 && p > places[i - 1]) warnings.push(`${i + 1}. sıra ${i}. sıradan fazla puan alıyor.`);
  });
  if (places[0] === 0) errors.push('1. sıra en az 1 puan almalı.');
  const clean = errors.length ? null : S.normalizePoints(places);
  const changed = !!clean && clean.join() !== rules().join();
  return { clean, errors, warnings, changed };
}

function renderAyarlar() {
  const admin = !!token();
  const saved = rules();
  if (!state.points || !state.points.dirty) state.points = { places: saved.map(String), dirty: false, busy: false };
  const f = state.points;
  const msg = state.pointsMsg ? `<p class="msg ${state.pointsMsg.ok ? 'ok' : 'err'}">${esc(state.pointsMsg.text)}</p>` : '';

  const form = `<div class="panel">
      <ol class="pt-list">${f.places.map((v, i) => `<li>
          <label for="s-pt-${i}">${i + 1}. sıra</label>
          <input type="text" inputmode="numeric" maxlength="2" id="s-pt-${i}" data-pt="${i}" value="${esc(v)}">
          <span class="dim">puan</span>
          ${i > 0 && i === f.places.length - 1 ? `<button type="button" class="icon" data-act="pt-remove" aria-label="${i + 1}. sırayı kaldır">✕</button>` : ''}
        </li>`).join('')}</ol>
      <p class="dim" style="margin:10px 0 0;font-size:14px">Listede olmayan sıralar puan almaz.</p>
      <ul class="issues" id="s-issues"></ul>
      <div class="save-row">
        <button type="button" class="btn primary" id="s-save">Kaydet</button>
        ${f.places.length < S.MAX_POINT_PLACES ? '<button type="button" class="btn" data-act="pt-add">Sıra ekle</button>' : ''}
        ${f.dirty ? '<button type="button" class="btn" data-act="pt-reset">Vazgeç</button>' : ''}
      </div>
      <div id="s-msg">${msg}</div>
    </div>`;

  view.innerHTML = `<section class="page-head">
      <p class="eyebrow">Yönetim</p><h1>Ayarlar</h1>
      <p class="lede">Ligin kuralları buradan değişir. Değişiklik herkes için geçerlidir ve geçmiş günler dahil bütün tablolara uygulanır.</p>
    </section>
    <section class="block" id="points">
      <div class="block-head"><h2>Puan sistemi</h2><span class="dim">Şu an: ${esc(S.rulesText(saved))}</span></div>
      <p class="dim" style="margin:0">Her günün sıralaması çalışma süresine göre oluşur. Aşağıdaki sıralar o gün karşılarındaki puanı alır.</p>
      ${admin ? form : `${msg}<p class="note">Puan sistemini değiştirmek için bu cihazda yönetici anahtarı kayıtlı olmalı. Anahtarı <a href="#yeni">Yeni Veri</a> sekmesinden girebilirsin.</p>`}
    </section>`;
  if (!admin) return;

  const refresh = () => {
    const d = pointsDraft();
    document.getElementById('s-issues').innerHTML =
      d.errors.map(e => `<li class="err">${esc(e)}</li>`).join('') + d.warnings.map(w => `<li class="warn">${esc(w)}</li>`).join('');
    document.getElementById('s-save').disabled = f.busy || !d.changed;
  };
  const edit = change => { change(); f.dirty = true; state.pointsMsg = null; render(); };
  view.querySelectorAll('[data-pt]').forEach(el => el.addEventListener('input', () => {
    f.places[+el.dataset.pt] = el.value;
    f.dirty = true;
    document.getElementById('s-msg').innerHTML = '';
    state.pointsMsg = null;
    refresh();
  }));
  view.querySelector('[data-act="pt-add"]')?.addEventListener('click', () => {
    edit(() => f.places.push(''));
    document.getElementById(`s-pt-${f.places.length - 1}`)?.focus();
  });
  view.querySelector('[data-act="pt-remove"]')?.addEventListener('click', () => edit(() => f.places.pop()));
  view.querySelector('[data-act="pt-reset"]')?.addEventListener('click', () => { state.points = null; state.pointsMsg = null; render(); });
  document.getElementById('s-save').addEventListener('click', savePoints);
  refresh();
}

async function savePoints() {
  const f = state.points;
  const d = pointsDraft();
  if (!d.changed || f.busy) return;
  const points = d.clean;
  f.busy = true;
  const btn = document.getElementById('s-save');
  btn.disabled = true;
  btn.textContent = 'Kaydediliyor…';
  try {
    await mutate(db => {
      const before = S.pointRules(db);
      db.settings = { ...db.settings, points };
      db.log.push({ at: new Date().toISOString(), action: 'settings', before: { points: before }, after: { points } });
    }, () => `Puan sistemi değişti: ${S.rulesText(points)}`);
    state.points = null;
    state.pointsMsg = { ok: true, text: 'Puan sistemi kaydedildi. Tablolar güncellendi, görseller 1–2 dakika içinde hazır olur.' };
  } catch (e) {
    f.busy = false;
    state.pointsMsg = { ok: false, text: errorText(e) };
  }
  render();
}

// ---------- Yardım ----------

function renderYardim() {
  const rl = rules();
  const pts = rl.map((p, i) => `<li><b>${p}</b>${i + 1}.</li>`).join('') + '<li><b>0</b>diğerleri</li>';
  view.innerHTML = `<div class="help">
    <section class="page-head"><p class="eyebrow">Nasıl çalışır</p><h1>Yardım</h1>
      <p class="lede">Bu sayfadaki her şey girilen çalışma sürelerinden otomatik hesaplanır. Yapılması gereken tek şey her gün kimin ne kadar çalıştığını kaydetmek.</p></section>

    <section><h2>Sekmeler</h2>
      <dl class="defs">
        <dt>Ana Tablo</dt><dd>Bütün zamanların tablosu. Hiç sıfırlanmaz.</dd>
        <dt>Ligler</dt><dd>Yılda iki lig oynanır: <strong>Kış Ligi</strong> 1 Ekim – 31 Mart, <strong>Yaz Ligi</strong> 1 Nisan – 30 Eylül. Yeni lig kendiliğinden açılır, geçmiş ligler menüde kalır.</dd>
        <dt>Günler</dt><dd>Kayıtlı her günün sıralaması ve çalışma süreleri.</dd>
        <dt>Yeni Veri</dt><dd>Üyeler ve nickleri, gün kaydı, bütün günlerin listesi, CSV ve değişiklik geçmişi.</dd>
        <dt>Ayarlar</dt><dd>Puan sistemi.</dd>
      </dl></section>

    <section><h2>Tablo</h2>
      <dl class="defs">
        <dt>Puan</dt><dd>Kazanılan puanların toplamı. Tablolar açılışta puana göre sıralıdır; puanlar eşitse toplam süresi fazla olan öndedir.</dd>
        <dt>Toplam süre</dt><dd>Kayıtlı bütün günlerdeki çalışma sürelerinin toplamı.</dd>
        <dt>Gün başına</dt><dd>Toplam süre ÷ gün sayısı. Gün sayısı, kişinin o tablodaki ilk kaydından itibaren kayıtlı bütün günlerdir: kayıtta olmadığı gün 0 sayılır, katılmadan önceki günler sayılmaz.</dd>
      </dl>
      <p>Bir sütun başlığına dokununca tablo o sütuna göre sıralanır, ikinci dokunuş sırayı ters çevirir.</p></section>

    <section><h2>Puan</h2>
      <ul class="pts">${pts}</ul>
      <p>Her günün sıralaması çalışma süresine göre oluşur: en çok çalışan 1. olur. Şu anki kural: <strong>${esc(S.rulesText(rl))}</strong>. Kural <a href="#ayarlar">Ayarlar</a> sekmesinden değiştirilebilir; değişiklik geçmiş günlere de uygulanır.</p></section>

    <section><h2>Üyeler ve nickler</h2>
      <p>Yeni biri katıldığında önce <strong>Yeni Veri → Üyeler</strong> bölümünden ismini ekle. Nick isteğe bağlı; tablolarda ve görsellerde nick görünür, nick boşsa isim görünür. Nick istediğin zaman <strong>Düzenle</strong> ile değiştirilebilir; geçmiş kayıtlar etkilenmez. Hiç kaydı olmayan üye silinebilir.</p></section>

    <section><h2>Gün kaydetme ve düzeltme</h2>
      <ol>
        <li><strong>Yeni Veri → Gün kaydet</strong> bölümünde tarihi seç. Her tarih bir kez kaydedilir.</li>
        <li>O gün çalışan üyelere dokun ve her birinin süresini saat ve dakika olarak yaz. Sıralama süreye göre kendiliğinden oluşur.</li>
        <li>Aynı süreyi çalışanlar varsa üstteki önde sayılır; ↑ ↓ ile yerlerini değiştirebilirsin.</li>
        <li><strong>Günü kaydet</strong>. Tablolar hemen, görseller 1–2 dakika içinde güncellenir.</li>
      </ol>
      <p>Yanlış girilen günü <strong>Tüm günler</strong> listesinde <strong>Düzelt</strong> ile değiştirebilir, <strong>Sil</strong> ile kaldırabilirsin. Silinen gün kaybolmaz, "Silinenleri göster" ile görünür ve <strong>Geri al</strong> ile geri gelir. Geçmiş tarihli günler de girilebilir; doğru lige kendiliğinden yerleşir.</p></section>

    <section><h2>Görsel ve paylaşım</h2>
      <p>Ana Tablo ve her lig için paylaşmaya hazır bir görsel üretilir. Tablonun üstündeki <strong>Görseli indir</strong> ve <strong>CSV indir</strong> düğmeleri dosyaları indirir. Telefonda <strong>Paylaş</strong> düğmesi görseli ve CSV'yi birlikte WhatsApp'a gönderebilir.</p></section>

    <section><h2>Yönetici anahtarı</h2>
      <p>Veri eklemek ve ayarları değiştirmek için her cihazda bir kez anahtar girmek gerekir. Anahtar sadece o tarayıcıda saklanır, kimseyle paylaşma. Oluşturmak için:</p>
      <ol>
        <li><strong>72-o</strong> hesabıyla GitHub'a gir ve <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">yeni anahtar sayfasını</a> aç.</li>
        <li><strong>Token name</strong>: <code>Forest Ligi</code>. <strong>Expiration</strong>: en uzun süreyi seç.</li>
        <li><strong>Repository access</strong>: <code>Only select repositories</code> → <code>72-o/forest</code>.</li>
        <li><strong>Permissions</strong> → <strong>Contents</strong>: <code>Read and write</code>.</li>
        <li><strong>Generate token</strong> de, çıkan <code>github_pat_…</code> anahtarını kopyala ve Yeni Veri sekmesindeki kutuya yapıştır.</li>
      </ol>
      <p>Anahtarın süresi dolunca kayıt sırasında uyarı çıkar; aynı adımlarla yenisini oluşturman yeterli.</p></section>
  </div>`;
}

// ---------- boot ----------

async function boot() {
  render();
  try {
    const [db, build] = await Promise.all([
      getJSON(`${DATA_PATH}?t=${Date.now()}`),
      getJSON(`build.json?t=${Date.now()}`).catch(() => null),
    ]);
    state.db = { ...emptyDb(), ...db };
    state.build = build;
  } catch (e) {
    state.loadError = e;
  }
  state.loaded = true;
  render();
  syncAdmin();
}

boot();
