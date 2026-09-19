"""Интеграция BMS Tablet.

Комнаты планшет собирает сам из area_registry — эта интеграция нужна для того,
что в приложении жить не может: фото комнат, порядок и видимость комнат,
исключения для ошибок автоопределения и настройки объекта.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path

import voluptuous as vol
from homeassistant.components import frontend, panel_custom
from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant, ServiceCall
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.service import async_register_admin_service

from . import websocket_api
from .const import (
    BACKGROUND_URL_PATH,
    DOMAIN,
    PANEL_COMPONENT,
    PANEL_ICON,
    PANEL_STATIC_PATH,
    PANEL_TITLE,
    PANEL_URL_PATH,
)
from .http import BackgroundUploadView, BackgroundImageView, background_dir
from .store import BmsTabletStore, get_store
from .pairing import PairingManager
from .pairing_http import PairingView
from .intercom_http import (
    IntercomDirectory,
    IntercomPeersView,
    IntercomPublishView,
    IntercomUnpublishView,
)

_LOGGER = logging.getLogger(__name__)

PLATFORMS = [Platform.SENSOR]

SERVICE_UPDATE_CONFIG = "update_config"
SERVICE_RESET_CONFIG = "reset_config"


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    store = BmsTabletStore(hass)
    await store.async_load()
    if store.migrated_from_tablets:
        _LOGGER.info(
            "Список планшетов свёрнут в одну конфигурацию дома: %s. "
            "Комнаты и правки сохранены, лишние сенсоры убраны.",
            store.home().get("name"),
        )
    await _async_read_version(hass)
    await _async_register_static(hass)
    hass.data.setdefault(DOMAIN, {})["store"] = store

    if not hass.data[DOMAIN].get("pairing"):
        pairing = PairingManager(hass)
        await pairing.load()
        hass.data[DOMAIN]["pairing"] = pairing
    if not hass.data[DOMAIN].get("pairing_view_registered"):
        hass.http.register_view(PairingView(hass))
        hass.data[DOMAIN]["pairing_view_registered"] = True
    # Справочник интеркома живёт в памяти весь запуск HA: переживает
    # перезагрузку интеграции, планшеты всё равно обновляются раз в минуту.
    hass.data[DOMAIN].setdefault("intercom", IntercomDirectory())
    if not hass.data[DOMAIN].get("intercom_views_registered"):
        hass.http.register_view(IntercomPublishView(hass))
        hass.http.register_view(IntercomPeersView(hass))
        hass.http.register_view(IntercomUnpublishView(hass))
        hass.data[DOMAIN]["intercom_views_registered"] = True

    await _async_register_panel(hass)

    websocket_api.async_register(hass)
    # Маршрут регистрируется один раз за запуск HA: повторная регистрация того же
    # пути при перезагрузке интеграции падает.
    if not hass.data[DOMAIN].get("view_registered"):
        hass.http.register_view(BackgroundUploadView(hass, store))
        hass.http.register_view(BackgroundImageView(hass))
        hass.data[DOMAIN]["view_registered"] = True

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    _async_register_services(hass, store)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    unloaded = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unloaded:
        frontend.async_remove_panel(hass, PANEL_URL_PATH)
        # Статику и маршрут снять нельзя, поэтому их флаги оставляем —
        # иначе повторная установка попробует зарегистрировать их снова.
        hass.data.get(DOMAIN, {}).pop("store", None)
        hass.data.get(DOMAIN, {}).pop("pairing", None)
        # Сервисы снимаются вместе с интеграцией: иначе вызов после выгрузки
        # падал бы на отсутствующем хранилище.
        hass.services.async_remove(DOMAIN, SERVICE_UPDATE_CONFIG)
        hass.services.async_remove(DOMAIN, SERVICE_RESET_CONFIG)
    return unloaded


async def _async_read_version(hass: HomeAssistant) -> str:
    """Версия из manifest.json — она попадает в адрес редактора и в его шапку.

    Читается один раз за запуск: файл маленький, но лезть на диск из цикла
    событий на каждый запрос незачем.
    """
    data = hass.data.setdefault(DOMAIN, {})
    if data.get("version"):
        return data["version"]

    manifest = Path(__file__).parent / "manifest.json"

    def _read() -> str:
        try:
            return json.loads(manifest.read_text(encoding="utf-8")).get("version", "")
        except (OSError, ValueError):
            return ""

    data["version"] = await hass.async_add_executor_job(_read)
    return data["version"]


def _editor_url(hass: HomeAssistant) -> str:
    """Адрес редактора с версией.

    Версия в адресе не украшение: без неё браузер и service worker Home
    Assistant держат старый editor.js после обновления интеграции, и панель
    выглядит ровно так же, как до него. Меняется версия — меняется адрес,
    и старый файл больше не подходит.
    """
    version = hass.data.get(DOMAIN, {}).get("version") or "dev"
    return f"{PANEL_STATIC_PATH}/editor.js?v={version}"


async def _async_register_static(hass: HomeAssistant) -> None:
    if hass.data.setdefault(DOMAIN, {}).get("static_registered"):
        return
    panel_dir = Path(__file__).parent / "panel"
    photos = background_dir(hass)
    await hass.async_add_executor_job(lambda: photos.mkdir(parents=True, exist_ok=True))
    await hass.http.async_register_static_paths(
        [
            # Редактор кэшировать нельзя — иначе после обновления интеграции
            # в браузере останется старая версия.
            StaticPathConfig(PANEL_STATIC_PATH, str(panel_dir), False),
        ]
    )
    hass.data[DOMAIN]["static_registered"] = True


async def _async_register_panel(hass: HomeAssistant) -> None:
    module_url = _editor_url(hass)
    existing = hass.data.get("frontend_panels", {}).get(PANEL_URL_PATH)
    if existing is not None:
        # Панель уже зарегистрирована. Если адрес редактора тот же — оставляем
        # как есть; если версия сменилась, перерегистрируем, иначе после
        # «Перезагрузить интеграцию» в браузер уехал бы старый редактор.
        config = getattr(existing, "config", None)
        custom = config.get("_panel_custom") if isinstance(config, dict) else None
        current = custom.get("module_url") if isinstance(custom, dict) else None
        if current == module_url:
            return
        # Форма конфигурации панели у Home Assistant могла измениться — тогда
        # current будет None и мы перерегистрируем панель зря. Это безобидно,
        # в отличие от обратного: молча оставить старый редактор.
        frontend.async_remove_panel(hass, PANEL_URL_PATH)

    await panel_custom.async_register_panel(
        hass,
        frontend_url_path=PANEL_URL_PATH,
        webcomponent_name=PANEL_COMPONENT,
        module_url=module_url,
        sidebar_title=PANEL_TITLE,
        sidebar_icon=PANEL_ICON,
        require_admin=True,
        config={},
    )


def _async_register_services(hass: HomeAssistant, store: BmsTabletStore) -> None:
    async def update_config(call: ServiceCall) -> None:
        await get_store(hass).async_update_home(call.data["patch"])

    async def reset_config(call: ServiceCall) -> None:
        await get_store(hass).async_reset_home()

    async_register_admin_service(
        hass, DOMAIN,
        SERVICE_UPDATE_CONFIG,
        update_config,
        schema=vol.Schema({vol.Required("patch"): dict}),
    )
    async_register_admin_service(
        hass, DOMAIN,
        SERVICE_RESET_CONFIG,
        reset_config,
        schema=vol.Schema({}),
    )
