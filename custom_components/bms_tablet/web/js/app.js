// Веб-версия BMS Планшета для iPad: вход в Home Assistant, состояние дома,
// маршруты, отрисовка и все нажатия. Дом собирается из того же конфига
// интеграции (sensor.bms_tablet_*), что у Android-планшета.

import { getAuth, logout } from './ha/auth.js';
import { createConnection } from './ha/connection.js';
import { buildHouse } from './model/house.js';
import { buildSpeakers, musicCall, parseMediaFolder, radioRoot, RADIO_ROOT } from './model/music.js';
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
const ui = { pendingTarget: {}, rememberedMode: {}, drag: {}, gateCooling: {}, menu: false };
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
  const ctx = { ui, grid: g, live: status === 'connected', title, weather: house.weather, speakers };
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
    case 'logout': return logout({ base: location.origin }).finally(() => location.reload());
    case 'target': return stepClimate(act.id, act.up);
    case 'radio': return openRadio(act.id);
    case 'radio-open': return browseRadio([...ui.radio.path, [act.contentId, act.contentType]]);
    case 'radio-back': return ui.radio.path.length > 1 ? browseRadio(ui.radio.path.slice(0, -1)) : closeRadio();
    case 'radio-close': return closeRadio();
    case 'radio-play': closeRadio(); return sendMusic({ type: 'Play', id: act.id, contentId: act.contentId, contentType: act.contentType });
    default: return undefined;
  }
}

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
  } else if (act.music === 'Source') {
    sendMusic({ type: 'Source', id: act.id, source: value });
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

// ------------------------------------------------------------------- музыка

async function sendMusic(action) {
  const call = musicCall(action);
  try {
    await conn.sendMessage({ type: 'call_service', ...call });
  } catch { /* колонка ответит своим состоянием */ }
}

function openRadio(id) {
  ui.radio = { id, path: [[RADIO_ROOT, 'music']], folder: null, loading: true };
  browseRadio(ui.radio.path);
}

function closeRadio() {
  ui.radio = null;
  render();
}

async function browseRadio(path) {
  const radio = ui.radio;
  if (!radio) return;
  radio.path = path;
  radio.loading = true;
  render();
  const [contentId, contentType] = path[path.length - 1];
  let folder = null;
  try {
    folder = parseMediaFolder(await conn.sendMessage({ type: 'media_player/browse_media', entity_id: radio.id, media_content_id: contentId, media_content_type: contentType }));
    if (folder && contentId === RADIO_ROOT) folder = radioRoot(folder);
  } catch { folder = null; }
  if (ui.radio !== radio || radio.path !== path) return; // уже ушли в другую папку
  radio.folder = folder;
  radio.loading = false;
  render();
}

/** Громкость: как ползунок вытяжки, но без ступеней; одна команда на отпускании. */
function startVolume(el, event) {
  const id = el.dataset.volume;
  if (el.classList.contains('disabled')) return;
  try { el.setPointerCapture(event.pointerId); } catch { /* без захвата */ }
  const key = 'vol:' + id;
  const valueAt = (x) => { const r = el.getBoundingClientRect(); return Math.max(0, Math.min(100, Math.round(((x - r.left) / r.width) * 100))); };
  ui.drag[key] = valueAt(event.clientX);
  render();
  const move = (e) => { ui.drag[key] = valueAt(e.clientX); render(); };
  const end = (e) => {
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', end);
    el.removeEventListener('pointercancel', end);
    if (e.type !== 'pointercancel') sendMusic({ type: 'Volume', id, percent: ui.drag[key] });
    setTimeout(() => { delete ui.drag[key]; render(); }, e.type === 'pointercancel' ? 0 : 2500);
  };
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
}

/** Реестры: у какой интеграции плеер (отсеять DLNA-двойников) и в какой он комнате. */
async function loadRegistry() {
  try {
    const [entities, devices, areas] = await Promise.all([
      conn.sendMessage({ type: 'config/entity_registry/list_for_display' }),
      conn.sendMessage({ type: 'config/device_registry/list' }).catch(() => []),
      conn.sendMessage({ type: 'config/area_registry/list' }).catch(() => []),
    ]);
    const map = new Map();
    for (const e of entities?.entities ?? []) {
      if (e.hb || e.ec != null) continue; // скрытые и служебные
      map.set(e.ei, { platform: e.pl ?? null, areaId: e.ai ?? null, deviceId: e.di ?? null });
    }
    registry = {
      entities: map,
      deviceAreas: new Map((devices ?? []).filter((d) => d.area_id).map((d) => [d.id, d.area_id])),
      areaNames: new Map((areas ?? []).map((a) => [a.area_id, a.name])),
    };
  } catch { registry = null; }
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
  conn.onStatus((next, detail) => {
    status = next;
    if (next === 'connected') { everConnected = true; offlineSince = null; }
    else if (offlineSince == null) { offlineSince = Date.now(); setTimeout(() => render(), BANNER_DELAY_MS + 100); }
    statusText = detail ? String(detail) : '';
    if (next === 'connected') loadRegistry().then(loadStates).catch(() => {});
    render();
  });
  await conn.connect();
  await conn.subscribeEvents(onStateChanged, 'state_changed');
}

start();
