// Камеры дома — как CamerasSection.kt планшета: снимки плитками, касание — живое видео.
// Владелец (фото телефона): «можешь сделать, чтобы на телефоне тоже камеру показывало».

import { roomPages } from './navigation.js';

export const CAMERAS = 'Камеры';

/** Комнаты (страницы) с камерами — по разделу на зону. */
export const cameraRooms = (rooms) => roomPages(rooms).filter((r) => r.cameras?.length);

export const hasCameras = (rooms) => rooms.some((r) => r.cameras?.length);

/** Снимок камеры. tick меняется раз в несколько секунд — браузер берёт свежий кадр, а не из кэша. */
export function snapshotUrl(camera, tick) {
  if (!camera?.picture) return null;
  return camera.picture + (camera.picture.includes('?') ? '&' : '?') + '_=' + tick;
}

/** Живая картинка камеры — поток кадров (MJPEG), открывается сразу на любом устройстве. */
export function mjpegUrl(camera) {
  if (!camera?.picture) return null;
  return camera.picture.replace('/api/camera_proxy/', '/api/camera_proxy_stream/');
}

/** Пауза между снимками одной камеры после того, как предыдущий дошёл. */
export const SNAPSHOT_EVERY_MS = 10_000;

/**
 * Каким камерам пора за новым снимком. Снимок generic-камеры — около 450 КБ, а
 * через туннель он идёт 5–7 с: раньше страница каждые 5 с бросала недогруженный
 * кадр и начинала новый (53 запроса за 12 с, догружены 3 картинки из 10).
 * Теперь на камеру — не больше одной загрузки, следующая — через паузу после
 * того, как дошла предыдущая (или упала). state: id → {busy, doneAt}.
 */
export function dueCameras(cameras, state, now, everyMs = SNAPSHOT_EVERY_MS) {
  return cameras.filter((c) => {
    if (!c.available || !c.picture) return false;
    const s = state[c.id];
    if (!s) return true;
    return !s.busy && now - (s.doneAt ?? 0) >= everyMs;
  }).map((c) => c.id);
}
