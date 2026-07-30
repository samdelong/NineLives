import { readFile } from "node:fs/promises";

const frame = await readFile(
  new URL("../../public/og.png", import.meta.url),
);
const sinkUrl = process.env.INFERENCE_SINK_URL;
const sinkToken = process.env.INFERENCE_SINK_TOKEN;
let frameId = 0;
let posting = false;

async function post(path, body, contentType, id) {
  const response = await fetch(`${sinkUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": contentType,
      "X-Inference-Token": sinkToken,
      "X-Frame-Id": String(id),
    },
    body,
  });
  if (!response.ok) {
    throw new Error(`Mock sink returned ${response.status}.`);
  }
}

async function publishMockInference() {
  if (posting) return;
  posting = true;
  frameId += 1;

  try {
    const mockEventId = frameId < 8 ? "mock-cat-event-1" : "mock-cat-event-2";
    await post(
      "/api/inference/frame",
      frame,
      "image/png",
      frameId,
    );
    await post(
      "/api/inference/data",
      JSON.stringify({
        frame_id: String(frameId),
        data: {
          identified_cats: 1,
          raw_cat_predictions: [{ class: "cat", confidence: 0.97 }],
          vision_events_event_id: mockEventId,
          vision_events_message:
            mockEventId === "mock-cat-event-1"
              ? "Mock cat entered the feeding area."
              : "A second mock cat event was detected.",
        },
      }),
      "application/json",
      frameId,
    );
  } finally {
    posting = false;
  }
}

console.log("Mock WebRTC worker started.");
void publishMockInference();
const timer = setInterval(() => void publishMockInference(), 250);

function shutdown() {
  clearInterval(timer);
  process.exit(0);
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
