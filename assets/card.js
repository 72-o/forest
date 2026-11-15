// Builds the share image markup for one board. Used by card.html (screenshotted by the build).
import { durationParts, formatDate, rulesText } from './stats.js';

export const LEAGUE_NAME = 'Forest Ligi';
export const SITE_URL = '72-o.github.io/forest';

const MEDALS = ['var(--gold)', 'var(--silver)', 'var(--bronze)'];

export function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// "5 sa 30 dk" with the units set small, so the numbers carry the weight.
export function durHTML(minutes) {
  return `<span class="dur">${durationParts(minutes).map(p => `${p.value}<small>${p.unit}</small>`).join(' ')}</span>`;
}

export function cardHTML(board) {
  const isAna = board.scope.type === 'ana';
  const eyebrow = isAna ? 'Ana Tablo · Tüm zamanlar' : board.scope.label;
  const titleLines = LEAGUE_NAME.split(' ').map(esc).join('<br>');
  const head = `<header class="c-head">
      <div><div class="c-eyebrow">${esc(eyebrow)}</div><div class="c-title">${titleLines}</div></div>
      <div class="c-count"><b>${board.dayCount}</b><span>gün${board.last ? ` · son gün ${formatDate(board.last.date)}` : ''}</span></div>
    </header>`;

  if (!board.dayCount) {
    return `${head}<div class="c-empty">Henüz kayıt yok</div>${foot(board)}`;
  }

  const last = board.last.players.map((n, i) => `<li><b>${i + 1}</b>${esc(n)} ${durHTML(board.last.minutes[i])}</li>`).join('');
  const th = `<div class="c-th">
      <span></span><span>İsim</span><span class="c-p">Puan</span><span class="c-d">Toplam</span><span class="c-d">Gün başına</span>
    </div>`;
  const rows = board.players.map((p, i) => `<div class="c-row${i === 0 ? ' lead' : ''}">
      <span class="c-rank${i < 3 ? ' top' : ''}" style="--c:${MEDALS[i] || 'inherit'}">${i + 1}</span>
      <span class="c-name">${esc(p.name)}</span>
      <span class="c-p">${p.points}</span>
      <span class="c-d">${durHTML(p.minutes)}</span>
      <span class="c-d">${durHTML(p.perDay)}</span>
    </div>`).join('');

  return `${head}
    <section class="c-last"><span class="c-last-label">Son gün</span><ol class="c-last-list">${last}</ol></section>
    <div class="c-table">${th}<div class="c-rows">${rows}</div></div>
    ${foot(board)}`;
}

function foot(board) {
  return `<footer class="c-foot"><span><b>${SITE_URL}</b></span><span>Puan: ${esc(rulesText(board.rules))}</span></footer>`;
}

// Fit the rows into the space left by the header, strip and footer.
export function layoutCard(el) {
  const rows = el.querySelector('.c-rows');
  if (!rows) return;
  const n = rows.children.length || 1;
  const rh = Math.max(28, Math.min(78, Math.floor(rows.clientHeight / n)));
  el.style.setProperty('--rh', `${rh}px`);
}
