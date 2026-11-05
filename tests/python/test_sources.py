"""Deezer / SoundCloud sources, URL safety, the local audio server."""
import asyncio
import json
from pathlib import Path

import pytest

import main
from conftest import FakeProcess, FakeResponse


def write(path: Path, data: bytes = b"audio") -> Path:
    path.write_bytes(data)
    return path


class TestPublicUrl:
    @pytest.mark.parametrize(
        "url",
        [
            "https://downloads.khinsider.com/x.mp3",
            "http://example.com/a",
            "https://cdn/track.mp3",
        ],
    )
    def test_allows_public(self, url):
        assert main.is_public_http_url(url)

    @pytest.mark.parametrize(
        "url",
        [
            "http://localhost/x",
            "http://127.0.0.1:1337/x",
            "http://192.168.1.2/x",
            "http://10.0.0.1/x",
            "http://169.254.169.254/latest",
            "http://[::1]/x",
            "http://printer.local/x",
            "file:///etc/passwd",
            "ftp://example.com/x",
            "https:///nohost",
            "",
        ],
    )
    def test_rejects_private_and_non_http(self, url):
        assert not main.is_public_http_url(url)

    async def test_fetch_url_refuses_local_addresses(self, plugin, fake_http):
        assert await plugin.fetch_url("http://127.0.0.1:8080/") == ""
        assert fake_http.calls == []

    async def test_download_url_refuses_local_addresses(self, plugin, fake_http):
        with pytest.raises(ValueError):
            await plugin.download_url("http://192.168.0.5/a.mp3", "id1")
        assert fake_http.calls == []


class TestSoundCloudTargets:
    def test_targets(self):
        assert main.is_ytdlp_target("https://soundcloud.com/a/b")
        assert main.is_ytdlp_target("https://api.soundcloud.com/tracks/1")
        assert main.is_ytdlp_target("dQw4w9WgXcQ")
        assert not main.is_ytdlp_target("https://evil.com/soundcloud.com")
        assert not main.is_ytdlp_target("https://notsoundcloud.com/a")
        assert not main.is_ytdlp_target("../../etc/passwd")

    async def test_download_soundcloud_uses_hashed_name(self, plugin, fake_exec):
        write(Path(plugin._get_ytdlp_path()))
        url = "https://soundcloud.com/a/b"

        def make(args):
            name = main.get_audio_filename(url)
            write(Path(plugin.music_path) / f"{name}.mp3")
            return FakeProcess()

        fake_exec.next = make
        await plugin.download_yt_audio(url)
        args = fake_exec.calls[0]["args"]
        assert args[args.index("--") + 1] == url
        assert plugin.local_match(main.get_audio_filename(url))

    async def test_hls_only_stream_is_downloaded_instead(self, plugin, fake_exec):
        write(Path(plugin._get_ytdlp_path()))
        url = "https://soundcloud.com/a/b"
        info = {"url": "https://cdn/x.m3u8", "protocol": "m3u8_native"}
        calls = []

        def make(args):
            calls.append(args)
            if "-j" in args:
                return FakeProcess(stdout=json.dumps(info).encode())
            write(Path(plugin.music_path) / f"{main.get_audio_filename(url)}.mp3")
            return FakeProcess()

        fake_exec.next = make
        result = await plugin.single_yt_url(url)
        assert result and result.startswith("data:audio/")
        assert len(calls) == 2

    async def test_unsafe_target_refused(self, plugin, fake_exec):
        assert await plugin.single_yt_url("https://evil.com/x") is None
        with pytest.raises(ValueError):
            await plugin.download_yt_audio("https://evil.com/x")
        assert fake_exec.calls == []


class TestDeezer:
    async def test_search(self, plugin, fake_http):
        fake_http.routes["https://api.deezer.com/search"] = FakeResponse(
            json_data={
                "data": [
                    {
                        "id": 7,
                        "title": "Theme",
                        "preview": "https://cdn.deezer/p.mp3",
                        "duration": 30,
                        "artist": {"name": "Composer"},
                        "album": {"title": "OST", "cover_big": "https://img/c.jpg"},
                    },
                    {"id": 8, "title": "no preview", "preview": ""},
                ]
            }
        )
        results = await plugin.search_deezer("zelda", 5)
        assert results == [{
            "id": "deezer_7",
            "title": "Theme - Composer",
            "url": "https://cdn.deezer/p.mp3",
            "thumbnail": "https://img/c.jpg",
            "artist": "Composer",
            "album": "OST",
            "duration": 30,
        }]
        assert fake_http.calls[0]["params"]["q"] == "zelda"

    async def test_search_failure_returns_empty(self, plugin, fake_http):
        fake_http.routes["https://api.deezer.com/"] = FakeResponse(status=500)
        assert await plugin.search_deezer("x") == []

    async def test_download(self, plugin, fake_http):
        fake_http.routes["https://api.deezer.com/track/7"] = FakeResponse(
            json_data={"preview": "https://cdn.deezer/p.mp3"}
        )
        fake_http.routes["https://cdn.deezer/"] = FakeResponse(b"mp3")
        await plugin.download_url("https://ignored", "deezer_7")
        assert (Path(plugin.music_path) / "deezer_7.mp3").read_bytes() == b"mp3"
        assert await plugin.local_audio_exists("deezer_7")

    async def test_download_without_preview_fails_cleanly(self, plugin, fake_http):
        fake_http.routes["https://api.deezer.com/track/7"] = FakeResponse(
            json_data={"preview": ""}
        )
        with pytest.raises(RuntimeError):
            await plugin.download_deezer("deezer_7")
        assert list(Path(plugin.music_path).iterdir()) == []

    async def test_download_rejects_bad_id(self, plugin, fake_http):
        with pytest.raises(ValueError):
            await plugin.download_deezer("deezer_../x")


class TestDownloadLocking:
    async def test_concurrent_downloads_fetch_once(self, plugin, fake_http):
        fake_http.routes["https://cdn/"] = FakeResponse(b"mp3data")
        await asyncio.gather(
            plugin.download_url("https://cdn/t.mp3", "same"),
            plugin.download_url("https://cdn/t.mp3", "same"),
            plugin.download_url("https://cdn/t.mp3", "same"),
        )
        assert [p.name for p in Path(plugin.music_path).iterdir()] == ["same.mp3"]
        assert len(fake_http.calls) == 1


class TestAudioServer:
    async def test_serves_files_with_ranges_and_only_audio(self, plugin):
        import aiohttp

        write(Path(plugin.music_path) / "abc.mp3", b"0123456789")
        write(Path(plugin.local_path) / "mine.ogg", b"ogg-data")
        write(Path(plugin.music_path) / "secret.txt", b"nope")
        await plugin._start_audio_server()
        try:
            assert plugin.audio_port
            base = f"http://127.0.0.1:{plugin.audio_port}/audio"
            url = await plugin.local_audio_url("abc")
            assert url == f"{base}/music/abc.mp3"
            assert await plugin.get_local_music_url("local_mine") == f"{base}/local/mine.ogg"

            async with aiohttp.ClientSession() as session:
                async with session.get(url, headers={"Range": "bytes=2-4"}) as res:
                    assert res.status == 206
                    assert await res.read() == b"234"
                async with session.get(f"{base}/music/secret.txt") as res:
                    assert res.status == 404
                async with session.get(f"{base}/music/..%2Fabc.mp3") as res:
                    assert res.status == 404
                async with session.get(f"{base}/other/abc.mp3") as res:
                    assert res.status == 404
        finally:
            await plugin._unload()
        assert plugin.audio_port is None

    async def test_falls_back_to_data_url_without_server(self, plugin):
        write(Path(plugin.music_path) / "abc.mp3", b"x")
        assert plugin.audio_port is None
        assert (await plugin.local_audio_url("abc")).startswith("data:audio/mpeg")


class TestBackupPruning:
    async def test_keeps_only_recent_backups(self, plugin, monkeypatch):
        monkeypatch.setattr(main, "BACKUPS_TO_KEEP", 2)
        for i in range(4):
            write(Path(plugin.cache_path) / f"backup-2026-01-0{i + 1}.json", b"{}")
        await plugin.export_cache({})
        names = await plugin.list_cache_backups()
        assert len(names) == 2
        assert names[0] > "backup-2026-02"
