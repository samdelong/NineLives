import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  FeedingWindowLog,
  resolveActiveFeedingWindows,
} from "../src/feeding-window-log.mjs";

test("resolves daytime, overnight, and continuous feeding windows", () => {
  const daytime = resolveActiveFeedingWindows(
    {
      enabled: true,
      windows: [{ start: "07:00", end: "09:00" }],
    },
    new Date(2026, 6, 30, 8, 15),
  );
  assert.equal(daytime.length, 1);
  assert.equal(daytime[0].startedAt.getHours(), 7);
  assert.equal(daytime[0].endedAt.getHours(), 9);

  assert.deepEqual(
    resolveActiveFeedingWindows(
      {
        enabled: true,
        windows: [{ start: "07:00", end: "09:00" }],
      },
      new Date(2026, 6, 30, 12, 0),
    ),
    [],
  );

  const overnight = resolveActiveFeedingWindows(
    {
      enabled: true,
      windows: [{ start: "22:00", end: "02:00" }],
    },
    new Date(2026, 6, 30, 1, 0),
  );
  assert.equal(overnight.length, 1);
  assert.equal(overnight[0].startedAt.getDate(), 29);
  assert.equal(overnight[0].startedAt.getHours(), 22);
  assert.equal(overnight[0].endedAt.getDate(), 30);
  assert.equal(overnight[0].endedAt.getHours(), 2);

  const continuous = resolveActiveFeedingWindows(
    { enabled: false, windows: [] },
    new Date(2026, 6, 30, 12, 0),
  );
  assert.equal(continuous.length, 1);
  assert.equal(continuous[0].startedAt.getHours(), 0);
  assert.equal(continuous[0].endedAt.getDate(), 31);
});

test("persists zero-cat windows and aggregates up to two detected cats", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nine-lives-feeding-windows-"));
  const filePath = join(directory, "feeding-windows.json");
  let now = new Date(2026, 6, 30, 8, 15, 0, 0);
  const schedule = {
    enabled: true,
    windows: [{ start: "07:00", end: "09:00" }],
  };

  try {
    const log = new FeedingWindowLog({
      filePath,
      scheduleProvider: () => schedule,
      now: () => now,
      setIntervalFn: () => ({ unref() {} }),
      clearIntervalFn: () => undefined,
    });
    await log.load();
    await log.start();

    let [window] = log.getWindows([], now);
    assert.equal(window.catCount, 0);
    assert.deepEqual(window.catNames, []);

    await log.observe({ identified_cats: ["bobby"] }, { at: now });
    now = new Date(2026, 6, 30, 8, 15, 4, 0);
    await log.observe({ identified_cats: ["bobby"] }, { at: now });
    assert.equal(log.getWindows([], now)[0].catCount, 0);

    now = new Date(2026, 6, 30, 8, 15, 4, 100);
    await log.observe({ identified_cats: [] }, { at: now });
    now = new Date(2026, 6, 30, 8, 15, 5, 0);
    await log.observe({ identified_cats: ["bobby"] }, { at: now });
    now = new Date(2026, 6, 30, 8, 15, 10, 1);
    await log.observe({ identified_cats: ["bobby"] }, { at: now });
    assert.equal(log.getWindows([], now)[0].catCount, 1);

    now = new Date(2026, 6, 30, 8, 15, 11, 0);
    await log.observe(
      { identified_cats: ["bobby", "luna"] },
      { at: now },
    );
    now = new Date(2026, 6, 30, 8, 15, 16, 1);
    await log.observe(
      { identified_cats: ["bobby", "luna"] },
      { at: now },
    );

    [window] = log.getWindows(
      [
        {
          id: "event-1",
          detectedAt: new Date(2026, 6, 30, 8, 5).toISOString(),
          catName: "Bobby",
          catCount: 1,
          clipId: "clip-1",
          clipReady: true,
        },
      ],
      now,
    );
    assert.equal(window.catCount, 2);
    assert.deepEqual(window.catNames, ["Bobby", "Luna"]);
    assert.equal(window.events.length, 1);
    assert.equal(window.events[0].clipId, "clip-1");

    const stored = JSON.parse(await readFile(filePath, "utf8"));
    assert.equal(stored.windows.length, 1);
    assert.equal(stored.windows[0].catCount, 2);

    const reloaded = new FeedingWindowLog({
      filePath,
      scheduleProvider: () => schedule,
      now: () => now,
    });
    await reloaded.load();
    assert.equal(reloaded.getWindows([], now)[0].catCount, 2);
    assert.deepEqual(reloaded.getWindows([], now)[0].catNames, ["Bobby", "Luna"]);
    log.stop();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
