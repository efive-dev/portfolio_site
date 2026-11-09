// Home page logic: connects the 3D room, the navigation, the side panels and the big blog reader.
//   #about #work #experience #contact  -> side panel (content comes from the HTML in index.html)
//   #blog and #blog/<slug>             -> big reader: post history on the left, selected post on the right
//   #home                              -> back to the room
import { startRoom } from './room.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const base = document.body.dataset.base || '';
const root = document.documentElement;
const cfg = JSON.parse($('#room-config').textContent);
const DEV = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);

const PANELS = ['about', 'work', 'experience', 'contact'];
const ROOM_KEY = { about: 'about', work: 'projects', experience: 'experience', blog: 'blog', contact: 'contact' };   // site section -> hotspot in the room
const SITE_KEY = Object.fromEntries(Object.entries(ROOM_KEY).map(([a, b]) => [b, a]));
const LABEL = { about: 'About', work: 'Work', experience: 'Career', blog: 'Blog', contact: 'Contact' };

let room = null;
let current = 'home';
let posts = null;
let readerOpen = false;
const markers = {};

// ---------------------------------------------------------------- theme
const themeName = () => (root.getAttribute('data-theme') === 'day' ? 'day' : 'night');
function setTheme(name, instant = false) {
  root.setAttribute('data-theme', name);
  try { localStorage.setItem('theme', name); } catch (e) { /* private mode */ }
  $('#theme').setAttribute('aria-pressed', name === 'night');
  if (room) room.setTheme(name, instant);
}

// ---------------------------------------------------------------- side panel
function openPanel(key) {
  const src = document.getElementById(key);
  if (!src) return;
  $('#panel-body').innerHTML = src.innerHTML;
  const p = $('#panel');
  p.classList.add('open');
  p.setAttribute('aria-hidden', 'false');
  p.scrollTop = 0;
  if (room) room.setViewShift(innerWidth > 900 ? Math.min(560, innerWidth * 0.5) / 2 : 0);
}
function closePanel() {
  const p = $('#panel');
  p.classList.remove('open');
  p.setAttribute('aria-hidden', 'true');
  if (room) room.setViewShift(0);
}

// ---------------------------------------------------------------- blog reader (big screen)
async function ensurePosts() {
  if (posts) return posts;
  try {
    const r = await fetch(`${base}/blog/posts.json`, { cache: 'no-cache' });
    if (!r.ok) throw new Error(r.status);
    posts = await r.json();
  } catch (err) {
    console.warn('blog feed unavailable', err);
    return null;
  }
  return posts;
}

function renderList() {
  $('#reader-items').innerHTML = posts.length
    ? posts.map((p) => `<li><button type="button" data-slug="${esc(p.slug)}"><time datetime="${esc(p.date)}">${esc(p.dateLabel)}</time>` +
        `<span class="t">${esc(p.title)}</span><span class="d">${esc(p.description)}</span></button></li>`).join('')
    : '<li class="empty">No posts yet.</li>';
}

function selectPost(slug, push = true) {
  const art = $('#reader-article');
  const i = Math.max(0, posts.findIndex((p) => p.slug === slug));
  const p = posts[i];
  if (!p) { art.innerHTML = '<p class="lead">No posts yet.</p>'; return; }
  $$('#reader-items button').forEach((b) => b.setAttribute('aria-current', b.dataset.slug === p.slug));
  const newer = posts[i - 1], older = posts[i + 1];
  art.innerHTML =
    `<button type="button" class="reader-back" data-act="list">&larr; All posts</button>` +
    `<p class="meta"><time datetime="${esc(p.date)}">${esc(p.dateLabel)}</time>${(p.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</p>` +
    `<h1>${esc(p.title)}</h1>` +
    (p.description ? `<p class="lead">${esc(p.description)}</p>` : '') +
    `<div class="prose">${p.content}</div>` +
    `<div class="reader-foot">` +
      (newer ? `<button type="button" class="btn btn-dark" data-slug="${esc(newer.slug)}"><span class="arrow">[ &larr; ]</span> ${esc(newer.title)}</button>` : '<span></span>') +
      (older ? `<button type="button" class="btn btn-dark" data-slug="${esc(older.slug)}">${esc(older.title)} <span class="arrow">[ &rarr; ]</span></button>` : '') +
    `</div>`;
  $('#reader').dataset.view = 'post';
  art.scrollTop = 0;
  if (push) history.pushState(null, '', `#blog/${p.slug}`);
}

async function openReader(slug) {
  const list = await ensurePosts();
  if (list === null) { location.href = `${base}/blog/`; return; }      // no feed: fall back to the plain blog page
  const reader = $('#reader');
  renderList();
  selectPost(slug || (list[0] && list[0].slug), false);
  if (!slug && innerWidth <= 900) reader.dataset.view = 'list';        // phones: show the history first
  reader.classList.add('open');
  reader.setAttribute('aria-hidden', 'false');
  readerOpen = true;
  if (room) { room.focus('blog'); setTimeout(() => { if (readerOpen) room.setPaused(true); }, 700); }
  $('#reader-close').focus({ preventScroll: true });
}
function closeReader() {
  if (!readerOpen) return;
  const reader = $('#reader');
  reader.classList.remove('open');
  reader.setAttribute('aria-hidden', 'true');
  readerOpen = false;
  if (room) room.setPaused(false);
}

// ---------------------------------------------------------------- routing
function setHash(h, push) {
  const want = h ? `#${h}` : '';
  if (!push || location.hash === want) return;
  history.pushState(null, '', want || location.pathname + location.search);
}

function go(key, { push = true, slug = null } = {}) {
  if (!key || key === 'home') {
    closePanel(); closeReader();
    if (room) room.overview();
    current = 'home';
    setHash('', push);
  } else if (key === 'blog') {
    closePanel();
    openReader(slug);
    current = 'blog';
    if (push) history.pushState(null, '', slug ? `#blog/${slug}` : '#blog');
  } else if (PANELS.includes(key)) {
    closeReader();
    openPanel(key);
    if (room) room.focus(ROOM_KEY[key]);
    current = key;
    setHash(key, push);
  }
  updateNav();
}

function routeFromHash() {
  const [key, slug] = location.hash.replace('#', '').split('/');
  go(key || 'home', { push: false, slug: slug || null });
}

function updateNav() {
  $$('.nav a').forEach((a) => (a.dataset.nav === current ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
}

// ---------------------------------------------------------------- room callbacks
function onHover(roomKey, ev) {
  const site = roomKey ? SITE_KEY[roomKey] : null;
  const tip = $('#tip');
  if (ev) tip.style.transform = `translate(${ev.clientX + 14}px, ${ev.clientY + 14}px)`;
  tip.textContent = site ? LABEL[site] : '';
  tip.classList.toggle('show', !!site);
  Object.entries(markers).forEach(([k, el]) => el.classList.toggle('hover', k === roomKey));
}

function onFrame(project) {
  for (const [roomKey, el] of Object.entries(markers)) {
    const p = project(roomKey);
    if (!p) { el.style.display = 'none'; continue; }
    el.style.transform = `translate(${p.x}px, ${p.y}px)`;
    const show = p.visible && current === 'home';
    el.style.opacity = show ? 1 : 0;
    el.style.pointerEvents = show ? 'auto' : 'none';
  }
}

function buildMarkers(roomKeys) {
  const host = $('#markers');
  roomKeys.forEach((rk) => {
    const site = SITE_KEY[rk];
    if (!site) return;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'marker';
    b.setAttribute('aria-label', LABEL[site]);
    b.innerHTML = `<i></i><span>${esc(LABEL[site])}</span>`;
    b.addEventListener('click', () => go(site));
    b.addEventListener('pointerenter', () => { if (room) room.setHover(rk); });
    b.addEventListener('pointerleave', () => { if (room) room.setHover(null); });
    host.appendChild(b);
    markers[rk] = b;
  });
}

function toast(text, ms = 8000) {
  const t = $('#toast');
  t.textContent = text;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), ms);
}

// ---------------------------------------------------------------- wire up the DOM
function bindUI() {
  $$('[data-nav]').forEach((a) => {
    a.addEventListener('click', (e) => { e.preventDefault(); go(a.dataset.nav); });
    if (ROOM_KEY[a.dataset.nav]) {
      a.addEventListener('pointerenter', () => { if (room) room.setHover(ROOM_KEY[a.dataset.nav]); });
      a.addEventListener('pointerleave', () => { if (room) room.setHover(null); });
    }
  });
  $('#theme').addEventListener('click', () => setTheme(themeName() === 'night' ? 'day' : 'night'));
  $('#panel-close').addEventListener('click', () => go('home'));
  $('#reader-close').addEventListener('click', () => go('home'));
  $('#reader').addEventListener('click', (e) => { if (e.target === $('#reader')) go('home'); });

  const pick = (e) => {                                                // history items, previous / next buttons, back button
    const b = e.target.closest('[data-slug], [data-act]');
    if (!b) return;
    if (b.dataset.act === 'list') { $('#reader').dataset.view = 'list'; return; }
    selectPost(b.dataset.slug);
  };
  $('#reader-items').addEventListener('click', pick);
  $('#reader-article').addEventListener('click', pick);

  addEventListener('keydown', (e) => { if (e.key === 'Escape' && current !== 'home') go('home'); });
  addEventListener('popstate', routeFromHash);
}

// ---------------------------------------------------------------- start
(async () => {
  setTheme(themeName(), true);
  bindUI();
  const bar = $('#loader .bar i');
  try {
    room = await startRoom({
      canvas: $('#scene'), base, theme: themeName(),
      terminal: cfg.terminal, terminalTitle: cfg.terminalTitle, matrixText: cfg.matrixText,
      onProgress: (p) => { bar.style.width = `${Math.round(5 + p * 95)}%`; },
      onHover, onPick: (roomKey) => go(SITE_KEY[roomKey]), onFrame,
    });
    buildMarkers(room.sections());
    if (DEV && !room.baked) toast('Preview lighting. Bake the room in Blender (BAKE = True) for the final look.');
  } catch (err) {
    console.warn('The 3D room could not start:', err);
    document.body.classList.add('no-room');
    if (DEV) toast('3D room not found. Export it from Blender into assets/room/ (see README). The rest of the site works.', 12000);
  }
  root.classList.add('room-ready');
  $('#loader').classList.add('done');
  routeFromHash();
})();
