/**
 * Редактор планшета BMS в боковой панели Home Assistant.
 *
 * Комнаты и устройства заполняются автоматически из зон HA, монтажник снимает
 * галочки с лишнего и при необходимости добавляет недостающее руками. Ничего
 * не чертим и не расставляем по координатам.
 *
 * Конфигурация одна на дом. Списка планшетов здесь нет намеренно: планшет в
 * квартире обычно один, а если их два — комнаты у них всё равно те же самые,
 * и выбирать, какую из одинаковых конфигураций правишь, было незачем.
 *
 * Обычный Web Component без сборки: файл кладётся как есть и работает.
 */

const ROLE_LABELS = {
  light: "Свет",
  ac: "Кондиционер",
  floor: "Тёплый пол",
  radiator: "Радиатор",
  convector: "Конвектор",
  cover: "Шторы",
  tv: "Телевизор",
  media: "Музыка",
  fan: "Вентиляция",
  irrigation: "Полив",
  camera: "Камера",
  other: "Прочее",
  sensor_air_temp: "Датчик · воздух",
  sensor_floor_temp: "Датчик · пол",
  sensor_humidity: "Датчик · влажность",
  hidden: "Не показывать",
};

// Датчики в списке есть намеренно: устройства расставляются автоматически, а
// вот датчик температуры на объекте сплошь и рядом приходит из Modbus или из
// шаблона без device_class — и определить его может только человек.
const ROLE_CHOICES = [
  "auto", "light", "ac", "floor", "radiator", "convector",
  "cover", "tv", "media", "fan", "irrigation", "camera",
  "sensor_air_temp", "sensor_floor_temp", "sensor_humidity",
  "other", "hidden",
];

/** Во что роли складываются в сводке комнаты. */
const ROLE_GROUPS = [
  ["Свет", ["light"], "#f3a83c"],
  ["Климат", ["ac", "floor", "radiator", "convector"], "#5bb8e8"],
  ["Шторы", ["cover"], "#8f9bff"],
  ["Полив", ["irrigation"], "#3fb9c9"],
  ["Камеры", ["camera"], "#c98f5b"],
  ["Техника", ["tv", "media", "fan", "other"], "#37c58e"],
  ["Датчики", ["sensor_air_temp", "sensor_floor_temp", "sensor_humidity"], "#9aa2ae"],
];

/** Состояния, которые видно в строке устройства. Кондиционер отвечает «cool». */
const STATE_LABELS = {
  on: "вкл",
  off: "выкл",
  unavailable: "недоступно",
  unknown: "неизвестно",
  cool: "охлаждение",
  heat: "отопление",
  heat_cool: "авто",
  auto: "авто",
  dry: "осушение",
  fan_only: "обдув",
  open: "открыто",
  closed: "закрыто",
  opening: "открывается",
  closing: "закрывается",
  playing: "играет",
  paused: "пауза",
  idle: "ожидание",
  standby: "ожидание",
  home: "дома",
  not_home: "нет дома",
};

/**
 * Поля домофона: ключ, подпись, из каких доменов выбирать, пояснение.
 *
 * Сами сущности приходят от отдельной интеграции («BMS Intercom»), поэтому
 * здесь только ссылки — никаких предположений о том, как они называются.
 * Домены обязаны совпадать с DOORSTATION_ENTITY_KEYS в const.py.
 */
const DOORSTATION_FIELDS = [
  ["camera", "Камера панели", ["camera"], "Видео с вызывной панели."],
  ["call", "Датчик вызова", ["binary_sensor"], "У него атрибут call_state: idle, ringing, answered."],
  ["answer", "Кнопка «Ответить»", ["button", "switch", "script"], ""],
  ["reject", "Кнопка «Сбросить»", ["button", "switch", "script"], ""],
  ["door", "Кнопка «Открыть дверь»", ["button", "switch", "script"], "На планшете нажимается с удержанием в одну секунду."],
];

const AMBIENT_MODES = [
  ["never", "Не гаснет"],
  ["timeout", "Через время"],
  ["motion", "По датчику движения"],
];

const STYLE = `
  :host { display: block; height: 100%; background: var(--primary-background-color); }
  .wrap { display: flex; flex-direction: column; height: 100%;
          font-family: var(--paper-font-body1_-_font-family, Roboto, sans-serif);
          color: var(--primary-text-color); }

  header { display: flex; align-items: baseline; gap: 10px; padding: 18px 28px 14px; }
  header h1 { font-size: 22px; font-weight: 500; margin: 0; }
  header .ver { font-size: 12px; opacity: .5; }
  header .eid { font-size: 12px; opacity: .5; font-family: ui-monospace, monospace; }
  header .grow { flex: 1; }
  .err { color: var(--error-color); font-size: 13px; }

  .strip { display: flex; gap: 10px; padding: 0 28px 16px; flex-wrap: wrap; }
  .stat { border: 1px solid var(--divider-color); border-radius: 14px; padding: 10px 16px;
          background: var(--card-background-color); min-width: 108px; }
  .stat b { display: block; font-size: 20px; font-weight: 600; line-height: 1.2; }
  .stat span { font-size: 12px; opacity: .6; }
  .stat.warn b { color: var(--warning-color, #f3a83c); }

  .tabs { display: flex; gap: 8px; padding: 0 28px; border-bottom: 1px solid var(--divider-color); }
  .tab { padding: 10px 4px; margin-bottom: -1px; border-bottom: 2px solid transparent;
         cursor: pointer; font-size: 14px; opacity: .7; }
  .tab.on { border-bottom-color: var(--primary-color); opacity: 1; font-weight: 500; }
  .tab + .tab { margin-left: 18px; }

  .main { flex: 1; overflow: auto; padding: 20px 28px 80px; }

  button { font: inherit; cursor: pointer; border-radius: 10px; border: 1px solid var(--divider-color);
           background: var(--card-background-color); color: var(--primary-text-color); padding: 9px 16px; }
  button:hover { border-color: var(--primary-color); }
  button.primary { background: var(--primary-color); color: var(--text-primary-color, #fff); border-color: transparent; }
  button.danger { color: var(--error-color); }
  button.icon { padding: 4px 9px; border-radius: 8px; line-height: 1.4; }

  .toolbar { display: flex; gap: 10px; align-items: center; margin-bottom: 16px; flex-wrap: wrap; }
  .search { flex: 1; min-width: 220px; }

  input[type=text], input[type=search], input[type=number], select {
    font: inherit; padding: 9px 12px; border-radius: 10px; width: 100%; box-sizing: border-box;
    border: 1px solid var(--divider-color); background: var(--card-background-color);
    color: var(--primary-text-color); }
  select { width: auto; }
  input[type=range] { width: 210px; vertical-align: middle; accent-color: var(--primary-color); }

  .card { border: 1px solid var(--divider-color); border-radius: 16px; margin-bottom: 12px;
          overflow: hidden; background: var(--card-background-color); }
  .card > .head { display: flex; align-items: center; gap: 12px; padding: 12px 16px; cursor: pointer; }
  .card > .head .thumb { width: 44px; height: 34px; border-radius: 8px; flex: none;
          background: var(--secondary-background-color) center/cover no-repeat; }
  .card > .head .name { font-size: 16px; font-weight: 500; }
  .card > .head .chips { display: flex; gap: 6px; flex-wrap: wrap; flex: 1; }
  .card.off .name { opacity: .45; text-decoration: line-through; }
  .card.off .chips { opacity: .35; }

  .chip { font-size: 12px; padding: 3px 9px; border-radius: 999px; white-space: nowrap;
          border: 1px solid currentColor; opacity: .9; }
  .chip.muted { color: var(--secondary-text-color); opacity: .7; }
  .chip.warn { color: var(--warning-color, #f3a83c); }

  .rows { border-top: 1px solid var(--divider-color); padding: 4px 16px 14px; }
  .row { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; padding: 9px 0;
         border-bottom: 1px solid var(--divider-color); }
  .row:last-child { border-bottom: none; }
  .row .nm { flex: 1; min-width: 200px; }
  .row .nm b { font-weight: 500; display: block; }
  .row .nm small { opacity: .55; font-size: 12px; display: block;
                   overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .row.excluded .nm, .row.excluded select { opacity: .4; }
  .row .nm .zone { display: flex; align-items: center; gap: 8px; font-size: 12px; opacity: .8; margin-top: 4px; }
  .row .nm .zone input { width: 180px; }
  .state { font-size: 12px; opacity: .75; min-width: 62px; text-align: right; font-variant-numeric: tabular-nums; }
  .manual { font-size: 11px; padding: 1px 7px; border-radius: 6px; background: var(--primary-color);
            color: var(--text-primary-color,#fff); font-weight: 400; }

  .add { display: flex; gap: 10px; align-items: center; padding-top: 12px; }
  .add select { flex: 1; }

  .field { display: flex; align-items: center; gap: 14px; margin-bottom: 14px; }
  .field label { width: 220px; flex: none; opacity: .8; font-size: 14px; }
  .field .val { flex: 1; }
  .hint { opacity: .62; font-size: 13px; line-height: 1.55; margin: 6px 0 18px; max-width: 720px; }
  .empty { text-align: center; padding: 70px 20px; opacity: .8; }
  h3 { font-weight: 500; margin: 28px 0 14px; font-size: 15px; letter-spacing: .3px;
       text-transform: uppercase; opacity: .6; }

  .bg { display: flex; gap: 20px; align-items: flex-start; padding: 16px; }
  .bg .frame { width: 232px; height: 145px; border-radius: 12px; flex: none; overflow: hidden;
               position: relative; background: var(--secondary-background-color);
               border: 1px solid var(--divider-color); }
  .bg .frame .img { position: absolute; inset: 0; background: center/cover no-repeat; }
  .bg .frame .veil { position: absolute; inset: 0; background: #0e1014; }
  .bg .frame .none { position: absolute; inset: 0; display: flex; align-items: center;
                     justify-content: center; font-size: 13px; opacity: .5; }
  .bg .ctrls { flex: 1; min-width: 0; }
  .bg .ctrls .title { font-size: 16px; font-weight: 500; margin-bottom: 12px; }
`;

class BmsTabletEditor extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._tab = "rooms";
    this._open = new Set();
    this._error = "";
    this._booted = false;
    this._bound = false;
    this._version = "";
    this._entityId = "";
    this._search = "";
    this._focus = null;
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._booted) {
      this._booted = true;
      this._reload();
    }
  }

  disconnectedCallback() { for(const url of (this._previewCache || new Map()).values()) URL.revokeObjectURL(url); this._previewCache=new Map(); }

  set narrow(_) {}
  set route(_) {}
  set panel(_) {}

  // ------------------------------------------------------------- данные

  _ws(type, extra) {
    return this._hass.connection.sendMessagePromise(
      Object.assign({ type: `bms_tablet/${type}` }, extra || {}),
    );
  }

  async _reload() {
    const revision=this._reloadRevision=(this._reloadRevision || 0)+1;
    try {
      const [config, areas] = await Promise.all([
        this._ws("config"),
        this._ws("areas"),
      ]);
      const previous=this._previewCache || new Map();
      const next=new Map();
      const pending=Object.values(config.backgrounds || {}).filter(bg=>bg?.url);
      await Promise.all(Array.from({length:Math.min(4,pending.length)},async()=>{
        while(pending.length) {
          const bg=pending.shift();
          try {
            const url=new URL(bg.url,location.href);
            if(url.origin!==location.origin || !url.pathname.startsWith("/api/bms_tablet/image/")) continue;
            const key=url.href+"#"+(bg.version || 0);
            let preview=previous.get(key);
            if(!preview) {
              // fetchWithAuth сам обновляет токен: сохранённый access_token живёт 30 минут.
              const response=await this._hass.fetchWithAuth(url.pathname+url.search,{signal:AbortSignal.timeout(10000)});
              if(response.ok) preview=URL.createObjectURL(await response.blob());
            }
            if(preview) { bg.preview_url=preview; next.set(key,preview); }
          } catch (_) { /* Keep controls usable when a photo is unavailable. */ }
        }
      }));
      if(revision!==this._reloadRevision) {
        for(const url of next.values()) if(!Array.from(previous.values()).includes(url)) URL.revokeObjectURL(url);
        return;
      }
      this._previewCache=next;
      for(const [key,url] of previous) if(!next.has(key)) URL.revokeObjectURL(url);
      this._config = config;
      this._version = config.version || "";
      this._entityId = config.entity_id || "";
      this._areas = areas.areas || [];
      this._catalog = areas.catalog || [];
      this._sortAreas();
      this._error = "";
    } catch (err) {
      this._error = (err && err.message) || "Не удалось загрузить настройки";
    }
    this._render();
  }

  /** Сервер отдаёт комнаты по алфавиту — показываем в том порядке, что задал монтажник. */
  _sortAreas() {
    const rooms = this._home.rooms || {};
    this._areas = this._areas
      .map((area, index) => ({ area, order: numberOr(rooms[area.area_id] && rooms[area.area_id].order, index) }))
      .sort((a, b) => a.order - b.order || a.area.name.localeCompare(b.area.name, "ru"))
      .map((item) => item.area);
  }

  get _home() {
    return (this._config && this._config.home) || {};
  }

  _roomCfg(areaId) {
    const rooms = this._home.rooms || {};
    return rooms[areaId] || {};
  }

  /** Все устройства комнаты, включая добавленные руками. */
  _entitiesOf(area) {
    const cfg = this._roomCfg(area.area_id);
    const manual = (cfg.include || [])
      .filter((id) => !area.entities.some((e) => e.entity_id === id))
      .map((id) => {
        const found = this._catalog.find((c) => c.entity_id === id);
        return found
          ? Object.assign({}, found, { manual: true })
          : { entity_id: id, name: id, role: "other", manual: true };
      });
    return area.entities.concat(manual);
  }

  /** Роль с учётом правки монтажника. */
  _roleOf(area, entity) {
    const roles = this._roomCfg(area.area_id).roles || {};
    const role = roles[entity.entity_id] || "auto";
    return role === "auto" ? entity.role : role;
  }

  // merge: сервер сливает словари по ключу (null удаляет) и списки через
  // add/remove — правка не тащит за собой устаревшую копию всего словаря.
  async _patchRoom(areaId, patch) {
    try { await this._ws("home/update", { patch: { rooms: { [areaId]: patch } }, merge: true }); await this._reload(); }
    catch(err) { this._error=err.message || "Не удалось сохранить комнату"; this._render(); }
  }

  async _patchHome(patch) {
    try { await this._ws("home/update", { patch }); await this._reload(); }
    catch(err) { this._error=err.message || "Не удалось сохранить настройки"; this._render(); }
  }

  // ------------------------------------------------------------- отрисовка

  _render() {
    if (!this._config) {
      this.shadowRoot.innerHTML = `<style>${STYLE}</style><div class="wrap"><div class="empty">Загрузка…</div></div>`;
      return;
    }

    const body =
      this._tab === "rooms" ? this._renderRooms()
        : this._tab === "backgrounds" ? this._renderBackgrounds()
          : this._tab === "doorstation" ? this._renderDoorstation()
            : this._renderSettings();

    this.shadowRoot.innerHTML = `
      <style>${STYLE}</style>
      <div class="wrap">
        <header>
          <h1>BMS Планшеты</h1>
          <span class="ver">${esc(this._version ? "v" + this._version : "")}</span>
          <span class="eid">${esc(this._entityId)}</span>
          <span class="grow"></span>
          ${this._error ? `<span class="err">${esc(this._error)}</span>` : ""}
        </header>
        ${this._renderStrip()}
        <div class="tabs">
          ${[["rooms", "Комнаты и устройства"], ["backgrounds", "Фон и фотографии"], ["doorstation", "Домофон"], ["tablet", "Планшет"]]
            .map(([id, label]) =>
              `<div class="tab ${this._tab === id ? "on" : ""}" data-act="tab" data-id="${id}">${label}</div>`)
            .join("")}
        </div>
        <div class="main">${body}</div>
      </div>`;
    this._bind();
    this._restoreFocus();
  }

  /** Сводка: столько дом и уедет на планшет. */
  _renderStrip() {
    let rooms = 0;
    let devices = 0;
    let sensors = 0;
    for (const area of this._areas) {
      const cfg = this._roomCfg(area.area_id);
      if (cfg.visible === false) continue;
      const excluded = new Set(cfg.exclude || []);
      const shown = this._entitiesOf(area).filter((e) => !excluded.has(e.entity_id));
      if (shown.length === 0) continue;
      rooms += 1;
      for (const entity of shown) {
        if (this._roleOf(area, entity).startsWith("sensor_")) sensors += 1;
        else devices += 1;
      }
    }
    const photos = this._areas.filter(a => this._roomCfg(a.area_id).visible !== false && (this._config.backgrounds || {})[a.area_id]?.url).length;
    const noPhoto = rooms - photos;

    return `
      <div class="strip">
        <div class="stat"><b>${rooms}</b><span>комнат на планшете</span></div>
        <div class="stat"><b>${devices}</b><span>устройств</span></div>
        <div class="stat"><b>${sensors}</b><span>датчиков</span></div>
        <div class="stat ${noPhoto > 0 ? "warn" : ""}"><b>${photos}</b><span>комнат с фото</span></div>
      </div>`;
  }

  // -------------------------------------------------- вкладка «Комнаты»

  _renderRooms() {
    if (this._areas.length === 0) {
      return `<div class="empty">
        <p>В Home Assistant нет ни одной зоны (Area).</p>
        <p class="hint">Комната планшета — это зона HA. Создайте её здесь, потом
        добавьте в неё устройства.</p>
        <button data-act="create-area" class="primary">Создать комнату</button>
      </div>`;
    }

    const query = this._search.trim().toLowerCase();
    const areas = query
      ? this._areas.filter((area) =>
        (this._roomCfg(area.area_id).name || area.name).toLowerCase().includes(query) ||
        this._entitiesOf(area).some((e) =>
          e.name.toLowerCase().includes(query) || e.entity_id.includes(query)))
      : this._areas;

    const rows = areas.map((area) => this._renderArea(area)).join("");

    return `
      <div class="toolbar">
        <div class="search">
          <input type="search" placeholder="Поиск по комнатам и устройствам"
                 value="${esc(this._search)}" data-act="search">
        </div>
        <button data-act="create-area">Создать комнату</button>
        <button data-act="expand-all">${this._open.size ? "Свернуть всё" : "Развернуть всё"}</button>
        <button data-act="reset" class="danger">Сбросить все правки</button>
      </div>
      <p class="hint">Комнаты и устройства заполнены автоматически из зон Home Assistant.
      Снимите галочки с лишнего, поправьте тип, где автоопределение ошиблось,
      и добавьте недостающее вручную. Комната без устройств тоже видна на планшете, спрятать её можно галочкой.</p>
      ${rows || `<div class="empty">Ничего не нашлось.</div>`}`;
  }

  _renderArea(area) {
    const cfg = this._roomCfg(area.area_id);
    const visible = cfg.visible !== false;
    const excluded = new Set(cfg.exclude || []);
    const open = this._open.has(area.area_id);
    const entities = this._entitiesOf(area);
    const shown = entities.filter((e) => !excluded.has(e.entity_id));

    const background = (this._config.backgrounds || {})[area.area_id];
    const photo = background?.preview_url || "";

    // Сводка по ролям вместо голой цифры: сразу видно, из чего комната состоит.
    const counts = {};
    for (const entity of shown) {
      const role = this._roleOf(area, entity);
      counts[role] = (counts[role] || 0) + 1;
    }
    const chips = ROLE_GROUPS
      .map(([label, roles, color]) => {
        const total = roles.reduce((sum, role) => sum + (counts[role] || 0), 0);
        return total ? `<span class="chip" style="color:${color}">${total} · ${label}</span>` : "";
      })
      .filter(Boolean)
      .join("");

    const warning = !visible
      ? `<span class="chip warn">скрыта</span>`
      : shown.length === 0
        ? `<span class="chip muted">без устройств</span>`
        : "";

    return `
      <div class="card ${visible ? "" : "off"}">
        <div class="head" data-act="toggle-open" data-id="${esc(area.area_id)}">
          <input type="checkbox" ${visible ? "checked" : ""} data-act="visible" data-id="${esc(area.area_id)}"
                 title="Показывать комнату на планшете">
          ${photo ? `<div class="thumb" style="background-image:url('${esc(photo)}')"></div>` : ""}
          <span class="name">${esc(cfg.name || area.name)}</span>
          <span class="chips">${chips || `<span class="chip muted">пусто</span>`}${warning}</span>
          <button class="icon" data-act="move-up" data-id="${esc(area.area_id)}" title="Выше">↑</button>
          <button class="icon" data-act="move-down" data-id="${esc(area.area_id)}" title="Ниже">↓</button>
          <span class="chip muted">${open ? "▲" : "▼"}</span>
        </div>
        ${open ? `<div class="rows">
          <div class="field"><label>Название на планшете</label><input type="text" maxlength="100" data-act="room-name" data-id="${esc(area.area_id)}" value="${esc(cfg.name || "")}" placeholder="${esc(area.name)}"></div>
          <div class="field"><label>Этаж / зона на планшете</label><input type="text" maxlength="100" data-act="room-floor" data-id="${esc(area.area_id)}" value="${esc(cfg.floor_name || "")}" placeholder="${esc(area.floor_name || "Как в Home Assistant")}"></div>
          <p class="hint">Пустое поле — название из Home Assistant. Изменения касаются только планшета. Сохраняются после выхода из поля.</p>
          <p class="hint">Устройства с одинаковой зоной планшет показывает отдельной карточкой. Название вида «Летняя кухня · Споты» тоже задаёт зону.</p>
          <button data-act="room-photo" data-id="${esc(area.area_id)}">Настроить фотографию комнаты</button>
          ${entities.length === 0 ? `<p class="hint">В этой комнате нет устройств. Добавьте вручную ниже.</p>` : ""}
          <p class="hint">Тёплый пол, конвектор и радиатор — отдельные термостаты. Добавьте каждый из Home Assistant и выберите его тип в строке устройства. Название, питание и температура у каждого свои. Для реле сначала создайте термостат в Home Assistant.</p>
          <div class="field"><label>Добавить отдельный термостат</label>
            <select data-act="add-entity-select" data-id="${esc(area.area_id)}">
              <option value="">— выбрать климатическое устройство —</option>
              ${this._catalog.filter((c) => c.entity_id.startsWith("climate.") && !entities.some((e) => e.entity_id === c.entity_id))
                .map((c) => `<option value="${esc(c.entity_id)}">${esc(c.name)} · ${esc(c.entity_id)}</option>`).join("")}
            </select>
          </div>
          ${entities.map((e) => this._renderEntity(area, e, excluded)).join("")}
          <datalist id="zones-${esc(area.area_id)}">${[...new Set(Object.values(cfg.entity_zones || {}))].map((z) => `<option value="${esc(z)}">`).join("")}</datalist>
          <div class="add">
            <select data-act="add-entity-select" data-id="${esc(area.area_id)}">
              <option value="">— добавить устройство или датчик вручную —</option>
              ${this._catalog
                .filter((c) => !entities.some((e) => e.entity_id === c.entity_id))
                .map((c) => `<option value="${esc(c.entity_id)}">${esc(c.name)} · ${esc(c.entity_id)}</option>`)
                .join("")}
            </select>
          </div>
        </div>` : ""}
      </div>`;
  }

  _renderEntity(area, entity, excluded) {
    const isExcluded = excluded.has(entity.entity_id);
    const roles = this._roomCfg(area.area_id).roles || {};
    const role = roles[entity.entity_id] || "auto";
    const zones = this._roomCfg(area.area_id).entity_zones || {};
    const effective = role === "auto" ? entity.role : role;
    const testable = ["light", "ac", "floor", "radiator", "convector", "cover", "tv", "media", "fan", "other"]
      .includes(effective);

    return `
      <div class="row ${isExcluded ? "excluded" : ""}">
        <input type="checkbox" ${isExcluded ? "" : "checked"}
               data-act="entity" data-area="${esc(area.area_id)}" data-id="${esc(entity.entity_id)}"
               title="Показывать на планшете">
        <div class="nm">
          <input aria-label="Название ${esc(entity.entity_id)}" type="text" maxlength="100" data-act="entity-name" data-area="${esc(area.area_id)}" data-id="${esc(entity.entity_id)}" value="${esc((this._roomCfg(area.area_id).entity_names || {})[entity.entity_id] || "")}" placeholder="${esc(entity.name)}">
          <b>${entity.manual ? '<span class="manual">вручную</span>' : ""}</b>
          <small>${esc(entity.entity_id)} · автоопределение: ${esc(ROLE_LABELS[entity.role] || entity.role)}</small>
          <label class="zone">Зона внутри комнаты <input aria-label="Зона внутри комнаты ${esc(entity.entity_id)}" type="text" maxlength="60" list="zones-${esc(area.area_id)}" data-act="entity-zone" data-area="${esc(area.area_id)}" data-id="${esc(entity.entity_id)}" value="${esc(zones[entity.entity_id] || "")}" placeholder="Без зоны"></label>
        </div>
        <span class="state">${esc(this._stateOf(entity.entity_id))}</span>
        <select data-act="role" data-area="${esc(area.area_id)}" data-id="${esc(entity.entity_id)}">
          ${ROLE_CHOICES.map((r) =>
            `<option value="${r}" ${r === role ? "selected" : ""}>${r === "auto" ? "Как определилось" : ROLE_LABELS[r]}</option>`,
          ).join("")}
        </select>
        ${!effective.startsWith("sensor_") ? `<div style="display:flex;align-items:center;gap:8px">
          ${((this._config.icons || []).find(i => i.id === (this._roomCfg(area.area_id).entity_icons || {})[entity.entity_id])) ? `<img alt="" width="30" height="30" style="background:#303030;padding:6px;border-radius:6px" src="/bms_tablet_static/icons/${esc((this._roomCfg(area.area_id).entity_icons || {})[entity.entity_id])}.svg">` : ""}
          <select aria-label="Иконка ${esc(entity.entity_id)}" data-act="entity-icon" data-area="${esc(area.area_id)}" data-id="${esc(entity.entity_id)}">
            <option value="">Иконка автоматически</option>
            ${(this._config.icons || []).filter(i => i.selectable).map(i => `<option value="${esc(i.id)}" ${(this._roomCfg(area.area_id).entity_icons || {})[entity.entity_id] === i.id ? "selected" : ""}>${esc(i.name)}</option>`).join("")}
          </select>
        </div>` : ""}
        ${effective === "cover" ? `<select aria-label="Направление открытия ${esc(entity.entity_id)}" data-act="cover-direction" data-area="${esc(area.area_id)}" data-id="${esc(entity.entity_id)}">
          ${[["center","От центра в стороны"],["left_to_right","Слева направо"],["right_to_left","Справа налево"]].map(([value,label]) => `<option value="${value}" ${((this._roomCfg(area.area_id).cover_directions || {})[entity.entity_id] || "center") === value ? "selected" : ""}>${label}</option>`).join("")}
        </select>` : ""}
        ${testable ? `<button class="icon" data-act="test" data-id="${esc(entity.entity_id)}" title="Переключить и проверить">⚡</button>` : ""}
      </div>`;
  }

  /** Живое состояние рядом с устройством — видно, что оно вообще отвечает. */
  _stateOf(entityId) {
    const state = this._hass && this._hass.states[entityId];
    if (!state) return "нет";
    const value = state.state;
    if (STATE_LABELS[value]) return STATE_LABELS[value];
    const unit = state.attributes.unit_of_measurement;
    return unit ? `${value} ${unit}` : value;
  }

  // ---------------------------------------------------- вкладка «Фон»

  _renderBackgrounds() {
    const backgrounds = this._config.backgrounds || {};
    const tablets = this._bgTablets(backgrounds);
    return `
      <p class="hint">Общий фон применяется к главной странице и разделам. Фото комнаты появляется на её карточке и за устройствами. Масштаб и смещение действуют в обоих местах; затемнение и размытие — на фоне за устройствами.
      Ползунки видно сразу на снимке: где-то комнату хочется показать чётко,
      где-то фон должен просто не мешать карточкам.</p>
      ${this._bgCard({area_id:"__home__",name:"Общий фон дома",sub:"Для планшетов без номера"}, backgrounds)}
      ${tablets.map((n) => this._bgCard({area_id:`__home__${n}`,name:`Фон · Планшет ${n}`,tablet:n}, backgrounds)).join("")}
      <button data-act="add-tablet-bg" style="margin-bottom:6px">+ Фон для планшета</button>
      <p class="hint">На планшете: Настройки → Номер планшета.</p>
      ${this._areas.map((area) => this._bgCard(area, backgrounds)).join("")}`;
  }

  /** Номера планшетов со своим общим фоном (__home__N), включая только что добавленные. */
  _bgTablets(backgrounds) {
    const nums = new Set(this._bgExtra || []);
    Object.keys(backgrounds).forEach((key) => { const m = /^__home__([1-9]\d?)$/.exec(key); if (m) nums.add(Number(m[1])); });
    return [...nums].sort((a, b) => a - b);
  }

  _bgCard(area, backgrounds) {
    const bg = backgrounds[area.area_id] || {};
    const url = bg.preview_url || "";
    const transform = Object.assign({zoom:1,dx:0,dy:0}, bg.transform || {});
    const blur = Math.round((bg.blur === undefined ? 0.35 : bg.blur) * 100);
    const dim = Math.round((bg.dim === undefined ? 0.24 : bg.dim) * 100);
    return `
      <div class="card" data-background="${esc(area.area_id)}"><div class="bg">
        <div class="frame" data-frame="${esc(area.area_id)}">
          ${url
            ? `<div class="img" data-img="${esc(area.area_id)}"
                    style="background-image:url('${esc(url)}');filter:blur(${blur * 0.18}px);transform:translate(${transform.dx*50}%,${transform.dy*50}%) scale(${transform.zoom})"></div>
               <div class="veil" data-veil="${esc(area.area_id)}" style="opacity:${dim / 100}"></div>`
            : `<div class="none">нет фото</div>`}
        </div>
        <div class="ctrls">
          <div class="title">${esc(this._roomCfg(area.area_id).name || area.name)}</div>${area.sub ? `<p class="hint" style="margin:-8px 0 12px">${esc(area.sub)}</p>` : ""}
          <div class="field"><label data-label="blur-${esc(area.area_id)}">Размытие · ${blur}%</label>
            <input type="range" min="0" max="100" value="${blur}"
                   data-act="blur" data-id="${esc(area.area_id)}"></div>
          <div class="field"><label data-label="dim-${esc(area.area_id)}">Затемнение · ${dim}%</label>
            <input type="range" min="0" max="90" value="${dim}"
                   data-act="dim" data-id="${esc(area.area_id)}"></div>
          ${[["zoom","Масштаб",50,400], ["dx","Смещение по горизонтали",-100,100], ["dy","Смещение по вертикали",-100,100]].map(([key,label,min,max]) => `<div class="field"><label>${label}</label><input aria-label="${label}" type="range" min="${min}" max="${max}" value="${Math.round(transform[key]*100)}" data-act="${key}" data-id="${esc(area.area_id)}"></div>`).join("")}
          <div style="display:flex;gap:10px">
            <button data-act="upload" data-id="${esc(area.area_id)}">${url ? "Заменить фото" : "Загрузить фото"}</button>
            ${url || area.tablet ? `<button class="danger" data-act="drop-bg" data-id="${esc(area.area_id)}">Удалить</button>` : ""}
          </div>
        </div>
      </div></div>`;
  }

  // ------------------------------------------------ вкладка «Планшет»

  // ------------------------------------------------- вкладка «Домофон»

  /** Сущности выбранных доменов, по алфавиту, с понятным именем. */
  _entityOptions(domains) {
    return Object.keys(this._hass.states)
      .filter((id) => domains.includes(id.split(".", 1)[0]))
      .map((id) => [id, this._hass.states[id].attributes.friendly_name || id])
      .sort((a, b) => a[1].localeCompare(b[1], "ru"));
  }

  _renderDoorstation() {
    const door = this._home.doorstation || {};
    const configured = DOORSTATION_FIELDS.some(([key]) => door[key]);

    return `
      <p class="hint">Вызывная панель у калитки. Сущности публикует отдельная интеграция
      «BMS Intercom» — здесь только указывается, какие из них к ней относятся.
      Когда домофон заведён, звонок открывает экран вызова на всех планшетах дома
      поверх того, что на них показано, — включая спящий экран.</p>
      <p class="hint">Любое поле можно оставить пустым. Без камеры планшет всё равно
      покажет вызов и кнопку «Открыть дверь»: открыть дверь важнее, чем увидеть, кто пришёл.</p>

      <div class="field"><label>Название</label>
        <div class="val"><input type="text" style="max-width:320px" placeholder="Домофон"
               value="${esc(door.name || "")}" data-act="door-name"></div></div>

      ${DOORSTATION_FIELDS.map(([key, label, domains, hint]) => `
        <div class="field"><label>${esc(label)}</label>
          <div class="val"><select data-act="door-entity" data-id="${key}">
            <option value="">— не выбрано —</option>
            ${this._entityOptions(domains).map(([id, name]) =>
              `<option value="${esc(id)}" ${door[key] === id ? "selected" : ""}>${esc(name)} · ${esc(id)}</option>`).join("")}
          </select>${hint ? ` <small class="hint">${esc(hint)}</small>` : ""}</div></div>`).join("")}

      ${configured ? `<p class="hint">Двусторонний звук («Говорить») пока не включён: кнопка на планшете
      видна, но подписана «Скоро».</p>
      <button class="danger" data-act="door-clear">Убрать домофон</button>` :
      `<p class="hint">Домофон не заведён — планшеты работают как раньше.</p>`}`;
  }

  _renderSettings() {
    const home = this._home;
    const ambient = home.ambient || {};
    const motionEntities = Object.keys(this._hass.states)
      .filter((id) => id.startsWith("binary_sensor."))
      .filter((id) => (this._hass.states[id].attributes.device_class || "") === "motion");

    return `
      <p class="hint">Настройки дома. Планшет читает их из
      <code>${esc(this._entityId)}</code> — отдельно настраивать каждый планшет не нужно,
      комнаты у них всё равно одни и те же.</p>

      <div class="field"><label>Название дома</label>
        <div class="val"><input type="text" value="${esc(home.name || "")}" data-act="name" style="max-width:320px"></div></div>
      <div class="field"><label>Стартовая комната</label>
        <div class="val"><select data-act="start-area">
          <option value="">— первая по списку —</option>
          ${this._areas.map((a) =>
            `<option value="${esc(a.area_id)}" ${home.start_area === a.area_id ? "selected" : ""}>${esc(a.name)}</option>`).join("")}
        </select></div></div>

      <h3>Привязка устройств</h3>
      <p class="hint">На планшете нажмите «Привязать по коду». Подтвердите здесь код, показанный именно на вашем устройстве. Каждому планшету выдаётся отдельный доступ без прав администратора.</p>
      <div class="toolbar"><input aria-label="Код привязки" data-act="pair-code" maxlength="6" placeholder="ABC234" style="max-width:180px;text-transform:uppercase"><button data-act="pair-approve">Подтвердить код</button></div>
      ${(this._config.paired_devices || []).map(d => `<div class="row"><span class="nm">${esc(d.name)}<small>${esc(d.device_id)}</small><small>${esc(renewInfo(d))}</small></span><span>${d.revoked ? "Доступ отозван" : "Привязан"}</span>${d.revoked ? "" : `<button class="danger" data-act="pair-revoke" data-id="${esc(d.device_id)}">Отозвать доступ</button>`}</div>`).join("")}
      <p class="hint">Отзыв удаляет личность устройства и все его рабочие токены. Самостоятельно восстановить доступ после этого планшет не сможет.</p>

      <h3>Спящий экран</h3>
      <p class="hint">Эта настройка главнее той, что задана на самом планшете:
      её выбирает монтажник, а не тот, кто дотянулся до экрана.</p>
      <div class="field"><label>Когда гаснет</label>
        <div class="val"><select data-act="ambient-mode">
          ${AMBIENT_MODES.map(([v, l]) =>
            `<option value="${v}" ${ambient.mode === v ? "selected" : ""}>${l}</option>`).join("")}
        </select></div></div>
      ${ambient.mode === "timeout" ? `
        <div class="field"><label>Через сколько, секунд</label>
          <div class="val"><input type="number" min="15" max="3600" step="15" style="max-width:140px"
                 value="${ambient.timeout_sec || 180}" data-act="ambient-timeout"></div></div>` : ""}
      ${ambient.mode === "motion" ? `
        <div class="field"><label>Датчик движения</label>
          <div class="val"><select data-act="ambient-motion">
            <option value="">— не выбран —</option>
            ${motionEntities.map((id) =>
              `<option value="${esc(id)}" ${ambient.motion_entity === id ? "selected" : ""}>${esc(this._hass.states[id].attributes.friendly_name || id)}</option>`).join("")}
          </select></div></div>` : ""}
      <div class="field"><label>Яркость в работе · ${ambient.brightness_active || 100}%</label>
        <div class="val"><input type="range" min="10" max="100" value="${ambient.brightness_active || 100}" data-act="brightness-active"></div></div>
      <div class="field"><label>Яркость в покое · ${ambient.brightness_ambient || 15}%</label>
        <div class="val"><input type="range" min="1" max="100" value="${ambient.brightness_ambient || 15}" data-act="brightness-ambient"></div></div>

      <h3>Киоск</h3>
      <p class="hint">Включается на самом планшете: жест в углу → PIN → «Киоск».
      Отсюда киоск не включается намеренно — иначе панель можно было бы
      заблокировать удалённо, а разблокировать пришлось бы ногами.</p>

      <h3>Сброс</h3>
      <p class="hint">Вернуть комнаты к чистому автоопределению. Фотографии останутся.</p>
      <button class="danger" data-act="reset">Сбросить все правки</button>`;
  }

  // ------------------------------------------------------------ события

  _bind() {
    // shadowRoot при перерисовке не пересоздаётся, поэтому вешаем слушатели
    // ровно один раз — иначе каждый клик уходил бы по нескольку раз.
    if (this._bound) return;
    this._bound = true;
    const root = this.shadowRoot;

    root.addEventListener("click", async (event) => {
      const target = event.target.closest("[data-act]");
      if (!target) return;
      const act = target.dataset.act;
      const id = target.dataset.id;

      if (act === "tab") { this._tab = id; return this._render(); }
      if (act === "toggle-open") {
        if (event.target.matches("input,button,select")) return;
        this._open.has(id) ? this._open.delete(id) : this._open.add(id);
        return this._render();
      }
      if (act === "expand-all") {
        if (this._open.size) this._open.clear();
        else this._areas.forEach((a) => this._open.add(a.area_id));
        return this._render();
      }
      if (act === "move-up" || act === "move-down") {
        event.stopPropagation();
        return this._move(id, act === "move-up" ? -1 : 1);
      }
      if (act === "test") { event.stopPropagation(); return this._test(id); }
      if (act === "room-photo") {
        this._tab="backgrounds"; this._render();
        Array.from(root.querySelectorAll("[data-background]")).find(el=>el.dataset.background===id)?.scrollIntoView({block:"start"});
        return;
      }
      if (act === "pair-approve" || act === "pair-revoke") {
        if(this._pairBusy) return;
        const code=root.querySelector('[data-act="pair-code"]')?.value.trim().toUpperCase();
        if(act === "pair-revoke" && !window.confirm("Отозвать доступ этого планшета и запретить восстановление токенов?")) return;
        this._pairBusy=true; target.disabled=true;
        try {
          await this._ws("pairing", act === "pair-approve" ? {action:"approve",code} : {action:"revoke",device_id:id});
          await this._reload();
        } catch(err) { this._error=err.message || "Не удалось выполнить привязку"; this._render(); }
        finally { this._pairBusy=false; target.disabled=false; }
        return;
      }
      if (act === "upload") return this._upload(id);
      if (act === "drop-bg") return this._dropBackground(id);
      if (act === "add-tablet-bg") {
        const used = this._bgTablets(this._config.backgrounds || {});
        const n = [...Array(99).keys()].map((i) => i + 1).find((i) => !used.includes(i));
        if (!n) return;
        (this._bgExtra = this._bgExtra || new Set()).add(n);
        this._render();
        return this._upload(`__home__${n}`);
      }
      if (act === "door-clear") {
        if (!confirm("Убрать домофон? Планшеты перестанут показывать вызов.")) return;
        return this._enqueue(() => this._patchHome({ doorstation: null }));
      }
      if (act === "reset") return this._reset();
      if (act === "create-area") return this._createArea();
    });

    // Ползунки фона показывают результат прямо на снимке, ещё до сохранения:
    // подобрать размытие «на глаз» иначе невозможно.
    root.addEventListener("input", (event) => {
      const target = event.target.closest("[data-act]");
      if (!target) return;
      const act = target.dataset.act;
      const id = target.dataset.id;

      if (act === "search") {
        this._search = target.value;
        this._focus = { act: "search", start: target.selectionStart };
        return this._render();
      }
      if (["zoom","dx","dy"].includes(act)) {
        const frame=Array.from(root.querySelectorAll("[data-background]")).find(el=>el.dataset.background===id);
        const value=key=>Number(frame.querySelector(`[data-act="${key}"]`).value)/100;
        const img=frame.querySelector(".img");
        if(img) img.style.transform=`translate(${value("dx")*50}%,${value("dy")*50}%) scale(${value("zoom")})`;
      }
      if (act === "blur" || act === "dim") {
        const label = root.querySelector(`[data-label="${act}-${id}"]`);
        if (label) {
          label.textContent = `${act === "blur" ? "Размытие" : "Затемнение"} · ${target.value}%`;
        }
        if (act === "blur") {
          const img = root.querySelector(`[data-img="${id}"]`);
          if (img) img.style.filter = `blur(${target.value * 0.18}px)`;
        } else {
          const veil = root.querySelector(`[data-veil="${id}"]`);
          if (veil) veil.style.opacity = String(target.value / 100);
        }
      }
    });

    root.addEventListener("change", (event) => {
      const source = event.target.closest("[data-act]");
      if (!source) return;
      // Capture the input now, but derive maps from the latest saved config.
      // Otherwise fast changes to different icons overwrite each other.
      const target = { dataset: { ...source.dataset }, value: source.value, checked: source.checked };
      event.stopPropagation();
      this._enqueue(async () => {
      const act = target.dataset.act;
      const id = target.dataset.id;

      if (act === "room-name") return this._patchRoom(id,{name:target.value.trim() || null});
      if (act === "room-floor") return this._patchRoom(id,{floor_name:target.value.trim() || null});
      if (act === "entity-name") return this._patchRoom(target.dataset.area,{entity_names:{[id]:target.value.trim() || null}});
      if (act === "entity-zone") return this._patchRoom(target.dataset.area,{entity_zones:{[id]:target.value.trim().slice(0,60) || null}});
      if (["zoom","dx","dy"].includes(act)) return this._ws("background/set",{area_id:id,transform:{[act]:Number(target.value)/100}}).then(()=>this._reload());
      if (act === "visible") {
        event.stopPropagation();
        return this._patchRoom(id, { visible: target.checked });
      }
      if (act === "entity") {
        return this._patchRoom(target.dataset.area, { exclude: target.checked ? { remove: [id] } : { add: [id] } });
      }
      if (act === "entity-icon") return this._patchRoom(target.dataset.area, { entity_icons: { [id]: target.value || null } });
      if (act === "cover-direction") return this._patchRoom(target.dataset.area, { cover_directions: { [id]: target.value } });
      if (act === "role") return this._patchRoom(target.dataset.area, { roles: { [id]: target.value === "auto" ? null : target.value } });
      if (act === "add-entity-select") {
        if (!target.value) return;
        this._open.add(id);
        return this._patchRoom(id, { include: { add: [target.value] } });
      }
      if (act === "blur") return this._ws("background/set", { area_id: id, blur: target.value / 100 }).then(() => this._reload());
      if (act === "dim") return this._ws("background/set", { area_id: id, dim: target.value / 100 }).then(() => this._reload());
      if (act === "door-entity") return this._patchHome({ doorstation: { [id]: target.value || "" } });
      if (act === "door-name") return this._patchHome({ doorstation: { name: target.value.trim() || null } });
      if (act === "name") return this._patchHome({ name: target.value });
      if (act === "start-area") return this._patchHome({ start_area: target.value || null });
      if (act === "ambient-mode") return this._patchHome({ ambient: { mode: target.value } });
      if (act === "ambient-timeout") return this._patchHome({ ambient: { timeout_sec: Number(target.value) } });
      if (act === "ambient-motion") return this._patchHome({ ambient: { motion_entity: target.value || null } });
      if (act === "brightness-active") return this._patchHome({ ambient: { brightness_active: Number(target.value) } });
      if (act === "brightness-ambient") return this._patchHome({ ambient: { brightness_ambient: Number(target.value) } });
      });
    });
  }

  /** Все записи идут по одной: следующая строится от конфига, перечитанного после предыдущей. */
  _enqueue(job) {
    this._changeQueue = (this._changeQueue || Promise.resolve()).then(job)
      .catch(err => { this._error = (err && err.message) || "Не удалось сохранить настройки"; this._render(); });
    return this._changeQueue;
  }

  /** После перерисовки вернуть курсор в поиск — иначе он теряется на первой букве. */
  _restoreFocus() {
    if (!this._focus) return;
    const field = this.shadowRoot.querySelector(`[data-act="${this._focus.act}"]`);
    if (field) {
      field.focus();
      const at = this._focus.start;
      if (at !== null && at !== undefined && field.setSelectionRange) {
        try { field.setSelectionRange(at, at); } catch (err) { /* type=search не всегда умеет */ }
      }
    }
    this._focus = null;
  }

  // ------------------------------------------------------------ действия

  async _reset() {
    if (!confirm("Вернуть все комнаты к автоопределению? Правки будут стёрты.")) return;
    return this._enqueue(async () => {
      try { await this._ws("home/reset"); await this._reload(); }
      catch(err) { this._error=(err && err.message) || "Не удалось сбросить правки"; this._render(); }
    });
  }

  _move(areaId, delta) {
    // Порядок считается уже внутри очереди — от списка после предыдущей записи.
    return this._enqueue(async () => {
      const order = this._areas.map((a) => a.area_id);
      const from = order.indexOf(areaId);
      const to = from + delta;
      if (from < 0 || to < 0 || to >= order.length) return;
      order.splice(to, 0, order.splice(from, 1)[0]);
      const rooms = {};
      order.forEach((id, index) => { rooms[id] = { order: index }; });
      try {
        await this._ws("home/update", { patch: { rooms }, merge: true });
        this._areas = order.map((id) => this._areas.find((a) => a.area_id === id));
        await this._reload();
      } catch(err) { this._error=(err && err.message) || "Не удалось изменить порядок"; this._render(); }
    });
  }

  async _test(entityId) {
    const domain = entityId.split(".")[0];
    try {
      // toggle есть у всех доменов, которые мы показываем на планшете.
      await this._hass.callService(domain, "toggle", { entity_id: entityId });
    } catch (err) {
      this._error = `Не удалось переключить ${entityId}`;
      this._render();
    }
  }

  _upload(areaId) {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/jpeg,image/png,image/webp";
    input.addEventListener("change", () => this._enqueue(async () => {
      const file = input.files && input.files[0];
      if (!file) return;
      const form = new FormData();
      form.append("file", file);
      let uploadError = "";
      try {
        const response = await this._hass.fetchWithAuth(`/api/bms_tablet/background/${encodeURIComponent(areaId)}`, {
          method: "POST",
          body: form,
        });
        if (!response.ok) {
          const detail = await response.json().catch(() => ({}));
          throw new Error(detail.message || `Ошибка ${response.status}`);
        }
        this._error = "";
      } catch (err) {
        uploadError = (err && err.message) || "Не удалось загрузить фото";
      }
      await this._reload();
      if(uploadError) { this._error=uploadError; this._render(); }
    }));
    input.click();
  }

  async _dropBackground(areaId) {
    const tablet = /^__home__\d+$/.test(areaId);
    if (!confirm(tablet ? "Удалить фон этого планшета?" : "Удалить фото комнаты?")) return;
    if (tablet) this._bgExtra?.delete(Number(areaId.slice(8)));
    if (tablet && !(this._config.backgrounds || {})[areaId]) return this._render();
    return this._enqueue(async () => {
      let dropError = "";
      try {
        const response = await this._hass.fetchWithAuth(`/api/bms_tablet/background/${encodeURIComponent(areaId)}`, { method: "DELETE" });
        if (!response.ok) {
          const detail = await response.json().catch(() => ({}));
          throw new Error(detail.message || `Ошибка ${response.status}`);
        }
      } catch (err) {
        dropError = (err && err.message) || "Не удалось удалить фото";
      }
      await this._reload();
      if (dropError) { this._error = dropError; this._render(); }
    });
  }

  async _createArea() {
    const name = prompt("Название комнаты");
    if (!name) return;
    try {
      await this._hass.connection.sendMessagePromise({
        type: "config/area_registry/create",
        name,
      });
    } catch (err) {
      this._error = (err && err.message) || "Не удалось создать комнату";
    }
    await this._reload();
  }
}

// --------------------------------------------------------------- утилиты

function esc(value) {
  return String(value === undefined || value === null ? "" : value)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** «Последнее обновление: дата, IP» — чужое обновление доступа видно админу сразу. */
function renewInfo(device) {
  const at = device.last_renew_at || device.renewed;
  const when = at ? new Date(at * 1000).toLocaleString("ru-RU") : "ещё не было";
  const seen = device.last_seen ? ` · на связи: ${new Date(device.last_seen * 1000).toLocaleString("ru-RU")}` : "";
  return `Последнее обновление: ${when}${device.last_ip ? ", " + device.last_ip : ""}${seen}`;
}

function numberOr(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

if (!customElements.get("bms-tablet-editor")) {
  customElements.define("bms-tablet-editor", BmsTabletEditor);
}
