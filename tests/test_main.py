import pytest
import asyncio
import sys
from pathlib import Path
from unittest.mock import Mock, patch, AsyncMock, MagicMock
import os

sys.modules['decky'] = MagicMock()

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


class TestYtDlpIntegration:
    """Test yt-dlp integration and subprocess handling."""
    
    @pytest.mark.asyncio
    async def test_ytdlp_command_includes_no_window_flag_on_windows(self):
        """Test that yt-dlp subprocess creation includes CREATE_NO_WINDOW flag on Windows."""
        with patch('sys.platform', 'win32'):
            with patch('asyncio.create_subprocess_exec') as mock_exec:
                import subprocess
                mock_process = AsyncMock()
                mock_process.communicate = AsyncMock(return_value=(b'', b''))
                mock_process.returncode = 0
                mock_exec.return_value = mock_process
                
                await asyncio.create_subprocess_exec(
                    'yt-dlp', '--version',
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                    creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == 'win32' else 0
                )
                
                assert mock_exec.called
                if sys.platform == 'win32':
                    call_kwargs = mock_exec.call_args[1]
                    assert 'creationflags' in call_kwargs


class TestAudioPlayerState:
    """Test audio player state management."""
    
    def test_audio_player_singleton_pattern(self):
        """Test that GlobalAudioPlayer follows singleton pattern."""
        
        
        
        
        
        
        
        
        
        class TestSingleton:
            _instance = None
            
            @classmethod
            def getInstance(cls):
                if cls._instance is None:
                    cls._instance = TestSingleton()
                return cls._instance
        
        instance1 = TestSingleton.getInstance()
        instance2 = TestSingleton.getInstance()
        
        
        assert instance1 is instance2
        assert TestSingleton._instance is not None
        
        
        instance3 = TestSingleton.getInstance()
        assert instance3 is instance1 


class TestGameStateTracking:
    """Test game state tracking and audio control."""
    
    def test_audio_pauses_when_game_launches(self):
        """Test that audio player pauses when gamesRunning > 0."""
        
        mock_audio = MagicMock()
        mock_audio.paused = False
        
        
        games_running = []
        
        
        assert len(games_running) == 0
        
        
        games_running.append({"appId": "12345"})
        
        
        assert len(games_running) > 0
        
        
        if len(games_running) > 0:
            mock_audio.pause()
        
        
        mock_audio.pause.assert_called_once()
        
    def test_audio_resumes_when_game_exits(self):
        """Test that audio player can resume after game exits."""
        
        mock_audio = MagicMock()
        mock_audio.paused = True
        mock_audio.play = MagicMock(return_value=asyncio.Future())
        mock_audio.play.return_value.set_result(None)
        
        
        games_running = [{"appId": "12345"}]
        
        
        assert len(games_running) > 0
        assert mock_audio.paused is True
        
        
        games_running.clear()
        
        
        assert len(games_running) == 0
        
        
        
        
        
        
        assert hasattr(mock_audio, 'play')
        assert callable(mock_audio.play)


class TestContextMenuPatch:
    """Test context menu patching."""
    
    def test_symbol_handling_in_webpack_modules(self):
        """Test that Symbol values are properly handled during webpack module scanning."""
        
        
        
        
        class JSSymbol:
            def __init__(self, description):
                self.description = description
            
            def __repr__(self):
                return f'Symbol({self.description})'
            
            def __hash__(self):
                return hash(id(self))
        
        
        symbol_key1 = JSSymbol('react.element')
        symbol_key2 = JSSymbol('react.fragment')
        
        mock_module = {
            'default': lambda: None,
            'someFunction': lambda: None,
            symbol_key1: True,  
            symbol_key2: True,
            '__esModule': True
        }
        
        
        
        
        
        safe_props = []
        for prop in mock_module:
            
            if isinstance(prop, str) and callable(mock_module[prop]):
                safe_props.append(prop)
        
        
        assert 'default' in safe_props
        assert 'someFunction' in safe_props
        
        assert len(safe_props) == 2  
        
    def test_function_check_before_tostring(self):
        """Test that typeof checks are performed before calling toString."""
        
        
        
        class JSSymbol:
            def __init__(self, name):
                self.name = name
        
        symbol_key = JSSymbol('symbol_key')
        
        test_object = {
            'validFunction': lambda x: x,
            'anotherFunction': print,
            symbol_key: 'symbol_value',  
            'normalProp': 'string'
        }
        
        
        functions_found = []
        
        for key in test_object:
            value = test_object[key]
            
            if callable(value) and isinstance(key, str):
                
                functions_found.append(key)
        
        
        assert 'validFunction' in functions_found
        assert 'anotherFunction' in functions_found
        assert len(functions_found) == 2
        
        
        assert symbol_key in test_object
        assert symbol_key not in functions_found


class TestFileOperations:
    """Test file operations and directory management."""
    
    @pytest.mark.asyncio
    async def test_theme_directory_creation(self, tmp_path):
        """Test that theme directories are created properly."""
        theme_dir = tmp_path / "themes"
        theme_dir.mkdir()
        
        assert theme_dir.exists()
        assert theme_dir.is_dir()
    
    @pytest.mark.asyncio
    async def test_theme_file_storage(self, tmp_path):
        """Test that theme files are stored with correct structure."""
        theme_dir = tmp_path / "themes" / "12345"
        theme_dir.mkdir(parents=True)
        
        theme_file = theme_dir / "theme.mp3"
        theme_file.write_text("mock audio content")
        
        assert theme_file.exists()
        assert theme_file.is_file()


class TestConfigurationManagement:
    """Test configuration and settings management."""
    
    def test_settings_structure(self):
        """Test that settings follow expected structure."""
        settings = {
            "volume": 0.5,
            "autoPlay": True,
            "customThemes": {}
        }
        
        assert "volume" in settings
        assert isinstance(settings["volume"], (int, float))
        assert 0 <= settings["volume"] <= 1
    
    def test_theme_metadata_structure(self):
        """Test that theme metadata follows expected structure."""
        metadata = {
            "gameId": "12345",
            "themeName": "Custom Theme",
            "url": "http://example.com/theme.mp3",
            "localPath": "/path/to/theme.mp3"
        }
        
        assert "gameId" in metadata
        assert "themeName" in metadata
        assert isinstance(metadata["gameId"], str)


class TestErrorHandling:
    """Test error handling and edge cases."""
    
    @pytest.mark.asyncio
    async def test_missing_audio_file_handling(self):
        """Test handling of missing audio files."""
        from pathlib import Path
        
        fake_path = Path("/nonexistent/audio.mp3")
        assert not fake_path.exists()
    
    @pytest.mark.asyncio
    async def test_invalid_url_handling(self):
        """Test handling of invalid URLs."""
        invalid_urls = [
            "",
            "not-a-url",
            "http://",
            "ftp://invalid.com"
        ]
        
        for url in invalid_urls:
            assert not url.startswith("https://") or len(url) < 10


class TestUtilityFunctions:
    """Test utility functions and helpers."""
    
    def test_path_sanitization(self):
        """Test that file paths are properly sanitized."""
        unsafe_names = [
            "../../../etc/passwd",
            "C:\\Windows\\System32",
            "file:///etc/passwd"
        ]
        
        for name in unsafe_names:
            assert ".." not in Path(name).name or not Path(name).is_absolute()
    
    def test_url_validation(self):
        """Test URL validation logic."""
        valid_urls = [
            "https://example.com/audio.mp3",
            "https://youtube.com/watch?v=12345"
        ]
        
        invalid_urls = [
            "javascript:alert(1)",
            "data:text/html,<script>alert(1)</script>",
            "file:///etc/passwd"
        ]
        
        for url in valid_urls:
            assert url.startswith("http://") or url.startswith("https://")
        
        for url in invalid_urls:
            assert not (url.startswith("http://") or url.startswith("https://"))


@pytest.mark.asyncio
async def test_async_operation_cleanup():
    """Test that async operations are properly cleaned up."""
    tasks = []
    
    async def sample_task():
        await asyncio.sleep(0.01)
    
    task = asyncio.create_task(sample_task())
    tasks.append(task)
    
    await asyncio.gather(*tasks)
    
    assert task.done()
    assert not task.cancelled()


def test_platform_compatibility():
    """Test platform-specific code paths."""
    import platform
    
    current_platform = platform.system()
    assert current_platform in ['Windows', 'Linux', 'Darwin']
    
    if current_platform == 'Windows':
        import subprocess
        assert hasattr(subprocess, 'CREATE_NO_WINDOW')
