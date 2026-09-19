"""Small, explicit configuration contract shared by storage and API tests."""
from __future__ import annotations
import math
import re
from .icon_catalog import ICON_IDS
from .const import DEVICE_ROLES

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


def validate_home_patch(patch, merge=False):
    if not isinstance(patch, dict) or set(patch) - {"name", "start_area", "ambient", "rooms"}:
        raise ValueError("Неизвестные настройки дома")
    if "name" in patch: text(patch["name"])
    if "start_area" in patch: text(patch["start_area"],128,True)
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
