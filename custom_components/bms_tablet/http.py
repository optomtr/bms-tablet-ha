"""Authenticated photos, bounded uploads and atomic replacement off the HA event loop."""
from __future__ import annotations

import asyncio
from io import BytesIO
from pathlib import Path
import re
import tempfile
from uuid import uuid4

from aiohttp import web
from PIL import Image, UnidentifiedImageError
from homeassistant.components.http import HomeAssistantView
from homeassistant.core import HomeAssistant

from .const import BACKGROUND_DIR, BACKGROUND_EXTENSIONS, BACKGROUND_MAX_BYTES, BACKGROUND_URL_PATH, DOMAIN
from .store import BmsTabletStore, NotLoaded, get_store


def background_dir(hass: HomeAssistant) -> Path:
    return Path(hass.config.path(BACKGROUND_DIR))


def valid_id(value: str) -> bool:
    return bool(re.fullmatch(r"[\w-]{1,128}", value))


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
        if not valid_id(area_id):
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
        if not valid_id(area_id):
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
