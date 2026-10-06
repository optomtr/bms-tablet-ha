// Страницы: главная (вариант «В»), зона, комната, разделы Свет/Климат/
// Отопление/Шторы. Порядок и состав — как в PremiumHouse (PremiumHome.kt).

import { h, icon } from './dom.js';
import {
  press, sectionTitle, emptySection, grid, fullCell, bulkPair, navTile, actionButton,
} from './components.js';
import { zoneGroup, floorHeatingCard, irrigationCard, equipmentCard, fanGroup, climateCard, coverCard } from './controls.js';
import { roomCard } from './photos.js';
import { musicPage, MUSIC } from './music.js';
import { zoneLabel, roomPages, pageKey, pageOf, isCurtain, buildings, buildingOf, MAIN_BUILDING, floorSplit, zoneOf, zoneTitle } from '../model/navigation.js';
import { availableModes, hasSpeed } from '../model/devices.js';
import { formatTemp, gatesLabel, plural, pageModel } from '../model/summary.js';
import { climatesOn, climatesOff, relaysSet, lightsSet, curtainsCommand } from '../model/actions.js';

const TILES_PER_CARD = 2;

/** Сетка страницы от ширины, как PageGrid: 1 / 2 / 3 / 4 колонки. */
export function pageGrid(width) {
  const columns = width < 616 ? 1 : width < 960 ? 2 : width >= 1500 ? 4 : 3;
  return {
    columns,
    phone: width < 616,
    cardWidth: (width - (columns - 1) * 16) / columns,
    spansFull: (tiles) => columns > 1 && tiles > TILES_PER_CARD * 2,
    tilesPerRow: (full) => (full ? TILES_PER_CARD * columns : TILES_PER_CARD),
    navColumnsFor(count) {
      const nav = columns * 2;
      if (count <= 0) return nav;
      const empty = (c) => (c - (count % c)) % c;
      const rows = (c) => Math.ceil(count / c);
      return [columns, nav].sort((a, b) => empty(a) - empty(b) || rows(a) - rows(b))[0];
    },
  };
}

export function renderPage(route, rooms, selected, ctx) {
  const model = pageModel(rooms, selected);
  const g = ctx.grid;
  if (!rooms.length) return [h('div.empty', 'В доме пока нет устройств. Их добавляют в Home Assistant: «BMS Планшеты».')];
  if (route === 'home') return homePage(model, { ...ctx, rooms });
  const title = ctx.title;
  if (route.startsWith('zone:') && !['Терраса', 'Двор', 'Бассейн'].includes(title)) return floorPage(selected, title, ctx);
  const outdoor = ctx.weather?.temperature ?? null;
  if (route === 'Отопление') return heatingPage(model, outdoor, g, ctx);
  if (route === 'Климат') return climatePage(model, outdoor, g, ctx);
  if (route === 'Свет') return lightPage(model, g, ctx);
  if (route === 'Шторы') return curtainPage(model, g, ctx);
  if (route === MUSIC) return musicPage(ctx.speakers ?? [], g, ctx);
  return roomPage(model, selected, g, ctx);
}

function homePage(model, ctx) {
  const s = model.summary;
  const stats = [];
  const on = s.lightsOn;
  stats.push(stat('Свет в доме', 'ic_light', on > 0 ? String(on) : 'Выкл.',
    on > 0 ? plural(on, 'лампа горит', 'лампы горят', 'ламп горят') : 'свет', 'Свет'));
  if (s.airTemp != null) stats.push(stat('Температура в доме', 'ic_thermo', formatTemp(s.airTemp) + '°', 'в доме', 'Климат'));
  if (s.gates > 0 && s.gateZone) stats.push(stat('Ворота', 'premium_gate', gatesLabel(s.gates, s.gatesOpen), 'ворота', 'zone:' + s.gateZone));
  const zoneCols = !ctx.grid.phone && ctx.grid.columns >= 3 ? 2 : 1;
  const sections = homeSections({ music: !!ctx.speakers?.length, youtube: !!ctx.youtube });
  const sectionCols = ctx.grid.phone ? ctx.grid.navColumnsFor(sections.length) : (ctx.grid.columns >= 3 ? Math.min(sections.length, 6) : (sections.length <= 4 ? sections.length : 3));
  return [
    h('div.stats', { 'data-key': 'stats' }, stats),
    // Дом в одну зону (квартира, один этаж) — комнаты сразу на главной, без строки «1 этаж».
    // Несколько зданий (дача: главный и гостевой дом) — по разделу на здание.
    ...(model.zoneList.length === 1
      ? floorPage(ctx.rooms.filter((r) => zoneOf(r) === model.zoneList[0].zone), zoneTitle(model.zoneList[0].zone), ctx)
      : houseSections(ctx.rooms, model.zoneList, zoneCols)),
    sectionTitle('Управление'),
    // Стрелка — только на широкой плитке: в портрете без неё «Отопление» не рвётся.
    grid(sectionCols, sections.map((label) => (label === YOUTUBE
      // YouTube — не страница дома: открывается приложение YouTube (на iPad — по ссылке).
      ? press('nav-tile', { act: { ui: 'youtube' }, card: true, label, key: 'nav:' + label }, icon('ic_play'), h('span.label', label), roomy(ctx.grid) ? icon('premium_next', 'next') : null)
      : navTile(label, SECTION_ICON[label], label, 'nav:' + label, roomy(ctx.grid)))), 'sections'),
  ];
}

export const YOUTUBE = 'YouTube';

/** Разделы «Управления» на главной — как homeSections() Android-планшета. */
export function homeSections({ music = false, youtube = false } = {}) {
  return ['Свет', 'Климат', 'Отопление', 'Шторы', ...(music ? [MUSIC] : []), ...(youtube ? [YOUTUBE] : [])];
}

const roomy = (g) => !g.phone && (g.cardWidth - 16) / 2 >= 190;

function houseSections(rooms, rows, cols) {
  const houses = buildings(rooms);
  return houses.flatMap((house) => [
    sectionTitle(houses.length < 2 ? 'Зоны дома' : house || MAIN_BUILDING, 'house:' + house),
    grid(cols, rows.filter((r) => buildingOf(r.zone) === house).map(zoneRow), 'zones:' + house),
  ]);
}

const SECTION_ICON = { 'Свет': 'ic_light', 'Климат': 'ic_fan', 'Отопление': 'ic_radiator', 'Шторы': 'ic_curtain', [MUSIC]: 'ic_music' };

function stat(description, iconName, big, small, nav) {
  return press('stat', { nav, label: description },
    h('span.big', icon(iconName), big), h('span.small', small));
}

function zoneIcon(zone) {
  return { 'Подвал': 'premium_stairs', 'Терраса': 'premium_terrace', 'Двор': 'premium_tree', 'Бассейн': 'premium_pool' }[zone] ?? 'premium_home';
}

function zoneRow(row) {
  const title = zoneLabel(row.zone);
  return press('zone-row', { nav: 'zone:' + row.zone, label: title, key: 'zone:' + row.zone },
    h('span.bubble', icon(zoneIcon(row.zone))),
    h('span.text', h('span.name', title), row.meta ? h('span.meta', row.meta) : null),
    row.airTemp != null ? h('span.temp', formatTemp(row.airTemp) + '°') : null,
    row.lightsOn > 0 ? h('span.lit', icon('ic_light'), `горит ${row.lightsOn}`) : h('span.dark', 'свет выкл.'),
    icon('premium_next', 'next'));
}

/** Страница этажа: карточки комнат с фото (FloorOverview). */
function floorPage(rooms, title, ctx) {
  const { featured, others } = floorSplit(roomPages(rooms), []);
  const out = [];
  if (featured.length) {
    out.push(sectionTitle('Комнаты'));
    out.push(grid(ctx.grid.phone ? 2 : ctx.grid.columns,
      featured.map((room) => roomCard(room, 'room:' + pageKey(room), pageOf(room), ctx)), 'rooms'));
  }
  // Санузлы — маленькими плитками внизу (как FloorOverview на планшете).
  const small = others.map((room) => navTile(pageOf(room), utilityIcon(pageOf(room)), 'room:' + pageKey(room), 'other:' + room.id, roomy(ctx.grid)));
  if (title === 'Подвал') small.push(navTile('Отопление', 'ic_radiator', 'Отопление', 'nav:heat', roomy(ctx.grid)));
  if (small.length) {
    out.push(sectionTitle('Прочие помещения'));
    out.push(grid(ctx.grid.navColumnsFor(small.length), small, 'others'));
  }
  return out;
}

function utilityIcon(name) {
  const n = name.toLowerCase();
  if (n.includes('лестниц')) return 'premium_stairs';
  if (n.includes('санузел') || n.includes('туалет')) return 'premium_bath';
  if (n.includes('гардероб')) return 'premium_wardrobe';
  if (n.includes('кладов')) return 'premium_storage';
  if (n.includes('постир')) return 'premium_laundry';
  return 'premium_home';
}

/** Ряд карточек как cardRows: CSS-сетка сама ровняет высоту ряда. */
function cards(list, g, key) {
  return grid(g.columns, list, key);
}

function lightCards(blocks, g, ctx) {
  return blocks.map(({ key, title, lights }) => {
    const full = g.spansFull(lights.length);
    return zoneGroup(title, lights, [], { perRow: g.tilesPerRow(full), full, key: 'l:' + key, ctx });
  });
}

function lightPage(model, g, ctx) {
  const out = [];
  if (model.allLights.length) {
    out.push(bulkPair(null, 'Включить весь свет', 'Выключить весь свет', 'ic_light', 'ic_power',
      lightsSet(model.allLights, true), lightsSet(model.allLights, false), 'bulk-light'));
  }
  const blocks = model.allLightBlocks;
  if (!blocks.length) out.push(emptySection());
  else out.push(cards(lightCards(blocks, g, ctx), g, 'light'));
  return out;
}

function climatePage(model, outdoor, g, ctx) {
  const out = [];
  if (!model.climateByKind.length && !model.floorRelaysAll.length) out.push(emptySection());
  for (const { kind, items: group } of model.climateByKind) {
    const what = { AC: 'Кондиционеры', FLOOR: 'Тёплый пол', RADIATOR: 'Радиаторы', CONVECTOR: 'Конвекторы' }[kind];
    const devices = group.map(({ device }) => device);
    const relays = kind === 'FLOOR' ? model.floorRelaysAll : [];
    out.push(sectionTitle(what, 'ct:' + kind));
    out.push(bulkPair(what, 'Включить все', 'Выключить все', KIND_ICON[kind], 'ic_power',
      [...climatesOn(devices, outdoor), ...relaysSet(relays, true)],
      [...climatesOff(devices), ...relaysSet(relays, false)], 'cb:' + kind));
    out.push(cards(group.map(({ room, device }) => climateCard(device, room.name, { ctx })), g, 'cc:' + kind));
  }
  if (!model.climateByKind.some((c) => c.kind === 'FLOOR') && model.floorRelaysAll.length) {
    out.push(sectionTitle('Тёплый пол', 'ct:relays'));
    out.push(bulkPair('Тёплый пол', 'Включить все', 'Выключить все', 'ic_floor', 'ic_power',
      relaysSet(model.floorRelaysAll, true), relaysSet(model.floorRelaysAll, false), 'cb:relays'));
  }
  out.push(...fanRows(model.allFans, g, ctx));
  return out;
}

const KIND_ICON = { AC: 'ic_fan', FLOOR: 'ic_floor', RADIATOR: 'ic_radiator', CONVECTOR: 'ic_radiator' };

function heatingPage(model, outdoor, g, ctx) {
  // Вкладка «Отопление» есть в панели Home Assistant — раздел ровно как она.
  if (ctx.heating?.length) return [heatingPanel(ctx.heating, g, ctx)];
  const out = [];
  if (model.heaters.length || model.floorRelaysAll.length) {
    out.push(bulkPair('Отопление', 'Включить отопление', 'Выключить отопление', 'ic_radiator', 'ic_power',
      [...climatesOn(model.heaters, outdoor), ...relaysSet(model.floorRelaysAll, true)],
      [...climatesOff(model.heaters), ...relaysSet(model.floorRelaysAll, false)], 'bulk-heating'));
  }
  if (!model.heating.length) out.push(emptySection());
  out.push(cards(model.heating.map(({ title: label, items: devices }) => {
    const seen = new Set();
    const rows = devices.filter(({ device: d }) => !seen.has(d.id) && seen.add(d.id)).map(({ room, device: d }) => {
      const isOn = d.mode !== 'off';
      const modes = availableModes(d);
      const heat = modes.find((m) => m === 'heat') ?? modes.find((m) => m !== 'off') ?? null;
      return h('div.heat-row', { 'data-key': d.id },
        h('div.who', room.name, d.available ? null : h('small', 'Недоступно')),
        actionButton('Вкл.', { on: isOn, enabled: d.available && ctx.live, act: heat ? { type: 'ClimateMode', id: d.id, mode: heat } : null }),
        actionButton('Выкл.', { on: !isOn, enabled: d.available && ctx.live, act: { type: 'ClimateMode', id: d.id, mode: 'off' } }));
    });
    return h('section.card', { 'data-key': 'heat:' + label }, h('div.card-head', h('div.title', label)), ...rows);
  }), g, 'heating'));
  return out;
}

/** Группы вкладки «Отопление» из HA: значок контура, «1 Детская», переключатель. */
function heatingPanel(groups, g, ctx) {
  const wanted = ctx.ui.heatWanted ?? {};
  return grid(Math.min(g.columns, 2), groups.map((group, gi) => h('section.card', { 'data-key': `hp:${gi}:${group.title}` },
    h('div.card-head', h('div.title', group.title)),
    ...group.rows.map((row, ri) => {
      if (wanted[row.entityId] === row.isOn) delete wanted[row.entityId];
      const shown = wanted[row.entityId] ?? row.isOn;
      return h('div.heat-panel-row', { 'data-key': `${ri}:${row.entityId}`, class: row.available ? '' : 'off-line' },
        icon(row.kind === 'radiator' ? 'ic_radiator' : 'ic_floor'),
        h('span.n', row.name, row.available ? null : h('small', 'Недоступно')),
        press('heat-switch', { on: shown, enabled: row.available && ctx.live, label: row.name, act: { ui: 'heat-toggle', id: row.entityId, on: !shown } }, h('i.knob')));
    }))), 'heating-panel');
}

function curtainPage(model, g, ctx) {
  const out = [];
  if (model.allCurtains.length) {
    out.push(bulkPair(null, 'Открыть все шторы', 'Закрыть все шторы', 'ic_curtain', 'ic_curtain',
      curtainsCommand(model.allCurtains, true), curtainsCommand(model.allCurtains, false), 'bulk-curtains'));
  }
  if (!model.curtainRooms.length) out.push(emptySection());
  for (const room of model.curtainRooms) {
    out.push(sectionTitle(room.name, 'cr:' + room.id));
    out.push(cards(room.covers.filter(isCurtain).map((d) => coverCard(d, { key: 'cv:' + d.id, ctx })), g, 'cg:' + room.id));
  }
  return out;
}

/** Вытяжки: со скоростью — своей карточкой, простые — плитками в «Вытяжки». */
function fanRows(fans, g, ctx) {
  if (!fans.length) return [];
  const speed = fans.filter(({ device }) => hasSpeed(device));
  const simple = fans.filter(({ device }) => !hasSpeed(device));
  const list = [];
  if (simple.length) {
    const full = simple.length > TILES_PER_CARD * 2 && g.columns > 1;
    list.push(h('section.card', { class: full ? 'full' : '', 'data-key': 'fans' },
      h('div.card-head', h('div.title', 'Вытяжки')),
      h('div.tiles', { style: `--per-row:${g.tilesPerRow(full)}` }, simple.map(({ room, device }) => fanGroup(room.name, device, { ctx })))));
  }
  for (const { room, device } of speed) list.push(fanGroup(room.name, device, { key: 'fan/' + device.id, ctx }));
  return [cards(list, g, 'fans-grid')];
}

function roomPage(model, selected, g, ctx) {
  const out = [];
  const layout = model.layout;
  const room = selected[0];
  if (layout && room) {
    if (layout.lights.length) {
      out.push(cards([zoneGroup('Освещение', layout.lights, [], { perRow: g.tilesPerRow(true), full: true, key: 'room-lights', ctx })], g, 'room-lights'));
    }
  } else if (model.lightBlocks.length) {
    if (!model.isHall) out.push(sectionTitle('Освещение', 'room-light-title'));
    out.push(cards(lightCards(model.lightBlocks, g, ctx), g, 'room-light-grid'));
  }
  const multi = selected.length > 1;
  const list = model.cards().map((card) => {
    const full = g.spansFull(card.tiles ?? 0);
    const opts = { perRow: g.tilesPerRow(full), full, key: 'pc:' + card.key, ctx };
    switch (card.type) {
      case 'cover': return coverCard(card.cover, opts);
      case 'zone': return zoneGroup(card.zone.title, card.zone.lights, card.zone.toggles, opts);
      case 'floor': return floorHeatingCard(card.relays, opts);
      case 'irrigation': return irrigationCard(card.zones, opts);
      case 'media': return equipmentCard(card.devices, opts);
      case 'climate': return climateCard(card.device, multi ? card.room.name : KIND_RU[card.device.kind], { key: 'pc:' + card.key, ctx });
      default: return null;
    }
  }).filter(Boolean).map((el) => fullCell(el, el.classList.contains('full')));
  if (list.length) out.push(cards(list, g, 'room-cards'));
  out.push(...fanRows(model.fans, g, ctx));
  if (model.sensorRooms.length) {
    out.push(sectionTitle('Датчики', 'sensors-title'));
    // Графика за сутки в веб-версии нет — показания без кнопки.
    out.push(grid(g.columns, model.sensorRooms.map((r) => h('div.press.action', { 'data-key': 'sensor:' + r.id },
      icon('ic_thermo'),
      h('span', `${r.name} · ${r.sensors.airTemp != null ? formatTemp(r.sensors.airTemp) + '°' : '—'} · ${r.sensors.humidity != null ? Math.trunc(r.sensors.humidity) + '%' : '—'}`))), 'sensors'));
  }
  if (!selected.length) out.push(emptySection());
  return out;
}

const KIND_RU = { AC: 'Кондиционер', FLOOR: 'Тёплый пол', RADIATOR: 'Радиатор', CONVECTOR: 'Конвектор' };

