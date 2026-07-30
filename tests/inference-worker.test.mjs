import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { InferenceWorker } from "../src/inference-worker.mjs";

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.pid = 4321;
    this.killed = false;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
  }

  kill(signal) {
    this.killed = true;
    this.signal = signal;
  }
}

test("starts the WebRTC worker with private configuration in its environment", () => {
  const child = new FakeChild();
  let spawned;
  const states = [];
  const publisher = {
    setWorkerState(state, detail) {
      states.push({ state, detail });
    },
    stop() {
      states.push({ state: "stopped" });
    },
  };
  const worker = new InferenceWorker({
    command: ".venv/bin/python",
    script: "/app/inference_stream.py",
    env: {
      ROBOFLOW_API_KEY: "test-key",
      ROBOFLOW_API_URL: "http://gpu-server.local:9001",
    },
    publisher,
    spawn(command, args, options) {
      spawned = { command, args, options };
      return child;
    },
    logger: { log() {}, error() {} },
  });

  worker.start();
  child.emit("spawn");

  assert.equal(spawned.command, ".venv/bin/python");
  assert.deepEqual(spawned.args, ["/app/inference_stream.py"]);
  assert.equal(spawned.options.env.ROBOFLOW_API_KEY, "test-key");
  assert.equal(states.at(-1).state, "running");
  assert.equal(states.at(-1).detail.pid, 4321);

  worker.stop();
  assert.equal(child.killed, true);
  assert.equal(child.signal, "SIGTERM");
});

test("does not spawn the worker without an API key", () => {
  let spawned = false;
  let latestState;
  const worker = new InferenceWorker({
    command: ".venv/bin/python",
    script: "/app/inference_stream.py",
    env: {},
    enabled: false,
    publisher: {
      setWorkerState(state, detail) {
        latestState = { state, detail };
      },
      stop() {},
    },
    spawn() {
      spawned = true;
    },
  });

  worker.start();

  assert.equal(spawned, false);
  assert.equal(latestState.state, "unconfigured");
  assert.match(latestState.detail.error, /ROBOFLOW_API_KEY/);
});

test("pauses inference without closing the annotated stream publisher", () => {
  const child = new FakeChild();
  const states = [];
  let publisherStopped = false;
  const worker = new InferenceWorker({
    command: ".venv/bin/python",
    script: "/app/inference_stream.py",
    env: {},
    publisher: {
      setWorkerState(state) {
        states.push(state);
      },
      stop() {
        publisherStopped = true;
      },
    },
    spawn() {
      return child;
    },
    logger: { log() {}, error() {} },
  });

  worker.start();
  child.emit("spawn");
  worker.pause();

  assert.equal(child.killed, true);
  assert.equal(child.signal, "SIGTERM");
  assert.equal(states.at(-1), "scheduled");
  assert.equal(publisherStopped, false);
});
