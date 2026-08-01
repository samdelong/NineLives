import assert from "node:assert/strict";
import test from "node:test";
import { InferenceStreamPublisher } from "../src/inference-publisher.mjs";

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

test("retains annotated WebRTC frames and data-channel results", () => {
  const publisher = new InferenceStreamPublisher({ targetFps: 8 });
  const observedFrames = [];
  const unsubscribe = publisher.subscribeToFrames((frame) => {
    observedFrames.push(frame);
  });

  publisher.setWorkerState("running", { pid: 1234 });
  publisher.publishFrame(JPEG, {
    contentType: "image/jpeg",
    frameId: "frame-41",
  });
  publisher.publishData(
    {
      identified_cats: 1,
      raw_cat_predictions: [{ class: "cat", confidence: 0.97 }],
    },
    { frameId: "frame-41" },
  );

  assert.deepEqual(publisher.latestFrame.buffer, JPEG);
  assert.equal(observedFrames.length, 1);
  assert.equal(observedFrames[0].frameId, "frame-41");
  assert.ok(observedFrames[0].capturedAt instanceof Date);
  assert.equal(publisher.latestResult.identified_cats, 1);
  assert.equal(publisher.inferenceCount, 1);
  assert.equal(publisher.getStatus().state, "live");
  assert.equal(publisher.getStatus().transport, "webrtc-video");
  assert.equal(publisher.getStatus().targetFps, 8);
  assert.equal(publisher.getStatus().latestFrameId, "frame-41");
  assert.equal(publisher.getStatus().latestDataFrameId, "frame-41");
  unsubscribe();
});

test("rejects non-image annotated frames", () => {
  const publisher = new InferenceStreamPublisher();

  assert.throws(
    () =>
      publisher.publishFrame(JPEG, {
        contentType: "application/octet-stream",
      }),
    /image content type/,
  );
});

test("clears a stale worker error when entering a healthy state", () => {
  const publisher = new InferenceStreamPublisher();

  publisher.setWorkerState("restarting", { error: "temporary failure" });
  publisher.setWorkerState("scheduled");

  assert.equal(publisher.getStatus().lastError, null);
  assert.equal(publisher.getStatus().state, "scheduled");
});
