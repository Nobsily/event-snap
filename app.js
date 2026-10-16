/* EventSnap - イベントで撮った写真を、タグ付きの下書きと一緒に X へ渡す
 * データはすべてこの端末の localStorage に保存（サーバー送信なし）
 */
'use strict';

const APP_VERSION = '0.4.0';
const SCHEMA = 'event-snap/2';

// ------------------------------------------------------------------ 保存
const K = {
  events: 'eventsnap.events',
  active: 'eventsnap.active',
  settings: 'eventsnap.settings',
  posted: 'eventsnap.posted',
  promptForm: 'eventsnap.promptForm',
};
const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v == null ? fallback : JSON.parse(v);
    } catch (e) { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; }
    catch (e) { toast('保存できませんでした（ブラウザの保存領域を確認してください）'); return false; }
  },
};

const DEFAULT_SETTINGS = {
  template: '{event_tags}\n{tags}\n{names}\n\n{comment}',
  honorific: '',
  nameSep: '、',
  tagMode: 'first',
  autoSave: true,
};

const state = {
  events: store.get(K.events, []),
  activeId: store.get(K.active, null),
  settings: (() => {
    const s = Object.assign({}, DEFAULT_SETTINGS, store.get(K.settings, {}));
    // v0.2.2 までの初期ひな形のままなら、新しい並び（共通タグ→本人タグ→名前）に置き換える
    if (s.template === '{comment}\n\n{names}\n{tags}\n{event_tags}') s.template = DEFAULT_SETTINGS.template;
    return s;
  })(),
  posted: store.get(K.posted, []),
  queue: [],          // {id, file, url, time, done}
  current: -1,        // queue の何番目を大きく表示中か
  pick: [],           // この投稿に使う写真の id（選んだ順、最大4枚）
  selected: [],       // 選択中の出演者 id
  tagOverride: {},    // タグ → true/false（初期状態からの手動切り替え）
  query: '',
  tab: 'post',
  editingPerfId: null,
  infoPerfId: null,
};

// ------------------------------------------------------------------ 小道具
const $ = (sel) => document.querySelector(sel);
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function toast(msg, ms) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._h);
  toast._h = setTimeout(() => t.classList.remove('show'), ms || 1800);
}
function pad2(n) { return String(n).padStart(2, '0'); }
function ymd(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
function hm(d) { return pad2(d.getHours()) + ':' + pad2(d.getMinutes()); }
function uid(prefix) { return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

function normTag(t) {
  let s = String(t || '').trim().replace(/^[#＃]+/, '').replace(/\s+/g, '');
  return s ? '#' + s : '';
}
function normTags(list) {
  const arr = Array.isArray(list) ? list : String(list || '').split(/[\s,、]+/);
  const out = [];
  const seen = new Set();
  for (const t of arr) {
    const n = normTag(t);
    if (n && !seen.has(n.toLowerCase())) { seen.add(n.toLowerCase()); out.push(n); }
  }
  return out;
}
function normTime(t) {
  const m = String(t || '').trim().replace(/[：]/g, ':').match(/^(\d{1,2}):(\d{2})/);
  if (!m) return '';
  const h = Number(m[1]);
  if (h > 29) return '';
  return pad2(h) + ':' + m[2];
}
function normDate(d) {
  const m = String(d || '').trim().match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})/);
  return m ? m[1] + '-' + pad2(m[2]) + '-' + pad2(m[3]) : '';
}
function normId(x) { return String(x || '').trim().replace(/^@+/, '').replace(/^https?:\/\/(x|twitter)\.com\//, '').split(/[/?\s]/)[0]; }
function normConf(c) { c = String(c || '').toLowerCase(); return ['high', 'medium', 'low'].includes(c) ? c : 'low'; }

// X の文字数（全角は2、半角は1、URL は 23 として数える）
function xLength(text) {
  const urlRe = /https?:\/\/\S+/g;
  let len = 0;
  const stripped = text.replace(urlRe, () => { len += 23; return ''; });
  for (const ch of stripped) {
    const cp = ch.codePointAt(0);
    const light = (cp <= 0x10FF) || (cp >= 0x2000 && cp <= 0x200D) || (cp >= 0x2010 && cp <= 0x201F) || (cp >= 0x2032 && cp <= 0x2037);
    len += light ? 1 : 2;
  }
  return len;
}

// ------------------------------------------------------------------ イベントデータ
function activeEvent() { return state.events.find((e) => e.id === state.activeId) || null; }
function saveEvents() { store.set(K.events, state.events); store.set(K.active, state.activeId); }

// ---- SNS アカウント（X / Instagram / TikTok / YouTube / Twitch / その他）
const PLATFORMS = {
  x: { label: 'X', short: 'X' },
  instagram: { label: 'Instagram', short: 'IG' },
  tiktok: { label: 'TikTok', short: 'TT' },
  youtube: { label: 'YouTube', short: 'YT' },
  twitch: { label: 'Twitch', short: 'TW' },
  linkhub: { label: 'リンク集', short: '🔗' },
  other: { label: 'リンク', short: '🔗' },
};
const PLATFORM_ALIAS = { litlink: 'linkhub', linktree: 'linkhub', 'lit.link': 'linkhub', twitter: 'x', 'x.com': 'x', ig: 'instagram', insta: 'instagram', tt: 'tiktok', yt: 'youtube', web: 'other', site: 'other', link: 'other' };

function platformFromUrl(u) {
  const s = String(u || '').toLowerCase();
  if (/(^|\/\/|\.)(x|twitter)\.com\//.test(s)) return 'x';
  if (s.includes('instagram.com/')) return 'instagram';
  if (s.includes('tiktok.com/')) return 'tiktok';
  if (s.includes('youtube.com/') || s.includes('youtu.be/')) return 'youtube';
  if (s.includes('twitch.tv/')) return 'twitch';
  if (/(lit\.link|linktr\.ee|potofu\.me|profcard\.info|lnk\.bio|bio\.link|linkco\.re|solo\.to)\//.test(s)) return 'linkhub';
  return 'other';
}

function accountUrl(platform, id) {
  const raw = String(id || '').trim();
  if (/^https?:\/\//i.test(raw)) return raw;
  const bare = raw.replace(/^@+/, '');
  if (!bare) return '';
  switch (platform) {
    case 'x': return 'https://x.com/' + bare;
    case 'instagram': return 'https://www.instagram.com/' + bare + '/';
    case 'tiktok': return 'https://www.tiktok.com/@' + bare;
    case 'youtube': return /^UC[\w-]{20,}$/.test(bare) ? 'https://www.youtube.com/channel/' + bare : 'https://www.youtube.com/@' + bare;
    case 'twitch': return 'https://www.twitch.tv/' + bare;
    default: return '';
  }
}

function accountId(platform, idOrUrl) {
  let s = String(idOrUrl || '').trim();
  if (/^https?:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      const seg = u.pathname.split('/').filter(Boolean);
      if (platform === 'youtube') s = seg[0] === 'channel' ? seg[1] || '' : (seg[0] || '');
      else if (platform === 'linkhub' || platform === 'other') s = seg[seg.length - 1] || u.hostname;
      else s = seg[0] || '';
    } catch (e) { return ''; }
  }
  return s.replace(/^@+/, '');
}

function normAccount(a) {
  let platform, id, url;
  if (typeof a === 'string') {
    platform = platformFromUrl(a); url = /^https?:\/\//i.test(a) ? a.trim() : ''; id = accountId(platform, a);
  } else if (a && typeof a === 'object') {
    platform = String(a.platform || a.type || a.service || '').toLowerCase().trim();
    platform = PLATFORM_ALIAS[platform] || platform;
    url = String(a.url || '').trim();
    if (!PLATFORMS[platform]) platform = url ? platformFromUrl(url) : 'other';
    id = accountId(platform, a.id || a.handle || a.username || url);
  } else {
    return null;
  }
  if (!url) url = accountUrl(platform, id);
  if (!id && !url) return null;
  return { platform, id, url };
}

function normAccounts(p) {
  const list = [];
  const push = (a) => {
    const n = normAccount(a);
    if (!n) return;
    const key = n.platform + ':' + (n.id || n.url).toLowerCase();
    if (!list.some((x) => x.platform + ':' + (x.id || x.url).toLowerCase() === key)) list.push(n);
  };
  (Array.isArray(p.accounts) ? p.accounts : []).forEach(push);
  const xid = normId(p.x_id || p.xid || p.x || p.twitter);
  if (xid) push({ platform: 'x', id: xid });
  ['instagram', 'tiktok', 'youtube', 'twitch'].forEach((k) => { if (p[k]) push({ platform: k, id: p[k] }); });
  if (p.youtube_url) push({ platform: 'youtube', url: p.youtube_url });
  const order = ['x', 'youtube', 'instagram', 'tiktok', 'twitch', 'linkhub', 'other'];
  return list.sort((a, b) => order.indexOf(a.platform) - order.indexOf(b.platform));
}

function xIdOf(p) { const a = (p.accounts || []).find((x) => x.platform === 'x'); return a ? a.id : ''; }

function normalizePerformer(p, i) {
  const accounts = normAccounts(p);
  const xa = accounts.find((a) => a.platform === 'x');
  return {
    id: p.id || ('p' + (i + 1) + '_' + Math.random().toString(36).slice(2, 6)),
    name: String(p.name || '').trim(),
    reading: String(p.reading || '').trim(),
    x_id: xa ? xa.id : '',
    accounts,
    hashtags: normTags(p.hashtags || p.tags || []),
    bio: String(p.bio || p.x_bio || p.profile || '').trim(),
    youtube_about: String(p.youtube_about || p.youtube_summary || '').trim(),
    stage: String(p.stage || '').trim(),
    date: normDate(p.date),
    start: normTime(p.start),
    end: normTime(p.end),
    source_url: String(p.source_url || '').trim(),
    confidence: normConf(p.confidence),
    note: String(p.note || '').trim(),
  };
}

// 名前の照合用（全角半角・空白・大文字小文字の違いを無視）
function nameKey(s) {
  return String(s || '').normalize('NFKC').replace(/[\s　・･_\-－]/g, '').toLowerCase();
}

function normalizeEvent(obj) {
  const ev = obj.event || {};
  const perfs = Array.isArray(obj.performers) ? obj.performers : [];
  return {
    id: uid('ev'),
    schema: SCHEMA,
    name: String(ev.name || '').trim() || '名称未設定のイベント',
    date: normDate(ev.date),
    venue: String(ev.venue || '').trim(),
    hashtags: normTags(ev.hashtags || ev.tags || []),
    source_urls: Array.isArray(ev.source_urls) ? ev.source_urls : [],
    performers: perfs.map(normalizePerformer).filter((p) => p.name),
    imported_at: new Date().toISOString(),
  };
}

// Grok の回答から JSON 部分を取り出す（```json ～ ``` や前後の説明文があっても可）
function extractJson(text) {
  const t = String(text || '').trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence ? fence[1] : t;
  const s = body.indexOf('{');
  const e = body.lastIndexOf('}');
  if (s < 0 || e <= s) throw new Error('JSON が見つかりません');
  return JSON.parse(body.slice(s, e + 1));
}

const CONF_RANK = { low: 0, medium: 1, high: 2 };

// 既存の出演者 cur に、新しい情報 inc の「空欄だけ」を埋める。タグ・アカウントは足し合わせる
function mergePerformer(cur, inc) {
  // 何も見つからなかった結果（空欄だらけ＋low）は、メモも含めて取り込まない
  const empty = !(inc.accounts || []).length && !inc.hashtags.length && !inc.bio && !inc.youtube_about && !inc.start && !inc.stage;
  if (empty) return false;
  let changed = false;
  ['reading', 'bio', 'youtube_about', 'stage', 'date', 'start', 'end', 'source_url'].forEach((k) => {
    if (!cur[k] && inc[k]) { cur[k] = inc[k]; changed = true; }
  });
  const tags = normTags(cur.hashtags.concat(inc.hashtags));
  if (tags.length !== cur.hashtags.length) { cur.hashtags = tags; changed = true; }
  const accs = normAccounts({ accounts: (cur.accounts || []).concat(inc.accounts || []) });
  if (accs.length !== (cur.accounts || []).length) { cur.accounts = accs; changed = true; }
  cur.x_id = xIdOf(cur);
  if (CONF_RANK[inc.confidence] > CONF_RANK[cur.confidence]) { cur.confidence = inc.confidence; changed = true; }
  if (inc.note && !cur.note.includes(inc.note)) { cur.note = cur.note ? cur.note + ' / ' + inc.note : inc.note; changed = true; }
  return changed;
}

// 同じ人か（名前が同じで、出演日が両方入っていて違う場合は別出演として扱う）
function findSamePerformer(list, p, evDate) {
  const k = nameKey(p.name);
  const sameDay = (x) => !((x.date || evDate) && (p.date || evDate) && (x.date || evDate) !== (p.date || evDate));
  // 1) 名前が一致  2) 同じ日・同じ開始時刻で、名前がほぼ同じ（「未月」と「末月」のような1〜2文字違い）
  return list.find((x) => nameKey(x.name) === k && sameDay(x)) ||
    list.find((x) => sameDay(x) && p.start && x.start === p.start && nameSimilar(x.name, p.name));
}

// 2つの文字列の違い（何文字直せば同じになるか）
function editDistance(a, b) {
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}

// 名前がほぼ同じか（表記ゆれ・誤字・片方がもう片方を含む）
function nameSimilar(a, b) {
  const x = nameKey(a), y = nameKey(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const short = x.length < y.length ? x : y, long = x.length < y.length ? y : x;
  if (long.includes(short) && short.length >= 2 && short.length / long.length >= 0.6) return true;
  const limit = Math.max(1, Math.floor(Math.min(x.length, y.length) / 4));
  return editDistance(x, y) <= limit;
}

// 選択ダイアログ（ボタンを押した値を返す）
function choose(title, message, options) {
  return new Promise((resolve) => {
    const dlg = $('#dlgChoice');
    $('#choiceTitle').textContent = title;
    $('#choiceMsg').textContent = message;
    const box = $('#choiceBtns');
    box.innerHTML = '';
    options.forEach((o) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn' + (o.primary ? ' primary' : '');
      b.textContent = o.label;
      b.onclick = () => { dlg.close(); resolve(o.value); };
      box.appendChild(b);
    });
    dlg.onclose = () => resolve(null);
    dlg.showModal();
  });
}

// 読み込み。戻り値 { ev, mode: 'new'|'replace'|'merge', updated, added }、キャンセル時は null
async function importEventObject(obj) {
  if (!obj || typeof obj !== 'object') throw new Error('形式が違います');
  const inc = normalizeEvent(obj);
  if (!inc.performers.length) throw new Error('出演者が1人もいません');
  const dup = state.events.find((e) => nameKey(e.name) === nameKey(inc.name));
  if (!dup) {
    state.events.push(inc);
    state.activeId = inc.id;
    saveEvents();
    resetDraft();
    return { ev: inc, mode: 'new', updated: 0, added: inc.performers.length };
  }

  const mode = await choose('「' + dup.name + '」は保存済みです',
    '補完：今のデータの空欄だけを埋め、タグ・SNS は足し合わせ、いない人は追加します（Grok の日別出力や Gemini の補完結果はこちら）。\n置き換え：今のデータを新しい内容で置き換えます。',
    [{ label: '補完する', value: 'merge', primary: true }, { label: '置き換える', value: 'replace' }, { label: 'やめる', value: null }]);
  if (!mode) return null;

  let updated = 0, added = 0;
  if (mode === 'merge') {
    // 日付違いの出力（2日目だけ等）は、出演日を各出演者に持たせてから合わせる
    const incDate = inc.date && dup.date && inc.date !== dup.date ? inc.date : '';
    if (!dup.date && inc.date) dup.date = inc.date;
    if (!dup.hashtags.length) dup.hashtags = inc.hashtags;  // 共通タグは日別の出力で増やさない（必要ならイベント情報の編集で追加）
    if (!dup.venue && inc.venue) dup.venue = inc.venue;
    for (const p of inc.performers) {
      if (!p.date && incDate) p.date = incDate;
      const cur = findSamePerformer(dup.performers, p, dup.date);
      if (cur) { if (mergePerformer(cur, p)) updated++; }
      else { dup.performers.push(p); added++; }
    }
    state.activeId = dup.id;
    saveEvents();
    resetDraft();
    return { ev: dup, mode, updated, added };
  }

  // 置き換え：同じ名前の人は id を引き継ぐ（投稿済みの ✓ を残すため）
  inc.id = dup.id;
  inc.performers.forEach((p) => {
    const old = findSamePerformer(dup.performers, p, inc.date);
    if (old) p.id = old.id;
  });
  state.events = state.events.map((e) => (e.id === dup.id ? inc : e));
  state.activeId = inc.id;
  saveEvents();
  resetDraft();
  return { ev: inc, mode, updated: 0, added: inc.performers.length };
}

function importMessage(r) {
  const low = r.ev.performers.filter((p) => p.confidence === 'low').length;
  const lowText = low ? '（要確認 ' + low + '人）' : '';
  if (r.mode === 'merge') return '補完しました：更新 ' + r.updated + '人・追加 ' + r.added + '人' + lowText;
  return '「' + r.ev.name + '」' + r.ev.performers.length + '人を読み込みました' + lowText;
}

async function loadSample() {
  try {
    const res = await fetch('sample-event.json', { cache: 'no-cache' });
    const obj = await res.json();
    // デモ用：日付を今日に、出演時刻を「今」の前後に並べ直す
    const now = new Date();
    obj.event.date = ymd(now);
    obj.event.name = obj.event.name + '（サンプル）';
    const base = new Date(now.getTime() - 45 * 60000);
    base.setMinutes(Math.floor(base.getMinutes() / 15) * 15, 0, 0);
    obj.performers.forEach((p, i) => {
      const s = new Date(base.getTime() + i * 30 * 60000);
      const e = new Date(s.getTime() + 25 * 60000);
      p.start = hm(s); p.end = hm(e); p.date = '';
    });
    const r = await importEventObject(obj);
    if (r) { toast('サンプルを読み込みました'); go('post'); }
  } catch (e) {
    toast('サンプルを読み込めませんでした');
  }
}

// ------------------------------------------------------------------ 出演時刻
function perfRange(ev, p, refDate) {
  if (!p.start) return null;
  const day = p.date || ev.date || ymd(refDate);
  const [sh, sm] = p.start.split(':').map(Number);
  const start = new Date(day + 'T00:00:00');
  start.setHours(sh, sm, 0, 0);
  let end;
  if (p.end) {
    const [eh, em] = p.end.split(':').map(Number);
    end = new Date(day + 'T00:00:00');
    end.setHours(eh, em, 0, 0);
    if (end <= start) end = new Date(end.getTime() + 24 * 3600000);
  } else {
    end = new Date(start.getTime() + 30 * 60000);
  }
  return { start, end };
}

// 基準時刻：表示中の写真の撮影時刻（イベント当日のものなら）、なければ現在時刻
function referenceTime(ev) {
  const firstPick = state.queue.find((q) => q.id === state.pick[0]);
  const item = firstPick || state.queue[state.current];
  if (item && item.time && ev) {
    const d = new Date(item.time);
    const days = new Set([ev.date].concat(ev.performers.map((p) => p.date)).filter(Boolean));
    if (!days.size || days.has(ymd(d))) return { time: d, fromPhoto: true };
  }
  return { time: new Date(), fromPhoto: false };
}

function postedCount(evId, perfId) {
  return state.posted.filter((r) => r.eventId === evId && r.performers.includes(perfId)).length;
}

// ------------------------------------------------------------------ 下書き
function resetDraft() {
  state.selected = [];
  state.tagOverride = {};
  $('#comment').value = '';
}

function draftTags(ev) {
  const perfTags = [];
  const seen = new Set();
  for (const id of state.selected) {
    const p = ev.performers.find((x) => x.id === id);
    if (!p) continue;
    p.hashtags.forEach((t, i) => {
      const k = t.toLowerCase();
      if (seen.has(k)) return;
      seen.add(k);
      const def = state.settings.tagMode === 'all' || i === 0;
      perfTags.push({ tag: t, on: t in state.tagOverride ? state.tagOverride[t] : def, kind: 'perf' });
    });
  }
  const evTags = [];
  for (const t of ev.hashtags) {
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    evTags.push({ tag: t, on: t in state.tagOverride ? state.tagOverride[t] : true, kind: 'event' });
  }
  return { perfTags, evTags };
}

function buildDraft(ev) {
  if (!ev) return '';
  const s = state.settings;
  const names = state.selected
    .map((id) => ev.performers.find((p) => p.id === id))
    .filter(Boolean)
    .map((p) => p.name + (s.honorific || ''))
    .join(s.nameSep == null ? '、' : s.nameSep);
  const { perfTags, evTags } = draftTags(ev);
  const tags = perfTags.filter((t) => t.on).map((t) => t.tag).join(' ');
  const eventTags = evTags.filter((t) => t.on).map((t) => t.tag).join(' ');
  let text = (s.template || DEFAULT_SETTINGS.template)
    .replace(/\{comment\}/g, $('#comment').value.trim())
    .replace(/\{names\}/g, names)
    .replace(/\{tags\}/g, tags)
    .replace(/\{event_tags\}/g, eventTags)
    .replace(/\{event\}/g, ev.name);
  text = text.split('\n').map((l) => l.replace(/\s+$/, '')).join('\n');
  text = text.replace(/\n{3,}/g, '\n\n').trim();
  return text;
}

// ------------------------------------------------------------------ 描画：共通
function go(tab) {
  state.tab = tab;
  document.querySelectorAll('.tab').forEach((s) => { s.hidden = s.dataset.tab !== tab; });
  document.querySelectorAll('.tabbar button').forEach((b) => b.classList.toggle('on', b.dataset.go === tab));
  render();
  window.scrollTo(0, 0);
}

function render() {
  renderEventSelect();
  if (state.tab === 'post') renderPost();
  if (state.tab === 'event') renderEventTab();
  if (state.tab === 'settings') renderSettings();
}

function renderEventSelect() {
  const sel = $('#evSelect');
  if (!state.events.length) {
    sel.innerHTML = '<option>（イベント未登録）</option>';
    sel.disabled = true;
    return;
  }
  sel.disabled = false;
  sel.innerHTML = state.events
    .map((e) => '<option value="' + esc(e.id) + '"' + (e.id === state.activeId ? ' selected' : '') + '>' + esc(e.name) + (e.date ? '（' + esc(e.date) + '）' : '') + '</option>')
    .join('');
  if (!activeEvent()) { state.activeId = state.events[0].id; saveEvents(); }
}

// ------------------------------------------------------------------ 描画：投稿タブ
function renderPost() {
  const ev = activeEvent();
  $('#noEvent').hidden = !!ev;
  renderQueue();
  renderPerformers(ev);
  renderDraft(ev);
}

const MAX_PICK = 4;

function renderQueue() {
  const q = $('#queue');
  state.pick = state.pick.filter((id) => state.queue.some((x) => x.id === id));
  if (state.queue.length <= 1) {
    q.innerHTML = '';
  } else {
    q.innerHTML = state.queue
      .map((it, i) => {
        const n = state.pick.indexOf(it.id);
        return '<button type="button" class="qitem' + (i === state.current ? ' cur' : '') + (it.done ? ' done' : '') + (n >= 0 ? ' picked' : '') + '" data-q="' + i + '">' +
          (isVideo(it) ? '<video src="' + it.url + '#t=0.1" muted preload="metadata"></video><span class="qvid">▶</span>' : '<img src="' + it.url + '" alt="">') +
          (n >= 0 ? '<span class="qnum">' + (n + 1) + '</span>' : '') +
          (it.done ? '<span class="qbadge">済</span>' : '') + '</button>';
      })
      .join('');
  }
  const pv = $('#preview');
  const it = state.queue[state.current];
  if (!it) { pv.innerHTML = ''; return; }
  const remain = state.queue.filter((x) => !x.done).length;
  const n = state.pick.indexOf(it.id);
  const full = n < 0 && state.pick.length >= MAX_PICK;
  pv.innerHTML = (isVideo(it) ? '<video src="' + it.url + '" controls playsinline preload="metadata"></video>' : '<img src="' + it.url + '" alt="表示中の写真">') +
    '<div class="pmeta small muted"><span>' + (it.time ? '撮影 ' + esc(hm(new Date(it.time))) : '') +
    (state.queue.length > 1 ? '　' + (state.current + 1) + ' / ' + state.queue.length + '（未投稿 ' + remain + '）' : '') + '</span></div>' +
    '<div class="row pick-row">' +
    '<button type="button" class="btn ' + (n >= 0 ? 'primary' : '') + '" id="btnPick"' + (full ? ' disabled' : '') + '>' +
      (n >= 0 ? '✓ 投稿に使う（' + (n + 1) + '枚目）' : full ? '4枚まで選択済み' : '＋ 投稿に使う') + '</button>' +
    '<button type="button" class="btn" id="btnRemovePhoto">一覧から消す</button>' +
    '<button type="button" class="btn" id="btnSaveMedia">端末に保存</button>' +
    (state.queue.some((x) => x.done) ? '<button type="button" class="btn" id="btnClearDone">投稿済みを消す</button>' : '') +
    '</div>' +
    '<div class="small muted">この投稿に使う写真：' + (state.pick.length ? state.pick.length + '枚（最大4枚・選んだ順に添付）' : 'なし') +
    (state.queue.length > 1 ? '。下の一覧をタップで切り替え' : '') + '</div>';
}

function togglePick(id) {
  const i = state.pick.indexOf(id);
  if (i >= 0) state.pick.splice(i, 1);
  else if (state.pick.length < MAX_PICK) state.pick.push(id);
  else { toast('1回の投稿に使えるのは4枚までです'); return; }
  renderQueue();
  renderPerformers(activeEvent());
}

function clearDonePhotos() {
  state.queue.filter((x) => x.done).forEach((x) => { URL.revokeObjectURL(x.url); mediaStore.del(x.id); });
  const curId = state.queue[state.current] && state.queue[state.current].id;
  state.queue = state.queue.filter((x) => !x.done);
  const idx = state.queue.findIndex((x) => x.id === curId);
  state.current = idx >= 0 ? idx : (state.queue.length ? 0 : -1);
  render();
}

function renderPerformers(ev) {
  const list = $('#pList');
  const info = $('#refInfo');
  const chips = $('#selChips');
  if (!ev) { list.innerHTML = ''; info.textContent = ''; chips.innerHTML = ''; return; }

  const ref = referenceTime(ev);
  info.textContent = (ref.fromPhoto ? '📷 撮影時刻 ' : '🕒 現在 ') + hm(ref.time) + ' に出演中の人を上に表示';

  chips.innerHTML = state.selected
    .map((id) => ev.performers.find((p) => p.id === id))
    .filter(Boolean)
    .map((p) => '<button type="button" class="chip on" data-unsel="' + esc(p.id) + '">' + esc(p.name) + ' ✕</button>')
    .join('');

  const q = state.query.trim().toLowerCase();
  // 複数日開催で、基準時刻がそのどれかの日なら、その日の出演者だけ表示（検索中は全日程）
  const days = new Set(ev.performers.map((p) => p.date || ev.date).filter(Boolean));
  const refDay = ymd(ref.time);
  const dayOnly = !q && days.size > 1 && days.has(refDay);
  if (dayOnly) info.textContent += '（' + refDay.slice(5).replace('-', '/') + ' の出演者のみ。他の日は検索で表示）';
  const rows = ev.performers
    .filter((p) => !dayOnly || (p.date || ev.date) === refDay)
    .filter((p) => !q || (p.name + ' ' + p.reading + ' ' + p.hashtags.join(' ') + ' ' + p.stage + ' ' + (p.accounts || []).map((a) => a.id).join(' ')).toLowerCase().includes(q))
    .map((p) => {
      const r = perfRange(ev, p, ref.time);
      const on = !!(r && r.start <= ref.time && ref.time < r.end);
      const soon = !!(r && !on && r.start > ref.time && r.start - ref.time <= 30 * 60000);
      return { p, r, on, soon };
    });
  const byStart = (a, b) => (a.r ? a.r.start : Infinity) - (b.r ? b.r.start : Infinity);
  const onstage = rows.filter((x) => x.on).sort(byStart);
  const soon = rows.filter((x) => x.soon).sort(byStart);
  const rest = rows.filter((x) => !x.on && !x.soon).sort(byStart);

  const rowHtml = (x) => {
    const p = x.p;
    const cnt = postedCount(ev.id, p.id);
    const time = p.start ? p.start + (p.end ? '–' + p.end : '') : '';
    return '<div class="pwrap"><button type="button" class="prow' + (x.on ? ' onstage' : '') + (state.selected.includes(p.id) ? ' sel' : '') + '" data-pid="' + esc(p.id) + '">' +
      '<div class="pmain"><div class="pname">' + esc(p.name) +
      (p.confidence === 'low' ? '<span class="badge warn">要確認</span>' : '') +
      (cnt ? '<span class="badge ok">✓' + cnt + '</span>' : '') + snsBadges(p) + '</div>' +
      '<div class="psub">' + esc(p.hashtags[0] || 'タグなし') + (p.reading ? '・' + esc(p.reading) : '') + '</div></div>' +
      '<div class="pright">' + esc(time) + (p.stage ? '<br>' + esc(p.stage) : '') + '</div></button>' +
      '<button type="button" class="pinfo" data-info="' + esc(p.id) + '" aria-label="紹介を見る">ⓘ</button></div>';
  };
  let html = '';
  if (onstage.length) html += '<div class="pgroup">いま出演中</div>' + onstage.map(rowHtml).join('');
  if (soon.length) html += '<div class="pgroup">まもなく</div>' + soon.map(rowHtml).join('');
  if (rest.length) html += '<div class="pgroup">' + (onstage.length || soon.length ? 'ほかの出演者' : '出演者（時刻順）') + '</div>' + rest.map(rowHtml).join('');
  if (!html) html = '<div class="small muted">該当する出演者がいません</div>';
  list.innerHTML = html;
}

function renderDraft(ev) {
  const chips = $('#tagChips');
  if (!ev) { chips.innerHTML = ''; $('#draft').textContent = ''; $('#count').textContent = ''; return; }
  const { perfTags, evTags } = draftTags(ev);
  chips.innerHTML = perfTags.concat(evTags)
    .map((t) => '<button type="button" class="chip ' + (t.on ? 'on' : 'off') + '" data-tag="' + esc(t.tag) + '" data-on="' + (t.on ? 1 : 0) + '">' + esc(t.tag) + '</button>')
    .join('');
  const text = buildDraft(ev);
  $('#draft').textContent = text || '（出演者を選ぶと本文ができます）';
  const len = xLength(text);
  const c = $('#count');
  c.textContent = len + ' / 280';
  c.classList.toggle('over', len > 280);
}

// SNS の種類を小さな印で表示（X が無い人が分かるように）
function snsBadges(p) {
  const accs = p.accounts || [];
  if (!accs.length) return '<span class="badge sns none">SNS未取得</span>';
  const seen = new Set();
  return accs.filter((a) => { if (seen.has(a.platform)) return false; seen.add(a.platform); return true; })
    .map((a) => '<span class="badge sns ' + esc(a.platform) + '">' + esc((PLATFORMS[a.platform] || PLATFORMS.other).short) + '</span>').join('');
}

function accountLabel(a) {
  if (a.platform === 'linkhub' || a.platform === 'other') {
    try { return '（' + new URL(a.url).hostname.replace(/^www\./, '') + '）'; } catch (e) { return ''; }
  }
  return a.id ? ' @' + a.id : '';
}

// 手動で探すための検索リンク（Gemini/Grok で見つからなかった人向け）
function searchLinks(p) {
  const n = p.name;
  const q = (s) => encodeURIComponent(s);
  return [
    { label: 'Google（リンク集）', url: 'https://www.google.com/search?q=' + q('"' + n + '" lit.link OR linktr.ee OR potofu') },
    { label: 'Google（VTuber）', url: 'https://www.google.com/search?q=' + q('"' + n + '" VTuber') },
    { label: 'YouTube で検索', url: 'https://www.youtube.com/results?search_query=' + q(n) + '&sp=EgIQAg%253D%253D' },
    { label: 'X で検索', url: 'https://x.com/search?q=' + q(n) + '&f=user' },
  ];
}

// 出演者の紹介を表示（X 等へ飛ぶ前に確認できるように）
function openInfo(perfId) {
  const ev = activeEvent();
  const p = ev && ev.performers.find((x) => x.id === perfId);
  if (!p) return;
  state.infoPerfId = perfId;
  const time = p.start ? (p.date ? p.date.slice(5).replace('-', '/') + ' ' : '') + p.start + (p.end ? '–' + p.end : '') : '';
  const sec = (title, body) => body ? '<div class="info-sec"><div class="label">' + title + '</div><div class="info-text">' + esc(body) + '</div></div>' : '';
  $('#infoBody').innerHTML =
    '<h3>' + esc(p.name) + (p.confidence === 'low' ? '<span class="badge warn">要確認</span>' : '') + '</h3>' +
    '<div class="small muted">' + esc([p.reading, time, p.stage].filter(Boolean).join('・')) + '</div>' +
    '<div class="info-links">' + ((p.accounts || []).length
      ? p.accounts.map((a) => '<a class="btn sns-btn ' + esc(a.platform) + '" href="' + esc(a.url) + '" target="_blank" rel="noopener">' +
        esc((PLATFORMS[a.platform] || PLATFORMS.other).label) + esc(accountLabel(a)) + '</a>').join('')
      : '<span class="small muted">SNS アカウント未取得</span>') + '</div>' +
    sec('ハッシュタグ', p.hashtags.join(' ')) +
    sec('プロフィール（原文）', p.bio) +
    sec('YouTube チャンネル紹介（要約）', p.youtube_about) +
    sec('メモ', p.note) +
    '<div class="info-sec"><div class="label">自分で探す</div><div class="info-links">' +
      searchLinks(p).map((l) => '<a class="btn" href="' + esc(l.url) + '" target="_blank" rel="noopener">' + esc(l.label) + '</a>').join('') +
    '</div><div class="small muted">見つけた URL は「編集」→「URL を貼り付け」に入れると、種類（X・YouTube 等）を自動で判別します</div></div>' +
    (!p.bio && !p.youtube_about ? '<div class="small muted info-sec">紹介文は未取得です（イベントタブの「Gemini で補完」で取れます）</div>' : '');
  const selected = state.selected.includes(p.id);
  $('#btnInfoSelect').textContent = selected ? '選択を外す' : 'この人を選ぶ';
  $('#dlgInfo').showModal();
}

// ------------------------------------------------------------------ データ点検（重複・抜け・空き枠）
function dayOf(ev, p) { return p.date || ev.date || ''; }

function findDuplicates(ev) {
  const ignore = new Set(ev.notDup || []);
  const out = [];
  const ps = ev.performers;
  for (let i = 0; i < ps.length; i++) {
    for (let j = i + 1; j < ps.length; j++) {
      const a = ps[i], b = ps[j];
      if (dayOf(ev, a) !== dayOf(ev, b)) continue;
      if (ignore.has(a.id + '|' + b.id) || ignore.has(b.id + '|' + a.id)) continue;
      const similar = nameSimilar(a.name, b.name);
      const sameSlot = a.start && a.start === b.start;
      if (similar) out.push({ a, b, why: sameSlot ? '名前がほぼ同じ・同じ枠' : '名前がほぼ同じ' });
      else if (sameSlot) out.push({ a, b, why: '同じ時刻の枠に2人' });
    }
  }
  return out;
}

function perfSummary(p) {
  const bits = [];
  if ((p.accounts || []).length) bits.push((p.accounts || []).map((a) => (PLATFORMS[a.platform] || PLATFORMS.other).short).join('・'));
  if (p.hashtags.length) bits.push(p.hashtags[0]);
  if (p.bio || p.youtube_about) bits.push('紹介あり');
  return bits.join(' / ') || '情報なし';
}

function renderCheck(ev) {
  const box = $('#checkCard');
  const days = Array.from(new Set(ev.performers.map((p) => dayOf(ev, p)))).sort();
  const count = (f) => ev.performers.filter(f).length;
  const dayCounts = days.map((d) => (d ? d.slice(5).replace('-', '/') : '日付なし') + '：' + count((p) => dayOf(ev, p) === d) + '人').join('　');
  const low = count((p) => p.confidence === 'low');
  const noSns = count((p) => !(p.accounts || []).length);
  const noTag = count((p) => !p.hashtags.length);
  const noIntro = count((p) => !p.bio && !p.youtube_about);
  const dups = findDuplicates(ev);
  const autoNotes = count((p) => noisyNote(p.note));

  let html = '<div class="check-sum"><b>合計 ' + ev.performers.length + '人</b>（' + esc(dayCounts) + '）</div>' +
    '<div class="small muted">要確認 ' + low + '・SNS なし ' + noSns + '・タグなし ' + noTag + '・紹介なし ' + noIntro + '</div>';

  html += '<div class="label">重複の候補</div>';
  if (!dups.length) {
    html += '<div class="small ok-text">重複の候補はありません</div>';
  } else {
    html += dups.map((d, i) => '<div class="dup">' +
      '<div class="small warn-text">' + esc(d.why) + '</div>' +
      ['a', 'b'].map((k) => '<div class="dup-row"><b>' + esc(d[k].name) + '</b> <span class="small muted">' +
        esc(d[k].start ? d[k].start + (d[k].end ? '–' + d[k].end : '') : '時刻なし') + '・' + esc(perfSummary(d[k])) + '</span></div>').join('') +
      '<div class="row">' +
      '<button type="button" class="btn" data-dupkeep="a" data-dup="' + i + '">「' + esc(d.a.name) + '」に まとめる</button>' +
      '<button type="button" class="btn" data-dupkeep="b" data-dup="' + i + '">「' + esc(d.b.name) + '」に まとめる</button>' +
      '<button type="button" class="btn" data-dupkeep="none" data-dup="' + i + '">別人</button></div></div>').join('');
  }
  state.dupCache = dups;

  html += '<div class="label">日別の出演順（タイムテーブルと見比べて抜けを確認）</div>';
  html += days.map((d) => {
    const list = ev.performers.filter((p) => dayOf(ev, p) === d).slice().sort((a, b) => (a.start || '99').localeCompare(b.start || '99'));
    let prevEnd = '';
    const rows = list.map((p) => {
      let pre = '';
      if (prevEnd && p.start && p.start > prevEnd) pre = '<div class="tl gap">… 空き ' + esc(prevEnd) + '–' + esc(p.start) + '</div>';
      const overlap = prevEnd && p.start && p.start < prevEnd;
      if (p.end) prevEnd = p.end;
      return pre + '<div class="tl' + (overlap ? ' overlap' : '') + '"><span class="tl-time">' + esc(p.start ? p.start + '–' + (p.end || '') : '--:--') + '</span> ' +
        esc(p.name) + (p.confidence === 'low' ? ' <span class="badge warn">要確認</span>' : '') + (overlap ? ' <span class="badge warn">時間が重なる</span>' : '') + '</div>';
    }).join('');
    return '<details><summary>' + esc(d ? d.slice(5).replace('-', '/') : '日付なし') + '（' + list.length + '人）</summary>' + rows + '</details>';
  }).join('');

  if (autoNotes) {
    html += '<div class="row"><button type="button" class="btn" id="btnCleanNotes">「未確認」などの自動メモを消す（' + autoNotes + '人）</button></div>';
  }
  box.innerHTML = html;
}

// Grok/Gemini が付けた「確認できない」系の自動メモか
function noisyNote(note) {
  return /未確認|確認できな|特定できず|見つから|外部検索/.test(String(note || ''));
}

function mergeDuplicate(i, keepKey) {
  const ev = activeEvent();
  const d = (state.dupCache || [])[i];
  if (!ev || !d) return;
  if (keepKey === 'none') {
    ev.notDup = (ev.notDup || []).concat(d.a.id + '|' + d.b.id);
    saveEvents();
    toast('別人として記録しました');
    render();
    return;
  }
  const keep = keepKey === 'a' ? d.a : d.b;
  const drop = keepKey === 'a' ? d.b : d.a;
  if (!confirm('「' + drop.name + '」の情報を「' + keep.name + '」にまとめて、「' + drop.name + '」を削除しますか？')) return;
  const keepName = keep.name;
  mergePerformer(keep, Object.assign({}, drop, { note: noisyNote(drop.note) ? '' : drop.note }));
  keep.name = keepName;
  ev.performers = ev.performers.filter((p) => p.id !== drop.id);
  state.posted.forEach((r) => { if (r.eventId === ev.id) r.performers = Array.from(new Set(r.performers.map((x) => (x === drop.id ? keep.id : x)))); });
  store.set(K.posted, state.posted);
  state.selected = state.selected.filter((x) => x !== drop.id);
  saveEvents();
  toast('「' + keep.name + '」にまとめました');
  render();
}

function cleanNotes() {
  const ev = activeEvent();
  if (!ev) return;
  let n = 0;
  ev.performers.forEach((p) => {
    if (!noisyNote(p.note)) return;
    // 「 / 」で区切られたメモのうち、自動メモの部分だけ消す
    const kept = p.note.split(' / ').filter((x) => !noisyNote(x)).join(' / ');
    if (kept !== p.note) { p.note = kept; n++; }
  });
  saveEvents();
  toast(n + '人のメモを整理しました');
  render();
}

// ------------------------------------------------------------------ 描画：イベントタブ
const PROMPT_FIELDS = ['gName', 'gDate', 'gDay', 'gUrl', 'gExtra'];
function promptForm() { const o = {}; PROMPT_FIELDS.forEach((id) => { o[id] = $('#' + id).value; }); return o; }
function renderEventTab() {
  const pf = store.get(K.promptForm, {});
  PROMPT_FIELDS.forEach((id) => { if (document.activeElement !== $('#' + id)) $('#' + id).value = pf[id] || ''; });

  $('#evList').innerHTML = state.events.length
    ? state.events.map((e) => {
      const low = e.performers.filter((p) => p.confidence === 'low').length;
      return '<div class="evrow' + (e.id === state.activeId ? ' active' : '') + '">' +
        '<div class="evmain"><div><b>' + esc(e.name) + '</b></div><div class="small muted">' + esc(e.date || '日付なし') + '・' + e.performers.length + '人' +
        (low ? '・<span class="badge warn">要確認 ' + low + '</span>' : '') + '</div></div>' +
        (e.id === state.activeId ? '' : '<button type="button" class="btn" data-evuse="' + esc(e.id) + '">使う</button>') +
        '<button type="button" class="btn" data-evexport="' + esc(e.id) + '">書き出し</button>' +
        '<button type="button" class="btn danger" data-evdel="' + esc(e.id) + '">削除</button></div>';
    }).join('')
    : '<div class="small muted">まだありません</div>';

  const ev = activeEvent();
  $('#perfHead').textContent = ev ? '出演者（' + ev.name + '）' : '出演者';
  $('#btnAddPerf').disabled = !ev;
  $('#btnEditEvent').disabled = !ev;
  if (!ev) { $('#perfEditList').innerHTML = ''; return; }
  const sorted = ev.performers.slice().sort((a, b) => (a.confidence === 'low' ? 0 : 1) - (b.confidence === 'low' ? 0 : 1) || (a.start || '99').localeCompare(b.start || '99'));
  $('#perfEditList').innerHTML =
    '<div class="small muted" style="margin:6px 0">共通タグ：' + esc(ev.hashtags.join(' ') || '（なし）') + '</div>' +
    sorted.map((p) => '<div class="pwrap"><button type="button" class="prow" data-editp="' + esc(p.id) + '">' +
      '<div class="pmain"><div class="pname">' + esc(p.name) + (p.confidence === 'low' ? '<span class="badge warn">要確認</span>' : '') + snsBadges(p) + '</div>' +
      '<div class="psub">' + esc(p.hashtags.join(' ') || 'タグなし') + (p.x_id ? '・@' + esc(p.x_id) : '') + (p.note ? '・' + esc(p.note) : '') + '</div></div>' +
      '<div class="pright">' + esc((p.date ? p.date.slice(5).replace('-', '/') + ' ' : '') + (p.start ? p.start + (p.end ? '–' + p.end : '') : '')) + '<br>編集 ›</div></button>' +
      '<button type="button" class="pinfo" data-info="' + esc(p.id) + '" aria-label="紹介を見る">ⓘ</button></div>').join('');
  renderGeminiCard(ev);
  renderCheck(ev);
}

function openPerfDialog(perfId) {
  const ev = activeEvent();
  if (!ev) return;
  const p = ev.performers.find((x) => x.id === perfId) || normalizePerformer({ confidence: 'high' }, ev.performers.length);
  state.editingPerfId = perfId || null;
  const f = $('#formPerf');
  $('#dlgPerfTitle').textContent = perfId ? '出演者を編集' : '出演者を追加';
  f.elements.name.value = p.name; f.elements.reading.value = p.reading; f.elements.hashtags.value = p.hashtags.join(' ');
  const accOf = (k) => (p.accounts || []).filter((a) => a.platform === k).map((a) => (k === 'youtube' || k === 'other') ? a.url : a.id).join(' ');
  f.elements.x_id.value = accOf('x'); f.elements.instagram.value = accOf('instagram'); f.elements.tiktok.value = accOf('tiktok');
  f.elements.youtube.value = accOf('youtube'); f.elements.otherlinks.value = (p.accounts || []).filter((a) => ['twitch', 'linkhub', 'other'].includes(a.platform)).map((a) => a.url).join(' ');
  f.elements.bio.value = p.bio || ''; f.elements.youtube_about.value = p.youtube_about || '';
  f.elements.start.value = p.start; f.elements.end.value = p.end; f.elements.date.value = p.date;
  f.elements.stage.value = p.stage; f.elements.confidence.value = p.confidence; f.elements.note.value = p.note;
  $('#btnDelPerf').hidden = !perfId;
  $('#dlgPerf').returnValue = '';
  $('#dlgPerf').showModal();
}

function splitWords(s) { return String(s || '').split(/[\s,、]+/).map((x) => x.trim()).filter(Boolean); }

function savePerfDialog() {
  const ev = activeEvent();
  if (!ev) return;
  const f = $('#formPerf');
  const before = ev.performers.find((p) => p.id === state.editingPerfId) || {};
  const data = normalizePerformer({
    id: state.editingPerfId || undefined,
    source_url: before.source_url || '',
    name: f.elements.name.value, reading: f.elements.reading.value, hashtags: f.elements.hashtags.value,
    accounts: [].concat(
      splitWords(f.elements.x_id.value).map((v) => ({ platform: 'x', id: v })),
      splitWords(f.elements.instagram.value).map((v) => ({ platform: 'instagram', id: v })),
      splitWords(f.elements.tiktok.value).map((v) => ({ platform: 'tiktok', id: v })),
      splitWords(f.elements.youtube.value).map((v) => (/^https?:/i.test(v) ? { platform: 'youtube', url: v } : { platform: 'youtube', id: v })),
      splitWords(f.elements.otherlinks.value).map((v) => (/^https?:/i.test(v) ? v : 'https://' + v))),
    bio: f.elements.bio.value, youtube_about: f.elements.youtube_about.value,
    start: f.elements.start.value, end: f.elements.end.value, date: f.elements.date.value, stage: f.elements.stage.value,
    confidence: f.elements.confidence.value, note: f.elements.note.value,
  }, ev.performers.length);
  if (!data.name) { toast('名前を入れてください'); return; }
  if (state.editingPerfId) ev.performers = ev.performers.map((p) => (p.id === state.editingPerfId ? data : p));
  else ev.performers.push(data);
  saveEvents();
  toast('保存しました');
  render();
}

// ------------------------------------------------------------------ 描画：設定タブ
function renderSettings() {
  const s = state.settings;
  $('#sTemplate').value = s.template;
  $('#sHonorific').value = s.honorific;
  $('#sSep').value = s.nameSep;
  $('#sTagMode').value = s.tagMode;
  $('#sAutoSave').checked = s.autoSave !== false;
  $('#about').textContent = 'EventSnap v' + APP_VERSION + '・イベント ' + state.events.length + ' 件・投稿記録 ' + state.posted.length + ' 件';
}

// ------------------------------------------------------------------ 写真
function isVideo(it) { return /^video\//.test(it.file.type) || /\.(mp4|mov|webm|3gp|m4v)$/i.test(it.file.name); }

function addPhotos(files, opts) {
  opts = opts || {};
  const list = Array.from(files || []).filter((f) => /^(image|video)\//.test(f.type) || /\.(jpe?g|png|heic|heif|webp|mp4|mov|webm|3gp|m4v)$/i.test(f.name));
  if (!list.length) return;
  list.sort((a, b) => a.lastModified - b.lastModified);
  const firstNew = state.queue.length;
  for (const f of list) {
    const item = { id: uid('q'), file: f, url: URL.createObjectURL(f), time: f.lastModified || Date.now(), done: false };
    state.queue.push(item);
    mediaStore.put(item);
  }
  if (opts.quiet) { if (!state.pick.length) state.pick.push(state.queue[firstNew].id); state.current = state.queue.length - 1; return; }
  state.current = firstNew;
  if (!state.pick.length) state.pick.push(state.queue[firstNew].id);
  render();
  if (list.length > 1) toast(list.length + ' 枚を追加しました。使う写真を選んでください（最大4枚）', 2500);
}

function removeCurrentPhoto() {
  const it = state.queue[state.current];
  if (!it) return;
  URL.revokeObjectURL(it.url);
  mediaStore.del(it.id);
  state.pick = state.pick.filter((id) => id !== it.id);
  state.queue.splice(state.current, 1);
  state.current = Math.min(state.current, state.queue.length - 1);
  render();
}

function nextPhoto() {
  const idx = state.queue.findIndex((x) => !x.done);
  if (idx >= 0) { state.current = idx; state.pick = [state.queue[idx].id]; resetDraft(); return true; }
  return false;
}

// ------------------------------------------------------------------ コピー・投稿
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e2) { ok = false; }
    document.body.removeChild(ta);
    return ok;
  }
}

function recordPosted(ev) {
  state.posted.push({ eventId: ev.id, performers: state.selected.slice(), at: new Date().toISOString() });
  store.set(K.posted, state.posted);
}

async function sharePost() {
  const ev = activeEvent();
  if (!ev) { toast('先にイベントを登録してください'); return; }
  if (!state.selected.length) { toast('出演者を選んでください'); return; }
  const text = buildDraft(ev);
  let items = state.pick.map((id) => state.queue.find((q) => q.id === id)).filter(Boolean);
  if (!items.length && state.queue[state.current]) items = [state.queue[state.current]];
  const copied = await copyText(text);   // 共有先で本文が消えた時の保険

  const data = { text };
  if (items.length) data.files = items.map((x) => x.file);
  const canShare = navigator.share && (!data.files || (navigator.canShare && navigator.canShare({ files: data.files })));

  if (canShare) {
    try {
      await navigator.share(data);
      afterPosted(ev, items, copied);
    } catch (e) {
      if (e && e.name === 'AbortError') toast('共有をキャンセルしました' + (copied ? '（本文はコピー済み）' : ''));
      else toast('共有できませんでした。本文はコピー済みです');
    }
    return;
  }
  // 共有に対応していない環境（PC など）：本文だけ X の投稿画面に渡す
  window.open('https://x.com/intent/post?text=' + encodeURIComponent(text), '_blank');
  toast(items.length ? '画像は X の画面で手動で添付してください' : 'X の投稿画面を開きました', 3000);
  afterPosted(ev, items, copied);
}

function afterPosted(ev, items, copied) {
  recordPosted(ev);
  items.forEach((x) => { x.done = true; mediaStore.put(x); });
  state.pick = [];
  const moved = items.length ? nextPhoto() : false;
  if (!moved) resetDraft();
  render();
  toast(moved ? '投稿済みにしました。次の写真へ' : '投稿済みにしました' + (copied ? '（本文はクリップボードにもあります）' : ''), 2500);
}

// ------------------------------------------------------------------ イベント操作
function exportEvent(id) {
  const e = state.events.find((x) => x.id === id);
  if (!e) return;
  const obj = {
    schema: SCHEMA,
    event: { name: e.name, date: e.date, venue: e.venue, hashtags: e.hashtags, source_urls: e.source_urls },
    performers: e.performers.map(({ id: _id, ...rest }) => rest),
  };
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'event-snap_' + (e.date || 'nodate') + '_' + e.name.replace(/[\\/:*?"<>|\s]+/g, '_') + '.json';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

// ---- Gemini で補完（YouTube 紹介・X 以外の SNS・要確認の人の再調査）
function geminiTargets(ev) {
  const mode = $('#gemTarget').value;
  const day = $('#gemDay').value;
  const limit = Number($('#gemLimit').value) || 0;
  const list = ev.performers.filter((p) => {
    if (day && (p.date || ev.date) !== day) return false;
    if (mode === 'all') return true;
    if (mode === 'intro') return !p.bio || !p.youtube_about;
    return p.confidence === 'low' || !(p.accounts || []).length || !p.hashtags.length;
  });
  return limit ? list.slice(0, limit) : list;
}

function renderGeminiCard(ev) {
  const sel = $('#gemDay');
  const days = Array.from(new Set(ev.performers.map((p) => p.date || ev.date).filter(Boolean))).sort();
  const cur = sel.value;
  sel.innerHTML = '<option value="">すべての日</option>' + days.map((d) => '<option value="' + esc(d) + '">' + esc(d) + '</option>').join('');
  if (days.includes(cur)) sel.value = cur;
  const n = geminiTargets(ev).length;
  $('#gemCount').textContent = '対象 ' + n + ' 人' + (n > 10 ? '（10人以下に分けると検索してくれやすい）' : '');
  $('#btnGemini').disabled = !n;
}

async function copyGeminiPrompt() {
  const ev = activeEvent();
  if (!ev) return;
  const targets = geminiTargets(ev);
  if (!targets.length) { toast('対象の出演者がいません'); return; }
  let tpl;
  try {
    tpl = await (await fetch('gemini-prompt.txt', { cache: 'no-cache' })).text();
  } catch (e) {
    toast('プロンプトを読み込めませんでした（オンラインで一度開いてください）');
    return;
  }
  const mode = $('#gemTarget').value;
  const task = mode === 'intro'
    ? '各出演者のプロフィール文（bio）と YouTube チャンネル紹介の要約（youtube_about）を中心に調べる。SNS アカウントやハッシュタグが空なら、それも埋める'
    : mode === 'all'
      ? '各出演者の SNS アカウント・ハッシュタグ・プロフィール文・YouTube チャンネル紹介をすべて確認し、空欄を埋める'
      : 'SNS アカウント・ハッシュタグが未確認の出演者について、X 以外（Instagram・TikTok・YouTube 等）も含めて探す。あわせてプロフィール文と YouTube 紹介も調べる';
  const list = targets.map((p) => ({
    name: p.name, reading: p.reading, date: p.date || ev.date, start: p.start,
    accounts: (p.accounts || []).map((a) => ({ platform: a.platform, id: a.id || a.url })),
    hashtags: p.hashtags, note: p.note,
  }));
  const pf = store.get(K.promptForm, {});
  const text = tpl
    .replace(/\{\{EVENT_NAME\}\}/g, ev.name)
    .replace(/\{\{EVENT_DATE\}\}/g, ev.date || '（不明）')
    .replace(/\{\{EVENT_URL\}\}/g, pf.gUrl || '（なし）')
    .replace(/\{\{TASK\}\}/g, task)
    .replace(/\{\{TARGETS_JSON\}\}/g, JSON.stringify(list, null, 1));
  toast((await copyText(text)) ? targets.length + '人分のプロンプトをコピーしました。Gemini に貼り付けてください' : 'コピーできませんでした', 2500);
}

async function copyGrokPrompt() {
  const form = promptForm();
  store.set(K.promptForm, form);
  let tpl;
  try {
    tpl = await (await fetch('grok-prompt.txt', { cache: 'no-cache' })).text();
  } catch (e) {
    toast('プロンプトを読み込めませんでした（オンラインで一度開いてください）');
    return;
  }
  const text = tpl
    .replace(/\{\{EVENT_NAME\}\}/g, form.gName || '（未記入）')
    .replace(/\{\{EVENT_DATE\}\}/g, form.gDate || '（未記入）')
    .replace(/\{\{EVENT_URL\}\}/g, form.gUrl || '（なし。添付画像を参照）')
    .replace(/\{\{TARGET_DAY\}\}/g, form.gDay || '全日程')
    .replace(/\{\{EXTRA\}\}/g, form.gExtra || '（なし）');
  toast((await copyText(text)) ? 'プロンプトをコピーしました。Grok に貼り付けてください' : 'コピーできませんでした', 2500);
}

// ------------------------------------------------------------------ イベント登録（ボタン等）
function bind() {
  document.querySelectorAll('.tabbar button').forEach((b) => b.addEventListener('click', () => go(b.dataset.go)));

  $('#evSelect').addEventListener('change', (e) => { state.activeId = e.target.value; saveEvents(); resetDraft(); render(); });

  $('#inCamera').addEventListener('change', (e) => { addPhotos(e.target.files); e.target.value = ''; });
  $('#inGallery').addEventListener('change', (e) => { addPhotos(e.target.files); e.target.value = ''; });
  bindCamera();

  $('#queue').addEventListener('click', (e) => {
    const b = e.target.closest('[data-q]');
    if (!b) return;
    state.current = Number(b.dataset.q);
    renderQueue();
  });
  $('#preview').addEventListener('click', (e) => {
    if (e.target.id === 'btnRemovePhoto') removeCurrentPhoto();
    if (e.target.id === 'btnClearDone') clearDonePhotos();
    if (e.target.id === 'btnSaveMedia') { const it = state.queue[state.current]; if (it) { downloadFile(it.file); toast('ダウンロードフォルダに保存しました'); } }
    if (e.target.closest('#btnPick')) { const it = state.queue[state.current]; if (it) togglePick(it.id); }
  });

  $('#pSearch').addEventListener('input', (e) => { state.query = e.target.value; renderPerformers(activeEvent()); });

  $('#pList').addEventListener('click', (e) => {
    const info = e.target.closest('[data-info]');
    if (info) { openInfo(info.dataset.info); return; }
    const b = e.target.closest('[data-pid]');
    if (!b) return;
    const id = b.dataset.pid;
    state.selected = state.selected.includes(id) ? state.selected.filter((x) => x !== id) : state.selected.concat(id);
    if (state.query) { state.query = ''; $('#pSearch').value = ''; }
    renderPost();
  });
  $('#selChips').addEventListener('click', (e) => {
    const b = e.target.closest('[data-unsel]');
    if (!b) return;
    state.selected = state.selected.filter((x) => x !== b.dataset.unsel);
    renderPost();
  });
  $('#tagChips').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tag]');
    if (!b) return;
    state.tagOverride[b.dataset.tag] = b.dataset.on !== '1';
    renderDraft(activeEvent());
  });
  $('#comment').addEventListener('input', () => renderDraft(activeEvent()));

  $('#btnCopy').addEventListener('click', async () => {
    const ev = activeEvent();
    if (!ev) return;
    toast((await copyText(buildDraft(ev))) ? '本文をコピーしました' : 'コピーできませんでした');
  });
  $('#btnShare').addEventListener('click', sharePost);

  // イベントタブ
  $('#btnPrompt').addEventListener('click', copyGrokPrompt);
  PROMPT_FIELDS.forEach((id) => $('#' + id).addEventListener('change', () => store.set(K.promptForm, promptForm())));
  $('#btnGemini').addEventListener('click', copyGeminiPrompt);
  ['gemTarget', 'gemDay', 'gemLimit'].forEach((id) => $('#' + id).addEventListener('change', () => { const ev = activeEvent(); if (ev) renderGeminiCard(ev); }));
  $('#btnImport').addEventListener('click', async () => {
    try {
      const r = await importEventObject(extractJson($('#importText').value));
      if (r) {
        $('#importText').value = '';
        toast(importMessage(r), 3500);
        render();
      }
    } catch (e) {
      toast('読み込めませんでした：' + e.message, 3000);
    }
  });
  $('#inImportFile').addEventListener('change', async (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      const r = await importEventObject(extractJson(await f.text()));
      if (r) { toast(importMessage(r), 3500); render(); }
    } catch (err) {
      toast('読み込めませんでした：' + err.message, 3000);
    }
  });
  $('#btnSample1').addEventListener('click', loadSample);
  $('#btnSample2').addEventListener('click', loadSample);

  $('#evList').addEventListener('click', (e) => {
    const use = e.target.closest('[data-evuse]');
    const exp = e.target.closest('[data-evexport]');
    const del = e.target.closest('[data-evdel]');
    if (use) { state.activeId = use.dataset.evuse; saveEvents(); resetDraft(); render(); }
    if (exp) exportEvent(exp.dataset.evexport);
    if (del) {
      const ev = state.events.find((x) => x.id === del.dataset.evdel);
      if (ev && confirm('「' + ev.name + '」を削除しますか？（この端末から消えます）')) {
        state.events = state.events.filter((x) => x.id !== ev.id);
        state.posted = state.posted.filter((r) => r.eventId !== ev.id);
        store.set(K.posted, state.posted);
        if (state.activeId === ev.id) state.activeId = state.events.length ? state.events[0].id : null;
        saveEvents();
        resetDraft();
        render();
      }
    }
  });
  $('#checkCard').addEventListener('click', (e) => {
    const b = e.target.closest('[data-dupkeep]');
    if (b) { mergeDuplicate(Number(b.dataset.dup), b.dataset.dupkeep); return; }
    if (e.target.id === 'btnCleanNotes') cleanNotes();
  });
  $('#perfEditList').addEventListener('click', (e) => {
    const info = e.target.closest('[data-info]');
    if (info) { openInfo(info.dataset.info); return; }
    const b = e.target.closest('[data-editp]');
    if (b) openPerfDialog(b.dataset.editp);
  });
  $('#btnAddPerf').addEventListener('click', () => openPerfDialog(null));
  $('#btnInfoSelect').addEventListener('click', () => {
    const id = state.infoPerfId;
    if (!id) return;
    state.selected = state.selected.includes(id) ? state.selected.filter((x) => x !== id) : state.selected.concat(id);
    $('#dlgInfo').close();
    if (state.tab !== 'post') go('post'); else renderPost();
  });
  $('#btnInfoEdit').addEventListener('click', () => { const id = state.infoPerfId; $('#dlgInfo').close(); openPerfDialog(id); });
  $('#btnInfoClose').addEventListener('click', () => $('#dlgInfo').close());
  $('#dlgPerf').addEventListener('close', () => { if ($('#dlgPerf').returnValue === 'save') savePerfDialog(); });
  $('#btnDelPerf').addEventListener('click', () => {
    const ev = activeEvent();
    if (!ev || !state.editingPerfId) return;
    if (!confirm('この出演者を削除しますか？')) return;
    ev.performers = ev.performers.filter((p) => p.id !== state.editingPerfId);
    state.selected = state.selected.filter((x) => x !== state.editingPerfId);
    saveEvents();
    $('#dlgPerf').close('deleted');
    render();
  });

  $('#btnEditEvent').addEventListener('click', () => {
    const ev = activeEvent();
    if (!ev) return;
    const f = $('#formEvent');
    f.elements.name.value = ev.name; f.elements.date.value = ev.date; f.elements.venue.value = ev.venue; f.elements.hashtags.value = ev.hashtags.join(' ');
    $('#dlgEvent').returnValue = '';
    $('#dlgEvent').showModal();
  });
  $('#dlgEvent').addEventListener('close', () => {
    if ($('#dlgEvent').returnValue !== 'save') return;
    const ev = activeEvent();
    if (!ev) return;
    const f = $('#formEvent');
    ev.name = f.elements.name.value.trim() || ev.name;
    ev.date = normDate(f.elements.date.value);
    ev.venue = f.elements.venue.value.trim();
    ev.hashtags = normTags(f.elements.hashtags.value);
    saveEvents();
    render();
  });

  // 設定タブ
  $('#btnSaveSettings').addEventListener('click', () => {
    state.settings = {
      template: $('#sTemplate').value || DEFAULT_SETTINGS.template,
      honorific: $('#sHonorific').value,
      nameSep: $('#sSep').value,
      tagMode: $('#sTagMode').value,
      autoSave: $('#sAutoSave').checked,
    };
    store.set(K.settings, state.settings);
    toast('保存しました');
  });
  $('#btnResetSettings').addEventListener('click', () => {
    state.settings = Object.assign({}, DEFAULT_SETTINGS);
    store.set(K.settings, state.settings);
    renderSettings();
    toast('初期値に戻しました');
  });
  $('#btnClearPosted').addEventListener('click', () => {
    if (!confirm('投稿済みの記録（✓の数）をすべて消しますか？')) return;
    state.posted = [];
    store.set(K.posted, state.posted);
    render();
    toast('消しました');
  });

  // 出演中の表示を1分ごとに更新
  setInterval(() => { if (state.tab === 'post') renderPerformers(activeEvent()); }, 60000);
}

// ------------------------------------------------------------------ 写真・動画の保存（IndexedDB）
// アプリが閉じられても（X に切り替えた時など）撮った写真が消えないよう、端末のブラウザ内に保存する
const mediaStore = {
  db: null,
  open() {
    if (this.db) return Promise.resolve(this.db);
    return new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) { reject(new Error('no indexedDB')); return; }
      const req = indexedDB.open('eventsnap', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('media', { keyPath: 'id' });
      req.onsuccess = () => { this.db = req.result; resolve(this.db); };
      req.onerror = () => reject(req.error);
    });
  },
  async tx(mode, fn) {
    try {
      const db = await this.open();
      return await new Promise((resolve, reject) => {
        const t = db.transaction('media', mode);
        const r = fn(t.objectStore('media'));
        t.oncomplete = () => resolve(r && r.result);
        t.onerror = () => reject(t.error);
      });
    } catch (e) { return null; }
  },
  put(it) {
    return this.tx('readwrite', (st) => st.put({ id: it.id, blob: it.file, name: it.file.name, type: it.file.type, time: it.time, done: !!it.done }));
  },
  del(id) { return this.tx('readwrite', (st) => st.delete(id)); },
  async loadAll() {
    const rows = (await this.tx('readonly', (st) => st.getAll())) || [];
    return rows.map((r) => {
      const file = new File([r.blob], r.name || (r.id + '.jpg'), { type: r.type || r.blob.type, lastModified: r.time });
      return { id: r.id, file, url: URL.createObjectURL(file), time: r.time, done: !!r.done };
    });
  },
};

function downloadFile(file) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}

// ------------------------------------------------------------------ 連写カメラ
const cam = {
  stream: null, track: null, imageCapture: null, audioTrack: null,
  mode: 'photo', quality: 'fast', count: 0,
  recorder: null, chunks: [], recStart: 0, timer: null, busy: false,
};

function stamp(d) { return d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + '_' + pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds()); }

async function openCamera() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    toast('この環境では連写カメラを使えません。端末のカメラで撮ってください', 3000);
    $('#inCamera').click();
    return;
  }
  $('#cam').hidden = false;
  cam.count = 0;
  $('#camCount').textContent = '';
  $('#camThumb').innerHTML = '';
  setCamMode('photo');
  try {
    cam.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 } },
      audio: false,
    });
  } catch (e) {
    $('#cam').hidden = true;
    toast('カメラを起動できませんでした（' + (e.name || e.message) + '）。ブラウザのカメラ許可を確認してください', 4000);
    return;
  }
  cam.track = cam.stream.getVideoTracks()[0];
  $('#camVideo').srcObject = cam.stream;
  cam.imageCapture = null;
  if ('ImageCapture' in window) { try { cam.imageCapture = new ImageCapture(cam.track); } catch (e) { cam.imageCapture = null; } }
  $('#camQuality').hidden = !cam.imageCapture;
  setupZoom();
  updateCamInfo();
}

function setupZoom() {
  const box = $('#camZoom');
  box.innerHTML = '';
  const caps = cam.track && cam.track.getCapabilities ? cam.track.getCapabilities() : {};
  if (!caps.zoom) return;
  const min = caps.zoom.min, max = caps.zoom.max;
  const steps = Array.from(new Set([min, 1, 2, 3, 5, 10, max].filter((z) => z >= min && z <= max).map((z) => Math.round(z * 10) / 10))).sort((a, b) => a - b);
  const cur = (cam.track.getSettings && cam.track.getSettings().zoom) || 1;
  box.innerHTML = steps.map((z) => '<button type="button" data-zoom="' + z + '" class="' + (Math.abs(z - cur) < 0.05 ? 'on' : '') + '">' + z + '×</button>').join('');
}

function updateCamInfo() {
  const st = cam.track && cam.track.getSettings ? cam.track.getSettings() : {};
  const res = st.width && st.height ? st.width + '×' + st.height : '';
  if (cam.recorder && cam.recorder.state === 'recording') return;
  $('#camInfo').classList.remove('rec');
  $('#camInfo').textContent = (cam.mode === 'photo' ? '写真' : '動画') + (res ? '・' + res : '') + (cam.count ? '・' + cam.count + '件撮影' : '');
}

function setCamMode(m) {
  if (cam.recorder && cam.recorder.state === 'recording') return;
  cam.mode = m;
  document.querySelectorAll('[data-cammode]').forEach((b) => b.classList.toggle('on', b.dataset.cammode === m));
  $('#camShutter').classList.toggle('video', m === 'video');
  updateCamInfo();
}

function flash() {
  const f = $('#camFlash');
  f.classList.add('on');
  setTimeout(() => f.classList.remove('on'), 80);
  if (navigator.vibrate) navigator.vibrate(20);
}

function camAdd(file) {
  addPhotos([file], { quiet: true });
  cam.count++;
  $('#camCount').textContent = cam.count;
  const url = state.queue[state.queue.length - 1].url;
  $('#camThumb').innerHTML = /^video\//.test(file.type) ? '<video src="' + url + '#t=0.1" muted></video>' : '<img src="' + url + '" alt="">';
  if (state.settings.autoSave !== false) downloadFile(file);
  updateCamInfo();
}

async function takeShot() {
  if (cam.busy || !cam.track) return;
  cam.busy = true;
  flash();
  try {
    let blob = null;
    if (cam.quality === 'high' && cam.imageCapture) {
      try { blob = await cam.imageCapture.takePhoto(); } catch (e) { blob = null; }
    }
    if (!blob) {
      const v = $('#camVideo');
      const c = document.createElement('canvas');
      c.width = v.videoWidth; c.height = v.videoHeight;
      c.getContext('2d').drawImage(v, 0, 0);
      blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.92));
    }
    if (!blob) throw new Error('撮影できませんでした');
    const now = new Date();
    camAdd(new File([blob], 'eventsnap_' + stamp(now) + '_' + (cam.count + 1) + '.jpg', { type: 'image/jpeg', lastModified: now.getTime() }));
  } catch (e) {
    toast(e.message || '撮影できませんでした');
  } finally {
    cam.busy = false;
  }
}

function pickVideoMime() {
  const list = ['video/mp4;codecs=avc1,mp4a', 'video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm'];
  return list.find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || '';
}

async function toggleRecord() {
  if (cam.recorder && cam.recorder.state === 'recording') { cam.recorder.stop(); return; }
  if (!window.MediaRecorder) { toast('この端末では動画を撮れません'); return; }
  if (!cam.audioTrack) {
    try { cam.audioTrack = (await navigator.mediaDevices.getUserMedia({ audio: true })).getAudioTracks()[0]; } catch (e) { cam.audioTrack = null; }
  }
  const tracks = [cam.track].concat(cam.audioTrack ? [cam.audioTrack] : []);
  const mime = pickVideoMime();
  cam.chunks = [];
  try {
    cam.recorder = new MediaRecorder(new MediaStream(tracks), mime ? { mimeType: mime } : undefined);
  } catch (e) { toast('録画を開始できませんでした'); return; }
  cam.recorder.ondataavailable = (e) => { if (e.data && e.data.size) cam.chunks.push(e.data); };
  cam.recorder.onstop = () => {
    clearInterval(cam.timer);
    $('#camShutter').classList.remove('recording');
    const type = (cam.recorder.mimeType || mime || 'video/webm').split(';')[0];
    const ext = type.includes('mp4') ? 'mp4' : 'webm';
    const now = new Date();
    if (cam.chunks.length) camAdd(new File(cam.chunks, 'eventsnap_' + stamp(now) + '.' + ext, { type, lastModified: now.getTime() }));
    if (ext !== 'mp4') toast('この端末では WebM 形式で保存されました（X に投稿できない場合があります）', 4000);
    updateCamInfo();
  };
  cam.recorder.start(1000);
  cam.recStart = Date.now();
  $('#camShutter').classList.add('recording');
  const info = $('#camInfo');
  info.classList.add('rec');
  const tick = () => { const s = Math.floor((Date.now() - cam.recStart) / 1000); info.textContent = '● 録画中 ' + Math.floor(s / 60) + ':' + pad2(s % 60); };
  tick();
  cam.timer = setInterval(tick, 500);
}

async function closeCamera() {
  if (cam.recorder && cam.recorder.state === 'recording') {
    await new Promise((r) => { const prev = cam.recorder.onstop; cam.recorder.onstop = () => { prev(); r(); }; cam.recorder.stop(); });
  }
  if (cam.stream) cam.stream.getTracks().forEach((t) => t.stop());
  if (cam.audioTrack) { cam.audioTrack.stop(); cam.audioTrack = null; }
  cam.stream = null; cam.track = null;
  $('#camVideo').srcObject = null;
  $('#cam').hidden = true;
  render();
  if (cam.count) toast(cam.count + '件を追加しました。使う写真を選んでください（最大4枚）', 2500);
}

function bindCamera() {
  $('#btnCam').addEventListener('click', openCamera);
  $('#camClose').addEventListener('click', closeCamera);
  $('#camDone').addEventListener('click', closeCamera);
  $('#camShutter').addEventListener('click', () => (cam.mode === 'photo' ? takeShot() : toggleRecord()));
  document.querySelectorAll('[data-cammode]').forEach((b) => b.addEventListener('click', () => setCamMode(b.dataset.cammode)));
  $('#camQuality').addEventListener('click', () => {
    cam.quality = cam.quality === 'fast' ? 'high' : 'fast';
    $('#camQuality').textContent = cam.quality === 'fast' ? '標準' : '高画質';
    toast(cam.quality === 'fast' ? '標準：すばやく連写できます' : '高画質：1枚ごとに少し時間がかかります');
  });
  $('#camZoom').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-zoom]');
    if (!b || !cam.track) return;
    try { await cam.track.applyConstraints({ advanced: [{ zoom: Number(b.dataset.zoom) }] }); } catch (err) { /* 非対応 */ }
    setupZoom();
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden && cam.stream && !(cam.recorder && cam.recorder.state === 'recording')) closeCamera(); });
}

// ------------------------------------------------------------------ 起動
// v0.1 で保存したデータ（x_id だけ）を、SNS アカウント一覧の形に移す
function migrate() {
  let changed = false;
  for (const ev of state.events) {
    for (const p of ev.performers) {
      if (!Array.isArray(p.accounts)) { p.accounts = normAccounts(p); changed = true; }
      if (p.bio == null) { p.bio = ''; changed = true; }
      if (p.youtube_about == null) { p.youtube_about = ''; changed = true; }
    }
  }
  if (changed) saveEvents();
}
migrate();
bind();
go('post');
mediaStore.loadAll().then((items) => {
  if (!items.length) return;
  for (const it of items) state.queue.push(it);
  state.queue.sort((a, b) => a.time - b.time);
  const idx = state.queue.findIndex((x) => !x.done);
  state.current = idx >= 0 ? idx : state.queue.length - 1;
  if (idx >= 0) state.pick = [state.queue[idx].id];
  render();
  const n = items.filter((x) => !x.done).length;
  if (n) toast('前回の写真・動画 ' + n + ' 件を読み込みました');
});
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
