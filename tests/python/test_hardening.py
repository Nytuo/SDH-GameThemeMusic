"""Security / robustness tests for main.Plugin."""
import hashlib
import json
import sys
import time
from pathlib import Path

import pytest

import main
from conftest import FakeResponse


def write(path: Path, data: bytes = b"audio") -> Path:
    path.write_bytes(data)
    return path


class TestPathTraversal:
    @pytest.mark.parametrize(
        "stem", ["../x", "..", ".hidden", "a/b", "a\\b", "", "x" * 300, "a\x00b"]
    )
    def test_unsafe_stems_rejected(self, stem):
        assert not main.is_safe_stem(stem)

    @pytest.mark.parametrize("stem", ["dQw4w9WgXcQ", "-leading-dash", "My Song (1)"])
    def test_safe_stems_accepted(self, stem):
        assert main.is_safe_stem(stem)

    async def test_local_music_url_cannot_escape(self, plugin, tmp_path):
        write(tmp_path / "secret.mp3", b"secret")
        assert await plugin.get_local_music_url("local_../secret") is None

    async def test_delete_cannot_escape(self, plugin, tmp_path):
        victim = write(tmp_path / "victim.mp3")
        assert await plugin.delete_local_music("local_../victim") is False
        assert victim.exists()

    async def test_import_local_music_rejects_bad_destination(self, plugin, tmp_path):
        src = write(tmp_path / "in.mp3")
        assert await plugin.import_local_music(str(src), "../../evil") is None
        assert not (tmp_path / "evil.mp3").exists()

    async def test_import_local_music_rejects_non_audio(self, plugin, tmp_path):
        src = write(tmp_path / "script.sh")
        assert await plugin.import_local_music(str(src), "x") is None

    async def test_download_url_rejects_bad_id(self, plugin, fake_http):
        with pytest.raises(ValueError):
            await plugin.download_url("https://cdn/x.mp3", "../../evil")
        assert fake_http.calls == []

    async def test_download_url_rejects_non_http(self, plugin, fake_http):
        with pytest.raises(ValueError):
            await plugin.download_url("file:///etc/passwd", "abc")

    async def test_import_cache_rejects_traversal(self, plugin):
        with pytest.raises(ValueError):
            await plugin.import_cache("../../settings/config")

    async def test_fetch_url_refuses_non_http(self, plugin, fake_http):
        assert await plugin.fetch_url("file:///etc/passwd") == ""
        assert fake_http.calls == []


class TestImportCacheValidation:
    async def test_keeps_only_well_formed_entries(self, plugin):
        (Path(plugin.cache_path) / "b.json").write_text(json.dumps({
            "1": {"videoId": "abc", "volume": 0.5},
            "2": {"videoId": 5, "volume": 7},
            "3": "garbage",
            "4": {"videoId": "", "extra": "dropped"},
        }))
        assert await plugin.import_cache("b") == {
            "1": {"videoId": "abc", "volume": 0.5},
            "2": {},
            "4": {"videoId": ""},
        }

    async def test_non_object_backup_rejected(self, plugin):
        (Path(plugin.cache_path) / "b.json").write_text("[1, 2]")
        with pytest.raises(ValueError):
            await plugin.import_cache("b")


class TestDownloadLimits:
    async def test_content_length_over_limit(self, plugin, fake_http, monkeypatch):
        monkeypatch.setattr(main, "MAX_DOWNLOAD_BYTES", 10)
        fake_http.routes["https://cdn/"] = FakeResponse(
            b"x" * 5, headers={"content-length": "1000"}
        )
        with pytest.raises(ValueError):
            await plugin.download_url("https://cdn/a.mp3", "id1")
        assert list(Path(plugin.music_path).iterdir()) == []

    async def test_streamed_body_over_limit(self, plugin, fake_http, monkeypatch):
        monkeypatch.setattr(main, "MAX_DOWNLOAD_BYTES", 10)
        fake_http.routes["https://cdn/"] = FakeResponse(b"x" * 100)
        with pytest.raises(ValueError):
            await plugin.download_url("https://cdn/a.mp3", "id1")
        assert list(Path(plugin.music_path).iterdir()) == []

    async def test_empty_body_is_an_error(self, plugin, fake_http):
        fake_http.routes["https://cdn/"] = FakeResponse(b"")
        with pytest.raises(ValueError):
            await plugin.download_url("https://cdn/a.mp3", "id1")

    async def test_large_local_file_not_inlined(self, plugin, monkeypatch):
        monkeypatch.setattr(main, "MAX_INLINE_AUDIO_BYTES", 4)
        write(Path(plugin.music_path) / "big.mp3", b"12345")
        assert await plugin.get_local_music_url("local_big") is None

    async def test_partial_downloads_cleaned_on_start(self, plugin, monkeypatch):
        leftover = write(Path(plugin.music_path) / "abc.webm.part")

        async def no_update():
            return None

        monkeypatch.setattr(plugin, "_startup_ytdlp_update", no_update)
        await plugin._main()
        assert not leftover.exists()


class TestYtDlpUpdateSafety:
    async def test_checksum_mismatch_keeps_old_binary(self, plugin, fake_http):
        target = write(Path(plugin._get_ytdlp_path()), b"old")
        fake_http.routes["https://dl/"] = FakeResponse(b"tampered")
        ok = await plugin.download_ytdlp_binary("https://dl/yt-dlp", "0" * 64)
        assert ok is False
        assert target.read_bytes() == b"old"
        assert [p.name for p in target.parent.iterdir()] == [target.name]

    async def test_checksum_match_installs(self, plugin, fake_http):
        write(Path(plugin._get_bundled_ytdlp_path()), b"old")
        fake_http.routes["https://dl/"] = FakeResponse(b"new")
        digest = hashlib.sha256(b"new").hexdigest()
        assert await plugin.download_ytdlp_binary("https://dl/yt-dlp", digest)
        # updates go to the runtime dir; the bundled binary is never touched
        assert Path(plugin._get_ytdlp_path()).read_bytes() == b"new"
        assert Path(plugin._get_bundled_ytdlp_path()).read_bytes() == b"old"

    async def test_expected_checksum_parsed_from_sums(self, plugin, fake_http):
        fake_http.routes["https://sums/"] = FakeResponse(
            b"aaaa  yt-dlp.exe\nbbbb  yt-dlp_linux\n"
        )
        assets = [{"name": "SHA2-256SUMS", "browser_download_url": "https://sums/x"}]
        assert await plugin._fetch_expected_sha256(assets, "yt-dlp_linux") == "bbbb"
        assert await plugin._fetch_expected_sha256(assets, "missing") is None
        assert await plugin._fetch_expected_sha256([], "yt-dlp_linux") is None

    async def test_update_refused_without_checksum(self, plugin, monkeypatch):
        async def ver():
            return "2025.01.01"

        async def rel():
            return {
                "version": "2026.01.01",
                "assets": [{"name": "yt-dlp_linux", "browser_download_url": "u"}],
            }

        async def must_not_download(*a, **kw):
            raise AssertionError("downloaded without checksum")

        monkeypatch.setattr(plugin, "get_ytdlp_version", ver)
        monkeypatch.setattr(plugin, "get_latest_ytdlp_release", rel)
        monkeypatch.setattr(plugin, "_get_ytdlp_asset_name", lambda: "yt-dlp_linux")
        monkeypatch.setattr(plugin, "download_ytdlp_binary", must_not_download)
        assert await plugin.check_and_update_ytdlp() is False

    async def test_startup_update_is_throttled(self, plugin, monkeypatch):
        write(Path(plugin._get_ytdlp_path()))
        calls = []

        async def check():
            calls.append(1)
            return False

        monkeypatch.setattr(plugin, "check_and_update_ytdlp", check)
        plugin.settings.setSetting("ytdlp_last_update_check", time.time())
        await plugin._startup_ytdlp_update()
        assert calls == []

        plugin.settings.setSetting("ytdlp_last_update_check", 0)
        await plugin._startup_ytdlp_update()
        assert calls == [1]
        assert plugin.settings.getSetting("ytdlp_last_update_check") > 0

    async def test_startup_update_runs_when_binary_missing(self, plugin, monkeypatch):
        calls = []

        async def check():
            calls.append(1)
            return True

        monkeypatch.setattr(plugin, "check_and_update_ytdlp", check)
        plugin.settings.setSetting("ytdlp_last_update_check", time.time())
        await plugin._startup_ytdlp_update()
        assert calls == [1]

    async def test_manual_update_reports_result(self, plugin, monkeypatch):
        async def check():
            return False

        async def ver():
            return "2026.06.09"

        monkeypatch.setattr(plugin, "check_and_update_ytdlp", check)
        monkeypatch.setattr(plugin, "get_ytdlp_version", ver)
        assert await plugin.update_yt_dlp() == {
            "success": True,
            "message": "yt-dlp is up to date (2026.06.09)",
        }


class TestDirectoryBrowsing:
    @pytest.mark.skipif(sys.platform == "win32", reason="POSIX path semantics")
    async def test_dotdot_escape_denied(self, plugin, monkeypatch):
        monkeypatch.setattr(main.platform, "system", lambda: "Linux")
        res = await plugin.list_directory("/home/../etc")
        assert res["error"] == "Access denied"

    @pytest.mark.skipif(sys.platform == "win32", reason="POSIX path semantics")
    async def test_prefix_lookalike_denied(self, plugin, monkeypatch):
        monkeypatch.setattr(main.platform, "system", lambda: "Linux")
        res = await plugin.list_directory("/homeevil")
        assert res["error"] == "Access denied"

    async def test_windows_requires_drive_path(self, plugin, monkeypatch):
        monkeypatch.setattr(main.platform, "system", lambda: "Windows")
        for bad in ["relative\\dir", "//server/share", "\\\\?\\C:\\"]:
            res = await plugin.list_directory(bad)
            assert res["error"] == "Access denied", bad

    async def test_directories_listed_first(self, plugin, tmp_path):
        if sys.platform != "win32" and not str(tmp_path).startswith("/home"):
            pytest.skip("tmp_path is outside the allowed browse roots")
        write(tmp_path / "a.mp3")
        (tmp_path / "z_dir").mkdir()
        res = await plugin.list_directory(str(tmp_path))
        names = [e["name"] for e in res["entries"]]
        assert names.index("z_dir") < names.index("a.mp3")


class TestLocalSearch:
    async def test_ignores_generic_words(self, plugin):
        music = Path(plugin.local_path)
        write(music / "Zelda_Overworld.mp3")
        write(music / "Mario_Theme.ogg")
        write(music / "notes.txt")

        found = await plugin.search_local_music("Zelda main theme")
        assert [r["filename"] for r in found] == ["Zelda_Overworld.mp3"]

        everything = await plugin.search_local_music("main theme")
        assert {r["filename"] for r in everything} == {
            "Zelda_Overworld.mp3", "Mario_Theme.ogg"
        }
