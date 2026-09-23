"""Константы интеграции BMS Tablet."""

from __future__ import annotations

DOMAIN = "bms_tablet"

STORAGE_KEY = "bms_tablet.config"
STORAGE_VERSION = 1

# Один объект — одна конфигурация. Планшетов в квартире один, а если их два,
# комнаты у них всё равно те же самые: дом-то один. Раньше конфигураций можно
# было завести сколько угодно, и это только запутывало — какую из них правишь
# и какую читает планшет, было непонятно.
HOME_ID = "home"
SENSOR_ENTITY_ID = f"sensor.bms_tablet_{HOME_ID}"

# Боковая панель
PANEL_URL_PATH = "bms-tablet"
PANEL_TITLE = "BMS Планшеты"
PANEL_ICON = "mdi:tablet-dashboard"
PANEL_COMPONENT = "bms-tablet-editor"
PANEL_STATIC_PATH = "/bms_tablet_static"

# Фото комнат раздаём своим статическим путём, а не через /local:
# /local регистрируется только если папка www существовала на старте HA.
BACKGROUND_URL_PATH = "/api/bms_tablet/image"
BACKGROUND_DIR = "bms_tablet_backgrounds"
BACKGROUND_MAX_BYTES = 12 * 1024 * 1024
BACKGROUND_EXTENSIONS = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
}

DEFAULT_DIM = 0.24
# 0 — фотография комнаты чёткая, 1 — сильное размытие.
DEFAULT_BLUR = 0.35
DEFAULT_AMBIENT = {
    # never | timeout | motion
    #
    # По умолчанию гаснет через время, а не «никогда». Настройки интеграции
    # на планшете главнее локальных, поэтому «никогда» по умолчанию молча
    # отключало спящий экран: монтажник выставлял 3 минуты на самом планшете,
    # и ничего не происходило. «Никогда» теперь означает выбор, а не умолчание.
    "mode": "timeout",
    "timeout_sec": 180,
    "motion_entity": None,
    "brightness_active": 100,
    "brightness_ambient": 15,
}

# Типы климатической техники — совпадают с ClimateKind в приложении
CLIMATE_TYPES = ("ac", "floor", "radiator", "convector")

# Роли устройств, которые монтажник может переопределить руками.
# Список обязан совпадать с ROLE_CHOICES в panel/editor.js.
DEVICE_ROLES = (
    "auto",
    "light",
    "ac",
    "floor",
    "radiator",
    "convector",
    "cover",
    "tv",
    "media",
    "fan",
    "irrigation",
    "sensor_air_temp",
    "sensor_floor_temp",
    "sensor_humidity",
    "other",
    "hidden",
)


# --------------------------------------------------------------- домофон
#
# Панель у калитки живёт в отдельной интеграции («BMS Intercom»): она публикует
# камеру, датчик состояния вызова и кнопки. Планшету нужно только знать, какие
# именно сущности к ней относятся, — поэтому здесь ссылки, а не устройство.
#
# Дом один — и домофон один: держим его рядом с именем дома, а не внутри
# комнаты. Иначе один и тот же звонок пришлось бы заводить в каждой комнате.
DEFAULT_DOORSTATION_NAME = "Домофон"

# ключ -> допустимые домены сущности. Любой ключ может быть пустым: объект без
# кнопки «Открыть дверь» всё равно показывает, кто пришёл.
DOORSTATION_ENTITY_KEYS = {
    "camera": ("camera",),
    "call": ("binary_sensor",),
    # Кнопку домофона обычно отдают как button.*, но на объекте встречается и
    # реле (switch), и скрипт. Выбор монтажника важнее нашего представления
    # о том, как правильно; какую службу звать, приложение решает по домену.
    "answer": ("button", "switch", "script"),
    "reject": ("button", "switch", "script"),
    "door": ("button", "switch", "script"),
}

# Состояния вызова в атрибуте `call_state` датчика домофона.
DOORSTATION_CALL_STATES = ("idle", "ringing", "answered")

SIGNAL_CONFIG_CHANGED = f"{DOMAIN}_config_changed"
