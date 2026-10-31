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

/** Поток кадров (MJPEG) — запасной путь, где браузер не играет HLS (Chrome на компьютере). */
export function mjpegUrl(camera) {
  if (!camera?.picture) return null;
  return camera.picture.replace('/api/camera_proxy/', '/api/camera_proxy_stream/');
}

/** Играет ли браузер HLS сам (Safari на iPhone/iPad — да). */
export function canPlayHls(video) {
  return !!video && typeof video.canPlayType === 'function' && video.canPlayType('application/vnd.apple.mpegurl') !== '';
}
