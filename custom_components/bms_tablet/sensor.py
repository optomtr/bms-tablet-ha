"""Сенсор с конфигурацией дома.

Приложение читает `sensor.bms_tablet_home`: состояние — номер ревизии конфига
(поменялся — значит есть что перечитать), атрибуты — сам конфиг.

Сенсор один, потому что и конфигурация одна на дом. Раньше их было по одному
на каждый заведённый планшет, и одинаковых сенсоров с разными именами
набиралось столько, сколько раз нажали «Добавить планшет».
"""

from __future__ import annotations

import logging
from copy import deepcopy
from typing import Any

from homeassistant.components.sensor import SensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import EVENT_STATE_CHANGED, MATCH_ALL
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers.dispatcher import async_dispatcher_connect
from homeassistant.helpers.event import async_call_later
from homeassistant.helpers.entity import DeviceInfo
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.start import async_at_started

from .const import (
    DOMAIN,
    HOME_ID,
    PANEL_URL_PATH,
    SENSOR_ENTITY_ID,
    SIGNAL_CONFIG_CHANGED,
)
from .discovery import SUPPORTED_DOMAINS, async_doorstation_payload, async_room_payload
from .store import BmsTabletStore, get_store

_LOGGER = logging.getLogger(__name__)

# Реестры Home Assistant. Названия событий берём строками, а не константами:
# константы за версии HA переезжали между модулями, а сами события — нет.
REGISTRY_EVENTS = (
    "area_registry_updated",
    "floor_registry_updated",
    "entity_registry_updated",
    "device_registry_updated",
)

# Одно действие в HA — «перенести устройство в комнату» — даёт пачку событий
# реестра подряд. Пересобирать конфиг на каждое незачем.
REGISTRY_DEBOUNCE = 2.0

# После старта HA Tuya/Zigbee поднимают свои сущности позже нас: без их
# состояний пропадают имена, роли и добавленные руками устройства. Поэтому
# конфиг переписывается ещё раз после старта и спустя эти секунды.
STARTUP_REWRITES = (30.0, 120.0)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    store = get_store(hass)
    _async_drop_legacy_entities(hass, entry)
    async_add_entities([BmsTabletSensor(store)])


@callback
def _async_drop_legacy_entities(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Убрать сенсоры планшетов, заведённых до перехода на один конфиг.

    Без этого они остались бы в реестре навсегда — недоступные, но видимые, и
    приложение, ищущее сенсор по префиксу `sensor.bms_tablet_`, могло бы взять
    как раз такой.
    """
    registry = er.async_get(hass)
    keep = f"{DOMAIN}_{HOME_ID}"
    stale = [
        entity.entity_id
        for entity in er.async_entries_for_config_entry(registry, entry.entry_id)
        if entity.unique_id != keep
    ]
    for entity_id in stale:
        _LOGGER.info("Убираем сенсор от прежней схемы с планшетами: %s", entity_id)
        registry.async_remove(entity_id)

    # Устройство на каждый планшет заводилось своё. Пустые остались бы висеть
    # в списке устройств Home Assistant.
    devices = dr.async_get(hass)
    for device in dr.async_entries_for_config_entry(devices, entry.entry_id):
        if (DOMAIN, HOME_ID) in device.identifiers:
            continue
        _LOGGER.info("Убираем устройство от прежней схемы: %s", device.name)
        devices.async_remove_device(device.id)


class BmsTabletSensor(SensorEntity):
    """Конфигурация дома, которую читает планшет."""

    _attr_should_poll = False
    _attr_icon = "mdi:tablet-dashboard"
    _attr_has_entity_name = False
    _attr_name = "BMS Планшет"
    # Конфиг целиком в атрибутах: в истории он только раздувает базу recorder.
    _unrecorded_attributes = frozenset({MATCH_ALL})

    def __init__(self, store: BmsTabletStore) -> None:
        self._store = store
        self._pending_registry = None
        self._startup_timers: list = []
        self._attr_unique_id = f"{DOMAIN}_{HOME_ID}"
        # entity_id фиксируем явно: иначе HA слепит его из названия, а
        # приложение ищет сенсор по префиксу `sensor.bms_tablet_`.
        self.entity_id = SENSOR_ENTITY_ID
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, HOME_ID)},
            name="BMS Планшет",
            manufacturer="BMS Smart",
            model="BMS Smart Tablet",
            configuration_url=f"homeassistant://{PANEL_URL_PATH}",
        )

    async def async_added_to_hass(self) -> None:
        self.async_on_remove(
            async_dispatcher_connect(
                self.hass, SIGNAL_CONFIG_CHANGED, self._handle_config_changed
            )
        )
        # Комнаты берутся из зон Home Assistant, а не только из наших правок:
        # завели зону, перенесли в неё устройство, переименовали — планшет
        # должен увидеть это сам. Без подписки на реестры новая комната ждала
        # бы первой правки в редакторе или перезапуска HA.
        for event in REGISTRY_EVENTS:
            self.async_on_remove(
                self.hass.bus.async_listen(event, self._handle_registry_changed)
            )
        # Новая сущность поддерживаемого домена появилась в машине состояний —
        # обычно это интеграция, догрузившаяся после нас. Тот же дебаунс.
        self.async_on_remove(
            self.hass.bus.async_listen(
                EVENT_STATE_CHANGED,
                self._handle_registry_changed,
                event_filter=_is_new_supported_state,
            )
        )
        self.async_on_remove(self._cancel_pending_registry)
        self.async_on_remove(async_at_started(self.hass, self._handle_started))
        self.async_on_remove(self._cancel_startup_timers)

    @callback
    def _handle_started(self, _hass) -> None:
        self.async_write_ha_state()
        self._cancel_startup_timers()
        self._startup_timers = [
            async_call_later(self.hass, delay, self._rewrite)
            for delay in STARTUP_REWRITES
        ]

    @callback
    def _rewrite(self, _now) -> None:
        self.async_write_ha_state()

    @callback
    def _cancel_startup_timers(self) -> None:
        for cancel in self._startup_timers:
            cancel()
        self._startup_timers = []

    @callback
    def _handle_config_changed(self) -> None:
        self.async_write_ha_state()

    @callback
    def _handle_registry_changed(self, _event) -> None:
        self._cancel_pending_registry()
        self._pending_registry = async_call_later(
            self.hass, REGISTRY_DEBOUNCE, self._flush_registry
        )

    @callback
    def _flush_registry(self, _now) -> None:
        self._pending_registry = None
        # Если состав комнат не поменялся, Home Assistant сравнит атрибуты и
        # события не пошлёт — планшет зря дёргать не будем.
        self.async_write_ha_state()

    @callback
    def _cancel_pending_registry(self) -> None:
        if self._pending_registry is not None:
            self._pending_registry()
            self._pending_registry = None

    @property
    def native_value(self) -> int:
        return int(self._store.home().get("revision", 0))

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        home = self._store.home()
        backgrounds = self._store.backgrounds()
        # Домофона на объекте может не быть — тогда ключа нет вовсе. Планшет
        # прежней версии читает конфиг как читал, а новый видит отсутствие
        # ключа как «домофон не заведён», не отличая его от старой интеграции.
        doorstation = async_doorstation_payload(home)
        # Только копии: HA сравнивает новые атрибуты со старыми, и живой словарь
        # хранилища, изменённый на месте, совпал бы сам с собой — state_changed
        # не ушёл бы, и планшет не увидел бы новое фото или кадрирование.
        return deepcopy({
            # tablet_id оставлен ради приложений прошлых версий: они читают
            # его первым делом и без него считают конфиг непригодным.
            "tablet_id": HOME_ID,
            "tablet_name": home.get("name"),
            "revision": home.get("revision", 0),
            "start_area": home.get("start_area"),
            "ambient": home.get("ambient") or {},
            "rooms": async_room_payload(self.hass, home, backgrounds),
            "backgrounds": backgrounds,
            **({"doorstation": doorstation} if doorstation else {}),
        })


@callback
def _is_new_supported_state(event_data) -> bool:
    return (
        event_data.get("old_state") is None
        and event_data.get("new_state") is not None
        and event_data["entity_id"].split(".", 1)[0] in SUPPORTED_DOMAINS
    )
