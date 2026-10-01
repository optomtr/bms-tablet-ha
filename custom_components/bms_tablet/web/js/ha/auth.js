// Вход в Home Assistant для веб-версии планшета (iPad, Safari).
//
// Страница входит как обычный пользователь HA через его собственный OAuth2
// (/auth/authorize → /auth/token), как официальный фронтенд. Токены живут
// только в localStorage этого же адреса и уходят только на этот же адрес.
// Никаких долгоживущих токенов и секретов в HTML.

export const TOKENS_KEY = 'bmsTabletTokens';
// Токены фронтенда HA на том же адресе: только читаем, никогда не пишем.
export const HASS_TOKENS_KEY = 'hassTokens';
export const STATE_KEY = 'bmsTabletOAuthState';
// После «Выйти» токены фронтенда HA не подхватываем: иначе выход ничего бы
// не менял. Снимается следующим входом через страницу HA.
export const LOGGED_OUT_KEY = 'bmsTabletLoggedOut';
// Ярлык на экране «Домой» на iOS может потерять sessionStorage при переходе
// на страницу входа и обратно, поэтому state живёт в localStorage, но недолго.
const STATE_TTL_MS = 10 * 60 * 1000;

export class AuthError extends Error {
  /** code: 'invalid_grant' | 'state_mismatch' | 'exchange_failed' | 'network' | 'server' */
  constructor(code, message, { retryable = false } = {}) {
    super(message || code);
    this.name = 'AuthError';
    this.code = code;
    this.retryable = retryable;
  }
}

// ---------------------------------------------------------------- хранилище

function store(kind = 'localStorage') {
  try {
    return globalThis[kind] || null;
  } catch {
    return null;
  }
}

function readJson(key, kind) {
  try {
    const raw = store(kind)?.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeJson(key, value, kind) {
  try {
    store(kind)?.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function removeKey(key, kind) {
  try {
    store(kind)?.removeItem(key);
  } catch {
    /* хранилище недоступно — забывать нечего */
  }
}

// ---------------------------------------------------------------- помощники

function normalizeBase(base) {
  const url = new URL(String(base));
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AuthError('bad_base', 'Адрес Home Assistant должен быть http(s)');
  }
  return url.origin;
}

function clientIdFor(base) {
  // Так же, как у фронтенда HA: токен обновления привязан к client_id, и
  // одинаковый client_id позволяет пользоваться уже выданными hassTokens.
  return `${base}/`;
}

function randomState() {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function pageUrlWithoutQuery() {
  const { origin, pathname } = globalThis.location;
  return origin + pathname;
}

function validTokens(data, base) {
  return (
    data &&
    typeof data === 'object' &&
    typeof data.access_token === 'string' &&
    data.access_token &&
    typeof data.refresh_token === 'string' &&
    data.refresh_token &&
    // Чужой адрес — чужие токены: отправлять их туда нельзя и незачем.
    (data.hassUrl === undefined || data.hassUrl === base)
  );
}

function expiresAtOf(data) {
  if (Number.isFinite(data.expires)) return data.expires;
  return 0; // неизвестно — считаем истёкшим, обновим перед подключением
}

async function postForm(base, path, fields) {
  let response;
  try {
    response = await globalThis.fetch(`${base}${path}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
    });
  } catch (error) {
    throw new AuthError('network', 'Нет связи с Home Assistant', { retryable: true });
  }
  return response;
}

async function readTokenResponse(response) {
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return body;
}

// ---------------------------------------------------------------- Auth

class Auth {
  constructor(base, data) {
    this.base = base;
    this._data = data;
    this._refreshing = null;
  }

  get accessToken() {
    return this._data.access_token;
  }

  get refreshToken() {
    return this._data.refresh_token;
  }

  get expiresAt() {
    return expiresAtOf(this._data);
  }

  get clientId() {
    return this._data.clientId || clientIdFor(this.base);
  }

  get expired() {
    return Date.now() >= this.expiresAt;
  }

  /** Новый access-токен. Сеть упала — AuthError(retryable). Токен отозван — вход заново. */
  refresh() {
    if (!this._refreshing) {
      this._refreshing = this._doRefresh().finally(() => {
        this._refreshing = null;
      });
    }
    return this._refreshing;
  }

  async _doRefresh() {
    const response = await postForm(this.base, '/auth/token', {
      grant_type: 'refresh_token',
      refresh_token: this.refreshToken,
      client_id: this.clientId,
    });
    const body = await readTokenResponse(response);
    if (response.status === 400 || response.status === 401 || response.status === 403) {
      // Токен отозван, пользователь отключён или client_id чужой: свои
      // токены забываем (hassTokens не трогаем) и идём на вход.
      removeKey(TOKENS_KEY);
      startLogin({ base: this.base });
      throw new AuthError('invalid_grant', body?.error || 'invalid_grant');
    }
    if (!response.ok || !body || typeof body.access_token !== 'string') {
      throw new AuthError('server', `Ошибка Home Assistant ${response.status}`, { retryable: true });
    }
    this._data = {
      ...this._data,
      access_token: body.access_token,
      expires_in: body.expires_in,
      expires: Date.now() + Number(body.expires_in || 0) * 1000,
    };
    if (body.refresh_token) this._data.refresh_token = body.refresh_token;
    writeJson(TOKENS_KEY, this._data);
    return this;
  }
}

// ---------------------------------------------------------------- вход

/** Уйти на страницу входа Home Assistant. */
export function startLogin({ base = globalThis.location.origin } = {}) {
  base = normalizeBase(base);
  const state = randomState();
  const record = { state, ts: Date.now() };
  writeJson(STATE_KEY, record);
  writeJson(STATE_KEY, record, 'sessionStorage');
  const url =
    `${base}/auth/authorize?response_type=code` +
    `&client_id=${encodeURIComponent(clientIdFor(base))}` +
    `&redirect_uri=${encodeURIComponent(pageUrlWithoutQuery())}` +
    `&state=${encodeURIComponent(state)}`;
  globalThis.location.assign(url);
}

function takeSavedStates() {
  const states = [];
  for (const kind of ['localStorage', 'sessionStorage']) {
    const saved = readJson(STATE_KEY, kind);
    if (saved && typeof saved.state === 'string' && Date.now() - Number(saved.ts) < STATE_TTL_MS) {
      states.push(saved.state);
    }
    removeKey(STATE_KEY, kind);
  }
  return states;
}

function stripOAuthParams() {
  const url = new URL(globalThis.location.href);
  for (const name of ['code', 'state', 'auth_callback', 'storeToken']) url.searchParams.delete(name);
  const query = url.searchParams.toString();
  try {
    globalThis.history.replaceState(
      globalThis.history.state,
      '',
      url.pathname + (query ? `?${query}` : '') + url.hash,
    );
  } catch {
    /* без history код останется в адресе, но второй раз он уже не сработает */
  }
}

async function exchangeCode(base, code) {
  const clientId = clientIdFor(base);
  const response = await postForm(base, '/auth/token', {
    grant_type: 'authorization_code',
    code,
    client_id: clientId,
  });
  const body = await readTokenResponse(response);
  if (!response.ok || !body || typeof body.access_token !== 'string' || typeof body.refresh_token !== 'string') {
    throw new AuthError('exchange_failed', body?.error_description || body?.error || `HTTP ${response.status}`, {
      retryable: response.status >= 500,
    });
  }
  return {
    access_token: body.access_token,
    refresh_token: body.refresh_token,
    token_type: body.token_type,
    expires_in: body.expires_in,
    expires: Date.now() + Number(body.expires_in || 0) * 1000,
    hassUrl: base,
    clientId,
    source: 'oauth',
  };
}

/**
 * Токены для Home Assistant.
 * Порядок: свои (bmsTabletTokens) → фронтенда HA (hassTokens, только чтение)
 * → возврат со страницы входа (?code=&state=) → переход на страницу входа.
 * При переходе на вход возвращённый Promise не разрешается.
 */
export async function getAuth({ base = globalThis.location.origin } = {}) {
  base = normalizeBase(base);
  const params = new URL(globalThis.location.href).searchParams;
  const code = params.get('code');

  if (code) {
    const returned = params.get('state');
    const saved = takeSavedStates();
    stripOAuthParams();
    if (!returned || !saved.includes(returned)) {
      // Чужой или устаревший code не обмениваем. Приложение покажет
      // «Войти снова»; следующий getAuth уже без code уйдёт на вход.
      throw new AuthError('state_mismatch', 'Вход не подтверждён, войдите снова');
    }
    const data = await exchangeCode(base, code);
    writeJson(TOKENS_KEY, data);
    removeKey(LOGGED_OUT_KEY);
    return new Auth(base, data);
  }

  const own = readJson(TOKENS_KEY);
  if (validTokens(own, base)) return new Auth(base, own);

  const hass = readJson(LOGGED_OUT_KEY) ? null : readJson(HASS_TOKENS_KEY);
  if (validTokens(hass, base) && (!hass.clientId || hass.clientId === clientIdFor(base))) {
    const data = {
      access_token: hass.access_token,
      refresh_token: hass.refresh_token,
      token_type: hass.token_type,
      expires_in: hass.expires_in,
      expires: Number.isFinite(hass.expires) ? hass.expires : 0,
      hassUrl: base,
      clientId: clientIdFor(base),
      // Токен общий с фронтендом HA: отзывать его при выходе нельзя.
      source: 'hass',
    };
    writeJson(TOKENS_KEY, data);
    return new Auth(base, data);
  }

  startLogin({ base });
  return new Promise(() => {});
}

/** Выйти: отозвать свой токен (по возможности) и забыть его. */
export async function logout({ base = globalThis.location.origin } = {}) {
  base = normalizeBase(base);
  const own = readJson(TOKENS_KEY);
  removeKey(TOKENS_KEY);
  writeJson(LOGGED_OUT_KEY, true);
  if (validTokens(own, base) && own.source !== 'hass') {
    try {
      await postForm(base, '/auth/revoke', { token: own.refresh_token });
    } catch {
      /* best-effort: локально уже вышли */
    }
  }
}
