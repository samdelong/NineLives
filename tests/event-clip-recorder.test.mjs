import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  EventClipRecorder,
  isValidClipId,
} from "../src/event-clip-recorder.mjs";
import { InferenceStreamPublisher } from "../src/inference-publisher.mjs";

const CLIP_ID = "11111111-1111-4111-8111-111111111111";
const COVERED_CLIP_ID = "22222222-2222-4222-8222-222222222222";

function fakeFfmpegSpawner(calls) {
  return (command, args) => {
    const child = new EventEmitter();
    const stdin = new EventEmitter();
    const stderr = new EventEmitter();
    const chunks = [];
    const outputPath = args.at(-1);

    stdin.destroyed = false;
    stdin.write = (chunk) => {
      chunks.push(Buffer.from(chunk));
      return true;
    };
    stdin.end = () => {
      stdin.destroyed = true;
      void writeFile(outputPath, Buffer.concat(chunks)).then(() => {
        child.emit("close", 0);
      });
    };
    stderr.setEncoding = () => undefined;
    child.stdin = stdin;
    child.stderr = stderr;
    calls.push({ args, command, chunks });
    return child;
  };
}

test("validates clip IDs used in public paths", () => {
  assert.equal(isValidClipId(CLIP_ID), true);
  assert.equal(isValidClipId("../../etc/passwd"), false);
  assert.equal(isValidClipId("not-a-uuid"), false);
});

test("records annotated frames for the full post-trigger window", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nine-lives-clips-"));
  const publisher = new InferenceStreamPublisher({ targetFps: 24 });
  const spawnCalls = [];
  const statuses = [];
  let resolveStarted;
  const started = new Promise((resolve) => {
    resolveStarted = resolve;
  });

  try {
    const recorder = new EventClipRecorder({
      publisher,
      directory,
      durationMs: 40,
      fps: 24,
      spawn: fakeFfmpegSpawner(spawnCalls),
      onStatus: (entry) => {
        statuses.push(entry.clipStatus);
        if (entry.clipStatus === "recording") resolveStarted();
      },
    });
    await recorder.start();

    publisher.publishFrame(Buffer.from("before"), {
      contentType: "image/jpeg",
      frameId: "before",
    });
    const recording = recorder.record({
      id: CLIP_ID,
      clipId: CLIP_ID,
      message: "Bobby entered.",
    });
    await started;
    publisher.publishFrame(Buffer.from("after"), {
      contentType: "image/jpeg",
      frameId: "after",
    });

    assert.deepEqual(await recording, { status: "ready" });
    assert.equal(spawnCalls.length, 1);
    assert.equal(spawnCalls[0].command, "ffmpeg");
    assert.ok(spawnCalls[0].args.includes("libx264"));
    assert.equal(
      (await readFile(recorder.clipPath(CLIP_ID))).toString(),
      "after",
    );
    assert.equal(recorder.getClipStatus(CLIP_ID), "ready");
    assert.deepEqual(statuses, ["recording", "ready"]);
    recorder.stop();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("covers overlapping events with one recording process", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nine-lives-covered-clips-"));
  const publisher = new InferenceStreamPublisher({ targetFps: 24 });
  const spawnCalls = [];
  const statuses = [];
  let resolveStarted;
  const started = new Promise((resolve) => {
    resolveStarted = resolve;
  });

  try {
    const recorder = new EventClipRecorder({
      publisher,
      directory,
      durationMs: 40,
      fps: 24,
      spawn: fakeFfmpegSpawner(spawnCalls),
      onStatus: (entry) => {
        statuses.push([entry.clipId, entry.clipStatus]);
        if (
          entry.clipId === CLIP_ID &&
          entry.clipStatus === "recording"
        ) {
          resolveStarted();
        }
      },
    });
    await recorder.start();

    const first = recorder.record({
      id: CLIP_ID,
      clipId: CLIP_ID,
      message: "Bobby entered.",
    });
    const covered = recorder.record({
      id: COVERED_CLIP_ID,
      clipId: COVERED_CLIP_ID,
      message: "Bobby left.",
    });
    await started;
    publisher.publishFrame(Buffer.from("shared"), {
      contentType: "image/jpeg",
      frameId: "shared",
    });

    assert.deepEqual(await Promise.all([first, covered]), [
      { status: "ready" },
      { status: "ready" },
    ]);
    assert.equal(spawnCalls.length, 1);
    assert.equal(
      (await readFile(recorder.clipPath(CLIP_ID))).toString(),
      "shared",
    );
    assert.equal(
      (await readFile(recorder.clipPath(COVERED_CLIP_ID))).toString(),
      "shared",
    );
    assert.equal(recorder.getClipStatus(CLIP_ID), "ready");
    assert.equal(recorder.getClipStatus(COVERED_CLIP_ID), "ready");
    assert.deepEqual(statuses, [
      [CLIP_ID, "recording"],
      [COVERED_CLIP_ID, "recording"],
      [CLIP_ID, "ready"],
      [COVERED_CLIP_ID, "ready"],
    ]);
    recorder.stop();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
