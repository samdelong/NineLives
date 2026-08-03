import { spawn as spawnChild } from "node:child_process";
import { link, mkdir, readdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";

const CLIP_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isValidClipId(value) {
  return typeof value === "string" && CLIP_ID_PATTERN.test(value);
}

export class EventClipRecorder {
  constructor({
    publisher,
    directory,
    durationMs = 30_000,
    fps = 24,
    ffmpegCommand = "ffmpeg",
    spawn = spawnChild,
    logger = console,
    onStatus = () => undefined,
  }) {
    this.publisher = publisher;
    this.directory = directory;
    this.durationMs = Math.max(10, durationMs);
    this.fps = Math.max(1, fps);
    this.ffmpegCommand = ffmpegCommand;
    this.spawn = spawn;
    this.logger = logger;
    this.onStatus = onStatus;

    this.active = new Map();
    this.aliases = new Map();
    this.currentRecording = null;
    this.ready = new Set();
    this.errors = new Map();
    this.starting = null;
    this.unsubscribe = null;
  }

  async start() {
    if (this.unsubscribe) return;
    await mkdir(this.directory, { recursive: true });

    const files = await readdir(this.directory).catch(() => []);
    for (const filename of files) {
      if (!filename.endsWith(".mp4")) continue;
      const clipId = filename.slice(0, -4);
      if (isValidClipId(clipId) && !filename.endsWith(".part.mp4")) {
        this.ready.add(clipId);
      }
    }

    this.unsubscribe = this.publisher.subscribeToFrames((frame) => {
      this.handleFrame(frame);
    });
  }

  handleFrame(frame) {
    if (frame.contentType !== "image/jpeg") return;

    for (const recording of this.active.values()) {
      this.writeFrame(recording, frame.buffer);
    }
  }

  writeFrame(recording, buffer) {
    if (!recording.accepting || recording.blocked) return;
    if (recording.child.stdin.destroyed) return;

    recording.blocked = !recording.child.stdin.write(buffer);
    if (recording.blocked) {
      recording.child.stdin.once("drain", () => {
        recording.blocked = false;
      });
    }
  }

  clipPath(clipId) {
    if (!isValidClipId(clipId)) return null;
    return join(this.directory, `${clipId}.mp4`);
  }

  getClipStatus(clipId) {
    if (!isValidClipId(clipId)) return "missing";
    if (this.errors.has(clipId)) return "error";
    const primaryClipId = this.aliases.get(clipId) ?? clipId;
    if (this.active.has(primaryClipId)) return "recording";
    if (this.ready.has(clipId)) return "ready";
    return "missing";
  }

  withClipStatus(entry) {
    if (!entry.clipId) return entry;
    const clipStatus = this.getClipStatus(entry.clipId);
    return {
      ...entry,
      clipReady: clipStatus === "ready",
      clipStatus,
    };
  }

  coverWithCurrentRecording(recording, entry) {
    const clipId = entry.clipId;
    if (!recording.entries.has(clipId)) {
      recording.entries.set(clipId, entry);
      this.aliases.set(clipId, recording.entry.clipId);
      this.errors.delete(clipId);
      this.onStatus(this.withClipStatus(entry));
    }
    return recording.completion;
  }

  async record(entry) {
    const clipId = entry.clipId;
    if (!isValidClipId(clipId)) return { status: "missing" };
    if (this.ready.has(clipId)) return { status: "ready" };
    if (this.active.has(clipId)) return this.active.get(clipId).completion;

    if (this.currentRecording && !this.currentRecording.settled) {
      return this.coverWithCurrentRecording(this.currentRecording, entry);
    }

    if (this.starting) {
      await this.starting;
      return this.record(entry);
    }

    let releaseStarting;
    this.starting = new Promise((resolve) => {
      releaseStarting = resolve;
    });

    if (!this.unsubscribe) {
      try {
        await this.start();
      } catch (error) {
        this.starting = null;
        releaseStarting();
        this.recordError(entry, error);
        return { status: "error", error };
      }
    }

    const temporaryPath = join(this.directory, `${clipId}.part.mp4`);
    await unlink(temporaryPath).catch(() => undefined);

    let child;
    try {
      child = this.spawn(
        this.ffmpegCommand,
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-f",
          "image2pipe",
          "-framerate",
          String(this.fps),
          "-vcodec",
          "mjpeg",
          "-i",
          "pipe:0",
          "-an",
          "-c:v",
          "libx264",
          "-preset",
          "veryfast",
          "-pix_fmt",
          "yuv420p",
          "-movflags",
          "+faststart",
          "-y",
          temporaryPath,
        ],
        { stdio: ["pipe", "ignore", "pipe"] },
      );
    } catch (error) {
      this.starting = null;
      releaseStarting();
      this.recordError(entry, error);
      return { status: "error", error };
    }

    let resolveCompletion;
    const completion = new Promise((resolve) => {
      resolveCompletion = resolve;
    });
    const recording = {
      accepting: true,
      blocked: false,
      child,
      completion,
      entry,
      entries: new Map([[clipId, entry]]),
      resolveCompletion,
      settled: false,
      stderr: "",
      temporaryPath,
      timer: null,
    };
    this.active.set(clipId, recording);
    this.currentRecording = recording;
    this.errors.delete(clipId);
    this.starting = null;
    releaseStarting();
    this.onStatus(this.withClipStatus(entry));

    child.stderr?.setEncoding?.("utf8");
    child.stderr?.on?.("data", (chunk) => {
      recording.stderr = `${recording.stderr}${chunk}`.slice(-2_000);
    });
    child.stdin.on("error", (error) => {
      if (error?.code !== "EPIPE") {
        void this.finishRecording(recording, null, error);
      }
    });
    child.once("error", (error) => {
      void this.finishRecording(recording, null, error);
    });
    child.once("close", (code) => {
      void this.finishRecording(recording, code);
    });

    recording.timer = setTimeout(() => {
      recording.accepting = false;
      if (!recording.child.stdin.destroyed) recording.child.stdin.end();
    }, this.durationMs);

    return completion;
  }

  recordError(entry, error) {
    const message = error instanceof Error ? error.message : String(error);
    this.errors.set(entry.clipId, message);
    this.logger.error(`Event clip ${entry.clipId} failed: ${message}`);
    this.onStatus(this.withClipStatus(entry));
  }

  async finishRecording(recording, code, error = null) {
    if (recording.settled) return;
    recording.settled = true;
    clearTimeout(recording.timer);
    recording.accepting = false;
    this.active.delete(recording.entry.clipId);
    if (this.currentRecording === recording) this.currentRecording = null;

    if (!error && code === 0) {
      try {
        const primaryClipId = recording.entry.clipId;
        const primaryPath = this.clipPath(primaryClipId);
        await rename(recording.temporaryPath, primaryPath);
        this.ready.add(primaryClipId);
        this.errors.delete(primaryClipId);
        this.onStatus(this.withClipStatus(recording.entry));

        for (const [coveredClipId, coveredEntry] of recording.entries) {
          if (coveredClipId === primaryClipId) continue;
          try {
            const coveredPath = this.clipPath(coveredClipId);
            await unlink(coveredPath).catch(() => undefined);
            await link(primaryPath, coveredPath);
            this.ready.add(coveredClipId);
            this.errors.delete(coveredClipId);
            this.onStatus(this.withClipStatus(coveredEntry));
          } catch (linkError) {
            this.recordError(coveredEntry, linkError);
          }
        }

        const result = { status: "ready" };
        recording.resolveCompletion(result);
        return;
      } catch (renameError) {
        error = renameError;
      }
    }

    const detail =
      error ||
      new Error(
        recording.stderr.trim() || `ffmpeg exited with code ${code ?? "unknown"}`,
      );
    await unlink(recording.temporaryPath).catch(() => undefined);
    for (const coveredEntry of recording.entries.values()) {
      this.recordError(coveredEntry, detail);
    }
    recording.resolveCompletion({ status: "error", error: detail });
  }

  stop() {
    this.unsubscribe?.();
    this.unsubscribe = null;

    for (const recording of this.active.values()) {
      clearTimeout(recording.timer);
      recording.accepting = false;
      if (!recording.child.stdin.destroyed) recording.child.stdin.end();
    }
  }
}
