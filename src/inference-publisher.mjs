function writeStreamFrame(response, frame) {
  response.write(
    `--frame\r\nContent-Type: ${frame.contentType}\r\nContent-Length: ${frame.buffer.length}\r\n\r\n`,
  );
  response.write(frame.buffer);
  response.write("\r\n");
}

export class InferenceStreamPublisher {
  constructor({ targetFps = 24 } = {}) {
    this.targetFps = targetFps;
    this.clients = new Set();
    this.frameListeners = new Set();
    this.state = "stopped";
    this.workerPid = null;
    this.lastError = null;
    this.latestFrame = null;
    this.latestFrameAt = null;
    this.latestFrameId = null;
    this.latestResult = null;
    this.latestDataAt = null;
    this.latestDataFrameId = null;
    this.inferenceCount = 0;
  }

  setWorkerState(state, { pid = null, error = null } = {}) {
    this.state = state;
    this.workerPid = pid;
    this.lastError = error;
  }

  publishFrame(
    buffer,
    { contentType = "image/jpeg", frameId = null } = {},
  ) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
      throw new TypeError("An annotated image buffer is required.");
    }
    if (!contentType.startsWith("image/")) {
      throw new TypeError("The annotated frame must use an image content type.");
    }

    const frame = {
      buffer: Buffer.from(buffer),
      contentType,
      frameId,
      capturedAt: new Date(),
    };
    this.latestFrame = frame;
    this.latestFrameAt = frame.capturedAt;
    this.latestFrameId = frameId;
    this.inferenceCount += 1;
    this.state = "live";
    this.lastError = null;

    for (const response of this.clients) {
      if (response.destroyed || response.writableEnded) {
        this.clients.delete(response);
        continue;
      }
      if (
        response.writableNeedDrain ||
        response.writableLength > frame.buffer.length * 2
      ) {
        continue;
      }
      writeStreamFrame(response, frame);
    }

    for (const listener of this.frameListeners) {
      try {
        listener(frame);
      } catch {
        // A recorder or observer must not interrupt the live stream.
      }
    }
  }

  publishData(result, { frameId = null } = {}) {
    this.latestResult = result;
    this.latestDataAt = new Date();
    this.latestDataFrameId = frameId;
  }

  openStream(response) {
    response.writeHead(200, {
      "Content-Type": "multipart/x-mixed-replace; boundary=frame",
      "Cache-Control": "no-store, no-cache, must-revalidate, private",
      Connection: "keep-alive",
      Pragma: "no-cache",
      "X-Content-Type-Options": "nosniff",
    });

    this.clients.add(response);
    response.on("close", () => this.clients.delete(response));

    if (this.latestFrame) {
      writeStreamFrame(response, this.latestFrame);
    }
  }

  subscribeToFrames(listener) {
    if (typeof listener !== "function") {
      throw new TypeError("A frame listener function is required.");
    }
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }

  getStatus() {
    return {
      state: this.state,
      inFlight: this.state === "running" || this.state === "starting",
      hasFrame: Boolean(this.latestFrame),
      frameAgeMs: this.latestFrameAt
        ? Date.now() - this.latestFrameAt.getTime()
        : null,
      inferenceCount: this.inferenceCount,
      latestInferenceAt: this.latestFrameAt?.toISOString() ?? null,
      latestCapturedAt: this.latestFrameAt?.toISOString() ?? null,
      latestDataAt: this.latestDataAt?.toISOString() ?? null,
      latestFrameId: this.latestFrameId,
      latestDataFrameId: this.latestDataFrameId,
      lastError: this.lastError,
      targetFps: this.targetFps,
      transport: "webrtc-video",
      workerPid: this.workerPid,
    };
  }

  stop() {
    this.state = "stopped";
    this.workerPid = null;
    for (const response of this.clients) {
      response.end();
    }
    this.clients.clear();
    this.frameListeners.clear();
  }
}
