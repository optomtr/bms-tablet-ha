"""Хранилище конфигурации объекта.

Один объект — один файл `.storage/bms_tablet.config`. Внутри два раздела:

* `home`        — настройки дома: комнаты, их порядок, правки автоопределения;
* `backgrounds` — фото комнат.

Конфигурация одна на дом, а не одна на планшет. Планшет в квартире обычно
один, а если их два — комнаты у них всё равно те же самые. Список планшетов,
который здесь был раньше, ничего не давал: приходилось помнить, какую из
одинаковых конфигураций правишь и какую читает планшет.

Фон вынесен отдельным разделом намеренно: фотография принадлежит комнате.
"""

from __future__ import annotations

from typing import Any
import asyncio
import logging
from copy import deepcopy
from functools import wraps
from .validation import background_key, validate_home_patch, number

from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.dispatcher import async_dispatcher_send

from .persist import StrictStore
from .const import (
    DEFAULT_AMBIENT,
    DEFAULT_BLUR,
    DEFAULT_DIM,
    DOMAIN,
    HOME_ID,
    SIGNAL_CONFIG_CHANGED,
    STORAGE_KEY,
    STORAGE_VERSION,
)

_LOGGER = logging.getLogger(__name__)


def default_home(name: str | None = None) -> dict[str, Any]:
    return {
        "id": HOME_ID,
        "name": name or "Мой дом",
        "start_area": None,
        "ambient": dict(DEFAULT_AMBIENT),
        # area_id -> {visible, order, exclude: [entity_id], roles: {entity_id: role}}
        "rooms": {},
        "revision": 1,
    }


def default_background() -> dict[str, Any]:
    return {
        "url": None,
        "version": 0,
        "dim": DEFAULT_DIM,
        "blur": DEFAULT_BLUR,
        "transform": {"zoom": 1.0, "dx": 0.0, "dy": 0.0},
    }


def _migrate(data: dict[str, Any] | None) -> dict[str, Any]:
    """Привести к нынешней форме, что бы ни лежало на диске.

    Со старых версий приходит `tablets` — словарь конфигураций. Оставляем ту,
    в которую больше вложено: у неё выше номер ревизии. Выбирать за монтажника
    неприятно, но альтернатива хуже — заставить его вручную сливать две
    одинаковые конфигурации, из которых планшет всё равно читал одну.
    """
    if not isinstance(data, dict):
        return {"home": default_home(), "backgrounds": {}}

    backgrounds = data.get("backgrounds") or {}

    home = data.get("home")
    if isinstance(home, dict) and home:
        home.setdefault("id", HOME_ID)
        return {"home": home, "backgrounds": backgrounds}

    tablets = data.get("tablets") or {}
    if isinstance(tablets, dict) and tablets:
        winner = max(
            tablets.items(),
            key=lambda item: (int((item[1] or {}).get("revision", 0)), item[0]),
        )[1]
        home = dict(winner or {})
        home["id"] = HOME_ID
        home.pop("kiosk", None)  # режим киоска включается на самом планшете
        return {"home": home, "backgrounds": backgrounds}

    return {"home": default_home(), "backgrounds": backgrounds}


MAP_KEYS = ("roles", "entity_names", "cover_directions", "entity_icons", "entity_zones")
LIST_KEYS = ("exclude", "include")


def merge_room(room: dict[str, Any], patch: dict[str, Any]) -> None:
    """Точечная правка комнаты: словари сливаются по ключу, списки — add/remove.

    Редактор шлёт только то, что поменял человек, поэтому две быстрые правки
    разных устройств не затирают друг друга устаревшей копией словаря.
    """
    for key, value in patch.items():
        if key in MAP_KEYS and isinstance(value, dict):
            current = dict(room.get(key) or {})
            for entity, label in value.items():
                if label is None:
                    current.pop(entity, None)
                else:
                    current[entity] = label
            if len(current) > 2000:
                raise ValueError("Некорректные параметры устройств")
            room[key] = current
        elif key in LIST_KEYS and isinstance(value, dict):
            remove = set(value.get("remove") or [])
            current = [item for item in room.get(key) or [] if item not in remove]
            for item in value.get("add") or []:
                if item not in current:
                    current.append(item)
            if len(current) > 2000:
                raise ValueError("Некорректный список устройств")
            room[key] = current
        else:
            room[key] = value


def transaction(method):
    @wraps(method)
    async def wrapped(self, *args, **kwargs):
        async with self._lock:
            before=deepcopy(self._data)
            try:
                return await method(self,*args,**kwargs)
            except BaseException:
                self._data=before
                raise
    return wrapped


class BmsTabletStore:
    """Тонкая обёртка над Store с уведомлением слушателей об изменениях."""

    def __init__(self, hass: HomeAssistant) -> None:
        self._hass = hass
        self._lock = asyncio.Lock()
        # Атомарная запись с ошибкой наверх: иначе откат в transaction мнимый.
        self._store = StrictStore(hass, STORAGE_VERSION, STORAGE_KEY)
        self._data: dict[str, Any] = {"home": default_home(), "backgrounds": {}}
        self._migrated = False

    # ------------------------------------------------------------- загрузка

    async def async_load(self) -> None:
        raw = await self._store.async_load()
        self._data = _migrate(raw)
        for bg in self._data["backgrounds"].values():
            if isinstance(bg,dict) and isinstance(bg.get("url"),str) and bg["url"].startswith("/bms_tablet_bg/"):
                bg["url"]=bg["url"].replace("/bms_tablet_bg/","/api/bms_tablet/image/",1)
        # Если на диске лежала старая форма, сразу сохраняем новую: иначе
        # список планшетов так и остался бы в файле, а миграция повторялась
        # бы при каждом запуске.
        if isinstance(raw, dict) and "tablets" in raw:
            self._migrated = True
            try:
                await self._store.async_save(self._data)
            except Exception as err:  # noqa: BLE001 — старый файл прочитается снова
                _LOGGER.warning("Не удалось сохранить перенесённую конфигурацию: %s", err)

    @property
    def migrated_from_tablets(self) -> bool:
        """Был ли на диске список планшетов — чтобы сказать об этом в журнале."""
        return self._migrated

    async def _async_save(self) -> None:
        await self._store.async_save(self._data)
        async_dispatcher_send(self._hass, SIGNAL_CONFIG_CHANGED)

    # -------------------------------------------------------------- чтение

    @property
    def data(self) -> dict[str, Any]:
        return self._data

    @callback
    def home(self) -> dict[str, Any]:
        return self._data["home"]

    @callback
    def backgrounds(self) -> dict[str, dict[str, Any]]:
        return self._data["backgrounds"]

    # -------------------------------------------------------------- запись

    @transaction
    async def async_update_home(self, patch: dict[str, Any], merge: bool = False) -> dict[str, Any]:
        validate_home_patch(patch, merge)
        home = self._data["home"]

        for key in ("name", "start_area"):
            if key in patch:
                home[key] = patch[key]

        if "ambient" in patch and isinstance(patch["ambient"], dict):
            ambient = dict(DEFAULT_AMBIENT)
            ambient.update(home.get("ambient") or {})
            ambient.update(patch["ambient"])
            home["ambient"] = ambient

        if "rooms" in patch and isinstance(patch["rooms"], dict):
            rooms = home.setdefault("rooms", {})
            for area_id, room_patch in patch["rooms"].items():
                if room_patch is None:
                    rooms.pop(area_id, None)
                    continue
                room = rooms.setdefault(area_id, {})
                if merge:
                    merge_room(room, room_patch)
                else:
                    room.update(room_patch)

        home["revision"] = int(home.get("revision", 0)) + 1
        await self._async_save()
        return home

    @transaction
    async def async_reset_home(self) -> dict[str, Any]:
        """Сбросить правки комнат — вернуться к чистому автоопределению."""
        old = self._data["home"]
        fresh = default_home(old.get("name"))
        fresh["revision"] = int(old.get("revision", 0)) + 1
        self._data["home"] = fresh
        await self._async_save()
        return fresh

    @transaction
    async def async_set_background(
        self,
        area_id: str,
        *,
        url: str | None = None,
        bump_version: bool = False,
        dim: float | None = None,
        blur: float | None = None,
        transform: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        background_key(area_id)
        if dim is not None: number(dim,0,.9)
        if blur is not None: number(blur,0,1)
        if transform is not None:
            if not isinstance(transform,dict) or set(transform)-{"zoom","dx","dy"}: raise ValueError("Некорректное кадрирование")
            for key,value in transform.items(): number(value,.5 if key=="zoom" else -1,4 if key=="zoom" else 1)
        background = self._data["backgrounds"].setdefault(area_id, default_background())
        if url is not None:
            background["url"] = url
        if bump_version:
            background["version"] = int(background.get("version", 0)) + 1
        if dim is not None:
            background["dim"] = max(0.0, min(0.9, float(dim)))
        if blur is not None:
            background["blur"] = max(0.0, min(1.0, float(blur)))
        if transform is not None:
            merged = dict(background.get("transform") or {})
            merged.update(transform)
            background["transform"] = {
                "zoom": max(0.5, min(4.0, float(merged.get("zoom", 1.0)))),
                "dx": max(-1.0, min(1.0, float(merged.get("dx", 0.0)))),
                "dy": max(-1.0, min(1.0, float(merged.get("dy", 0.0)))),
            }
        # Без новой ревизии планшет не узнаёт о смене фото/кадрирования.
        self._bump_revision()
        await self._async_save()
        return background

    @transaction
    async def async_remove_background(self, area_id: str) -> None:
        self._data["backgrounds"].pop(area_id, None)
        self._bump_revision()
        await self._async_save()

    def _bump_revision(self) -> None:
        home = self._data["home"]
        home["revision"] = int(home.get("revision", 0)) + 1


class NotLoaded(Exception):
    """Интеграция выгружена, а маршрут/команда остались зарегистрированы."""


@callback
def get_store(hass: HomeAssistant) -> BmsTabletStore:
    store = (hass.data.get(DOMAIN) or {}).get("store")
    if store is None:
        raise NotLoaded("Интеграция не загружена")
    return store
