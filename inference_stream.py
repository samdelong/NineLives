"""Bridge the Pi's MJPEG stream through a Roboflow WebRTC Workflow session."""

from __future__ import annotations

import json
import os
import queue
import signal
import sys
import threading
import time
import urllib.error
import urllib.request
from typing import Any

import cv2
import numpy as np

from inference_sdk import InferenceHTTPClient
from inference_sdk.webrtc import ManualSource, StreamConfig, VideoMetadata


def required_environment(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"{name} is required")
    return value


def csv_environment(name: str) -> list[str]:
    return [
        value.strip()
        for value in os.environ.get(name, "").split(",")
        if value.strip()
    ]


class NodeSink:
    """Send annotated frames and data-channel messages to Node over loopback."""

    def __init__(self, base_url: str, token: str, jpeg_quality: int) -> None:
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.jpeg_quality = jpeg_quality
        self.frame_queue: queue.Queue[tuple[bytes, str] | None] = queue.Queue(
            maxsize=1
        )
        self.data_queue: queue.Queue[tuple[bytes, str] | None] = queue.Queue(
            maxsize=8
        )
        self.closed = False
        self.last_error_at = 0.0
        self.frame_thread = threading.Thread(
            target=self._frame_loop,
            name="node-frame-sink",
            daemon=True,
        )
        self.data_thread = threading.Thread(
            target=self._data_loop,
            name="node-data-sink",
            daemon=True,
        )
        self.frame_thread.start()
        self.data_thread.start()

    def _post(
        self,
        path: str,
        body: bytes,
        content_type: str,
        frame_id: str,
    ) -> None:
        request = urllib.request.Request(
            f"{self.base_url}{path}",
            data=body,
            method="POST",
            headers={
                "Content-Type": content_type,
                "Content-Length": str(len(body)),
                "X-Inference-Token": self.token,
                "X-Frame-Id": frame_id,
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=5) as response:
                response.read()
        except (urllib.error.URLError, TimeoutError) as error:
            now = time.monotonic()
            if now - self.last_error_at >= 5:
                print(f"Node sink unavailable: {error}", file=sys.stderr)
                self.last_error_at = now

    @staticmethod
    def _offer_latest(
        destination: queue.Queue[tuple[bytes, str] | None],
        item: tuple[bytes, str],
    ) -> None:
        try:
            destination.put_nowait(item)
        except queue.Full:
            try:
                destination.get_nowait()
            except queue.Empty:
                pass
            destination.put_nowait(item)

    def submit_frame(self, frame: Any, frame_id: str) -> None:
        encoded, jpeg = cv2.imencode(
            ".jpg",
            frame,
            [cv2.IMWRITE_JPEG_QUALITY, self.jpeg_quality],
        )
        if not encoded:
            return
        self._offer_latest(self.frame_queue, (jpeg.tobytes(), frame_id))

    def submit_data(self, data: dict[str, Any], frame_id: str) -> None:
        body = json.dumps(
            {"data": data, "frame_id": frame_id},
            default=str,
            separators=(",", ":"),
        ).encode("utf-8")
        self._offer_latest(self.data_queue, (body, frame_id))

    def _frame_loop(self) -> None:
        while True:
            item = self.frame_queue.get()
            if item is None:
                return
            body, frame_id = item
            self._post(
                "/api/inference/frame",
                body,
                "image/jpeg",
                frame_id,
            )

    def _data_loop(self) -> None:
        while True:
            item = self.data_queue.get()
            if item is None:
                return
            body, frame_id = item
            self._post(
                "/api/inference/data",
                body,
                "application/json",
                frame_id,
            )

    def close(self) -> None:
        if self.closed:
            return
        self.closed = True
        for destination in (self.frame_queue, self.data_queue):
            try:
                destination.put_nowait(None)
            except queue.Full:
                try:
                    destination.get_nowait()
                except queue.Empty:
                    pass
                destination.put_nowait(None)


class LocalMJPEGFeeder:
    """Read the Node camera stream locally and send frames over WebRTC."""

    def __init__(
        self,
        camera_url: str,
        source: ManualSource,
        declared_fps: int,
        stop_event: threading.Event,
    ) -> None:
        self.camera_url = camera_url
        self.source = source
        self.frame_interval = 1 / declared_fps
        self.stop_event = stop_event

    def run(self) -> None:
        while not self.stop_event.is_set():
            request = urllib.request.Request(
                self.camera_url,
                headers={"Accept": "multipart/x-mixed-replace"},
            )
            try:
                response = urllib.request.urlopen(request, timeout=10)
            except (urllib.error.URLError, TimeoutError, OSError) as error:
                print(
                    f"Waiting for local camera stream: {error}",
                    file=sys.stderr,
                    flush=True,
                )
                self.stop_event.wait(1)
                continue

            with response:
                print(
                    f"Local camera stream connected: {self.camera_url}",
                    flush=True,
                )
                last_sent_at = 0.0

                while not self.stop_event.is_set():
                    try:
                        frame = self._read_frame(response)
                    except (TimeoutError, OSError, ValueError) as error:
                        print(
                            f"Local camera stream interrupted: {error}",
                            file=sys.stderr,
                            flush=True,
                        )
                        break

                    if frame is None:
                        print(
                            "Local camera stream disconnected; reconnecting.",
                            file=sys.stderr,
                            flush=True,
                        )
                        break

                    delay = self.frame_interval - (
                        time.monotonic() - last_sent_at
                    )
                    if delay > 0 and self.stop_event.wait(delay):
                        break

                    try:
                        self.source.send(frame)
                    except RuntimeError:
                        # The WebRTC session is still negotiating.
                        continue
                    last_sent_at = time.monotonic()

            self.stop_event.wait(1)

    @staticmethod
    def _read_frame(response: Any) -> Any | None:
        while True:
            line = response.readline()
            if not line:
                return None
            if line.startswith(b"--"):
                break

        content_length = None
        while True:
            line = response.readline()
            if not line:
                return None
            if line in (b"\r\n", b"\n"):
                break
            name, separator, value = line.partition(b":")
            if separator and name.strip().lower() == b"content-length":
                content_length = int(value.strip())

        if content_length is None:
            raise ValueError("camera stream frame has no Content-Length")

        payload = response.read(content_length)
        if len(payload) != content_length:
            return None

        encoded = np.frombuffer(payload, dtype=np.uint8)
        frame = cv2.imdecode(encoded, cv2.IMREAD_COLOR)
        if frame is None:
            raise ValueError("camera stream returned an invalid image")
        return frame


def main() -> None:
    api_key = required_environment("ROBOFLOW_API_KEY")
    api_url = required_environment("ROBOFLOW_API_URL")
    workspace = required_environment("ROBOFLOW_WORKSPACE")
    workflow = required_environment("ROBOFLOW_WORKFLOW")
    camera_url = required_environment("CAMERA_MJPEG_URL")
    sink_url = required_environment("INFERENCE_SINK_URL")
    sink_token = required_environment("INFERENCE_SINK_TOKEN")

    image_input = os.environ.get("ROBOFLOW_IMAGE_INPUT", "image")
    stream_output = os.environ.get("ROBOFLOW_STREAM_OUTPUT", "output_image")
    data_outputs = csv_environment("ROBOFLOW_DATA_OUTPUTS")
    declared_fps = int(os.environ.get("INFERENCE_DECLARED_FPS", "24"))
    processing_timeout = int(
        os.environ.get("INFERENCE_PROCESSING_TIMEOUT", "3600")
    )
    jpeg_quality = int(os.environ.get("INFERENCE_JPEG_QUALITY", "85"))

    sink = NodeSink(sink_url, sink_token, jpeg_quality)
    client = InferenceHTTPClient.init(api_url=api_url, api_key=api_key)
    source = ManualSource()
    config = StreamConfig(
        stream_output=[stream_output],
        data_output=data_outputs,
        processing_timeout=processing_timeout,
        realtime_processing=True,
        declared_fps=declared_fps,
    )
    session = client.webrtc.stream(
        source=source,
        workflow=workflow,
        workspace=workspace,
        image_input=image_input,
        config=config,
    )

    @session.on_frame
    def on_frame(frame: Any, metadata: VideoMetadata) -> None:
        sink.submit_frame(frame, str(metadata.frame_id))

    @session.on_data()
    def on_data(data: dict[str, Any], metadata: VideoMetadata) -> None:
        sink.submit_data(data, str(metadata.frame_id))

    stop_event = threading.Event()
    session_errors: queue.Queue[Exception] = queue.Queue(maxsize=1)

    def shutdown(_signal: int, _frame: Any) -> None:
        stop_event.set()
        session.close()

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)

    print(
        f"WebRTC video session starting: {camera_url} -> {api_url}",
        flush=True,
    )

    def run_session() -> None:
        try:
            session.run()
        except Exception as error:
            session_errors.put_nowait(error)
        finally:
            stop_event.set()

    session_thread = threading.Thread(
        target=run_session,
        name="roboflow-webrtc-session",
        daemon=True,
    )
    feeder = LocalMJPEGFeeder(
        camera_url=camera_url,
        source=source,
        declared_fps=declared_fps,
        stop_event=stop_event,
    )

    try:
        session_thread.start()
        feeder.run()
    finally:
        stop_event.set()
        session.close()
        session_thread.join(timeout=5)
        sink.close()
        print("WebRTC video session ended", flush=True)

    if not session_errors.empty():
        raise session_errors.get_nowait()


if __name__ == "__main__":
    main()
