"""Backend tests for main.Plugin."""
import asyncio
import base64
import json
import os
import sys
from pathlib import Path

import pytest

import main
from conftest import FakeProcess, FakeResponse


def write(path: Path, data: bytes = b"audio") -> Path:
    path.write_bytes(data)
    return path


# --------------------------------------------------------------------------- #
# Lifecycle & settings
# --------------------------------------------------------------------------- #


class TestLifecycle:
    async def test_main_creates_dirs_and_survives_update_failure(
        self, plugin, tmp_path, monkeypatch
    ):
        plugin.music_path = str(tmp_path / "new_music")
        plugin.cache_path = str(tmp_path / "new_cache")

        async def boom():
            raise RuntimeError("offline")

        monkeypatch.setattr(plugin, "check_and_update_ytdlp", boom)
        await plugin._main()

        assert Path(plugin.music_path).is_dir()
        assert Path(plugin.cache_path).is_dir()
        assert plugin.settings is not None

    async def test_unload_without_process(self, plugin):
        await plugin._unload()

    async def test_unload_terminates_running_process(self, plugin):
        proc = FakeProcess()
        plugin.searches["s1"] = proc
        running = FakeProcess()
        plugin.running_processes.add(running)
        await plugin._unload()
        assert proc.terminated
        assert running.terminated
        assert plugin.searches == {}

    async def test_windows_kills_whole_process_tree(self, plugin, fake_exec):
        plugin.is_windows = True
        proc = FakeProcess()
        proc.pid = 4242
        await plugin._stop_process(proc)
        assert fake_exec.calls[0]["args"] == [
            "taskkill", "/T", "/F", "/PID", "4242"
        ]

    async def test_settings_roundtrip(self, plugin):
        assert await plugin.get_setting("settings", {"volume": 1}) == {"volume": 1}
        await plugin.set_setting("settings", {"volume": 0.5})
        assert await plugin.get_setting("settings", None) == {"volume": 0.5}


# --------------------------------------------------------------------------- #
# yt-dlp binary management
# --------------------------------------------------------------------------- #


class TestYtDlpBinary:
    def test_path_windows(self, plugin):
        plugin.is_windows = True
        assert plugin._get_ytdlp_path().endswith("yt-dlp.exe")

    def test_path_linux(self, plugin):
        plugin.is_windows = False
        path = plugin._get_ytdlp_path()
        assert path.endswith("yt-dlp") and not path.endswith(".exe")

    def test_env_linux_sets_ld_library_path(self, plugin):
        plugin.is_windows = False
        assert "LD_LIBRARY_PATH" in plugin._get_env()

    def test_env_windows_is_plain_copy(self, plugin, monkeypatch):
        monkeypatch.delenv("LD_LIBRARY_PATH", raising=False)
        plugin.is_windows = True
        assert "LD_LIBRARY_PATH" not in plugin._get_env()

    @pytest.mark.parametrize(
        "system,machine,expected",
        [
            ("Windows", "AMD64", "yt-dlp.exe"),
            ("Linux", "x86_64", "yt-dlp_linux"),
            ("Linux", "aarch64", "yt-dlp_linux_aarch64"),
            ("Linux", "armv7l", "yt-dlp_linux_armv7l"),
            ("Darwin", "arm64", "yt-dlp_macos"),
            ("Darwin", "x86_64", "yt-dlp_macos"),
            ("Plan9", "mips", "yt-dlp_linux"),
        ],
    )
    def test_asset_name(self, plugin, monkeypatch, system, machine, expected):
        monkeypatch.setattr(main.platform, "system", lambda: system)
        monkeypatch.setattr(main.platform, "machine", lambda: machine)
        assert plugin._get_ytdlp_asset_name() == expected

    async def test_version_missing_binary(self, plugin):
        assert await plugin.get_ytdlp_version() is None

    async def test_version_reads_stdout(self, plugin, fake_exec):
        write(Path(plugin._get_ytdlp_path()))
        fake_exec.next = FakeProcess(stdout=b"2025.12.08\n")
        assert await plugin.get_ytdlp_version() == "2025.12.08"
        assert fake_exec.calls[0]["args"][1] == "--version"

    async def test_version_nonzero_exit(self, plugin, fake_exec):
        write(Path(plugin._get_ytdlp_path()))
        fake_exec.next = FakeProcess(stdout=b"x", returncode=1)
        assert await plugin.get_ytdlp_version() is None

    async def test_latest_release(self, plugin, fake_http):
        fake_http.routes["https://api.github.com/"] = FakeResponse(
            json_data={"tag_name": "2026.01.01", "assets": [{"name": "a"}]}
        )
        rel = await plugin.get_latest_ytdlp_release()
        assert rel == {"version": "2026.01.01", "assets": [{"name": "a"}]}

    async def test_latest_release_http_error(self, plugin, fake_http):
        fake_http.routes["https://api.github.com/"] = FakeResponse(status=403)
        assert await plugin.get_latest_ytdlp_release() is None

    async def test_download_binary_replaces_existing(self, plugin, fake_http):
        write(Path(plugin._get_bundled_ytdlp_path()), b"old")
        fake_http.routes["https://dl/"] = FakeResponse(b"new-binary")
        assert await plugin.download_ytdlp_binary("https://dl/yt-dlp") is True
        assert Path(plugin._get_ytdlp_path()).read_bytes() == b"new-binary"
        assert Path(plugin._get_bundled_ytdlp_path()).read_bytes() == b"old"

    async def test_download_binary_failure_keeps_existing(self, plugin, fake_http):
        target = write(Path(plugin._get_ytdlp_path()), b"old")
        fake_http.routes["https://dl/"] = FakeResponse(status=500)
        assert await plugin.download_ytdlp_binary("https://dl/yt-dlp") is False
        assert target.read_bytes() == b"old"
        assert not target.with_suffix(".tmp").exists()

    async def test_update_skipped_when_up_to_date(self, plugin, monkeypatch):
        async def ver():
            return "2026.01.01"

        async def rel():
            return {"version": "2026.01.01", "assets": []}

        monkeypatch.setattr(plugin, "get_ytdlp_version", ver)
        monkeypatch.setattr(plugin, "get_latest_ytdlp_release", rel)
        assert await plugin.check_and_update_ytdlp() is False

    async def test_update_no_release_info(self, plugin, monkeypatch):
        async def ver():
            return "2025.01.01"

        async def rel():
            return None

        monkeypatch.setattr(plugin, "get_ytdlp_version", ver)
        monkeypatch.setattr(plugin, "get_latest_ytdlp_release", rel)
        assert await plugin.check_and_update_ytdlp() is False

    async def test_update_downloads_matching_asset(self, plugin, monkeypatch):
        downloaded = []

        async def ver():
            return "2025.01.01"

        async def rel():
            return {
                "version": "2026.01.01",
                "assets": [
                    {"name": "other", "browser_download_url": "https://x/other"},
                    {"name": "wanted", "browser_download_url": "https://x/wanted"},
                ],
            }

        async def dl(url, expected=None):
            downloaded.append((url, expected))
            return True

        async def sums(assets, name):
            return "abc123"

        monkeypatch.setattr(plugin, "_fetch_expected_sha256", sums)
        monkeypatch.setattr(plugin, "get_ytdlp_version", ver)
        monkeypatch.setattr(plugin, "get_latest_ytdlp_release", rel)
        monkeypatch.setattr(plugin, "_get_ytdlp_asset_name", lambda: "wanted")
        monkeypatch.setattr(plugin, "download_ytdlp_binary", dl)
        assert await plugin.check_and_update_ytdlp() is True
        assert downloaded == [("https://x/wanted", "abc123")]

    async def test_update_missing_asset(self, plugin, monkeypatch):
        async def ver():
            return None

        async def rel():
            return {"version": "2026.01.01", "assets": []}

        monkeypatch.setattr(plugin, "get_ytdlp_version", ver)
        monkeypatch.setattr(plugin, "get_latest_ytdlp_release", rel)
        assert await plugin.check_and_update_ytdlp() is False


# --------------------------------------------------------------------------- #
# YouTube search / streaming / download
# --------------------------------------------------------------------------- #


def yt_id(i):
    return f"video{i:06d}"  # 11 characters, like a real YouTube id


def yt_entry(i):
    return {
        "url": f"https://audio/{i}",
        "title": f"Song {i}",
        "id": yt_id(i),
        "thumbnail": f"https://thumb/{i}",
        "extra": "ignored",
    }


class TestYouTube:
    def test_entry_to_info(self):
        assert main.Plugin.entry_to_info(yt_entry(1)) == {
            "url": "https://audio/1",
            "title": "Song 1",
            "id": yt_id(1),
            "thumbnail": "https://thumb/1",
        }

    async def test_search_without_binary_does_nothing(self, plugin, fake_exec):
        await plugin.search_yt("zelda")
        assert fake_exec.calls == []
        assert await plugin.next_yt_result() is None

    async def test_search_streams_results(self, plugin, fake_exec):
        write(Path(plugin._get_ytdlp_path()))
        lines = b"".join(json.dumps(yt_entry(i)).encode() + b"\n" for i in range(3))
        fake_exec.next = FakeProcess(stdout=lines)

        await plugin.search_yt("zelda")
        args = fake_exec.calls[0]["args"]
        assert any(str(a).startswith("ytsearch") and "zelda" in str(a) for a in args)

        results = []
        while (r := await plugin.next_yt_result()) is not None:
            results.append(r)
        assert [r["id"] for r in results] == [yt_id(0), yt_id(1), yt_id(2)]
        assert "--flat-playlist" in args

    async def test_searches_are_independent(self, plugin, fake_exec):
        write(Path(plugin._get_ytdlp_path()))
        first = FakeProcess(stdout=json.dumps(yt_entry(1)).encode() + b"\n")
        fake_exec.next = first
        a = await plugin.search_yt("a")
        second = FakeProcess(stdout=json.dumps(yt_entry(2)).encode() + b"\n")
        fake_exec.next = second
        b = await plugin.search_yt("b")
        assert a and b and a != b
        assert not first.terminated
        assert (await plugin.next_yt_result(a))["id"] == yt_id(1)
        assert (await plugin.next_yt_result(b))["id"] == yt_id(2)

    async def test_oldest_search_is_dropped_over_the_limit(self, plugin, fake_exec):
        write(Path(plugin._get_ytdlp_path()))
        procs = []
        for i in range(main.MAX_ACTIVE_SEARCHES + 1):
            procs.append(FakeProcess(stdout=b""))
            fake_exec.next = procs[-1]
            await plugin.search_yt(f"t{i}")
        assert procs[0].terminated
        assert len(plugin.searches) == main.MAX_ACTIVE_SEARCHES

    async def test_close_search_stops_process(self, plugin, fake_exec):
        write(Path(plugin._get_ytdlp_path()))
        proc = FakeProcess(stdout=b"")
        fake_exec.next = proc
        sid = await plugin.search_yt("a")
        await plugin.close_search(sid)
        assert proc.terminated and plugin.searches == {}

    async def test_soundcloud_search_uses_scsearch_and_track_url(
        self, plugin, fake_exec
    ):
        write(Path(plugin._get_ytdlp_path()))
        entry = {"id": "123", "title": "T", "url": "https://soundcloud.com/a/b"}
        fake_exec.next = FakeProcess(stdout=json.dumps(entry).encode() + b"\n")
        sid = await plugin.search_yt("zelda", "soundcloud")
        assert any(str(a).startswith("scsearch") for a in fake_exec.calls[0]["args"])
        assert (await plugin.next_yt_result(sid))["id"] == "https://soundcloud.com/a/b"

    async def test_unknown_search_provider_rejected(self, plugin):
        with pytest.raises(ValueError):
            await plugin.search_yt("x", "nope")

    async def test_next_result_skips_bad_json(self, plugin, fake_exec):
        write(Path(plugin._get_ytdlp_path()))
        fake_exec.next = FakeProcess(
            stdout=b"not json\n" + json.dumps(yt_entry(4)).encode() + b"\n"
        )
        await plugin.search_yt("x")
        assert (await plugin.next_yt_result())["id"] == yt_id(4)
        assert await plugin.next_yt_result() is None

    async def test_single_url_prefers_local_file(self, plugin, fake_exec):
        write(Path(plugin.music_path) / f"{yt_id(1)}.webm", b"hello")
        url = await plugin.single_yt_url(yt_id(1))
        assert url.startswith("data:audio/")
        assert base64.b64decode(url.split(",", 1)[1]) == b"hello"
        assert fake_exec.calls == []

    async def test_single_url_from_ytdlp(self, plugin, fake_exec):
        write(Path(plugin._get_ytdlp_path()))
        fake_exec.next = FakeProcess(stdout=json.dumps(yt_entry(7)).encode())
        assert await plugin.single_yt_url(yt_id(7)) == "https://audio/7"
        args = fake_exec.calls[0]["args"]
        # the id comes after "--" so it can never be parsed as an option
        assert args[args.index("--") + 1] == yt_id(7)

    async def test_single_url_no_output(self, plugin, fake_exec):
        write(Path(plugin._get_ytdlp_path()))
        fake_exec.next = FakeProcess(stdout=b"")
        assert await plugin.single_yt_url(yt_id(7)) is None

    @pytest.mark.parametrize(
        "bad", ["--exec=touch pwned", "../../etc/passwd", "abc", "https://evil.com/x"]
    )
    async def test_single_url_rejects_invalid_ids(self, plugin, fake_exec, bad):
        write(Path(plugin._get_ytdlp_path()))
        assert await plugin.single_yt_url(bad) is None
        assert fake_exec.calls == []

    async def test_single_url_accepts_youtube_urls(self, plugin, fake_exec):
        write(Path(plugin._get_ytdlp_path()))
        fake_exec.next = FakeProcess(stdout=json.dumps(yt_entry(1)).encode())
        url = "https://www.youtube.com/watch?v=" + yt_id(1)
        assert await plugin.single_yt_url(url) == "https://audio/1"

    async def test_download_skips_existing(self, plugin, fake_exec):
        write(Path(plugin.music_path) / f"{yt_id(1)}.webm")
        await plugin.download_yt_audio(yt_id(1))
        assert fake_exec.calls == []

    async def test_download_invokes_ytdlp(self, plugin, fake_exec):
        write(Path(plugin._get_ytdlp_path()))

        def run(args):
            write(Path(plugin.music_path) / f"{yt_id(1)}.m4a")
            return FakeProcess(returncode=0)

        fake_exec.next = run
        await plugin.download_yt_audio(yt_id(1))
        args = fake_exec.calls[0]["args"]
        assert args[args.index("--") + 1] == yt_id(1)
        assert plugin.music_path in args

    async def test_download_failure_raises_and_cleans_up(self, plugin, fake_exec):
        write(Path(plugin._get_ytdlp_path()))

        def run(args):
            write(Path(plugin.music_path) / f"{yt_id(1)}.webm.part")
            return FakeProcess(returncode=1, stderr=b"HTTP Error 403")

        fake_exec.next = run
        with pytest.raises(RuntimeError, match="403"):
            await plugin.download_yt_audio(yt_id(1))
        assert list(Path(plugin.music_path).iterdir()) == []

    async def test_download_rejects_invalid_id(self, plugin, fake_exec):
        with pytest.raises(ValueError):
            await plugin.download_yt_audio("-o/tmp/x")
        assert fake_exec.calls == []

    async def test_resolve_timeout_kills_process(self, plugin, fake_exec, monkeypatch):
        write(Path(plugin._get_ytdlp_path()))
        proc = FakeProcess()

        async def hang():
            await asyncio.sleep(10)

        proc.communicate = hang
        fake_exec.next = proc
        monkeypatch.setattr(main, "YT_RESOLVE_TIMEOUT", 0.05)
        assert await plugin.single_yt_url(yt_id(1)) is None
        assert proc.terminated or proc.killed

    def test_entry_to_info_flat_search_thumbnail(self):
        info = main.Plugin.entry_to_info({
            "id": yt_id(3),
            "url": "https://www.youtube.com/watch?v=" + yt_id(3),
            "title": "x",
        })
        assert info["thumbnail"] == f"https://i.ytimg.com/vi/{yt_id(3)}/hqdefault.jpg"

    def test_entry_to_info_prefers_largest_thumbnail(self):
        info = main.Plugin.entry_to_info({
            "id": yt_id(3),
            "thumbnails": [{"url": "small"}, {"url": "large"}],
        })
        assert info["thumbnail"] == "large"


# --------------------------------------------------------------------------- #
# Direct URL / iTunes
# --------------------------------------------------------------------------- #


class TestDirectDownloads:
    async def test_download_url_uses_path_extension(self, plugin, fake_http):
        fake_http.routes["https://cdn/"] = FakeResponse(b"mp3data")
        await plugin.download_url("https://cdn/track.mp3", "khi_1")
        assert (Path(plugin.music_path) / "khi_1.mp3").read_bytes() == b"mp3data"

    @pytest.mark.parametrize(
        "ctype,ext",
        [("audio/mpeg", "mp3"), ("audio/ogg", "ogg"), ("audio/wav", "wav"),
         ("application/octet-stream", "webm")],
    )
    async def test_download_url_content_type_fallback(
        self, plugin, fake_http, ctype, ext
    ):
        fake_http.routes["https://cdn/"] = FakeResponse(
            b"x", headers={"content-type": ctype}
        )
        await plugin.download_url("https://cdn/stream", "id1")
        assert (Path(plugin.music_path) / f"id1.{ext}").exists()

    async def test_download_url_http_error_raises(self, plugin, fake_http):
        fake_http.routes["https://cdn/"] = FakeResponse(status=404)
        with pytest.raises(Exception):
            await plugin.download_url("https://cdn/track.mp3", "id1")

    async def test_download_url_delegates_itunes(self, plugin, monkeypatch):
        seen = []

        async def fake_itunes(track_id):
            seen.append(track_id)

        monkeypatch.setattr(plugin, "download_itunes", fake_itunes)
        await plugin.download_url("https://ignored", "itunes_123")
        assert seen == ["itunes_123"]

    async def test_download_itunes(self, plugin, fake_http):
        fake_http.routes["https://itunes.apple.com/lookup"] = FakeResponse(
            json_data={"results": [{"previewUrl": "https://audio.itunes/p.m4a"}]}
        )
        fake_http.routes["https://audio.itunes/"] = FakeResponse(b"m4a")
        await plugin.download_itunes("itunes_42")
        assert (Path(plugin.music_path) / "itunes_42.m4a").read_bytes() == b"m4a"

    async def test_download_itunes_no_results(self, plugin, fake_http):
        fake_http.routes["https://itunes.apple.com/lookup"] = FakeResponse(
            json_data={"results": []}
        )
        with pytest.raises(RuntimeError):
            await plugin.download_itunes("42")
        assert list(Path(plugin.music_path).iterdir()) == []

    async def test_download_itunes_rejects_bad_id(self, plugin, fake_http):
        with pytest.raises(ValueError):
            await plugin.download_itunes("itunes_../../x")
        assert fake_http.calls == []

    async def test_download_itunes_preview_failure_cleans_up(self, plugin, fake_http):
        fake_http.routes["https://itunes.apple.com/lookup"] = FakeResponse(
            json_data={"results": [{"previewUrl": "https://audio.itunes/p.m4a"}]}
        )
        fake_http.routes["https://audio.itunes/"] = FakeResponse(status=500)
        with pytest.raises(Exception):
            await plugin.download_itunes("42")
        assert list(Path(plugin.music_path).iterdir()) == []

    async def test_search_itunes_maps_results(self, plugin, fake_http):
        fake_http.routes["https://itunes.apple.com/search"] = FakeResponse(
            json_data={
                "results": [
                    {
                        "trackId": 1,
                        "trackName": "Theme",
                        "artistName": "Composer",
                        "previewUrl": "https://p/1.m4a",
                        "artworkUrl100": "https://art/100x100bb.jpg",
                        "collectionName": "OST",
                        "trackTimeMillis": 90500,
                    }
                ]
            }
        )
        results = await plugin.search_itunes("zelda", 5)
        assert results == [
            {
                "id": "itunes_1",
                "title": "Theme - Composer",
                "url": "https://p/1.m4a",
                "thumbnail": "https://art/600x600bb.jpg",
                "artist": "Composer",
                "album": "OST",
                "duration": 90,
            }
        ]
        assert fake_http.calls[0]["params"]["limit"] == 5

    async def test_search_itunes_error_returns_empty(self, plugin, fake_http):
        fake_http.routes["https://itunes.apple.com/search"] = FakeResponse(status=503)
        assert await plugin.search_itunes("zelda") == []


# --------------------------------------------------------------------------- #
# Local library
# --------------------------------------------------------------------------- #


class TestLocalLibrary:
    def test_local_match_none(self, plugin):
        assert plugin.local_match("missing") is None

    def test_local_match_found(self, plugin):
        f = write(Path(plugin.music_path) / "song.mp3")
        assert plugin.local_match("song") == str(f)

    def test_local_match_ignores_directories(self, plugin):
        (Path(plugin.music_path) / "song.d").mkdir()
        assert plugin.local_match("song") is None

    async def test_search_local_music_filters_and_limits(self, plugin):
        music = Path(plugin.local_path)
        for name in ["Zelda_Theme.mp3", "mario-song.ogg", "notes.txt", "zelda2.flac"]:
            write(music / name)

        all_results = await plugin.search_local_music("")
        assert {r["filename"] for r in all_results} == {
            "Zelda_Theme.mp3", "mario-song.ogg", "zelda2.flac"
        }

        zelda = await plugin.search_local_music("zelda")
        assert {r["id"] for r in zelda} == {"local_Zelda_Theme", "local_zelda2"}

        assert len(await plugin.search_local_music("", limit=1)) == 1

    async def test_search_local_music_missing_dir(self, plugin, tmp_path):
        plugin.local_path = str(tmp_path / "nope")
        assert await plugin.search_local_music("") == []

    @pytest.mark.parametrize(
        "ext,mime",
        [("mp3", "audio/mpeg"), ("m4a", "audio/mp4"), ("webm", "audio/webm"),
         ("flac", "audio/flac")],
    )
    async def test_get_local_music_url_mime(self, plugin, ext, mime):
        write(Path(plugin.local_path) / f"track.{ext}", b"data")
        url = await plugin.get_local_music_url("local_track")
        assert url.startswith(f"data:{mime};base64,")
        assert base64.b64decode(url.split(",", 1)[1]) == b"data"

    async def test_get_local_music_url_missing(self, plugin):
        assert await plugin.get_local_music_url("local_nothing") is None

    async def test_delete_local_music(self, plugin):
        f = write(Path(plugin.local_path) / "bye.mp3")
        assert await plugin.delete_local_music("local_bye") is True
        assert not f.exists()
        assert await plugin.delete_local_music("local_bye") is False

    async def test_clear_downloads(self, plugin):
        music = Path(plugin.music_path)
        write(music / "a.mp3")
        write(music / "b.webm")
        await plugin.clear_downloads()
        assert list(music.iterdir()) == []

    async def test_import_local_music(self, plugin, tmp_path):
        src = write(tmp_path / "in.flac", b"flac")
        assert await plugin.import_local_music(str(src), "imported") == "local_imported"
        assert (Path(plugin.local_path) / "imported.flac").read_bytes() == b"flac"
        assert await plugin.import_local_music(str(tmp_path / "x.mp3"), "y") is None

    async def test_import_uses_source_name_when_unnamed(self, plugin, tmp_path):
        src = write(tmp_path / "My Song.mp3", b"abc")
        assert await plugin.import_local_music(str(src)) == "local_My Song"

    async def test_import_never_overwrites(self, plugin, tmp_path):
        write(Path(plugin.local_path) / "dup.mp3", b"old")
        src = write(tmp_path / "dup.mp3", b"new")
        assert await plugin.import_local_music(str(src), "dup") == "local_dup_2"
        assert (Path(plugin.local_path) / "dup.mp3").read_bytes() == b"old"
        assert (Path(plugin.local_path) / "dup_2.mp3").read_bytes() == b"new"

    async def test_clear_downloads_keeps_local_library(self, plugin):
        write(Path(plugin.local_path) / "mine.mp3")
        write(Path(plugin.music_path) / "abc.mp3")
        await plugin.clear_downloads()
        assert (Path(plugin.local_path) / "mine.mp3").exists()
        assert list(Path(plugin.music_path).iterdir()) == []

    def test_legacy_imports_move_to_local_library(self, plugin):
        music = Path(plugin.music_path)
        write(music / "My_Own_Song_Remix.mp3")
        write(music / f"{yt_id(1)}.webm")
        write(music / "itunes_42.m4a")
        plugin._migrate_legacy_local_files()
        assert (Path(plugin.local_path) / "My_Own_Song_Remix.mp3").exists()
        assert (music / f"{yt_id(1)}.webm").exists()
        assert (music / "itunes_42.m4a").exists()

    async def test_download_cap_evicts_oldest(self, plugin, monkeypatch):
        monkeypatch.setattr(main, "MAX_DOWNLOADS_TOTAL_BYTES", 10)
        music = Path(plugin.music_path)
        old = write(music / "old.mp3", b"123456")
        new = write(music / "new.mp3", b"123456")
        os.utime(old, (1, 1))
        await plugin._enforce_download_cap(keep=str(new))
        assert not old.exists() and new.exists()


# --------------------------------------------------------------------------- #
# Directory browsing
# --------------------------------------------------------------------------- #


class TestListDirectory:
    async def test_linux_denies_outside_allowed_roots(self, plugin, monkeypatch):
        monkeypatch.setattr(main.platform, "system", lambda: "Linux")
        res = await plugin.list_directory("/etc")
        assert res["error"] == "Access denied"
        assert res["entries"] == []

    async def test_windows_denies_unc_paths(self, plugin, monkeypatch):
        monkeypatch.setattr(main.platform, "system", lambda: "Windows")
        res = await plugin.list_directory(r"\\server\share")
        assert res["error"] == "Access denied"

    async def test_lists_entries(self, plugin, tmp_path, monkeypatch):
        (tmp_path / "sub").mkdir()
        write(tmp_path / "file.mp3")
        if sys.platform != "win32" and not str(tmp_path).startswith("/home"):
            pytest.skip("tmp_path is outside the allowed browse roots on this host")
        res = await plugin.list_directory(str(tmp_path))
        names = {(e["name"], e["is_directory"]) for e in res["entries"]}
        assert ("sub", True) in names
        assert ("file.mp3", False) in names

    async def test_missing_directory(self, plugin, tmp_path):
        if sys.platform == "win32":
            missing = str(tmp_path / "missing")
        else:
            missing = "/home/definitely/not/here"
        res = await plugin.list_directory(missing)
        assert res["error"] == "Directory does not exist"


# --------------------------------------------------------------------------- #
# Cache backups
# --------------------------------------------------------------------------- #


class TestCacheBackups:
    async def test_export_list_import_clear(self, plugin):
        cache = {"123": {"videoId": "abc", "volume": 0.5}}
        await plugin.export_cache(cache)

        backups = await plugin.list_cache_backups()
        assert len(backups) == 1
        assert backups[0].startswith("backup-")

        assert await plugin.import_cache(backups[0]) == cache

        assert await plugin.clear_cache() == 1
        assert await plugin.list_cache_backups() == []

    async def test_import_missing_raises(self, plugin):
        with pytest.raises(Exception):
            await plugin.import_cache("does-not-exist")
