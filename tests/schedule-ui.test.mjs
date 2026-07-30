import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyWindow,
  createOneHourWindow,
  isValidTime,
} from "../public/schedule.js";

test("accepts arbitrary minute-level schedule times", () => {
  assert.equal(isValidTime("07:13"), true);
  assert.equal(isValidTime("18:47"), true);
  assert.equal(isValidTime("24:00"), false);
  assert.equal(isValidTime("7:13"), false);
});

test("classifies daytime, overnight, and all-day windows", () => {
  assert.equal(
    classifyWindow({ start: "07:13", end: "08:41" }),
    "daytime",
  );
  assert.equal(
    classifyWindow({ start: "22:17", end: "01:08" }),
    "overnight",
  );
  assert.equal(
    classifyWindow({ start: "00:00", end: "00:00" }),
    "all-day",
  );
});

test("creates a one-hour window without rounding the selected minute", () => {
  const window = createOneHourWindow(new Date(2026, 6, 30, 23, 37));

  assert.deepEqual(window, { start: "23:37", end: "00:37" });
});
