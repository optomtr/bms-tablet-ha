// Интернет-радио напрямую из каталога Radio Browser — порт ha/RadioBrowser.kt.
// Через Home Assistant папка «Jazz» открывалась 19–25 секунд (он качает все
// 1124 станции жанра); здесь — 60 самых популярных, доли секунды.

const HOSTS = ['https://de1.api.radio-browser.info', 'https://fi1.api.radio-browser.info', 'https://de2.api.radio-browser.info'];
const LIMIT = 60;
export const PREFIX = 'rb:';

/** Жанры: подпись по-русски, тег каталога, картинка плитки. */
export const GENRES = [
  ['Поп', 'pop', '🎤'], ['Рок', 'rock', '🎸'], ['Джаз', 'jazz', '🎷'],
  ['Классика', 'classical', '🎻'], ['Электроника', 'electronic', '🎛️'], ['Хип-хоп', 'hip hop', '🎧'],
  ['Танцевальная', 'dance', '💃'], ['Лаунж', 'lounge', '🍸'], ['Чилаут', 'chillout', '🌙'],
  ['Релакс', 'relax', '🌿'], ['Ретро', 'oldies', '📻'], ['Восточная', 'oriental', '🪕'],
  ['Коран', 'quran', '🕌'], ['Новости', 'news', '📰'],
];

const ART = new Map([['country:UZ', '🇺🇿'], ['country:RU', '🇷🇺'], ['top', '🌍'], ['genres', '🎼'],
  ...GENRES.map(([, tag, emoji]) => ['tag:' + tag, emoji])]);

/** Картинка плитки папки радио; null — не наша папка. */
export const art = (contentId) => (contentId?.startsWith(PREFIX) ? ART.get(contentId.slice(PREFIX.length)) ?? null : null);

const folder = (title, id) => ({ title, contentId: PREFIX + id, contentType: 'folder', canPlay: false, canExpand: true, thumbnail: null });

/** Корень радио: свои папки, без сети. */
export const root = () => ({ title: 'Радио', items: [
  folder('Узбекистан', 'country:UZ'), folder('Россия', 'country:RU'), folder('Популярное в мире', 'top'), folder('Жанры', 'genres'),
] });

/** Адрес запроса к каталогу для папки (без хоста); null — папка без сети или чужая. */
export function pathFor(contentId) {
  if (!contentId?.startsWith(PREFIX)) return null;
  const id = contentId.slice(PREFIX.length);
  const enc = (v) => encodeURIComponent(v);
  const common = `order=votes&reverse=true&hidebroken=true&limit=${LIMIT}`;
  if (id === 'top') return `/json/stations/topvote/${LIMIT}?hidebroken=true`;
  if (id.startsWith('country:')) return `/json/stations/search?countrycode=${enc(id.slice(8))}&${common}`;
  if (id.startsWith('tag:')) return `/json/stations/search?tag=${enc(id.slice(4))}&tagExact=false&${common}`;
  return null;
}

/** Ответ каталога → станции; одинаковые потоки — один раз; значок только по https. */
export function parseStations(title, list) {
  const seen = new Set();
  const items = [];
  for (const o of Array.isArray(list) ? list : []) {
    const url = String(o?.url_resolved || o?.url || '').trim();
    const name = String(o?.name ?? '').trim();
    if (!url.startsWith('http') || !name || seen.has(url)) continue;
    seen.add(url);
    const icon = String(o.favicon ?? '');
    items.push({ title: name, contentId: url, contentType: 'music', canPlay: true, canExpand: false, thumbnail: icon.startsWith('https://') ? icon : null });
  }
  return { title, items };
}

const cache = new Map();

/** Папка радио: корень, жанры или станции. null — каталог не ответил. */
export async function browse(contentId, title, fetcher = fetch) {
  if (!contentId || contentId === PREFIX + 'root') return root();
  if (contentId === PREFIX + 'genres') return { title: 'Жанры', items: GENRES.map(([ru, tag]) => folder(ru, 'tag:' + tag)) };
  const path = pathFor(contentId);
  if (!path) return null;
  if (cache.has(path)) return { ...cache.get(path), title };
  for (const host of HOSTS) {
    try {
      const r = await fetcher(host + path, { signal: AbortSignal.timeout?.(8000) });
      if (!r.ok) continue;
      const result = parseStations(title, await r.json());
      cache.set(path, result);
      return result;
    } catch { /* следующее зеркало */ }
  }
  return null;
}
