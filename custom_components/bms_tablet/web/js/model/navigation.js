// Навигация по дому: зоны, этажи, холл, страницы, раскладка комнаты, группы света.
// Порт ui/premium/HomeNavigation.kt и model/LightGrouping.kt.
import { isFloorRelated } from './house.js';

/** Подзоны холла из утверждённого дома. entity_id всегда из HA. */
/** Комната-холл: «Холл», «Холл подвала» — подзоны по hallSections, прочий свет — «Освещение». */
export const isHallRoom = (cleanName) => cleanName === 'холл' || cleanName.startsWith('холл ');

export const hallSections = Object.freeze(['Центральный холл', 'Левый холл', 'Правый холл', 'Левый коридор', 'Правый коридор', 'Лифтовой коридор', 'Дворовый вход', 'Тамбур', 'Левый тамбур', 'Правый тамбур']);
const basement = new Set(['кинотеатр', 'детская площадка', 'учебная комната', 'холл подвала', 'котельный', 'котельная', 'левый санузел', 'гардероб', 'кладовая', 'постирочная']);
const terrace = new Set(['бильярд', 'зона отдыха', 'терраса']);
const yard = new Set(['двор', 'летняя кухня', 'задний двор', 'навес', 'гараж']);
const clean = (s) => s.toLowerCase().replaceAll('ё', 'е').trim();
const isBlank = (s) => s == null || s.trim() === '';
const cap = (s) => (s ? s.charAt(0).toLocaleUpperCase('ru') + s.slice(1) : s);
const nameOf = (room) => room.originalName ?? room.name;

/** Зона комнаты: этаж из HA, иначе — по имени помещения. */
export function zoneOf(room) {
  if (!isBlank(room.floorName)) return room.floorName;
  const name = clean(nameOf(room));
  if (basement.has(name) || name.includes('подвал')) return 'Подвал';
  if (terrace.has(name)) return 'Терраса';
  if (yard.has(name)) return 'Двор';
  if (name.includes('бассейн') || name === 'сауна' || name === 'парилка') return 'Бассейн';
  return '1 этаж';
}

/** Ключ страницы холла: не совпадёт с area_id из HA (там только slug). */
export const HALL_PAGE = '#hall';

const isHallName = (room) => hallSections.some((s) => clean(s) === clean(nameOf(room)));

/**
 * Подзоны холла сливаются в одну страницу, только когда их две и больше:
 * одинокий «Тамбур» в обычном доме — своя комната.
 */
export function markHallSections(rooms) {
  const grouped = rooms.filter(isHallName).length >= 2;
  return rooms.map((room) => {
    const hall = grouped && isHallName(room);
    return room.hallSection === hall ? room : { ...room, hallSection: hall };
  });
}

/** Подпись страницы. Для навигации не годится: два «Санузла» на разных этажах совпадут. */
export const pageOf = (room) => (room.hallSection ? 'Холл' : room.name);
/** Ключ страницы — по id зоны: одинаковые имена и переименование не путают комнаты. */
export const pageKey = (room) => (room.hallSection ? HALL_PAGE : room.id);
export const pageRooms = (rooms, key) => rooms.filter((r) => pageKey(r) === key);
export function roomPages(rooms) {
  const seen = new Set();
  return rooms.filter((r) => { const k = pageKey(r); if (seen.has(k)) return false; seen.add(k); return true; });
}

const ordinals = [['перв', 1], ['втор', 2], ['трет', 3], ['четв', 4], ['пят', 5]];

/** Номер этажа из названия в HA: «1 этажа», «2-этаж», «Этаж 2», «Второй этаж», «Floor 1». Не этаж — null. */
export function floorNumberOf(zone) {
  const name = clean(zone);
  if (!name.includes('этаж') && !name.includes('floor')) return null;
  const m = name.match(/-?\d+/);
  if (m) return parseInt(m[0], 10);
  return ordinals.find(([word]) => name.includes(word))?.[1] ?? null;
}

/**
 * Подпись зоны: этаж с номером — «N этаж», как бы его ни назвали в HA
 * (владелец спросил, откуда «этажа»). Ключ маршрута остаётся именем из HA.
 */
export function zoneLabel(zone) {
  const n = floorNumberOf(zone);
  return n !== null && n > 0 ? `${n} этаж` : zone;
}

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const distinct = (xs) => [...new Set(xs)];

/** Главный этаж дома — первый, как бы он ни был назван в HA. */
export function mainZone(rooms) {
  const firsts = distinct(rooms.map(zoneOf)).filter((z) => floorNumberOf(z) === 1).sort(cmp);
  return firsts.length ? firsts[0] : '1 этаж';
}

/** Этажи — по номеру и первыми, дальше подвал, терраса, двор, бассейн. */
/**
 * Здание этажа: имя этажа без самого этажа. «Гостевой Дом 1 этаж» → «Гостевой Дом»,
 * «1-этаж» → "" (главное здание). Не этаж (подвал, двор) — главное здание.
 */
export function buildingOf(zone) {
  if (floorNumberOf(zone) === null) return '';
  return zone.trim().split(/[\s\-–—_.,·]+/).filter(Boolean).filter((w) => {
    const c = clean(w);
    return !(c.startsWith('этаж') || c === 'floor' || /^-?\d+(-?(й|ой|ий|ый|ая|я))?$/.test(c)
      || ordinals.some(([stem]) => c.startsWith(stem)));
  }).join(' ');
}

/** Подпись главного здания, когда зданий несколько. */
export const MAIN_BUILDING = 'Главный дом';

/** Здания по порядку: главное первым, остальные по имени. */
export function buildings(rooms) {
  return distinct(zones(rooms).map(buildingOf)).sort((a, b) => (a !== '') - (b !== '') || cmp(a, b));
}

/** Полное имя зоны для заголовков: «Гостевой Дом · 1 этаж». */
export function zoneTitle(zone) {
  const b = buildingOf(zone);
  return b ? `${b} · ${zoneLabel(zone)}` : zoneLabel(zone);
}

export function zones(rooms) {
  const order = ['Подвал', 'Терраса', 'Двор', 'Бассейн'];
  const rank = (z) => floorNumberOf(z) ?? 1000 + (order.indexOf(z) < 0 ? 99 : order.indexOf(z));
  return distinct(rooms.map(zoneOf)).sort((a, b) => rank(a) - rank(b) || cmp(a, b));
}

/**
 * Карточки этажа и ряд «Прочие помещения»: санузлы внизу, остальные зоны — карточками;
 * порядок демо-дома — только сортировка.
 */
export function floorSplit(pages, order) {
  const rank = (room) => { const i = order.indexOf(room.originalName ?? pageOf(room)); return i < 0 ? Infinity : i; };
  const sorted = [...pages].sort((a, b) => (rank(a) === rank(b) ? 0 : rank(a) < rank(b) ? -1 : 1));
  return { featured: sorted.filter((r) => !isUtilityRoom(r)), others: sorted.filter(isUtilityRoom) };
}

/** Санузел и туалет — маленькой плиткой внизу этажа (владелец, 01.10.2026). */
export function isUtilityRoom(room) {
  const name = clean(pageOf(room));
  return ['санузел', 'туалет', 'с/у', 'wc'].some((w) => name.includes(w));
}

/** Разделитель подзоны в имени: «Летняя кухня · Споты». */
export const ZONE_SEPARATOR = ' · ';

/**
 * Подзона и подпись плитки. Явная подзона главнее имени; без неё — то, что до « · ».
 * Совпадающий с явной подзоной префикс в подписи не повторяем.
 */
export function zoneAndLabel(name, explicit) {
  const zone = typeof explicit === 'string' ? (explicit.trim().slice(0, 60).trim() || null) : null;
  const cut = name.indexOf(ZONE_SEPARATOR);
  const prefix = cut > 0 ? name.slice(0, cut).trim() : '';
  const rest = cut > 0 ? name.slice(cut + ZONE_SEPARATOR.length).trim() : '';
  if (zone !== null) {
    return { zone, label: prefix && rest && clean(prefix) === clean(zone) ? cap(rest) : name };
  }
  if (!prefix || !rest) return { zone: null, label: name };
  return { zone: prefix, label: cap(rest) };
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const trimChars = (s, chars) => {
  let a = 0; let b = s.length;
  while (a < b && chars.includes(s[a])) a++;
  while (b > a && chars.includes(s[b - 1])) b--;
  return s.slice(a, b);
};

/** Подзона света в холле: кроме « · » узнаём подзону в любом месте имени («Левый коридор Бра»). */
function hallZoneAndLabel(light) {
  const direct = zoneAndLabel(light.name, light.zone);
  if (direct.zone !== null) return direct;
  const section = [...hallSections].sort((a, b) => b.length - a.length).find((s) => clean(light.name).includes(clean(s)));
  if (!section) return { zone: null, label: light.name };
  let label = trimChars(light.name.replace(new RegExp(escapeRe(section), 'giu'), ''), ' ·-:/');
  if (isBlank(label)) label = light.name;
  return { zone: section, label: cap(label) };
}

/** Подзона → {zone, items} с подписями без подзоны. Порядок подзон — по первому устройству. */
function byZone(items, split) {
  const groups = new Map();
  for (const item of items) {
    const { zone, label } = split(item);
    const key = zone === null ? null : clean(zone);
    if (!groups.has(key)) groups.set(key, { zone, items: [] });
    groups.get(key).items.push(label === item.name ? item : { ...item, name: label });
  }
  return groups;
}
const plainZone = (d) => zoneAndLabel(d.name, d.zone);

/** Реле тёплого пола: на странице комнаты — отдельной карточкой. */
export const isFloorHeatingRelay = (d) => d.kind !== 'FAN' && d.kind !== 'IRRIGATION' && isFloorRelated(d.name);
/** Зона полива: карточкой «Полив», а не среди оборудования. */
export const isIrrigationZone = (d) => d.kind === 'IRRIGATION';

/**
 * Раскладка страницы одной комнаты: {lights — свет без подзоны, zones — [{title, lights, toggles}],
 * floorHeating, irrigation, toggles — прочие тумблеры без подзоны}.
 */
export function roomLayout(room) {
  const lights = byZone(room.lights, plainZone);
  const irrigation = room.toggles.filter(isIrrigationZone);
  const rest = room.toggles.filter((t) => !isIrrigationZone(t));
  const floor = rest.filter(isFloorHeatingRelay);
  const others = rest.filter((t) => !isFloorHeatingRelay(t));
  const toggles = byZone(others, plainZone);
  const keys = distinct([...lights.keys(), ...toggles.keys()].filter((k) => k !== null));
  // Подпись плитки пола и полива — подзона, если есть: «Тёплый пол» в карточке «Тёплый пол» ничего не говорит.
  const zoneName = (t) => { const { zone, label } = plainZone(t); return { ...t, name: zone ?? label }; };
  return {
    lights: lights.get(null)?.items ?? [],
    zones: keys.map((k) => ({
      title: (lights.get(k) ?? toggles.get(k)).zone,
      lights: lights.get(k)?.items ?? [],
      toggles: toggles.get(k)?.items ?? [],
    })),
    floorHeating: floor.map(zoneName),
    irrigation: irrigation.map(zoneName),
    toggles: toggles.get(null)?.items ?? [],
  };
}

/**
 * Группы света комнаты [{title, lights}]: свет без подзоны и по группе на подзону.
 * Холл — подзоны в порядке hallSections, свет без подзоны последним («Освещение»).
 * withRoom — страница нескольких комнат: к подзоне приписываем комнату.
 */
export function lightSections(room, withRoom = false) {
  // «Холл» и «Холл подвала» — раскладка холла (как isHallRoom планшета).
  const hall = isHallRoom(clean(nameOf(room)));
  const groups = byZone(room.lights, hall ? hallZoneAndLabel : plainZone);
  const zoned = [...groups.entries()].filter(([k]) => k !== null).map(([, g]) => ({ title: g.zone, lights: g.items }));
  const rest = groups.get(null)?.items ?? [];
  if (hall) {
    const rank = (z) => { const i = hallSections.findIndex((s) => clean(s) === clean(z)); return i < 0 ? Infinity : i; };
    const sorted = [...zoned].sort((a, b) => (rank(a.title) === rank(b.title) ? 0 : rank(a.title) < rank(b.title) ? -1 : 1));
    return [...sorted, { title: 'Освещение', lights: rest }].filter((s) => s.lights.length);
  }
  return [{ title: room.name, lights: rest }, ...zoned.map((z) => ({ title: withRoom ? `${room.name} · ${z.title}` : z.title, lights: z.lights }))]
    .filter((s) => s.lights.length);
}

/** Шторы — по device_class, иначе по словам; ворота, окна и двери шторами не бывают. */
export function isCurtain(cover) {
  if (cover.deviceClass != null) return ['curtain', 'blind', 'shade', 'shutter'].includes(cover.deviceClass);
  const text = (cover.name + ' ' + cover.id).toLowerCase();
  if (['ворот', 'gate', 'гараж', 'garage', 'окно', 'окна', 'window', 'двер', 'door'].some((w) => text.includes(w))) return false;
  return ['штор', 'тюль', 'портьер', 'ролет', 'жалюзи', 'блэкаут', 'curtain', 'tulle', 'blind', 'shade', 'shutter', 'roller'].some((w) => text.includes(w));
}

export const isGateCover = (cover) =>
  cover.deviceClass === 'gate' || cover.deviceClass === 'garage' || cover.name.toLowerCase().includes('ворота');

// ---------------------------------------------------------------- группы одинаковых светильников

/** Если светильников немного, группировать нечего. */
const GROUP_THRESHOLD = 6;
const TRAILING_INDEX = /^(.*?)[\s\-_.]*(\d{1,3}|[IVX]{1,4})$/iu;

/** «Спот 3» → «Спот», «Подсветка» → «Подсветка». */
export function lightGroupKey(name) {
  const trimmed = name.trim();
  const m = trimmed.match(TRAILING_INDEX);
  if (!m) return trimmed;
  return m[1].trim() || trimmed;
}

const lightGroup = (key, title, lights) => ({ key, title, lights, ids: lights.map((l) => l.id), size: lights.length, onCount: lights.filter((l) => l.isOn).length, isOn: lights.some((l) => l.isOn), isGroup: lights.length > 1 });

/** «Спот 1…8» склеиваются в одну плитку с количеством; по именам из HA, без ручной разметки. */
export function groupLights(lights) {
  const single = () => lights.map((l) => lightGroup(l.id, l.name, [l]));
  if (lights.length <= GROUP_THRESHOLD) return single();
  const order = new Map();
  for (const l of lights) {
    const key = lightGroupKey(l.name).toLowerCase();
    if (!order.has(key)) order.set(key, []);
    order.get(key).push(l);
  }
  const groups = [...order.entries()].map(([key, items]) =>
    lightGroup(key, items.length > 1 ? lightGroupKey(items[0].name) : items[0].name, items));
  // Склейка не помогла (все названия разные) — плоский список.
  return groups.length === lights.length ? single() : groups;
}
