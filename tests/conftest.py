"""
Shared fixtures for backend tests.

`decky` and `settings` are injected by Decky Loader at runtime, so they are
stubbed here before `main` is imported.
"""
import asyncio
import json
import sys
import tempfile
import types
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

_stub_root = Path(tempfile.mkdtemp(prefix="gtm-tests-"))

decky_stub = types.ModuleType("decky")
decky_stub.DECKY_PLUGIN_DIR = str(_stub_root / "plugin")
decky_stub.DECKY_PLUGIN_RUNTIME_DIR = str(_stub_root / "runtime")
decky_stub.DECKY_PLUGIN_SETTINGS_DIR = str(_stub_root / "settings")
decky_stub.DECKY_PLUGIN_LOG_DIR = str(_stub_root / "logs")
sys.modules["decky"] = decky_stub


class FakeSettingsManager:
    def __init__(self, name, settings_directory=None):
        self.name = name
        self.settings_directory = settings_directory
        self.settings = {}

    def getSetting(self, key, defaults=None):
        return self.settings.get(key, defaults)

    def setSetting(self, key, value):
        self.settings[key] = value


settings_stub = types.ModuleType("settings")
settings_stub.SettingsManager = FakeSettingsManager
sys.modules["settings"] = settings_stub

import main  # noqa: E402


@pytest.fixture
def plugin(tmp_path, monkeypatch):
    """A Plugin instance whose directories all live under tmp_path."""
    plugin_dir = tmp_path / "plugin"
    (plugin_dir / "bin").mkdir(parents=True)
    monkeypatch.setattr(main.decky, "DECKY_PLUGIN_DIR", str(plugin_dir))

    p = main.Plugin()
    p.music_path = str(tmp_path / "music")
    p.cache_path = str(tmp_path / "cache")
    Path(p.music_path).mkdir()
    Path(p.cache_path).mkdir()
    p.settings = FakeSettingsManager("config")
    p.yt_process = None
    return p


# --------------------------------------------------------------------------- #
# Fake aiohttp
# --------------------------------------------------------------------------- #


class FakeContent:
    def __init__(self, body: bytes):
        self._body = body

    async def iter_chunked(self, size):
        for i in range(0, len(self._body), size):
            yield self._body[i:i + size]


class FakeResponse:
    def __init__(self, body=b"", status=200, headers=None, json_data=None):
        if json_data is not None:
            body = json.dumps(json_data).encode()
        self._body = body
        self.status = status
        self.headers = headers or {}
        self.content = FakeContent(body)

    def raise_for_status(self):
        if self.status >= 400:
            raise RuntimeError(f"HTTP {self.status}")

    async def text(self):
        return self._body.decode()

    async def json(self):
        return json.loads(self._body.decode())

    async def read(self):
        return self._body

    # usable both as `await session.get()` and `async with session.get()`
    def __await__(self):
        async def _self():
            return self
        return _self().__await__()

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False


class FakeSession:
    """Routes GET requests through a handler(url, params) -> FakeResponse."""

    def __init__(self, handler, calls):
        self._handler = handler
        self._calls = calls

    def get(self, url, params=None, **kwargs):
        self._calls.append({"url": url, "params": params, **kwargs})
        return self._handler(url, params)

    async def close(self):
        pass

    @property
    def closed(self):
        return False

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False


@pytest.fixture
def fake_http(monkeypatch):
    """
    Install a fake aiohttp.ClientSession. Returns an object with:
      - .routes: dict mapping URL prefix -> FakeResponse | callable(url, params)
      - .calls: list of request dicts
    """

    class Http:
        routes = {}
        calls = []

    http = Http()
    http.routes = {}
    http.calls = []

    def handler(url, params):
        for prefix, resp in http.routes.items():
            if url.startswith(prefix):
                return resp(url, params) if callable(resp) else resp
        return FakeResponse(b"not found", status=404)

    monkeypatch.setattr(
        main.aiohttp, "ClientSession",
        lambda *a, **kw: FakeSession(handler, http.calls),
    )
    return http


# --------------------------------------------------------------------------- #
# Fake subprocess
# --------------------------------------------------------------------------- #


class FakeProcess:
    def __init__(self, stdout=b"", stderr=b"", returncode=0):
        self._stdout_data = stdout
        self._stderr_data = stderr
        self._final_returncode = returncode
        self.returncode = None
        self.stdout = asyncio.StreamReader()
        self.stdout.feed_data(stdout)
        self.stdout.feed_eof()
        self.stderr = asyncio.StreamReader()
        self.stderr.feed_data(stderr)
        self.stderr.feed_eof()
        self.terminated = False
        self.killed = False

    async def communicate(self):
        self.returncode = self._final_returncode
        return self._stdout_data, self._stderr_data

    async def wait(self):
        self.returncode = self._final_returncode
        return self.returncode

    def terminate(self):
        self.terminated = True
        self.returncode = -15

    def kill(self):
        self.killed = True
        self.returncode = -9


@pytest.fixture
def fake_exec(monkeypatch):
    """
    Replace asyncio.create_subprocess_exec. Set `.next` to a FakeProcess (or a
    callable(args) -> FakeProcess). All invocations are recorded in `.calls`.
    """

    class Exec:
        next = None
        calls = []

    ex = Exec()
    ex.calls = []

    async def create(*args, **kwargs):
        ex.calls.append({"args": list(args), "kwargs": kwargs})
        proc = ex.next(args) if callable(ex.next) else ex.next
        if proc is None:
            proc = FakeProcess()
        return proc

    monkeypatch.setattr(main.asyncio, "create_subprocess_exec", create)
    return ex
