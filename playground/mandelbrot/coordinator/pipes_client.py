"""Thin PipesHub client on python-socketio.

PipesClientPython cannot be used here (see KNOWN_LIMITATIONS.md): it forces
HTTP long-polling, sends the JWT as a header, has no correlation ids and
cannot answer inbound asks asynchronously. This client speaks the same
envelope as playground/mandelbrot/src/pipes.js:

  emit 'gateway'          { senderId, receiverId, operation, input, awaiting }
  emit 'responseGateway'  the received envelope plus { res }, to reply

It waits for the hub's `gateway` 200 before sending anything, because the hub
attaches its listeners only after that point.
"""

from __future__ import annotations

import asyncio
import logging
import secrets
from typing import Any, Awaitable, Callable

import aiohttp
import socketio

log = logging.getLogger("pipes")

HUB_READY = 200
ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567"

Reply = Callable[[Any], bool]
OnMessage = Callable[[str, dict, str, "Reply | None"], Awaitable[None] | None]


class PipeError(Exception):
    """code is one of TIMEOUT, OFFLINE, CLOSED, AUTH_TIMEOUT, CONNECT_TIMEOUT."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def random_id(length: int = 16) -> str:
    return "".join(ID_ALPHABET[b & 31] for b in secrets.token_bytes(length))


async def fetch_token(auth_url: str, unit_name: str, timeout_s: float = 10.0) -> str:
    """POST /auth with form field `name`; the hub answers with the JWT as text."""
    try:
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=timeout_s)) as s:
            async with s.post(f"{auth_url}/auth", data={"name": unit_name}) as r:
                if r.status != 200:
                    raise RuntimeError(f"auth {r.status}")
                return await r.text()
    except asyncio.TimeoutError as e:
        raise PipeError("AUTH_TIMEOUT") from e


class PipeClient:
    """One PipesHub unit.

    on_message(operation, input, sender_id, reply) is called for every
    envelope addressed to this unit. reply(res) is None unless the sender
    used ask; it returns False if the client is offline.
    """

    def __init__(self, hub_url: str, auth_url: str, unit_name: str,
                 on_message: OnMessage, *,
                 on_status: Callable[[str, Any], None] | None = None,
                 sio_factory: Callable[[], Any] | None = None,
                 token_fn: Callable[[str, str], Awaitable[str]] = fetch_token):
        self.hub_url = hub_url
        self.auth_url = auth_url
        self.unit_name = unit_name
        self._on_message = on_message
        self._on_status = on_status
        self._token_fn = token_fn
        self._sio = (sio_factory or self._default_sio)()
        self._token: str | None = None
        self._ready = asyncio.Event()
        self._pending: dict[str, asyncio.Future] = {}
        self._closed = False

        self._sio.on("gateway", self._handle_gateway)
        self._sio.on("responseGateway", self._handle_response)
        self._sio.on("disconnect", self._handle_disconnect)
        self._sio.on("connect_error", self._handle_connect_error)

    @staticmethod
    def _default_sio():
        return socketio.AsyncClient(reconnection=True, reconnection_delay=1,
                                    reconnection_delay_max=5, randomization_factor=0.5)

    # ── Public API ──────────────────────────────────────────────────────────

    @property
    def ready(self) -> bool:
        return self._ready.is_set()

    def pending_count(self) -> int:
        return len(self._pending)

    async def connect(self, timeout_s: float = 15.0) -> None:
        self._token = await self._token_fn(self.auth_url, self.unit_name)
        sep = "&" if "?" in self.hub_url else "?"
        await self._sio.connect(
            f"{self.hub_url}{sep}name={self.unit_name}",
            auth=lambda: {"token": self._token},   # re-read on every reconnect
            transports=["websocket"],
            wait_timeout=timeout_s,
        )
        try:
            await asyncio.wait_for(self._ready.wait(), timeout_s)
        except asyncio.TimeoutError as e:
            await self.close()
            raise PipeError("CONNECT_TIMEOUT") from e

    async def ask(self, receiver_id: str, operation: str, input: dict | None = None,
                  timeout_s: float = 10.0) -> Any:
        if not self.ready:
            raise PipeError("OFFLINE")
        correlation_id = random_id(16)
        fut = asyncio.get_running_loop().create_future()
        self._pending[correlation_id] = fut
        await self._sio.emit("gateway", {
            "senderId": self.unit_name,
            "receiverId": receiver_id,
            "operation": operation,
            "input": {**(input or {}), "correlationId": correlation_id},
            "awaiting": True,
        })
        try:
            return await asyncio.wait_for(fut, timeout_s)
        except asyncio.TimeoutError as e:
            raise PipeError("TIMEOUT") from e
        finally:
            self._pending.pop(correlation_id, None)

    async def request(self, receiver_id: str, operation: str, input: dict | None = None) -> bool:
        """Fire and forget. Returns False when offline (nothing was sent)."""
        if not self.ready:
            return False
        await self._sio.emit("gateway", {
            "senderId": self.unit_name,
            "receiverId": receiver_id,
            "operation": operation,
            "input": input or {},
            "awaiting": False,
        })
        return True

    async def close(self) -> None:
        self._closed = True
        self._ready.clear()
        for fut in self._pending.values():
            if not fut.done():
                fut.set_exception(PipeError("CLOSED"))
        self._pending.clear()
        await self._sio.disconnect()

    # ── Socket events ───────────────────────────────────────────────────────

    def _status(self, status: str, detail: Any = None) -> None:
        if self._on_status:
            self._on_status(status, detail)

    async def _handle_gateway(self, data: Any) -> None:
        if data == HUB_READY:
            self._ready.set()
            self._status("ready")
            return
        if not isinstance(data, dict):
            log.debug("hub notice: %r", data)   # e.g. 'No unit found with given name.'
            return
        if data.get("receiverId") != self.unit_name:
            return

        reply: Reply | None = None
        if data.get("awaiting"):
            def reply(res: Any, _data=data) -> bool:
                if not self.ready:
                    return False
                asyncio.ensure_future(self._sio.emit("responseGateway", {**_data, "res": res}))
                return True

        inp = data.get("input")
        result = self._on_message(data.get("operation"), inp if isinstance(inp, dict) else {},
                                  data.get("senderId"), reply)
        if asyncio.iscoroutine(result):
            await result

    async def _handle_response(self, data: Any) -> None:
        inp = data.get("input") if isinstance(data, dict) else None
        cid = inp.get("correlationId") if isinstance(inp, dict) else None
        fut = self._pending.get(cid) if cid else None
        if fut and not fut.done():   # else: a late reply after a timeout, or not ours
            fut.set_result(data.get("res"))

    async def _handle_disconnect(self, *reason: Any) -> None:
        self._ready.clear()
        self._status("disconnected", reason[0] if reason else None)

    async def _handle_connect_error(self, data: Any = None) -> None:
        self._ready.clear()
        self._status("error", data)
        message = data.get("message", "") if isinstance(data, dict) else str(data or "")
        if "token" in message.lower() and not self._closed:
            try:   # a rejected token (e.g. the hub secret changed) needs a fresh one
                self._token = await self._token_fn(self.auth_url, self.unit_name)
            except Exception:   # the next reconnect attempt tries again
                pass
