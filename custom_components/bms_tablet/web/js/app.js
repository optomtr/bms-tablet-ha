// Веб-версия BMS Планшета для iPad: вход в Home Assistant, состояние дома,
// маршруты, отрисовка и все нажатия. Дом собирается из того же конфига
// интеграции (sensor.bms_tablet_*), что у Android-планшета.

import { getAuth, logout } from './ha/auth.js';
import { createConnection } from './ha/connection.js';
import { buildHouse } from './model/house.js';
import { buildSpeakers } from './model/music.js';
import { setupMusic, sendMusic, musicUiCommand, startVolume, loadRegistry } from './music-controller.js';
import { serviceCalls, applyAction } from './model/actions.js';
import { markHallSections } from './model/navigation.js';
import { selectedRooms, pageTitle } from './model/summary.js';
import { stepTarget, snapSpeed } from './model/devices.js';
import { h, icon, morph } from './ui/dom.js';
import { press } from './ui/components.js';
import { renderPage, pageGrid } from './ui/pages.js';
import { setupPhotos, backdrop } from './ui/photos.js';

const TARGET_DEBOUNCE_MS = 500;
const TARGET_CONFIRM_MS = 5000;
const OVERRIDE_MS = 4000;
const GATE_COOLDOWN_MS = 2000;
const HOLD_MS = 1000;

const root = document.getElementById('app');
const states = new Map();
const ui = { pendingTarget: {}, rememberedMode: {}, drag: {}, gateCooling: {}, menu: false, youtube: readYouTube() };

// Кнопка YouTube на главной: включают и выключают в меню ☰, помнит каждое устройство своё.
function readYouTube() {
  try { return localStorage.getItem('bms-show-youtube') !== '0'; } catch { return true; }
}
function saveYouTube(on) {
  try { localStorage.setItem('bms-show-youtube', on ? '1' : '0'); } catch { /* без памяти */ }
}
let house = { rooms: [], settings: {}, weather: null, configured: false };
let speakers = [];
/** Реестры для колонок: интеграция плеера и комната. null — не получили (колонки без комнат). */
let registry = null;
let overrides = []; // {action, ids, until}: нажали — показываем сразу, не дожидаясь дома
let status = 'connecting';
let statusText = '';
// Полосу «Нет связи» показываем, только если обрыв держится дольше 20 с:
// iPad, проснувшись, переподключается за секунду, и полоса мигала бы зря.
const BANNER_DELAY_MS = 20_000;
let offlineSince = null;
let everConnected = false;
let loaded = false;
let conn = null;
let auth = null;
let route = routeFromHash();
let parent = 'home';

// ------------------------------------------------------------------ маршрут

function routeFromHash() {
  const raw = decodeURIComponent(location.hash.slice(1));
  return raw || 'home';
}

function go(next) {
  parent = route;
  route = next;
  ui.menu = false;
  // Полный путь: у страницы <base href>, и голый «#…» увёл бы адрес на /bms_tablet_web/.
  history.replaceState(null, '', location.pathname + location.search + '#' + encodeURIComponent(next));
  render({ scrollTop: true });
}

function back() {
  const next = route.startsWith('room:') && parent.startsWith('zone:') ? parent : 'home';
  parent = 'home';
  go(next);
  parent = 'home';
}

// ------------------------------------------------------------------- данные

function rebuild() {
  house = buildHouse(states, location.origin, house.config ?? null);
  speakers = buildSpeakers(states, registry);
  const now = Date.now();
  overrides = overrides.filter((o) => o.until > now);
}

function rooms() {
  let list = house.rooms;
  for (const o of overrides) list = applyAction(list, o.action);
  return markHallSections(list);
}

function idsOf(action) {
  return action.ids ?? (action.id ? [action.id] : []);
}

async function dispatch(action) {
  if (!action) return;
  if (action.batch) { action.batch.forEach(dispatch); return; }
  if (action.type === 'Cover' && action.gate) {
    ui.gateCooling[action.id] = Date.now() + GATE_COOLDOWN_MS;
    setTimeout(() => render(), GATE_COOLDOWN_MS + 50);
  }
  const clean = { ...action };
  delete clean.gate;
  const entry = { action: clean, ids: idsOf(clean), until: Date.now() + OVERRIDE_MS };
  overrides.push(entry);
  render();
  try {
    for (const call of serviceCalls(clean, house.rooms)) {
      await conn.sendMessage({ type: 'call_service', domain: call.domain, service: call.service, service_data: call.service_data ?? {}, target: call.target });
    }
  } catch {
    // Не прошло — снимаем предположение и показываем, как есть на самом деле.
    overrides = overrides.filter((o) => o !== entry);
    render();
  }
}

function findDevice(id) {
  for (const room of rooms()) {
    for (const list of [room.climates, room.toggles, room.lights, room.covers]) {
      const d = list.find((x) => x.id === id);
      if (d) return d;
    }
  }
  return null;
}

/** «+» и «−» копятся на экране, в дом уходит одна команда через полсекунды. */
const targetTimers = {};
function stepClimate(id, up) {
  const device = findDevice(id);
  if (!device) return;
  const current = ui.pendingTarget[id] ?? device.target;
  ui.pendingTarget[id] = stepTarget({ ...device, target: current }, up);
  render();
  clearTimeout(targetTimers[id]);
  targetTimers[id] = setTimeout(() => {
    dispatch({ type: 'ClimateTarget', id, target: ui.pendingTarget[id] });
    targetTimers[id] = setTimeout(() => { delete ui.pendingTarget[id]; render(); }, TARGET_CONFIRM_MS);
  }, TARGET_DEBOUNCE_MS);
}

// ---------------------------------------------------------------- отрисовка

let clock = '';
function header(title) {
  const home = route === 'home';
  const live = status === 'connected';
  const parts = [];
  if (!home) {
    parts.push(press('btn-home', { act: { ui: 'home' }, label: 'Дом' }, icon('premium_home'), h('span', 'Дом')));
    if (!grid().phone) parts.push(press('btn-icon', { act: { ui: 'back' }, label: 'Назад' }, icon('premium_back')));
    parts.push(h('div.title', title));
  } else {
    parts.push(h('img.wordmark', { src: 'img/bms_wordmark.png', alt: 'BMS Smart Home' }), h('div.grow'));
    const w = house.weather;
    if (w) parts.push(h('div.weather', icon('ic_sun'), `${w.ru ? w.ru[0].toUpperCase() + w.ru.slice(1) : 'Погода'} · ${w.temperature != null ? Math.trunc(w.temperature) + '°' : '—'}`));
  }
  parts.push(h('div.clock', clock));
  parts.push(press('btn-icon', { act: { ui: 'menu' }, label: 'Настройки', on: ui.menu }, icon('ic_settings')));
  return [
    h('header.header', { 'data-key': 'header' }, parts),
    live || !loaded || !bannerDue() ? null : h('div.conn-bar', { class: status === 'connecting' ? '' : 'error', 'data-key': 'conn' },
      status === 'connecting' ? 'Подключение к дому…' : [h('b', 'Нет связи'), h('span', statusText || 'Пробуем подключиться снова…')]),
  ];
}

function bannerDue() {
  if (!everConnected) return true;
  return offlineSince != null && Date.now() - offlineSince >= BANNER_DELAY_MS;
}

function menu() {
  if (!ui.menu) return null;
  return h('div.menu', { 'data-key': 'menu' },
    press('action', { act: { ui: 'youtube-toggle' }, on: ui.youtube, label: 'Кнопка YouTube' }, icon('ic_play'),
      h('span', `Кнопка YouTube: ${ui.youtube ? 'вкл.' : 'выкл.'}`)),
    press('action', { act: { ui: 'reload' }, label: 'Обновить' }, icon('ic_grid'), h('span', 'Обновить страницу')),
    press('action', { act: { ui: 'logout' }, label: 'Выйти' }, icon('ic_close'), h('span', 'Выйти из Home Assistant')));
}

function grid() {
  const page = root.querySelector('.page');
  const width = (page ? page.clientWidth : window.innerWidth) - 2 * (window.innerWidth < 616 ? 16 : 24);
  return pageGrid(width);
}

let scheduled = false;
function render(opts = {}) {
  if (opts.scrollTop) {
    scheduled = false;
    draw(true);
    return;
  }
  if (scheduled) return;
  scheduled = true;
  // Кадр — когда страницу видно; скрытой вкладке кадров не дают, рисуем по таймеру.
  const next = document.visibilityState === 'visible' ? requestAnimationFrame : (f) => setTimeout(f, 16);
  next(() => { scheduled = false; draw(false); });
}

function draw(scrollTop) {
  const list = rooms();
  const selected = selectedRooms(list, route);
  const title = pageTitle(route, selected, house.settings?.homeName);
  const g = grid();
  const ctx = { ui, grid: g, live: status === 'connected', title, weather: house.weather, speakers, youtube: ui.youtube };
  let body;
  if (!loaded) body = [h('div.splash', h('div', h('img', { src: 'img/bms_wordmark.png', alt: 'BMS' }), status === 'auth_failed' ? 'Не удалось войти в Home Assistant' : 'Подключение к дому…'))];
  else if (!house.configured) body = [h('div.empty', 'Интеграция «BMS Планшеты» не настроена в Home Assistant.')];
  else body = renderPage(route, list, selected, ctx);
  const bg = route.startsWith('room:') ? (selected[0]?.background?.imageUrl ? selected[0].background : house.settings?.background) : house.settings?.background;
  const tree = h('div', { id: 'app' },
    bg ? backdrop(bg) : null,
    header(title),
    h('main.page', { 'data-key': 'page:' + route }, body),
    menu());
  morph(root, tree);
  restoreHold();
  if (scrollTop) root.querySelector('.page')?.scrollTo(0, 0);
}

// ----------------------------------------------------------------- нажатия

root.addEventListener('click', (event) => {
  const el = event.target.closest('[data-act],[data-nav]');
  // Касание мимо открытого меню закрывает его (сама кнопка меню переключает).
  if (ui.menu && !event.target.closest('.menu') && el?.getAttribute('aria-label') !== 'Настройки') {
    ui.menu = false;
    if (!el) { render(); return; }
  }
  if (!el || el.disabled || el.hasAttribute('data-hold')) return;
  if (el.dataset.nav) { go(el.dataset.nav); return; }
  const act = JSON.parse(el.dataset.act);
  if (act.ui) return uiCommand(act);
  if (act.music) return sendMusic(act.music);
  ui.menu = false;
  dispatch(act);
});

function uiCommand(act) {
  switch (act.ui) {
    case 'home': return go('home');
    case 'back': return back();
    case 'menu': ui.menu = !ui.menu; return render();
    case 'reload': return location.reload();
    case 'youtube-toggle': ui.youtube = !ui.youtube; saveYouTube(ui.youtube); return render();
    case 'youtube': window.open('https://www.youtube.com/', '_blank', 'noopener'); return undefined;
    case 'logout': return logout({ base: location.origin }).finally(() => location.reload());
    case 'target': return stepClimate(act.id, act.up);
    default: musicUiCommand(act); return undefined;
  }
}

// Поиск музыки: Enter на клавиатуре iPad («Найти») — как кнопка «Найти».
root.addEventListener('submit', (event) => {
  if (!event.target.closest('[data-search-form]')) return;
  event.preventDefault();
  musicUiCommand({ ui: 'find-run' });
});

root.addEventListener('change', (event) => {
  const select = event.target.closest('select[data-choice]');
  if (!select) return;
  const act = JSON.parse(select.dataset.choice);
  const value = select.value;
  select.blur();
  if (act.ui === 'mode') {
    ui.rememberedMode[act.id] = value;
    if (act.on) dispatch({ type: 'ClimateMode', id: act.id, mode: value });
    else render();
  } else if (act.type === 'ClimateFanMode') {
    dispatch({ type: 'ClimateFanMode', id: act.id, mode: value });
  }
});

// Держать секунду: заливка идёт, пока палец на кнопке; отпустил раньше — ничего.
let holding = null;
root.addEventListener('pointerdown', (event) => {
  const el = event.target.closest('[data-hold]');
  if (el && !el.disabled && el.dataset.act) startHold(el);
  const slider = event.target.closest('[data-slider]');
  if (slider) startSlide(slider, event);
  const vol = event.target.closest('[data-volume]');
  if (vol) startVolume(vol, event);
});

function startHold(el) {
  cancelHold();
  const act = JSON.parse(el.dataset.act);
  const label = el.getAttribute('aria-label');
  el.classList.add('holding');
  holding = { label, timer: setTimeout(() => { cancelHold(); dispatch(act); }, HOLD_MS) };
}

function cancelHold() {
  if (!holding) return;
  clearTimeout(holding.timer);
  root.querySelectorAll('.holding').forEach((n) => n.classList.remove('holding'));
  holding = null;
}

function restoreHold() {
  if (!holding) return;
  const el = [...root.querySelectorAll('[data-hold]')].find((n) => n.getAttribute('aria-label') === holding.label);
  if (el) el.classList.add('holding');
}

for (const type of ['pointerup', 'pointercancel', 'pointerleave']) {
  root.addEventListener(type, (event) => { if (holding && event.target.closest?.('[data-hold]')) cancelHold(); }, true);
}
// Долгое касание на iPad вызывает меню «копировать» — у кнопок его быть не должно.
root.addEventListener('contextmenu', (event) => event.preventDefault());

// Ползунок скорости: прилипает к ступеням, команда одна — на отпускании.
function startSlide(el, event) {
  const id = el.dataset.slider;
  const fan = findDevice(id);
  if (!fan || el.classList.contains('disabled')) return;
  // Палец может уйти с полосы — захват держит движение за ней. Не дали — не страшно.
  try { el.setPointerCapture(event.pointerId); } catch { /* без захвата */ }
  const valueAt = (x) => {
    const r = el.getBoundingClientRect();
    return snapSpeed(fan, Math.round(((x - r.left) / r.width) * 100));
  };
  ui.drag[id] = valueAt(event.clientX);
  render();
  const move = (e) => { ui.drag[id] = valueAt(e.clientX); render(); };
  const end = (e) => {
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', end);
    el.removeEventListener('pointercancel', end);
    if (e.type === 'pointercancel') { delete ui.drag[id]; render(); return; }
    const value = ui.drag[id];
    // Нулём вытяжку выключают — отдельная команда понятнее любому железу.
    dispatch(value <= 0 ? { type: 'ToggleSet', id, on: false } : { type: 'FanSpeed', id, percent: value });
    setTimeout(() => { delete ui.drag[id]; render(); }, 2500);
  };
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
}

// --------------------------------------------------------------- подключение

function tickClock() {
  const now = new Date();
  clock = now.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  render();
  setTimeout(tickClock, 60_000 - (Date.now() % 60_000) + 50);
}

async function loadStates() {
  const list = await conn.getStates();
  states.clear();
  for (const s of list) states.set(s.entity_id, s);
  rebuild();
  loaded = true;
  render();
}

function onStateChanged(event) {
  const { entity_id: id, new_state: next } = event.data ?? {};
  if (!id) return;
  if (next) states.set(id, next); else states.delete(id);
  // Дом ответил — предположение по этому устройству больше не нужно.
  overrides = overrides.filter((o) => !o.ids.includes(id));
  for (const [key, value] of Object.entries(ui.pendingTarget)) {
    if (key === id && next && Math.abs((next.attributes?.temperature ?? NaN) - value) < 0.01) delete ui.pendingTarget[key];
  }
  rebuild();
  render();
}

async function keepAwake() {
  // iPad гаснет сам; на iPadOS 18.4+ у приложения с экрана «Домой» это можно запретить.
  try { if (document.visibilityState === 'visible') await navigator.wakeLock?.request('screen'); } catch { /* нельзя — не беда */ }
}

async function start() {
  tickClock();
  window.addEventListener('resize', () => render());
  window.addEventListener('hashchange', () => { const r = routeFromHash(); if (r !== route) { parent = 'home'; route = r; render({ scrollTop: true }); } });
  document.addEventListener('visibilitychange', keepAwake);
  keepAwake();
  try {
    auth = await getAuth({ base: location.origin });
  } catch (error) {
    status = 'auth_failed';
    statusText = String(error?.message ?? error);
    render();
    return;
  }
  if (!auth) return; // ушли на страницу входа Home Assistant
  setupPhotos(async () => {
    if (auth.expired) await auth.refresh();
    return auth.accessToken;
  }, () => render());
  conn = createConnection(auth);
  setupMusic({ conn: () => conn, ui, render, findSpeaker: (id) => speakers.find((s) => s.id === id), allSpeakers: () => speakers });
  conn.onStatus((next, detail) => {
    status = next;
    if (next === 'connected') { everConnected = true; offlineSince = null; }
    else if (offlineSince == null) { offlineSince = Date.now(); setTimeout(() => render(), BANNER_DELAY_MS + 100); }
    statusText = detail ? String(detail) : '';
    if (next === 'connected') loadRegistry().then((r) => { registry = r; }).then(loadStates).catch(() => {});
    render();
  });
  await conn.connect();
  await conn.subscribeEvents(onStateChanged, 'state_changed');
}

start();
