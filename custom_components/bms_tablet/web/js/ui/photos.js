// Фото комнат и общий фон. Фото, лежащее на самом Home Assistant, отдаётся
// только с токеном — <img> заголовок не пошлёт, поэтому качаем fetch'ем и
// показываем blob:. Чужие адреса (needsAuth=false) грузятся как есть.

import { h, icon } from './dom.js';
import { press } from './components.js';

const cache = new Map(); // ключ → {url|null, loading}
let tokenSource = null;
let onLoaded = () => {};

export function setupPhotos(getToken, rerender) {
  tokenSource = getToken;
  onLoaded = rerender;
}

/** Адрес картинки для <img> или null, пока она грузится (или не загрузилась). */
export function photoUrl(background) {
  const src = background?.imageUrl;
  if (!src) return null;
  if (!background.needsAuth) return src;
  const key = `${src}#${background.version ?? 0}`;
  const hit = cache.get(key);
  if (hit) return hit.url;
  cache.set(key, { url: null });
  load(key, src);
  return null;
}

async function load(key, src) {
  try {
    const token = tokenSource ? await tokenSource() : null;
    const res = await fetch(src, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if (!res.ok) throw new Error(String(res.status));
    const blob = await res.blob();
    if (!blob.type.startsWith('image/')) throw new Error('not an image');
    cache.set(key, { url: URL.createObjectURL(blob) });
    onLoaded();
  } catch {
    // Нет фото — карточка с домиком. Повторим при следующей загрузке страницы.
    setTimeout(() => cache.delete(key), 60_000);
  }
}

/** Масштаб и сдвиг кадра — как настроил монтажник (background_transform). */
function framing(bg) {
  const zoom = bg.zoom ?? 1, dx = (bg.dx ?? 0) * 50, dy = (bg.dy ?? 0) * 50;
  return `transform:translate(${dx}%,${dy}%) scale(${zoom})`;
}

export function roomCard(room, nav, title, ctx) {
  const url = photoUrl(room.background);
  return press('room-card', { nav, card: true, label: title, key: 'rc:' + nav },
    url ? h('img', { src: url, alt: '', style: framing(room.background), draggable: 'false' }) : null,
    h('i.shade'),
    url ? null : icon('premium_home', 'placeholder'),
    h('span.foot', h('span.t', title), icon('premium_next', 'next')));
}

/** Размытый фон страницы (ConfiguredBackdrop). */
export function backdrop(bg) {
  const url = photoUrl(bg);
  if (!url) return h('div.backdrop', { 'data-key': 'backdrop' });
  const blur = Math.round((bg.blur ?? 0.35) * 18);
  return h('div.backdrop', { 'data-key': 'backdrop' },
    h('img', { src: url, alt: '', style: `${framing(bg)};filter:blur(${blur}px)` }),
    h('i.dim', { style: `opacity:${bg.dim ?? 0.24}` }));
}
