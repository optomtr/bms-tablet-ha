"""Справочник интеркома: планшеты находят друг друга через интеграцию.

Раньше планшет писал `POST /api/states/sensor.bms_intercom_<id>` с ключом
интеркома в атрибутах. Это требовало прав администратора (у привязанного
планшета их нет) и показывало ключ любому пользователю HA и recorder'у.
Теперь ключ живёт только в памяти интеграции и отдаётся лишь планшетам.

КОНТРАКТ (клиент Android пишется строго по нему)
------------------------------------------------
Доступ к обоим адресам: заголовок `Authorization: Bearer <token>`; пускаем
администратора HA или пользователя привязанного (не отозванного) планшета,
остальным 403. HTTP 404 на эти адреса = старая интеграция, клиент
откатывается на /api/states.

POST /api/bms_tablet/intercom/publish
  Content-Type: application/json, тело не больше 8 KiB. JSON-объект:
    {
      "device_id":    str, ^[A-Za-z0-9_-]{1,64}$            (обязательно)
      "device_name":  str, 1..80                              (обязательно)
      "ip":           str, IPv4/IPv6 адрес                    (обязательно)
      "port":         int, 1..65535                           (обязательно)
      "key":          str, 1..256                             (обязательно)
      "friendly_name":str, до 255   (необязательно)
      "icon":         str, до 255   (необязательно)
      "bms_intercom": bool          (необязательно, по умолчанию true)
      "app_version":  str, до 64    (необязательно)
      "heartbeat":    int, epoch сек часов планшета (необязательно, не доверяем)
    }
  Неизвестные ключи молча отбрасываются.
  `"bms_intercom": false` — снять планшет из справочника (тогда обязателен
  только device_id): запись удаляется, состояние сущности становится offline.
  Ответ 200: {"ok": true}
  Ошибки: 400 {"error": "invalid_request"|"json_required"}, 403 {"error": "forbidden"},
  409 {"error": "device_owned"} (device_id уже публикует другой планшет),
  413 {"error": "request_too_large"}, 429 {"error": "directory_full"},
  503 {"error": "not_loaded"}.
  Побочно: состояние `sensor.bms_intercom_<device_id в нижнем регистре, "-"→"_">`
  = "online" с теми же атрибутами, НО БЕЗ "key" (для старых автоматизаций);
  heartbeat в атрибутах — время сервера.

POST /api/bms_tablet/intercom/unpublish
  Тело (JSON, до 8 KiB): {"device_id": str ^[A-Za-z0-9_-]{1,64}$}
  Убирает планшет из справочника и удаляет состояние sensor.bms_intercom_<id>.
  Ответ 200: {"ok": true} (и когда записи уже не было). Ошибки — как у publish
  (403, 400, 409 если запись принадлежит другому планшету, 503).

GET /api/bms_tablet/intercom/peers
  Ответ 200: {"peers": [ {"device_id", "device_name", "ip", "port", "key",
    "friendly_name", "icon", "bms_intercom", "app_version", "heartbeat"} ]}
  heartbeat здесь — epoch сек ВРЕМЕНИ СЕРВЕРА, когда пришла последняя публикация.
  Записи старше 10 минут не отдаются. Сам запрашивающий в списке тоже есть —
  клиент отфильтровывает себя по device_id.
"""
from __future__ import annotations

import asyncio
import ipaddress
import json
import re
import time

from aiohttp import web
from homeassistant.components.http import HomeAssistantView

from .const import DOMAIN

DEVICE_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
MAX_BODY = 8192
STALE_SEC = 600
MAX_PEERS = 256
HEADERS = {"Cache-Control": "no-store"}


class IntercomError(Exception):
    def __init__(self, status: int, code: str) -> None:
        super().__init__(code)
        self.status = status
        self.code = code


def _text(data: dict, key: str, low: int, high: int, required: bool = False):
    value = data.get(key)
    if value is None and not required:
        return None
    if not isinstance(value, str) or not low <= len(value) <= high:
        raise IntercomError(400, "invalid_request")
    return value


def validate_publish(data) -> dict:
    """Проверенная запись справочника (с ключом) или IntercomError."""
    if not isinstance(data, dict):
        raise IntercomError(400, "invalid_request")
    device_id = _text(data, "device_id", 1, 64, True)
    if not DEVICE_ID.fullmatch(device_id):
        raise IntercomError(400, "invalid_request")
    active = data.get("bms_intercom", True)
    if not isinstance(active, bool):
        raise IntercomError(400, "invalid_request")
    if not active:
        return {"device_id": device_id, "bms_intercom": False}
    ip = _text(data, "ip", 2, 45, True)
    try:
        ipaddress.ip_address(ip)
    except ValueError as err:
        raise IntercomError(400, "invalid_request") from err
    port = data.get("port")
    if isinstance(port, bool) or not isinstance(port, int) or not 1 <= port <= 65535:
        raise IntercomError(400, "invalid_request")
    heartbeat = data.get("heartbeat")
    if heartbeat is not None and (isinstance(heartbeat, bool) or not isinstance(heartbeat, int)):
        raise IntercomError(400, "invalid_request")
    device_name = _text(data, "device_name", 1, 80, True)
    return {
        "device_id": device_id,
        "device_name": device_name,
        "ip": ip,
        "port": port,
        "key": _text(data, "key", 1, 256, True),
        "friendly_name": _text(data, "friendly_name", 0, 255) or f"Интерком: {device_name}",
        "icon": _text(data, "icon", 0, 255) or "mdi:deskphone",
        "bms_intercom": True,
        "app_version": _text(data, "app_version", 0, 64) or "",
    }


def entity_id(device_id: str) -> str:
    return "sensor.bms_intercom_" + device_id.lower().replace("-", "_")


class IntercomDirectory:
    """Планшеты в памяти: device_id -> запись, владелец и время получения."""

    def __init__(self) -> None:
        self.peers: dict[str, dict] = {}

    def prune(self, now: float) -> None:
        for device_id in [k for k, v in self.peers.items() if now - v["received"] > STALE_SEC]:
            del self.peers[device_id]

    def publish(self, record: dict, user_id: str, is_admin: bool, now: float) -> None:
        self.prune(now)
        device_id = record["device_id"]
        current = self.peers.get(device_id)
        # Чужой планшет не может переписать адрес и ключ другого — только админ.
        if current is not None and current["owner"] != user_id and not is_admin:
            raise IntercomError(409, "device_owned")
        if not record["bms_intercom"]:
            self.peers.pop(device_id, None)
            return
        if current is None and len(self.peers) >= MAX_PEERS:
            raise IntercomError(429, "directory_full")
        owner = current["owner"] if current is not None and is_admin else user_id
        self.peers[device_id] = {"record": record, "owner": owner, "received": now}

    def listing(self, now: float) -> list[dict]:
        self.prune(now)
        return [
            dict(v["record"], heartbeat=int(v["received"]))
            for v in sorted(self.peers.values(), key=lambda v: v["record"]["device_id"])
        ]


def _context(hass) -> tuple:
    data = hass.data.get(DOMAIN) or {}
    if data.get("store") is None or data.get("intercom") is None:
        raise IntercomError(503, "not_loaded")
    return data["intercom"], data.get("pairing")


def _authorize(request, pairing) -> tuple:
    """Админ HA или пользователь привязанного планшета."""
    user = request.get("hass_user")
    if user is None:
        raise IntercomError(403, "forbidden")
    if user.is_admin:
        return user, True
    if pairing is not None and pairing.device_for_user(user.id):
        pairing.mark_seen(user.id)
        return user, False
    raise IntercomError(403, "forbidden")


async def _read_json(request: web.Request):
    if request.content_type != "application/json":
        raise IntercomError(400, "json_required")
    try:
        async with asyncio.timeout(10):
            body = bytearray()
            async for chunk in request.content.iter_chunked(4096):
                body.extend(chunk)
                if len(body) > MAX_BODY:
                    raise IntercomError(413, "request_too_large")
        return json.loads(body)
    except (ValueError, RecursionError, TimeoutError) as err:
        raise IntercomError(400, "invalid_request") from err


def _error(error: IntercomError) -> web.Response:
    return web.json_response({"error": error.code}, status=error.status, headers=HEADERS)


class IntercomPublishView(HomeAssistantView):
    url = "/api/bms_tablet/intercom/publish"
    name = "api:bms_tablet:intercom_publish"
    requires_auth = True

    def __init__(self, hass) -> None:
        self.hass = hass

    async def post(self, request: web.Request) -> web.Response:
        try:
            directory, pairing = _context(self.hass)
            user, is_admin = _authorize(request, pairing)
            record = validate_publish(await _read_json(request))
            directory.publish(record, user.id, is_admin, time.time())
        except IntercomError as error:
            return _error(error)
        # heartbeat меняется на каждой публикации, как и раньше: иначе
        # last_updated сущности застывает и живой планшет выглядит пропавшим.
        public = {k: v for k, v in record.items() if k != "key"}
        public["heartbeat"] = int(time.time())
        state = "online" if record["bms_intercom"] else "offline"
        self.hass.states.async_set(entity_id(record["device_id"]), state, public)
        return web.json_response({"ok": True}, headers=HEADERS)


class IntercomUnpublishView(HomeAssistantView):
    url = "/api/bms_tablet/intercom/unpublish"
    name = "api:bms_tablet:intercom_unpublish"
    requires_auth = True

    def __init__(self, hass) -> None:
        self.hass = hass

    async def post(self, request: web.Request) -> web.Response:
        try:
            directory, pairing = _context(self.hass)
            user, is_admin = _authorize(request, pairing)
            data = await _read_json(request)
            if not isinstance(data, dict):
                raise IntercomError(400, "invalid_request")
            device_id = _text(data, "device_id", 1, 64, True)
            if not DEVICE_ID.fullmatch(device_id):
                raise IntercomError(400, "invalid_request")
            directory.publish({"device_id": device_id, "bms_intercom": False}, user.id, is_admin, time.time())
        except IntercomError as error:
            return _error(error)
        self.hass.states.async_remove(entity_id(device_id))
        return web.json_response({"ok": True}, headers=HEADERS)


class IntercomPeersView(HomeAssistantView):
    url = "/api/bms_tablet/intercom/peers"
    name = "api:bms_tablet:intercom_peers"
    requires_auth = True

    def __init__(self, hass) -> None:
        self.hass = hass

    async def get(self, request: web.Request) -> web.Response:
        try:
            directory, pairing = _context(self.hass)
            _authorize(request, pairing)
        except IntercomError as error:
            return _error(error)
        return web.json_response({"peers": directory.listing(time.time())}, headers=HEADERS)
