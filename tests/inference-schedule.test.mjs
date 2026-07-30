import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  findNextScheduleTransition,
  InferenceScheduleController,
  isScheduleActive,
  validateSchedule,
} from "../src/inference-schedule.mjs";

test("validates and sorts daily schedule windows", () => {
  assert.deepEqual(
    validateSchedule({
      enabled: true,
      windows: [
        { start: "17:00", end: "19:00" },
        { start: "07:00", end: "09:00" },
      ],
    }),
    {
      enabled: true,
      windows: [
        { start: "07:00", end: "09:00" },
        { start: "17:00", end: "19:00" },
      ],
    },
  );

  assert.throws(
    () =>
      validateSchedule({
        enabled: true,
        windows: [{ start: "7am", end: "09:00" }],
      }),
    /HH:MM/,
  );
});

test("supports normal, overnight, disabled, and all-day windows", () => {
  const at = (hours, minutes = 0) =>
    new Date(2026, 6, 30, hours, minutes, 0, 0);

  assert.equal(
    isScheduleActive(
      {
        enabled: true,
        windows: [{ start: "07:00", end: "09:00" }],
      },
      at(8),
    ),
    true,
  );
  assert.equal(
    isScheduleActive(
      {
        enabled: true,
        windows: [{ start: "22:00", end: "02:00" }],
      },
      at(1),
    ),
    true,
  );
  assert.equal(
    isScheduleActive(
      {
        enabled: true,
        windows: [{ start: "22:00", end: "02:00" }],
      },
      at(12),
    ),
    false,
  );
  assert.equal(
    isScheduleActive({ enabled: false, windows: [] }, at(12)),
    true,
  );
  assert.equal(
    isScheduleActive(
      {
        enabled: true,
        windows: [{ start: "00:00", end: "00:00" }],
      },
      at(12),
    ),
    true,
  );
});

test("finds the next transition in local server time", () => {
  const transition = findNextScheduleTransition(
    {
      enabled: true,
      windows: [{ start: "07:00", end: "09:00" }],
    },
    new Date(2026, 6, 30, 8, 15, 0, 0),
  );

  assert.equal(transition.getHours(), 9);
  assert.equal(transition.getMinutes(), 0);
  assert.equal(transition.getDate(), 30);
});

test("persists schedule updates and starts or pauses the worker immediately", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nine-lives-schedule-"));
  const filePath = join(directory, "schedule.json");
  const actions = [];
  let now = new Date(2026, 6, 30, 12, 0, 0, 0);
  let timerCleared = false;
  const controller = new InferenceScheduleController({
    worker: {
      start() {
        actions.push("start");
      },
      pause() {
        actions.push("pause");
      },
      restart() {
        actions.push("restart");
      },
    },
    filePath,
    now: () => now,
    setIntervalFn() {
      return { unref() {} };
    },
    clearIntervalFn() {
      timerCleared = true;
    },
  });

  try {
    await controller.load();
    controller.start();
    assert.equal(actions.at(-1), "start");

    await controller.update({
      enabled: true,
      windows: [{ start: "07:00", end: "09:00" }],
    });
    assert.equal(actions.at(-1), "pause");
    assert.deepEqual(JSON.parse(await readFile(filePath, "utf8")), {
      enabled: true,
      windows: [{ start: "07:00", end: "09:00" }],
    });

    now = new Date(2026, 6, 30, 8, 0, 0, 0);
    controller.reconcile();
    assert.equal(actions.at(-1), "start");

    controller.stop();
    assert.equal(timerCleared, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
