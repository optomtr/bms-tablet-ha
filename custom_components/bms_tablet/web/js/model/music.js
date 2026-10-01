// Колонки дома — порт ha/MusicMapping.kt и model/Music.kt Android-планшета.
// Какие плееры — колонки, что они умеют, какие службы Home Assistant зовём.

import { toggleKindOf } from './house.js';

// MediaPlayerEntityFeature из Home Assistant.
export const F = {
  PAUSE: 1, VOLUME_SET: 4, VOLUME_MUTE: 8, PREVIOUS_TRACK: 16, NEXT_TRACK: 32, PLAY_MEDIA: 512,
  SELECT_SOURCE: 2048, STOP: 4096, PLAY: 16384, BROWSE_MEDIA: 131072, GROUPING: 524288,
};

/** ИК-пульты BMS заводят телевизор как media_player — это не колонка. */
const NOT_SPEAKERS = new Set(['bms_smart_ir']);
/** DLNA-рендерер — тот же усилитель второй раз, только беднее. */
const DLNA = 'dlna_dmr';
/** Пресеты на колонке: у LinkPlay в приложении обычно заняты первые шесть. */
const PRESETS = { linkplay: 6 };

const collator = new Intl.Collator('ru');

/**
 * Колонки из состояний и реестров. registry: {entities: Map id → {platform, areaId, deviceId},
 * deviceAreas: Map deviceId → areaId, areaNames: Map areaId → name}; без реестра — без комнат
 * и без отсева DLNA-двойников.
 */
export function buildSpeakers(states, registry = null) {
  const inputs = [];
  for (const [id, st] of states) {
    if (!id.startsWith('media_player.')) continue;
    const reg = registry?.entities.get(id);
    if (registry && !reg) continue; // скрытые и отключённые в реестре не попадают
    const areaId = reg?.areaId ?? (reg?.deviceId ? registry.deviceAreas.get(reg.deviceId) : null);
    inputs.push({ id, platform: reg?.platform ?? null, room: areaId ? registry.areaNames.get(areaId) ?? null : null, st });
  }
  const candidates = inputs.filter(({ platform, st }) => !NOT_SPEAKERS.has(platform)
    && st.attributes?.device_class !== 'tv'
    && toggleKindOf('media_player', nameOf(st), null) !== 'TV');
  // Music Assistant стоит — колонки это его плееры (очередь, поиск, медиатека);
  // пресеты остаются у LinkPlay-двойника с тем же именем.
  const assistant = candidates.filter((c) => c.platform === ASSISTANT);
  if (assistant.length) {
    const twins = new Map(candidates.filter((c) => c.platform !== ASSISTANT && PRESETS[c.platform])
      .map((c) => [norm(nameOf(c.st)), c]));
    return assistant.map((c) => {
      const twin = twins.get(norm(nameOf(c.st)));
      return { ...speakerFrom(c), assistant: true, presets: twin ? PRESETS[twin.platform] : 0, presetEntity: twin?.id ?? null, room: c.room ?? twin?.room ?? null };
    }).sort(order);
  }
  const rich = candidates.some((c) => c.platform && c.platform !== DLNA);
  return candidates.filter((c) => !rich || c.platform !== DLNA).map(speakerFrom).sort(order);
}

const order = (a, b) => (isAvailable(a) === isAvailable(b) ? 0 : isAvailable(a) ? -1 : 1)
  || collator.compare(a.room ?? '\uFFFF', b.room ?? '\uFFFF')
  || collator.compare(a.name, b.name);
const norm = (name) => name.toLowerCase().replaceAll('ё', 'е').trim();
/** Плееры Music Assistant в Home Assistant. */
export const ASSISTANT = 'music_assistant';

const nameOf = (st) => st.attributes?.friendly_name || st.entity_id.split('.')[1];

function speakerFrom({ id, platform, room, st }) {
  const a = st.attributes ?? {};
  const str = (v) => (typeof v === 'string' && v.trim() ? v : null);
  return {
    id, name: nameOf(st), room, state: String(st.state ?? '').toLowerCase(),
    title: str(a.media_title), artist: str(a.media_artist) ?? str(a.media_album_artist),
    picture: str(a.entity_picture),
    volume: typeof a.volume_level === 'number' ? Math.max(0, Math.min(100, Math.round(a.volume_level * 100))) : null,
    muted: a.is_volume_muted === true, source: str(a.source),
    sources: Array.isArray(a.source_list) ? a.source_list.filter(str) : [],
    group: Array.isArray(a.group_members) ? a.group_members : [],
    features: Number(a.supported_features) || 0,
    presets: PRESETS[platform] ?? 0,
    presetEntity: PRESETS[platform] ? id : null,
    assistant: false,
  };
}

export const isAvailable = (s) => s.state !== 'unavailable' && s.state !== 'unknown';
export const isPlaying = (s) => s.state === 'playing' || s.state === 'buffering';
export const can = (s, f) => (s.features & f) !== 0;
export const canPlayPause = (s) => can(s, F.PAUSE) || can(s, F.PLAY);
export const canSource = (s) => can(s, F.SELECT_SOURCE) && s.sources.length > 1;
export const canBrowse = (s) => can(s, F.BROWSE_MEDIA) && can(s, F.PLAY_MEDIA);

/** Название трека для людей: радио по адресу LinkPlay называет самим адресом — такое не показываем. */
export const trackTitle = (s) => (s.title && !s.title.includes('://') ? s.title.trim() : null);
/** Исполнитель; «Unknown» от колонки — это «не знаю», не имя. */
export const trackArtist = (s) => (s.artist && s.artist.trim().toLowerCase() !== 'unknown' ? s.artist.trim() : null);

/** Что написать под названием колонки. */
export function nowPlaying(s) {
  if (!isAvailable(s)) return 'Недоступна';
  if (trackTitle(s)) return [trackTitle(s), trackArtist(s)].filter(Boolean).join(' · ');
  if (isPlaying(s)) return s.title ? 'Интернет-радио' : 'Играет';
  if (s.state === 'paused') return 'Пауза';
  if (s.state === 'off') return 'Выключена';
  return 'Ничего не играет';
}

/** Действие музыки → вызов службы: {domain, service, service_data, target}. */
export function musicCall(action) {
  const target = { entity_id: action.id };
  switch (action.type) {
    case 'PlayPause': return { domain: 'media_player', service: 'media_play_pause', service_data: {}, target };
    case 'Next': return { domain: 'media_player', service: 'media_next_track', service_data: {}, target };
    case 'Previous': return { domain: 'media_player', service: 'media_previous_track', service_data: {}, target };
    case 'Volume': return { domain: 'media_player', service: 'volume_set', service_data: { volume_level: Math.max(0, Math.min(100, action.percent)) / 100 }, target };
    case 'Source': return { domain: 'media_player', service: 'select_source', service_data: { source: action.source }, target };
    case 'Preset': return { domain: 'linkplay', service: 'play_preset', service_data: { preset_number: action.number }, target };
    case 'Play': return { domain: 'media_player', service: 'play_media', service_data: { media_content_id: action.contentId, media_content_type: action.contentType }, target };
    case 'Join': return { domain: 'media_player', service: 'join', service_data: { group_members: action.members.filter((m) => m !== action.id) }, target };
    case 'Unjoin': return { domain: 'media_player', service: 'unjoin', service_data: {}, target };
    case 'PlayAssistant': return { domain: 'music_assistant', service: 'play_media', service_data: { media_id: action.uri, media_type: action.mediaType, enqueue: 'play' }, target };
    default: throw new Error('unknown music action ' + action.type);
  }
}

/** Ответ media_player/browse_media → {title, items}. */
export function parseMediaFolder(result) {
  if (!result) return null;
  const items = (result.children ?? []).filter((c) => c?.media_content_id).map((c) => ({
    title: c.title || c.media_content_id, contentId: c.media_content_id,
    contentType: c.media_content_type || 'music', canPlay: c.can_play === true, canExpand: c.can_expand === true,
    thumbnail: typeof c.thumbnail === 'string' && c.thumbnail ? c.thumbnail : null,
  }));
  return { title: result.title || 'Медиатека', items };
}

/** Ведущая группы, где играет колонка (первая в group_members); null — играет одна. */
export function groupLeader(speaker, all) {
  const group = speaker.group.length > 1 ? speaker.group
    : all.find((o) => o.id !== speaker.id && o.group.length > 1 && o.group.includes(speaker.id))?.group;
  return group ? all.find((o) => o.id === group[0]) ?? null : null;
}

/** Кто играет вместе с ведущей (без неё самой). */
export const groupFollowers = (leader, all) => all.filter((o) => o.id !== leader.id && leader.group.includes(o.id));

/**
 * К кому одиночную колонку можно подключить одним касанием: где играет музыка —
 * одиночки и ведущие. По одной колонке: каждый join у LinkPlay заново
 * синхронизирует группу, и звук на миг пропадает во всех комнатах.
 */
export function joinTargets(speaker, all) {
  if (!can(speaker, F.GROUPING) || groupLeader(speaker, all)) return [];
  return all.filter((o) => o.id !== speaker.id && isAvailable(o) && can(o, F.GROUPING) && isPlaying(o)
    && (groupLeader(o, all)?.id ?? o.id) === o.id);
}

const SEARCH_SECTIONS = [['tracks', 'Песни'], ['albums', 'Альбомы'], ['playlists', 'Плейлисты'], ['artists', 'Исполнители'], ['radio', 'Радио']];

/** Ответ music_assistant.search → [{title, hits:[{title, subtitle, uri, mediaType}]}]. */
export function parseAssistantSearch(response) {
  if (!response) return [];
  return SEARCH_SECTIONS.map(([key, title]) => ({
    title,
    hits: (response[key] ?? []).filter((o) => o?.uri).map((o) => ({
      title: o.name || o.uri,
      subtitle: (o.artists ?? []).map((a) => a?.name).filter(Boolean).join(', ') || null,
      uri: o.uri,
      mediaType: o.media_type || key.replace(/s$/, ''),
      image: typeof o.image === 'string' && o.image ? o.image : null,
    })),
  }));
}
