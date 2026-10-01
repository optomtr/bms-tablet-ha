// Небольшой клиент WebSocket API Home Assistant для веб-версии планшета.
//
// iPad часто засыпает: сокет умирает молча, поэтому здесь ping раз в 30 с,
// переподключение с паузами и немедленное — при возвращении на экран и
// появлении сети. После каждого подключения подписки восстанавливаются и
// приходит статус 'connected' — по нему приложение перечитывает состояния.

const BACKOFF_MS = [1000, 2000, 5000, 10000, 30000];
const PING_INTERVAL_MS = 30000;
const PONG_TIMEOUT_MS = 10000;
// Сокет, который не прошёл авторизацию за это время, считается мёртвым.
const HANDSHAKE_TIMEOUT_MS = 15000;
// Токен, которому жить меньше минуты, обновляем до подключения.
const REFRESH_MARGIN_MS = 60000;

export class ConnectionError extends Error {
  /** code: 'not_connected' | 'connection_lost' | 'closed' | код ошибки HA */
  constructor(code, message) {
    super(message || code);
    this.name = 'ConnectionError';
    this.code = code;
  }
}

export function websocketUrl(base) {
  const url = new URL(String(base));
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new ConnectionError('bad_base', 'Адрес Home Assistant должен быть http(s)');
  }
  // http → ws, https → wss; путь и параметры базы не нужны.
  return `${url.origin.replace(/^http/, 'ws')}/api/websocket`;
}

/**
 * @param auth объект из getAuth(): accessToken, expiresAt, base, refresh()
 * @param options для тестов: WebSocket, backoff, pingInterval, pongTimeout, handshakeTimeout
 */
export function createConnection(auth, options = {}) {
  const WS = options.WebSocket || globalThis.WebSocket;
  const backoff = options.backoff || BACKOFF_MS;
  const pingInterval = options.pingInterval ?? PING_INTERVAL_MS;
  const pongTimeout = options.pongTimeout ?? PONG_TIMEOUT_MS;
  const handshakeTimeout = options.handshakeTimeout ?? HANDSHAKE_TIMEOUT_MS;
  const url = websocketUrl(auth.base);

  let socket = null;
  let ready = false; // auth_ok получен, команды можно слать
  let status = 'disconnected';
  let nextId = 1;
  let attempt = 0;
  let retriedAuth = false;
  let stopped = true; // close() или auth_failed: само не переподключается
  let reconnectTimer = null;
  let handshakeTimer = null;
  let pingTimer = null;
  let pongTimer = null;
  let firstConnect = null;
  let opening = false; // идёт обновление токена перед подключением

  const pending = new Map(); // id -> {resolve, reject}
  const subscriptions = new Map(); // ключ -> {callback, eventType, haId}
  const statusListeners = new Set();
  let subscriptionKey = 0;

  function setStatus(value) {
    if (status === value) return;
    status = value;
    for (const listener of [...statusListeners]) {
      try {
        listener(value);
      } catch (error) {
        console.error('[bms] status listener', error);
      }
    }
    if (firstConnect) {
      if (value === 'connected') firstConnect.resolve();
      if (value === 'auth_failed') firstConnect.reject(new ConnectionError('auth_failed', 'Вход не принят'));
      if (value === 'connected' || value === 'auth_failed') firstConnect = null;
    }
  }

  function clearTimers() {
    clearTimeout(reconnectTimer);
    clearTimeout(handshakeTimer);
    clearInterval(pingTimer);
    clearTimeout(pongTimer);
    reconnectTimer = handshakeTimer = pingTimer = pongTimer = null;
  }

  function rejectPending(code, message) {
    const waiting = [...pending.values()];
    pending.clear();
    for (const entry of waiting) entry.reject(new ConnectionError(code, message));
  }

  function rawSend(message) {
    socket.send(JSON.stringify(message));
  }

  function command(message) {
    if (!ready || !socket) {
      return Promise.reject(new ConnectionError('not_connected', 'Нет связи с домом'));
    }
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      try {
        rawSend({ ...message, id });
      } catch (error) {
        pending.delete(id);
        reject(new ConnectionError('connection_lost', 'Нет связи с домом'));
      }
    });
  }

  // ------------------------------------------------------------ жизненный цикл

  function scheduleReconnect(delay) {
    if (stopped) return;
    clearTimeout(reconnectTimer);
    const wait = delay ?? backoff[Math.min(attempt, backoff.length - 1)];
    attempt += 1;
    reconnectTimer = setTimeout(open, wait);
  }

  /** Сокет больше не годится: снять обработчики, закрыть, решить, что дальше. */
  function drop(reason, { reconnectDelay } = {}) {
    const old = socket;
    socket = null;
    ready = false;
    clearTimers();
    if (old) {
      old.onopen = old.onmessage = old.onerror = old.onclose = null;
      try {
        old.close();
      } catch {
        /* уже закрыт */
      }
    }
    for (const sub of subscriptions.values()) sub.haId = null;
    rejectPending('connection_lost', reason || 'Связь с домом потеряна');
    if (stopped) return;
    setStatus('disconnected');
    scheduleReconnect(reconnectDelay);
  }

  function authFailed() {
    stopped = true;
    drop('Вход не принят');
    setStatus('auth_failed');
  }

  async function refreshOrFail() {
    try {
      await auth.refresh();
      return true;
    } catch (error) {
      if (error && error.retryable) {
        drop('Нет связи для обновления входа');
      } else {
        authFailed();
      }
      return false;
    }
  }

  async function open() {
    if (stopped) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    if (socket || opening) return;
    setStatus('connecting');
    if (!Number.isFinite(auth.expiresAt) || auth.expiresAt - Date.now() < REFRESH_MARGIN_MS) {
      opening = true;
      let refreshed;
      try {
        refreshed = await refreshOrFail();
      } finally {
        opening = false;
      }
      if (!refreshed || stopped || socket) return;
    }
    let ws;
    try {
      ws = new WS(url);
    } catch (error) {
      drop('Не удалось открыть соединение');
      return;
    }
    socket = ws;
    handshakeTimer = setTimeout(() => {
      if (socket === ws && !ready) drop('Дом не ответил');
    }, handshakeTimeout);
    ws.onmessage = (event) => {
      if (socket !== ws) return;
      let data;
      try {
        data = JSON.parse(event.data);
      } catch {
        return;
      }
      for (const message of Array.isArray(data) ? data : [data]) handleMessage(ws, message);
    };
    ws.onclose = () => {
      if (socket === ws) drop('Связь с домом потеряна');
    };
    ws.onerror = () => {
      /* за ним всегда приходит onclose */
    };
  }

  async function onAuthOk() {
    ready = true;
    retriedAuth = false;
    attempt = 0;
    clearTimeout(handshakeTimer);
    handshakeTimer = null;
    startKeepalive();
    const ws = socket;
    // Подписки — до статуса 'connected': приложение перечитает состояния
    // уже с подпиской на изменения и ничего не пропустит.
    await Promise.allSettled([...subscriptions.values()].map((sub) => sendSubscribe(sub)));
    if (socket === ws && ready) setStatus('connected');
  }

  async function onAuthInvalid() {
    if (retriedAuth) {
      authFailed();
      return;
    }
    retriedAuth = true;
    const ws = socket;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
      try {
        ws.close();
      } catch {
        /* уже закрыт */
      }
    }
    socket = null;
    clearTimers();
    if (!(await refreshOrFail())) return;
    open();
  }

  function handleMessage(ws, message) {
    if (!message || typeof message !== 'object') return;
    switch (message.type) {
      case 'auth_required':
        try {
          ws.send(JSON.stringify({ type: 'auth', access_token: auth.accessToken }));
        } catch {
          drop('Связь с домом потеряна');
        }
        return;
      case 'auth_ok':
        onAuthOk();
        return;
      case 'auth_invalid':
        onAuthInvalid();
        return;
      case 'pong':
        clearTimeout(pongTimer);
        pongTimer = null;
        resolvePending(message.id, message);
        return;
      case 'event':
        for (const sub of subscriptions.values()) {
          if (sub.haId === message.id) {
            try {
              sub.callback(message.event);
            } catch (error) {
              console.error('[bms] event callback', error);
            }
          }
        }
        return;
      case 'result': {
        const entry = pending.get(message.id);
        if (!entry) return;
        pending.delete(message.id);
        if (message.success) entry.resolve(message.result);
        else {
          const error = message.error || {};
          entry.reject(new ConnectionError(error.code || 'unknown_error', error.message));
        }
        return;
      }
      default:
    }
  }

  function resolvePending(id, value) {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    entry.resolve(value);
  }

  // ------------------------------------------------------------ keepalive

  function ping() {
    if (!ready || pongTimer) return;
    pongTimer = setTimeout(() => {
      pongTimer = null;
      drop('Дом не отвечает', { reconnectDelay: 0 });
    }, pongTimeout);
    command({ type: 'ping' }).catch(() => {});
  }

  function startKeepalive() {
    clearInterval(pingTimer);
    pingTimer = setInterval(ping, pingInterval);
  }

  // ------------------------------------------------------------ события окна

  function wake() {
    if (stopped) return;
    if (ready) {
      // После сна сокет мог умереть молча — проверяем сразу, не ждём 30 с.
      ping();
      return;
    }
    if (!socket && !opening) {
      attempt = 0;
      open();
    }
  }

  function onVisibility() {
    if (globalThis.document?.visibilityState === 'visible') wake();
  }

  function onOnline() {
    wake();
  }

  function listenWindow(on) {
    const method = on ? 'addEventListener' : 'removeEventListener';
    try {
      globalThis.document?.[method]?.('visibilitychange', onVisibility);
      globalThis[method]?.('online', onOnline);
    } catch {
      /* без окна (тесты, воркер) — просто без пробуждения */
    }
  }

  // ------------------------------------------------------------ подписки

  async function sendSubscribe(sub) {
    const message = { type: 'subscribe_events' };
    if (sub.eventType) message.event_type = sub.eventType;
    const id = nextId; // command() возьмёт именно этот id
    sub.haId = id;
    try {
      await command(message);
    } catch (error) {
      if (sub.haId === id) sub.haId = null;
      throw error;
    }
  }

  // ------------------------------------------------------------ API

  return {
    get status() {
      return status;
    },

    /** Подключиться. Разрешается при первом 'connected', отклоняется при 'auth_failed'. */
    connect() {
      if (status === 'connected') return Promise.resolve();
      const wait = firstConnect?.promise || null;
      if (wait && !stopped) return wait;
      stopped = false;
      retriedAuth = false;
      attempt = 0;
      let resolve;
      let reject;
      const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
      });
      firstConnect = { promise, resolve, reject };
      listenWindow(true);
      open();
      return promise;
    },

    close() {
      stopped = true;
      listenWindow(false);
      drop('Соединение закрыто');
      rejectPending('closed', 'Соединение закрыто');
      setStatus('disconnected');
      if (firstConnect) {
        firstConnect.reject(new ConnectionError('closed', 'Соединение закрыто'));
        firstConnect = null;
      }
    },

    sendMessage(message) {
      return command(message);
    },

    async subscribeEvents(callback, eventType) {
      const key = ++subscriptionKey;
      const sub = { callback, eventType, haId: null };
      subscriptions.set(key, sub);
      if (ready) {
        try {
          await sendSubscribe(sub);
        } catch (error) {
          // Отказ HA (нет прав) — подписки нет. Обрыв связи — подписка
          // останется и восстановится при переподключении.
          if (!(error instanceof ConnectionError && ['connection_lost', 'not_connected'].includes(error.code))) {
            subscriptions.delete(key);
            throw error;
          }
        }
      }
      return async () => {
        const current = subscriptions.get(key);
        subscriptions.delete(key);
        if (current?.haId != null && ready) {
          try {
            await command({ type: 'unsubscribe_events', subscription: current.haId });
          } catch {
            /* сокет закрылся — подписка умерла вместе с ним */
          }
        }
      };
    },

    getStates() {
      return command({ type: 'get_states' });
    },

    callService(domain, service, serviceData, target) {
      const message = { type: 'call_service', domain, service };
      if (serviceData !== undefined) message.service_data = serviceData;
      if (target !== undefined) message.target = target;
      return command(message);
    },

    /** cb(status) на каждую смену статуса. Возвращает функцию отписки. */
    onStatus(callback) {
      statusListeners.add(callback);
      return () => statusListeners.delete(callback);
    },
  };
}
