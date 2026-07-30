import { spawn as spawnChild } from "node:child_process";

export class InferenceWorker {
  constructor({
    command,
    script,
    env,
    publisher,
    enabled = true,
    spawn = spawnChild,
    restartDelayMs = 1_500,
    maxRestartDelayMs = 15_000,
    logger = console,
  }) {
    this.command = command;
    this.script = script;
    this.env = env;
    this.publisher = publisher;
    this.enabled = enabled;
    this.spawn = spawn;
    this.restartDelayMs = restartDelayMs;
    this.maxRestartDelayMs = maxRestartDelayMs;
    this.currentRestartDelayMs = restartDelayMs;
    this.logger = logger;

    this.child = null;
    this.restartTimer = null;
    this.stopping = true;
    this.stderrTail = [];
  }

  start() {
    if (this.child || this.restartTimer) return;
    this.stopping = false;
    this.stderrTail = [];

    if (!this.enabled) {
      this.publisher.setWorkerState("unconfigured", {
        error:
          "Add ROBOFLOW_API_KEY, ROBOFLOW_WORKSPACE, and ROBOFLOW_WORKFLOW to .env.local.",
      });
      return;
    }

    this.publisher.setWorkerState("starting");

    let child;
    try {
      child = this.spawn(this.command, [this.script], {
        env: { ...process.env, ...this.env },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      this.handleFailure(error);
      return;
    }

    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk) => {
      for (const line of chunk.split(/\r?\n/).filter(Boolean)) {
        this.logger.log(`[inference] ${line}`);
      }
    });
    child.stderr.on("data", (chunk) => {
      const lines = chunk
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      this.stderrTail.push(...lines);
      this.stderrTail = this.stderrTail.slice(-8);
      for (const line of lines) {
        this.logger.error(`[inference] ${line}`);
      }
    });

    child.once("spawn", () => {
      if (this.child !== child) return;
      this.currentRestartDelayMs = this.restartDelayMs;
      this.publisher.setWorkerState("running", { pid: child.pid });
    });
    child.once("error", (error) => {
      if (this.child !== child) return;
      this.child = null;
      this.handleFailure(error);
    });
    child.once("close", (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      if (this.stopping) return;

      const detail = this.stderrTail.at(-1);
      const exitDescription = signal
        ? `Inference worker stopped with ${signal}.`
        : `Inference worker exited with code ${code ?? "unknown"}.`;
      this.scheduleRestart(
        detail ? `${exitDescription} ${detail}` : exitDescription,
      );
    });
  }

  handleFailure(error) {
    const message =
      error?.code === "ENOENT"
        ? `Python command "${this.command}" was not found. Run npm run setup:python.`
        : error instanceof Error
          ? error.message
          : "The inference worker could not be started.";
    this.scheduleRestart(message);
  }

  scheduleRestart(error) {
    if (this.stopping || this.restartTimer) return;

    this.publisher.setWorkerState("restarting", { error });
    const delay = this.currentRestartDelayMs;
    this.currentRestartDelayMs = Math.min(
      this.currentRestartDelayMs * 2,
      this.maxRestartDelayMs,
    );
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.start();
    }, delay);
    this.restartTimer.unref?.();
  }

  restart() {
    clearTimeout(this.restartTimer);
    this.restartTimer = null;

    const child = this.child;
    this.child = null;
    if (child && !child.killed) child.kill("SIGTERM");

    this.stopping = false;
    this.currentRestartDelayMs = this.restartDelayMs;
    this.start();
  }

  pause() {
    this.stopping = true;
    clearTimeout(this.restartTimer);
    this.restartTimer = null;

    const child = this.child;
    this.child = null;
    if (child && !child.killed) child.kill("SIGTERM");
    this.publisher.setWorkerState("scheduled");
  }

  stop() {
    this.stopping = true;
    clearTimeout(this.restartTimer);
    this.restartTimer = null;

    const child = this.child;
    this.child = null;
    if (child && !child.killed) child.kill("SIGTERM");
    this.publisher.stop();
  }
}
