// Сборка дома из состояний Home Assistant по конфигу интеграции (sensor.bms_tablet_*).
// Порт ha/HaRepository.kt (путь с интеграцией), ha/TabletConfig.kt, ha/EntityMapping.kt, model/House.kt.
import {
  CLIMATE_KIND, TOGGLE_KIND, hvacFrom, coverDirectionFrom, isControllable, climateIsOn, roomLightsOn,
  roomSensors, roomBackground, lightDevice, climateDevice, coverDevice, toggleDevice, cameraDevice,
} from './devices.js';

// ---------------------------------------------------------------- разбор атрибутов (как org.json)

const isNullAttr = (o, k) => o == null || o[k] === undefined || o[k] === null;
const isBlank = (s) => s.trim() === '';

/** str(): null и пустая строка — null. Числа и булевы — строкой, как optString. */
export function str(o, k) {
  if (isNullAttr(o, k)) return null;
  const v = o[k];
  const s = typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '';
  return isBlank(s) ? null : s;
}

/** dbl(): число или строка-число; всё остальное — null. */
export function dbl(o, k) {
  if (isNullAttr(o, k)) return null;
  const v = o[k];
  let n = NaN;
  if (typeof v === 'number') n = v;
  else if (typeof v === 'string' && !isBlank(v)) n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function int(o, k, fallback) {
  const n = dbl(o, k);
  return n === null ? fallback : Math.trunc(n);
}

function bool(o, k, fallback) {
  if (isNullAttr(o, k)) return fallback;
  const v = o[k];
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string' && /^(true|false)$/i.test(v)) return v.toLowerCase() === 'true';
  return fallback;
}

/** Список строк атрибута (`fan_modes`, `preset_modes`); пусто — нет. */
export function strings(o, k) {
  const list = o?.[k];
  if (!Array.isArray(list)) return [];
  return list.map((v) => (v === null || v === undefined ? 'null' : String(v)))
    .filter((v) => !isBlank(v) && v !== 'null');
}

const obj = (o, k) => (o && o[k] && typeof o[k] === 'object' && !Array.isArray(o[k]) ? o[k] : null);
const coerceIn = (v, min, max) => Math.min(Math.max(v, min), max);

/** Kotlin String.toDoubleOrNull для состояния датчика. */
function toDoubleOrNull(s) {
  if (typeof s !== 'string') return null;
  const t = s.trim();
  return /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t) ? Number(t) : null;
}

// ---------------------------------------------------------------- классификация сущностей

// «пол» отдельным словом: «Тёплый пол», «floor», но не «полотенцесушитель» и не «потолок».
const FLOOR_WORD = /(^|[^а-яёa-z0-9])(пол|полы|floor|underfloor)([^а-яёa-z0-9]|$)/iu;
const LIGHT_WORDS = ['свет', 'лампа', 'лампы', 'люстр', 'бра', 'спот', 'подсвет', 'торшер', 'ночник', 'light', 'lamp', 'chandelier', 'spot'];
const TV_WORDS = ['телевизор', 'тв', 'tv', 'телек', 'приставк'];
const FAN_WORDS = ['вентил', 'вытяж', 'проветр', 'рекуперат', 'fan', 'vent', 'hood', 'exhaust'];
// Не «вода» и не «насос»: насос стоит и на скважине, и в бассейне.
const IRRIGATION_WORDS = ['полив', 'капель', 'орошен', 'sprinkler', 'irrigation', 'drip'];
const HUMIDITY_WORDS = ['влажн', 'humid'];
const hasWord = (text, words) => words.some((w) => text.includes(w));

export const isFloorRelated = (name) => FLOOR_WORD.test(name);

/** Полив по имени или entity_id: реле часто зовут `switch.irrigation_1` без имени. */
export const looksLikeIrrigation = (...names) =>
  names.some((n) => typeof n === 'string' && hasWord(n.toLowerCase(), IRRIGATION_WORDS));

/** «Включено» для реле и клапана: клапан в процессе открытия уже льёт воду. */
export const isOnState = (state) => ['on', 'open', 'opening'].includes(String(state).toLowerCase());

/** Недоступные и неизвестные сущности на планшет не выносим. */
export function isUsableState(state) {
  if (typeof state !== 'string' || isBlank(state)) return false;
  const s = state.toLowerCase();
  return s !== 'unavailable' && s !== 'unknown';
}

export function climateKindOf(name) {
  const n = name.toLowerCase();
  if (isFloorRelated(n)) return 'FLOOR';
  if (n.includes('радиатор') || n.includes('батаре') || n.includes('radiator')) return 'RADIATOR';
  if (n.includes('конвектор') || n.includes('convector')) return 'CONVECTOR';
  return 'AC';
}

/** Свет, заведённый через `switch.*` (реле в щите), показываем как свет. */
export const looksLikeLight = (name) => hasWord(name.toLowerCase(), LIGHT_WORDS);

export function toggleKindOf(domain, name, deviceClass = null) {
  const n = name.toLowerCase();
  // Колонка у media_player — «Музыка», а не «Телевизор».
  if (domain === 'media_player') {
    if (deviceClass === 'tv') return 'TV';
    if (deviceClass === 'speaker' || deviceClass === 'receiver') return 'MEDIA';
    return hasWord(n, TV_WORDS) ? 'TV' : 'MEDIA';
  }
  if (domain === 'fan') return 'FAN';
  // Полив раньше вентиляции: «Клапан полива» не вытяжка.
  if (looksLikeIrrigation(n)) return 'IRRIGATION';
  if (hasWord(n, TV_WORDS)) return 'TV';
  if (hasWord(n, FAN_WORDS)) return 'FAN';
  return 'OTHER';
}

/** Больше 8 `switch.*` на устройстве — служебные тумблеры техники (пылесос даёт 41). */
export const MAX_SWITCHES_PER_DEVICE = 8;

export function switchIsUseful(name, switchesOnDevice) {
  if (switchesOnDevice > MAX_SWITCHES_PER_DEVICE) return false;
  const n = name.toLowerCase();
  return hasWord(n, LIGHT_WORDS) || hasWord(n, TV_WORDS) || hasWord(n, FAN_WORDS) || hasWord(n, IRRIGATION_WORDS);
}

/** Класс датчика по единице, когда device_class не проставлен (как в интеграции). */
export function sensorKindByUnit(unit, name) {
  const u = typeof unit === 'string' ? unit.trim() : null;
  if (['°C', 'C', '°F', 'F'].includes(u)) return 'temperature';
  // Проценты — не только влажность: батарейка, сигнал. Берём только названное влажностью.
  if (u === '%') return hasWord(name.toLowerCase(), HUMIDITY_WORDS) ? 'humidity' : null;
  return null;
}

/** Роли, которые планшет умеет рисовать (словарь общий с интеграцией, заведомо неполный). */
export const KNOWN_ROLES = new Set([
  'light', 'ac', 'floor', 'radiator', 'convector', 'cover', 'tv', 'media', 'fan', 'irrigation',
  'camera', 'other', 'sensor_air_temp', 'sensor_floor_temp', 'sensor_humidity',
]);

const TOGGLE_ROLE = { TV: 'tv', MEDIA: 'media', FAN: 'fan', IRRIGATION: 'irrigation', OTHER: 'other' };
const toggleRole = (domain, name, deviceClass) => TOGGLE_ROLE[toggleKindOf(domain, name, deviceClass)];

/** Роль «как понял планшет» (зеркало auto_role интеграции). null — не показывать. */
export function autoRole(entityId, name, deviceClass, unit = null, switchesOnDevice = 1) {
  const dot = entityId.indexOf('.');
  const domain = dot < 0 ? '' : entityId.slice(0, dot);
  switch (domain) {
    case 'light': return 'light';
    case 'switch':
      if (switchesOnDevice > MAX_SWITCHES_PER_DEVICE) return null;
      // Полив сильнее света: «Свет у полива» на грядке — всё-таки полив.
      if (looksLikeIrrigation(name, entityId)) return 'irrigation';
      if (!switchIsUseful(name, switchesOnDevice)) return null;
      if (looksLikeLight(name)) return 'light';
      return toggleRole(domain, name, deviceClass);
    // Клапан воды — полив; газ и стояк сами на планшет не лезут.
    case 'valve': return deviceClass === 'water' || looksLikeIrrigation(name, entityId) ? 'irrigation' : null;
    case 'fan': case 'media_player': return toggleRole(domain, name, deviceClass);
    case 'climate': return { FLOOR: 'floor', RADIATOR: 'radiator', CONVECTOR: 'convector', AC: 'ac' }[climateKindOf(name)];
    case 'cover': return 'cover';
    case 'camera': return 'camera';
    case 'sensor': {
      const kind = deviceClass ?? sensorKindByUnit(unit, name);
      if (kind === 'temperature') return isFloorRelated(name) ? 'sensor_floor_temp' : 'sensor_air_temp';
      if (kind === 'humidity') return 'sensor_humidity';
      return null;
    }
    default: return null;
  }
}

const titlecaseFirst = (s) => (s ? s.charAt(0).toLocaleUpperCase('ru') + s.slice(1) : s);

/** Короткое имя для плитки: «Гостиная Люстра» в комнате «Гостиная» → «Люстра». */
export function shortDeviceName(fullName, roomName) {
  let s = fullName.trim();
  if (!isBlank(roomName)) {
    const room = roomName.toLowerCase();
    for (const p of [' ', '. ', ' - ', ' — ', ': '].map((sep) => room + sep)) {
      if (s.toLowerCase().startsWith(p)) { s = s.slice(p.length).trim(); break; }
    }
    const suffix = ' ' + room;
    if (s.toLowerCase().endsWith(suffix)) s = s.slice(0, s.length - suffix.length).trim();
  }
  if (s === '') return fullName;
  return titlecaseFirst(s);
}

// ---------------------------------------------------------------- конфиг интеграции

export const TABLET_SENSOR_PREFIX = 'sensor.bms_tablet_';
const HOME_KEY = '__home__';
/** Предел длины подзоны — тот же, что проверяет интеграция. */
export const ZONE_MAX_LENGTH = 60;

const startsWithHttp = (u) => u.toLowerCase().startsWith('http');

/**
 * Фон из конфига. needsAuth — фото лежит на самом HA (относительный путь или
 * адрес HA): токен уходит только туда, никуда больше.
 */
export function parseBackground(json, httpBase) {
  if (!json || typeof json !== 'object') return roomBackground({});
  const url = str(json, 'url');
  if (url === null) return roomBackground({});
  const t = obj(json, 'transform');
  const base = httpBase || '';
  const ownHost = !startsWithHttp(url) || (base !== '' && url.toLowerCase().startsWith(base.toLowerCase()));
  return roomBackground({
    imageUrl: startsWithHttp(url) ? url : base.replace(/\/+$/, '') + '/' + url.replace(/^\/+/, ''),
    zoom: coerceIn(dbl(t, 'zoom') ?? 1, 0.5, 4),
    dx: coerceIn(dbl(t, 'dx') ?? 0, -1, 1),
    dy: coerceIn(dbl(t, 'dy') ?? 0, -1, 1),
    dim: coerceIn(dbl(json, 'dim') ?? 0.24, 0, 0.9),
    blur: coerceIn(dbl(json, 'blur') ?? 0.35, 0, 1),
    version: int(json, 'version', 0),
    needsAuth: ownHost,
  });
}

/** `__home__7` → 7; `__home__`, `__home__0`, `__home__07`, `__home__abc` — null. Номера 1…99. */
export function homeBackgroundNumber(key) {
  if (!key.startsWith(HOME_KEY)) return null;
  const digits = key.slice(HOME_KEY.length);
  if (!/^[1-9][0-9]?$/.test(digits)) return null;
  return Number(digits);
}

/** Все `__home__N` из ключей карты фонов → {N: фон}. */
export function parseHomeBackgrounds(keys, parse) {
  const out = {};
  for (const key of keys) {
    const n = homeBackgroundNumber(key);
    if (n !== null) out[n] = parse(key);
  }
  return out;
}

/** Общий фон планшета с номером: свой, если есть фото, иначе общий `__home__`. */
export function homeBackground(settings, number) {
  const own = number == null ? null : settings.homeBackgrounds?.[number];
  return own && own.imageUrl != null ? own : settings.background;
}

export function parseTabletConfig(attributes, httpBase) {
  const tabletId = str(attributes, 'tablet_id');
  if (tabletId === null) return null;
  const ambient = obj(attributes, 'ambient');
  const backgrounds = obj(attributes, 'backgrounds');
  const settings = {
    kiosk: bool(attributes, 'kiosk', false),
    homeName: str(attributes, 'tablet_name') ?? str(attributes, 'name'),
    background: parseBackground(obj(backgrounds, HOME_KEY), httpBase),
    homeBackgrounds: backgrounds
      ? parseHomeBackgrounds(Object.keys(backgrounds), (k) => parseBackground(obj(backgrounds, k), httpBase)) : {},
    startArea: str(attributes, 'start_area'),
    ambientMode: str(ambient, 'mode') ?? 'never',
    ambientTimeoutSec: int(ambient, 'timeout_sec', 180),
    motionEntity: str(ambient, 'motion_entity'),
    brightnessActive: int(ambient, 'brightness_active', 100),
    brightnessAmbient: int(ambient, 'brightness_ambient', 15),
  };
  const rooms = [];
  const roomsArray = Array.isArray(attributes?.rooms) ? attributes.rooms : [];
  roomsArray.forEach((r, i) => {
    if (!r || typeof r !== 'object') return;
    const areaId = str(r, 'area_id');
    if (areaId === null) return;
    const entities = [];
    for (const e of Array.isArray(r.entities) ? r.entities : []) {
      if (!e || typeof e !== 'object') continue;
      const entityId = str(e, 'entity_id');
      if (entityId === null) continue;
      const zone = str(e, 'zone')?.trim().slice(0, ZONE_MAX_LENGTH).trim() || null;
      entities.push({
        entityId,
        name: str(e, 'name') ?? entityId,
        role: str(e, 'role') ?? 'other',
        coverDirection: coverDirectionFrom(str(e, 'cover_direction')),
        icon: str(e, 'icon'),
        zone,
      });
    }
    rooms.push({
      areaId,
      name: str(r, 'name') ?? areaId,
      floorName: str(r, 'floor_name'),
      originalName: str(r, 'original_name'),
      order: int(r, 'order', i),
      entities,
      background: parseBackground(obj(r, 'background'), httpBase),
    });
  });
  rooms.sort((a, b) => a.order - b.order);
  return { tabletId, revision: int(attributes, 'revision', 0), settings, rooms };
}

// ---------------------------------------------------------------- сборка комнат

const MEDIA_OFF_STATES = new Set(['off', 'unavailable', 'unknown', 'standby']);
const DEFAULT_MIN = { AC: 16, FLOOR: 15, RADIATOR: 10, CONVECTOR: 10 };
const DEFAULT_MAX = { AC: 30, FLOOR: 35, RADIATOR: 30, CONVECTOR: 30 };
const ROLE_KIND = { floor: 'FLOOR', radiator: 'RADIATOR', convector: 'CONVECTOR' };
const UNAVAILABLE = Object.freeze({ state: 'unavailable', attributes: {} });

const entriesOf = (states) => (states instanceof Map ? [...states.entries()] : Object.entries(states || {}));
const stateOf = (states, id) => (states instanceof Map ? states.get(id) : states?.[id]);

export function brightnessPercent(st) {
  if (isNullAttr(st.attributes, 'brightness')) return null;
  const raw = int(st.attributes, 'brightness', -1);
  if (raw < 0) return null;
  return coerceIn(Math.round((raw * 100) / 255), 0, 100);
}

export function climateFrom(entityId, label, st, kind) {
  const a = st.attributes || {};
  const current = dbl(a, 'current_temperature');
  const rawMin = dbl(a, 'min_temp');
  const min = rawMin !== null && rawMin >= -100 && rawMin <= 150 ? rawMin : DEFAULT_MIN[kind];
  const rawMax = dbl(a, 'max_temp');
  const max = rawMax !== null && rawMax > min && rawMax <= 200 ? rawMax : Math.max(DEFAULT_MAX[kind], min + 1);
  const rawStep = dbl(a, 'target_temp_step');
  const step = rawStep !== null && rawStep > 0 && rawStep <= max - min ? rawStep : 1;
  const target = dbl(a, 'temperature') ?? current ?? (min + max) / 2;
  const supported = [];
  for (const m of Array.isArray(a.hvac_modes) ? a.hvac_modes : []) {
    const mode = hvacFrom(m === null || m === undefined ? '' : String(m));
    if (!supported.includes(mode)) supported.push(mode);
  }
  return climateDevice({
    id: entityId, kind, name: isBlank(label) ? CLIMATE_KIND[kind].title : label,
    mode: hvacFrom(st.state), target: coerceIn(target, min, max), current, min, max, step,
    supportedModes: supported,
    // Скорость вентилятора объявляют не все: у пола и конвектора лишнего ряда не будет.
    fanMode: str(a, 'fan_mode'), fanModes: strings(a, 'fan_modes'),
  });
}

/** Вытяжка: кнопка, ступени скорости или именованные пресеты. */
export function fanFrom(entityId, label, st) {
  const a = st.attributes || {};
  const pct = dbl(a, 'percentage');
  return toggleDevice({
    id: entityId, kind: 'FAN', name: isBlank(label) ? TOGGLE_KIND.FAN.title : label,
    isOn: String(st.state).toLowerCase() === 'on',
    speed: pct === null ? null : Math.round(pct),
    speedStep: dbl(a, 'percentage_step'),
    presetMode: str(a, 'preset_mode'),
    presetModes: strings(a, 'preset_modes'),
  });
}

export function coverFrom(entityId, label, st) {
  const state = String(st.state).toLowerCase();
  const a = st.attributes || {};
  let position;
  if (isNullAttr(a, 'current_position')) position = state === 'open' ? 100 : state === 'closed' ? 0 : null;
  else position = coerceIn(int(a, 'current_position', 0), 0, 100);
  return coverDevice({
    id: entityId, name: label, position, deviceClass: str(a, 'device_class'),
    available: state !== 'unavailable' && state !== 'unknown',
    isOpening: state === 'opening', isClosing: state === 'closing',
  });
}

/** Комнаты ровно так, как их собрал монтажник в интеграции; пустые не попадают. */
export function buildRoomsFromConfig(config, states) {
  const rooms = [];
  for (const rc of config.rooms) {
    const lights = []; const climates = []; const covers = []; const toggles = []; const cameras = [];
    const sensors = roomSensors({});
    for (const entity of rc.entities) {
      const id = entity.entityId;
      // Недоступные устройства остаются видны, управление у них выключено.
      const st = stateOf(states, id) ?? UNAVAILABLE;
      const friendly = entity.name;
      const label = shortDeviceName(friendly, rc.name);
      const on = isOnState(st.state);
      // Интеграция новее планшета пришлёт незнакомую роль — определяем сами, а не выбрасываем.
      const role = KNOWN_ROLES.has(entity.role) ? entity.role
        : autoRole(id, friendly, str(st.attributes, 'device_class'), str(st.attributes, 'unit_of_measurement'));
      if (role === null) continue;
      switch (role) {
        case 'light': lights.push(lightDevice({ id, name: label, isOn: on, brightness: brightnessPercent(st) })); break;
        case 'ac': case 'floor': case 'radiator': case 'convector':
          climates.push(climateFrom(id, label, st, ROLE_KIND[role] ?? 'AC')); break;
        case 'cover': covers.push({ ...coverFrom(id, label, st), direction: entity.coverDirection }); break;
        // Вытяжка с регулировкой скорости — не просто тумблер.
        case 'fan':
          toggles.push(id.startsWith('fan.') ? fanFrom(id, label, st) : toggleDevice({ id, kind: 'FAN', name: label, isOn: on }));
          break;
        case 'irrigation': toggles.push(toggleDevice({ id, kind: 'IRRIGATION', name: label, isOn: on })); break;
        case 'camera': cameras.push(cameraDevice({ id, name: label, available: isUsableState(st.state) })); break;
        case 'tv': case 'media': case 'other': {
          const kind = role === 'tv' ? 'TV' : role === 'media' ? 'MEDIA' : 'OTHER';
          const isOn = id.startsWith('media_player.') ? !MEDIA_OFF_STATES.has(String(st.state).toLowerCase()) : on;
          toggles.push(toggleDevice({ id, kind, name: label, isOn }));
          break;
        }
        case 'sensor_air_temp': case 'sensor_floor_temp': case 'sensor_humidity': {
          const field = { sensor_air_temp: 'airTemp', sensor_floor_temp: 'floorTemp', sensor_humidity: 'humidity' }[role];
          if (sensors[field] === null) {
            sensors[field] = toDoubleOrNull(st.state);
            if (sensors[field] !== null) sensors[field + 'Id'] = id;
          }
          break;
        }
        default: break;
      }
    }
    const icons = new Map(rc.entities.map((e) => [e.entityId, e.icon]));
    const zones = new Map(rc.entities.map((e) => [e.entityId, e.zone]));
    const avail = (d) => isUsableState((stateOf(states, d.id) ?? UNAVAILABLE).state);
    const finish = (d, withZone) => ({ ...d, icon: icons.get(d.id) ?? null, ...(withZone ? { zone: zones.get(d.id) ?? null } : {}), available: avail(d) });
    const room = {
      id: rc.areaId, name: rc.name, floorName: rc.floorName, originalName: rc.originalName, hallSection: false,
      sensors, background: rc.background,
      lights: lights.map((d) => finish(d, true)),
      climates: climates.map((d) => finish(d, false)),
      covers: covers.map((d) => finish(d, true)),
      toggles: toggles.map((d) => finish(d, true)),
      cameras,
    };
    if (isControllable(room)) rooms.push(room);
  }
  return rooms;
}

// ---------------------------------------------------------------- погода и сводка

const WEATHER_RU = {
  'clear-night': 'ясно', cloudy: 'облачно', exceptional: 'особые условия', fog: 'туман', hail: 'град',
  lightning: 'гроза', 'lightning-rainy': 'гроза с дождём', partlycloudy: 'переменная облачность',
  pouring: 'ливень', rainy: 'дождь', snowy: 'снег', 'snowy-rainy': 'мокрый снег', sunny: 'ясно',
  windy: 'ветрено', 'windy-variant': 'ветрено',
};

/** Первая сущность weather.* — их в доме обычно одна. */
export function buildWeather(states) {
  for (const [id, st] of entriesOf(states)) {
    if (!id.startsWith('weather.') || !isUsableState(st?.state)) continue;
    return {
      condition: st.state,
      ru: Object.prototype.hasOwnProperty.call(WEATHER_RU, st.state) ? WEATHER_RU[st.state] : null,
      temperature: dbl(st.attributes, 'temperature'),
      humidity: dbl(st.attributes, 'humidity'),
    };
  }
  return null;
}

/** Конфиг интеграции: первый `sensor.bms_tablet_*` по entity_id. */
export function findTabletConfig(states, httpBase) {
  let best = null;
  for (const [id] of entriesOf(states)) if (id.startsWith(TABLET_SENSOR_PREFIX) && (best === null || id < best)) best = id;
  if (best === null) return null;
  return parseTabletConfig(stateOf(states, best)?.attributes || {}, httpBase);
}

/**
 * Дом целиком. [fallbackConfig] — последний хороший конфиг: сенсор пропадает на время
 * перезагрузки интеграции, и дом в это время держится на нём (result.config — передать сюда же).
 */
export function buildHouse(states, httpBase = '', fallbackConfig = null) {
  const config = findTabletConfig(states, httpBase) ?? fallbackConfig;
  const weather = buildWeather(states);
  if (config === null) return { rooms: [], settings: null, weather, configured: false, config: null };
  return { rooms: buildRoomsFromConfig(config, states), settings: config.settings, weather, configured: true, config };
}

/** Сущности, чьё изменение меняет картину дома: из конфига, погода, сами сенсоры конфига. */
export function relevantEntityIds(states, config = null) {
  const ids = new Set();
  for (const [id] of entriesOf(states)) if (id.startsWith('weather.') || id.startsWith(TABLET_SENSOR_PREFIX)) ids.add(id);
  const cfg = findTabletConfig(states, '') ?? config;
  for (const room of cfg?.rooms ?? []) for (const e of room.entities) ids.add(e.entityId);
  return ids;
}

/** Сводка для общего и спящего экранов (houseStats). */
export function houseStats(rooms) {
  const avg = (xs) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null);
  if (!rooms.length) return { averageTemperature: null, averageHumidity: null, devicesOn: 0, devicesTotal: 0, lightsOn: 0 };
  let on = 0; let total = 0;
  for (const r of rooms) {
    total += r.lights.length + r.climates.length + r.toggles.length;
    on += roomLightsOn(r) + r.climates.filter(climateIsOn).length + r.toggles.filter((t) => t.isOn).length;
  }
  return {
    averageTemperature: avg(rooms.map((r) => r.sensors.airTemp).filter((v) => v != null)),
    averageHumidity: avg(rooms.map((r) => r.sensors.humidity).filter((v) => v != null)),
    devicesOn: on, devicesTotal: total, lightsOn: rooms.reduce((s, r) => s + roomLightsOn(r), 0),
  };
}
