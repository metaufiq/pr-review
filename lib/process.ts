import { spawn } from "node:child_process";
import { closeSync, openSync, readFileSync, writeSync } from "node:fs";

interface ProcessOptions {
  cwd: string;
  log: string;
  timeoutMs: number;
  input?: string;
  progress?: boolean;
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
    child.stdout.on("data", (chunk) => writeSync(output, chunk));
    child.stderr.on("data", (chunk) => {
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
