import importlib.util
import json
import os
import pathlib
import subprocess
import tempfile
import threading
import time
import unittest
from unittest.mock import MagicMock, patch

ROOT = pathlib.Path(__file__).parents[1]


class UtilityTranscribeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.home = pathlib.Path(self.temp.name)
        self.h = self.home / ".inkboard-team"
        self.h.mkdir()
        (self.h / "config.json").write_text(
            '{"url":"https://example.invalid","runnerToken":"fake"}'
        )
        (self.h / "worker-secrets.json").write_text(
            '{"DEEPSEEK_API_KEY":"shared-test-key"}'
        )
        with patch.object(pathlib.Path, "home", return_value=self.home):
            spec = importlib.util.spec_from_file_location(
                "utility_transcribe", ROOT / "runner/utility.py"
            )
            self.u = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(self.u)
        self.work = self.home / "utility" / "job"
        self.inputs = self.work / "inputs"
        self.inputs.mkdir(parents=True)
        (self.work / "tmp").mkdir()

    def tearDown(self):
        self.temp.cleanup()

    def audio(self, name="audio-BV1ab4111111.m4a"):
        path = self.inputs / name
        path.write_bytes(b"fake-audio")
        return path

    def test_busy_lock_is_skipped_without_waiting(self):
        lock = self.h / "media.lock"
        lock.mkdir()
        started = time.monotonic()
        self.assertFalse(self.u.acquire_media_lock(wait_seconds=0))
        self.assertLess(time.monotonic() - started, 1.0)
        self.assertTrue(lock.is_dir())

    def test_lock_waits_until_the_media_worker_releases_it(self):
        lock = self.h / "media.lock"
        lock.mkdir()

        def release():
            time.sleep(0.2)
            lock.rmdir()

        thread = threading.Thread(target=release)
        thread.start()
        try:
            self.assertTrue(
                self.u.acquire_media_lock(wait_seconds=2, poll_seconds=0.05)
            )
        finally:
            thread.join()
        self.assertTrue(lock.is_dir())
        self.u.release_media_lock()
        self.assertFalse(lock.exists())

    def test_stale_lock_from_a_dead_worker_is_reclaimed(self):
        lock = self.h / "media.lock"
        lock.mkdir()
        old = time.time() - 3601
        os.utime(lock, (old, old))
        self.assertTrue(self.u.acquire_media_lock(wait_seconds=0))
        self.u.release_media_lock()

    def test_success_writes_transcript_and_removes_the_audio(self):
        audio = self.audio()
        self.u.media_duration = lambda path: 65.0
        converted = []

        def to_wav(source, target, max_minutes, work):
            converted.append((source, target, max_minutes))
            target.write_bytes(b"RIFF-fake")

        self.u.to_wav = to_wav
        self.u.run_xasr = lambda wav, media, duration: {
            "segments": [
                {"start": 0.0, "end": 2.0, "text": "第一段，你好。"},
                {"start": 61.5, "end": 63.0, "text": "第二段。"},
            ],
            "audio_s": 65.0,
            "max_rss_mb": 420.0,
        }

        result = self.u.transcribe_bili_audio(audio, self.work, self.inputs)

        self.assertTrue(result["ok"], result)
        transcript = self.inputs / "transcript-BV1ab4111111.txt"
        self.assertEqual(
            transcript.read_text(),
            "[00:00] 第一段，你好。\n[01:01] 第二段。\n",
        )
        self.assertFalse(audio.exists(), "downloaded audio must be deleted")
        self.assertEqual([p.name for p in self.inputs.glob("*.wav")], [])
        self.assertFalse((self.h / "media.lock").exists())
        self.assertEqual(converted[0][2], 90)

    def test_failure_still_removes_audio_and_the_temporary_wav(self):
        audio = self.audio()
        self.u.media_duration = lambda path: 12.0

        def to_wav(source, target, max_minutes, work):
            target.write_bytes(b"RIFF-fake")

        self.u.to_wav = to_wav

        def broken(wav, media, duration):
            raise RuntimeError("recognition failed")

        self.u.run_xasr = broken
        result = self.u.transcribe_bili_audio(audio, self.work, self.inputs)

        self.assertFalse(result["ok"])
        self.assertEqual(result["reason"], "failed")
        self.assertFalse(audio.exists(), "failed transcription must still delete audio")
        self.assertEqual([p.name for p in self.inputs.glob("*.wav")], [])
        self.assertFalse((self.inputs / "transcript-BV1ab4111111.txt").exists())
        self.assertFalse((self.h / "media.lock").exists())

    def test_over_limit_audio_is_removed_without_transcribing(self):
        audio = self.audio()
        self.u.media_duration = lambda path: 90 * 60 + 1
        self.u.run_xasr = MagicMock(side_effect=AssertionError("must not transcribe"))

        result = self.u.transcribe_bili_audio(audio, self.work, self.inputs)

        self.assertFalse(result["ok"])
        self.assertEqual(result["reason"], "too_long")
        self.u.run_xasr.assert_not_called()
        self.assertFalse(audio.exists())

    def test_busy_lock_skips_transcription_and_deletes_audio(self):
        audio = self.audio()
        self.u.media_duration = lambda path: 30.0
        (self.h / "media.lock").mkdir()
        self.u.to_wav = MagicMock(side_effect=AssertionError("must not convert"))
        self.u.run_xasr = MagicMock(side_effect=AssertionError("must not transcribe"))

        result = self.u.transcribe_bili_audio(
            audio, self.work, self.inputs, wait_seconds=0
        )

        self.assertFalse(result["ok"])
        self.assertEqual(result["reason"], "busy")
        self.assertFalse(audio.exists())
        self.assertTrue((self.h / "media.lock").is_dir(), "the other worker keeps its lock")

    def test_prompt_points_the_agent_at_the_system_transcript(self):
        prompt = self.u.utility_task_prompt(
            {"message": "把这个 B 站视频整理成笔记"},
            {"ok": True, "transcript": "inputs/transcript-BV1ab4111111.txt"},
        )
        self.assertIn(
            "转写已由系统完成，见 inputs/transcript-*.txt；你自己不要启动转写模型", prompt
        )
        self.assertNotIn("不要启动任何语音转写模型", prompt)

    def test_prompt_without_a_transcript_still_forbids_starting_models(self):
        prompt = self.u.utility_task_prompt({"message": "整理资料"})
        self.assertIn("不要启动任何语音转写模型", prompt)

    def test_prompt_explains_why_a_bilibili_audio_was_not_transcribed(self):
        prompt = self.u.utility_task_prompt(
            {"message": "整理这个视频"},
            {"ok": False, "reason": "too_long", "duration": 7200, "max_minutes": 90},
        )
        self.assertIn("超过本机转写上限", prompt)
        self.assertIn("不要启动语音转写模型", prompt)
        self.assertNotIn("转写已由系统完成", prompt)

    def test_execute_transcribes_a_bilibili_audio_before_running_the_agent(self):
        job = {
            "id": "file-bili",
            "payload": {
                "message": "request-bili",
                "lease": "lease1",
                "effort": "high",
                "urls": ["https://www.bilibili.com/video/BV1ab4111111"],
            },
        }
        audio = self.audio()
        seen = {}
        calls = []

        def cloud(path, body):
            calls.append(path)
            if path == "inputs":
                return {"messages": []}
            if path == "media/heartbeat":
                return {"ok": True}
            return {"ok": True}

        def fake_process(args, work):
            self.assertEqual(args[0], "yt-dlp")
            # Bilibili's audio CDN answers 567 without an explicit whole-file range.
            self.assertIn("--add-header", args)
            self.assertIn("Range:bytes=0-", args)

        def fake_transcribe(path, work, inputs, media=None, wait_seconds=None):
            seen["audio"] = path
            (inputs / "transcript-BV1ab4111111.txt").write_text("[00:00] 转写内容")
            return {
                "ok": True,
                "transcript": "inputs/transcript-BV1ab4111111.txt",
                "duration": 30.0,
            }

        proc = MagicMock()
        proc.pid = 987654  # above the macOS PID ceiling, so the test never signals a real process
        proc.communicate.return_value = (
            json.dumps(
                {"type": "final", "reason": {"kind": "completed"}, "text": "笔记已生成"}
            ),
            "",
        )
        def spawn(*args, **kwargs):
            return proc

        u = self.u
        with patch.object(u, "cloud", side_effect=cloud), patch.object(
            u, "download"
        ), patch.object(u, "audio_process", side_effect=fake_process), patch.object(
            u, "transcribe_bili_audio", side_effect=fake_transcribe
        ), patch.object(
            u, "settings", return_value=json.loads((ROOT / "config/team.json").read_text())
        ), patch.object(
            u, "api_key", return_value="k"
        ), patch.object(
            u, "dsh_program", return_value="dsh"
        ), patch.object(
            u.subprocess, "Popen", side_effect=spawn
        ):
            outputs = self.work / "outputs"
            outputs.mkdir()
            completion = (
                self.h / "utility-reports" / "job" / "completion.json"
            )
            completion.parent.mkdir(parents=True)
            u.execute(job, self.work, self.inputs, outputs, completion)

        self.assertEqual(seen["audio"], audio)
        task = next(
            call.kwargs["input"]
            for call in proc.communicate.call_args_list
            if "input" in call.kwargs
        )
        self.assertIn("转写已由系统完成", task)
        self.assertNotIn("不要启动任何语音转写模型", task)


if __name__ == "__main__":
    unittest.main()
