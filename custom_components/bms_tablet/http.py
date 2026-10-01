"""Authenticated photos, bounded uploads and atomic replacement off the HA event loop."""
from __future__ import annotations

import asyncio
import json
from io import BytesIO
from pathlib import Path
import re
import tempfile
from uuid import uuid4

from aiohttp import web
from PIL import Image, UnidentifiedImageError
from homeassistant.components.http import HomeAssistantView
from homeassistant.core import HomeAssistant

from .const import (
    BACKGROUND_DIR,
    BACKGROUND_EXTENSIONS,
    BACKGROUND_MAX_BYTES,
    BACKGROUND_URL_PATH,
    DOMAIN,
    WEB_DIR,
    WEB_MANIFEST_PATH,
    WEB_STATIC_PATH,
    WEB_THEME_COLOR,
    WEB_TITLE,
    WEB_URL_PATH,
)
from .store import BmsTabletStore, NotLoaded, get_store
from .validation import BACKGROUND_KEY


def background_dir(hass: HomeAssistant) -> Path:
    return Path(hass.config.path(BACKGROUND_DIR))


def valid_id(value: str) -> bool:
    """Имя файла фото: «ключ-uuid» — и для «__home__-…», поэтому не ключ фона."""
    return bool(re.fullmatch(r"[\w-]{1,128}", value))


def valid_key(value: str) -> bool:
    return bool(BACKGROUND_KEY.match(value))


def validate_image(data: bytes, extension: str) -> None:
    """Reject disguised files, corrupt streams and excessive decoded allocations."""
    expected = {"jpg": "JPEG", "png": "PNG", "webp": "WEBP"}[extension]
    with Image.open(BytesIO(data)) as picture:
        if picture.format != expected or picture.width * picture.height > 24_000_000:
            raise ValueError("Неверный формат или изображение больше 24 мегапикселей")
        if getattr(picture, "n_frames", 1) != 1:
            raise ValueError("Нужно статичное изображение")
        picture.load()


def save_image(directory: Path, area_id: str, extension: str, data: bytes) -> None:
    validate_image(data, extension)
    directory.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=directory, suffix=".part", delete=False) as output:
        temp = Path(output.name)
        try:
            output.write(data)
            output.flush()
            import os
            os.fsync(output.fileno())
            temp.replace(directory / f"{area_id}.{extension}")
        finally:
            temp.unlink(missing_ok=True)
    for other in BACKGROUND_EXTENSIONS.values():
        if other != extension:
            (directory / f"{area_id}.{other}").unlink(missing_ok=True)


def remove_background_files(directory: Path, area_id: str, old_url: str | None) -> None:
    """Удалить файл фото комнаты (текущий по url и старые area_id.ext). Только в executor."""
    if old_url and old_url.startswith(BACKGROUND_URL_PATH + "/"):
        previous = Path(old_url).name
        if valid_id(previous.rpartition(".")[0]):
            (directory / previous).unlink(missing_ok=True)
    if valid_id(area_id):
        for ext in BACKGROUND_EXTENSIONS.values():
            (directory / f"{area_id}.{ext}").unlink(missing_ok=True)


class BackgroundUploadView(HomeAssistantView):
    url = "/api/" + DOMAIN + "/background/{area_id}"
    name = "api:" + DOMAIN + ":background"
    requires_auth = True

    def __init__(self, hass: HomeAssistant, store: BmsTabletStore) -> None:
        self._hass = hass
        # A single bounded upload transaction also serializes replacement/version updates.
        self._busy = asyncio.Lock()

    async def post(self, request: web.Request, area_id: str) -> web.Response:
        user = request.get("hass_user")
        if not user or not user.is_admin:
            return self.json_message("Нужны права администратора", 403)
        if not valid_key(area_id):
            return self.json_message("Некорректная комната", 400)
        if (self._hass.data.get(DOMAIN) or {}).get("store") is None:
            return self.json_message("Интеграция не загружена", 503)
        if self._busy.locked():
            return self.json_message("Загрузка уже выполняется, повторите позже", 429)
        async with self._busy:
            try:
                async with asyncio.timeout(30):
                    reader = await request.multipart()
                    field = await reader.next()
                    if field is None or field.name != "file":
                        return self.json_message("Ожидается поле file", 400)
                    mime = field.headers.get("Content-Type", "").split(";")[0].strip()
                    extension = BACKGROUND_EXTENSIONS.get(mime)
                    if extension is None:
                        return self.json_message("Поддерживаются JPEG, PNG и WebP", 400)
                    data = bytearray()
                    while chunk := await field.read_chunk():
                        data.extend(chunk)
                        if len(data) > BACKGROUND_MAX_BYTES:
                            return self.json_message("Файл больше 12 МБ", 413)
                file_id=area_id[:80]+"-"+uuid4().hex
                await self._hass.async_add_executor_job(save_image, background_dir(self._hass), file_id, extension, bytes(data))
            except TimeoutError:
                return self.json_message("Истекло время загрузки", 408)
            except (ValueError, UnidentifiedImageError, Image.DecompressionBombError):
                return self.json_message("Некорректное изображение: статичное JPEG/PNG/WebP до 24 Мп", 400)
            except OSError:
                return self.json_message("Не удалось прочитать или сохранить изображение", 400)
            try:
                store=get_store(self._hass)
            except NotLoaded:
                await self._hass.async_add_executor_job((background_dir(self._hass)/f"{file_id}.{extension}").unlink, True)
                return self.json_message("Интеграция не загружена", 503)
            old_url=(store.backgrounds().get(area_id) or {}).get("url")
            try:
                background = await store.async_set_background(area_id, url=f"{BACKGROUND_URL_PATH}/{file_id}.{extension}", bump_version=True)
            except BaseException:
                await self._hass.async_add_executor_job((background_dir(self._hass)/f"{file_id}.{extension}").unlink, True)
                raise
            if old_url != background.get("url"):
                await self._hass.async_add_executor_job(remove_background_files, background_dir(self._hass), "", old_url)
            return self.json({"area_id": area_id, "background": background})

    async def delete(self, request: web.Request, area_id: str) -> web.Response:
        user = request.get("hass_user")
        if not user or not user.is_admin:
            return self.json_message("Нужны права администратора", 403)
        if not valid_key(area_id):
            return self.json_message("Некорректная комната", 400)
        if self._busy.locked():
            return self.json_message("Загрузка уже выполняется, повторите позже", 429)
        async with self._busy:
            try:
                store=get_store(self._hass)
            except NotLoaded:
                return self.json_message("Интеграция не загружена", 503)
            old_url=(store.backgrounds().get(area_id) or {}).get("url")
            await store.async_remove_background(area_id)
            await self._hass.async_add_executor_job(remove_background_files, background_dir(self._hass), area_id, old_url)
        return self.json({"area_id": area_id, "background": None})


class BackgroundImageView(HomeAssistantView):
    url = BACKGROUND_URL_PATH + "/{filename}"
    name = "api:" + DOMAIN + ":image"
    requires_auth = True

    def __init__(self, hass: HomeAssistant) -> None:
        self._hass = hass

    async def get(self, request: web.Request, filename: str) -> web.StreamResponse:
        area, dot, ext = filename.rpartition(".")
        if not dot or not valid_id(area) or ext not in BACKGROUND_EXTENSIONS.values():
            raise web.HTTPNotFound()
        path = background_dir(self._hass) / filename
        if not await self._hass.async_add_executor_job(path.is_file):
            raise web.HTTPNotFound()
        return web.FileResponse(path, headers={"Cache-Control":"private, no-cache", "X-Content-Type-Options":"nosniff"})


# ------------------------------------------------------------ веб-версия (iPad)
#
# Страница отдаётся без входа: вход делает сама страница через OAuth HA.
# Поэтому в HTML ничего из запроса не попадает — только файл с диска и
# постоянный <base>. Хост из запроса идёт лишь в заголовок CSP (ws/wss на
# себя) и только после строгой проверки.

WEB_BASE_HREF = WEB_STATIC_PATH + "/"
_VERSION_SEGMENT = re.compile(r"^v[0-9][0-9A-Za-z.\-]{0,30}/")
_BASE_TAG = re.compile(r"<base[\s>/]", re.IGNORECASE)
_HEAD_TAG = re.compile(r"<head(\s[^>]*)?>", re.IGNORECASE)
_SAFE_HOST = re.compile(r"(?:[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63})*|\[[0-9A-Fa-f:.]{2,45}\])(?::\d{1,5})?")


def web_dir() -> Path:
    return Path(__file__).parent / WEB_DIR


def _integration_version() -> str:
    try:
        version = json.loads((Path(__file__).parent / "manifest.json").read_text(encoding="utf-8")).get("version", "")
    except (OSError, ValueError):
        return ""
    return version if re.fullmatch(r"[0-9][0-9A-Za-z.\-]{0,30}", str(version)) else ""


def web_base_href() -> str:
    """Адрес файлов страницы, своя папка на каждую версию: /bms_tablet_web/v0.7.6/.

    На даче после обновления браузер собрал страницу из старых модулей — взял
    их из своего кэша, не спросив сервер. Новый адрес у каждой версии такой
    кэш обходит наверняка; WebStaticView этот сегмент просто отбрасывает.
    """
    # Версию читаем при каждом открытии страницы: обновление одних файлов
    # страницы через HACS доходит без перезапуска HA.
    version = _integration_version()
    return f"{WEB_STATIC_PATH}/v{version}/" if version else WEB_BASE_HREF


def with_base_tag(html: str, base: str | None = None) -> str:
    """Добавить <base href="/bms_tablet_web/v<версия>/">, если в файле его нет."""
    if _BASE_TAG.search(html):
        return html
    tag = f'<base href="{base or web_base_href()}">'
    head = _HEAD_TAG.search(html)
    if head:
        return html[: head.end()] + tag + html[head.end():]
    return tag + html


def content_security_policy(host: str | None) -> str:
    connect = ["'self'"]
    # Старый Safari не считает ws(s) на свой адрес частью 'self' — пишем явно.
    if host and _SAFE_HOST.fullmatch(host):
        connect += [f"wss://{host}", f"ws://{host}"]
    return "; ".join(
        [
            "default-src 'self'",
            "script-src 'self'",
            # style="--cols:3" в разметке — атрибуты стилей нужны.
            "style-src 'self' 'unsafe-inline'",
            "img-src 'self' data: blob:",
            "font-src 'self'",
            "media-src 'self' blob:",
            "connect-src " + " ".join(connect),
            "manifest-src 'self'",
            "worker-src 'self'",
            "object-src 'none'",
            "base-uri 'self'",
            "form-action 'self'",
            "frame-ancestors 'self'",
        ]
    )


def read_page() -> str | None:
    try:
        return (web_dir() / "index.html").read_text(encoding="utf-8")
    except OSError:
        return None


class WebPageView(HomeAssistantView):
    """Страница веб-версии: index.html с <base> и строгим CSP, без кэша."""

    url = WEB_URL_PATH
    name = DOMAIN + ":web"
    requires_auth = False

    def __init__(self, hass: HomeAssistant) -> None:
        self._hass = hass

    async def get(self, request: web.Request) -> web.Response:
        html, base = await self._hass.async_add_executor_job(lambda: (read_page(), web_base_href()))
        if html is None:
            return web.Response(status=503, text="Веб-версия не установлена", headers={"Cache-Control": "no-store"})
        return web.Response(
            text=with_base_tag(html, base),
            content_type="text/html",
            charset="utf-8",
            headers={
                "Cache-Control": "no-cache",
                "Content-Security-Policy": content_security_policy(request.host),
                "X-Content-Type-Options": "nosniff",
                "Referrer-Policy": "same-origin",
            },
        )


# Что веб-версия раздаёт: только свои файлы этих типов, ничего больше.
WEB_FILE_TYPES = {".html", ".js", ".css", ".png", ".svg", ".ttf", ".woff2", ".json"}


def web_file(path: str) -> Path | None:
    """Файл веб-версии по пути из адреса или None: «..», ссылки наружу и чужие типы — нет."""
    root = web_dir().resolve()
    # Сегмент версии из <base> («v0.7.6/js/app.js») — не папка, отбрасываем.
    path = _VERSION_SEGMENT.sub("", path, count=1)
    try:
        target = (root / path).resolve()
    except (OSError, ValueError):
        return None
    if not target.is_relative_to(root) or target.suffix.lower() not in WEB_FILE_TYPES:
        return None
    return target if target.is_file() else None


class WebStaticView(HomeAssistantView):
    """Файлы веб-версии с «Cache-Control: no-cache».

    Встроенная раздача HA без кэш-заголовков оставляет решение браузеру, и
    Safari держал старый скрипт после обновления интеграции: экран iPad
    собирался из нового HTML и вчерашнего JS. no-cache — браузер каждый раз
    сверяется с сервером (ответ 304, если файл тот же), дёшево и всегда свежо.
    """

    url = WEB_STATIC_PATH + "/{path:.+}"
    name = DOMAIN + ":web:static"
    requires_auth = False

    def __init__(self, hass: HomeAssistant) -> None:
        self._hass = hass

    async def get(self, request: web.Request, path: str) -> web.StreamResponse:
        target = await self._hass.async_add_executor_job(web_file, path)
        if target is None:
            raise web.HTTPNotFound()
        return web.FileResponse(target, headers={"Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff"})


def web_manifest() -> dict:
    icons = WEB_STATIC_PATH + "/icons"
    return {
        "id": WEB_URL_PATH,
        "name": WEB_TITLE,
        "short_name": "BMS",
        "lang": "ru",
        "start_url": WEB_URL_PATH,
        "scope": WEB_URL_PATH,
        "display": "standalone",
        "background_color": WEB_THEME_COLOR,
        "theme_color": WEB_THEME_COLOR,
        "icons": [
            {"src": f"{icons}/app-192.png", "sizes": "192x192", "type": "image/png"},
            {"src": f"{icons}/app-512.png", "sizes": "512x512", "type": "image/png"},
        ],
    }


class WebManifestView(HomeAssistantView):
    url = WEB_MANIFEST_PATH
    name = DOMAIN + ":web:manifest"
    requires_auth = False

    async def get(self, request: web.Request) -> web.Response:
        return web.Response(
            text=json.dumps(web_manifest(), ensure_ascii=False),
            content_type="application/manifest+json",
            charset="utf-8",
            headers={"Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff"},
        )
