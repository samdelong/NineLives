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

test("extracts identified cat names and workflow event metadata", () => {
  assert.deepEqual(
    extractCatDetection({
      outputs: {
        identified_cats: [
          { name: "bobby", confidence: 0.98 },
          { cat_name: "LUNA", confidence: 0.96 },
        ],
        vision_events_event_id: ["event-42"],
        vision_events_message: "Bobby detected.",
      },
    }),
    {
      catCount: 2,
      catNames: ["Bobby", "Luna"],
      detected: true,
      workflowEventId: "event-42",
      message: "Bobby detected.",
    },
  );
});

test("extracts cat names from strings and boolean maps", () => {
  const encoded = extractCatDetection({
    identified_cats: '["bobby", "Millie"]',
  });
  assert.deepEqual(encoded.catNames, ["Bobby", "Millie"]);
  assert.equal(encoded.catCount, 2);

  const mapped = extractCatDetection({
    identified_cats: { bobby: true, luna: false },
  });
  assert.deepEqual(mapped.catNames, ["Bobby"]);
  assert.equal(mapped.catCount, 1);
});

test("treats unknown-cat labels as unnamed positive detections", () => {
  for (const label of [
    "unknown cat",
    "Unknown_Cat",
    "unidentified cat",
    "unrecognized-cat",
    "not recognized",
    "no match",
  ]) {
    const detection = extractCatDetection({ identified_cats: [label] });
    assert.deepEqual(detection.catNames, [], label);
    assert.equal(detection.catCount, 1, label);
    assert.equal(detection.detected, true, label);
  }
});

test("falls back to raw cat prediction labels", () => {
  const detection = extractCatDetection({
    raw_cat_predictions: [
      { class: "cat", confidence: 0.97 },
      { class: "bowl", confidence: 0.88 },
    ],
  });

  assert.equal(detection.detected, true);
  assert.equal(detection.catCount, 1);
  assert.deepEqual(detection.catNames, []);
});

test("records one entered and one left event per identified cat", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nine-lives-transitions-"));
  const filePath = join(directory, "detections.jsonl");
  let now = new Date("2026-07-30T12:00:00.000Z");

  try {
    const log = new DetectionLog({ filePath, now: () => now });
    await log.load();

    assert.deepEqual(
      await log.recordFromInference({ identified_cats: [] }),
      [],
    );

    const [bobbyEntered] = await log.recordFromInference(
      {
        identified_cats: ["bobby"],
        vision_events_event_id: "event-one",
      },
      { frameId: "10" },
    );
    assert.equal(bobbyEntered.message, "Bobby entered.");
    assert.equal(bobbyEntered.event, "entered");
    assert.equal(bobbyEntered.catName, "Bobby");
    assert.equal(bobbyEntered.frameId, "10");
    assert.equal(bobbyEntered.clipId, bobbyEntered.id);
    assert.equal(bobbyEntered.clipReady, false);
    assert.equal(bobbyEntered.clipStatus, "recording");

    now = new Date("2026-07-30T12:00:01.000Z");
    assert.deepEqual(
      await log.recordFromInference({
        identified_cats: ["bobby"],
        vision_events_event_id: "event-two",
      }),
      [],
    );

    const [lunaEntered] = await log.recordFromInference({
      identified_cats: ["bobby", "luna"],
    });
    assert.equal(lunaEntered.message, "Luna entered.");

    now = new Date("2026-07-30T12:00:02.000Z");
    assert.deepEqual(
      await log.recordFromInference({ identified_cats: ["luna"] }),
      [],
    );
    now = new Date("2026-07-30T12:00:03.000Z");
    const [bobbyLeft] = await log.recordFromInference({
      identified_cats: ["luna"],
    });
    assert.equal(bobbyLeft.message, "Bobby left.");

    now = new Date("2026-07-30T12:00:04.000Z");
    assert.deepEqual(
      await log.recordFromInference({ identified_cats: [] }),
      [],
    );
    now = new Date("2026-07-30T12:00:05.000Z");
    const [lunaLeft] = await log.recordFromInference({
      identified_cats: [],
    });
    assert.equal(lunaLeft.message, "Luna left.");
    assert.equal(log.getStatus().total, 4);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("restores current cat presence from persisted transitions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nine-lives-reload-"));
  const filePath = join(directory, "detections.jsonl");
  let now = new Date("2026-07-30T12:00:00.000Z");

  try {
    const firstLog = new DetectionLog({ filePath, now: () => now });
    await firstLog.recordFromInference({ identified_cats: ["bobby"] });

    const reloaded = new DetectionLog({ filePath, now: () => now });
    await reloaded.load();
    assert.deepEqual(
      await reloaded.recordFromInference({ identified_cats: ["bobby"] }),
      [],
    );

    assert.deepEqual(
      await reloaded.recordFromInference({ identified_cats: [] }),
      [],
    );
    now = new Date("2026-07-30T12:00:01.000Z");
    const [left] = await reloaded.recordFromInference({ identified_cats: [] });
    assert.equal(left.message, "Bobby left.");
    assert.equal(reloaded.getStatus().total, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("tracks anonymous cats by count when no identities are available", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nine-lives-anonymous-"));
  const filePath = join(directory, "detections.jsonl");
  let now = new Date("2026-07-30T12:00:00.000Z");

  try {
    const log = new DetectionLog({ filePath, now: () => now });
    const entered = await log.recordFromInference({ identified_cats: 2 });
    assert.deepEqual(
      entered.map((entry) => entry.message),
      ["A cat entered.", "A cat entered."],
    );
    assert.deepEqual(
      await log.recordFromInference({ identified_cats: 2 }),
      [],
    );

    assert.deepEqual(
      await log.recordFromInference({ identified_cats: 1 }),
      [],
    );
    now = new Date("2026-07-30T12:00:01.000Z");
    const oneLeft = await log.recordFromInference({ identified_cats: 1 });
    assert.equal(oneLeft[0].message, "A cat left.");
    assert.deepEqual(
      await log.recordFromInference({ identified_cats: 0 }),
      [],
    );
    now = new Date("2026-07-30T12:00:02.000Z");
    const lastLeft = await log.recordFromInference({ identified_cats: 0 });
    assert.equal(lastLeft[0].message, "A cat left.");
    assert.equal(log.getStatus().total, 4);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("cancels a pending exit when detection flickers for less than one second", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nine-lives-cooldown-"));
  const filePath = join(directory, "detections.jsonl");
  let now = new Date("2026-07-30T12:00:00.000Z");

  try {
    const log = new DetectionLog({ filePath, now: () => now });
    const [entered] = await log.recordFromInference({
      identified_cats: ["bobby"],
    });
    assert.equal(entered.message, "Bobby entered.");

    for (let index = 1; index <= 9; index += 1) {
      now = new Date(`2026-07-30T12:00:00.${index}00Z`);
      assert.deepEqual(
        await log.recordFromInference({ identified_cats: [] }),
        [],
      );
      now = new Date(`2026-07-30T12:00:00.${index}50Z`);
      assert.deepEqual(
        await log.recordFromInference({ identified_cats: ["bobby"] }),
        [],
      );
    }

    assert.equal(log.getStatus().total, 1);
    now = new Date("2026-07-30T12:00:02.000Z");
    assert.deepEqual(
      await log.recordFromInference({ identified_cats: [] }),
      [],
    );
    now = new Date("2026-07-30T12:00:03.000Z");
    const [left] = await log.recordFromInference({ identified_cats: [] });
    assert.equal(left.message, "Bobby left.");
    assert.equal(log.getStatus().total, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("does not log identity flicker between a known and unknown cat", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nine-lives-identity-flicker-"));
  const filePath = join(directory, "detections.jsonl");
  let now = new Date("2026-07-30T12:00:00.000Z");

  try {
    const log = new DetectionLog({ filePath, now: () => now });
    const [entered] = await log.recordFromInference({
      identified_cats: ["bobby"],
    });
    assert.equal(entered.message, "Bobby entered.");

    for (let index = 1; index <= 5; index += 1) {
      now = new Date(2026, 6, 30, 8, 0, index);
      assert.deepEqual(
        await log.recordFromInference({
          identified_cats: ["unknown cat"],
        }),
        [],
      );
      now = new Date(2026, 6, 30, 8, 0, index, 100);
      assert.deepEqual(
        await log.recordFromInference({ identified_cats: ["bobby"] }),
        [],
      );
    }

    assert.equal(log.getStatus().total, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("streams new persisted presence transitions to live clients", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nine-lives-stream-"));
  const filePath = join(directory, "detections.jsonl");
  const response = new FakeEventStreamResponse();

  try {
    const log = new DetectionLog({ filePath });
    log.openStream(response);
    await log.recordFromInference({
      identified_cats: ["bobby"],
      vision_events_event_id: "live-event",
    });

    assert.equal(response.status, 200);
    assert.equal(
      response.headers["Content-Type"],
      "text/event-stream; charset=utf-8",
    );
    assert.match(response.output, /event: detection/);
    assert.match(response.output, /"message":"Bobby entered\."/);

    response.emit("close");
    log.stop();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
