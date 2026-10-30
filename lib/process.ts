import { spawn } from "node:child_process";
import { closeSync, openSync, readFileSync, writeSync } from "node:fs";
import { createInterface } from "node:readline";

interface ProcessOptions {
  cwd: string;
  log: string;
  timeoutMs: number;
  input?: string;
  progress?: {
    label: string;
    formatLine?: (line: string) => string[];
    intervalMs?: number;
  };
}

export function run(command: string, args: string[], options: ProcessOptions): Promise<string> {
  const output = openSync(`${options.log}.stdout.log`, "w", 0o600);
  const errors = openSync(`${options.log}.stderr.log`, "w", 0o600);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, GH_PROMPT_DISABLED: "1" },
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    let failure: Error | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    const stop = (message: string, exitCode = 1) => {
      failure ??= Object.assign(new Error(message), { exitCode });
      signal("SIGTERM");
      killTimer ??= setTimeout(() => signal("SIGKILL"), 5000);
    };
    const signal = (name: NodeJS.Signals) => {
      if (!child.pid) return;
      try {
        if (process.platform === "win32") child.kill(name);
        else process.kill(-child.pid, name);
      } catch (error) {
        const failureToSignal = error as NodeJS.ErrnoException;
        if (failureToSignal.code !== "ESRCH") failure ??= failureToSignal;
      }
    };
    const interrupt = () => stop("Interrupted", 130);
    const terminate = () => stop("Terminated", 143);
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", terminate);
    const timer = setTimeout(() => stop(`${command} timed out`), options.timeoutMs);
    const started = Date.now();
    let lastOutput = started;
    const report = (message: string) => process.stderr.write(`[${options.progress!.label}] ${message}\n`);
    const heartbeat = options.progress && setInterval(() => {
      const now = Date.now();
      report(`Still running; elapsed ${duration(now - started)}; last output ${duration(now - lastOutput)} ago; timeout in ${duration(Math.max(0, options.timeoutMs - (now - started)))}.`);
    }, options.progress.intervalMs ?? 30000);
    const lines = options.progress?.formatLine ? createInterface({ input: child.stdout, crlfDelay: Infinity }) : undefined;
    lines?.on("line", (line) => {
      for (const message of options.progress!.formatLine!(line)) report(message);
    });
    child.stdout.on("data", (chunk) => {
      lastOutput = Date.now();
      writeSync(output, chunk);
    });
    child.stderr.on("data", (chunk) => {
      lastOutput = Date.now();
      writeSync(errors, chunk);
      if (options.progress) process.stderr.write(chunk);
    });
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") stop(error.message);
    });
    child.on("error", (error) => { failure ??= error; });
    child.on("close", (code, childSignal) => {
      if (failure) signal("SIGKILL");
      clearTimeout(timer);
      clearTimeout(killTimer);
      clearInterval(heartbeat);
      lines?.close();
      process.removeListener("SIGINT", interrupt);
      process.removeListener("SIGTERM", terminate);
      closeSync(output);
      closeSync(errors);
      if (failure) return reject(failure);
      if (code !== 0) return reject(new Error(`${command} exited ${code ?? childSignal}; see ${options.log}.stderr.log`));
      resolve(readFileSync(`${options.log}.stdout.log`, "utf8"));
    });
    child.stdin.end(options.input ?? "");
  });
}

function duration(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1000);
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
}
