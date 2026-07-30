import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

const DEFAULT_DEDUPE_WINDOW_MS = 5 * 60 * 1_000;

function findValuesByKey(value, targetKey, matches = []) {
  if (Array.isArray(value)) {
    for (const item of value) findValuesByKey(item, targetKey, matches);
    return matches;
  }
  if (!value || typeof value !== "object") return matches;

  for (const [key, child] of Object.entries(value)) {
    if (key.toLowerCase() === targetKey) matches.push(child);
    findValuesByKey(child, targetKey, matches);
  }
  return matches;
}

function firstScalar(value) {
  if (Array.isArray(value)) {
    for (const item of value) {
      const scalar = firstScalar(item);
      if (scalar !== null) return scalar;
    }
    return null;
  }
  if (typeof value === "string" || typeof value === "number") {
    const normalized = String(value).trim();
    return normalized || null;
  }
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) {
      const scalar = firstScalar(child);
      if (scalar !== null) return scalar;
    }
  }
  return null;
}

function countIdentifiedCats(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.round(value));
  }
  if (typeof value === "boolean") return value ? 1 : 0;
  if (Array.isArray(value)) return value.length;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (
      !normalized ||
      ["0", "false", "none", "no"].includes(normalized) ||
      /\bno cats?\b/.test(normalized)
    ) {
      return 0;
    }
    const numeric = Number(normalized);
    return Number.isFinite(numeric) ? Math.max(0, Math.round(numeric)) : 1;
  }
  if (value && typeof value === "object") {
    for (const key of ["count", "cat_count", "number_of_cats"]) {
      if (key in value) return countIdentifiedCats(value[key]);
    }
  }
  return null;
}

function countPredictionCats(predictions) {
  const values = Array.isArray(predictions) ? predictions : [predictions];
  return values.filter((prediction) => {
    if (!prediction || typeof prediction !== "object") return false;
    const label =
      prediction.class ??
      prediction.class_name ??
      prediction.label ??
      prediction.category;
    return typeof label === "string" && /\bcats?\b/i.test(label);
  }).length;
}

export function extractCatDetection(data) {
  const identifiedValues = findValuesByKey(data, "identified_cats");
  let catCount = null;
  for (const value of identifiedValues) {
    const count = countIdentifiedCats(value);
    if (count !== null) catCount = Math.max(catCount ?? 0, count);
  }

  if (catCount === null) {
    const predictionValues = findValuesByKey(data, "raw_cat_predictions");
    catCount = predictionValues.reduce(
      (total, value) => Math.max(total, countPredictionCats(value)),
      0,
    );
  }

  const workflowEventId = firstScalar(
    findValuesByKey(data, "vision_events_event_id"),
  );
  const message = firstScalar(
    findValuesByKey(data, "vision_events_message"),
  );

  return {
    catCount,
    detected: catCount > 0,
    workflowEventId,
    message,
  };
}

function isStoredEntry(value) {
  return (
    value &&
    typeof value === "object" &&
    typeof value.id === "string" &&
    typeof value.detectedAt === "string" &&
    Number.isFinite(value.catCount)
  );
}

function writeEvent(response, entry) {
  response.write(`event: detection\ndata: ${JSON.stringify(entry)}\n\n`);
}

export class DetectionLog {
  constructor({
    filePath,
    now = () => new Date(),
    dedupeWindowMs = DEFAULT_DEDUPE_WINDOW_MS,
    logger = console,
  }) {
    this.filePath = filePath;
    this.now = now;
    this.dedupeWindowMs = dedupeWindowMs;
    this.logger = logger;

    this.entries = [];
    this.seenEventIds = new Set();
    this.currentlyDetected = false;
    this.lastFallbackDetectionAt = null;
    this.clients = new Set();
    this.writeQueue = Promise.resolve();
  }

  async load() {
    let contents;
    try {
      contents = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return this.getStatus();
      throw error;
    }

    let invalidLines = 0;
    this.entries = contents
      .split(/\r?\n/)
      .filter(Boolean)
      .flatMap((line) => {
        try {
          const entry = JSON.parse(line);
          if (isStoredEntry(entry)) return [entry];
        } catch {
          // Count malformed records below and continue loading valid history.
        }
        invalidLines += 1;
        return [];
      });
    this.seenEventIds = new Set(
      this.entries
        .map((entry) => entry.workflowEventId)
        .filter((eventId) => typeof eventId === "string" && eventId),
    );

    if (invalidLines > 0) {
      this.logger.warn(
        `Skipped ${invalidLines} invalid detection log ${
          invalidLines === 1 ? "record" : "records"
        }.`,
      );
    }
    return this.getStatus();
  }

  async recordFromInference(data, { frameId = null } = {}) {
    const detection = extractCatDetection(data);
    if (!detection.detected) {
      this.currentlyDetected = false;
      return null;
    }

    const detectedAt = this.now();
    if (detection.workflowEventId) {
      if (this.seenEventIds.has(detection.workflowEventId)) return null;
      this.seenEventIds.add(detection.workflowEventId);
    } else {
      const withinDedupeWindow =
        this.lastFallbackDetectionAt &&
        detectedAt.getTime() - this.lastFallbackDetectionAt.getTime() <
          this.dedupeWindowMs;
      if (this.currentlyDetected && withinDedupeWindow) return null;
      this.lastFallbackDetectionAt = detectedAt;
    }
    this.currentlyDetected = true;

    const entry = {
      id: randomUUID(),
      detectedAt: detectedAt.toISOString(),
      catCount: detection.catCount,
      message: detection.message,
      workflowEventId: detection.workflowEventId,
      frameId: frameId === null ? null : String(frameId),
    };

    try {
      await this.persist(entry);
    } catch (error) {
      if (entry.workflowEventId) {
        this.seenEventIds.delete(entry.workflowEventId);
      }
      throw error;
    }

    this.entries.push(entry);
    this.broadcast(entry);
    return entry;
  }

  async persist(entry) {
    await mkdir(dirname(this.filePath), { recursive: true });
    this.writeQueue = this.writeQueue
      .catch(() => undefined)
      .then(() =>
        appendFile(this.filePath, `${JSON.stringify(entry)}\n`, {
          encoding: "utf8",
          mode: 0o600,
        }),
      );
    await this.writeQueue;
  }

  broadcast(entry) {
    for (const response of this.clients) {
      if (response.destroyed || response.writableEnded) {
        this.clients.delete(response);
        continue;
      }
      writeEvent(response, entry);
    }
  }

  openStream(response) {
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    response.write("retry: 2000\n\n");

    const heartbeat = setInterval(() => {
      if (!response.destroyed && !response.writableEnded) {
        response.write(": keepalive\n\n");
      }
    }, 20_000);
    heartbeat.unref?.();

    this.clients.add(response);
    response.on("close", () => {
      clearInterval(heartbeat);
      this.clients.delete(response);
    });
  }

  getEntries() {
    return [...this.entries].reverse();
  }

  getStatus() {
    const latest = this.entries.at(-1) ?? null;
    return {
      total: this.entries.length,
      latestDetectionAt: latest?.detectedAt ?? null,
    };
  }

  stop() {
    for (const response of this.clients) response.end();
    this.clients.clear();
  }
}
