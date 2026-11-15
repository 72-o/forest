// Shared by the site (browser) and the image build (Node). Pure functions only:
// everything shown anywhere is derived from data/db.json through this file.
//
// One record ("game" in the data file) is one day: who worked how long, longest first.

export const MAX_DAY_MINUTES = 24 * 60;

// ---------- names ----------

export function cleanName(name) {
  return String(name ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();
}

export function nameKey(name) {
  return cleanName(name).toLocaleLowerCase('tr');
}

// Leaderboards show the nickname when one is set, otherwise the real name.
export function displayName(name, nicks) {
  const nick = nicks && nicks[nameKey(name)];
  return nick ? cleanName(nick) : cleanName(name);
}

// ---------- points ----------

// The points system lives in db.settings.points: points per finishing place, best first.
// [1] means only the day's winner scores, and gets 1 point. Editable on the Ayarlar page.
export const DEFAULT_POINTS = [1];
export const MAX_POINT_PLACES = 6;
export const MAX_POINT_VALUE = 99;

// Anything malformed falls back to the default; trailing zeros carry no meaning and are dropped.
export function normalizePoints(raw) {
  if (!Array.isArray(raw) || !raw.length || raw.length > MAX_POINT_PLACES) return DEFAULT_POINTS.slice();
  if (raw.some(x => !Number.isInteger(x) || x < 0 || x > MAX_POINT_VALUE)) return DEFAULT_POINTS.slice();
  const out = raw.slice();
  while (out.length > 1 && out[out.length - 1] === 0) out.pop();
  return out[0] > 0 ? out : DEFAULT_POINTS.slice();
}

export function pointRules(db) {
  return normalizePoints(db?.settings?.points);
}

export function pointsFor(place, rules = DEFAULT_POINTS) {
  return rules[place - 1] || 0;
}

// One line for the share image and the history, e.g. "günün birincisi 1 puan" or "1. = 3 · 2. = 1".
export function rulesText(rules) {
  if (rules.length === 1) return `günün birincisi ${rules[0]} puan`;
  return rules.map((p, i) => `${i + 1}. = ${p}`).join(' · ');
}

// ---------- durations ----------

export function minutesOf(game, i) {
  const m = Number(game.minutes?.[i]);
  return Number.isFinite(m) && m > 0 ? Math.round(m) : 0;
}

// [{ value, unit }] parts of a duration: 330 → 5 sa 30 dk, 45 → 45 dk, 120 → 2 sa.
export function durationParts(minutes) {
  const total = Math.max(0, Math.round(minutes));
  const h = Math.floor(total / 60);
  const m = total % 60;
  const parts = [];
  if (h) parts.push({ value: h, unit: 'sa' });
  if (m || !h) parts.push({ value: m, unit: 'dk' });
  return parts;
}

export function fmtDuration(minutes) {
  return durationParts(minutes).map(p => `${p.value} ${p.unit}`).join(' ');
}

// ---------- dates and leagues ----------

export function todayISO(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function formatDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
}

export function isValidISODate(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso || '')) return false;
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

// Two leagues a year: Kış Ligi runs 1 October – 31 March, Yaz Ligi 1 April – 30 September.
// The key is the league's first month ("2026-10", "2027-04"), so keys sort chronologically.
export function ligKey(iso) {
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  if (m >= 10) return `${y}-10`;
  if (m <= 3) return `${y - 1}-10`;
  return `${y}-04`;
}

// Short name, e.g. "Kış 2026–27" or "Yaz 2027".
export function ligShort(key) {
  const y = Number(key.slice(0, 4));
  return key.endsWith('-10') ? `Kış ${y}–${String((y + 1) % 100).padStart(2, '0')}` : `Yaz ${y}`;
}

// Month span, e.g. "Ekim 2026 – Mart 2027".
export function ligRange(key) {
  const y = Number(key.slice(0, 4));
  return key.endsWith('-10') ? `Ekim ${y} – Mart ${y + 1}` : `Nisan – Eylül ${y}`;
}

export function ligLabel(key) {
  const y = Number(key.slice(0, 4));
  return key.endsWith('-10') ? `Kış Ligi ${y}–${String((y + 1) % 100).padStart(2, '0')}` : `Yaz Ligi ${y}`;
}

// ---------- days and scopes ----------

export function activeGames(db) {
  return (db?.games || [])
    .filter(g => !g.deleted)
    .slice()
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id));
}

// Ana Tablo first, then every league that has days plus the current one, newest first.
export function scopeList(db, today = todayISO()) {
  const current = ligKey(today);
  const keys = new Set(activeGames(db).map(g => ligKey(g.date)));
  keys.add(current);
  const ligs = [...keys].sort().reverse().map(key => ({
    type: 'lig', key, id: `lig-${key}`, label: ligLabel(key), current: key === current,
  }));
  return [{ type: 'ana', key: 'ana', id: 'ana', label: 'Ana Tablo', current: false }, ...ligs];
}

export function findScope(db, id, today = todayISO()) {
  return scopeList(db, today).find(s => s.id === id) || null;
}

export function gamesFor(db, scope) {
  const all = activeGames(db);
  return scope.type === 'ana' ? all : all.filter(g => ligKey(g.date) === scope.key);
}

// The roster: registered members plus any name that appears in a day, with active day counts.
export function playerList(db) {
  const map = new Map();
  for (const p of db?.players || []) {
    const key = nameKey(p.name);
    if (key && !map.has(key)) map.set(key, { key, name: cleanName(p.name), nick: cleanName(p.nick || ''), count: 0, registered: true });
  }
  for (const g of db?.games || []) {
    for (const n of g.players) {
      const key = nameKey(n);
      if (!map.has(key)) map.set(key, { key, name: cleanName(n), nick: '', count: 0, registered: false });
      if (!g.deleted) map.get(key).count++;
    }
  }
  return [...map.values()];
}

export function nickMap(db) {
  const out = {};
  for (const p of db?.players || []) if (p.nick) out[nameKey(p.name)] = cleanName(p.nick);
  return out;
}

// ---------- boards ----------

// games: active days in date order. Each player gets the points, the total time worked and the
// time per day. "Per day" divides by every recorded day since the player's first one in this
// board, so a skipped day counts as zero but days before joining do not.
export function buildBoard(games, scope, nicks = {}, rules = DEFAULT_POINTS) {
  const dates = [...new Set(games.map(g => g.date))];
  const dayIndex = new Map(dates.map((d, i) => [d, i]));
  const map = new Map();

  for (const g of games) {
    g.players.forEach((name, i) => {
      const k = nameKey(name);
      if (!map.has(k)) {
        map.set(k, { name: displayName(name, nicks), realName: cleanName(name), first: dayIndex.get(g.date), points: 0, minutes: 0 });
      }
      const p = map.get(k);
      p.points += pointsFor(i + 1, rules);
      p.minutes += minutesOf(g, i);
    });
  }

  const players = [...map.values()].map(p => ({
    name: p.name,
    realName: p.realName,
    points: p.points,
    minutes: p.minutes,
    days: dates.length - p.first,
    perDay: p.minutes / (dates.length - p.first),
  }));

  const lastGame = games[games.length - 1];
  return {
    scope,
    rules,
    dayCount: dates.length,
    playerCount: players.length,
    last: lastGame
      ? { date: lastGame.date, players: lastGame.players.map(n => displayName(n, nicks)), minutes: lastGame.players.map((_, i) => minutesOf(lastGame, i)) }
      : null,
    players: sortPlayers(players),
  };
}

// ---------- sorting ----------

export const SORT_KEYS = {
  name: p => p.name,
  points: p => p.points,
  minutes: p => p.minutes,
  perDay: p => p.perDay,
};

export const DEFAULT_SORT = 'points';

// Equal points: whoever worked longer comes first.
const TIE_BREAKS = [['points', -1], ['minutes', -1]];

function compare(a, b) {
  if (typeof a === 'string') return a.localeCompare(b, 'tr');
  return a < b ? -1 : a > b ? 1 : 0;
}

// dir: 'desc' or 'asc'. Ties fall back to points, then total time, then the name.
export function sortPlayers(list, key = DEFAULT_SORT, dir = 'desc') {
  const chain = [[key, dir === 'asc' ? 1 : -1], ...TIE_BREAKS];
  return list.slice().sort((a, b) => {
    for (const [k, d] of chain) {
      const c = compare(SORT_KEYS[k](a), SORT_KEYS[k](b));
      if (c) return c * d;
    }
    return compare(a.name, b.name);
  });
}

// ---------- export ----------

function csvCell(v) {
  const s = String(v);
  return /[";\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// One row per person per day. Semicolons and a BOM so Turkish Excel opens it cleanly.
export function gamesCsv(games, nicks = {}, rules = DEFAULT_POINTS) {
  const rows = [['tarih', 'lig', 'sira', 'isim', 'nick', 'sure_dakika', 'sure', 'puan']];
  for (const g of games) {
    g.players.forEach((name, i) => {
      const min = minutesOf(g, i);
      rows.push([formatDate(g.date), ligLabel(ligKey(g.date)), i + 1, name, nicks[nameKey(name)] || '', min, fmtDuration(min), pointsFor(i + 1, rules)]);
    });
  }
  return '\uFEFF' + rows.map(r => r.map(csvCell).join(';')).join('\r\n') + '\r\n';
}

// One member, day or log entry per line keeps the git history readable.
export function serializeDb(db) {
  const list = arr => (arr.length ? '\n' + arr.map(x => '    ' + JSON.stringify(x)).join(',\n') + '\n  ' : '');
  const settings = JSON.stringify({ points: pointRules(db) });
  const players = (db.players || []).map(p => (p.nick ? { name: p.name, nick: p.nick } : { name: p.name }));
  return `{\n  "version": 1,\n  "settings": ${settings},\n  "players": [${list(players)}],\n  "games": [${list(db.games || [])}],\n  "log": [${list(db.log || [])}]\n}\n`;
}
