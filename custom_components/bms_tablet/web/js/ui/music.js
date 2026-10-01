// Раздел «Музыка» — как MusicSection.kt Android-планшета: по карточке на колонку
// и окно выбора радиостанции.

import { h, icon } from './dom.js';
import { press, group, actionButton, emptySection } from './components.js';
import { F, can, canPlayPause, canSource, canBrowse, isAvailable, isPlaying, nowPlaying, groupPartners } from '../model/music.js';

export const MUSIC = 'Музыка';

export function musicPage(speakers, g, ctx) {
  if (!speakers.length) return [emptySection()];
  const cards = speakers.map((s) => speakerCard(s, speakers, ctx));
  const out = [h('div.grid', { style: `--cols:${g.columns}`, 'data-key': 'speakers' }, cards)];
  if (ctx.ui.radio) out.push(radioSheet(ctx.ui.radio, speakers));
  if (ctx.ui.multiroom) out.push(multiroomSheet(ctx.ui.multiroom, speakers));
  if (ctx.ui.find) out.push(searchSheet(ctx.ui.find, speakers));
  return out;
}

const act = (type, id, extra = {}) => ({ music: { type, id, ...extra } });

function speakerCard(s, all, ctx) {
  const live = isAvailable(s) && ctx.live;
  const playing = isPlaying(s);
  const action = canPlayPause(s) ? press('bulb-btn', {
    on: playing, enabled: live, act: act('PlayPause', s.id), label: `${playing ? 'Пауза' : 'Играть'} · ${s.name}`,
  }, icon(playing ? 'ic_media_pause' : 'ic_media_play')) : null;
  const parts = [
    h('div.now', h('span.cover', s.picture ? h('img', { src: s.picture, alt: '' }) : icon('ic_music')),
      h('span.text', h('span.what', { class: playing ? 'on' : '' }, nowPlaying(s)), s.room ? h('span.room', s.room) : null)),
  ];
  if (can(s, F.PREVIOUS_TRACK) || can(s, F.NEXT_TRACK)) {
    parts.push(h('div.row2',
      can(s, F.PREVIOUS_TRACK) ? actionButton('Назад', { iconName: 'ic_media_prev', enabled: live, act: act('Previous', s.id) }) : null,
      can(s, F.NEXT_TRACK) ? actionButton('Дальше', { iconName: 'ic_media_next', enabled: live, act: act('Next', s.id) }) : null));
  }
  if (can(s, F.VOLUME_SET) && s.volume != null) parts.push(volume(s, live, ctx));
  if (s.presets > 0) {
    parts.push(h('div.choice', h('div.l', 'Пресеты')));
    parts.push(h('div.tiles', { style: '--per-row:3' }, Array.from({ length: s.presets }, (_, i) =>
      actionButton(String(i + 1), { enabled: live, act: act('Preset', s.presetEntity ?? s.id, { number: i + 1 }) }))));
  }
  // Music Assistant: поиск музыки и его медиатека.
  if (s.assistant) {
    parts.push(h('div.row2',
      actionButton('Найти музыку', { iconName: 'ic_music', enabled: live, act: { ui: 'find-open', id: s.id } }),
      canBrowse(s) ? actionButton('Медиатека', { iconName: 'ic_grid', enabled: live, act: { ui: 'library', id: s.id } }) : null));
  }
  const radio = canBrowse(s);
  if (radio || canSource(s)) {
    parts.push(h('div.row2',
      radio ? actionButton('Радио', { iconName: 'ic_radio', enabled: live, act: { ui: 'radio', id: s.id } }) : null,
      canSource(s) ? h('div.press.action.select', { class: live ? '' : 'off-line' }, icon('ic_grid'), h('span', s.source ?? 'Вход'),
        h('select', { 'aria-label': 'Вход · ' + s.name, disabled: !live, 'data-choice': JSON.stringify({ music: 'Source', id: s.id }), 'data-value': s.source ?? '' },
          (s.source ? [] : [h('option', { value: '', selected: true }, 'Вход')]).concat(s.sources.map((src) => h('option', { value: src, selected: src === s.source }, src))))) : null));
  }
  // Мультирум: с кем играет вместе и выбор комнат.
  const partners = all.filter((o) => o.id !== s.id && isAvailable(o) && can(o, F.GROUPING));
  if (can(s, F.GROUPING) && partners.length) {
    const together = groupPartners(s, all);
    if (together.length) parts.push(h('div.together', `Играет вместе с: ${together.join(', ')}`));
    parts.push(actionButton('Мультирум', { iconName: 'ic_speaker', on: together.length > 0, enabled: live, act: { ui: 'mr-open', id: s.id } }));
  }
  return group(s.name, { action, key: 'speaker:' + s.id }, ...parts);
}

/** Громкость пальцем: команда одна, на отпускании (обработчик — в app.js). */
function volume(s, live, ctx) {
  const shown = ctx.ui.drag['vol:' + s.id] ?? s.volume;
  const label = s.muted ? 'Без звука' : `Громкость ${shown} %`;
  return h('div.slider', {
    class: [shown > 0 && 'on', !live && 'disabled'].filter(Boolean).join(' '),
    'data-volume': s.id, role: 'slider', 'aria-label': 'Громкость · ' + s.name,
    'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(shown), 'aria-valuetext': label,
  }, h('i.fill', { style: `width:${shown}%` }), shown > 2 ? h('i.knob', { style: `left:${shown}%` }) : null, h('span.value', label));
}

/** Окно радио: папки медиатеки Home Assistant, станция по касанию играет на колонке. */
function radioSheet(radio, speakers) {
  const s = speakers.find((x) => x.id === radio.id);
  const folder = radio.folder;
  let body;
  if (radio.loading) body = h('div.empty', 'Загружаем…');
  else if (!folder) body = h('div.empty', 'Радио недоступно: Home Assistant не ответил');
  else if (!folder.items.length) body = h('div.empty', 'Здесь пусто');
  else {
    body = h('div.radio-list', folder.items.map((item) => press('radio-item', {
      key: 'ri:' + item.contentId, label: item.title,
      act: item.canExpand ? { ui: 'radio-open', contentId: item.contentId, contentType: item.contentType, title: item.title }
        : item.canPlay ? { ui: 'radio-play', id: radio.id, contentId: item.contentId, contentType: item.contentType } : null,
      enabled: item.canExpand || item.canPlay,
    }, icon(item.canExpand ? 'ic_grid' : 'ic_radio'), h('span.t', item.title),
    item.canExpand ? icon('premium_next', 'next') : h('span.play', 'Играть'))));
  }
  return h('div.sheet-back', { 'data-key': 'radio', 'data-act': JSON.stringify({ ui: 'radio-close' }) },
    h('section.card.sheet', { 'data-act': JSON.stringify({ ui: 'none' }) },
      h('div.card-head',
        press('btn-icon', { act: { ui: 'radio-back' }, label: 'Назад' }, icon('premium_back')),
        // Radio Browser зовёт любую папку «Radio Browser» — заголовок из касания.
        h('div.title', radio.path[radio.path.length - 1][2] ?? 'Радио', h('small', `Играть на: ${s?.name ?? ''}`)),
        actionButton('Закрыть', { iconName: 'ic_close', act: { ui: 'radio-close' } })),
      body));
}

/** Выбор комнат для мультирума: галочки, «Все», «Никого», «Готово». */
function multiroomSheet(mr, speakers) {
  const leader = speakers.find((x) => x.id === mr.id);
  const partners = speakers.filter((o) => o.id !== mr.id && isAvailable(o) && can(o, F.GROUPING));
  return h('div.sheet-back', { 'data-key': 'multiroom', 'data-act': JSON.stringify({ ui: 'mr-close' }) },
    h('section.card.sheet', { 'data-act': JSON.stringify({ ui: 'none' }) },
      h('div.card-head', h('div.title', 'Мультирум', h('small', `Играть то же, что на «${leader?.name ?? ''}», ещё в:`))),
      h('div.tiles', { style: '--per-row:2' }, partners.map((p) => {
        const on = mr.chosen.has(p.id);
        return actionButton([p.name, p.room].filter(Boolean).join(' · '), { iconName: on ? 'ic_speaker' : null, on, key: 'mr:' + p.id, act: { ui: 'mr-toggle', member: p.id } });
      })),
      h('div.row2',
        actionButton('Все', { act: { ui: 'mr-all', members: partners.map((p) => p.id) } }),
        actionButton('Никого', { act: { ui: 'mr-none' } }),
        actionButton('Готово', { iconName: 'ic_speaker', on: true, act: { ui: 'mr-done' } }))));
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
      }, icon('ic_music'), h('span.t', hit.title, hit.subtitle ? h('small', ' · ' + hit.subtitle) : null), h('span.play', 'Играть'))),
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
