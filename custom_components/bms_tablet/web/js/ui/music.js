// Раздел «Музыка» — как MusicSection.kt Android-планшета: по карточке на колонку
// и окно выбора радиостанции.

import { h, icon } from './dom.js';
import { press, group, actionButton, emptySection } from './components.js';
import { F, can, canPlayPause, canBrowse, isAvailable, isPlaying, nowPlaying, trackTitle, groupLeader, groupFollowers, joinTargets } from '../model/music.js';
import { art } from '../model/radio.js';

export const MUSIC = 'Музыка';

export function musicPage(speakers, g, ctx) {
  if (!speakers.length) return [emptySection()];
  settlePending(speakers, ctx.ui);
  const cards = speakers.map((s) => speakerCard(s, speakers, ctx));
  const out = [h('div.grid', { style: `--cols:${g.columns}`, 'data-key': 'speakers' }, cards)];
  if (ctx.ui.radio) out.push(mediaSheet(ctx.ui.radio, speakers));
  if (ctx.ui.find) out.push(searchSheet(ctx.ui.find, speakers));
  return out;
}

/** Колонка перешла в другую группу (сменилась ведущая) — «Подключаем…» больше не нужно. */
function settlePending(speakers, ui) {
  for (const [id, p] of Object.entries(ui.mrPending ?? {})) {
    const s = speakers.find((x) => x.id === id);
    if (!s || (groupLeader(s, speakers)?.id ?? null) !== p.leaderBefore) delete ui.mrPending[id];
  }
}

const act = (type, id, extra = {}) => ({ music: { type, id, ...extra } });

/**
 * Карточка колонки: обложка и что играет, громкость, радио и поиск, мультирум.
 * Ведомая колонка группы показывает то, что играет ведущая, и кнопку «отключить».
 */
function speakerCard(s, all, ctx) {
  const live = isAvailable(s) && ctx.live;
  const leader = groupLeader(s, all);
  const follower = !!leader && leader.id !== s.id;
  const shown = follower ? leader : s;
  const playing = isPlaying(shown);
  const action = canPlayPause(shown) ? press('bulb-btn', {
    on: playing, enabled: live, act: act('PlayPause', shown.id), label: `${playing ? 'Пауза' : 'Играть'} · ${s.name}`,
  }, icon(playing ? 'ic_media_pause' : 'ic_media_play')) : null;
  const together = follower ? `Вместе с «${leader.name}»`
    : leader ? 'Также в: ' + groupFollowers(s, all).map((o) => o.name).join(', ') : null;
  const parts = [nowBlock(shown, s.room, together, ctx)];
  if (!follower && (can(s, F.PREVIOUS_TRACK) || can(s, F.NEXT_TRACK))) {
    parts.push(h('div.row2',
      can(s, F.PREVIOUS_TRACK) ? actionButton('Назад', { iconName: 'ic_media_prev', enabled: live, act: act('Previous', s.id) }) : null,
      can(s, F.NEXT_TRACK) ? actionButton('Дальше', { iconName: 'ic_media_next', enabled: live, act: act('Next', s.id) }) : null));
  }
  if (can(s, F.VOLUME_SET) && s.volume != null) parts.push(volume(s, live, ctx));
  // Что включить — у ведомой нет: она играет то же, что ведущая.
  const canRadio = !follower && can(s, F.PLAY_MEDIA);
  const canFind = !follower && s.assistant;
  if (canRadio || canFind) {
    parts.push(h('div.row2',
      canRadio ? actionButton('Радио', { iconName: 'ic_radio', enabled: live, act: { ui: 'radio', id: s.id } }) : null,
      canFind ? actionButton('Поиск', { iconName: 'ic_music', enabled: live, act: { ui: 'find-open', id: s.id } }) : null,
      canFind && canBrowse(s) ? actionButton('Медиатека', { iconName: 'ic_grid', enabled: live, act: { ui: 'library', id: s.id } }) : null));
  }
  parts.push(...groupButtons(s, all, leader, live, ctx));
  return group(s.name, { action, key: 'speaker:' + s.id }, ...parts);
}

/** Обложка и что играет. Радио по адресу: имя и значок станции, включённой с планшета. */
function nowBlock(shown, room, together, ctx) {
  const station = isPlaying(shown) && !trackTitle(shown) ? ctx.ui.stations?.[shown.id] ?? null : null;
  const picture = station?.thumbnail ?? (trackTitle(shown) ? shown.picture : null);
  const playing = isPlaying(shown);
  return h('div.now',
    artTile(picture, station ? '📻' : null, station?.title ?? shown.name, { cls: 'cover', fit: !!station, placeholder: playing ? 'ic_music' : 'ic_speaker' }),
    h('span.text',
      h('span.what', { class: playing ? 'on' : '' }, station?.title ?? nowPlaying(shown)),
      station ? h('span.room', 'Интернет-радио') : null,
      together ? h('span.together', together) : null,
      room ? h('span.room', room) : null));
}

/**
 * Мультирум одним касанием: одиночная колонка — «Слушать с «1 sound»», ведомая —
 * «Отключить». Пока колонки переходят, кнопка говорит «Подключаем…» и не
 * принимает касаний: лишняя команда у LinkPlay — пересинхронизация и пропавший звук.
 */
function groupButtons(s, all, leader, live, ctx) {
  if (!can(s, F.GROUPING)) return [];
  const pending = ctx.ui.mrPending?.[s.id];
  if (leader && leader.id !== s.id) {
    return [actionButton(pending ? 'Отключаем…' : `Отключить от «${leader.name}»`, {
      iconName: 'ic_close', enabled: live && !pending, key: 'mr-leave:' + s.id, act: { ui: 'mr-leave', id: s.id, leader: leader.id },
    })];
  }
  if (leader) return [];
  return joinTargets(s, all).slice(0, 2).map((t) => actionButton(pending?.target === t.id ? 'Подключаем…' : `Слушать с «${t.name}»`, {
    iconName: 'ic_speaker', on: pending?.target === t.id, enabled: live && !pending, key: 'mr-join:' + s.id + ':' + t.id,
    act: { ui: 'mr-join', id: s.id, target: t.id },
  }));
}

const ART_COLORS = ['#3A3326', '#26332E', '#2C2E3A', '#3A2A2A', '#33302A', '#2A3338'];
const hash = (text) => [...text].reduce((n, ch) => (n * 31 + ch.codePointAt(0)) | 0, 0);

/**
 * Плитка-картинка: снимок по адресу поверх эмодзи папки или первой буквы на
 * своём цвете. Картинка не загрузилась — видно то, что под ней.
 */
function artTile(url, emoji, title, { cls = 'art', fit = false, placeholder = null } = {}) {
  const letter = [...title].find((ch) => /[\p{L}\p{N}]/u.test(ch))?.toUpperCase() ?? '♪';
  return h('span.' + cls, { class: fit ? 'fit' : '', style: `background:${ART_COLORS[Math.abs(hash(title)) % ART_COLORS.length]}` },
    emoji ? h('span.glyph', emoji) : placeholder ? icon(placeholder) : h('span.glyph.letter', letter),
    url ? h('img', { src: url, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }) : null);
}

/** Громкость пальцем: меняется сразу, пока палец едет (обработчик — music-controller.js). */
function volume(s, live, ctx) {
  const shown = ctx.ui.drag['vol:' + s.id] ?? s.volume;
  const label = s.muted ? 'Без звука' : `Громкость ${shown} %`;
  return h('div.slider', {
    class: [shown > 0 && 'on', !live && 'disabled'].filter(Boolean).join(' '),
    'data-volume': s.id, role: 'slider', 'aria-label': 'Громкость · ' + s.name,
    'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(shown), 'aria-valuetext': label,
  }, h('i.fill', { style: `width:${shown}%` }), shown > 2 ? h('i.knob', { style: `left:${shown}%` }) : null, h('span.value', label));
}

/**
 * Окно выбора: папки и станции (или медиатека Music Assistant) плитками с
 * картинками — как в самом Music Assistant. Станция по касанию сразу играет.
 */
function mediaSheet(radio, speakers) {
  const s = speakers.find((x) => x.id === radio.id);
  const folder = radio.folder;
  let body;
  if (radio.loading) body = h('div.empty', 'Загружаем…');
  else if (!folder) body = h('div.empty', 'Нет связи с каталогом — попробуйте ещё раз');
  else if (!folder.items.length) body = h('div.empty', 'Здесь пусто');
  else {
    body = h('div.art-grid', folder.items.map((item) => press('art-item', {
      key: 'ri:' + item.contentId, label: item.title,
      act: item.canExpand ? { ui: 'radio-open', contentId: item.contentId, contentType: item.contentType, title: item.title }
        : item.canPlay ? { ui: 'radio-play', id: radio.id, contentId: item.contentId, contentType: item.contentType, title: item.title, thumbnail: item.thumbnail } : null,
      enabled: item.canExpand || item.canPlay,
    }, artTile(item.thumbnail, art(item.contentId), item.title, { fit: !item.canExpand }), h('span.t', item.title))));
  }
  return h('div.sheet-back', { 'data-key': 'radio', 'data-act': JSON.stringify({ ui: 'radio-close' }) },
    h('section.card.sheet.wide', { 'data-act': JSON.stringify({ ui: 'none' }) },
      h('div.card-head',
        press('btn-icon', { act: { ui: 'radio-back' }, label: 'Назад' }, icon('premium_back')),
        h('div.title', radio.path[radio.path.length - 1][2] ?? 'Радио', h('small', `Играть на: ${s?.name ?? ''}`)),
        actionButton('Закрыть', { iconName: 'ic_close', act: { ui: 'radio-close' } })),
      body));
}

/** «Найти музыку»: поле, «Найти», находки по разделам; касание играет на колонке. */
function searchSheet(find, speakers) {
  const s = speakers.find((x) => x.id === find.id);
  let body;
  if (find.loading) body = h('div.empty', 'Ищем…');
  else if (!find.query) body = h('div.empty', 'Напишите, что включить, и нажмите «Найти»');
  else if (!find.result) body = h('div.empty', 'Music Assistant не ответил');
  else if (!find.result.some((sec) => sec.hits.length)) body = h('div.empty', 'Ничего не нашлось');
  else {
    body = h('div.radio-list', find.result.filter((sec) => sec.hits.length).flatMap((sec) => [
      h('div.together', { 'data-key': 'fs:' + sec.title }, sec.title),
      ...sec.hits.map((hit) => press('radio-item', {
        key: 'fh:' + hit.uri, label: hit.title,
        act: { ui: 'find-play', id: find.id, uri: hit.uri, mediaType: hit.mediaType },
      }, artTile(hit.image, null, hit.title, { cls: 'thumb', placeholder: 'ic_music' }), h('span.t', hit.title, hit.subtitle ? h('small', ' · ' + hit.subtitle) : null), h('span.play', 'Играть'))),
    ]));
  }
  return h('div.sheet-back', { 'data-key': 'find', 'data-act': JSON.stringify({ ui: 'find-close' }) },
    h('section.card.sheet', { 'data-act': JSON.stringify({ ui: 'none' }) },
      h('div.card-head', h('div.title', 'Найти музыку', h('small', `Играть на: ${s?.name ?? ''}`)),
        actionButton('Закрыть', { iconName: 'ic_close', act: { ui: 'find-close' } })),
      h('form.row2', { 'data-search-form': '1' },
        h('input.search', { 'data-search-field': '1', type: 'search', enterkeyhint: 'search', placeholder: 'Песня, исполнитель, альбом…', 'aria-label': 'Что найти', autocomplete: 'off' }),
        actionButton('Найти', { iconName: 'ic_music', on: true, act: { ui: 'find-run' } })),
      body));
}
