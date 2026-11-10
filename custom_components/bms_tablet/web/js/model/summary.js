// Сводка по дому, строки зон, модель страницы и форматирование.
// Порт ui/premium/HomeSummary.kt, PageModel/selectedRooms/pageTitle из PremiumHome.kt, model/Format.kt.
import { CLIMATE_KIND, CLIMATE_KIND_ORDER, roomFans, roomIrrigation, roomMedia, hasSpeed, roomLightsOn, availableModes } from './devices.js';
import {
  zoneOf, zones, zoneLabel, zoneTitle, roomPages, pageOf, pageRooms, isGateCover, isCurtain, isFloorHeatingRelay,
  lightSections, roomLayout, isHallRoom, coverGroups,
} from './navigation.js';

// ---------------------------------------------------------------- форматирование

/** Русское склонение по числу. */
export function plural(n, one, few, many) {
  const mod100 = n % 100;
  const mod10 = n % 10;
  if (mod100 >= 11 && mod100 <= 14) return many;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

/** «%.1f» с запятой и округлением половины вверх, как String.format в Kotlin. */
export function formatTemp1(value) {
  const sign = value < 0 ? '-' : '';
  const abs = Math.round(Number(Math.abs(value).toPrecision(15)) * 10) / 10;
  return (sign + abs.toFixed(1)).replace('.', ',');
}

/** Целое — без дробной части («21»), иначе один знак с запятой («26,5»). */
export const formatTemp = (value) => (value % 1 === 0 ? String(Math.trunc(value)) : formatTemp1(value));

/** 28.7 → «28,7°». */
export const formatTempUnit = (value) => formatTemp1(value) + '°';

/** 21.0 → «21°» — крупное значение уставки. */
export function formatTargetUnit(value) {
  const rounded = Math.round(value);
  return Math.abs(value - rounded) < 0.05 ? `${rounded}°` : formatTempUnit(value);
}

export const formatPercent = (value) => `${Math.round(value)}%`;

/** «2 источника света включено» / «свет выключен». */
export function lightsSummary(count) {
  if (count === 0) return 'свет выключен';
  return `${count} ${plural(count, 'источник', 'источника', 'источников')} света ${plural(count, 'включён', 'включено', 'включено')}`;
}

/** «28,7° · 2 источника света включено». */
export function roomStatusLine(room) {
  const parts = [];
  if (room.sensors.airTemp != null) parts.push(formatTempUnit(room.sensors.airTemp));
  parts.push(lightsSummary(roomLightsOn(room)));
  return parts.join(' · ');
}

/** Скорость вентилятора сплита по-русски; незнакомое — как пришло («Auto + Swing»). */
export function fanModeLabel(raw) {
  switch (raw.trim().toLowerCase()) {
    case 'low': case 'min': case 'quiet': case 'silent': return 'Низкий';
    case 'mid': case 'middle': case 'medium': return 'Средний';
    case 'high': case 'max': case 'strong': case 'turbo': return 'Высокий';
    case 'auto': case 'automatic': return 'Авто';
    default: return raw;
  }
}

// ---------------------------------------------------------------- сводка главного экрана

/** Улица: её температура — не «в доме». */
const OUTDOOR = new Set(['Двор', 'Терраса']);

const distinctBy = (xs, key) => { const seen = new Set(); return xs.filter((x) => { const k = key(x); if (seen.has(k)) return false; seen.add(k); return true; }); };
const average = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/**
 * Температура комнат: датчик, без него — то, что меряет кондиционер.
 * Один датчик в нескольких подзонах холла считается один раз.
 */
function roomTemps(rooms) {
  const pairs = [];
  for (const room of rooms) {
    if (room.sensors.airTemp != null) { pairs.push([room.sensors.airTempId ?? `room:${room.id}`, room.sensors.airTemp]); continue; }
    const c = room.climates.find((d) => d.current != null);
    if (c) pairs.push([c.id, c.current]);
  }
  return distinctBy(pairs, (p) => p[0]).map((p) => p[1]);
}

const lightsOn = (rooms) => distinctBy(rooms.flatMap((r) => r.lights).filter((l) => l.available && l.isOn), (l) => l.id).length;

/** {lightsOn, airTemp, gates, gatesOpen, gateZone} — главный экран «В». */
export function houseSummary(rooms) {
  const gates = distinctBy(rooms.flatMap((room) => room.covers.filter((c) => c.available && isGateCover(c)).map((c) => ({ room, gate: c }))), (p) => p.gate.id);
  return {
    lightsOn: lightsOn(rooms),
    airTemp: average(roomTemps(rooms.filter((r) => !OUTDOOR.has(zoneOf(r))))),
    gates: gates.length,
    gatesOpen: gates.filter(({ gate }) => (gate.position ?? 0) > 0 || gate.isOpening).length,
    gateZone: gates.length ? zoneOf(gates[0].room) : null,
  };
}

/** Строки зон [{zone, meta, lightsOn, airTemp}]: «11 помещений» или сами имена, когда их три и меньше. */
export function zoneRows(rooms) {
  return zones(rooms).map((zone) => {
    const inZone = rooms.filter((r) => zoneOf(r) === zone);
    const pages = [...new Set(roomPages(inZone).map(pageOf))];
    let meta;
    if (pages.length === 1 && pages[0].toLowerCase() === zone.toLowerCase()) meta = '';
    else if (pages.length <= 3) meta = pages.join(', ');
    else meta = `${pages.length} ${plural(pages.length, 'помещение', 'помещения', 'помещений')}`;
    return { zone, meta, lightsOn: lightsOn(inZone), airTemp: average(roomTemps(inZone)) };
  });
}

/** Крупная строка плитки ворот: «Закрыты», «Открыты», «Открыто 1 из 2». */
export function gatesLabel(total, open) {
  if (open <= 0) return 'Закрыты';
  if (open >= total) return 'Открыты';
  return `Открыто ${open} из ${total}`;
}

// ---------------------------------------------------------------- маршруты и модель страницы

const after = (route) => route.slice(route.indexOf(':') + 1);

/** Комнаты маршрута: "room:<pageKey>", "zone:<zone>", остальное — весь дом. */
export function selectedRooms(rooms, route) {
  if (route.startsWith('room:')) return pageRooms(rooms, after(route));
  if (route.startsWith('zone:')) { const zone = after(route); return rooms.filter((r) => zoneOf(r) === zone); }
  if (route.startsWith('group:')) { const g = after(route); return rooms.filter((r) => (r.group ?? '').trim() === g); }
  return rooms;
}

export function pageTitle(route, selected, homeName) {
  if (route === 'home') return homeName ?? 'Мой дом';
  if (route.startsWith('room:')) return selected.length ? pageOf(selected[0]) : '';
  if (route.startsWith('zone:')) return zoneTitle(after(route));
  if (route.startsWith('group:')) return after(route);
  if (route.includes(':')) return after(route);
  return route;
}

/** Ленивое поле: считается при первом обращении, как `by lazy`. */
function lazy(target, name, compute) {
  Object.defineProperty(target, name, {
    configurable: true, enumerable: true,
    get() { const v = compute(); Object.defineProperty(target, name, { value: v, enumerable: true }); return v; },
  });
}

const byId = (xs) => distinctBy(xs, (d) => d.id);
const pairsById = (xs) => distinctBy(xs, (p) => p.device.id);

/**
 * Всё, что страницы выводят из списка комнат. Пары «комната + устройство» — {room, device}.
 * cards() — карточки под светом страницы комнаты (без расчёта ширины; tiles — число плиток).
 */
export function pageModel(rooms, selected) {
  const m = {};
  lazy(m, 'summary', () => houseSummary(rooms));
  lazy(m, 'zoneList', () => zoneRows(rooms));
  lazy(m, 'allLights', () => byId(rooms.flatMap((r) => r.lights).filter((l) => l.available)));
  lazy(m, 'allCurtains', () => byId(rooms.flatMap((r) => r.covers).filter((c) => c.available && isCurtain(c))));
  // Всё, что греет: термостаты тёплого пола, радиаторы, конвекторы.
  lazy(m, 'heaters', () => byId(rooms.flatMap((r) => r.climates).filter((c) => !CLIMATE_KIND[c.kind].isCold)));
  // Реле тёплого пола всего дома — у второго объекта пол только на них.
  lazy(m, 'floorRelaysAll', () => byId(rooms.flatMap((r) => r.toggles).filter(isFloorHeatingRelay)));
  lazy(m, 'heating', () => {
    const groups = new Map();
    for (const room of rooms) for (const device of room.climates.filter((c) => !CLIMATE_KIND[c.kind].isCold)) {
      const title = `${CLIMATE_KIND[device.kind].title} · ${zoneTitle(zoneOf(room))}`;
      if (!groups.has(title)) groups.set(title, []);
      groups.get(title).push({ room, device });
    }
    return [...groups.entries()].map(([title, items]) => ({ title, items }));
  });
  lazy(m, 'climateByKind', () => {
    const devices = rooms.flatMap((room) => room.climates.map((device) => ({ room, device })));
    return CLIMATE_KIND_ORDER.map((kind) => ({ kind, items: pairsById(devices.filter((p) => p.device.kind === kind)) }))
      .filter((g) => g.items.length);
  });
  lazy(m, 'allFans', () => rooms.flatMap((room) => roomFans(room).map((device) => ({ room, device }))));
  lazy(m, 'allCameras', () => byId(rooms.flatMap((r) => r.cameras)));
  lazy(m, 'cameraRooms', () => roomPages(rooms).filter((r) => r.cameras.length));
  lazy(m, 'cameras', () => byId(selected.flatMap((r) => r.cameras)));
  lazy(m, 'allLightBlocks', () => rooms.flatMap((room) => lightSections(room, true).map((s) => ({ key: `${room.id}/${s.title}`, ...s }))));
  lazy(m, 'curtainRooms', () => rooms.filter((r) => r.covers.some(isCurtain)));
  lazy(m, 'lightBlocks', () => selected.flatMap((room) => lightSections(room, selected.length > 1).map((s) => ({ key: `${room.id}/${s.title}`, ...s }))));
  lazy(m, 'isHall', () => selected.some((r) => isHallRoom(String(r.originalName ?? r.name).toLowerCase().replaceAll('ё', 'е').trim())));
  // Страница одной комнаты раскладывается по подзонам; холл и страницы зон — по-старому.
  lazy(m, 'layout', () => (selected.length === 1 && !m.isHall ? roomLayout(selected[0]) : null));
  lazy(m, 'floorRelays', () => m.layout?.floorHeating ?? byId(selected.flatMap((r) => r.toggles).filter(isFloorHeatingRelay)));
  lazy(m, 'irrigation', () => m.layout?.irrigation ?? byId(selected.flatMap(roomIrrigation)));
  lazy(m, 'lights', () => byId(selected.flatMap((r) => r.lights).filter((l) => l.available)));
  lazy(m, 'covers', () => byId(selected.flatMap((r) => r.covers)));
  lazy(m, 'climates', () => pairsById(selected.flatMap((room) => room.climates.map((device) => ({ room, device })))));
  lazy(m, 'fans', () => (m.layout
    ? m.layout.toggles.filter((t) => t.kind === 'FAN').map((device) => ({ room: selected[0], device }))
    : pairsById(selected.flatMap((room) => roomFans(room).map((device) => ({ room, device }))))));
  lazy(m, 'media', () => (m.layout
    ? m.layout.toggles.filter((t) => t.kind !== 'FAN')
    : byId(selected.flatMap(roomMedia).filter((t) => !isFloorHeatingRelay(t)))));
  // Зоны полива страницы — по ним спрашиваем «Полито: …».
  lazy(m, 'irrigationIds', () => m.irrigation.map((t) => t.id));
  m.cards = () => {
    const out = [];
    for (const zone of m.layout?.zones ?? []) {
      const tiles = zone.lights.length + zone.toggles.filter((t) => !(t.kind === 'FAN' && hasSpeed(t))).length;
      out.push({ type: 'zone', key: `zone/${zone.title}`, zone, tiles });
    }
    // Штор много (холл: окна, боковые, тюль) — группами; мало — карточкой на штору.
    const grouped = coverGroups(m.covers.filter((c) => !isGateCover(c)), m.isHall);
    if (grouped) {
      for (const group of grouped) out.push({ type: 'covers', key: `covers/${group.title}`, group });
      for (const cover of m.covers.filter(isGateCover)) out.push({ type: 'cover', key: `cover/${cover.id}`, cover });
    } else for (const cover of m.covers) out.push({ type: 'cover', key: `cover/${cover.id}`, cover });
    // Полив — сразу за шторами и воротами: во дворе это соседи по смыслу.
    if (m.irrigation.length) out.push({ type: 'irrigation', key: 'irrigation', zones: m.irrigation, tiles: m.irrigation.length });
    if (m.floorRelays.length) out.push({ type: 'floor', key: 'floor-heating', relays: m.floorRelays, tiles: m.floorRelays.length });
    // Комната с несколькими тёплыми полами или радиаторами — одна общая карточка на вид,
    // термостаты под ней раскрываются по кнопке (владелец, холл, 10.11.2026).
    const one = selected.length === 1;
    const done = new Set();
    for (const { room, device } of m.climates) {
      const kind = device.kind;
      const members = one && GROUPED_KINDS.includes(kind) ? m.climates.filter((c) => c.device.kind === kind) : [];
      if (members.length < 2) { out.push({ type: 'climate', key: `climate/${device.id}`, room, device }); continue; }
      if (done.has(kind)) continue;
      done.add(kind);
      const key = `climate-group/${kind}`;
      out.push({ type: 'climateGroup', key, kind, devices: members.map((c) => c.device) });
      for (const c of members) out.push({ type: 'climate', key: `climate/${c.device.id}`, room: c.room, device: c.device, memberOf: key });
    }
    if (m.media.length) out.push({ type: 'media', key: 'media', devices: m.media, tiles: m.media.length });
    return out;
  };
  return m;
}

/** Виды термостатов, которые на странице комнаты собираются в одну общую карточку. */
export const GROUPED_KINDS = Object.freeze(['FLOOR', 'RADIATOR', 'CONVECTOR']);

/**
 * Общая карточка термостатов: питание и «+/−» уходят каждому доступному термостату
 * отдельной командой — недоступный не мешает остальным.
 */
export function climateGroupState(devices, pendingTarget = {}) {
  const live = devices.filter((d) => d.available);
  const on = live.filter((d) => d.mode !== 'off');
  const lead = on[0] ?? live[0] ?? null;
  return {
    live, on,
    target: lead ? (pendingTarget[lead.id] ?? lead.target) : null,
    current: lead?.current ?? null,
    unavailable: devices.length - live.length,
  };
}

/** Команды питания общей карточки: включить — каждому свой режим обогрева, выключить — включённые. */
export function climateGroupPower(devices, turnOn, remembered = {}) {
  const live = devices.filter((d) => d.available);
  if (!turnOn) return live.filter((d) => d.mode !== 'off').map((d) => ({ type: 'ClimateMode', id: d.id, mode: 'off' }));
  return live.filter((d) => d.mode === 'off').map((d) => {
    const modes = availableModes(d).filter((x) => x !== 'off');
    const mode = modes.find((x) => x === remembered[d.id]) ?? modes.find((x) => x === 'heat') ?? modes[0];
    return mode ? { type: 'ClimateMode', id: d.id, mode } : null;
  }).filter(Boolean);
}

/** Комната из одних климатических приборов («Климат» дачи): «8 кондиционеров · включено 1»; иначе null. */
export function climateOnlySummary(room) {
  if (!room.climates.length || room.lights.length || room.covers.length || room.toggles.length) return null;
  const n = room.climates.length;
  const on = room.climates.filter((c) => c.mode !== 'off').length;
  const what = room.climates.every((c) => c.kind === 'AC')
    ? plural(n, 'кондиционер', 'кондиционера', 'кондиционеров')
    : plural(n, 'термостат', 'термостата', 'термостатов');
  return `${n} ${what} · ` + (on === 0 ? 'все выключены' : `включено ${on}`);
}
