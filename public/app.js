import {
  classifyWindow,
  createOneHourWindow,
  isValidTime,
} from "./schedule.js";

const elements = {
  cameraBadge: document.querySelector("#cameraBadge"),
  cameraBadgeLabel: document.querySelector("#cameraBadgeLabel"),
  cameraCover: document.querySelector("#cameraCover"),
  cameraCoverMessage: document.querySelector("#cameraCoverMessage"),
  cameraFeed: document.querySelector("#cameraFeed"),
  cameraSource: document.querySelector("#cameraSource"),
  detectionLog: document.querySelector("#detectionLog"),
  detectionLogConnection: document.querySelector("#detectionLogConnection"),
  detectionLogCount: document.querySelector("#detectionLogCount"),
  emptyResult: document.querySelector("#emptyResult"),
  errorMessage: document.querySelector("#errorMessage"),
  errorResult: document.querySelector("#errorResult"),
  inferenceStatus: document.querySelector("#inferenceStatus"),
  inferenceStatusLabel: document.querySelector("#inferenceStatusLabel"),
  liveChip: document.querySelector("#liveChip"),
  rawResult: document.querySelector("#rawResult"),
  restartCameraButton: document.querySelector("#restartCameraButton"),
  resultCheck: document.querySelector("#resultCheck"),
  resultDetail: document.querySelector("#resultDetail"),
  resultEyebrow: document.querySelector("#resultEyebrow"),
  resultHeadline: document.querySelector("#resultHeadline"),
  resultTimestamp: document.querySelector("#resultTimestamp"),
  runningDetail: document.querySelector("#runningDetail"),
  runningResult: document.querySelector("#runningResult"),
  runningTitle: document.querySelector("#runningTitle"),
  saveScheduleButton: document.querySelector("#saveScheduleButton"),
  scheduleAddButton: document.querySelector("#scheduleAddButton"),
  scheduleClearButton: document.querySelector("#scheduleClearButton"),
  scheduleEnabled: document.querySelector("#scheduleEnabled"),
  scheduleEveningButton: document.querySelector("#scheduleEveningButton"),
  scheduleFeedback: document.querySelector("#scheduleFeedback"),
  scheduleMorningButton: document.querySelector("#scheduleMorningButton"),
  scheduleSummary: document.querySelector("#scheduleSummary"),
  scheduleWindows: document.querySelector("#scheduleWindows"),
  successResult: document.querySelector("#successResult"),
};

const labelKeys = new Set(["class", "class_name", "label", "category"]);
const countKey =
  /^(cat(s)?_?count|number_of_cats|identified_cats)$/i;
const presenceKey =
  /^(cat(s)?_(present|detected)|contains_?cats?|is_?cat|identified_cats)$/i;

let lastInferenceCount = -1;
let hasDisplayedResult = false;
let latestSchedule = null;
let scheduleDirty = false;
let scheduleInitialized = false;
let selectedScheduleWindows = [];
let detectionEntries = [];
let detectionLogTotal = 0;
let detectionTimezone;

function formatPiTime(value, timezone) {
  try {
    return new Date(value).toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit",
      timeZone: timezone,
    });
  } catch {
    return new Date(value).toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit",
    });
  }
}

function markScheduleDirty() {
  scheduleDirty = true;
  const count = selectedScheduleWindows.length;
  elements.scheduleFeedback.textContent = count
    ? `Unsaved · ${count} ${count === 1 ? "window" : "windows"}`
    : "Unsaved · no windows";
  elements.scheduleFeedback.className = "schedule-feedback--pending";
}

function updateWindowTag(tag, window) {
  const classification = classifyWindow(window);
  tag.hidden = classification === "daytime";
  tag.className = `schedule-window-tag schedule-window-tag--${classification}`;
  tag.textContent =
    classification === "overnight"
      ? "Ends next day"
      : classification === "all-day"
        ? "Runs all day"
        : classification === "invalid"
          ? "Choose both times"
          : "";
}

function createTimeField(label, value, index, key, tag) {
  const field = document.createElement("label");
  field.className = "schedule-time-field";

  const caption = document.createElement("span");
  caption.textContent = label;

  const input = document.createElement("input");
  input.type = "time";
  input.step = "60";
  input.value = value;
  input.setAttribute(
    "aria-label",
    `Window ${index + 1} ${label.toLowerCase()} time`,
  );
  input.addEventListener("input", () => {
    selectedScheduleWindows[index][key] = input.value;
    updateWindowTag(tag, selectedScheduleWindows[index]);
    markScheduleDirty();
  });

  field.append(caption, input);
  return field;
}

function renderScheduleWindows() {
  elements.scheduleWindows.replaceChildren();
  elements.scheduleAddButton.disabled = selectedScheduleWindows.length >= 24;

  if (selectedScheduleWindows.length === 0) {
    const empty = document.createElement("p");
    empty.className = "schedule-window-empty";
    empty.textContent = "No inference windows selected.";
    elements.scheduleWindows.append(empty);
    return;
  }

  selectedScheduleWindows.forEach((window, index) => {
    const row = document.createElement("div");
    row.className = "schedule-window-row";

    const times = document.createElement("div");
    times.className = "schedule-window-times";

    const tag = document.createElement("span");
    updateWindowTag(tag, window);

    const separator = document.createElement("span");
    separator.className = "schedule-time-separator";
    separator.textContent = "→";
    separator.setAttribute("aria-hidden", "true");

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "schedule-window-remove";
    remove.textContent = "×";
    remove.setAttribute("aria-label", `Remove window ${index + 1}`);
    remove.addEventListener("click", () => {
      selectedScheduleWindows.splice(index, 1);
      renderScheduleWindows();
      markScheduleDirty();
    });

    const start = createTimeField("Start", window.start, index, "start", tag);
    const end = createTimeField("End", window.end, index, "end", tag);
    times.append(start, separator, end, remove);
    row.append(times, tag);
    elements.scheduleWindows.append(row);
  });
}

function renderScheduleSummary(schedule) {
  const timezone = schedule.timezone || "Pi local time";
  let summary;

  if (!schedule.enabled) {
    summary = `Schedule off · inference runs all day (${timezone}).`;
  } else if (schedule.windows.length === 0) {
    summary = `Paused all day · add at least one time window (${timezone}).`;
  } else if (schedule.active) {
    summary = schedule.nextTransitionAt
      ? `Running now · pauses at ${formatPiTime(
          schedule.nextTransitionAt,
          timezone,
        )} (${timezone}).`
      : `Running all day (${timezone}).`;
  } else {
    summary = schedule.nextTransitionAt
      ? `Paused now · starts at ${formatPiTime(
          schedule.nextTransitionAt,
          timezone,
        )} (${timezone}).`
      : `Paused all day (${timezone}).`;
  }

  elements.scheduleSummary.textContent = summary;
}

function syncSchedule(schedule) {
  latestSchedule = schedule;
  renderScheduleSummary(schedule);

  if (!scheduleInitialized || !scheduleDirty) {
    elements.scheduleEnabled.checked = schedule.enabled;
    selectedScheduleWindows = schedule.windows.map((window) => ({ ...window }));
    scheduleInitialized = true;
    renderScheduleWindows();
  }
}

function detectionDateLabel(value) {
  const options = {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  };
  if (detectionTimezone) options.timeZone = detectionTimezone;
  return new Date(value).toLocaleDateString([], options);
}

function detectionTimeLabel(value) {
  const options = {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  };
  if (detectionTimezone) options.timeZone = detectionTimezone;
  return new Date(value).toLocaleTimeString([], options);
}

function renderDetectionLog() {
  elements.detectionLog.replaceChildren();
  elements.detectionLogCount.textContent =
    `${detectionLogTotal.toLocaleString()} ${
      detectionLogTotal === 1 ? "event" : "events"
    }`;

  if (detectionEntries.length === 0) {
    const empty = document.createElement("p");
    empty.className = "detection-log-empty";
    empty.textContent = "No cat activity saved yet.";
    elements.detectionLog.append(empty);
    return;
  }

  let currentDate = "";
  for (const entry of detectionEntries) {
    const dateLabel = detectionDateLabel(entry.detectedAt);
    if (dateLabel !== currentDate) {
      currentDate = dateLabel;
      const date = document.createElement("p");
      date.className = "detection-log-date";
      date.textContent = dateLabel;
      elements.detectionLog.append(date);
    }

    const row = document.createElement("article");
    row.className = "detection-log-entry";
    if (entry.event === "left") {
      row.classList.add("detection-log-entry--left");
    }

    const dot = document.createElement("span");
    dot.className = "detection-log-dot";
    dot.setAttribute("aria-hidden", "true");

    const body = document.createElement("div");
    const title = document.createElement("p");
    title.className = "detection-log-title";
    title.textContent =
      entry.event === "entered" || entry.event === "left"
        ? entry.message ||
          `${entry.catName || "A cat"} ${entry.event}.`
        : `${entry.catCount} ${
            entry.catCount === 1 ? "cat" : "cats"
          } detected`;

    const detail = document.createElement("p");
    detail.className = "detection-log-time";
    detail.textContent = detectionTimeLabel(entry.detectedAt);
    body.append(title, detail);

    const supportingMessage =
      entry.workflowMessage ||
      (entry.event ? null : entry.message);
    if (supportingMessage) {
      const message = document.createElement("p");
      message.className = "detection-log-message";
      message.textContent = String(supportingMessage).slice(0, 180);
      body.append(message);
    }

    if (entry.clipId) {
      const clip = document.createElement(
        entry.clipReady ? "a" : "span",
      );
      clip.className = entry.clipReady
        ? "detection-log-clip"
        : "detection-log-clip detection-log-clip--pending";
      if (entry.clipReady) {
        clip.href = `/api/clips/${encodeURIComponent(entry.clipId)}.mp4`;
        clip.target = "_blank";
        clip.rel = "noopener";
        clip.textContent = "Watch 10s clip →";
      } else if (entry.clipStatus === "recording") {
        clip.textContent = "Recording 10s clip…";
      } else {
        clip.textContent = "Clip unavailable";
      }
      body.append(clip);
    }

    row.append(dot, body);
    elements.detectionLog.append(row);
  }
}

async function loadDetectionLog() {
  try {
    const response = await fetch("/api/detections", { cache: "no-store" });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "Detection history unavailable.");
    }

    detectionTimezone = payload.timezone;
    const merged = new Map(
      [...payload.entries, ...detectionEntries].map((entry) => [
        entry.id,
        entry,
      ]),
    );
    detectionEntries = [...merged.values()].sort(
      (left, right) =>
        new Date(right.detectedAt) - new Date(left.detectedAt),
    );
    detectionLogTotal = Math.max(payload.total, detectionEntries.length);
    renderDetectionLog();
  } catch {
    elements.detectionLogConnection.textContent = "Unavailable";
    elements.detectionLogConnection.className =
      "detection-log-connection detection-log-connection--error";
  }
}

function connectDetectionLog() {
  if (!("EventSource" in window)) {
    elements.detectionLogConnection.textContent = "Polling";
    window.setInterval(() => void loadDetectionLog(), 5_000);
    return;
  }

  const source = new EventSource("/api/detections/stream");
  source.addEventListener("open", () => {
    elements.detectionLogConnection.textContent = "Live";
    elements.detectionLogConnection.className =
      "detection-log-connection detection-log-connection--live";
    void loadDetectionLog();
  });
  source.addEventListener("error", () => {
    elements.detectionLogConnection.textContent = "Reconnecting";
    elements.detectionLogConnection.className =
      "detection-log-connection detection-log-connection--error";
  });
  source.addEventListener("detection", (event) => {
    try {
      const entry = JSON.parse(event.data);
      const existingIndex = detectionEntries.findIndex(
        (existing) => existing.id === entry.id,
      );
      if (existingIndex === -1) {
        detectionEntries.unshift(entry);
        detectionLogTotal += 1;
      } else {
        detectionEntries[existingIndex] = {
          ...detectionEntries[existingIndex],
          ...entry,
        };
      }
      renderDetectionLog();
    } catch {
      void loadDetectionLog();
    }
  });
}

function summarizeInference(result) {
  const catDetections = [];
  let explicitCount = null;
  let explicitPresence = null;

  const visit = (value) => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== "object") return;

    for (const [key, child] of Object.entries(value)) {
      if (countKey.test(key)) {
        if (typeof child === "number") explicitCount = child;
        if (Array.isArray(child)) explicitCount = child.length;
      }
      if (presenceKey.test(key) && typeof child === "boolean") {
        explicitPresence = child;
      }
      if (
        labelKeys.has(key.toLowerCase()) &&
        typeof child === "string" &&
        /\bcats?\b/i.test(child)
      ) {
        catDetections.push({
          confidence:
            typeof value.confidence === "number" ? value.confidence : undefined,
        });
      }
      visit(child);
    }
  };

  visit(result);

  const count = explicitCount ?? catDetections.length;
  const catSeen = explicitPresence ?? count > 0;

  if (catSeen) {
    const confidences = catDetections
      .map(({ confidence }) => confidence)
      .filter((confidence) => confidence !== undefined);
    const bestConfidence = confidences.length
      ? Math.max(...confidences)
      : undefined;
    const confidenceLabel =
      bestConfidence !== undefined
        ? ` Highest confidence: ${Math.round(bestConfidence * 100)}%.`
        : "";

    return {
      eyebrow: "Cat signal",
      headline:
        count > 0
          ? `${count} ${count === 1 ? "cat" : "cats"} detected`
          : "Cat detected",
      detail: `The live workflow sees a cat.${confidenceLabel}`,
      positive: true,
    };
  }

  if (explicitPresence === false || explicitCount === 0) {
    return {
      eyebrow: "Clear frame",
      headline: "No cats detected",
      detail: "The latest workflow result did not report a cat.",
      positive: false,
    };
  }

  return {
    eyebrow: "Workflow response",
    headline: "Inference running",
    detail: "The workflow is producing annotated frames and prediction data.",
    positive: false,
  };
}

function showResult(name) {
  for (const resultName of [
    "emptyResult",
    "runningResult",
    "errorResult",
    "successResult",
  ]) {
    elements[resultName].hidden = resultName !== name;
  }
}

function setPipelineState(state, label, message = "") {
  elements.cameraBadge.className = `camera-badge camera-badge--${state}`;
  elements.cameraBadgeLabel.textContent = label;

  const ready = state === "ready";
  elements.cameraCover.hidden = ready;
  elements.liveChip.setAttribute("aria-hidden", String(!ready));

  if (message) {
    elements.cameraCoverMessage.textContent = message;
  }
}

function setInferenceStatus(state, label) {
  elements.inferenceStatus.className =
    `continuous-status continuous-status--${state}`;
  elements.inferenceStatusLabel.textContent = label;
}

function rawResultWithoutImage(result) {
  return JSON.stringify(
    result,
    (key, value) => {
      if (
        /^(output_image|annotated_image)$/i.test(key) &&
        (typeof value === "string" || (value && typeof value === "object"))
      ) {
        return "[annotated image omitted]";
      }
      return value;
    },
    2,
  );
}

async function refreshLatestResult(expectedCount) {
  if (expectedCount === lastInferenceCount) return;

  const response = await fetch("/api/inference/latest", {
    cache: "no-store",
  });
  const payload = await response.json();
  if (!response.ok || !("result" in payload)) {
    throw new Error(payload.error || "Inference result unavailable.");
  }

  lastInferenceCount = payload.inferenceCount;
  hasDisplayedResult = true;

  const summary = summarizeInference(payload.result);
  elements.successResult.className = summary.positive
    ? "success-result success-result--positive"
    : "success-result";
  elements.resultEyebrow.textContent = summary.eyebrow;
  elements.resultHeadline.textContent = summary.headline;
  elements.resultDetail.textContent = summary.detail;
  elements.resultCheck.textContent = summary.positive ? "✓" : "·";
  elements.resultTimestamp.textContent = `Inference ${payload.inferenceCount.toLocaleString()} · ${new Date(
    payload.inferredAt,
  ).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })}`;
  elements.rawResult.textContent = rawResultWithoutImage(payload.result);
  showResult("successResult");
}

async function refreshStatus() {
  try {
    const response = await fetch("/api/status", { cache: "no-store" });
    if (!response.ok) throw new Error("Status request failed.");
    const { camera, inference, schedule } = await response.json();
    syncSchedule(schedule);

    elements.cameraSource.textContent =
      `${camera.command} · ${camera.width}×${camera.height} · ${camera.framerate} camera fps · WebRTC video`;

    const cameraReady =
      camera.hasFrame &&
      camera.frameAgeMs !== null &&
      camera.frameAgeMs < 5_000;
    const scheduledPause = schedule.enabled && !schedule.active;
    const nextStart = schedule.nextTransitionAt
      ? formatPiTime(schedule.nextTransitionAt, schedule.timezone)
      : null;

    if (scheduledPause) {
      setPipelineState(
        "scheduled",
        "Inference scheduled",
        nextStart
          ? `The camera is live. Inference will begin at ${nextStart} (${schedule.timezone}).`
          : "The camera is live. Select and save an inference window to begin processing.",
      );
    } else if (inference.hasFrame) {
      setPipelineState("ready", "Continuous inference live");
    } else if (!cameraReady && (camera.lastError || camera.state === "restarting")) {
      setPipelineState(
        "error",
        "Pi camera offline",
        camera.lastError ||
          "The camera process is not running. The server will retry automatically.",
      );
    } else if (inference.state === "error" || inference.state === "unconfigured") {
      setPipelineState(
        "error",
        "Inference unavailable",
        inference.lastError || "The inference workflow could not be reached.",
      );
    } else if (cameraReady) {
      setPipelineState(
        "requesting",
        "Starting inference",
        "The camera is live. Waiting for the first annotated workflow frame…",
      );
    } else {
      setPipelineState(
        "requesting",
        "Connecting to Pi",
        "Waiting for the first frame from rpicam-vid…",
      );
    }

    elements.restartCameraButton.hidden = !camera.lastError;

    if (scheduledPause) {
      setInferenceStatus(
        "scheduled",
        nextStart ? `Paused until ${nextStart}` : "Paused by schedule",
      );
      if (!hasDisplayedResult) {
        elements.runningTitle.textContent = "Inference is scheduled";
        elements.runningDetail.textContent = nextStart
          ? `The next window begins at ${nextStart}`
          : "Select a time window and save the schedule";
        showResult("runningResult");
      }
    } else if (inference.state === "live" || inference.state === "running") {
      setInferenceStatus(
        "live",
        inference.inFlight
          ? "Processing live frame"
          : `${inference.inferenceCount.toLocaleString()} frames processed`,
      );
    } else if (inference.state === "error" || inference.state === "unconfigured") {
      setInferenceStatus("error", "Inference retrying");
      if (!hasDisplayedResult) {
        elements.errorMessage.textContent =
          inference.lastError || "The inference workflow could not be reached.";
        showResult("errorResult");
      }
    } else {
      setInferenceStatus("waiting", "Waiting for first result");
      if (!hasDisplayedResult) {
        elements.runningTitle.textContent = "Starting continuous inference";
        elements.runningDetail.textContent =
          "Waiting for the first annotated workflow frame";
        showResult("runningResult");
      }
    }

    if (inference.inferenceCount > 0) {
      await refreshLatestResult(inference.inferenceCount);
    }
  } catch (error) {
    setPipelineState(
      "error",
      "Server unavailable",
      "The browser could not reach the Pi camera server.",
    );
    setInferenceStatus("error", "Backend disconnected");
    if (!hasDisplayedResult) {
      elements.errorMessage.textContent =
        error instanceof Error ? error.message : "Backend disconnected.";
      showResult("errorResult");
    }
  }
}

async function restartCamera() {
  elements.restartCameraButton.disabled = true;
  try {
    await fetch("/api/camera/restart", { method: "POST" });
    setPipelineState(
      "requesting",
      "Restarting camera",
      "The Pi camera process is starting again…",
    );
  } finally {
    window.setTimeout(() => {
      elements.restartCameraButton.disabled = false;
      void refreshStatus();
    }, 1_500);
  }
}

function addScheduleWindow(window) {
  if (selectedScheduleWindows.length >= 24) {
    elements.scheduleFeedback.textContent = "Maximum of 24 windows";
    elements.scheduleFeedback.className = "schedule-feedback--error";
    return;
  }

  selectedScheduleWindows.push({ ...window });
  elements.scheduleEnabled.checked = true;
  renderScheduleWindows();
  markScheduleDirty();
}

async function saveSchedule() {
  if (
    selectedScheduleWindows.some(
      (window) => !isValidTime(window.start) || !isValidTime(window.end),
    )
  ) {
    elements.scheduleFeedback.textContent =
      "Choose a start and end for every window";
    elements.scheduleFeedback.className = "schedule-feedback--error";
    return;
  }

  elements.saveScheduleButton.disabled = true;
  elements.scheduleFeedback.textContent = "Saving…";
  elements.scheduleFeedback.className = "";

  try {
    const response = await fetch("/api/schedule", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        enabled: elements.scheduleEnabled.checked,
        windows: selectedScheduleWindows.map((window) => ({ ...window })),
      }),
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "The schedule could not be saved.");
    }

    scheduleDirty = false;
    syncSchedule(payload);
    elements.scheduleFeedback.textContent = "Saved";
    elements.scheduleFeedback.className = "schedule-feedback--saved";
    await refreshStatus();
  } catch (error) {
    elements.scheduleFeedback.textContent =
      error instanceof Error ? error.message : "Save failed";
    elements.scheduleFeedback.className = "schedule-feedback--error";
  } finally {
    elements.saveScheduleButton.disabled = false;
  }
}

renderScheduleWindows();

elements.scheduleEnabled.addEventListener("change", markScheduleDirty);
elements.scheduleAddButton.addEventListener("click", () =>
  addScheduleWindow(createOneHourWindow()),
);
elements.scheduleMorningButton.addEventListener("click", () =>
  addScheduleWindow({ start: "07:00", end: "09:00" }),
);
elements.scheduleEveningButton.addEventListener("click", () =>
  addScheduleWindow({ start: "17:00", end: "19:00" }),
);
elements.scheduleClearButton.addEventListener("click", () => {
  selectedScheduleWindows = [];
  renderScheduleWindows();
  markScheduleDirty();
});
elements.saveScheduleButton.addEventListener("click", () =>
  void saveSchedule(),
);
elements.restartCameraButton.addEventListener("click", () =>
  void restartCamera(),
);
elements.cameraFeed.addEventListener("error", () => {
  if (latestSchedule?.enabled && !latestSchedule.active) {
    const nextStart = latestSchedule.nextTransitionAt
      ? formatPiTime(
          latestSchedule.nextTransitionAt,
          latestSchedule.timezone,
        )
      : null;
    setPipelineState(
      "scheduled",
      "Inference scheduled",
      nextStart
        ? `The camera is live. Inference will begin at ${nextStart} (${latestSchedule.timezone}).`
        : "The camera is live. Select and save an inference window to begin processing.",
    );
    return;
  }
  setPipelineState(
    "error",
    "Output stream interrupted",
    "Waiting for the annotated inference stream to reconnect…",
  );
});

void refreshStatus();
void loadDetectionLog();
connectDetectionLog();
window.setInterval(() => void refreshStatus(), 1_000);
