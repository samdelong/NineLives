const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isValidTime(value) {
  return typeof value === "string" && TIME_PATTERN.test(value);
}

export function classifyWindow(window) {
  if (!isValidTime(window?.start) || !isValidTime(window?.end)) {
    return "invalid";
  }
  if (window.start === window.end) return "all-day";
  return window.start > window.end ? "overnight" : "daytime";
}

function dateToTime(date) {
  return `${String(date.getHours()).padStart(2, "0")}:${String(
    date.getMinutes(),
  ).padStart(2, "0")}`;
}

export function createOneHourWindow(now = new Date()) {
  const end = new Date(now.getTime() + 60 * 60 * 1_000);
  return {
    start: dateToTime(now),
    end: dateToTime(end),
  };
}
