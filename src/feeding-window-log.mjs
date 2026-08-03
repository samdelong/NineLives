import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { extractCatDetection } from "./detection-log.mjs";
import { timeToMinutes } from "./inference-schedule.mjs";

const MAX_DISPLAYED_CATS = 2;
const DEFAULT_DETECTION_CONFIRMATION_MS = 5_000;

function localDayStart(value) {
  const day = new Date(value);
  day.setHours(0, 0, 0, 0);
  return day;
}

function dateAtMinute(day, minute, dayOffset = 0) {
  const value = new Date(day);
  value.setDate(value.getDate() + dayOffset);
  value.setMinutes(minute);
  return value;
}

function occurrenceKey(startedAt, endedAt, scheduleStart, scheduleEnd, index) {
  return [
    startedAt.toISOString(),
    endedAt.toISOString(),
    scheduleStart,
    scheduleEnd,
    index,
  ].join("|");
}

export function resolveActiveFeedingWindows(schedule, at = new Date()) {
  const day = localDayStart(at);
  const minute = at.getHours() * 60 + at.getMinutes();

  if (!schedule?.enabled) {
    const endedAt = dateAtMinute(day, 0, 1);
    return [
      {
        key: occurrenceKey(day, endedAt, "00:00", "00:00", "continuous"),
        startedAt: day,
        endedAt,
        scheduleStart: "00:00",
        scheduleEnd: "00:00",
      },
    ];
  }

  const occurrences = [];
  for (const [index, window] of (schedule.windows ?? []).entries()) {
    const startMinute = timeToMinutes(window.start);
    const endMinute = timeToMinutes(window.end);
    if (startMinute === null || endMinute === null) continue;

    let startedAt;
    let endedAt;
    if (startMinute === endMinute) {
      startedAt = day;
      endedAt = dateAtMinute(day, 0, 1);
    } else if (startMinute < endMinute) {
      if (minute < startMinute || minute >= endMinute) continue;
      startedAt = dateAtMinute(day, startMinute);
      endedAt = dateAtMinute(day, endMinute);
    } else if (minute >= startMinute) {
      startedAt = dateAtMinute(day, startMinute);
      endedAt = dateAtMinute(day, endMinute, 1);
    } else if (minute < endMinute) {
      startedAt = dateAtMinute(day, startMinute, -1);
      endedAt = dateAtMinute(day, endMinute);
    } else {
      continue;
    }

    occurrences.push({
      key: occurrenceKey(
        startedAt,
        endedAt,
        window.start,
        window.end,
        index,
      ),
      startedAt,
      endedAt,
      scheduleStart: window.start,
      scheduleEnd: window.end,
    });
  }
  return occurrences;
}

function isStoredWindow(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof value.id === "string" &&
      typeof value.key === "string" &&
      !Number.isNaN(new Date(value.startedAt).getTime()) &&
      !Number.isNaN(new Date(value.endedAt).getTime()) &&
      Number.isFinite(value.catCount) &&
      Array.isArray(value.catNames) &&
      value.catNames.every((name) => typeof name === "string"),
  );
}

function createStoredWindow(occurrence) {
  return {
    id: randomUUID(),
    key: occurrence.key,
    startedAt: occurrence.startedAt.toISOString(),
    endedAt: occurrence.endedAt.toISOString(),
    scheduleStart: occurrence.scheduleStart,
    scheduleEnd: occurrence.scheduleEnd,
    catCount: 0,
    catNames: [],
  };
}

function addDetection(record, detection) {
  const names = new Map(
    record.catNames.map((name) => [name.toLocaleLowerCase(), name]),
  );
  for (const name of detection.catNames) {
    names.set(name.toLocaleLowerCase(), name);
  }

  const catNames = [...names.values()];
  const catCount = Math.min(
    MAX_DISPLAYED_CATS,
    Math.max(record.catCount, detection.catCount, catNames.length),
  );
  const changed =
    catCount !== record.catCount ||
    catNames.length !== record.catNames.length;

  if (changed) {
    record.catCount = catCount;
    record.catNames = catNames;
  }
  return changed;
}

function addStableDetection(
  record,
  detection,
  pending,
  atMs,
  confirmationMs,
) {
  let changed = false;
  const detectedCount = Math.min(
    MAX_DISPLAYED_CATS,
    Math.max(0, detection.catCount),
  );

  for (let count = 1; count <= MAX_DISPLAYED_CATS; count += 1) {
    if (record.catCount >= count) {
      pending.countSince.delete(count);
      continue;
    }
    if (detectedCount < count) {
      pending.countSince.delete(count);
      continue;
    }

    const since = pending.countSince.get(count);
    if (since === undefined) {
      if (confirmationMs === 0) {
        record.catCount = Math.max(record.catCount, count);
        changed = true;
      } else {
        pending.countSince.set(count, atMs);
      }
    } else if (atMs - since >= confirmationMs) {
      record.catCount = Math.max(record.catCount, count);
      pending.countSince.delete(count);
      changed = true;
    }
  }

  const detectedNames = new Map(
    detection.catNames.map((name) => [name.toLocaleLowerCase(), name]),
  );
  const confirmedNames = new Map(
    record.catNames.map((name) => [name.toLocaleLowerCase(), name]),
  );
  for (const key of pending.nameSince.keys()) {
    if (!detectedNames.has(key)) pending.nameSince.delete(key);
  }
  for (const [key, name] of detectedNames) {
    if (confirmedNames.has(key)) {
      pending.nameSince.delete(key);
      continue;
    }
    const since = pending.nameSince.get(key);
    if (since === undefined) {
      if (confirmationMs === 0) {
        confirmedNames.set(key, name);
        changed = true;
      } else {
        pending.nameSince.set(key, atMs);
      }
    } else if (atMs - since >= confirmationMs) {
      confirmedNames.set(key, name);
      pending.nameSince.delete(key);
      changed = true;
    }
  }

  record.catNames = [...confirmedNames.values()].slice(0, MAX_DISPLAYED_CATS);
  record.catCount = Math.max(record.catCount, record.catNames.length);
  return changed;
}

export class FeedingWindowLog {
  constructor({
    filePath,
    scheduleProvider,
    confirmationMs = DEFAULT_DETECTION_CONFIRMATION_MS,
    now = () => new Date(),
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
    checkIntervalMs = 15_000,
    logger = console,
  }) {
    this.filePath = filePath;
    this.scheduleProvider = scheduleProvider;
    this.confirmationMs = Math.max(0, confirmationMs);
    this.now = now;
    this.setIntervalFn = setIntervalFn;
    this.clearIntervalFn = clearIntervalFn;
    this.checkIntervalMs = checkIntervalMs;
    this.logger = logger;

    this.windows = [];
    this.byKey = new Map();
    this.pendingDetections = new Map();
    this.timer = null;
    this.writeQueue = Promise.resolve();
  }

  async load() {
    try {
      const payload = JSON.parse(await readFile(this.filePath, "utf8"));
      const windows = Array.isArray(payload) ? payload : payload.windows;
      this.windows = Array.isArray(windows)
        ? windows.filter(isStoredWindow)
        : [];
      this.byKey = new Map(this.windows.map((window) => [window.key, window]));
      this.pendingDetections.clear();
    } catch (error) {
      if (error?.code !== "ENOENT") {
        this.logger.warn(`Could not load feeding-window history: ${error.message}`);
      }
    }
    return this.getStatus();
  }

  ensureOccurrence(occurrence) {
    const existing = this.byKey.get(occurrence.key);
    if (existing) return { record: existing, created: false };

    const record = createStoredWindow(occurrence);
    this.windows.push(record);
    this.byKey.set(record.key, record);
    return { record, created: true };
  }

  async persist() {
    const contents = `${JSON.stringify({ version: 1, windows: this.windows }, null, 2)}\n`;
    const temporaryPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    this.writeQueue = this.writeQueue
      .catch(() => undefined)
      .then(async () => {
        await mkdir(dirname(this.filePath), { recursive: true });
        await writeFile(temporaryPath, contents, { mode: 0o600 });
        await rename(temporaryPath, this.filePath);
      });
    await this.writeQueue;
  }

  async reconcile(at = this.now()) {
    const atMs = at.getTime();
    for (const [windowId] of this.pendingDetections) {
      const record = this.windows.find((window) => window.id === windowId);
      if (!record || new Date(record.endedAt).getTime() <= atMs) {
        this.pendingDetections.delete(windowId);
      }
    }

    let changed = false;
    for (const occurrence of resolveActiveFeedingWindows(
      this.scheduleProvider(),
      at,
    )) {
      changed = this.ensureOccurrence(occurrence).created || changed;
    }
    if (changed) await this.persist();
    return changed;
  }

  async observe(data, { at = this.now() } = {}) {
    const detection = extractCatDetection(data);
    const atMs = at.getTime();
    let changed = false;
    const records = [];

    for (const occurrence of resolveActiveFeedingWindows(
      this.scheduleProvider(),
      at,
    )) {
      const ensured = this.ensureOccurrence(occurrence);
      let pending = this.pendingDetections.get(ensured.record.id);
      if (!pending) {
        pending = { countSince: new Map(), nameSince: new Map() };
        this.pendingDetections.set(ensured.record.id, pending);
      }
      const detectionChanged = addStableDetection(
        ensured.record,
        detection,
        pending,
        atMs,
        this.confirmationMs,
      );
      changed = ensured.created || detectionChanged || changed;
      records.push(ensured.record);
    }

    if (changed) await this.persist();
    return records;
  }

  async backfill(entries) {
    let changed = false;
    for (const entry of [...entries].reverse()) {
      const detectedAt = new Date(entry.detectedAt);
      if (Number.isNaN(detectedAt.getTime())) continue;

      for (const occurrence of resolveActiveFeedingWindows(
        this.scheduleProvider(),
        detectedAt,
      )) {
        const ensured = this.ensureOccurrence(occurrence);
        changed = ensured.created || changed;
        changed =
          addDetection(ensured.record, {
            catCount: Number.isFinite(entry.catCount) ? entry.catCount : 0,
            catNames: entry.catName ? [entry.catName] : [],
          }) || changed;
      }
    }
    if (changed) await this.persist();
    return changed;
  }

  getWindows(entries = [], at = this.now()) {
    const nowMs = at.getTime();
    return [...this.windows]
      .sort((left, right) => new Date(right.startedAt) - new Date(left.startedAt))
      .map((record) => {
        const startedAtMs = new Date(record.startedAt).getTime();
        const endedAtMs = new Date(record.endedAt).getTime();
        const events = entries.filter((entry) => {
          const eventAtMs = new Date(entry.detectedAt).getTime();
          return eventAtMs >= startedAtMs && eventAtMs < endedAtMs;
        });
        const names = new Map(
          record.catNames.map((name) => [name.toLocaleLowerCase(), name]),
        );
        let catCount = record.catCount;
        for (const entry of events) {
          if (entry.catName) {
            names.set(entry.catName.toLocaleLowerCase(), entry.catName);
          }
          catCount = Math.max(catCount, entry.catCount ?? 0, names.size);
        }

        return {
          id: record.id,
          startedAt: record.startedAt,
          endedAt: record.endedAt,
          scheduleStart: record.scheduleStart,
          scheduleEnd: record.scheduleEnd,
          status:
            nowMs >= startedAtMs && nowMs < endedAtMs
              ? "active"
              : "complete",
          catCount: Math.min(MAX_DISPLAYED_CATS, catCount),
          catNames: [...names.values()],
          events,
        };
      });
  }

  getStatus() {
    return {
      total: this.windows.length,
    };
  }

  async start() {
    if (this.timer) return;
    await this.reconcile();
    this.timer = this.setIntervalFn(() => {
      void this.reconcile().catch((error) => {
        this.logger.error(`Could not update feeding-window history: ${error.message}`);
      });
    }, this.checkIntervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) this.clearIntervalFn(this.timer);
    this.timer = null;
    this.pendingDetections.clear();
  }
}
