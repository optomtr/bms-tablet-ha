// Раздел «Отопление» ровно как вкладка «Отопление» в панели Home Assistant —
// порт ha/HeatingPanel.kt Android-планшета: те же группы, номера, подписи, порядок.

const norm = (s) => String(s ?? '').trim().toLowerCase().replaceAll('ё', 'е');
const list = (v) => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object') : []);

/** Вкладка «Отопление» из конфигураций панелей (по порядку); null — такой нет. */
export function findView(configs) {
  for (const c of configs) {
    const view = list(c?.views).find((v) => norm(v.title) === 'отопление');
    if (view) return view;
  }
  return null;
}

function rowKind(icon, title) {
  if (icon.includes('radiator')) return 'radiator';
  if (icon.includes('coil') || icon.includes('floor')) return 'floor';
  return norm(title).includes('радиат') ? 'radiator' : 'floor';
}

/** Группы вкладки: заголовок (heading) и списки под ним; стопки и сетки раскрываются. */
export function parseView(view) {
  const groups = [];
  let heading = null;
  const visit = (card) => {
    if (card.type === 'heading') heading = String(card.heading ?? '').trim() || null;
    else if (Array.isArray(card.entities)) {
      const title = String(card.title ?? '').trim() || heading || 'Отопление';
      const rows = [];
      for (const item of card.entities) {
        const [id, name, icon] = typeof item === 'string' ? [item, '', ''] : item && typeof item === 'object' ? [String(item.entity ?? ''), String(item.name ?? ''), String(item.icon ?? '')] : ['', '', ''];
        if (!id.includes('.')) continue; // разделители, подписи
        rows.push({ entityId: id, name, kind: rowKind(icon, title) });
      }
      if (rows.length) {
        const radiators = rows.filter((r) => r.kind === 'radiator').length;
        groups.push({ title, kind: norm(title).includes('радиат') || radiators * 2 > rows.length ? 'radiator' : 'floor', rows });
      }
    } else list(card.cards).forEach(visit);
  };
  list(view.cards).forEach(visit);
  for (const section of list(view.sections)) { heading = null; list(section.cards).forEach(visit); }
  return groups;
}

/** Состояния реле → строки с «вкл./выкл.»; имя без подписи в HA — имя сущности. */
export function resolve(groups, states) {
  return groups.map((g) => ({
    ...g,
    rows: g.rows.map((r) => {
      const st = states.get(r.entityId);
      const value = st?.state ?? 'unavailable';
      return {
        ...r,
        name: r.name || st?.attributes?.friendly_name || r.entityId.split('.')[1],
        isOn: value === 'on' || (r.entityId.startsWith('climate.') && !['off', 'unavailable', 'unknown'].includes(value)),
        available: value !== 'unavailable' && value !== 'unknown',
      };
    }),
  }));
}

/** Ищет вкладку: сначала главная панель, потом остальные по списку. */
export async function loadHeatingView(send) {
  const configs = [];
  const config = async (urlPath) => {
    try { return await send(urlPath ? { type: 'lovelace/config', url_path: urlPath } : { type: 'lovelace/config' }); } catch { return null; }
  };
  const main = await config(null);
  if (main) configs.push(main);
  let dashboards = [];
  try { dashboards = await send({ type: 'lovelace/dashboards/list' }); } catch { dashboards = []; }
  for (const d of Array.isArray(dashboards) ? dashboards : []) {
    if (findView(configs)) break;
    if (!d?.url_path) continue;
    const c = await config(d.url_path);
    if (c) configs.push(c);
  }
  const view = findView(configs);
  return view ? parseView(view) : [];
}
