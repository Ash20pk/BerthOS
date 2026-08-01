"""Mirrors @berth/sdk's context-bus/local.ts — an in-process no-op fallback
used when the real Unix-socket daemon isn't reachable (e.g. running an app
outside a sandbox during a quick script/test)."""

from __future__ import annotations

import logging
from collections import defaultdict
from typing import Any, Callable

logger = logging.getLogger("berth.context_bus.local")


class LocalContextBus:
    def __init__(self) -> None:
        self._handlers: dict[str, list[Callable[[Any], None]]] = defaultdict(list)

    # Plain synchronous methods — see context_bus.py's own comment on why
    # these deliberately aren't `async def` in this runtime.
    def register(self, app: str) -> None:
        logger.debug('register app="%s" (no-op — real daemon not connected)', app)

    def publish(self, topic: str, payload: Any) -> None:
        logger.debug('publish topic="%s"', topic)
        for handler in list(self._handlers.get(topic, [])):
            handler(payload)

    def subscribe(self, topic: str, handler: Callable[[Any], None]) -> Callable[[], None]:
        logger.debug('subscribe topic="%s"', topic)
        self._handlers[topic].append(handler)

        def unsubscribe() -> None:
            if handler in self._handlers[topic]:
                self._handlers[topic].remove(handler)

        return unsubscribe
