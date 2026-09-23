"""Автосборка комнат из реестров Home Assistant.

Это серверная половина того же правила, по которому живёт приложение: комната —
это Area, устройства комнаты — её сущности, разложенные по ролям. Никакой ручной
расстановки; монтажник только снимает галочки с лишнего.

Списки слов ниже должны совпадать с `EntityMapping.kt` в приложении, иначе
редактор покажет одно, а планшет нарисует другое.
"""

from __future__ import annotations

import re
from typing import Any

from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import area_registry as ar
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers import floor_registry as fr

from .const import DEFAULT_DOORSTATION_NAME, DOORSTATION_ENTITY_KEYS

# «пол» отдельным словом: ловит «Тёплый пол» и «floor»,
# но не «полотенцесушитель» и не «потолок».
FLOOR_WORD = re.compile(
    r"(^|[^а-яёa-z0-9])(пол|полы|floor|underfloor)([^а-яёa-z0-9]|$)",
    re.IGNORECASE,
)

LIGHT_WORDS = (
    "свет", "лампа", "лампы", "люстр", "бра", "спот", "подсвет", "торшер", "ночник",
    "light", "lamp", "chandelier", "spot",
)
TV_WORDS = ("телевизор", "тв", "tv", "телек", "приставк")
FAN_WORDS = ("вентил", "вытяж", "проветр", "рекуперат", "fan", "vent", "hood", "exhaust")
IRRIGATION_WORDS = ("полив", "орошен", "капель", "sprinkler", "irrigation", "drip")

SUPPORTED_DOMAINS = ("light", "switch", "valve", "fan", "media_player", "climate", "cover", "sensor")


def is_floor_related(name: str) -> bool:
    return bool(FLOOR_WORD.search(name or ""))


def climate_role(name: str) -> str:
    lowered = (name or "").lower()
    if is_floor_related(lowered):
        return "floor"
    if "радиатор" in lowered or "батаре" in lowered or "radiator" in lowered:
        return "radiator"
    if "конвектор" in lowered or "convector" in lowered:
        return "convector"
    return "ac"


def looks_like_light(name: str) -> bool:
    lowered = (name or "").lower()
    return any(word in lowered for word in LIGHT_WORDS)


def looks_like_irrigation(*names: str) -> bool:
    """Полив узнаём по имени или по entity_id: в щите реле зовут `switch.poliv_1`."""
    return any(word in (name or "").lower() for name in names for word in IRRIGATION_WORDS)


def toggle_role(domain: str, name: str, device_class: str | None = None) -> str:
    lowered = (name or "").lower()
    if domain == "media_player":
        # У media_player есть device_class: колонка это «Музыка», а не «Телевизор».
        if device_class == "tv":
            return "tv"
        if device_class in ("speaker", "receiver"):
            return "media"
        return "tv" if any(word in lowered for word in TV_WORDS) else "media"
    if domain == "fan":
        return "fan"
    if any(word in lowered for word in TV_WORDS):
        return "tv"
    if any(word in lowered for word in FAN_WORDS):
        return "fan"
    return "other"


# Сколько switch у устройства, чтобы считать их настоящими выключателями.
# Реле в щите даёт 1-8 каналов. Робот-пылесос Xiaomi даёт 41 служебный
# переключатель, и ни один не помечен entity_category=config.
MAX_SWITCHES_PER_DEVICE = 8


def switch_is_useful(name: str, switches_on_device: int) -> bool:
    """`switch.*`, который планшет узнаёт по имени: свет, ТВ, вентиляция или полив.

    Розетки, клапаны и служебные тумблеры техники планшету не нужны: его дело
    свет, климат и шторы, а не полный список сущностей дома.
    """
    if switches_on_device > MAX_SWITCHES_PER_DEVICE:
        return False
    lowered = (name or "").lower()
    return (
        any(word in lowered for word in LIGHT_WORDS)
        or any(word in lowered for word in TV_WORDS)
        or any(word in lowered for word in FAN_WORDS)
        or any(word in lowered for word in IRRIGATION_WORDS)
    )


def is_usable_state(state) -> bool:
    """Недоступное устройство рисовать как рабочее нельзя."""
    return state is not None and state.state not in ("unavailable", "unknown")


def auto_role(
    entity_id: str,
    friendly_name: str,
    device_class: str | None,
    switches_on_device: int = 1,
) -> str | None:
    """Роль устройства так, как её определит приложение. None — не показываем."""
    domain = entity_id.split(".", 1)[0]

    if domain == "light":
        return "light"
    if domain == "valve":
        # Клапан воды — это полив, как бы его ни назвали. Остальные клапаны
        # (газ, стояк) на планшет сами не лезут: перекрыть газ с настенной
        # плитки — не то, чего от неё ждут. Руками добавить их можно.
        if device_class == "water" or looks_like_irrigation(friendly_name, entity_id):
            return "irrigation"
        return None
    if domain == "switch":
        if switches_on_device > MAX_SWITCHES_PER_DEVICE:
            return None
        # Полив сильнее света и вентиляции: «Свет у полива» на грядке — это
        # всё-таки полив, а вот `light.*` над грядкой остаётся светом.
        if looks_like_irrigation(friendly_name, entity_id):
            return "irrigation"
        if looks_like_light(friendly_name):
            return "light"
        if switch_is_useful(friendly_name, switches_on_device):
            return toggle_role(domain, friendly_name, device_class)
        # Всё остальное, что стоит в зоне, — тоже на планшет: реле тёплого пола,
        # насосы, розетки. Планшет показывает комнату такой, какая она в HA;
        # служебные тумблеры (entity_category) отсеиваются раньше.
        return "other"
    if domain in ("fan", "media_player"):
        return toggle_role(domain, friendly_name, device_class)
    if domain == "climate":
        return climate_role(friendly_name)
    if domain == "cover":
        return "cover"
    if domain == "sensor":
        if device_class == "temperature":
            return "sensor_floor_temp" if is_floor_related(friendly_name) else "sensor_air_temp"
        if device_class == "humidity":
            return "sensor_humidity"
        return None
    return None


def sensor_role_by_unit(state) -> str | None:
    """Роль датчика по единице измерения, когда device_class не проставлен.

    На объектах температура часто приходит из Modbus или из шаблона, и класс
    никто не задаёт — но «°C» в единицах измерения сказано прямо.
    """
    if state is None:
        return None
    unit = (state.attributes.get("unit_of_measurement") or "").strip()
    name = state.attributes.get("friendly_name") or state.entity_id
    if unit in ("°C", "C", "°F", "F"):
        return "sensor_floor_temp" if is_floor_related(name) else "sensor_air_temp"
    # Проценты — не только влажность: заряд батарейки, уровень сигнала, объём
    # диска. Без device_class берём только то, что и названо влажностью.
    if unit == "%" and any(word in (name or "").lower() for word in ("влажн", "humid")):
        return "sensor_humidity"
    return None


@callback
def async_collect_areas(hass: HomeAssistant) -> list[dict[str, Any]]:
    """Комнаты объекта с уже разложенными по ролям устройствами."""
    area_reg = ar.async_get(hass)
    floor_reg = fr.async_get(hass)
    entity_reg = er.async_get(hass)
    device_reg = dr.async_get(hass)

    # Сколько switch у каждого устройства — этим отсекаем служебные тумблеры техники.
    switches_per_device: dict[str, int] = {}
    # Выключенные и служебные (entity_category) не считаем: иначе 8-канальное
    # реле с одним тумблером настроек «превышает» порог и пропадает целиком.
    for entry in entity_reg.entities.values():
        if (
            entry.domain == "switch"
            and entry.device_id
            and entry.disabled_by is None
            and entry.entity_category is None
        ):
            switches_per_device[entry.device_id] = switches_per_device.get(entry.device_id, 0) + 1

    by_area: dict[str, list[dict[str, Any]]] = {}

    for entry in entity_reg.entities.values():
        if entry.disabled_by is not None or entry.hidden_by is not None:
            continue
        if entry.entity_category is not None:
            continue
        if entry.domain not in SUPPORTED_DOMAINS:
            continue

        area_id = entry.area_id
        if area_id is None and entry.device_id:
            device = device_reg.async_get(entry.device_id)
            area_id = device.area_id if device else None
        if area_id is None:
            continue

        state = hass.states.get(entry.entity_id)
        # Keep unavailable devices in the layout; Android disables their controls.

        friendly_name = (
            (state.attributes.get("friendly_name") if state else None)
            or entry.name
            or entry.original_name
            or entry.entity_id
        )
        device_class = (
            (state.attributes.get("device_class") if state else None)
            or entry.device_class
            or entry.original_device_class
        )

        role = auto_role(
            entry.entity_id,
            friendly_name,
            device_class,
            switches_per_device.get(entry.device_id or "", 1),
        )
        if role is None and entry.domain == "sensor":
            # Датчик без device_class: смотрим на единицу измерения. Иначе
            # комната с температурой из Modbus выглядит на планшете так, будто
            # датчика в ней нет.
            role = sensor_role_by_unit(state)
        if role is None:
            continue

        by_area.setdefault(area_id, []).append(
            {
                "entity_id": entry.entity_id,
                "name": friendly_name,
                "domain": entry.domain,
                "role": role,
                "available": is_usable_state(state),
            }
        )

    areas: list[dict[str, Any]] = []
    for area in area_reg.async_list_areas():
        # Пустые комнаты тоже отдаём: в редакторе в них можно добавить
        # устройства руками, а на планшет пустая комната всё равно не попадёт.
        floor_id = getattr(area, "floor_id", None)
        floor = floor_reg.async_get_floor(floor_id) if floor_id else None
        entities = by_area.get(area.id, [])
        entities.sort(key=lambda item: (item["role"], item["name"]))
        areas.append(
            {
                "area_id": area.id,
                "name": area.name,
                "floor_name": floor.name if floor else None,
                "icon": area.icon,
                "entities": entities,
            }
        )

    areas.sort(key=lambda item: item["name"].lower())
    return areas


@callback
def async_entity_catalog(hass: HomeAssistant) -> list[dict[str, Any]]:
    """Все подходящие сущности дома — для ручного добавления в комнату.

    Автоопределение видит только то, что привязано к Area. Если монтажник
    добавляет устройство руками, выбирать надо из полного списка.
    """
    entity_reg = er.async_get(hass)
    device_reg = dr.async_get(hass)
    result: list[dict[str, Any]] = []

    for entry in entity_reg.entities.values():
        if entry.disabled_by is not None or entry.hidden_by is not None:
            continue
        if entry.domain not in SUPPORTED_DOMAINS:
            continue
        state = hass.states.get(entry.entity_id)
        friendly_name = (
            (state.attributes.get("friendly_name") if state else None)
            or entry.name
            or entry.original_name
            or entry.entity_id
        )
        device_class = (
            (state.attributes.get("device_class") if state else None)
            or entry.device_class
            or entry.original_device_class
        )
        area_id = entry.area_id
        if area_id is None and entry.device_id:
            # Как в async_collect_areas: комната сущности наследуется от устройства.
            device = device_reg.async_get(entry.device_id)
            area_id = device.area_id if device else None
        # В каталоге для ручного добавления фильтр мягче: сюда лезут именно за
        # тем, что автоопределение не взяло. Реле «Насос» тоже должно быть видно.
        role = auto_role(entry.entity_id, friendly_name, device_class)
        if role is None:
            if entry.domain == "sensor":
                # Датчик без device_class автоопределение не берёт, а на объекте
                # это сплошь и рядом: температура приходит из Modbus или из
                # шаблона, и класс никто не проставил. Роль здесь — подсказка по
                # единице измерения, а окончательную монтажник выберет руками.
                role = sensor_role_by_unit(state)
                if role is None:
                    continue
            elif entry.domain in ("switch", "valve", "fan", "media_player"):
                role = "other"
            else:
                continue
        result.append(
            {
                "entity_id": entry.entity_id,
                "name": friendly_name,
                "domain": entry.domain,
                "role": role,
                "area_id": area_id,
            }
        )

    result.sort(key=lambda item: item["name"].lower())
    return result


@callback
def async_room_payload(
    hass: HomeAssistant,
    tablet: dict[str, Any],
    backgrounds: dict[str, Any],
) -> list[dict[str, Any]]:
    """То, что уедет в атрибуты сенсора и что прочитает планшет.

    Автоопределение + правки монтажника: скрытые комнаты выброшены, снятые
    галочками сущности выброшены, переопределённые роли применены.
    """
    rooms_cfg = tablet.get("rooms") or {}
    payload: list[dict[str, Any]] = []

    for index, area in enumerate(async_collect_areas(hass)):
        area_id = area["area_id"]
        cfg = rooms_cfg.get(area_id) or {}
        if cfg.get("visible") is False:
            continue

        excluded = set(cfg.get("exclude") or [])
        roles: dict[str, str] = cfg.get("roles") or {}

        # Добавленные руками сущности — они могут быть вообще из другой Area
        # или не иметь её совсем.
        candidates = list(area["entities"])
        known = {item["entity_id"] for item in candidates}
        for entity_id in cfg.get("include") or []:
            if entity_id in known:
                continue
            state = hass.states.get(entity_id)
            if state is None:
                continue
            name = state.attributes.get("friendly_name") or entity_id
            role = auto_role(entity_id, name, state.attributes.get("device_class"))
            if role is None:
                # Выбор монтажника главнее автоопределения: датчик добавляют
                # руками именно тогда, когда распознать его не удалось, и
                # выбрасывать такую сущность до применения ролей нельзя —
                # иначе выпадающий список в редакторе ни на что не влияет.
                role = roles.get(entity_id)
                if role in (None, "auto"):
                    role = sensor_role_by_unit(state) if entity_id.startswith("sensor.") else None
                if role is None:
                    continue
            candidates.append(
                {"entity_id": entity_id, "name": name, "role": role, "manual": True}
            )

        entities = []
        for item in candidates:
            if item["entity_id"] in excluded:
                continue
            role = roles.get(item["entity_id"], item["role"])
            if role in ("hidden", "auto"):
                if role == "hidden":
                    continue
                role = item["role"]
            entity = {"entity_id": item["entity_id"], "name": (cfg.get("entity_names") or {}).get(item["entity_id"]) or item["name"], "role": role}
            icon = (cfg.get("entity_icons") or {}).get(item["entity_id"])
            if icon: entity["icon"] = icon
            zone = (cfg.get("entity_zones") or {}).get(item["entity_id"])
            if zone: entity["zone"] = zone  # отдельная карточка зоны внутри комнаты
            if role == "cover":
                entity["cover_direction"] = (cfg.get("cover_directions") or {}).get(item["entity_id"], "center")
            entities.append(entity)

        # Комната без устройств — тоже комната: владелец видит на планшете все
        # зоны дома. Спрятать её можно только галочкой (visible=False выше).

        background = backgrounds.get(area_id)
        payload.append(
            {
                "area_id": area_id,
                "name": cfg.get("name") or area["name"],
                "original_name": area["name"],
                "floor_name": cfg.get("floor_name") or area.get("floor_name"),
                "order": int(cfg.get("order", index)),
                "entities": entities,
                "background": background,
            }
        )

    payload.sort(key=lambda room: (room["order"], room["name"].lower()))
    return payload


@callback
def async_doorstation_payload(home: dict[str, Any]) -> dict[str, Any] | None:
    """Домофон в том виде, в каком его читает планшет. None — домофона нет.

    Ключ в конфиге дома, а не в комнате: панель у калитки одна на объект, и
    звонок с неё должен поднять любой планшет, в какой бы комнате он ни висел.

    Сущности отдаём как записаны, даже если сейчас их в Home Assistant нет:
    после перезапуска камера поднимается позже нас, и вычеркнуть её означало
    бы на полминуты оставить хозяина без кнопки «Открыть дверь».
    """
    stored = home.get("doorstation")
    if not isinstance(stored, dict):
        return None
    payload = {key: stored[key] for key in DOORSTATION_ENTITY_KEYS if stored.get(key)}
    if not payload:
        return None
    payload["name"] = stored.get("name") or DEFAULT_DOORSTATION_NAME
    return payload
