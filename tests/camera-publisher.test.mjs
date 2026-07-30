import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCameraArgs,
  CameraPublisher,
  MjpegFrameDecoder,
} from "../src/camera-publisher.mjs";

function jpeg(payload) {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    Buffer.from(payload),
    Buffer.from([0xff, 0xd9]),
  ]);
}

test("decodes complete JPEG frames across arbitrary chunks", () => {
  const frames = [];
  const first = jpeg("first");
  const second = jpeg("second");
  const decoder = new MjpegFrameDecoder((frame) => frames.push(frame));
  const stream = Buffer.concat([
    Buffer.from("noise"),
    first,
    second,
    Buffer.from([0xff]),
  ]);

  decoder.push(stream.subarray(0, 8));
  decoder.push(stream.subarray(8, 15));
  decoder.push(stream.subarray(15));

  assert.deepEqual(frames, [first, second]);
});

test("builds an indefinite MJPEG stdout command", () => {
  const args = buildCameraArgs({
    width: 1280,
    height: 720,
    framerate: 8,
    quality: 80,
    extraArgs: ["--rotation", "180"],
  });

  assert.deepEqual(args.slice(0, 6), [
    "--timeout",
    "0",
    "--nopreview",
    "--codec",
    "mjpeg",
    "--quality",
  ]);
  assert.ok(args.includes("--flush"));
  assert.deepEqual(args.slice(-4), ["--output", "-", "--rotation", "180"]);
});

test("mock publisher retains the latest frame without a camera process", () => {
  const frame = jpeg("mock");
  const publisher = new CameraPublisher({
    args: [],
    mockFrame: frame,
    mockFps: 1,
  });

  publisher.start();

  assert.deepEqual(publisher.latestFrame, frame);
  assert.equal(publisher.getStatus().state, "live");
  assert.equal(publisher.getStatus().command, "mock-image");

  publisher.stop();
});
