// Карточки устройств: свет подзоны, термостат, шторы и ворота, вытяжка,
// тёплый пол, полив, техника. Повторяют ThermostatControl.kt,
// CurtainControl.kt, VentilationControl.kt и ZoneGroup из PremiumHome.kt.

import { h, icon } from './dom.js';
import { press, group, group as group_, tiles, tile, lamp, actionButton, holdButton, lightIcon, equipmentIcon, configured } from './components.js';
import { availableModes, HVAC, speedSteps, hasSpeed, speedLabel } from '../model/devices.js';
import { formatTemp } from '../model/summary.js';
import { isGateCover } from '../model/navigation.js';

/** Карточка света и тумблеров одной подзоны (ZoneGroup). Лампочка в углу — весь свет карточки. */
export function zoneGroup(title, lights, toggles, { perRow, full, key, ctx }) {
  const speedFans = toggles.filter((t) => t.kind === 'FAN' && hasSpeed(t));
  const simple = toggles.filter((t) => !(t.kind === 'FAN' && hasSpeed(t)));
  let action = null;
  if (lights.length) {
    const available = lights.filter((l) => l.available);
    const anyOn = available.some((l) => l.isOn);
    action = press('bulb-btn', {
      on: anyOn, enabled: available.length > 0 && ctx.live,
      act: { type: 'LightsSet', ids: [...new Set(available.map((l) => l.id))], on: !anyOn },
      label: `Весь свет · ${title}: ${anyOn ? 'включено' : 'выключено'}`,
    }, lamp('ic_light', anyOn));
  }
  const items = [
    ...lights.map((l) => tile({
      title: l.name, iconName: configured(l.icon, lightIcon(l.name)), on: l.isOn, available: l.available,
      act: { type: 'LightSet', id: l.id, on: !l.isOn }, light: true, key: l.id, live: ctx.live,
    })),
    ...simple.map((t) => t.kind === 'FAN' ? fanTile(title, t, ctx) : tile({
      title: t.name, iconName: configured(t.icon, equipmentIcon(t)), on: t.isOn, available: t.available,
      act: { type: 'ToggleSet', id: t.id, on: !t.isOn }, key: t.id, live: ctx.live,
    })),
  ];
  return group(title, { action, key, full },
    items.length ? tiles(perRow, items) : null,
    ...speedFans.map((f) => fanCard(title, f, ctx)));
}

/** Реле тёплого пола — плитками в карточке «Тёплый пол». */
export function floorHeatingCard(relays, { perRow, full, key, ctx }) {
  return group('Тёплый пол', { key, full }, tiles(perRow, relays.map((d) => tile({
    title: d.name, iconName: configured(d.icon, 'ic_floor'), on: d.isOn, available: d.available,
    act: { type: 'ToggleSet', id: d.id, on: !d.isOn }, key: d.id, live: ctx.live,
  }))));
}

/** Полив: плитка на зону. Строки «Полито: …» в веб-версии нет — нет истории. */
export function irrigationCard(zones, { perRow, full, key, ctx }) {
  return group('Полив', { key, full }, tiles(perRow, zones.map((d) => tile({
    title: d.name, iconName: configured(d.icon, 'premium_irrigation'), on: d.isOn, available: d.available,
    act: { type: 'ToggleSet', id: d.id, on: !d.isOn }, key: d.id, live: ctx.live,
  }))));
}

export function equipmentCard(devices, { perRow, full, key, ctx }) {
  return group('Оборудование', { key, full }, tiles(perRow, devices.map((d) => tile({
    title: d.name, iconName: configured(d.icon, equipmentIcon(d)), on: d.isOn, available: d.available,
    act: { type: 'ToggleSet', id: d.id, on: !d.isOn }, key: d.id, live: ctx.live,
  }))));
}

function fanIcon(title, fan) {
  const kitchen = fan.name.toLowerCase().includes('кух') || title.toLowerCase().includes('кух');
  return configured(fan.icon, kitchen ? 'premium_hood' : 'ic_fan');
}

function fanTile(title, fan, ctx) {
  return tile({
    title: fan.name, iconName: fanIcon(title, fan), on: fan.isOn, available: fan.available,
    act: { type: 'ToggleSet', id: fan.id, on: !fan.isOn }, key: fan.id, live: ctx.live,
  });
}

/** Вытяжка: без скорости — плитка, с пресетами — кнопки, со скоростью — ползунок. */
export function fanGroup(title, fan, { key, full, ctx }) {
  if (!hasSpeed(fan)) {
    const t = fanTile(title, fan, ctx);
    if (full) t.classList.add('full');
    return t;
  }
  const el = fanCard(title, fan, ctx);
  if (key) el.setAttribute('data-key', key);
  return el;
}

function fanCard(title, fan, ctx) {
  const live = fan.available && ctx.live;
  const iconName = fanIcon(title, fan);
  const power = actionButton(fan.isOn ? 'Выкл.' : 'Вкл.', {
    iconName: 'ic_power', on: fan.isOn && fan.available, enabled: live,
    act: { type: 'ToggleSet', id: fan.id, on: !fan.isOn },
  });
  if (fan.presetModes?.length) {
    const cols = Math.min(fan.presetModes.length, 3);
    return group(fan.name, { action: power, key: 'fan/' + fan.id },
      h('div.fan-state', { class: fan.isOn ? 'on' : '' }, icon(iconName), fan.available ? speedLabel(fan) : 'Недоступно'),
      h('div.choice', h('div.l', 'Режим')),
      h('div.tiles', { style: `--per-row:${cols}` }, fan.presetModes.map((mode) => actionButton(mode, {
        on: fan.isOn && fan.presetMode === mode, enabled: live, act: { type: 'FanPreset', id: fan.id, preset: mode },
      }))));
  }
  const dragging = ctx.ui.drag[fan.id];
  const shown = dragging ?? (fan.isOn ? (fan.speed ?? 0) : 0);
  const label = !fan.available ? 'Недоступно' : shown > 0 ? `${shown} %` : 'Выключена';
  const steps = speedSteps(fan).slice(0, -1);
  return group(fan.name, { action: power, key: 'fan/' + fan.id },
    h('div.fan-state', { class: fan.isOn ? 'on' : '' }, icon(iconName), label),
    h('div.slider', {
      class: [shown > 0 && 'on', !live && 'disabled'].filter(Boolean).join(' '),
      'data-slider': fan.id, role: 'slider', 'aria-label': 'Скорость · ' + fan.name,
      'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(shown), 'aria-valuetext': label,
    },
    h('i.fill', { style: `width:${shown}%` }),
    ...steps.map((s) => h('i.tick', { style: `left:${s}%` })),
    shown > 2 ? h('i.knob', { style: `left:${shown}%` }) : null,
    h('span.value', label)));
}

/** Термостат (ClimateControl): питание, уставка ±, режим, вентилятор сплита. */
export function climateCard(device, title, { key, ctx }) {
  const live = device.available && ctx.live;
  const isOn = device.mode !== 'off';
  const modes = availableModes(device).filter((m) => m !== 'off');
  const pending = ctx.ui.pendingTarget[device.id];
  const target = pending ?? device.target;
  const remembered = ctx.ui.rememberedMode[device.id];
  const selected = isOn ? device.mode
    : modes.find((m) => m === remembered)
      ?? modes.find((m) => m === 'heat' && device.kind !== 'AC')
      ?? modes[0] ?? null;
  const accent = !device.available || !isOn ? 'var(--muted)' : device.mode === 'cool' ? 'var(--cool)' : 'var(--gold)';
  const kindTitle = KIND_TITLE[device.kind];
  const context = [...new Set([title, kindTitle])].filter((t) => t && t !== device.name);
  const kindIcon = device.kind === 'AC' ? 'ic_fan' : device.kind === 'FLOOR' ? 'ic_floor' : 'ic_radiator';
  return h('section.card.thermo', { style: `--accent:${accent}`, 'data-key': key ?? 'climate/' + device.id },
    h('div.head',
      icon(configured(device.icon, kindIcon)),
      h('div.names', h('div.n', device.name), context.length ? h('div.c', context.join(' · ')) : null),
      press('power', {
        on: device.available && isOn, enabled: live && (isOn || selected != null),
        act: selected != null || isOn ? { type: 'ClimateMode', id: device.id, mode: isOn ? 'off' : selected } : null,
        label: `${isOn ? 'Выключить' : 'Включить'} ${device.name}`,
      }, icon('ic_power'))),
    h('div.status',
      h('span.s', !device.available ? 'Недоступно' : isOn ? 'Включено' : 'Выключено'),
      h('span.p', 'Питание')),
    h('div.setpoint',
      h('div.l', 'Заданная температура'),
      h('div.row',
        press('step', { enabled: live && isOn && target > device.min, act: { ui: 'target', id: device.id, up: false }, label: `Уменьшить температуру ${device.name}` }, '−'),
        h('div.value', device.available ? `${formatTemp(target)}°` : '—'),
        press('step', { enabled: live && isOn && target < device.max, act: { ui: 'target', id: device.id, up: true }, label: `Повысить температуру ${device.name}` }, '+')),
      h('div.now', `Сейчас  ${device.available && device.current != null ? formatTemp(device.current) + '°' : '—'}`)),
    h('div.rule'),
    choice(isOn ? 'Режим' : 'Режим при включении',
      selected ? HVAC[selected].ru : 'Нет доступных режимов',
      modes.map((m) => [m, HVAC[m].ru]), selected, live,
      { ui: 'mode', id: device.id, on: isOn }),
    device.fanModes?.length
      ? choice('Вентилятор', fanLabel(device.fanMode), device.fanModes.map((m) => [m, fanLabel(m)]),
        device.fanMode, live && isOn, { type: 'ClimateFanMode', id: device.id })
      : null);
}

const KIND_TITLE = { AC: 'Кондиционер', FLOOR: 'Тёплый пол', RADIATOR: 'Радиатор', CONVECTOR: 'Конвектор' };

function fanLabel(value) {
  switch (value) {
    case 'low': return 'Низкая скорость';
    case 'mid': case 'medium': return 'Средняя скорость';
    case 'high': return 'Высокая скорость';
    case 'auto': return 'Автоматически';
    case null: case undefined: return 'Не задано';
    default: return value;
  }
}

/** Выбор из списка: на iPad — системный барабан, он удобнее любого своего меню. */
function choice(label, value, options, selected, enabled, act) {
  const many = options.length > 1;
  return h('div.choice',
    h('div.l', label),
    h('div.press.box', { class: enabled ? '' : 'off-line' },
      h('span', value), many ? h('i', '⌄') : null,
      many ? h('select', {
        'aria-label': label, disabled: !enabled, 'data-choice': JSON.stringify(act), 'data-value': selected ?? '',
      }, options.map(([k, text]) => h('option', { value: k, selected: k === selected }, text))) : null));
}

/** Шторы (CoverControl); ворота — одна кнопка-импульс, держать секунду. */
export function coverCard(device, { key, ctx }) {
  const live = device.available && ctx.live;
  if (isGateCover(device)) {
    const cooling = ctx.ui.gateCooling[device.id] > Date.now();
    const state = !device.available ? 'Недоступно'
      : (device.isOpening || device.isClosing) ? 'Движение'
        : device.position === 0 ? 'Закрыто' : device.position === 100 ? 'Открыто'
          : device.position != null ? `Открыто · ${device.position}%` : 'Положение неизвестно';
    return group(device.name, { key },
      h('div.cover-state', icon(configured(device.icon, 'premium_gate')), h('span.s', state)),
      holdButton('Открыть / Стоп / Закрыть', {
        iconName: 'premium_gate', enabled: live && !cooling,
        act: { type: 'Cover', id: device.id, command: 'toggle', gate: true },
      }));
  }
  const state = !device.available ? 'Недоступно' : device.isOpening ? 'Открывается' : device.isClosing ? 'Закрывается'
    : device.position == null ? 'Положение неизвестно' : device.position === 0 ? 'Закрыто'
      : device.position === 100 ? 'Открыто' : `Открыто · ${device.position}%`;
  return group(device.name, { key },
    h('div.cover-state', icon(configured(device.icon, 'ic_curtain')), h('span.s', state)),
    rail(device),
    h('div.cover-buttons', ['open', 'stop', 'close'].map((command) => press('', {
      enabled: live, act: { type: 'Cover', id: device.id, command },
      label: `${COMMAND_RU[command]} ${device.name}`,
    }, curtainIcon(command, device.direction)))));
}

const COMMAND_RU = { open: 'Открыть', stop: 'Стоп', close: 'Закрыть' };

const coverState = (d) => (!d.available ? 'Недоступно' : d.isOpening ? 'Открывается' : d.isClosing ? 'Закрывается'
  : d.position == null ? 'Положение неизвестно' : d.position === 0 ? 'Закрыто' : d.position === 100 ? 'Открыто' : `Открыто · ${d.position}%`);

/** Группа штор одной карточкой (CoverGroupCard): строки «1…9» с «открыть / стоп / закрыть», в шапке — вся группа. */
export function coverGroupCard(group, { key, ctx }) {
  // Прямо приборам группы: общий «закрыть все шторы» отбрасывает «Окно N».
  const all = (open) => group.rows.filter((r) => r.device.available).map((r) => ({ type: 'Cover', id: r.device.id, command: open ? 'open' : 'close' }));
  const head = h('div.cover-group-all', ['open', 'close'].map((command) => {
    const acts = all(command === 'open');
    return press('btn-icon', { enabled: ctx.live && acts.length > 0, act: acts.length ? { batch: acts } : null,
      label: `${COMMAND_RU[command]} все · ${group.title}` }, curtainIcon(command, 'center'));
  }));
  return group_(group.title, { key, action: head }, ...group.rows.map(({ label, device }) => {
    const live = device.available && ctx.live;
    return h('div.cover-row', { 'data-key': device.id, class: device.available ? '' : 'off-line' },
      h('span.n', label, h('small', coverState(device))),
      ...['open', 'stop', 'close'].map((command) => press('', { enabled: live, act: { type: 'Cover', id: device.id, command },
        label: `${COMMAND_RU[command]} ${device.name}` }, curtainIcon(command, device.direction))));
  }));
}

/** Золото — ткань: закрыто — вся планка, открыто — зазор. */
function rail(device) {
  const segments = [];
  if (device.position != null && device.available) {
    const fabric = 100 - Math.max(0, Math.min(100, device.position));
    if (device.direction === 'left_to_right') segments.push(h('i', { style: `right:0;width:${fabric}%` }));
    else if (device.direction === 'right_to_left') segments.push(h('i', { style: `left:0;width:${fabric}%` }));
    else segments.push(h('i', { style: `left:0;width:${fabric / 2}%` }), h('i', { style: `right:0;width:${fabric / 2}%` }));
  }
  return h('div.rail', { role: 'img', 'aria-label': device.position != null ? `Открыто на ${device.position} процентов` : 'Положение неизвестно' }, segments);
}

function curtainIcon(command, direction) {
  const wrap = document.createElement('span');
  const arrow = (l, r, right) => {
    const tip = right ? r : l, tail = right ? l : r, back = tip + (right ? -4 : 4);
    return `<path d="M${tail} 17H${tip}M${back} 12.6L${tip} 17L${back} 21.4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>`;
  };
  let body;
  if (command === 'stop') body = '<rect x="11.5" y="11.5" width="11" height="11" fill="currentColor"/>';
  else {
    const open = command === 'open';
    if (direction === 'left_to_right') body = arrow(6, 28, open);
    else if (direction === 'right_to_left') body = arrow(6, 28, !open);
    else body = arrow(2, 14, !open) + arrow(20, 32, open);
  }
  wrap.innerHTML = `<svg viewBox="0 0 34 34" aria-hidden="true">${body}</svg>`;
  return wrap.firstChild;
}
