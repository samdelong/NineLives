import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const DEFAULT_INFERENCE_SCHEDULE = Object.freeze({
  enabled: false,
  windows: Object.freeze([
    Object.freeze({ start: "07:00", end: "09:00" }),
    Object.freeze({ start: "17:00", end: "19:00" }),
  ]),
});

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const MAX_WINDOWS = 24;

export class ScheduleValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ScheduleValidationError";
    this.status = 400;
  }
}

export function timeToMinutes(value) {
  if (typeof value !== "string") return null;
  const match = value.match(TIME_PATTERN);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

export function validateSchedule(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ScheduleValidationError("The schedule must be an object.");
  }
  if (typeof value.enabled !== "boolean") {
    throw new ScheduleValidationError("Schedule enabled must be true or false.");
  }
  if (!Array.isArray(value.windows)) {
    throw new ScheduleValidationError("Schedule windows must be an array.");
  }
  if (value.windows.length > MAX_WINDOWS) {
    throw new ScheduleValidationError(
      `A schedule can contain at most ${MAX_WINDOWS} windows.`,
    );
  }

  const windows = value.windows.map((window, index) => {
    if (!window || typeof window !== "object" || Array.isArray(window)) {
      throw new ScheduleValidationError(
        `Schedule window ${index + 1} must be an object.`,
      );
    }
    const startMinutes = timeToMinutes(window.start);
    const endMinutes = timeToMinutes(window.end);
    if (startMinutes === null || endMinutes === null) {
      throw new ScheduleValidationError(
        `Schedule window ${index + 1} must use HH:MM times.`,
      );
    }
    return {
      start: window.start,
      end: window.end,
    };
  });

  windows.sort(
    (left, right) =>
      timeToMinutes(left.start) - timeToMinutes(right.start) ||
      timeToMinutes(left.end) - timeToMinutes(right.end),
  );

  return {
    enabled: value.enabled,
    windows,
  };
}

function minuteIsInsideWindow(minute, window) {
  const start = timeToMinutes(window.start);
  const end = timeToMinutes(window.end);

  if (start === end) return true;
  if (start < end) return minute >= start && minute < end;
  return minute >= start || minute < end;
}

export function isScheduleActive(schedule, now = new Date()) {
  if (!schedule.enabled) return true;

  const minute = now.getHours() * 60 + now.getMinutes();
  return schedule.windows.some((window) =>
    minuteIsInsideWindow(minute, window),
  );
}

export function findNextScheduleTransition(schedule, now = new Date()) {
  if (!schedule.enabled || schedule.windows.length === 0) return null;
  if (
    schedule.windows.some(
      (window) => timeToMinutes(window.start) === timeToMinutes(window.end),
    )
  ) {
    return null;
  }

  const candidates = [];
  for (let dayOffset = 0; dayOffset <= 2; dayOffset += 1) {
    for (const window of schedule.windows) {
      for (const value of [window.start, window.end]) {
        const minutes = timeToMinutes(value);
        const candidate = new Date(now);
        candidate.setHours(0, 0, 0, 0);
        candidate.setDate(candidate.getDate() + dayOffset);
        candidate.setMinutes(minutes);
        if (candidate > now) candidates.push(candidate);
      }
    }
  }

  candidates.sort((left, right) => left - right);
  return (
    candidates.find((candidate) => {
      const before = new Date(candidate.getTime() - 1);
      const after = new Date(candidate.getTime() + 1);
      return (
        isScheduleActive(schedule, before) !==
        isScheduleActive(schedule, after)
      );
    }) ?? null
  );
}

function cloneDefaultSchedule() {
  return {
    enabled: DEFAULT_INFERENCE_SCHEDULE.enabled,
    windows: DEFAULT_INFERENCE_SCHEDULE.windows.map((window) => ({ ...window })),
  };
}

export class InferenceScheduleController {
  constructor({
    worker,
    filePath,
    now = () => new Date(),
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
    checkIntervalMs = 15_000,
    logger = console,
  }) {
    this.worker = worker;
    this.filePath = filePath;
    this.now = now;
    this.setIntervalFn = setIntervalFn;
    this.clearIntervalFn = clearIntervalFn;
    this.checkIntervalMs = checkIntervalMs;
    this.logger = logger;

    this.schedule = cloneDefaultSchedule();
    this.active = null;
    this.timer = null;
  }

  async load() {
    try {
      const contents = await readFile(this.filePath, "utf8");
      this.schedule = validateSchedule(JSON.parse(contents));
    } catch (error) {
      if (error?.code !== "ENOENT") {
        this.logger.warn(
          `Could not load inference schedule; using defaults: ${error.message}`,
        );
      }
    }
    return this.getStatus();
  }

  start() {
    if (this.timer) return;
    this.reconcile();
    this.timer = this.setIntervalFn(
      () => this.reconcile(),
      this.checkIntervalMs,
    );
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) this.clearIntervalFn(this.timer);
    this.timer = null;
  }

  reconcile() {
    const active = isScheduleActive(this.schedule, this.now());
    if (active === this.active) return;

    this.active = active;
    if (active) {
      this.worker.start();
    } else {
      this.worker.pause();
    }
  }

  restartIfActive() {
    const active = isScheduleActive(this.schedule, this.now());
    this.active = active;
    if (active) {
      this.worker.restart();
    } else {
      this.worker.pause();
    }
  }

  async update(value) {
    const schedule = validateSchedule(value);
    await mkdir(dirname(this.filePath), { recursive: true });

    const temporaryPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(schedule, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(temporaryPath, this.filePath);

    this.schedule = schedule;
    this.active = null;
    this.reconcile();
    return this.getStatus();
  }

  getStatus(now = this.now()) {
    const active = isScheduleActive(this.schedule, now);
    const nextTransition = findNextScheduleTransition(this.schedule, now);

    return {
      enabled: this.schedule.enabled,
      windows: this.schedule.windows.map((window) => ({ ...window })),
      active,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      serverTime: now.toISOString(),
      nextTransitionAt: nextTransition?.toISOString() ?? null,
    };
  }
}
