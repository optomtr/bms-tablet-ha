"""WebSocket-команды для редактора в боковой панели."""

from __future__ import annotations

from functools import wraps
from typing import Any

import voluptuous as vol
from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant, callback
from homeassistant.exceptions import HomeAssistantError

from .const import DEVICE_ROLES, DOMAIN, HOME_ID, SENSOR_ENTITY_ID
from .icon_catalog import ICONS
from .discovery import async_collect_areas, async_entity_catalog, async_room_payload
from .store import NotLoaded, get_store

AREA_ID = vol.Match(r"^[\w-]{1,128}$")


def _loaded(handler):
    """Команды нельзя снять при выгрузке: без хранилища отвечаем not_loaded."""

    @wraps(handler)
    def wrapped(hass, connection, msg):
        if (hass.data.get(DOMAIN) or {}).get("store") is None:
            connection.send_error(msg["id"], "not_loaded", "Интеграция не загружена")
            return None
        return handler(hass, connection, msg)

    return wrapped


async def _write(connection, msg, job) -> bool:
    """Выполнить запись; ошибку проверки или диска вернуть редактору словами."""
    try:
        await job
    except ValueError as err:
        connection.send_error(msg["id"], "invalid_format", str(err))
        return False
    except NotLoaded:
        connection.send_error(msg["id"], "not_loaded", "Интеграция не загружена")
        return False
    except (HomeAssistantError, OSError) as err:
        connection.send_error(msg["id"], "write_failed", f"Не удалось сохранить на диск: {err}")
        return False
    return True


@callback
def async_register(hass: HomeAssistant) -> None:
    websocket_api.async_register_command(hass, ws_pairing)
    websocket_api.async_register_command(hass, ws_config)
    websocket_api.async_register_command(hass, ws_areas)
    websocket_api.async_register_command(hass, ws_update_home)
    websocket_api.async_register_command(hass, ws_reset_home)
    websocket_api.async_register_command(hass, ws_set_background)
    websocket_api.async_register_command(hass, ws_remove_background)
    websocket_api.async_register_command(hass, ws_preview)
    websocket_api.async_register_command(hass, ws_list_tablets)


def _payload(hass: HomeAssistant) -> dict[str, Any]:
    store = get_store(hass)
    pairing = hass.data.get(DOMAIN, {}).get("pairing")
    return {
        "home": store.home(),
        "backgrounds": store.backgrounds(),
        "roles": list(DEVICE_ROLES),
        "icons": ICONS,
        "paired_devices": pairing.listing() if pairing else [],
        "entity_id": SENSOR_ENTITY_ID,
        # Версия видна в шапке редактора: вопрос «обновилось или нет» должен
        # решаться взглядом на экран, а не проверкой файлов на диске.
        "version": hass.data.get(DOMAIN, {}).get("version", ""),
    }


@_loaded
@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/list_tablets"})
@callback
def ws_list_tablets(hass: HomeAssistant, connection, msg: dict[str, Any]) -> None:
    """Опрос со стороны планшета.

    Планшет подписан на state_changed своего сенсора, но подписка может
    отвалиться незаметно — опрос это ловит.

    Прав администратора не требует: планшет заходит обычным токеном. Отдаёт
    список из одного элемента: конфигурация на дом одна, а список сохранён
    ради приложений, выпущенных до этого перехода.
    """
    store = get_store(hass)
    home = store.home()
    backgrounds = store.backgrounds()
    connection.send_result(
        msg["id"],
        [
            {
                "tablet_id": HOME_ID,
                "name": home.get("name"),
                "revision": home.get("revision", 0),
                "start_area": home.get("start_area"),
                "ambient": home.get("ambient") or {},
                "rooms": async_room_payload(hass, home, backgrounds),
                "backgrounds": backgrounds,
            }
        ],
    )


@_loaded
@websocket_api.require_admin
@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/config"})
@callback
def ws_config(hass: HomeAssistant, connection, msg: dict[str, Any]) -> None:
    connection.send_result(msg["id"], _payload(hass))


@websocket_api.require_admin
@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/areas"})
@callback
def ws_areas(hass: HomeAssistant, connection, msg: dict[str, Any]) -> None:
    connection.send_result(
        msg["id"],
        {
            "areas": async_collect_areas(hass),
            "catalog": async_entity_catalog(hass),
        },
    )


@_loaded
@websocket_api.require_admin
@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/preview"})
@callback
def ws_preview(hass: HomeAssistant, connection, msg: dict[str, Any]) -> None:
    """Что реально уедет на планшет после всех правок монтажника."""
    store = get_store(hass)
    connection.send_result(
        msg["id"],
        {"rooms": async_room_payload(hass, store.home(), store.backgrounds())},
    )


@_loaded
@websocket_api.require_admin
@websocket_api.websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/home/update",
        vol.Required("patch"): dict,
        # merge=True — точечные правки (словари по ключу, списки add/remove).
        # Без него — прежняя полная замена ключей комнаты: старый редактор
        # из кэша браузера продолжает работать.
        vol.Optional("merge", default=False): bool,
    }
)
@websocket_api.async_response
async def ws_update_home(hass: HomeAssistant, connection, msg: dict[str, Any]) -> None:
    if await _write(connection, msg, get_store(hass).async_update_home(msg["patch"], msg["merge"])):
        connection.send_result(msg["id"], _payload(hass))


@_loaded
@websocket_api.require_admin
@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/home/reset"})
@websocket_api.async_response
async def ws_reset_home(hass: HomeAssistant, connection, msg: dict[str, Any]) -> None:
    if await _write(connection, msg, get_store(hass).async_reset_home()):
        connection.send_result(msg["id"], _payload(hass))


@_loaded
@websocket_api.require_admin
@websocket_api.websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/background/set",
        vol.Required("area_id"): AREA_ID,
        vol.Optional("dim"): vol.Coerce(float),
        vol.Optional("blur"): vol.Coerce(float),
        vol.Optional("transform"): dict,
    }
)
@websocket_api.async_response
async def ws_set_background(hass: HomeAssistant, connection, msg: dict[str, Any]) -> None:
    job = get_store(hass).async_set_background(
        msg["area_id"],
        dim=msg.get("dim"),
        blur=msg.get("blur"),
        transform=msg.get("transform"),
    )
    if await _write(connection, msg, job):
        connection.send_result(msg["id"], _payload(hass))


@_loaded
@websocket_api.require_admin
@websocket_api.websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/background/remove",
        vol.Required("area_id"): AREA_ID,
    }
)
@websocket_api.async_response
async def ws_remove_background(
    hass: HomeAssistant, connection, msg: dict[str, Any]
) -> None:
    from .http import background_dir, remove_background_files

    store = get_store(hass)
    old_url = (store.backgrounds().get(msg["area_id"]) or {}).get("url")
    if not await _write(connection, msg, store.async_remove_background(msg["area_id"])):
        return
    # Файл удаляем так же, как DELETE по HTTP, иначе он остаётся на диске навсегда.
    await hass.async_add_executor_job(
        remove_background_files, background_dir(hass), msg["area_id"], old_url
    )
    connection.send_result(msg["id"], _payload(hass))


@websocket_api.websocket_command({vol.Required("type"): "bms_tablet/pairing", vol.Required("action"): vol.In(["list","approve","revoke"]), vol.Optional("code"): str, vol.Optional("device_id"): str})
@websocket_api.require_admin
@websocket_api.async_response
async def ws_pairing(hass, connection, msg):
    from .pairing import PairError
    manager=hass.data.get(DOMAIN,{}).get("pairing")
    if manager is None:
        connection.send_error(msg["id"],"unavailable","Интеграция не загружена"); return
    try:
        if msg["action"]=="list": result={"devices":manager.listing()}
        elif msg["action"]=="approve": result=await manager.approve(msg.get("code"),connection.user.id)
        else: result=await manager.revoke(msg.get("device_id"),connection.user.id)
        connection.send_result(msg["id"],result)
    except PairError as error: connection.send_error(msg["id"],error.code,"Не удалось выполнить действие привязки")
