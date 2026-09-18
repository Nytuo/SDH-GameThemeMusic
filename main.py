import asyncio
import base64
import datetime
import glob
import hashlib
import json
import logging
import os
import platform
import re
import shutil
import ssl
import sys
import time
from pathlib import Path
from urllib.parse import urlparse

import aiohttp
import certifi

import decky
from settings import SettingsManager

logging.basicConfig(
    level=logging.INFO,
    format='[%(asctime)s] [%(levelname)s] [%(name)s] %(message)s',
    handlers=[
        logging.StreamHandler(sys.stdout)
    ]
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

HTTP_TIMEOUT = aiohttp.ClientTimeout(total=120, connect=15, sock_read=30)
PAGE_TIMEOUT = aiohttp.ClientTimeout(total=15)

YT_SEARCH_RESULTS = 15
YT_SEARCH_LINE_TIMEOUT = 45
YT_RESOLVE_TIMEOUT = 60
YT_DOWNLOAD_TIMEOUT = 300
YTDLP_UPDATE_INTERVAL = 24 * 60 * 60

YT_AUDIO_FORMAT = "bestaudio[protocol^=http][protocol!*=m3u8]/bestaudio/best"
YOUTUBE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")
ITUNES_ID_RE = re.compile(r"^\d{1,20}$")
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


def is_http_url(url: str) -> bool:
    try:
        return urlparse(url).scheme in ("http", "https")
    except ValueError:
        return False


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
    tmp = dest.with_name(dest.name + ".part")
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
    yt_process: asyncio.subprocess.Process | None = None
    yt_process_lock = asyncio.Lock()
    ytdlp_update_lock = asyncio.Lock()
    background_tasks: set = set()
    music_path = str(Path(decky.DECKY_PLUGIN_RUNTIME_DIR) / "music")
    cache_path = str(Path(decky.DECKY_PLUGIN_RUNTIME_DIR) / "cache")
    ssl_context = ssl.create_default_context(cafile=certifi.where())
    is_windows = platform.system() == "Windows"

    subprocess_flags = {}
    if is_windows:
        import subprocess as _subprocess
        subprocess_flags = {"creationflags": _subprocess.CREATE_NO_WINDOW}

    async def _main(self):
        logger.info(f"Plugin initializing on {platform.system()} ({platform.machine()})")
        self.settings = SettingsManager(
            name="config", settings_directory=decky.DECKY_PLUGIN_SETTINGS_DIR
        )
        os.makedirs(self.music_path, exist_ok=True)
        os.makedirs(self.cache_path, exist_ok=True)
        self._cleanup_partial_downloads()
        logger.info(f"Music path: {self.music_path}")
        logger.info(f"Cache path: {self.cache_path}")

        # Never block plugin startup on the network.
        self._spawn(self._startup_ytdlp_update())

    async def _unload(self):
        logger.info("Plugin unloading...")
        for task in list(self.background_tasks):
            task.cancel()
        await self._stop_process(self.yt_process)
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

    async def set_setting(self, key, value):
        logger.debug(f"Setting {key} = {value}")
        self.settings.setSetting(key, value)

    async def get_setting(self, key, default):
        value = self.settings.getSetting(key, default)
        logger.debug(f"Getting {key} = {value}")
        return value

    # ------------------------------------------------------------------ #
    # Subprocess helpers
    # ------------------------------------------------------------------ #

    def _get_ytdlp_path(self) -> str:
        bin_dir = Path(decky.DECKY_PLUGIN_DIR) / "bin"
        return str(bin_dir / ("yt-dlp.exe" if self.is_windows else "yt-dlp"))

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

    async def _run(self, args: list, timeout: float):
        """Run a command to completion, killing it on timeout."""
        process = await self._exec(*args)
        try:
            stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=timeout)
        except asyncio.TimeoutError:
            await self._stop_process(process)
            raise TimeoutError(f"{Path(args[0]).name} timed out after {timeout}s")
        except asyncio.CancelledError:
            await self._stop_process(process)
            raise
        return process.returncode, stdout or b"", stderr or b""

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
        Download yt-dlp and atomically replace the existing binary. When
        `expected_sha256` is given the download must match it.
        """
        logger.info(f"Downloading yt-dlp binary from: {asset_url}")
        ytdlp_path = Path(self._get_ytdlp_path())
        temp_path = ytdlp_path.with_name(ytdlp_path.name + ".download")
        try:
            ytdlp_path.parent.mkdir(parents=True, exist_ok=True)
            async with aiohttp.ClientSession(timeout=HTTP_TIMEOUT) as session:
                async with session.get(asset_url, ssl=self.ssl_context) as res:
                    res.raise_for_status()
                    await stream_to_file(res, temp_path)

            if expected_sha256:
                digest = hashlib.sha256(temp_path.read_bytes()).hexdigest()
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

            if self.yt_process is not None and self.yt_process.returncode is None:
                await self._stop_process(self.yt_process)

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
    # YouTube
    # ------------------------------------------------------------------ #

    async def search_yt(self, term: str):
        """
        Start a YouTube search. Uses flat extraction (metadata only), which
        returns in a second or two instead of resolving every video's streams;
        the stream URL is resolved on demand by single_yt_url.
        """
        logger.info(f"Searching YouTube for: {term}")
        ytdlp_path = self._ensure_ytdlp()
        if ytdlp_path is None:
            return

        term = (term or "").strip()[:200]
        if not term:
            return

        await self._stop_process(self.yt_process)

        try:
            self.yt_process = await self._exec(
                ytdlp_path,
                f"ytsearch{YT_SEARCH_RESULTS}:{term}",
                "-j",
                "--flat-playlist",
                "--match-filters",
                f"duration<?{20 * 60}",
                "--no-warnings",
                stderr=asyncio.subprocess.DEVNULL,
                limit=10 * 1024 ** 2,
            )
            logger.info(f"yt-dlp search started for: {term}")
        except Exception as e:
            logger.error(f"Error starting yt-dlp search: {e}")
            raise

    async def next_yt_result(self):
        """Get the next YouTube search result from yt-dlp."""
        async with self.yt_process_lock:
            process = self.yt_process
            while True:
                if not process or not process.stdout:
                    return None
                try:
                    raw = await asyncio.wait_for(
                        process.stdout.readline(), timeout=YT_SEARCH_LINE_TIMEOUT
                    )
                except (asyncio.TimeoutError, ValueError) as e:
                    logger.warning(f"yt-dlp search stalled: {e!r}")
                    await self._stop_process(process)
                    return None
                line = raw.strip()
                if not line:
                    logger.debug("No more YouTube search results")
                    return None
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError as e:
                    logger.error(f"Error parsing YouTube result: {e}")
                    continue
                result = self.entry_to_info(entry)
                if result["id"]:
                    return result

    @staticmethod
    def entry_to_info(entry):
        thumbnails = entry.get("thumbnails") or []
        thumbnail = entry.get("thumbnail") or (
            (thumbnails[-1] or {}).get("url") if thumbnails else None
        )
        video_id = entry.get("id")
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
        Playable audio URL for a YouTube video: the downloaded file if there is
        one, otherwise a direct stream URL.
        """
        logger.info(f"Getting audio URL for YouTube ID: {id_yt}")
        if not isinstance(id_yt, str) or not is_youtube_target(id_yt):
            logger.warning(f"Refusing invalid YouTube id: {id_yt!r}")
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
            url = json.loads(output).get("url")
            logger.info(f"Got audio URL for ID: {id_yt}")
            return url
        except Exception as e:
            logger.error(f"Error getting audio URL for ID {id_yt}: {e}")
            return None

    async def download_yt_audio(self, id_yt: str):
        """Download audio for a YouTube video. Raises on failure."""
        if not isinstance(id_yt, str) or not is_youtube_target(id_yt):
            raise ValueError(f"Invalid YouTube id: {id_yt!r}")

        filename = get_audio_filename(id_yt)
        if self.local_match(filename) is not None:
            logger.info(f"Audio already downloaded for ID: {id_yt}")
            return

        ytdlp_path = self._ensure_ytdlp()
        if ytdlp_path is None:
            raise RuntimeError("yt-dlp is not installed")

        logger.info(f"Downloading audio for YouTube ID: {id_yt}")
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
        if self.local_match(filename) is None:
            raise RuntimeError(f"yt-dlp finished but no audio file for {id_yt}")
        logger.info(f"Successfully downloaded audio for ID: {id_yt}")

    def _remove_incomplete(self, stem: str):
        pattern = os.path.join(glob.escape(self.music_path), f"{glob.escape(stem)}.*")
        for path in glob.glob(pattern):
            if path.endswith((".part", ".ytdl", ".temp")) or ".part-" in path:
                try:
                    os.remove(path)
                except OSError:
                    pass

    # ------------------------------------------------------------------ #
    # Web pages / direct downloads / iTunes
    # ------------------------------------------------------------------ #

    async def fetch_url(self, url: str) -> str:
        """Fetch a web page as text (used by the KHInsider scraper)."""
        if not is_http_url(url):
            logger.warning(f"fetch_url refused non-http url: {url!r}")
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
        Download audio from a direct URL (KHInsider) or an iTunes preview.
        Raises on failure.
        """
        logger.info(f"Downloading audio for ID: {id_to_save_as}")
        if isinstance(url, str) and url.startswith("data:"):
            logger.info("Skipping download because URL is already local audio data")
            return
        if id_to_save_as.startswith("itunes_"):
            await self.download_itunes(id_to_save_as)
            return

        stem = get_audio_filename(id_to_save_as)
        if not is_safe_stem(stem):
            raise ValueError(f"Invalid id: {id_to_save_as!r}")
        if not is_http_url(url):
            raise ValueError(f"Invalid download url: {url!r}")

        headers = dict(BROWSER_HEADERS)
        if "khinsider.com" in url or "khinsider.com" in id_to_save_as:
            headers["Referer"] = (
                id_to_save_as if id_to_save_as.startswith("https://")
                else "https://downloads.khinsider.com/"
            )
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
                    await stream_to_file(res, Path(self.music_path) / f"{stem}.{ext}")
            logger.info(f"Successfully downloaded audio from URL for ID: {id_to_save_as}")
        except Exception as e:
            logger.error(f"Error downloading from URL for ID {id_to_save_as}: {e}")
            raise

    async def download_itunes(self, track_id: str):
        """Download the audio preview of an iTunes track. Raises on failure."""
        logger.info(f"Downloading iTunes audio for ID: {track_id}")
        if track_id.startswith("itunes_"):
            track_id = track_id.split("_", 1)[1]
        if not ITUNES_ID_RE.match(track_id):
            raise ValueError(f"Invalid iTunes track id: {track_id!r}")

        dest_path = Path(self.music_path) / f"itunes_{track_id}.m4a"
        async with aiohttp.ClientSession(timeout=HTTP_TIMEOUT) as session:
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
            preview_url = results[0].get("previewUrl") if results else None
            if not preview_url or not is_http_url(preview_url):
                raise RuntimeError(f"No preview available for iTunes track {track_id}")

            async with session.get(preview_url, ssl=self.ssl_context) as audio_res:
                audio_res.raise_for_status()
                await stream_to_file(audio_res, dest_path)
        logger.info(f"Successfully downloaded iTunes preview to {dest_path}")

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

    # ------------------------------------------------------------------ #
    # Local library
    # ------------------------------------------------------------------ #

    def local_match(self, id_local: str) -> str | None:
        """Path of the audio file stored for `id_local`, if any."""
        if not is_safe_stem(id_local):
            return None
        pattern = os.path.join(
            glob.escape(self.music_path), f"{glob.escape(id_local)}.*"
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
        """Return a data URL for an already downloaded track, or None."""
        local_match = self.local_match(get_audio_filename(id))
        return None if local_match is None else self._read_data_url(local_match)

    async def local_audio_exists(self, id: str) -> bool:
        return self.local_match(get_audio_filename(id)) is not None

    def _local_stem(self, local_music_id: str) -> str:
        if local_music_id.startswith("local_"):
            return local_music_id[len("local_"):]
        return local_music_id

    async def search_local_music(self, term: str = "", limit: int = 100):
        """
        List local music files. A file matches when its name contains any
        significant word of `term` ("main", "theme", ... are ignored).
        """
        logger.info(f"Searching local music for: {term}")
        try:
            music_path = Path(self.music_path)
            if not music_path.exists():
                return []
            tokens = [
                t for t in re.split(r"[\s_\-]+", (term or "").lower())
                if len(t) > 1 and t not in LOCAL_SEARCH_STOP_WORDS
            ]

            results = []
            for file in sorted(music_path.iterdir()):
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
        except Exception as e:
            logger.error(f"Error searching local music: {e}")
            return []

    async def get_local_music_url(self, local_music_id: str):
        """Data URL for a local music file, or None."""
        local_match = self.local_match(self._local_stem(local_music_id))
        if local_match is None:
            logger.warning(f"No local music file found for ID: {local_music_id}")
            return None
        return self._read_data_url(local_match)

    def _validate_import_source(self, file_path: str) -> Path | None:
        source = Path(file_path)
        if not source.is_file():
            logger.error(f"Source file does not exist: {file_path}")
            return None
        if source.suffix.lower() not in IMPORTABLE_EXTENSIONS:
            logger.error(f"Unsupported audio format: {source.suffix}")
            return None
        return source

    async def save_local_music(self, file_path: str, custom_name: str = ""):
        """Copy a music file into the music directory. Returns its id."""
        logger.info(f"Saving local music file: {file_path}")
        try:
            source = self._validate_import_source(file_path)
            if source is None:
                return None
            stem = sanitize_name(custom_name) if custom_name else source.stem
            if not is_safe_stem(stem):
                logger.error(f"Invalid file name: {stem!r}")
                return None
            dest_path = Path(self.music_path) / f"{stem}{source.suffix.lower()}"
            if dest_path.exists():
                logger.warning(f"File already exists: {dest_path.name}")
                return f"local_{dest_path.stem}"
            shutil.copy2(source, dest_path)
            return f"local_{dest_path.stem}"
        except Exception as e:
            logger.error(f"Error saving local music file: {e}")
            return None

    async def import_local_music(self, source_path: str, dest_name: str) -> bool:
        """Copy a music file into the music directory as `dest_name`."""
        try:
            source = self._validate_import_source(source_path)
            if source is None:
                return False
            if not is_safe_stem(dest_name):
                logger.error(f"Invalid destination name: {dest_name!r}")
                return False
            dest = Path(self.music_path) / f"{dest_name}{source.suffix.lower()}"
            if dest.exists() and dest.samefile(source):
                return True
            shutil.copy2(source, dest)
            logger.info(f"Imported local music file: {source} -> {dest}")
            return True
        except Exception as e:
            logger.error(f"Error importing local music file: {e}")
            return False

    def _browse_roots(self) -> list[Path]:
        roots = [Path("/home"), Path("/media"), Path("/run/media"), Path("/mnt")]
        home = getattr(decky, "DECKY_USER_HOME", None) or getattr(decky, "HOME", None)
        if isinstance(home, str) and home:
            roots.append(Path(home))
        return roots

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
            entries = []
            try:
                for item in dir_path.iterdir():
                    try:
                        entries.append({
                            "name": item.name,
                            "path": str(item),
                            "is_directory": item.is_dir(),
                        })
                    except OSError:
                        continue
            except PermissionError:
                return {"error": "Permission denied", "entries": []}
            entries.sort(key=lambda e: (not e["is_directory"], e["name"].lower()))
            return {"entries": entries}
        except Exception as e:
            logger.error(f"Error listing directory {directory_path}: {e}")
            return {"error": str(e), "entries": []}

    async def delete_local_music(self, local_music_id: str):
        """Delete a specific local music file by ID."""
        logger.info(f"Deleting local music file: {local_music_id}")
        try:
            local_match = self.local_match(self._local_stem(local_music_id))
            if local_match is None:
                return False
            Path(local_match).unlink()
            return True
        except Exception as e:
            logger.error(f"Error deleting local music file {local_music_id}: {e}")
            return False

    async def clear_downloads(self):
        """Delete every file in the music directory."""
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
