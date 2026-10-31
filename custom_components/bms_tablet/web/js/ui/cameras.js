// Раздел «Камеры» и просмотр одной камеры во весь экран.

import { h, icon } from './dom.js';
import { press, sectionTitle, grid, actionButton, emptySection } from './components.js';
import { cameraRooms } from '../model/cameras.js';

export function cameraPage(rooms, g, ctx) {
  const list = cameraRooms(rooms);
  if (!list.length) return [emptySection()];
  const out = [];
  for (const room of list) {
    // Одна зона с камерами — без подзаголовка: страница и так «Камеры».
    if (list.length > 1) out.push(sectionTitle(room.name, 'cam-title:' + room.id));
    out.push(grid(g.phone ? 1 : Math.min(g.columns, 3), room.cameras.map((c) => cameraTile(c, ctx)), 'cams:' + room.id));
  }
  if (ctx.ui.camera) out.push(cameraViewer(ctx.ui.camera, rooms));
  return out;
}

function cameraTile(camera, ctx) {
  // Только полностью загруженный кадр (его грузит app.js в фоне): недогруженный не показываем.
  const src = camera.available ? ctx.ui.camFrames?.[camera.id] ?? null : null;
  return press('cam-tile', { key: 'cam:' + camera.id, label: camera.name, enabled: camera.available,
    act: { ui: 'camera-open', id: camera.id } },
  src ? h('img', { src, alt: '' }) : icon('ic_camera', 'cam-none'),
  h('span.cam-name', h('span.t', camera.name), camera.available ? icon('premium_next', 'next') : h('small', 'Недоступна')));
}

/** Живая картинка камеры во весь экран — поток кадров. */
function cameraViewer(view, rooms) {
  const camera = rooms.flatMap((r) => r.cameras ?? []).find((c) => c.id === view.id);
  let body;
  if (view.mjpeg) body = h('img.cam-live', { 'data-key': 'mjpeg:' + view.mjpeg, src: view.mjpeg, alt: '' });
  else body = h('div.empty', 'У камеры нет картинки — проверьте её в Home Assistant');
  return h('div.sheet-back.cam-back', { 'data-key': 'camera-view', 'data-act': JSON.stringify({ ui: 'camera-close' }) },
    h('section.card.sheet.cam-sheet', { 'data-act': JSON.stringify({ ui: 'none' }) },
      h('div.card-head', h('div.title', camera?.name ?? 'Камера'), actionButton('Закрыть', { iconName: 'ic_close', act: { ui: 'camera-close' } })),
      body));
}
