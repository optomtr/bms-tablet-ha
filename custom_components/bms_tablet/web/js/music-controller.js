// Музыка: команды колонкам, радио плитками, мультирум одним касанием, громкость пальцем, реестры.
// Отдельно от app.js — тот же порядок, что у раздела «Музыка» Android-планшета.

import { musicCall, parseMediaFolder, parseAssistantSearch, groupLeader } from './model/music.js';
import { browse as browseCatalog, PREFIX } from './model/radio.js';

let deps = null; // {conn: () => connection, ui, render, findSpeaker}

const STATIONS = 'bms-music-stations';

export function setupMusic(d) {
  deps = d;
  d.ui.mrPending = {};
  // Станции, включённые с этого iPad: колонка называет радио адресом, а мы — именем.
  try { d.ui.stations = JSON.parse(localStorage.getItem(STATIONS) ?? '{}') ?? {}; } catch { d.ui.stations = {}; }
}

function rememberStation(id, title, thumbnail) {
  deps.ui.stations[id] = { title, thumbnail: thumbnail ?? null };
  try { localStorage.setItem(STATIONS, JSON.stringify(deps.ui.stations)); } catch { /* без памяти */ }
}

/** Мультирум: команда одна, кнопка ждёт перехода не дольше 15 с. */
function groupCommand(id, target, action) {
  const { ui, render, findSpeaker, allSpeakers } = deps;
  const s = findSpeaker(id);
  if (!s || ui.mrPending[id]) return;
  const pending = { target, leaderBefore: groupLeader(s, allSpeakers())?.id ?? null };
  ui.mrPending[id] = pending;
  render();
  sendMusic(action);
  setTimeout(() => { if (ui.mrPending[id] === pending) { delete ui.mrPending[id]; render(); } }, 15000);
}

export async function sendMusic(action) {
  try {
    await deps.conn().sendMessage({ type: 'call_service', ...musicCall(action) });
  } catch { /* колонка ответит своим состоянием */ }
}

/** Команды интерфейса музыки; true — команда наша. */
export function musicUiCommand(act) {
  const { ui, render } = deps;
  switch (act.ui) {
    case 'radio': openRadio(act.id, 'radio', [PREFIX + 'root', 'folder', 'Радио']); return true;
    case 'library': openRadio(act.id, 'library', [null, null, 'Медиатека']); return true;
    case 'find-open': ui.find = { id: act.id, query: '', result: null, loading: false }; render(); return true;
    case 'find-close': ui.find = null; render(); return true;
    case 'find-run': runSearch(); return true;
    case 'find-play': ui.find = null; render(); sendMusic({ type: 'PlayAssistant', id: act.id, uri: act.uri, mediaType: act.mediaType }); return true;
    case 'radio-open': browseRadio([...ui.radio.path, [act.contentId, act.contentType, act.title]]); return true;
    case 'radio-back': if (ui.radio.path.length > 1) browseRadio(ui.radio.path.slice(0, -1)); else closeRadio(); return true;
    case 'radio-close': closeRadio(); return true;
    case 'radio-play':
      if (ui.radio?.kind === 'radio') rememberStation(act.id, act.title, act.thumbnail);
      closeRadio();
      sendMusic({ type: 'Play', id: act.id, contentId: act.contentId, contentType: act.contentType });
      return true;
    case 'mr-join': groupCommand(act.id, act.target, { type: 'Join', id: act.target, members: [act.id] }); return true;
    case 'mr-leave': groupCommand(act.id, act.leader, { type: 'Unjoin', id: act.id }); return true;
    default: return false;
  }
}

function openRadio(id, kind, root) {
  deps.ui.radio = { id, kind, path: [root], folder: null, loading: true };
  browseRadio(deps.ui.radio.path);
}

function closeRadio() {
  deps.ui.radio = null;
  deps.render();
}

async function browseRadio(path) {
  const radio = deps.ui.radio;
  if (!radio) return;
  radio.path = path;
  radio.loading = true;
  deps.render();
  const [contentId, contentType, title] = path[path.length - 1];
  let folder = null;
  try {
    if (radio.kind === 'radio') folder = await browseCatalog(contentId, title);
    else {
      const msg = { type: 'media_player/browse_media', entity_id: radio.id };
      if (contentId) Object.assign(msg, { media_content_id: contentId, media_content_type: contentType ?? '' });
      folder = parseMediaFolder(await deps.conn().sendMessage(msg));
    }
  } catch { folder = null; }
  if (deps.ui.radio !== radio || radio.path !== path) return; // уже ушли в другую папку
  radio.folder = folder;
  radio.loading = false;
  deps.render();
}

let assistantEntry = null;

/** Поиск в Music Assistant: строку берём из поля окна, ответ — по разделам. */
async function runSearch() {
  const find = deps.ui.find;
  const input = document.querySelector('[data-search-field]');
  const query = (input?.value ?? '').trim();
  if (!find || !query) return;
  find.query = query;
  find.loading = true;
  deps.render();
  let result = null;
  try {
    const conn = deps.conn();
    assistantEntry ??= (await conn.sendMessage({ type: 'config_entries/get', domain: 'music_assistant' }))?.[0]?.entry_id ?? null;
    if (assistantEntry) {
      const answer = await conn.sendMessage({ type: 'call_service', domain: 'music_assistant', service: 'search', return_response: true,
        service_data: { config_entry_id: assistantEntry, name: query, limit: 10 } });
      result = parseAssistantSearch(answer?.response);
    }
  } catch { result = null; }
  if (deps.ui.find !== find) return;
  find.result = result;
  find.loading = false;
  deps.render();
}

/** Громкость: как ползунок вытяжки, но без ступеней; одна команда на отпускании. */
export function startVolume(el, event) {
  const { ui, render } = deps;
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
export async function loadRegistry() {
  const conn = deps.conn();
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
    return {
      entities: map,
      deviceAreas: new Map((devices ?? []).filter((d) => d.area_id).map((d) => [d.id, d.area_id])),
      areaNames: new Map((areas ?? []).map((a) => [a.area_id, a.name])),
    };
  } catch { return null; }
}
