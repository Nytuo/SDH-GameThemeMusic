import asyncio
import base64
import datetime
import json
import logging
import os
import platform
import ssl
import sys
from pathlib import Path

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


class Plugin:
    yt_process: asyncio.subprocess.Process | None = None
    yt_process_lock = asyncio.Lock()
    music_path = str(Path(decky.DECKY_PLUGIN_RUNTIME_DIR) / "music")
    cache_path = str(Path(decky.DECKY_PLUGIN_RUNTIME_DIR) / "cache")
    ssl_context = ssl.create_default_context(cafile=certifi.where())
    is_windows = platform.system() == "Windows"

    async def _main(self):
        logger.info(f"Plugin initializing on {platform.system()} ({platform.machine()})")
        self.settings = SettingsManager(
            name="config", settings_directory=decky.DECKY_PLUGIN_SETTINGS_DIR
        )
        os.makedirs(self.music_path, exist_ok=True)
        os.makedirs(self.cache_path, exist_ok=True)
        logger.info(f"Music path: {self.music_path}")
        logger.info(f"Cache path: {self.cache_path}")

    async def _unload(self):
        logger.info("Plugin unloading...")
        if self.yt_process is not None and self.yt_process.returncode is None:
            logger.info("Terminating yt-dlp process...")
            self.yt_process.terminate()
            async with self.yt_process_lock:
                try:
                    await asyncio.wait_for(self.yt_process.communicate(), timeout=5)
                    logger.info("yt-dlp process terminated successfully")
                except TimeoutError:
                    logger.warning("yt-dlp process did not terminate in time, killing it")
                    self.yt_process.kill()
        logger.info("Plugin unloaded")

    async def set_setting(self, key, value):
        logger.debug(f"Setting {key} = {value}")
        self.settings.setSetting(key, value)

    async def get_setting(self, key, default):
        value = self.settings.getSetting(key, default)
        logger.debug(f"Getting {key} = {value}")
        return value

    def _get_ytdlp_path(self) -> str:
        """
        Get the path to the yt-dlp binary.
        :return:
        """
        bin_dir = Path(decky.DECKY_PLUGIN_DIR) / "bin"
        if self.is_windows:
            ytdlp_path = bin_dir / "yt-dlp.exe"
        else:
            ytdlp_path = bin_dir / "yt-dlp"
        return str(ytdlp_path)

    def _get_env(self) -> dict:
        """
        Get the environment variables for subprocesses. Linux needs LD_LIBRARY_PATH set.
        :return:
        """
        env = os.environ.copy()
        if not self.is_windows:
            env["LD_LIBRARY_PATH"] = "/usr/lib:/usr/lib64:/lib:/lib64"
        return env

    async def search_yt(self, term: str):
        """Search YouTube using yt-dlp."""
        logger.info(f"Searching YouTube for: {term}")
        ytdlp_path = self._get_ytdlp_path()

        try:
            path = Path(ytdlp_path)
            if path.exists():
                if not self.is_windows:
                    path.chmod(0o755)
                logger.debug(f"yt-dlp binary found at: {ytdlp_path}")
            else:
                logger.error(f"yt-dlp binary not found at: {ytdlp_path}")
                return
        except Exception as e:
            logger.error(f"Error checking yt-dlp binary: {e}")
            return

        if self.yt_process is not None and self.yt_process.returncode is None:
            logger.debug("Terminating existing yt-dlp search process")
            self.yt_process.terminate()
            async with self.yt_process_lock:
                await self.yt_process.communicate()

        try:
            self.yt_process = await asyncio.create_subprocess_exec(
                ytdlp_path,
                f"ytsearch10:{term}",
                "-j",
                "-f",
                "bestaudio",
                "--match-filters",
                f"duration<?{20 * 60}",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                limit=10 * 1024 ** 2,
                env=self._get_env(),
            )
            logger.info(f"yt-dlp search started for: {term}")
        except Exception as e:
            logger.error(f"Error starting yt-dlp search: {e}")
            raise

    async def next_yt_result(self):
        """Get the next YouTube search result from yt-dlp."""
        async with self.yt_process_lock:
            if (
                    not self.yt_process
                    or not (output := self.yt_process.stdout)
                    or not (line := (await output.readline()).strip())
            ):
                logger.debug("No more YouTube search results")
                return None
            try:
                entry = json.loads(line)
                result = self.entry_to_info(entry)
                logger.debug(f"YouTube result: {result['title']} ({result['id']})")
                return result
            except json.JSONDecodeError as e:
                logger.error(f"Error parsing YouTube result: {e}")
                return None

    @staticmethod
    def entry_to_info(entry):
        return {
            "url": entry["url"],
            "title": entry["title"],
            "id": entry["id"],
            "thumbnail": entry["thumbnail"],
        }

    def local_match(self, id_local: str) -> str | None:
        """
        Find a locally downloaded audio file matching the given ID.
        :param id_local: str ID to match
        :return: str | None Path to local file if found, else None
        """
        music_path = Path(self.music_path)
        local_matches = [
            str(x) for x in music_path.glob(f"{id_local}.*") if x.is_file()
        ]
        if len(local_matches) == 0:
            logger.debug(f"No local match found for ID: {id_local}")
            return None

        if len(local_matches) > 1:
            logger.warning(f"Multiple local matches found for ID {id_local}: {local_matches}")

        logger.debug(f"Local match found: {local_matches[0]}")
        return local_matches[0]

    async def single_yt_url(self, id_yt: str):
        """
        Get the audio URL for a single YouTube video ID.
        :param id_yt: str YouTube video ID
        :return: str | None Audio URL or None if not found
        """
        logger.info(f"Getting audio URL for YouTube ID: {id_yt}")
        local_match = self.local_match(id_yt)
        if local_match is not None:
            extension = Path(local_match).suffix.lstrip('.')
            logger.debug(f"Using local file: {local_match}")
            try:
                with open(local_match, "rb") as file:
                    data_url = f"data:audio/{extension};base64,{base64.b64encode(file.read()).decode()}"
                    logger.info(f"Returning base64-encoded local file for ID: {id_yt}")
                    return data_url
            except Exception as e:
                logger.error(f"Error reading local file {local_match}: {e}")

        ytdlp_path = self._get_ytdlp_path()
        logger.debug(f"Fetching audio URL from YouTube for ID: {id_yt}")

        try:
            result = await asyncio.create_subprocess_exec(
                ytdlp_path,
                f"{id_yt}",
                "-j",
                "-f",
                "bestaudio",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=self._get_env(),
            )
            if (
                    result.stdout is None
                    or len(output := (await result.stdout.read()).strip()) == 0
            ):
                logger.warning(f"No output from yt-dlp for ID: {id_yt}")
                return None
            entry = json.loads(output)
            url = entry["url"]
            logger.info(f"Got audio URL for ID: {id_yt}")
            return url
        except Exception as e:
            logger.error(f"Error getting audio URL for ID {id_yt}: {e}")
            return None

    async def download_yt_audio(self, id_yt: str):
        """
        Download audio from YouTube using yt-dlp.
        :param id_yt: str YouTube video ID
        :return: None
        """
        if self.local_match(id_yt) is not None:
            logger.info(f"Audio already downloaded for ID: {id_yt}")
            return

        logger.info(f"Downloading audio for YouTube ID: {id_yt}")
        ytdlp_path = self._get_ytdlp_path()

        try:
            yt_dlp_cmd = [
                ytdlp_path,
                f"{id_yt}",
                "-f",
                "bestaudio",
                "-o",
                "%(id)s.%(ext)s",
                "-P",
                self.music_path,
            ]
            logger.info(f"Running yt-dlp command: {yt_dlp_cmd}")
            logger.info(f"Working directory: {os.getcwd()}")
            process = await asyncio.create_subprocess_exec(
                *yt_dlp_cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=self._get_env(),
            )
            stdout, stderr = await process.communicate()

            if stdout:
                logger.info(f"yt-dlp stdout: {stdout.decode(errors='replace')}")
            else:
                logger.info("yt-dlp stdout: <empty>")
            if stderr:
                logger.info(f"yt-dlp stderr: {stderr.decode(errors='replace')}")
            else:
                logger.info("yt-dlp stderr: <empty>")

            if process.returncode == 0:
                logger.info(f"Successfully downloaded audio for ID: {id_yt}")
            else:
                logger.error(f"yt-dlp failed with return code {process.returncode}")
                if stderr:
                    logger.error(f"yt-dlp stderr: {stderr.decode()}")
        except Exception as e:
            logger.error(f"Error downloading audio for ID {id_yt}: {e}")
            raise

    async def download_url(self, url: str, id_to_save_as: str):
        """
        Download audio from a direct URL or iTunes preview.
        We do not enforce WebM format here
        :param url: str URL to download from
        :param id_to_save_as: str ID to save as
        :return: None
        """
        logger.info(f"Downloading audio for ID: {id_to_save_as}")
        if id_to_save_as.startswith("itunes_"):
            logger.info(f"ID {id_to_save_as} detected as iTunes, using download_itunes for more accurate handling")
            await self.download_itunes(id_to_save_as)
            return
        try:
            async with aiohttp.ClientSession() as session:
                res = await session.get(url, ssl=self.ssl_context)
                res.raise_for_status()
                try:
                    from urllib.parse import urlparse
                    parsed = urlparse(url)
                    ext = os.path.splitext(parsed.path)[1].lstrip('.')
                except Exception:
                    ext = ''

                if not ext:
                    ctype = res.headers.get('content-type', '')
                    if 'mpeg' in ctype or 'mp3' in ctype:
                        ext = 'mp3'
                    elif 'mpegurl' in ctype:
                        ext = 'm3u8'
                    elif 'ogg' in ctype:
                        ext = 'ogg'
                    elif 'wav' in ctype:
                        ext = 'wav'
                    elif 'mpeg' in ctype:
                        ext = 'mp3'
                    else:
                        ext = 'webm'

                file_path = Path(self.music_path) / f"{id_to_save_as}.{ext}"
                with open(file_path, "wb") as file:
                    async for chunk in res.content.iter_chunked(1024):
                        file.write(chunk)
            logger.info(f"Successfully downloaded audio from URL for ID: {id_to_save_as}")
        except Exception as e:
            logger.error(f"Error downloading from URL for ID {id_to_save_as}: {e}")
            raise

    async def download_itunes(self, track_id: str):
        """
        Download audio preview from iTunes.
        :param track_id: str iTunes track ID
        :return: None
        """
        logger.info(f"Downloading iTunes audio for ID: {track_id}")
        if track_id.startswith("itunes_"):
            track_id = track_id.split("_", 1)[1]

        lookup_url = f"https://itunes.apple.com/lookup?id={track_id}&entity=song"
        try:
            async with aiohttp.ClientSession() as session:
                res = await session.get(lookup_url, ssl=self.ssl_context)
                res.raise_for_status()
                try:
                    text = await res.text()
                    data = json.loads(text)
                except Exception as e:
                    logger.error(f"Error decoding iTunes lookup response as JSON: {e}")
                    return

                if not data or 'results' not in data or len(data['results']) == 0:
                    logger.warning(f"No iTunes lookup results for track id: {track_id}")
                    return

                item = data['results'][0]
                preview_url = item.get('previewUrl')
                if not preview_url:
                    logger.warning(f"No previewUrl available for iTunes track {track_id}")
                    return

                save_id = f"itunes_{track_id}"
                ext = os.path.splitext(preview_url)[1].lower()
                if ext != '.m4a':
                    logger.warning(f"Preview URL does not end with .m4a, got: {ext}. Will still save as .m4a.")
                dest_path = Path(self.music_path) / f"{save_id}.m4a"
                try:
                    async with session.get(preview_url, ssl=self.ssl_context) as audio_res:
                        audio_res.raise_for_status()
                        with open(dest_path, "wb") as f:
                            async for chunk in audio_res.content.iter_chunked(1024):
                                f.write(chunk)
                    logger.info(f"Successfully downloaded iTunes preview to {dest_path}")
                except Exception as e:
                    logger.error(f"Error downloading iTunes preview audio: {e}")
                    if dest_path.exists():
                        try:
                            dest_path.unlink()
                        except Exception:
                            pass
        except Exception as e:
            logger.error(f"Error downloading iTunes audio for {track_id}: {e}")
            raise

    async def search_itunes(self, term: str, limit: int = 10):
        """
        Search iTunes for music matching the search term.
        :param term: str Search term
        :param limit: int Maximum number of results to return
        :return: list List of search results
        """
        logger.info(f"Searching iTunes for: {term}")
        try:
            async with aiohttp.ClientSession() as session:
                params = {
                    "term": term,
                    "media": "music",
                    "entity": "song",
                    "limit": limit,
                    "attribute": "songTerm"
                }
                url = "https://itunes.apple.com/search"
                res = await session.get(url, params=params, ssl=self.ssl_context)
                res.raise_for_status()
                try:
                    text = await res.text()
                    data = json.loads(text)
                except Exception as e:
                    logger.error(f"Error decoding iTunes response as JSON: {e}")
                    return []

                results = []
                if "results" in data:
                    for item in data["results"]:
                        result = {
                            "id": f"itunes_{item.get('trackId', '')}",
                            "title": f"{item.get('trackName', '')} - {item.get('artistName', '')}",
                            "url": item.get("previewUrl", ""),
                            "thumbnail": item.get("artworkUrl100", "").replace("100x100", "600x600"),
                            "artist": item.get("artistName", ""),
                            "album": item.get("collectionName", ""),
                            "duration": item.get("trackTimeMillis", 0) // 1000
                        }
                        results.append(result)
                    logger.info(f"Found {len(results)} iTunes results for: {term}")
                else:
                    logger.warning(f"No iTunes results found for: {term}")

                return results
        except Exception as e:
            logger.error(f"Error searching iTunes: {e}")
            return []

    async def search_local_music(self, term: str = "", limit: int = 100):
        """
        Search local music files. Returns list of local music files matching the term.
        :param term: str Search term
        :param limit: int Maximum number of results to return
        :return: list List of local music files
        """
        logger.info(f"Searching local music for: {term}")
        try:
            music_path = Path(self.music_path)
            if not music_path.exists():
                logger.warning("Music path does not exist")
                return []

            audio_extensions = {'.mp3', '.m4a', '.webm', '.ogg', '.wav', '.flac', '.aac', '.opus'}

            results = []
            for file in music_path.iterdir():
                if file.is_file() and file.suffix.lower() in audio_extensions:
                    if term and term.lower() not in file.stem.lower():
                        continue
                    logger.debug(f"Found local file: {file.name} (size: {file.stat().st_size} bytes)")
                    result = {
                        "id": f"local_{file.stem}",
                        "title": file.stem.replace('_', ' ').replace('-', ' '),
                        "url": "",
                        "thumbnail": "",
                        "filename": file.name,
                        "extension": file.suffix.lstrip('.'),
                        "size": file.stat().st_size
                    }
                    results.append(result)

                    if len(results) >= limit:
                        break
            logger.info(f"Found {len(results)} local music files")
            return results
        except Exception as e:
            logger.error(f"Error searching local music: {e}")
            return []

    async def get_local_music_url(self, local_music_id: str):
        """Get the audio URL for a local music file (as base64 data URL).
        :param local_music_id: str Local music ID to look for
        :return: str | None Base64 data URL or None if not found
        """
        logger.info(f"Getting local music URL for ID: {local_music_id}")

        filename = local_music_id
        if local_music_id.startswith("local_"):
            filename = local_music_id.replace("local_", "", 1)

        local_match = self.local_match(filename)
        if local_match is None:
            logger.warning(f"No local music file found for ID: {local_music_id}")
            return None

        try:
            extension = Path(local_match).suffix.lstrip('.').lower()
            logger.info(f"Reading local file: {local_match}")
            with open(local_match, "rb") as file:
                data = file.read()
                logger.debug(f"Read {len(data)} bytes from {local_match}")
                mime_map = {
                    "mp3": "audio/mpeg",
                    "m4a": "audio/mp4",
                    "webm": "audio/webm",
                    "ogg": "audio/ogg",
                    "wav": "audio/wav",
                    "flac": "audio/flac",
                    "aac": "audio/aac",
                    "opus": "audio/opus"
                }
                mime_type = mime_map.get(extension, f"audio/{extension}")
                data_url = f"data:{mime_type};base64,{base64.b64encode(data).decode()}"
                logger.info(f"Returning base64-encoded local file for ID: {local_music_id} with MIME type {mime_type}")
                return data_url
        except Exception as e:
            logger.error(f"Error reading local music file {local_match}: {e}")
            return None

    async def save_local_music(self, file_path: str, custom_name: str = ""):
        """
        Import/save a music file from anywhere on the filesystem to the music directory.
        Returns the new ID for the saved file.
        """
        logger.info(f"Saving local music file: {file_path}")
        try:
            source_path = Path(file_path)
            if not source_path.exists():
                logger.error(f"Source file does not exist: {file_path}")
                return None

            if not source_path.is_file():
                logger.error(f"Source path is not a file: {file_path}")
                return None

            audio_extensions = {'.mp3', '.m4a', '.webm', '.ogg', '.wav', '.flac', '.aac', '.opus'}
            if source_path.suffix.lower() not in audio_extensions:
                logger.error(f"Unsupported audio format: {source_path.suffix}")
                return None

            if custom_name:
                safe_name = "".join(c for c in custom_name if c.isalnum() or c in (' ', '-', '_')).strip()
                safe_name = safe_name.replace(' ', '_')
                dest_filename = f"{safe_name}{source_path.suffix}"
            else:
                dest_filename = source_path.name

            dest_path = Path(self.music_path) / dest_filename

            if dest_path.exists():
                logger.warning(f"File already exists: {dest_filename}")
                return f"local_{dest_path.stem}"

            import shutil
            shutil.copy2(source_path, dest_path)
            logger.info(f"Successfully saved music file: {dest_filename} (size: {dest_path.stat().st_size} bytes)")

            return f"local_{dest_path.stem}"
        except Exception as e:
            logger.error(f"Error saving local music file: {e}")
            return None

    async def list_directory(self, directory_path: str):
        """List contents of a directory for file browser.
        :param directory_path: str Path to directory
        :return: dict Dictionary with 'entries' key containing list of entries
        """
        logger.info(f"Listing directory: {directory_path}")
        try:
            dir_path = Path(directory_path)
            is_windows = platform.system() == "Windows"
            if is_windows:
                allowed = False
                if len(str(dir_path.drive)) == 2 and str(dir_path)[2:3] == '\\':
                    allowed = True
                if any(str(dir_path).lower().startswith(f"{d}:\\".lower()) for d in 'cdefghijklmnopqrstuvwxyz'):
                    allowed = True
                if not allowed:
                    logger.warning(f"Directory access denied (Windows): {directory_path}")
                    return {"error": "Access denied", "entries": []}
            else:
                allowed_prefixes = ['/home', '/media', '/run/media', '/mnt']
                if not any(str(dir_path).startswith(prefix) for prefix in allowed_prefixes):
                    logger.warning(f"Directory access denied: {directory_path}")
                    return {"error": "Access denied", "entries": []}
            if not dir_path.exists():
                logger.warning(f"Directory does not exist: {directory_path}")
                return {"error": "Directory does not exist", "entries": []}
            if not dir_path.is_dir():
                logger.warning(f"Path is not a directory: {directory_path}")
                return {"error": "Not a directory", "entries": []}
            entries = []
            try:
                for item in dir_path.iterdir():
                    try:
                        entries.append({
                            "name": item.name,
                            "path": str(item),
                            "is_directory": item.is_dir()
                        })
                    except (PermissionError, OSError) as e:
                        logger.debug(f"Skipping inaccessible item {item}: {e}")
                        continue
            except PermissionError:
                logger.warning(f"Permission denied reading directory: {directory_path}")
                return {"error": "Permission denied", "entries": []}
            logger.info(f"Found {len(entries)} entries in {directory_path}")
            return {"entries": entries}
        except Exception as e:
            logger.error(f"Error listing directory {directory_path}: {e}")
            return {"error": str(e), "entries": []}

    async def delete_local_music(self, local_music_id: str):
        """Delete a specific local music file by ID.
        :param local_music_id: str Local music ID to delete
        :return: bool True if deleted, False otherwise
        """
        logger.info(f"Deleting local music file: {local_music_id}")
        try:
            filename = local_music_id
            if local_music_id.startswith("local_"):
                filename = local_music_id.replace("local_", "", 1)

            local_match = self.local_match(filename)
            if local_match is None:
                logger.warning(f"No local music file found to delete: {local_music_id}")
                return False

            file_path = Path(local_match)
            logger.info(f"Deleting file: {file_path} (size: {file_path.stat().st_size} bytes)")
            file_path.unlink()
            logger.info(f"Successfully deleted local music file: {file_path.name}")
            return True
        except Exception as e:
            logger.error(f"Error deleting local music file {local_music_id}: {e}")
            return False

    async def clear_downloads(self):
        """Clear all downloaded music files."""
        logger.info("Clearing downloads...")
        count = 0
        music_path = Path(self.music_path)
        for file in music_path.glob("*"):
            if file.is_file():
                try:
                    file.unlink()
                    count += 1
                except Exception as e:
                    logger.error(f"Error deleting file {file}: {e}")
        logger.info(f"Cleared {count} downloaded files")

    async def export_cache(self, cache: dict):
        """Export cache to a backup file.
        :return: None
        :param cache: dict Cache data to export
        """
        os.makedirs(self.cache_path, exist_ok=True)
        filename = f"backup-{datetime.datetime.now().strftime('%Y-%m-%d %H-%M')}.json"
        file_path = Path(self.cache_path) / filename
        logger.info(f"Exporting cache to: {file_path}")
        try:
            with open(file_path, "w") as file:
                json.dump(cache, file, indent=2)
            logger.info(f"Successfully exported cache to: {filename}")
        except Exception as e:
            logger.error(f"Error exporting cache: {e}")
            raise

    async def list_cache_backups(self):
        """List all available cache backups."""
        cache_path = Path(self.cache_path)
        backups = [
            file.stem for file in cache_path.glob("*.json") if file.is_file()
        ]
        logger.info(f"Found {len(backups)} cache backups")
        return backups

    async def import_cache(self, name: str):
        """Import cache from a backup file.
        :param name: str Name of the backup file (without .json)
        :return: dict Imported cache
        """
        file_path = Path(self.cache_path) / f"{name}.json"
        logger.info(f"Importing cache from: {file_path}")
        try:
            with open(file_path, "r") as file:
                cache = json.load(file)
            logger.info(f"Successfully imported cache from: {name}")
            return cache
        except Exception as e:
            logger.error(f"Error importing cache from {name}: {e}")
            raise

    async def clear_cache(self) -> int:
        """
        Clear all JSON cache backup files. Returns the number of files deleted.
        :return: int Number of cache files deleted
        """
        logger.info("Clearing cache backups...")
        count = 0
        cache_path = Path(self.cache_path)
        for file in cache_path.glob("*.json"):
            if file.is_file():
                try:
                    file.unlink()
                    count += 1
                except OSError as e:
                    logger.error(f"Error deleting cache file {file}: {e}")
        logger.info(f"Cleared {count} cache backup files from {cache_path}")
        return count
