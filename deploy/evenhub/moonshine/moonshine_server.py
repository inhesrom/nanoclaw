#!/usr/bin/env python3
"""Loopback-only Moonshine streaming service. Never logs audio or text."""

from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import logging
from pathlib import Path
import platform
import time
from typing import Any

from aiohttp import WSMsgType, web
import numpy as np
from moonshine_voice import ModelArch, Transcriber, TranscriptEventListener

AUDIO_TYPE = "audio/L16;rate=16000;channels=1"
MAX_AUDIO_BYTES = 960_000


class TranscriptState(TranscriptEventListener):
    def __init__(self) -> None:
        self._lines: dict[int, Any] = {}
        self.error: Exception | None = None

    def _update(self, event: Any) -> None:
        self._lines[event.line.line_id] = event.line

    def on_line_started(self, event: Any) -> None:
        self._update(event)

    def on_line_updated(self, event: Any) -> None:
        self._update(event)

    def on_line_text_changed(self, event: Any) -> None:
        self._update(event)

    def on_line_completed(self, event: Any) -> None:
        self._update(event)

    def on_error(self, event: Any) -> None:
        self.error = event.error

    def absorb(self, transcript: Any) -> None:
        for line in transcript.lines:
            self._lines[line.line_id] = line

    def snapshot(self) -> tuple[str, str]:
        completed: list[str] = []
        interim: list[str] = []
        for line in self._lines.values():
            text = " ".join((line.text or "").split())
            if not text:
                continue
            (completed if line.is_complete else interim).append(text)
        return " ".join(completed), " ".join(interim)

    def final_text(self) -> str:
        final_text, interim_text = self.snapshot()
        return " ".join(part for part in (final_text, interim_text) if part).strip()


class MoonshineService:
    def __init__(self, profile: dict[str, Any]) -> None:
        self.profile = profile
        self.transcriber = Transcriber(
            model_path=profile["modelPath"],
            model_arch=ModelArch(profile["modelArch"]),
            update_interval=profile["updateIntervalMs"] / 1000.0,
            options={"return_audio_data": "false", "log_output_text": "false"},
        )

    def new_stream(self) -> tuple[Any, TranscriptState]:
        stream = self.transcriber.create_stream(
            update_interval=self.profile["updateIntervalMs"] / 1000.0
        )
        state = TranscriptState()
        stream.add_listener(state)
        stream.start()
        return stream, state

    def transcribe(self, pcm: bytes) -> tuple[str, float]:
        stream, state = self.new_stream()
        processing_seconds = 0.0
        try:
            for offset in range(0, len(pcm), 3_200):
                started = time.perf_counter()
                stream.add_audio(pcm_float(pcm[offset : offset + 3_200]), 16_000)
                processing_seconds += time.perf_counter() - started
            started = time.perf_counter()
            transcript = stream.stop()
            processing_seconds += time.perf_counter() - started
            if transcript is not None:
                state.absorb(transcript)
            if state.error:
                raise state.error
            return state.final_text(), processing_seconds * 1000.0
        finally:
            stream.close()


def pcm_float(pcm: bytes) -> list[float]:
    if not pcm or len(pcm) % 2:
        raise ValueError("invalid PCM")
    return (np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0).tolist()


def load_profile(profile_path: Path) -> dict[str, Any]:
    profile = json.loads(profile_path.read_text(encoding="utf-8"))
    required = {
        "version": 1,
        "provider": "moonshine",
        "runtimeVersion": "0.0.69",
        "pythonVersion": "3.13",
        "modelArch": 4,
        "updateIntervalMs": 500,
    }
    for key, expected in required.items():
        if profile.get(key) != expected:
            raise ValueError(f"invalid selected profile field: {key}")
    if profile.get("selectionStatus") not in {"candidate", "selected"}:
        raise ValueError("profile is not a runnable candidate")
    model_path = Path(profile["modelPath"]).resolve(strict=True)
    if not model_path.is_dir():
        raise ValueError("modelPath must be a directory")
    components = profile.get("components")
    if not isinstance(components, list) or not components:
        raise ValueError("profile needs component hashes")
    for component in components:
        candidate = (model_path / component["path"]).resolve(strict=True)
        if model_path not in candidate.parents or not candidate.is_file():
            raise ValueError("invalid model component")
        if file_sha256(candidate) != component["sha256"]:
            raise ValueError("model component hash mismatch")
    runtime_path = Path(profile["runtimePath"]).resolve(strict=True)
    if not runtime_path.is_dir():
        raise ValueError("runtimePath must be a directory")
    runtime_components = profile.get("runtimeComponents")
    if not isinstance(runtime_components, list) or not runtime_components:
        raise ValueError("profile needs runtime component hashes")
    for component in runtime_components:
        candidate = (runtime_path / component["path"]).resolve(strict=True)
        if runtime_path not in candidate.parents or not candidate.is_file():
            raise ValueError("invalid runtime component")
        if file_sha256(candidate) != component["sha256"]:
            raise ValueError("runtime component hash mismatch")
    lock_path = Path(profile["runtimeLockPath"]).resolve(strict=True)
    server_path = Path(profile["serverPath"]).resolve(strict=True)
    if file_sha256(lock_path) != profile["runtimeLockSha256"]:
        raise ValueError("runtime lock hash mismatch")
    if server_path != Path(__file__).resolve() or file_sha256(server_path) != profile[
        "serverSha256"
    ]:
        raise ValueError("server hash mismatch")
    if importlib.metadata.version("moonshine-voice") != profile["runtimeVersion"]:
        raise ValueError("Moonshine runtime version mismatch")
    if platform.python_version_tuple()[:2] != tuple(profile["pythonVersion"].split(".")):
        raise ValueError("Python runtime version mismatch")
    profile["modelPath"] = str(model_path)
    return profile


def file_sha256(candidate: Path) -> str:
    digest = hashlib.sha256()
    with candidate.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def create_app(service: MoonshineService) -> web.Application:
    app = web.Application(client_max_size=MAX_AUDIO_BYTES)

    async def healthz(_request: web.Request) -> web.Response:
        return web.json_response(
            {
                "status": "ok",
                "provider": "moonshine",
                "model": service.profile["modelId"],
            }
        )

    async def transcribe(request: web.Request) -> web.Response:
        if request.headers.get("Content-Type", "").lower() != AUDIO_TYPE.lower():
            raise web.HTTPUnsupportedMediaType()
        pcm = await request.read()
        if len(pcm) > MAX_AUDIO_BYTES or len(pcm) % 2:
            raise web.HTTPUnprocessableEntity()
        started = time.perf_counter()
        text, processing_ms = service.transcribe(pcm)
        logging.info(
            "stt.request_completed audio_bytes=%d processing_ms=%.1f elapsed_ms=%.1f",
            len(pcm),
            processing_ms,
            (time.perf_counter() - started) * 1000.0,
        )
        return web.json_response({"text": text, "processingMs": processing_ms})

    async def stream(request: web.Request) -> web.WebSocketResponse:
        websocket = web.WebSocketResponse(
            autoping=True, heartbeat=15, max_msg_size=MAX_AUDIO_BYTES
        )
        await websocket.prepare(request)
        moonshine_stream = None
        state = None
        audio_bytes = 0
        processing_seconds = 0.0
        last_snapshot: tuple[str, str] | None = None
        try:
            first = await websocket.receive(timeout=5)
            if first.type != WSMsgType.TEXT:
                raise ValueError("start required")
            control = json.loads(first.data)
            if control != {
                "type": "start",
                "version": 1,
                "format": {
                    "encoding": "s16le",
                    "sampleRate": 16000,
                    "channels": 1,
                },
            }:
                raise ValueError("invalid start")
            moonshine_stream, state = service.new_stream()
            await websocket.send_json({"type": "ready", "version": 1})
            async for message in websocket:
                if message.type == WSMsgType.BINARY:
                    pcm = bytes(message.data)
                    audio_bytes += len(pcm)
                    if audio_bytes > MAX_AUDIO_BYTES:
                        raise ValueError("audio too large")
                    started = time.perf_counter()
                    moonshine_stream.add_audio(pcm_float(pcm), 16_000)
                    processing_seconds += time.perf_counter() - started
                    if state.error:
                        raise state.error
                    snapshot = state.snapshot()
                    if snapshot != last_snapshot:
                        last_snapshot = snapshot
                        await websocket.send_json(
                            {
                                "type": "snapshot",
                                "finalText": snapshot[0],
                                "interimText": snapshot[1],
                            }
                        )
                    continue
                if message.type == WSMsgType.TEXT:
                    finish = json.loads(message.data)
                    if finish != {"type": "finish"}:
                        raise ValueError("invalid finish")
                    started = time.perf_counter()
                    transcript = moonshine_stream.stop()
                    processing_seconds += time.perf_counter() - started
                    if transcript is not None:
                        state.absorb(transcript)
                    if state.error:
                        raise state.error
                    processing_ms = processing_seconds * 1000.0
                    logging.info(
                        "stt.stream_completed audio_bytes=%d processing_ms=%.1f",
                        audio_bytes,
                        processing_ms,
                    )
                    await websocket.send_json(
                        {
                            "type": "final",
                            "text": state.final_text(),
                            "processingMs": processing_ms,
                        }
                    )
                    await websocket.close()
                    break
                if message.type in {WSMsgType.ERROR, WSMsgType.CLOSE}:
                    break
        except Exception as error:
            logging.warning("stt.stream_failed error_type=%s", type(error).__name__)
            if not websocket.closed:
                await websocket.send_json(
                    {
                        "type": "error",
                        "code": "stt_unavailable",
                        "retryable": True,
                        "message": "Streaming session rejected",
                    }
                )
                await websocket.close()
        finally:
            if moonshine_stream is not None:
                moonshine_stream.close()
        return websocket

    app.router.add_get("/healthz", healthz)
    app.router.add_post("/v1/transcribe", transcribe)
    app.router.add_get("/v1/stream", stream)
    return app


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--profile", type=Path, required=True)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8178)
    args = parser.parse_args()
    if args.host != "127.0.0.1" or args.port != 8178:
        raise ValueError("Moonshine service must use 127.0.0.1:8178")
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    profile = load_profile(args.profile)
    service = MoonshineService(profile)
    logging.info("stt.service_ready provider=moonshine")
    web.run_app(create_app(service), host=args.host, port=args.port, access_log=None)


if __name__ == "__main__":
    main()
