import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

const NAME_KEYS = new Set([
  "cat_name",
  "catname",
  "class",
  "class_name",
  "identity",
  "label",
  "name",
]);

const NAME_CONTAINER_KEYS = new Set([
  "cats",
  "cat_names",
  "catnames",
  "identified",
  "identities",
  "names",
  "predictions",
  "results",
]);

const NON_NAME_KEYS = new Set([
  "box",
  "class_id",
  "confidence",
  "count",
  "height",
  "id",
  "number_of_cats",
  "points",
  "score",
  "width",
  "x",
  "y",
]);

const ABSENT_NAME_VALUES =
  /^(?:0|false|n\/a|no|no cats?|none|null|unknown|unidentified)$/i;
const GENERIC_CAT_VALUES = /^(?:a |the )?cats?$/i;
const DEFAULT_LOG_COOLDOWN_MS = 1_000;

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

function titleCaseName(value) {
  if (value !== value.toLowerCase() && value !== value.toUpperCase()) {
    return value;
  }
  return value
    .toLowerCase()
    .replace(/(^|[\s'-])([\p{L}\p{N}])/gu, (_, prefix, character) =>
      `${prefix}${character.toUpperCase()}`,
    );
}

function normalizeCatName(value) {
  if (typeof value !== "string") return null;

  let name = value
    .trim()
    .replace(/^[-*•]\s*/, "")
    .replace(/^(?:cat(?:\s+name)?|identity|name)\s*[:=-]\s*/i, "")
    .replace(
      /\s+(?:has\s+)?(?:arrived|departed|detected|entered|left|present|visible)$/i,
      "",
    )
    .replace(/\s+is\s+(?:in (?:the )?frame|present|visible)$/i, "")
    .replace(/\s+(?:in|inside) (?:the )?frame$/i, "")
    .replace(/^["']|["'.]$/g, "")
    .trim();

  if (
    !name ||
    name.length > 48 ||
    name.split(/\s+/).length > 4 ||
    ABSENT_NAME_VALUES.test(name) ||
    GENERIC_CAT_VALUES.test(name) ||
    /^\d+(?:\.\d+)?$/.test(name)
  ) {
    return null;
  }

  return titleCaseName(name);
}

function addCatName(names, value) {
  const name = normalizeCatName(value);
  if (name) names.set(name.toLocaleLowerCase(), name);
}

function collectNamesFromString(value, names) {
  const text = value.trim();
  if (!text || ABSENT_NAME_VALUES.test(text)) return;

  if (
    (text.startsWith("[") && text.endsWith("]")) ||
    (text.startsWith("{") && text.endsWith("}"))
  ) {
    try {
      collectCatNames(JSON.parse(text), names);
      return;
    } catch {
      // Treat non-JSON strings as ordinary Workflow output below.
    }
  }

  const parts = text
    .split(/\s*(?:,|;|\band\b|\n)\s*/i)
    .map((part) => part.trim())
    .filter(Boolean);
  for (const part of parts) addCatName(names, part);
}

function collectCatNames(value, names = new Map(), depth = 0) {
  if (depth > 8 || value === null || value === undefined) return names;

  if (typeof value === "string") {
    collectNamesFromString(value, names);
    return names;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectCatNames(item, names, depth + 1);
    return names;
  }
  if (typeof value !== "object") return names;

  let foundStructuredField = false;
  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase();
    if (NAME_KEYS.has(normalizedKey)) {
      foundStructuredField = true;
      if (typeof child === "string") collectNamesFromString(child, names);
      continue;
    }
    if (NAME_CONTAINER_KEYS.has(normalizedKey)) {
      foundStructuredField = true;
      collectCatNames(child, names, depth + 1);
    }
  }

  if (!foundStructuredField) {
    for (const [key, child] of Object.entries(value)) {
      const normalizedKey = key.toLowerCase();
      if (
        NON_NAME_KEYS.has(normalizedKey) ||
        NAME_KEYS.has(normalizedKey) ||
        NAME_CONTAINER_KEYS.has(normalizedKey)
      ) {
        continue;
      }
      if (child === true) addCatName(names, key);
    }
  }

  return names;
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

function nameFromEventMessage(message) {
  if (typeof message !== "string") return null;
  const match = message
    .trim()
    .match(
      /^(.{1,48}?)\s+(?:has\s+)?(?:arrived|departed|detected|entered|left|is present|is visible)\b/i,
    );
  return match ? normalizeCatName(match[1]) : null;
}

export function extractCatDetection(data) {
  const identifiedValues = findValuesByKey(data, "identified_cats");
  const names = new Map();
  let catCount = null;

  for (const value of identifiedValues) {
    collectCatNames(value, names);
    const count = countIdentifiedCats(value);
    if (count !== null) catCount = Math.max(catCount ?? 0, count);
  }

  if (names.size > 0) catCount = Math.max(catCount ?? 0, names.size);

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
  const messageName = nameFromEventMessage(message);
  if (messageName && catCount > 0) {
    names.set(messageName.toLocaleLowerCase(), messageName);
    catCount = Math.max(catCount, names.size);
  }

  return {
    catCount,
    catNames: [...names.values()],
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
    Number.isFinite(value.catCount) &&
    (value.event === undefined ||
      value.event === "entered" ||
      value.event === "left") &&
    (value.catName === undefined ||
      value.catName === null ||
      typeof value.catName === "string")
  );
}

function writeEvent(response, entry) {
  response.write(`event: detection\ndata: ${JSON.stringify(entry)}\n\n`);
}

function transitionMessage(catName, event) {
  return `${catName || "A cat"} ${event}.`;
}

export class DetectionLog {
  constructor({
    filePath,
    now = () => new Date(),
    cooldownMs = DEFAULT_LOG_COOLDOWN_MS,
    logger = console,
  }) {
    this.filePath = filePath;
    this.now = now;
    this.cooldownMs = Math.max(0, cooldownMs);
    this.logger = logger;

    this.entries = [];
    this.presentCats = new Map();
    this.presentAnonymousCount = 0;
    this.pendingDepartures = new Map();
    this.pendingAnonymousDeparture = null;
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

    this.restorePresenceState();

    if (invalidLines > 0) {
      this.logger.warn(
        `Skipped ${invalidLines} invalid detection log ${
          invalidLines === 1 ? "record" : "records"
        }.`,
      );
    }
    return this.getStatus();
  }

  restorePresenceState() {
    this.presentCats.clear();
    this.presentAnonymousCount = 0;
    this.pendingDepartures.clear();
    this.pendingAnonymousDeparture = null;

    for (const entry of this.entries) {
      if (!entry.event) continue;
      if (entry.catName) {
        const key = entry.catName.toLocaleLowerCase();
        if (entry.event === "entered") {
          this.presentCats.set(key, entry.catName);
        } else {
          this.presentCats.delete(key);
        }
      } else if (entry.event === "entered") {
        this.presentAnonymousCount += 1;
      } else {
        this.presentAnonymousCount = Math.max(
          0,
          this.presentAnonymousCount - 1,
        );
      }
    }
  }

  markNamedCatMissing(key, name, occurredAt, transitions) {
    const missingSince = this.pendingDepartures.get(key);
    if (!missingSince) {
      if (this.cooldownMs === 0) {
        transitions.push({ catName: name, event: "left" });
        this.presentCats.delete(key);
      } else {
        this.pendingDepartures.set(key, occurredAt);
      }
      return;
    }

    if (occurredAt.getTime() - missingSince.getTime() < this.cooldownMs) {
      return;
    }

    transitions.push({ catName: name, event: "left" });
    this.pendingDepartures.delete(key);
    this.presentCats.delete(key);
  }

  reconcileAnonymousCount(nextCount, occurredAt, transitions) {
    if (nextCount >= this.presentAnonymousCount) {
      this.pendingAnonymousDeparture = null;
      for (
        let index = this.presentAnonymousCount;
        index < nextCount;
        index += 1
      ) {
        transitions.push({ catName: null, event: "entered" });
      }
      this.presentAnonymousCount = nextCount;
      return;
    }

    if (this.cooldownMs === 0) {
      for (let index = nextCount; index < this.presentAnonymousCount; index += 1) {
        transitions.push({ catName: null, event: "left" });
      }
      this.presentAnonymousCount = nextCount;
      this.pendingAnonymousDeparture = null;
      return;
    }

    if (
      !this.pendingAnonymousDeparture ||
      this.pendingAnonymousDeparture.count !== nextCount
    ) {
      this.pendingAnonymousDeparture = {
        count: nextCount,
        since: occurredAt,
      };
      return;
    }

    if (
      occurredAt.getTime() -
        this.pendingAnonymousDeparture.since.getTime() <
      this.cooldownMs
    ) {
      return;
    }

    for (let index = nextCount; index < this.presentAnonymousCount; index += 1) {
      transitions.push({ catName: null, event: "left" });
    }
    this.presentAnonymousCount = nextCount;
    this.pendingAnonymousDeparture = null;
  }

  async recordFromInference(data, { frameId = null } = {}) {
    const detection = extractCatDetection(data);
    const occurredAt = this.now();
    const transitions = [];

    if (detection.catNames.length > 0) {
      const nextCats = new Map(
        detection.catNames.map((name) => [name.toLocaleLowerCase(), name]),
      );
      const anonymousMatches = Math.min(
        this.presentAnonymousCount,
        nextCats.size,
      );
      let matchedAnonymous = 0;

      for (const [key, name] of nextCats) {
        this.pendingDepartures.delete(key);
        if (this.presentCats.has(key)) continue;
        if (matchedAnonymous < anonymousMatches) {
          matchedAnonymous += 1;
        } else {
          transitions.push({ catName: name, event: "entered" });
        }
        this.presentCats.set(key, name);
      }
      for (const [key, name] of this.presentCats) {
        if (!nextCats.has(key)) {
          this.markNamedCatMissing(key, name, occurredAt, transitions);
        }
      }

      this.presentAnonymousCount -= matchedAnonymous;
      this.reconcileAnonymousCount(0, occurredAt, transitions);
    } else if (!detection.detected) {
      for (const [key, name] of this.presentCats) {
        this.markNamedCatMissing(key, name, occurredAt, transitions);
      }
      this.reconcileAnonymousCount(0, occurredAt, transitions);
    } else {
      // A positive count without identities is often a transient Workflow
      // fallback. Keep known cats present so an identity flicker does not
      // manufacture leave/re-enter events.
      for (const key of this.presentCats.keys()) {
        this.pendingDepartures.delete(key);
      }
      this.reconcileAnonymousCount(
        Math.max(0, detection.catCount - this.presentCats.size),
        occurredAt,
        transitions,
      );
    }

    const entries = [];
    for (const transition of transitions) {
      const entry = {
        id: randomUUID(),
        detectedAt: occurredAt.toISOString(),
        event: transition.event,
        catName: transition.catName,
        catCount: detection.catCount,
        message: transitionMessage(
          transition.catName,
          transition.event,
        ),
        workflowMessage: detection.message,
        workflowEventId: detection.workflowEventId,
        frameId: frameId === null ? null : String(frameId),
      };
      await this.persist(entry);
      this.entries.push(entry);
      this.broadcast(entry);
      entries.push(entry);
    }

    return entries;
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
      latestEventAt: latest?.detectedAt ?? null,
    };
  }

  stop() {
    for (const response of this.clients) response.end();
    this.clients.clear();
  }
}
