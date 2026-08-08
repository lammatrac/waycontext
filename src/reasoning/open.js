import { spawn, execFile } from "node:child_process";
import fs from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Linux-only probe: true when running inside WSL. */
export function detectWsl() {
  if (process.platform !== "linux") return false;
  if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) return true;
  try {
    return /microsoft/i.test(fs.readFileSync("/proc/version", "utf8"));
  } catch {
    return false;
  }
}

/** Determine platform command and arguments for opening a local file. */
export function resolveOpenLaunch(filePath, { platform = process.platform, isWsl = detectWsl() } = {}) {
  if (platform === "darwin") {
    return { command: "open", args: [filePath] };
  }
  if (platform === "win32") {
    return { command: "cmd", args: ["/c", "start", "", filePath] };
  }
  if (platform === "linux" && isWsl) {
    return {
      command: "cmd.exe",
      args: ["/c", "start", "", filePath],
      needsWindowsPath: true,
    };
  }
  return { command: "xdg-open", args: [filePath] };
}

async function toWindowsPath(filePath) {
  const { stdout } = await execFileAsync("wslpath", ["-w", filePath]);
  return stdout.trim();
}

async function launchDetached(command, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

/**
 * Fire-and-forget open of a local file via the platform default app.
 * Resolves once process spawn succeeds; rejects immediately when launch fails.
 */
export async function openLocalFile(filePath, {
  platform = process.platform,
  isWsl = detectWsl(),
  translateToWindowsPath = toWindowsPath,
  launch = launchDetached,
} = {}) {
  const launcher = resolveOpenLaunch(filePath, { platform, isWsl });

  if (!launcher.needsWindowsPath) {
    await launch(launcher.command, launcher.args);
    return { command: launcher.command, args: launcher.args };
  }

  const windowsPath = await translateToWindowsPath(filePath);
  const args = ["/c", "start", "", windowsPath];
  try {
    await launch("cmd.exe", args);
    return { command: "cmd.exe", args };
  } catch (e) {
    // Some WSL setups do not expose cmd.exe on PATH; use the canonical path.
    if (e && e.code === "ENOENT") {
      const fallback = "/mnt/c/Windows/System32/cmd.exe";
      await launch(fallback, args);
      return { command: fallback, args };
    }
    throw e;
  }
}
