// Модель устройств: порт model/Home.kt (Android). Только чистые функции.
// Устройства — простые объекты с теми же полями, что у Kotlin data class.

/**
 * Режимы климата. Ключ — hvac_mode Home Assistant; порядок ключей = порядок
 * enum HvacMode в Kotlin (по нему сортируются сегменты режимов).
 */
export const HVAC = Object.freeze({
  auto: Object.freeze({ ru: 'Авто', short: 'Авто' }),
  // HA отдаёт heat_cool у сплитов «на автомате» — без него включённый показывался выключенным.
  heat_cool: Object.freeze({ ru: 'Авто', short: 'Авто' }),
  cool: Object.freeze({ ru: 'Охлаждение', short: 'Холод' }),
  heat: Object.freeze({ ru: 'Отопление', short: 'Тепло' }),
  dry: Object.freeze({ ru: 'Осушение', short: 'Сушка' }),
  fan_only: Object.freeze({ ru: 'Вентиляция', short: 'Обдув' }),
  off: Object.freeze({ ru: 'Выкл', short: 'Выкл' }),
});

export const HVAC_ORDER = Object.freeze(Object.keys(HVAC));

/** HvacMode.from: незнакомое и пустое — «off». */
export function hvacFrom(value) {
  if (typeof value !== 'string') return 'off';
  const v = value.toLowerCase();
  return Object.prototype.hasOwnProperty.call(HVAC, v) ? v : 'off';
}

export const hvacIsOn = (mode) => mode !== 'off';

/** Типы климата: заголовок и запасной набор режимов. Кондиционер — холодный, остальное греет. */
export const CLIMATE_KIND = Object.freeze({
  AC: Object.freeze({ title: 'Кондиционер', modes: Object.freeze(['auto', 'cool', 'heat', 'dry', 'fan_only', 'off']), isCold: true }),
  FLOOR: Object.freeze({ title: 'Тёплый пол', modes: Object.freeze(['heat', 'off']), isCold: false }),
  RADIATOR: Object.freeze({ title: 'Радиатор', modes: Object.freeze(['heat', 'off']), isCold: false }),
  CONVECTOR: Object.freeze({ title: 'Конвектор', modes: Object.freeze(['heat', 'off']), isCold: false }),
});

export const CLIMATE_KIND_ORDER = Object.freeze(Object.keys(CLIMATE_KIND));

export const TOGGLE_KIND = Object.freeze({
  TV: Object.freeze({ title: 'Телевизор' }),
  MEDIA: Object.freeze({ title: 'Музыка' }),
  FAN: Object.freeze({ title: 'Вентиляция' }),
  // Полив — такое же «вкл/выкл», но во дворе его ищут отдельным разделом.
  IRRIGATION: Object.freeze({ title: 'Полив' }),
  OTHER: Object.freeze({ title: 'Устройство' }),
});

export const COVER_DIRECTIONS = Object.freeze(['center', 'left_to_right', 'right_to_left']);
export const coverDirectionFrom = (value) => (COVER_DIRECTIONS.includes(value) ? value : 'center');

// ---------------------------------------------------------------- фабрики с умолчаниями Kotlin

export const lightDevice = (f) => ({ brightness: null, available: true, icon: null, zone: null, ...f });

export const climateDevice = (f) => ({
  current: null, min: 16, max: 30, step: 1, supportedModes: [], fanMode: null, fanModes: [],
  available: true, icon: null, ...f,
});

export const coverDevice = (f) => ({
  position: null, isOpening: false, isClosing: false, available: true, deviceClass: null,
  direction: 'center', icon: null, zone: null, ...f,
});

export const toggleDevice = (f) => ({
  speed: null, speedStep: null, presetMode: null, presetModes: [], available: true, icon: null, zone: null, ...f,
});

export const cameraDevice = (f) => ({ available: true, ...f });

export const roomSensors = (f) => ({
  airTemp: null, floorTemp: null, humidity: null, airTempId: null, floorTempId: null, humidityId: null, ...f,
});

export const roomBackground = (f) => ({
  imageUrl: null, zoom: 1, dx: 0, dy: 0, dim: 0.24, blur: 0.35, version: 0, needsAuth: false, ...f,
});

export function makeRoom(f) {
  return {
    floorName: null, originalName: null, hallSection: false,
    lights: [], climates: [], covers: [], toggles: [], cameras: [],
    ...f,
    sensors: roomSensors(f.sensors || {}),
    background: roomBackground(f.background || {}),
  };
}

// ---------------------------------------------------------------- климат

export const climateIsOn = (device) => hvacIsOn(device.mode);

/**
 * Шаг уставки на планшете — целый градус: у пола HA отдаёт 0.1,
 * но человек у стены делает «потеплее», а не набирает 26,4.
 */
export const uiStep = (device) => (device.step < 1 ? 1 : device.step);

const coerceIn = (v, min, max) => Math.min(Math.max(v, min), max);

/** Следующая уставка: от 26,5 «плюс» даёт 27, ступени — от целых градусов. */
export function stepTarget(device, up) {
  const s = uiStep(device);
  const next = up
    ? Math.floor(device.target / s) * s + s
    : Math.ceil(device.target / s) * s - s;
  return coerceIn(next, device.min, device.max);
}

/** Сегменты режимов: от устройства, список по типу — только запасной вариант. */
export function availableModes(device) {
  const own = device.supportedModes || [];
  const modes = own.length ? own : CLIMATE_KIND[device.kind].modes;
  // auto и heat_cool называются одинаково — двух «Авто» в ряду быть не должно.
  const seen = new Map();
  for (const m of modes) {
    const ru = HVAC[m]?.ru;
    if (ru !== undefined && !seen.has(ru)) seen.set(ru, m);
  }
  const result = [...seen.values()];
  if (!result.some((m) => !hvacIsOn(m))) result.push('off');
  // HA часто ставит off первым — приводим к нашему порядку.
  return result.sort((a, b) => HVAC_ORDER.indexOf(a) - HVAC_ORDER.indexOf(b));
}

// ---------------------------------------------------------------- вентиляция

/** Ступени ползунка: шаг 25 → 25/50/75/100, шаг 16,7 (рекуператор) → 17/33/50/67/83/100. */
export function speedSteps(device) {
  const step = device.speedStep;
  if (step == null || step <= 0) return [];
  const count = Math.round(100 / step);
  // Шаг 1 % — уже сплошная шкала: ступеней нет, ползунок идёт плавно.
  if (count < 2 || count > 20) return [];
  const out = [];
  for (let i = 1; i <= count; i++) out.push(Math.round((i * 100) / count));
  return out;
}

/** Скорость регулируется вообще — значит есть ползунок (и у сплошной шкалы тоже). */
export const canSetSpeed = (device) => (device.speedStep ?? 0) > 0;

export const hasSpeed = (device) => (device.presetModes || []).length > 0 || canSetSpeed(device);

/** Ближайшее допустимое значение: на ступенчатом оборудовании — ступень (0 = выключено). */
export function snapSpeed(device, percent) {
  const value = coerceIn(percent, 0, 100);
  const steps = speedSteps(device);
  if (!steps.length) return value;
  let best = 0;
  for (const s of steps) if (Math.abs(s - value) < Math.abs(best - value)) best = s;
  return best;
}

/** Подпись под названием: «Выключена», имя пресета, «50 %». */
export function speedLabel(device) {
  if (!device.isOn) return 'Выключена';
  if (device.presetMode != null) return device.presetMode;
  if (device.speed != null) return `${device.speed} %`;
  return 'Включена';
}

// ---------------------------------------------------------------- шторы

export const coverIsMoving = (c) => c.isOpening || c.isClosing;
export const coverIsOpen = (c) => (c.position ?? 0) > 0;

// ---------------------------------------------------------------- комната

/** Вентиляция — это климат, а не «прочая техника»: её ищут там же, где кондиционер. */
export const roomFans = (room) => room.toggles.filter((t) => t.kind === 'FAN');
/** Полив — свой раздел страницы двора. */
export const roomIrrigation = (room) => room.toggles.filter((t) => t.kind === 'IRRIGATION');
/** Телевизор, музыка и прочее. */
export const roomMedia = (room) => room.toggles.filter((t) => t.kind !== 'FAN' && t.kind !== 'IRRIGATION');
export const roomLightsOn = (room) => room.lights.filter((l) => l.isOn).length;
export const roomHasAnythingOn = (room) =>
  roomLightsOn(room) > 0 || room.climates.some(climateIsOn) || room.toggles.some((t) => t.isOn);
export const sensorsEmpty = (s) => s.airTemp == null && s.floorTemp == null && s.humidity == null;

/** Есть ли чем управлять. Камера — тоже «есть что»: зона из одних камер не пропадает. */
export const isControllable = (room) =>
  room.lights.length > 0 || room.climates.length > 0 || room.covers.length > 0 ||
  room.toggles.length > 0 || room.cameras.length > 0;
