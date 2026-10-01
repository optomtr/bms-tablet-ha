// Действия интерфейса → службы Home Assistant, оптимистичное применение, общие кнопки разделов.
// Порт HaRepository.send/setEntities/runOffPatches/overridePatches, data/LocalMutations.kt, ui/premium/BulkActions.kt.
//
// Действия — объекты: {type:'LightSet', id, on}, {type:'LightsSet', ids, on}, {type:'LightsAllSet', roomId, on},
// {type:'ClimateMode', id, mode}, {type:'ClimateTarget', id, target}, {type:'ClimateFanMode', id, mode},
// {type:'FanSpeed', id, percent}, {type:'FanPreset', id, preset}, {type:'Cover', id, command:'open'|'close'|'stop'|'toggle'},
// {type:'ToggleSet', id, on}, {type:'RoomOff', roomId}, {type:'TurnOff', roomId?}.
import { CLIMATE_KIND, availableModes, hvacIsOn, climateIsOn } from './devices.js';
import { isOnState, isUsableState } from './house.js';
import { isCurtain } from './navigation.js';

/** Сколько держим предположение, пока не пришёл настоящий state_changed. */
export const OVERRIDE_MS = 2500;

// ---------------------------------------------------------------- службы

/** У клапана нет turn_on: `homeassistant.turn_on` на valve.* ничего не включает. */
export const hasOwnOnOffService = (entityId) => entityId.startsWith('valve.');

/** Домен и служба, которыми включается и выключается сущность. */
export function onOffService(entityId, on) {
  if (hasOwnOnOffService(entityId)) return ['valve', on ? 'open_valve' : 'close_valve'];
  const dot = entityId.indexOf('.');
  return [dot < 0 ? entityId : entityId.slice(0, dot), on ? 'turn_on' : 'turn_off'];
}

const call = (domain, service, entityId, data = {}) => ({ domain, service, service_data: data, target: { entity_id: entityId } });

/** Одна сущность — службой своего домена (свет может быть заведён через `switch.*`). */
function setEntity(entityId, on) {
  const [domain, service] = onOffService(entityId, on);
  return [call(domain, service, entityId)];
}

/** Много сущностей — одним `homeassistant.turn_*`; клапаны поштучно своей службой. */
function setEntities(ids, on) {
  if (!ids.length) return [];
  const unique = [...new Set(ids)];
  const own = unique.filter(hasOwnOnOffService);
  const rest = unique.filter((id) => !hasOwnOnOffService(id));
  const out = [];
  if (rest.length) out.push(call('homeassistant', on ? 'turn_on' : 'turn_off', rest));
  for (const id of own) out.push(...setEntity(id, on));
  return out;
}

const COVER_SERVICE = { open: 'open_cover', close: 'close_cover', stop: 'stop_cover', toggle: 'toggle' };

/**
 * Выключение многих: свет одной командой, затем каждое устройство своей.
 * Отправлять всё, не обрываясь на сбое одного (плеер без turn_off не должен оставить включёнными остальные).
 */
function offCalls(patches) {
  const out = setEntities(patches.filter((p) => p.type === 'LightSet').map((p) => p.id), false);
  for (const p of patches) {
    if (p.type === 'ToggleSet') out.push(...setEntity(p.id, false));
    else if (p.type === 'ClimateMode') out.push(call('climate', 'set_hvac_mode', p.id, { hvac_mode: 'off' }));
  }
  return out;
}

/** Вызовы служб для действия; [rooms] нужны только групповым (LightsAllSet, RoomOff, TurnOff). */
export function serviceCalls(action, rooms = []) {
  switch (action.type) {
    case 'LightSet': case 'ToggleSet': return setEntity(action.id, action.on);
    case 'LightsSet': return setEntities(action.ids, action.on);
    case 'LightsAllSet': {
      const room = rooms.find((r) => r.id === action.roomId);
      return room ? setEntities(room.lights.filter((l) => l.available).map((l) => l.id), action.on) : [];
    }
    case 'ClimateMode': return [call('climate', 'set_hvac_mode', action.id, { hvac_mode: action.mode })];
    case 'ClimateTarget': return [call('climate', 'set_temperature', action.id, { temperature: action.target })];
    case 'ClimateFanMode': return [call('climate', 'set_fan_mode', action.id, { fan_mode: action.mode })];
    case 'FanSpeed': return [call('fan', 'set_percentage', action.id, { percentage: action.percent })];
    case 'FanPreset': return [call('fan', 'set_preset_mode', action.id, { preset_mode: action.preset })];
    case 'Cover': return [call('cover', COVER_SERVICE[action.command], action.id)];
    case 'RoomOff': case 'TurnOff': return offCalls(overridePatches(action, rooms));
    default: return [];
  }
}

// ---------------------------------------------------------------- предположения (optimistic UI)

/**
 * Поштучные предположения: групповые команды раскладываются по устройствам, чтобы
 * подтверждение одного снимало ровно его. Для RoomOff/TurnOff — ровно то, что уходит в HA.
 */
export function overridePatches(action, rooms) {
  const lightOff = (l) => ({ type: 'LightSet', id: l.id, on: false });
  const toggleOff = (t) => ({ type: 'ToggleSet', id: t.id, on: false });
  const climateOff = (c) => ({ type: 'ClimateMode', id: c.id, mode: 'off' });
  switch (action.type) {
    case 'LightsSet': return [...new Set(action.ids)].map((id) => ({ type: 'LightSet', id, on: action.on }));
    case 'LightsAllSet': {
      const room = rooms.find((r) => r.id === action.roomId);
      return room ? room.lights.filter((l) => l.available).map((l) => ({ type: 'LightSet', id: l.id, on: action.on })) : [];
    }
    case 'RoomOff': return rooms.filter((r) => r.id === action.roomId).flatMap((r) => [
      ...r.lights.filter((l) => l.available).map(lightOff), ...r.toggles.map(toggleOff), ...r.climates.map(climateOff)]);
    // «Выключить всё»: отопление и телевизор не трогаем — не выстужать дом и не обрывать фильм.
    case 'TurnOff': return rooms.filter((r) => action.roomId == null || r.id === action.roomId).flatMap((r) => [
      ...r.lights.filter((l) => l.available && l.isOn).map(lightOff),
      ...r.toggles.filter((t) => t.isOn && t.kind !== 'TV').map(toggleOff),
      ...r.climates.filter((c) => climateIsOn(c) && CLIMATE_KIND[c.kind].isCold).map(climateOff)]);
    default: return [action];
  }
}

/** Ключ предположения: новое поштучное намерение вытесняет групповое по тому же устройству. */
export function overrideKey(action) {
  switch (action.type) {
    case 'LightSet': case 'ToggleSet': case 'Cover': return action.id;
    case 'LightsSet': return 'group:' + action.ids.join(',');
    case 'ClimateMode': return action.id + '#mode';
    case 'ClimateTarget': return action.id + '#target';
    case 'ClimateFanMode': return action.id + '#fan';
    case 'FanSpeed': return action.id + '#speed';
    case 'FanPreset': return action.id + '#preset';
    case 'LightsAllSet': return 'room:' + action.roomId + '#lights';
    case 'RoomOff': return 'room:' + action.roomId + '#off';
    case 'TurnOff': return 'house:' + (action.roomId ?? 'all') + '#off';
    default: return action.type;
  }
}

const ON_OFF = new Set(['on', 'off']);
const TOGGLE_STATES = new Set(['on', 'off', 'open', 'closed', 'opening', 'closing']);

/** Пришедшее состояние подтверждает предположение (или устройство недоступно) — его можно снять. */
export function overrideConfirmed(action, state, temperature) {
  if (state == null || !isUsableState(state)) return true;
  switch (action.type) {
    case 'LightSet': return !ON_OFF.has(state) || (state === 'on') === action.on;
    // Клапан отвечает open/closed — без этого плитка полива моргала обратно.
    case 'ToggleSet': return !TOGGLE_STATES.has(state) || isOnState(state) === action.on;
    case 'ClimateMode': return state.toLowerCase() === action.mode;
    case 'ClimateTarget': return temperature != null && Math.abs(temperature - action.target) < 0.01;
    default: return true;
  }
}

const coerceIn = (v, min, max) => Math.min(Math.max(v, min), max);

/** Заменить устройства с подходящим id; комната без изменений остаётся тем же объектом. */
function patchRoom(room, field, match, change) {
  let changed = false;
  const list = room[field].map((d) => { if (!match(d)) return d; changed = true; return { ...d, ...change(d) }; });
  return changed ? { ...room, [field]: list } : room;
}

/**
 * Предсказанное состояние после действия (LocalMutations.applyAction).
 * predictCoverPosition=false — режим HA: у шторы меняется только «едет», положение ждём от HA.
 */
export function applyAction(rooms, action, predictCoverPosition = false) {
  return rooms.map((room) => applyToRoom(room, action, predictCoverPosition));
}

function applyToRoom(room, a, predictCoverPosition) {
  const is = (d) => d.id === a.id;
  switch (a.type) {
    case 'LightSet': return patchRoom(room, 'lights', is, () => ({ isOn: a.on }));
    case 'LightsSet': return patchRoom(room, 'lights', (d) => a.ids.includes(d.id), () => ({ isOn: a.on }));
    case 'LightsAllSet':
      return room.id !== a.roomId ? room : patchRoom(room, 'lights', (d) => d.available, () => ({ isOn: a.on }));
    case 'ClimateMode': return patchRoom(room, 'climates', is, () => ({ mode: a.mode }));
    case 'ClimateTarget': return patchRoom(room, 'climates', is, (d) => ({ target: coerceIn(a.target, d.min, d.max) }));
    case 'ClimateFanMode': return patchRoom(room, 'climates', is, () => ({ fanMode: a.mode }));
    // Скорость выставили — вытяжка работает, даже если была выключена (так ведёт себя и HA).
    case 'FanSpeed': return patchRoom(room, 'toggles', is, () => ({ speed: a.percent, isOn: a.percent > 0 }));
    case 'FanPreset': return patchRoom(room, 'toggles', is, () => ({ presetMode: a.preset, isOn: true }));
    case 'Cover': return patchRoom(room, 'covers', is, (d) => {
      if (a.command === 'open') return { position: predictCoverPosition ? 100 : d.position, isOpening: true, isClosing: false };
      if (a.command === 'close') return { position: predictCoverPosition ? 0 : d.position, isOpening: false, isClosing: true };
      if (a.command === 'stop') return { isOpening: false, isClosing: false };
      return {}; // импульс: положение непредсказуемо, ждём HA
    });
    case 'ToggleSet': return patchRoom(room, 'toggles', is, () => ({ isOn: a.on }));
    case 'RoomOff':
      if (room.id !== a.roomId) return room;
      return {
        ...room,
        lights: room.lights.map((d) => ({ ...d, isOn: false })),
        climates: room.climates.map((d) => ({ ...d, mode: 'off' })),
        toggles: room.toggles.map((d) => ({ ...d, isOn: false })),
      };
    case 'TurnOff':
      if (a.roomId != null && room.id !== a.roomId) return room;
      return {
        ...room,
        lights: room.lights.map((d) => ({ ...d, isOn: false })),
        // Отопление не трогаем, кондиционер гасим; телевизор оставляем.
        climates: room.climates.map((d) => (CLIMATE_KIND[d.kind].isCold ? { ...d, mode: 'off' } : d)),
        toggles: room.toggles.map((d) => (d.kind === 'TV' ? d : { ...d, isOn: false })),
      };
    default: return room;
  }
}

/** Как dispatch в HA-режиме: действие раскладывается на поштучные предположения и накладывается. */
export const optimistic = (rooms, action) =>
  overridePatches(action, rooms).reduce((acc, patch) => applyAction(acc, patch, false), rooms);

// ---------------------------------------------------------------- «Включить всё / выключить всё»

/**
 * С какой улицы кондиционеру греть, а не охлаждать. Просто climate.turn_on нельзя:
 * HA сам выберет первый режим — то есть обогрев, даже в +34°.
 */
export const AC_HEAT_BELOW = 18;

/** Режим по общей кнопке: AC — охлаждение (в холод — обогрев, без погоды — охлаждение), отопление — обогрев. */
export function bulkOnMode(device, outdoor) {
  const modes = availableModes(device).filter(hvacIsOn);
  const wanted = device.kind === 'AC' ? (outdoor != null && outdoor < AC_HEAT_BELOW ? 'heat' : 'cool') : 'heat';
  return modes.find((m) => m === wanted) ?? modes[0] ?? null;
}

const distinctById = (xs) => { const seen = new Set(); return xs.filter((d) => (seen.has(d.id) ? false : (seen.add(d.id), true))); };

/** Включить выключенные; работающие не трогаем (осушение не должно молча стать охлаждением). */
export function climatesOn(devices, outdoor) {
  return distinctById(devices).filter((d) => d.available && !climateIsOn(d))
    .map((d) => { const mode = bulkOnMode(d, outdoor); return mode ? { type: 'ClimateMode', id: d.id, mode } : null; })
    .filter(Boolean);
}

/** Выключить работающие. */
export const climatesOff = (devices) =>
  distinctById(devices).filter((d) => d.available && climateIsOn(d)).map((d) => ({ type: 'ClimateMode', id: d.id, mode: 'off' }));

/** Реле тёплого пола — только те, что в другом положении. */
export const relaysSet = (relays, on) =>
  distinctById(relays).filter((d) => d.available && d.isOn !== on).map((d) => ({ type: 'ToggleSet', id: d.id, on }));

/** Свет — одной командой, только лампы в другом положении. */
export function lightsSet(lights, on) {
  const ids = [...new Set(lights.filter((l) => l.available && l.isOn !== on).map((l) => l.id))];
  return ids.length ? [{ type: 'LightsSet', ids, on }] : [];
}

/** Шторы — только шторы: ворота и окна в общую команду не попадают никогда. */
export const curtainsCommand = (covers, open) =>
  distinctById(covers.filter((c) => c.available && isCurtain(c))).map((c) => ({ type: 'Cover', id: c.id, command: open ? 'open' : 'close' }));
