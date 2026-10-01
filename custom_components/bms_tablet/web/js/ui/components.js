// Кирпичики экрана — те же, что в ui/premium/PremiumComponents.kt.
// Действия не вешаются на узлы: кнопка несёт data-act (и данные), а app.js
// ловит нажатия одним обработчиком на корне. Так morph() может свободно
// переиспользовать узлы.

import { h, icon } from './dom.js';
import { ICONS } from './icons.js';

/** Кнопка-поверхность (Pressable). act — JSON действия или имя команды интерфейса. */
export function press(cls, { act, nav, on = false, enabled = true, label, key, card = false, hold = false } = {}, ...children) {
  return h('button.press' + (cls ? '.' + cls : ''), {
    type: 'button',
    class: [on && 'on', card && 'card-shape', hold && 'hold'].filter(Boolean).join(' '),
    'data-act': act ? JSON.stringify(act) : null,
    'data-nav': nav ?? null,
    'data-hold': hold ? '1' : null,
    'aria-label': label ?? null,
    'aria-pressed': on ? 'true' : null,
    'data-key': key ?? null,
    disabled: !enabled,
  }, ...children);
}

export function sectionTitle(text, key) {
  return h('h2.section-title', { 'data-key': key ?? 't:' + text }, text);
}

export function emptySection() {
  return h('div.empty', 'В этом разделе пока нет устройств');
}

/** Сетка карточек страницы: cols колонок, full — во всю ширину. */
export function grid(cols, items, key) {
  return h('div.grid', { style: `--cols:${cols}`, 'data-key': key ?? null }, items);
}

export function fullCell(el, full) {
  if (full) el.classList.add('full');
  return el;
}

/** Карточка с заголовком и, при желании, кнопкой справа (Group). */
export function group(title, { action, key, full } = {}, ...content) {
  return h('section.card', { class: full ? 'full' : '', 'data-key': key ?? null },
    h('div.card-head', h('div.title', title), action ?? null),
    ...content);
}

export function tiles(perRow, items) {
  return h('div.tiles', { style: `--per-row:${perRow}` }, items);
}

/** Значок света с «горящим» контуром поверх (LightSymbol). */
export function lamp(name, glow) {
  const lit = LIT[name];
  return h('span.lamp', { class: glow ? 'glow' : '' }, icon(name), lit ? icon(lit, 'lit') : null);
}

const LIT = {
  premium_chandelier: 'premium_chandelier_lit',
  premium_sconce: 'premium_sconce_lit',
  premium_spots: 'premium_spots_lit',
  premium_strip: 'premium_strip_lit',
  ic_light: 'ic_light_lit',
};

/** Плитка устройства: значок, имя, «Вкл./Выкл./Недоступно» (Tile). */
export function tile({ title, iconName, on, available, act, light = false, key, live = true }) {
  const state = !available ? 'Недоступно' : on ? 'Вкл.' : 'Выкл.';
  return press('tile', {
    act, on: on && available, enabled: available && live, label: `${title}: ${state}`, key,
  },
  light ? lamp(iconName, on && available) : icon(iconName),
  h('span.name', title),
  h('span.state', state));
}

export function actionButton(title, { iconName, act, on = false, enabled = true, key, cls = '' } = {}) {
  return press('action' + (cls ? '.' + cls : ''), { act, on, enabled, key, label: title },
    iconName ? icon(iconName) : null, h('span', title));
}

/**
 * Держать секунду (HoldButton): случайное касание не гасит весь дом.
 * Заливка идёт CSS-переходом, пока на кнопке класс holding (см. app.js).
 */
export function holdButton(title, { iconName, act, enabled = true, key, label } = {}) {
  return press('action', { act, enabled, key, hold: true, label: label ?? title, card: true },
    h('i.fill'), h('span', iconName ? icon(iconName) : null, title));
}

/** «Включить все / Выключить все» раздела (BulkPair). Пустая пара — кнопка погашена. */
export function bulkPair(what, onTitle, offTitle, onIcon, offIcon, onActs, offActs, key) {
  return h('div.bulk', { 'data-key': key ?? null },
    holdButton(onTitle, { iconName: onIcon, act: onActs.length ? { batch: onActs } : null, enabled: onActs.length > 0, label: what ? `${onTitle} · ${what}` : onTitle }),
    holdButton(offTitle, { iconName: offIcon, act: offActs.length ? { batch: offActs } : null, enabled: offActs.length > 0, label: what ? `${offTitle} · ${what}` : offTitle }));
}

/** Плитка перехода в раздел (NavigationTile). */
export function navTile(title, iconName, nav, key, arrow = true) {
  return press('nav-tile', { nav, card: true, label: title, key }, icon(iconName), h('span.label', title), arrow ? icon('premium_next', 'next') : null);
}

/** Значок светильника по имени, как lightIcon() в приложении. */
export function lightIcon(name) {
  const n = name.toLowerCase();
  if (n.includes('люстр')) return 'premium_chandelier';
  if (n.includes('бра') || n.includes('ламп')) return 'premium_sconce';
  if (n.includes('подсвет') || n.includes('лайтбокс')) return 'premium_strip';
  if (n.includes('спот') || n.includes('рельс')) return 'premium_spots';
  return 'ic_light';
}

/** Значок прочей техники (equipmentIcon). */
export function equipmentIcon(device) {
  const n = device.name.toLowerCase();
  if (n.includes('мотор') || n.includes('насос')) return 'premium_motor';
  if (n.includes('гидромассаж')) return 'premium_hydromassage';
  if (n.includes('гейзер') || n.includes('фонтан')) return 'premium_geyser';
  if (device.kind === 'TV') return 'ic_tv';
  if (device.kind === 'MEDIA') return 'ic_music';
  return 'ic_power';
}

/** Значок, выбранный монтажником в интеграции, иначе — по типу. */
export function configured(id, fallback) {
  return id && Object.prototype.hasOwnProperty.call(ICONS, id) ? id : fallback;
}
