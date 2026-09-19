"""Store, у которого ошибка записи не проглатывается.

Обычный Store.async_save ловит WriteError и только пишет в журнал — вызывающий
код считает, что всё сохранилось, и откат транзакции никогда не срабатывает.
Здесь запись идёт тем же форматом файла, атомарно, а ошибка долетает наверх.
Чтение остаётся штатным (async_load со всеми миграциями Store).
"""
from __future__ import annotations

import os
from typing import Any

from homeassistant.helpers.storage import Store


class StrictStore(Store):
    def __init__(self, hass, version: int, key: str, private: bool = False) -> None:
        super().__init__(hass, version, key, private, atomic_writes=True)
        self._strict_private = private

    async def async_save(self, data: Any) -> None:
        # Импорт здесь: модульные тесты подменяют Store фейком без этих помощников.
        from homeassistant.helpers.json import prepare_save_json
        from homeassistant.helpers.storage import get_internal_store_manager
        from homeassistant.util.file import write_utf8_file_atomic

        payload = {
            "version": self.version,
            "minor_version": self.minor_version,
            "key": self.key,
            "data": data,
        }
        # Сериализуем в цикле событий: живые словари меняются только в нём.
        mode, text = prepare_save_json(payload)
        # Как и штатный Store: кэш предзагрузки после записи устаревает.
        get_internal_store_manager(self.hass).async_invalidate(self.key)
        path = self.path

        def write() -> None:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            write_utf8_file_atomic(path, text, self._strict_private, mode=mode)

        # WriteError/OSError не ловим — пусть откатывает транзакцию.
        await self.hass.async_add_executor_job(write)
