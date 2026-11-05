import asyncio
import base64
import contextlib
import datetime
import glob
import hashlib
import ipaddress
import json
import logging
import os
import platform
import re
import shutil
import ssl
import sys
import time
import uuid
from pathlib import Path
from urllib.parse import quote, urlparse

import aiohttp
from aiohttp import web
import certifi

import decky
from settings import SettingsManager

# Decky already routes its logger to the plugin log file; only configure
# logging ourselves when running outside Decky (tests, standalone).
logger = getattr(decky, "logger", None)
if logger is None:
    logging.basicConfig(
        level=logging.INFO,
        format='[%(asctime)s] [%(levelname)s] [%(name)s] %(message)s',
        handlers=[logging.StreamHandler(sys.stdout)],
    )
    logger = logging.getLogger("GameThemeMusic")

AUDIO_EXTENSIONS = (
    "mp3", "ogg", "flac", "m4a", "wav", "aac", "opus", "webm", "weba", "mp4",
)
IMPORTABLE_EXTENSIONS = {
    ".mp3", ".m4a", ".webm", ".ogg", ".wav", ".flac", ".aac", ".opus",
}

MIME_TYPES = {
    "mp3": "audio/mpeg",
    "m4a": "audio/mp4",
    "mp4": "audio/mp4",
    "webm": "audio/webm",
    "weba": "audio/webm",
    "ogg": "audio/ogg",
    "opus": "audio/ogg",
    "wav": "audio/wav",
    "flac": "audio/flac",
    "aac": "audio/aac",
}

BROWSER_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
    )
}

# Audio is handed to the frontend as a base64 data URL over Decky's
# websocket; anything larger than this would stall the UI.
MAX_INLINE_AUDIO_BYTES = 60 * 1024 * 1024
MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024
MAX_PAGE_BYTES = 5 * 1024 * 1024
# Downloaded (not imported) audio is a cache: oldest files are evicted once
# the folder grows past this. Evicted tracks can be restored from the settings.
MAX_DOWNLOADS_TOTAL_BYTES = 1024 * 1024 * 1024
BACKUPS_TO_KEEP = 20

HTTP_TIMEOUT = aiohttp.ClientTimeout(total=120, connect=15, sock_read=30)
PAGE_TIMEOUT = aiohttp.ClientTimeout(total=15)

YT_SEARCH_RESULTS = 15
MAX_ACTIVE_SEARCHES = 4
# yt-dlp "search" extractors, one per source tab.
YTDLP_SEARCH_PREFIXES = {
    "youtube": "ytsearch",
    "soundcloud": "scsearch",
}
YT_SEARCH_LINE_TIMEOUT = 45
YT_RESOLVE_TIMEOUT = 60
YT_DOWNLOAD_TIMEOUT = 300
YTDLP_UPDATE_INTERVAL = 24 * 60 * 60

YT_AUDIO_FORMAT = "bestaudio[protocol^=http][protocol!*=m3u8]/bestaudio/best"
YOUTUBE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")
ITUNES_ID_RE = re.compile(r"^\d{1,20}$")
DEEZER_ID_RE = re.compile(r"^\d{1,20}$")
# Names the plugin itself gives to downloaded audio (everything else in the
# legacy single music folder is something the user imported).
DOWNLOADED_STEM_RE = re.compile(
    r"^(?:[A-Za-z0-9_-]{11}|[0-9a-f]{32}|itunes_\d+|deezer_\d+)$"
)
LOCAL_SEARCH_STOP_WORDS = {
    "main", "theme", "music", "ost", "soundtrack", "the", "of", "a", "and",
}


def get_audio_filename(id: str) -> str:
    """
    File stem used to store audio for a media id. URL ids (KHInsider) are
    hashed so they are filesystem safe.
    """
    if id.startswith("https://") or id.startswith("http://"):
        return hashlib.md5(id.encode()).hexdigest()
    return id


def infer_download_extension(url: str) -> str:
    ext = url.split("?", 1)[0].rsplit(".", 1)[-1].lower()
    if ext not in AUDIO_EXTENSIONS:
        return "webm"
    return ext


def is_safe_stem(stem: str) -> bool:
    """A file stem that cannot escape the directory it is joined to."""
    return (
        isinstance(stem, str)
        and 0 < len(stem) <= 200
        and stem not in (".", "..")
        and not stem.startswith(".")
        and "/" not in stem
        and "\\" not in stem
        and "\x00" not in stem
        # "C:foo" would be joined as a drive-relative path on Windows.
        and not (os.name == "nt" and ":" in stem)
    )


def sanitize_name(name: str) -> str:
    safe = "".join(c for c in name if c.isalnum() or c in (" ", "-", "_")).strip()
    return safe.replace(" ", "_")[:120]


def is_youtube_target(id: str) -> bool:
    if YOUTUBE_ID_RE.match(id):
        return True
    try:
        parsed = urlparse(id)
    except ValueError:
        return False
    host = (parsed.hostname or "").lower()
    return parsed.scheme in ("http", "https") and (
        host == "youtu.be" or host == "youtube.com" or host.endswith(".youtube.com")
    )


def is_soundcloud_target(id: str) -> bool:
    try:
        parsed = urlparse(id)
    except ValueError:
        return False
    host = (parsed.hostname or "").lower()
    return parsed.scheme in ("http", "https") and (
        host == "soundcloud.com" or host.endswith(".soundcloud.com")
    )


def is_ytdlp_target(id: str) -> bool:
    """Ids that yt-dlp is allowed to resolve or download."""
    return isinstance(id, str) and (is_youtube_target(id) or is_soundcloud_target(id))


def is_http_url(url: str) -> bool:
    try:
        return urlparse(url).scheme in ("http", "https")
    except ValueError:
        return False


def is_public_http_url(url: str) -> bool:
    """
    http(s) URL that does not point at this machine or the local network.
    Names are not resolved, so this only stops literal addresses and
    `localhost`, which is what scraped pages could plausibly smuggle in.
    """
    try:
        parsed = urlparse(url)
        host = (parsed.hostname or "").lower()
    except ValueError:
        return False
    if parsed.scheme not in ("http", "https") or not host:
        return False
    if host == "localhost" or host.endswith(".localhost") or host.endswith(".local"):
        return False
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return True
    return not (
        ip.is_private or ip.is_loopback or ip.is_link_local
        or ip.is_reserved or ip.is_multicast or ip.is_unspecified
    )


def to_data_url(path: str) -> str | None:
    size = os.path.getsize(path)
    if size > MAX_INLINE_AUDIO_BYTES:
        logger.warning(
            f"{path} is too large to play inline ({size} bytes, "
            f"limit {MAX_INLINE_AUDIO_BYTES})"
        )
        return None
    extension = Path(path).suffix.lstrip(".").lower()
    mime_type = MIME_TYPES.get(extension, f"audio/{extension}")
    with open(path, "rb") as file:
        return f"data:{mime_type};base64,{base64.b64encode(file.read()).decode()}"


def is_within(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


async def stream_to_file(response, dest: Path, max_bytes: int | None = None):
    """Write a response body to `dest` atomically, enforcing a size limit."""
    if max_bytes is None:
        max_bytes = MAX_DOWNLOAD_BYTES
    length = response.headers.get("content-length") if response.headers else None
    if length and length.isdigit() and int(length) > max_bytes:
        raise ValueError(f"Download too large ({length} bytes)")
    tmp = dest.with_name(f"{dest.name}.{uuid.uuid4().hex[:8]}.part")
    written = 0
    try:
        with open(tmp, "wb") as file:
            async for chunk in response.content.iter_chunked(64 * 1024):
                written += len(chunk)
                if written > max_bytes:
                    raise ValueError(f"Download exceeded {max_bytes} bytes")
                file.write(chunk)
        if written == 0:
            raise ValueError("Empty download")
        os.replace(tmp, dest)
    except BaseException:
        try:
            tmp.unlink()
        except OSError:
            pass
        raise


class Plugin:
    music_path = str(Path(decky.DECKY_PLUGIN_RUNTIME_DIR) / "music")
    local_path = str(Path(decky.DECKY_PLUGIN_RUNTIME_DIR) / "local")
    cache_path = str(Path(decky.DECKY_PLUGIN_RUNTIME_DIR) / "cache")
    runtime_bin_path = str(Path(decky.DECKY_PLUGIN_RUNTIME_DIR) / "bin")
    ssl_context = ssl.create_default_context(cafile=certifi.where())
    is_windows = platform.system() == "Windows"

    subprocess_flags = {}
    if is_windows:
        import subprocess as _subprocess
        subprocess_flags = {"creationflags": _subprocess.CREATE_NO_WINDOW}

    def __init__(self):
        # Every search gets its own yt-dlp process so concurrent searches
        # (game page, focus player, change-theme page) never steal each other's
        # results.
        self.searches: dict[str, asyncio.subprocess.Process] = {}
        self.running_processes: set = set()
        self.ytdlp_update_lock = asyncio.Lock()
        self.download_locks: dict[str, asyncio.Lock] = {}
        self.background_tasks: set = set()
        self.audio_runner = None
        self.audio_port: int | None = None

    async def _main(self):
        logger.info(f"Plugin initializing on {platform.system()} ({platform.machine()})")
        self.settings = SettingsManager(
            name="config", settings_directory=decky.DECKY_PLUGIN_SETTINGS_DIR
        )
        os.makedirs(self.music_path, exist_ok=True)
        os.makedirs(self.local_path, exist_ok=True)
        os.makedirs(self.cache_path, exist_ok=True)
        self._cleanup_partial_downloads()
        await asyncio.to_thread(self._migrate_legacy_local_files)
        logger.info(f"Music path: {self.music_path}")
        logger.info(f"Local path: {self.local_path}")
        logger.info(f"Cache path: {self.cache_path}")

        await self._start_audio_server()
        # Never block plugin startup on the network.
        self._spawn(self._startup_ytdlp_update())

    async def _unload(self):
        logger.info("Plugin unloading...")
        for task in list(self.background_tasks):
            task.cancel()
        await self._stop_all_processes()
        if self.audio_runner is not None:
            try:
                await self.audio_runner.cleanup()
            except Exception as e:
                logger.warning(f"Error stopping audio server: {e}")
            self.audio_runner = None
            self.audio_port = None
        logger.info("Plugin unloaded")

    def _spawn(self, coro):
        task = asyncio.create_task(coro)
        self.background_tasks.add(task)
        task.add_done_callback(self.background_tasks.discard)
        return task

    def _cleanup_partial_downloads(self):
        for leftover in Path(self.music_path).glob("*.part"):
            try:
                leftover.unlink()
            except OSError:
                pass

    def _migrate_legacy_local_files(self):
        """
        Older versions kept imported music in the downloads folder, where
        "Delete downloads" wiped it. Move anything that isn't named like a
        download into the local library.
        """
        music = Path(self.music_path)
        local = Path(self.local_path)
        if not music.is_dir():
            return
        local.mkdir(parents=True, exist_ok=True)
        for file in music.iterdir():
            try:
                if (
                    not file.is_file()
                    or file.suffix.lower() not in IMPORTABLE_EXTENSIONS
                    or DOWNLOADED_STEM_RE.match(file.stem)
                ):
                    continue
                target = local / file.name
                if target.exists():
                    continue
                shutil.move(str(file), str(target))
                logger.info(f"Moved imported file to the local library: {file.name}")
            except OSError as e:
                logger.warning(f"Could not migrate {file}: {e}")

    async def set_setting(self, key, value):
        logger.debug(f"Setting {key} = {value}")
        self.settings.setSetting(key, value)

    async def get_setting(self, key, default):
        value = self.settings.getSetting(key, default)
        logger.debug(f"Getting {key} = {value}")
        return value

    # ------------------------------------------------------------------ #
    # Local audio server
    # ------------------------------------------------------------------ #

    async def _start_audio_server(self):
        """
        Serve stored audio from 127.0.0.1 (with range requests) so the
        frontend streams it instead of receiving it as a base64 blob. If the
        server can't start, playback falls back to data URLs.
        """
        try:
            app = web.Application()
            app.router.add_get("/audio/{kind}/{name}", self._serve_audio)
            runner = web.AppRunner(app)
            await runner.setup()
            site = web.TCPSite(runner, "127.0.0.1", 0)
            await site.start()
            sockets = getattr(site._server, "sockets", None) or []
            port = sockets[0].getsockname()[1] if sockets else None
            if not port:
                await runner.cleanup()
                return
            self.audio_runner = runner
            self.audio_port = port
            logger.info(f"Audio server listening on 127.0.0.1:{port}")
        except Exception as e:
            logger.warning(f"Could not start the audio server, using data URLs: {e}")
            self.audio_runner = None
            self.audio_port = None

    def _audio_file_for(self, kind: str, name: str) -> Path | None:
        directory = {"music": self.music_path, "local": self.local_path}.get(kind)
        if directory is None:
            return None
        stem, ext = os.path.splitext(name)
        if not is_safe_stem(stem) or ext.lstrip(".").lower() not in AUDIO_EXTENSIONS:
            return None
        path = Path(directory) / name
        return path if path.is_file() else None

    async def _serve_audio(self, request):
        path = self._audio_file_for(
            request.match_info["kind"], request.match_info["name"]
        )
        if path is None:
            raise web.HTTPNotFound()
        mime = MIME_TYPES.get(path.suffix.lstrip(".").lower(), "application/octet-stream")
        return web.FileResponse(
            path, headers={"Content-Type": mime, "Cache-Control": "no-store"}
        )

    async def _audio_url_for(self, path: str) -> str | None:
        """Playable URL for a stored file: local server URL or a data URL."""
        file = Path(path)
        try:
            # Recently played tracks are the last to be evicted.
            os.utime(file)
        except OSError:
            pass
        if self.audio_port:
            kind = "local" if file.parent == Path(self.local_path) else "music"
            return f"http://127.0.0.1:{self.audio_port}/audio/{kind}/{quote(file.name)}"
        return await asyncio.to_thread(self._read_data_url, path)

    # ------------------------------------------------------------------ #
    # Subprocess helpers
    # ------------------------------------------------------------------ #

    def _ytdlp_exe_name(self) -> str:
        return "yt-dlp.exe" if self.is_windows else "yt-dlp"

    def _get_bundled_ytdlp_path(self) -> str:
        return str(Path(decky.DECKY_PLUGIN_DIR) / "bin" / self._ytdlp_exe_name())

    def _get_runtime_ytdlp_path(self) -> str:
        return str(Path(self.runtime_bin_path) / self._ytdlp_exe_name())

    def _get_ytdlp_path(self) -> str:
        """
        yt-dlp self-updates into the runtime dir; the binary Decky installed
        from `remote_binary` is never modified (Decky verifies its hash).
        """
        runtime = Path(self._get_runtime_ytdlp_path())
        if runtime.exists():
            return str(runtime)
        return self._get_bundled_ytdlp_path()

    def _get_env(self) -> dict:
        """Environment for subprocesses. Linux needs LD_LIBRARY_PATH set."""
        env = os.environ.copy()
        if not self.is_windows:
            env["LD_LIBRARY_PATH"] = "/usr/lib:/usr/lib64:/lib:/lib64"
        return env

    def _ensure_ytdlp(self) -> str | None:
        path = Path(self._get_ytdlp_path())
        try:
            if not path.exists():
                logger.error(f"yt-dlp binary not found at: {path}")
                return None
            if not self.is_windows:
                path.chmod(0o755)
        except OSError as e:
            logger.error(f"Error checking yt-dlp binary: {e}")
            return None
        return str(path)

    async def _exec(self, *args, stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE, **kwargs):
        return await asyncio.create_subprocess_exec(
            *args,
            stdout=stdout,
            stderr=stderr,
            env=self._get_env(),
            **self.subprocess_flags,
            **kwargs,
        )

    async def _stop_process(self, process, timeout: float = 5):
        """
        Stop a subprocess and everything it spawned. On Windows yt-dlp.exe is a
        PyInstaller launcher whose child keeps our pipes open, so the whole
        tree has to be killed or reads never reach EOF.
        """
        if process is None or process.returncode is not None:
            return
        try:
            if self.is_windows:
                killer = await asyncio.create_subprocess_exec(
                    "taskkill", "/T", "/F", "/PID", str(process.pid),
                    stdout=asyncio.subprocess.DEVNULL,
                    stderr=asyncio.subprocess.DEVNULL,
                    **self.subprocess_flags,
                )
                await asyncio.wait_for(killer.wait(), timeout=timeout)
            else:
                process.terminate()
            await asyncio.wait_for(process.wait(), timeout=timeout)
        except (asyncio.TimeoutError, ProcessLookupError, OSError):
            try:
                process.kill()
            except (ProcessLookupError, OSError):
                pass
        except Exception as e:
            logger.warning(f"Error stopping process: {e}")

    async def _stop_all_processes(self):
        """Stop every search and every in-flight yt-dlp invocation."""
        processes = list(self.searches.values()) + list(self.running_processes)
        self.searches.clear()
        for process in processes:
            await self._stop_process(process)

    async def _run(self, args: list, timeout: float):
        """Run a command to completion, killing it on timeout."""
        process = await self._exec(*args)
        self.running_processes.add(process)
        try:
            stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=timeout)
        except asyncio.TimeoutError:
            await self._stop_process(process)
            raise TimeoutError(f"{Path(args[0]).name} timed out after {timeout}s")
        except asyncio.CancelledError:
            await self._stop_process(process)
            raise
        finally:
            self.running_processes.discard(process)
        return process.returncode, stdout or b"", stderr or b""

    @contextlib.asynccontextmanager
    async def _download_guard(self, key: str):
        """Serialise downloads of the same file."""
        lock = self.download_locks.setdefault(key, asyncio.Lock())
        async with lock:
            yield
        if not lock.locked():
            self.download_locks.pop(key, None)

    # ------------------------------------------------------------------ #
    # yt-dlp binary management
    # ------------------------------------------------------------------ #

    async def get_ytdlp_version(self) -> str | None:
        ytdlp_path = self._get_ytdlp_path()
        if not Path(ytdlp_path).exists():
            logger.info("yt-dlp binary not found")
            return None
        try:
            returncode, stdout, _ = await self._run([ytdlp_path, "--version"], timeout=20)
            if returncode == 0 and stdout:
                version = stdout.decode(errors="replace").strip()
                logger.info(f"Current yt-dlp version: {version}")
                return version
            return None
        except Exception as e:
            logger.error(f"Error getting yt-dlp version: {e}")
            return None

    async def get_latest_ytdlp_release(self) -> dict | None:
        logger.info("Checking for latest yt-dlp release on GitHub")
        try:
            async with aiohttp.ClientSession(timeout=PAGE_TIMEOUT) as session:
                url = "https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest"
                headers = {"Accept": "application/vnd.github.v3+json"}
                async with session.get(url, headers=headers, ssl=self.ssl_context) as res:
                    res.raise_for_status()
                    data = await res.json()
                    tag_name = data.get("tag_name", "")
                    logger.info(f"Latest yt-dlp release: {tag_name}")
                    return {
                        "version": tag_name,
                        "assets": data.get("assets", []) or [],
                    }
        except Exception as e:
            logger.error(f"Error getting latest yt-dlp release: {e}")
            return None

    def _get_ytdlp_asset_name(self) -> str:
        system = platform.system()
        machine = platform.machine().lower()

        if system == "Windows":
            return "yt-dlp.exe"
        elif system == "Linux":
            if machine in ["x86_64", "amd64"]:
                return "yt-dlp_linux"
            elif machine in ["aarch64", "arm64"]:
                return "yt-dlp_linux_aarch64"
            elif machine.startswith("arm"):
                return "yt-dlp_linux_armv7l"
        elif system == "Darwin":
            return "yt-dlp_macos"

        logger.warning(f"Unknown platform {system}/{machine}, defaulting to yt-dlp_linux")
        return "yt-dlp_linux"

    async def _fetch_expected_sha256(self, assets: list, asset_name: str) -> str | None:
        sums_url = next(
            (a.get("browser_download_url") for a in assets
             if a.get("name") == "SHA2-256SUMS"),
            None,
        )
        if not sums_url:
            return None
        try:
            async with aiohttp.ClientSession(timeout=PAGE_TIMEOUT) as session:
                async with session.get(sums_url, ssl=self.ssl_context) as res:
                    res.raise_for_status()
                    text = await res.text()
        except Exception as e:
            logger.error(f"Could not fetch yt-dlp checksums: {e}")
            return None
        for line in text.splitlines():
            parts = line.split()
            if len(parts) == 2 and parts[1].lstrip("*") == asset_name:
                return parts[0].lower()
        return None

    async def download_ytdlp_binary(self, asset_url: str,
                                    expected_sha256: str | None = None) -> bool:
        """
        Download yt-dlp into the runtime directory and atomically replace the
        previous update. When `expected_sha256` is given the download must
        match it.
        """
        logger.info(f"Downloading yt-dlp binary from: {asset_url}")
        ytdlp_path = Path(self._get_runtime_ytdlp_path())
        temp_path = ytdlp_path.with_name(ytdlp_path.name + ".download")
        try:
            ytdlp_path.parent.mkdir(parents=True, exist_ok=True)
            async with aiohttp.ClientSession(timeout=HTTP_TIMEOUT) as session:
                async with session.get(asset_url, ssl=self.ssl_context) as res:
                    res.raise_for_status()
                    await stream_to_file(res, temp_path)

            if expected_sha256:
                digest = await asyncio.to_thread(
                    lambda: hashlib.sha256(temp_path.read_bytes()).hexdigest()
                )
                if digest != expected_sha256:
                    raise ValueError(
                        f"checksum mismatch (expected {expected_sha256}, got {digest})"
                    )

            if not self.is_windows:
                temp_path.chmod(0o755)
            os.replace(temp_path, ytdlp_path)

            logger.info(f"Successfully installed yt-dlp binary to {ytdlp_path}")
            return True
        except Exception as e:
            logger.error(f"Error downloading yt-dlp binary: {e}")
            try:
                temp_path.unlink()
            except OSError:
                pass
            return False

    async def check_and_update_ytdlp(self) -> bool:
        """
        Check for a new yt-dlp release and install it (checksum verified).
        :return: bool True if updated, False otherwise
        """
        async with self.ytdlp_update_lock:
            logger.info("Checking for yt-dlp updates")
            current_version = await self.get_ytdlp_version()
            latest_release = await self.get_latest_ytdlp_release()

            if latest_release is None:
                logger.warning("Could not get latest release info")
                return False

            latest_version = latest_release["version"]
            if current_version is not None:
                if current_version.lstrip("v") == latest_version.lstrip("v"):
                    logger.info(f"yt-dlp is up to date ({current_version})")
                    return False
                logger.info(f"New yt-dlp version available: {current_version} -> {latest_version}")
            else:
                logger.info("No working yt-dlp binary, downloading latest")

            asset_name = self._get_ytdlp_asset_name()
            assets = latest_release["assets"]
            asset_url = next(
                (a.get("browser_download_url") for a in assets
                 if a.get("name") == asset_name),
                None,
            )
            if asset_url is None:
                logger.error(f"Could not find asset {asset_name} in release")
                return False

            expected = await self._fetch_expected_sha256(assets, asset_name)
            if expected is None:
                logger.error("No checksum published for yt-dlp asset, refusing to update")
                return False

            # Windows cannot replace a running executable.
            await self._stop_all_processes()

            if await self.download_ytdlp_binary(asset_url, expected):
                new_version = await self.get_ytdlp_version()
                logger.info(f"yt-dlp updated successfully to version {new_version}")
                return True
            logger.error("Failed to update yt-dlp")
            return False

    async def _startup_ytdlp_update(self):
        try:
            last = self.settings.getSetting("ytdlp_last_update_check", 0) or 0
            binary_missing = not Path(self._get_ytdlp_path()).exists()
            if not binary_missing and time.time() - float(last) < YTDLP_UPDATE_INTERVAL:
                logger.info("Skipping yt-dlp update check (checked recently)")
                return
            await self.check_and_update_ytdlp()
            self.settings.setSetting("ytdlp_last_update_check", time.time())
        except asyncio.CancelledError:
            raise
        except Exception as e:
            logger.error(f"Error checking for yt-dlp updates: {e}")

    async def update_yt_dlp(self):
        """
        Manually triggered yt-dlp update (settings button).
        :return: dict with 'success' and 'message'
        """
        try:
            updated = await self.check_and_update_ytdlp()
            version = await self.get_ytdlp_version()
            self.settings.setSetting("ytdlp_last_update_check", time.time())
            if updated:
                return {"success": True, "message": f"Updated yt-dlp to {version}"}
            if version is not None:
                return {"success": True, "message": f"yt-dlp is up to date ({version})"}
            return {"success": False, "message": "Could not update yt-dlp"}
        except Exception as e:
            logger.error(f"Error updating yt-dlp: {e}")
            return {"success": False, "message": f"Error updating yt-dlp: {e}"}

    # ------------------------------------------------------------------ #
    # yt-dlp sources (YouTube, SoundCloud)
    # ------------------------------------------------------------------ #

    async def search_yt(self, term: str, provider: str = "youtube"):
        """
        Start a search and return its id (None if it cannot run). Uses flat
        extraction (metadata only), which returns in a second or two instead
        of resolving every result's streams; the stream URL is resolved on
        demand by single_yt_url. Results are read with next_yt_result and the
        search is released with close_search.
        """
        logger.info(f"Searching {provider} for: {term}")
        prefix = YTDLP_SEARCH_PREFIXES.get(provider)
        if prefix is None:
            raise ValueError(f"Unknown search provider: {provider!r}")
        ytdlp_path = self._ensure_ytdlp()
        if ytdlp_path is None:
            return None

        term = (term or "").strip()[:200]
        if not term:
            return None

        while len(self.searches) >= MAX_ACTIVE_SEARCHES:
            oldest = next(iter(self.searches))
            await self._stop_process(self.searches.pop(oldest))

        try:
            process = await self._exec(
                ytdlp_path,
                f"{prefix}{YT_SEARCH_RESULTS}:{term}",
                "-j",
                "--flat-playlist",
                "--match-filters",
                f"duration<?{20 * 60}",
                "--no-warnings",
                stderr=asyncio.subprocess.DEVNULL,
                limit=10 * 1024 ** 2,
            )
        except Exception as e:
            logger.error(f"Error starting yt-dlp search: {e}")
            raise
        search_id = uuid.uuid4().hex[:12]
        self.searches[search_id] = process
        logger.info(f"yt-dlp {provider} search {search_id} started for: {term}")
        return search_id

    async def next_yt_result(self, search_id: str | None = None):
        """Next result of a search (the newest one when no id is given)."""
        if search_id is None and self.searches:
            search_id = next(reversed(self.searches))
        process = self.searches.get(search_id) if search_id else None
        while True:
            if not process or not process.stdout:
                return None
            try:
                raw = await asyncio.wait_for(
                    process.stdout.readline(), timeout=YT_SEARCH_LINE_TIMEOUT
                )
            except (asyncio.TimeoutError, ValueError) as e:
                logger.warning(f"yt-dlp search stalled: {e!r}")
                self.searches.pop(search_id, None)
                await self._stop_process(process)
                return None
            if not raw:
                logger.debug("No more search results")
                self.searches.pop(search_id, None)
                return None
            line = raw.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
            except json.JSONDecodeError as e:
                logger.error(f"Error parsing search result: {e}")
                continue
            result = self.entry_to_info(entry)
            if result["id"]:
                return result

    async def close_search(self, search_id: str):
        """Release a search that is no longer being read."""
        process = self.searches.pop(search_id, None)
        await self._stop_process(process)

    @staticmethod
    def entry_to_info(entry):
        thumbnails = entry.get("thumbnails") or []
        thumbnail = entry.get("thumbnail") or (
            (thumbnails[-1] or {}).get("url") if thumbnails else None
        )
        video_id = entry.get("id")
        url = entry.get("url")
        # SoundCloud ids are numeric and unusable on their own; the track URL
        # is what yt-dlp resolves.
        if isinstance(url, str) and is_soundcloud_target(url):
            video_id = url
        if not thumbnail and isinstance(video_id, str) and YOUTUBE_ID_RE.match(video_id):
            thumbnail = f"https://i.ytimg.com/vi/{video_id}/hqdefault.jpg"
        return {
            "url": entry.get("url"),
            "title": entry.get("title"),
            "id": video_id,
            "thumbnail": thumbnail,
        }

    async def single_yt_url(self, id_yt: str):
        """
        Playable audio URL for a YouTube/SoundCloud track: the stored file if
        there is one, otherwise a direct stream URL. Streams the browser
        cannot play (HLS) are downloaded first.
        """
        logger.info(f"Getting audio URL for: {id_yt}")
        if not is_ytdlp_target(id_yt):
            logger.warning(f"Refusing invalid yt-dlp id: {id_yt!r}")
            return None

        local = await self.local_audio_url(id_yt)
        if local is not None:
            return local

        ytdlp_path = self._ensure_ytdlp()
        if ytdlp_path is None:
            return None
        try:
            returncode, stdout, stderr = await self._run(
                [ytdlp_path, "-j", "-f", YT_AUDIO_FORMAT, "--no-playlist",
                 "--no-warnings", "--", id_yt],
                timeout=YT_RESOLVE_TIMEOUT,
            )
            output = stdout.strip()
            if returncode != 0 or not output:
                logger.warning(
                    f"yt-dlp could not resolve {id_yt}: "
                    f"{stderr.decode(errors='replace').strip()[:500]}"
                )
                return None
            info = json.loads(output)
            url = info.get("url")
            if not url:
                return None
            if "m3u8" in str(info.get("protocol", "")) or ".m3u8" in url:
                logger.info(f"{id_yt} is HLS only, downloading it instead")
                await self.download_yt_audio(id_yt)
                return await self.local_audio_url(id_yt)
            logger.info(f"Got audio URL for: {id_yt}")
            return url
        except Exception as e:
            logger.error(f"Error getting audio URL for {id_yt}: {e}")
            return None

    async def download_yt_audio(self, id_yt: str):
        """Download audio for a YouTube/SoundCloud track. Raises on failure."""
        if not is_ytdlp_target(id_yt):
            raise ValueError(f"Invalid yt-dlp id: {id_yt!r}")

        filename = get_audio_filename(id_yt)
        async with self._download_guard(filename):
            if self.local_match(filename) is not None:
                logger.info(f"Audio already downloaded for: {id_yt}")
                return

            ytdlp_path = self._ensure_ytdlp()
            if ytdlp_path is None:
                raise RuntimeError("yt-dlp is not installed")

            logger.info(f"Downloading audio for: {id_yt}")
            cmd = [
                ytdlp_path,
                "-f", YT_AUDIO_FORMAT,
                "-o", f"{filename}.%(ext)s",
                "-P", self.music_path,
                "--no-playlist",
                "--no-warnings",
                "--", id_yt,
            ]
            try:
                returncode, _, stderr = await self._run(cmd, timeout=YT_DOWNLOAD_TIMEOUT)
            except Exception:
                self._remove_incomplete(filename)
                raise
            if returncode != 0:
                self._remove_incomplete(filename)
                err = stderr.decode(errors="replace").strip()[:1000] or "Unknown error"
                raise RuntimeError(f"yt-dlp failed ({returncode}): {err}")
            downloaded = self.local_match(filename)
            if downloaded is None:
                raise RuntimeError(f"yt-dlp finished but no audio file for {id_yt}")
            logger.info(f"Successfully downloaded audio for: {id_yt}")
            await self._enforce_download_cap(keep=downloaded)

    def _remove_incomplete(self, stem: str):
        pattern = os.path.join(glob.escape(self.music_path), f"{glob.escape(stem)}.*")
        for path in glob.glob(pattern):
            if path.endswith((".part", ".ytdl", ".temp")) or ".part-" in path:
                try:
                    os.remove(path)
                except OSError:
                    pass

    async def _enforce_download_cap(self, keep: str | None = None):
        """Evict the least recently played downloads once over the size cap."""
        await asyncio.to_thread(self._evict_old_downloads, keep)

    def _evict_old_downloads(self, keep: str | None):
        files = []
        try:
            for file in Path(self.music_path).iterdir():
                if not file.is_file() or file.name.endswith(".part"):
                    continue
                stat = file.stat()
                files.append((stat.st_mtime, stat.st_size, file))
        except OSError:
            return
        total = sum(size for _, size, _ in files)
        if total <= MAX_DOWNLOADS_TOTAL_BYTES:
            return
        for _, size, file in sorted(files, key=lambda item: item[0]):
            if total <= MAX_DOWNLOADS_TOTAL_BYTES:
                break
            if keep is not None and str(file) == str(keep):
                continue
            try:
                file.unlink()
                total -= size
                logger.info(f"Evicted old download {file.name} (over cache limit)")
            except OSError:
                pass

    # ------------------------------------------------------------------ #
    # Web pages / direct downloads / preview providers
    # ------------------------------------------------------------------ #

    async def fetch_url(self, url: str) -> str:
        """Fetch a web page as text (used by the KHInsider scraper)."""
        if not is_public_http_url(url):
            logger.warning(f"fetch_url refused url: {url!r}")
            return ""
        try:
            async with aiohttp.ClientSession(timeout=PAGE_TIMEOUT) as session:
                async with session.get(
                    url, headers=BROWSER_HEADERS, ssl=self.ssl_context
                ) as response:
                    if response.status >= 400:
                        logger.warning(f"fetch_url {url} -> HTTP {response.status}")
                        return ""
                    body = bytearray()
                    async for chunk in response.content.iter_chunked(64 * 1024):
                        body.extend(chunk)
                        if len(body) >= MAX_PAGE_BYTES:
                            logger.warning(f"fetch_url truncated {url} at {MAX_PAGE_BYTES} bytes")
                            break
                    charset = getattr(response, "charset", None) or "utf-8"
                    return bytes(body).decode(charset, errors="replace")
        except Exception as e:
            logger.error(f"fetch_url error for {url}: {e}")
            return ""

    async def download_url(self, url: str, id_to_save_as: str):
        """
        Download audio from a direct URL (KHInsider) or a provider preview
        (Apple Music, Deezer). Raises on failure.
        """
        logger.info(f"Downloading audio for ID: {id_to_save_as}")
        if isinstance(url, str) and url.startswith("data:"):
            logger.info("Skipping download because URL is already local audio data")
            return
        if id_to_save_as.startswith("itunes_"):
            await self.download_itunes(id_to_save_as)
            return
        if id_to_save_as.startswith("deezer_"):
            await self.download_deezer(id_to_save_as)
            return

        stem = get_audio_filename(id_to_save_as)
        if not is_safe_stem(stem):
            raise ValueError(f"Invalid id: {id_to_save_as!r}")
        if not is_public_http_url(url):
            raise ValueError(f"Invalid download url: {url!r}")

        headers = dict(BROWSER_HEADERS)
        host = (urlparse(url).hostname or "").lower()
        if host == "khinsider.com" or host.endswith(".khinsider.com"):
            headers["Referer"] = (
                id_to_save_as if id_to_save_as.startswith("https://")
                else "https://downloads.khinsider.com/"
            )
        async with self._download_guard(stem):
            existing = self.local_match(stem)
            if existing is not None:
                logger.info(f"Audio already downloaded for ID: {id_to_save_as}")
                return
            try:
                async with aiohttp.ClientSession(timeout=HTTP_TIMEOUT) as session:
                    async with session.get(url, headers=headers, ssl=self.ssl_context) as res:
                        res.raise_for_status()
                        ext = os.path.splitext(urlparse(url).path)[1].lstrip(".").lower()
                        if ext not in AUDIO_EXTENSIONS:
                            ctype = (res.headers or {}).get("content-type", "")
                            if "mpeg" in ctype or "mp3" in ctype:
                                ext = "mp3"
                            elif "ogg" in ctype:
                                ext = "ogg"
                            elif "wav" in ctype:
                                ext = "wav"
                            elif "flac" in ctype:
                                ext = "flac"
                            elif "mp4" in ctype or "m4a" in ctype:
                                ext = "m4a"
                            else:
                                ext = "webm"
                        dest = Path(self.music_path) / f"{stem}.{ext}"
                        await stream_to_file(res, dest)
                logger.info(f"Successfully downloaded audio from URL for ID: {id_to_save_as}")
            except Exception as e:
                logger.error(f"Error downloading from URL for ID {id_to_save_as}: {e}")
                raise
            await self._enforce_download_cap(keep=str(dest))

    async def _download_preview(self, stem: str, ext: str, lookup):
        """
        Download a provider's preview clip. `lookup(session)` returns the
        preview URL.
        """
        dest_path = Path(self.music_path) / f"{stem}.{ext}"
        async with self._download_guard(stem):
            if dest_path.exists():
                return
            async with aiohttp.ClientSession(timeout=HTTP_TIMEOUT) as session:
                preview_url = await lookup(session)
                if not preview_url or not is_public_http_url(preview_url):
                    raise RuntimeError(f"No preview available for {stem}")
                async with session.get(preview_url, ssl=self.ssl_context) as audio_res:
                    audio_res.raise_for_status()
                    await stream_to_file(audio_res, dest_path)
            logger.info(f"Successfully downloaded preview to {dest_path}")
            await self._enforce_download_cap(keep=str(dest_path))

    async def download_itunes(self, track_id: str):
        """Download the audio preview of an iTunes track. Raises on failure."""
        logger.info(f"Downloading iTunes audio for ID: {track_id}")
        if track_id.startswith("itunes_"):
            track_id = track_id.split("_", 1)[1]
        if not ITUNES_ID_RE.match(track_id):
            raise ValueError(f"Invalid iTunes track id: {track_id!r}")

        async def lookup(session):
            async with session.get(
                "https://itunes.apple.com/lookup",
                params={"id": track_id, "entity": "song"},
                ssl=self.ssl_context,
            ) as res:
                res.raise_for_status()
                try:
                    data = json.loads(await res.text())
                except Exception as e:
                    raise RuntimeError(f"Invalid iTunes lookup response: {e}")
            results = (data or {}).get("results") or []
            return results[0].get("previewUrl") if results else None

        await self._download_preview(f"itunes_{track_id}", "m4a", lookup)

    async def download_deezer(self, track_id: str):
        """Download the 30 second preview of a Deezer track. Raises on failure."""
        logger.info(f"Downloading Deezer audio for ID: {track_id}")
        if track_id.startswith("deezer_"):
            track_id = track_id.split("_", 1)[1]
        if not DEEZER_ID_RE.match(track_id):
            raise ValueError(f"Invalid Deezer track id: {track_id!r}")

        async def lookup(session):
            # Preview links carry an expiring token, so always ask for a fresh one.
            async with session.get(
                f"https://api.deezer.com/track/{track_id}", ssl=self.ssl_context
            ) as res:
                res.raise_for_status()
                try:
                    data = json.loads(await res.text())
                except Exception as e:
                    raise RuntimeError(f"Invalid Deezer response: {e}")
            return (data or {}).get("preview")

        await self._download_preview(f"deezer_{track_id}", "mp3", lookup)

    async def search_itunes(self, term: str, limit: int = 10):
        """Search iTunes for songs matching `term`."""
        logger.info(f"Searching iTunes for: {term}")
        try:
            limit = max(1, min(int(limit), 50))
            async with aiohttp.ClientSession(timeout=PAGE_TIMEOUT) as session:
                params = {
                    "term": (term or "")[:200],
                    "media": "music",
                    "entity": "song",
                    "limit": limit,
                    "attribute": "songTerm",
                }
                async with session.get(
                    "https://itunes.apple.com/search", params=params, ssl=self.ssl_context
                ) as res:
                    res.raise_for_status()
                    try:
                        data = json.loads(await res.text())
                    except Exception as e:
                        logger.error(f"Error decoding iTunes response as JSON: {e}")
                        return []

            results = []
            for item in (data or {}).get("results") or []:
                if not item.get("trackId") or not item.get("previewUrl"):
                    continue
                results.append({
                    "id": f"itunes_{item.get('trackId')}",
                    "title": f"{item.get('trackName', '')} - {item.get('artistName', '')}",
                    "url": item.get("previewUrl", ""),
                    "thumbnail": (item.get("artworkUrl100") or "").replace("100x100", "600x600"),
                    "artist": item.get("artistName", ""),
                    "album": item.get("collectionName", ""),
                    "duration": (item.get("trackTimeMillis") or 0) // 1000,
                })
            logger.info(f"Found {len(results)} iTunes results for: {term}")
            return results
        except Exception as e:
            logger.error(f"Error searching iTunes: {e}")
            return []

    async def search_deezer(self, term: str, limit: int = 10):
        """Search Deezer for songs matching `term` (30 second previews)."""
        logger.info(f"Searching Deezer for: {term}")
        try:
            limit = max(1, min(int(limit), 50))
            async with aiohttp.ClientSession(timeout=PAGE_TIMEOUT) as session:
                params = {"q": (term or "")[:200], "limit": limit}
                async with session.get(
                    "https://api.deezer.com/search", params=params, ssl=self.ssl_context
                ) as res:
                    res.raise_for_status()
                    try:
                        data = json.loads(await res.text())
                    except Exception as e:
                        logger.error(f"Error decoding Deezer response as JSON: {e}")
                        return []

            results = []
            for item in (data or {}).get("data") or []:
                track_id = item.get("id")
                preview = item.get("preview")
                if not track_id or not preview:
                    continue
                artist = (item.get("artist") or {}).get("name", "")
                album = item.get("album") or {}
                results.append({
                    "id": f"deezer_{track_id}",
                    "title": f"{item.get('title', '')} - {artist}",
                    "url": preview,
                    "thumbnail": album.get("cover_big") or album.get("cover_medium") or "",
                    "artist": artist,
                    "album": album.get("title", ""),
                    "duration": item.get("duration") or 0,
                })
            logger.info(f"Found {len(results)} Deezer results for: {term}")
            return results
        except Exception as e:
            logger.error(f"Error searching Deezer: {e}")
            return []

    # ------------------------------------------------------------------ #
    # Stored audio
    # ------------------------------------------------------------------ #

    def local_match(self, id_local: str, directory: str | None = None) -> str | None:
        """Path of the audio file stored for `id_local`, if any."""
        if not is_safe_stem(id_local):
            return None
        pattern = os.path.join(
            glob.escape(directory or self.music_path), f"{glob.escape(id_local)}.*"
        )
        local_matches = sorted(
            x for x in glob.glob(pattern)
            if os.path.isfile(x)
            and x.rsplit(".", 1)[-1].lower() in AUDIO_EXTENSIONS
        )
        if not local_matches:
            return None
        if len(local_matches) > 1:
            logger.warning(f"Multiple local matches found for ID {id_local}: {local_matches}")
        return local_matches[0]

    def _read_data_url(self, path: str) -> str | None:
        try:
            return to_data_url(path)
        except Exception as e:
            logger.error(f"Error reading local file {path}: {e}")
            return None

    async def local_audio_url(self, id: str):
        """Return a playable URL for an already downloaded track, or None."""
        local_match = self.local_match(get_audio_filename(id))
        return None if local_match is None else await self._audio_url_for(local_match)

    async def local_audio_exists(self, id: str) -> bool:
        return self.local_match(get_audio_filename(id)) is not None

    # ------------------------------------------------------------------ #
    # Local library (user imported music)
    # ------------------------------------------------------------------ #

    def _local_stem(self, local_music_id: str) -> str:
        if local_music_id.startswith("local_"):
            return local_music_id[len("local_"):]
        return local_music_id

    async def search_local_music(self, term: str = "", limit: int = 100):
        """
        List imported music. A file matches when its name contains any
        significant word of `term` ("main", "theme", ... are ignored); an empty
        term lists everything.
        """
        logger.info(f"Searching local music for: {term}")
        try:
            return await asyncio.to_thread(self._search_local_music, term, limit)
        except Exception as e:
            logger.error(f"Error searching local music: {e}")
            return []

    def _search_local_music(self, term: str, limit: int):
        local_path = Path(self.local_path)
        if not local_path.exists():
            return []
        tokens = [
            t for t in re.split(r"[\s_\-]+", (term or "").lower())
            if len(t) > 1 and t not in LOCAL_SEARCH_STOP_WORDS
        ]

        results = []
        for file in sorted(local_path.iterdir()):
            if not file.is_file() or file.suffix.lower() not in IMPORTABLE_EXTENSIONS:
                continue
            name = file.stem.lower()
            if tokens and not any(t in name for t in tokens):
                continue
            results.append({
                "id": f"local_{file.stem}",
                "title": file.stem.replace('_', ' ').replace('-', ' '),
                "url": "",
                "thumbnail": "",
                "filename": file.name,
                "extension": file.suffix.lstrip('.'),
                "size": file.stat().st_size,
            })
            if len(results) >= limit:
                break
        logger.info(f"Found {len(results)} local music files")
        return results

    async def get_local_music_url(self, local_music_id: str):
        """Playable URL for an imported music file, or None."""
        local_match = self.local_match(self._local_stem(local_music_id), self.local_path)
        if local_match is None:
            logger.warning(f"No local music file found for ID: {local_music_id}")
            return None
        return await self._audio_url_for(local_match)

    def _validate_import_source(self, file_path: str) -> Path | None:
        source = Path(file_path)
        if not source.is_file():
            logger.error(f"Source file does not exist: {file_path}")
            return None
        if source.suffix.lower() not in IMPORTABLE_EXTENSIONS:
            logger.error(f"Unsupported audio format: {source.suffix}")
            return None
        return source

    async def import_local_music(self, source_path: str, dest_name: str = ""):
        """
        Copy a music file into the local library as `dest_name` (the source's
        own name when empty). An existing file with the same name is never
        overwritten. Returns the track id, or None on failure.
        """
        try:
            source = self._validate_import_source(source_path)
            if source is None:
                return None
            stem = (dest_name or "").strip() or source.stem
            if not is_safe_stem(stem):
                logger.error(f"Invalid destination name: {stem!r}")
                return None
            suffix = source.suffix.lower()
            local = Path(self.local_path)
            local.mkdir(parents=True, exist_ok=True)
            dest = local / f"{stem}{suffix}"
            if dest.exists() and dest.samefile(source):
                return f"local_{stem}"
            counter = 2
            while dest.exists():
                dest = local / f"{stem}_{counter}{suffix}"
                counter += 1
            await asyncio.to_thread(shutil.copy2, source, dest)
            logger.info(f"Imported local music file: {source} -> {dest}")
            return f"local_{dest.stem}"
        except Exception as e:
            logger.error(f"Error importing local music file: {e}")
            return None

    def _browse_roots(self) -> list[Path]:
        roots = [Path("/home"), Path("/media"), Path("/run/media"), Path("/mnt")]
        home = getattr(decky, "DECKY_USER_HOME", None) or getattr(decky, "HOME", None)
        if isinstance(home, str) and home:
            roots.append(Path(home))
        return roots

    @staticmethod
    def _list_entries(dir_path: Path):
        entries = []
        for item in dir_path.iterdir():
            try:
                entries.append({
                    "name": item.name,
                    "path": str(item),
                    "is_directory": item.is_dir(),
                })
            except OSError:
                continue
        entries.sort(key=lambda e: (not e["is_directory"], e["name"].lower()))
        return entries

    async def list_directory(self, directory_path: str):
        """List a directory for the file browser (restricted to user storage)."""
        logger.info(f"Listing directory: {directory_path}")
        try:
            if platform.system() == "Windows":
                raw = str(directory_path)
                if raw.startswith("\\\\") or raw.startswith("//") or not re.match(r"^[A-Za-z]:[\\/]", raw):
                    logger.warning(f"Directory access denied (Windows): {directory_path}")
                    return {"error": "Access denied", "entries": []}
                dir_path = Path(raw).resolve()
            else:
                dir_path = Path(os.path.realpath(directory_path))
                if not any(is_within(dir_path, root) for root in self._browse_roots()):
                    logger.warning(f"Directory access denied: {directory_path}")
                    return {"error": "Access denied", "entries": []}
            if not dir_path.exists():
                return {"error": "Directory does not exist", "entries": []}
            if not dir_path.is_dir():
                return {"error": "Not a directory", "entries": []}
            try:
                entries = await asyncio.to_thread(self._list_entries, dir_path)
            except PermissionError:
                return {"error": "Permission denied", "entries": []}
            return {"entries": entries}
        except Exception as e:
            logger.error(f"Error listing directory {directory_path}: {e}")
            return {"error": str(e), "entries": []}

    async def delete_local_music(self, local_music_id: str):
        """Delete a specific imported music file by ID."""
        logger.info(f"Deleting local music file: {local_music_id}")
        try:
            local_match = self.local_match(self._local_stem(local_music_id), self.local_path)
            if local_match is None:
                return False
            Path(local_match).unlink()
            return True
        except Exception as e:
            logger.error(f"Error deleting local music file {local_music_id}: {e}")
            return False

    async def clear_downloads(self):
        """Delete every downloaded file. Imported local music is kept."""
        logger.info("Clearing downloads...")
        count = 0
        for file in Path(self.music_path).glob("*"):
            if file.is_file():
                try:
                    file.unlink()
                    count += 1
                except Exception as e:
                    logger.error(f"Error deleting file {file}: {e}")
        logger.info(f"Cleared {count} downloaded files")
        return count

    # ------------------------------------------------------------------ #
    # Cache backups
    # ------------------------------------------------------------------ #

    async def export_cache(self, cache: dict):
        if not isinstance(cache, dict):
            raise ValueError("Cache must be an object")
        os.makedirs(self.cache_path, exist_ok=True)
        filename = f"backup-{datetime.datetime.now().strftime('%Y-%m-%d %H-%M-%S')}.json"
        file_path = Path(self.cache_path) / filename
        logger.info(f"Exporting cache to: {file_path}")
        tmp = file_path.with_name(file_path.name + ".tmp")
        with open(tmp, "w", encoding="utf-8") as file:
            json.dump(cache, file, indent=2)
        os.replace(tmp, file_path)
        self._prune_backups()

    def _prune_backups(self):
        backups = sorted(
            (f for f in Path(self.cache_path).glob("*.json") if f.is_file()),
            key=lambda f: f.name,
            reverse=True,
        )
        for old in backups[BACKUPS_TO_KEEP:]:
            try:
                old.unlink()
            except OSError:
                pass

    async def list_cache_backups(self):
        cache_path = Path(self.cache_path)
        if not cache_path.is_dir():
            return []
        return sorted(
            (file.stem for file in cache_path.glob("*.json") if file.is_file()),
            reverse=True,
        )

    async def import_cache(self, name: str):
        """Load a backup. Only well-formed {appid: {videoId?, volume?}} entries are kept."""
        if not is_safe_stem(name):
            raise ValueError(f"Invalid backup name: {name!r}")
        file_path = Path(self.cache_path) / f"{name}.json"
        logger.info(f"Importing cache from: {file_path}")
        with open(file_path, "r", encoding="utf-8") as file:
            raw = json.load(file)
        if not isinstance(raw, dict):
            raise ValueError("Backup is not a JSON object")
        cache = {}
        for key, value in raw.items():
            if not isinstance(value, dict):
                continue
            entry = {}
            video_id = value.get("videoId")
            if isinstance(video_id, str) and len(video_id) <= 2048:
                entry["videoId"] = video_id
            volume = value.get("volume")
            if isinstance(volume, (int, float)) and 0 <= volume <= 1:
                entry["volume"] = volume
            cache[str(key)] = entry
        return cache

    async def clear_cache(self) -> int:
        """Delete all backup files. Returns how many were deleted."""
        count = 0
        for file in Path(self.cache_path).glob("*.json"):
            if file.is_file():
                try:
                    file.unlink()
                    count += 1
                except OSError as e:
                    logger.error(f"Error deleting cache file {file}: {e}")
        logger.info(f"Cleared {count} cache backup files from {self.cache_path}")
        return count
