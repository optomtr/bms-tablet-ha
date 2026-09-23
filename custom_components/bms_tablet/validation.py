"""Small, explicit configuration contract shared by storage and API tests."""
from __future__ import annotations
import math
import re
from .icon_catalog import ICON_IDS
from .const import DEVICE_ROLES, DOORSTATION_ENTITY_KEYS

# Ключ фона: area_id комнаты, «__home__» (общий фон) или «__home__N» — фон планшета N (1..99).
BACKGROUND_KEY = re.compile(r"^(?:(?!__home__)[\w-]{1,128}|__home__(?:[1-9]\d?)?)\Z")


def background_key(value):
    if not isinstance(value, str) or not BACKGROUND_KEY.match(value): raise ValueError("Некорректный ключ фона")
    return value


def number(value, low, high):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not low <= value <= high:
        raise ValueError("Число вне допустимого диапазона")
    return value


def text(value, limit=100, nullable=False):
    if nullable and value is None:
        return value
    if not isinstance(value, str) or len(value) > limit:
        raise ValueError("Некорректная строка")
    return value


# `domain.object_id` — ровно то, что Home Assistant считает entity_id.
ENTITY_ID = re.compile(r"^[a-z][a-z0-9_]*\.[a-z0-9_]+\Z")


def entity_id(value, domains):
    """Ссылка на сущность нужного домена; пустая строка и None — «не выбрано»."""
    if value is None or value == "":
        return None
    if not isinstance(value, str) or len(value) > 255 or not ENTITY_ID.match(value):
        raise ValueError("Некорректная сущность")
    if value.split(".", 1)[0] not in domains:
        raise ValueError("Сущность не того типа: ожидается " + ", ".join(d + ".*" for d in domains))
    return value


def validate_doorstation(value):
    """Домофон: ссылки на камеру, датчик вызова и кнопки.

    None стирает домофон целиком. Пустой словарь — тоже: домофон без единой
    сущности планшету нечего показывать, и хранить такую запись незачем.
    """
    if value is None:
        return None
    if not isinstance(value, dict) or set(value) - set(DOORSTATION_ENTITY_KEYS) - {"name"}:
        raise ValueError("Неизвестные настройки домофона")
    result = {}
    for key, domains in DOORSTATION_ENTITY_KEYS.items():
        if key not in value:
            continue
        chosen = entity_id(value[key], domains)
        if chosen is not None:
            result[key] = chosen
    if "name" in value:
        name = text(value["name"], 100, True)
        if isinstance(name, str) and name.strip():
            result["name"] = name.strip()
    return result or None


def validate_home_patch(patch, merge=False):
    if not isinstance(patch, dict) or set(patch) - {"name", "start_area", "ambient", "rooms", "doorstation"}:
        raise ValueError("Неизвестные настройки дома")
    if "name" in patch: text(patch["name"])
    if "start_area" in patch: text(patch["start_area"],128,True)
    if "doorstation" in patch: validate_doorstation(patch["doorstation"])
    if "ambient" in patch:
        ambient=patch["ambient"]
        if not isinstance(ambient,dict) or set(ambient)-{"mode","timeout_sec","motion_entity","brightness_active","brightness_ambient"}: raise ValueError("Некорректный спящий режим")
        for key,value in ambient.items():
            if key=="mode" and value not in ("never","timeout","motion"): raise ValueError("Неизвестный режим")
            if key=="timeout_sec": number(value,15,3600)
            if key.startswith("brightness_"): number(value,1,100)
            if key=="motion_entity": text(value,255,True)
    if "rooms" not in patch: return
    rooms=patch["rooms"]
    if not isinstance(rooms,dict) or len(rooms)>2000: raise ValueError("Слишком много комнат")
    for area, room in rooms.items():
        text(area,128)
        if room is None: continue
        if not isinstance(room,dict) or set(room)-{"visible","order","exclude","include","roles","name","floor_name","entity_names","cover_directions","entity_icons","entity_zones"}: raise ValueError("Некорректная комната")
        for key,value in room.items():
            if key in ("name","floor_name"): text(value,100,True)
            elif key=="visible" and not isinstance(value,bool): raise ValueError("visible должен быть boolean")
            elif key=="order": number(value,0,100000)
            elif key in ("exclude","include"):
                # merge: {"add": [...], "remove": [...]} вместо всего списка
                if merge and isinstance(value,dict):
                    if set(value)-{"add","remove"}: raise ValueError("Некорректный список устройств")
                    parts=[value.get("add") or [],value.get("remove") or []]
                else: parts=[value]
                for part in parts:
                    if not isinstance(part,list) or len(part)>2000: raise ValueError("Некорректный список устройств")
                    for entity in part: text(entity,255)
            elif key in ("roles","entity_names","cover_directions","entity_icons","entity_zones"):
                if not isinstance(value,dict) or len(value)>2000: raise ValueError("Некорректные параметры устройств")
                for entity,label in value.items():
                    text(entity,255)
                    if merge and label is None: continue  # merge: None удаляет ключ
                    text(label)
                    # зона: подпись карточки внутри комнаты, без пробелов по краям
                    if key=="entity_zones" and (len(label)>60 or not label.strip() or label!=label.strip()): raise ValueError("Некорректная зона")
                    if key=="entity_icons" and label not in ICON_IDS: raise ValueError("Неизвестная иконка")
                    if key=="cover_directions" and label not in ("center","left_to_right","right_to_left"): raise ValueError("Неизвестное направление шторы")
                    if key=="roles" and label not in DEVICE_ROLES: raise ValueError("Неизвестная роль устройства")
