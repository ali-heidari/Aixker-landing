import asyncio

import pytest

from pipes_client import PipeClient, PipeError


class FakeSio:
    """Stands in for socketio.AsyncClient. The test plays the hub."""

    def __init__(self):
        self.handlers = {}
        self.emitted = []
        self.connect_args = None

    def on(self, event, handler):
        self.handlers[event] = handler

    async def connect(self, url, **kwargs):
        self.connect_args = (url, kwargs)

    async def emit(self, event, data):
        self.emitted.append((event, data))

    async def disconnect(self):
        pass

    async def fire(self, event, *args):
        await self.handlers[event](*args)


async def token(auth_url, unit):
    return "jwt"


def make(on_message=lambda *a: None):
    sio = FakeSio()
    pipe = PipeClient("http://hub:3000", "http://hub:16916", "me", on_message,
                      sio_factory=lambda: sio, token_fn=token)
    return pipe, sio


async def ready(pipe, sio):
    connecting = asyncio.create_task(pipe.connect(timeout_s=1))
    await asyncio.sleep(0)
    await sio.fire("gateway", 200)
    await connecting


def run(coro):
    return asyncio.run(coro)


def test_connects_websocket_only_with_token_in_auth_and_name_in_query():
    async def go():
        pipe, sio = make()
        await ready(pipe, sio)
        url, kw = sio.connect_args
        assert url == "http://hub:3000?name=me"
        assert kw["transports"] == ["websocket"]
        assert kw["auth"]() == {"token": "jwt"}
    run(go())


def test_connect_times_out_without_the_ready_signal():
    async def go():
        pipe, sio = make()
        with pytest.raises(PipeError) as e:
            await pipe.connect(timeout_s=0.05)
        assert e.value.code == "CONNECT_TIMEOUT"
    run(go())


def test_concurrent_asks_get_their_own_replies():
    async def go():
        pipe, sio = make()
        await ready(pipe, sio)
        a = asyncio.create_task(pipe.ask("other", "OP", {"n": 1}))
        b = asyncio.create_task(pipe.ask("other", "OP", {"n": 2}))
        await asyncio.sleep(0)
        sent = [d for e, d in sio.emitted if e == "gateway"]
        assert len({d["input"]["correlationId"] for d in sent}) == 2
        for d in reversed(sent):   # replies arrive in the other order
            await sio.fire("responseGateway", {**d, "res": d["input"]["n"] * 10})
        assert await a == 10 and await b == 20
        assert pipe.pending_count() == 0
    run(go())


def test_ask_times_out_and_ignores_a_late_reply():
    async def go():
        pipe, sio = make()
        await ready(pipe, sio)
        with pytest.raises(PipeError) as e:
            await pipe.ask("other", "OP", {}, timeout_s=0.02)
        assert e.value.code == "TIMEOUT"
        late = sio.emitted[-1][1]
        await sio.fire("responseGateway", {**late, "res": 1})   # must not raise
        assert pipe.pending_count() == 0
    run(go())


def test_ask_before_ready_is_offline_and_sends_nothing():
    async def go():
        pipe, sio = make()
        with pytest.raises(PipeError) as e:
            await pipe.ask("other", "OP")
        assert e.value.code == "OFFLINE" and sio.emitted == []
        assert await pipe.request("other", "OP") is False
    run(go())


def test_close_rejects_pending_asks():
    async def go():
        pipe, sio = make()
        await ready(pipe, sio)
        a = asyncio.create_task(pipe.ask("other", "OP"))
        await asyncio.sleep(0)
        await pipe.close()
        with pytest.raises(PipeError) as e:
            await a
        assert e.value.code == "CLOSED"
    run(go())


def test_inbound_ask_gets_reply_with_the_same_envelope():
    seen = []

    def on_message(op, inp, sender, reply):
        seen.append((op, inp, sender))
        reply({"ok": True})

    async def go():
        pipe, sio = make(on_message)
        await ready(pipe, sio)
        env = {"senderId": "tab", "receiverId": "me", "operation": "HELLO",
               "input": {"correlationId": "abc"}, "awaiting": True}
        await sio.fire("gateway", env)
        await sio.fire("gateway", {**env, "receiverId": "someone-else"})
        await asyncio.sleep(0)
        assert seen == [("HELLO", {"correlationId": "abc"}, "tab")]
        assert sio.emitted[-1] == ("responseGateway", {**env, "res": {"ok": True}})
    run(go())


def test_disconnect_drops_ready_until_the_next_200():
    async def go():
        pipe, sio = make()
        await ready(pipe, sio)
        await sio.fire("disconnect", "transport close")
        assert not pipe.ready
        await sio.fire("gateway", 200)
        assert pipe.ready
    run(go())


def test_rejected_token_is_refreshed():
    calls = []

    async def counting_token(auth_url, unit):
        calls.append(unit)
        return f"jwt{len(calls)}"

    async def go():
        sio = FakeSio()
        pipe = PipeClient("http://hub:3000", "http://a", "me", lambda *a: None,
                          sio_factory=lambda: sio, token_fn=counting_token)
        await ready(pipe, sio)
        await sio.fire("connect_error", {"message": "Invalid token"})
        assert sio.connect_args[1]["auth"]() == {"token": "jwt2"}
    run(go())
