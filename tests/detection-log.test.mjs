import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DetectionLog,
  extractCatDetection,
} from "../src/detection-log.mjs";

class FakeEventStreamResponse extends EventEmitter {
  constructor() {
    super();
    this.destroyed = false;
    this.writableEnded = false;
    this.output = "";
  }

  writeHead(status, headers) {
    this.status = status;
    this.headers = headers;
  }

  write(chunk) {
    this.output += chunk;
  }

  end() {
    this.writableEnded = true;
  }
}

test("extracts cat count and workflow event metadata", () => {
  assert.deepEqual(
    extractCatDetection({
      outputs: {
        identified_cats: 2,
        vision_events_event_id: ["event-42"],
        vision_events_message: "Cats arrived for dinner.",
      },
    }),
    {
      catCount: 2,
      detected: true,
      workflowEventId: "event-42",
      message: "Cats arrived for dinner.",
    },
  );
});

test("falls back to raw prediction labels", () => {
  const detection = extractCatDetection({
    raw_cat_predictions: [
      { class: "cat", confidence: 0.97 },
      { class: "bowl", confidence: 0.88 },
    ],
  });

  assert.equal(detection.detected, true);
  assert.equal(detection.catCount, 1);
});

test("persists entries and deduplicates workflow event IDs across restarts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nine-lives-detections-"));
  const filePath = join(directory, "detections.jsonl");
  let now = new Date("2026-07-30T12:00:00.000Z");

  try {
    const log = new DetectionLog({ filePath, now: () => now });
    await log.load();

    const first = await log.recordFromInference(
      {
        identified_cats: 1,
        vision_events_event_id: "event-one",
      },
      { frameId: "10" },
    );
    const duplicate = await log.recordFromInference({
      identified_cats: 1,
      vision_events_event_id: "event-one",
    });

    assert.equal(first.catCount, 1);
    assert.equal(first.frameId, "10");
    assert.equal(duplicate, null);
    assert.equal(log.getStatus().total, 1);

    const reloaded = new DetectionLog({ filePath, now: () => now });
    await reloaded.load();
    assert.equal(reloaded.getStatus().total, 1);
    assert.equal(
      await reloaded.recordFromInference({
        identified_cats: 1,
        vision_events_event_id: "event-one",
      }),
      null,
    );

    now = new Date("2026-07-31T08:15:00.000Z");
    await reloaded.recordFromInference({
      identified_cats: 2,
      vision_events_event_id: "event-two",
    });
    assert.equal(reloaded.getEntries().length, 2);
    assert.equal(reloaded.getEntries()[0].workflowEventId, "event-two");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("deduplicates continuous detections without event IDs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nine-lives-fallback-"));
  const filePath = join(directory, "detections.jsonl");
  let now = new Date("2026-07-30T12:00:00.000Z");

  try {
    const log = new DetectionLog({
      filePath,
      now: () => now,
      dedupeWindowMs: 5 * 60 * 1_000,
    });

    assert.ok(await log.recordFromInference({ identified_cats: 1 }));
    now = new Date("2026-07-30T12:01:00.000Z");
    assert.equal(
      await log.recordFromInference({ identified_cats: 1 }),
      null,
    );

    await log.recordFromInference({ identified_cats: 0 });
    now = new Date("2026-07-30T12:02:00.000Z");
    assert.ok(await log.recordFromInference({ identified_cats: 1 }));

    now = new Date("2026-07-30T12:08:00.000Z");
    assert.ok(await log.recordFromInference({ identified_cats: 1 }));
    assert.equal(log.getStatus().total, 3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("streams new persisted detections to live clients", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nine-lives-stream-"));
  const filePath = join(directory, "detections.jsonl");
  const response = new FakeEventStreamResponse();

  try {
    const log = new DetectionLog({ filePath });
    log.openStream(response);
    await log.recordFromInference({
      identified_cats: 1,
      vision_events_event_id: "live-event",
    });

    assert.equal(response.status, 200);
    assert.equal(response.headers["Content-Type"], "text/event-stream; charset=utf-8");
    assert.match(response.output, /event: detection/);
    assert.match(response.output, /"workflowEventId":"live-event"/);

    response.emit("close");
    log.stop();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
