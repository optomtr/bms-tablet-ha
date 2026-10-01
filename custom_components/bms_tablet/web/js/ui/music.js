// Раздел «Музыка» — как MusicSection.kt Android-планшета: по карточке на колонку
// и окно выбора радиостанции.

import { h, icon } from './dom.js';
import { press, group, actionButton, emptySection } from './components.js';
import { F, can, canPlayPause, canSource, canBrowse, isAvailable, isPlaying, nowPlaying } from '../model/music.js';

export const MUSIC = 'Музыка';

export function musicPage(speakers, g, ctx) {
  if (!speakers.length) return [emptySection()];
  const cards = speakers.map((s) => speakerCard(s, speakers, ctx));
  const out = [h('div.grid', { style: `--cols:${g.columns}`, 'data-key': 'speakers' }, cards)];
  if (ctx.ui.radio) out.push(radioSheet(ctx.ui.radio, speakers));
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
      actionButton(String(i + 1), { enabled: live, act: act('Preset', s.id, { number: i + 1 }) }))));
  }
  const radio = canBrowse(s);
  if (radio || canSource(s)) {
    parts.push(h('div.row2',
      radio ? actionButton('Радио', { iconName: 'ic_radio', enabled: live, act: { ui: 'radio', id: s.id } }) : null,
      canSource(s) ? h('div.press.action.select', { class: live ? '' : 'off-line' }, icon('ic_grid'), h('span', s.source ?? 'Вход'),
        h('select', { 'aria-label': 'Вход · ' + s.name, disabled: !live, 'data-choice': JSON.stringify({ music: 'Source', id: s.id }), 'data-value': s.source ?? '' },
          (s.source ? [] : [h('option', { value: '', selected: true }, 'Вход')]).concat(s.sources.map((src) => h('option', { value: src, selected: src === s.source }, src))))) : null));
  }
  const partners = all.filter((o) => o.id !== s.id && isAvailable(o) && can(o, F.GROUPING));
  if (can(s, F.GROUPING) && partners.length) {
    if (s.group.length > 1) parts.push(actionButton(`Вместе: ${s.group.length} · отключить`, { iconName: 'ic_speaker', on: true, enabled: live, act: act('Unjoin', s.id) }));
    else if (playing) parts.push(actionButton('Играть везде', { iconName: 'ic_speaker', enabled: live, act: act('Join', s.id, { members: partners.map((p) => p.id) }) }));
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
      act: item.canExpand ? { ui: 'radio-open', contentId: item.contentId, contentType: item.contentType }
        : item.canPlay ? { ui: 'radio-play', id: radio.id, contentId: item.contentId, contentType: item.contentType } : null,
      enabled: item.canExpand || item.canPlay,
    }, icon(item.canExpand ? 'ic_grid' : 'ic_radio'), h('span.t', item.title),
    item.canExpand ? icon('premium_next', 'next') : h('span.play', 'Играть'))));
  }
  return h('div.sheet-back', { 'data-key': 'radio', 'data-act': JSON.stringify({ ui: 'radio-close' }) },
    h('section.card.sheet', { 'data-act': JSON.stringify({ ui: 'none' }) },
      h('div.card-head',
        press('btn-icon', { act: { ui: 'radio-back' }, label: 'Назад' }, icon('premium_back')),
        h('div.title', folder?.title ?? 'Радио', h('small', `Играть на: ${s?.name ?? ''}`)),
        actionButton('Закрыть', { iconName: 'ic_close', act: { ui: 'radio-close' } })),
      body));
}
