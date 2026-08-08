import { test } from "node:test";
import assert from "node:assert/strict";
import { detectWsl, resolveOpenLaunch, openLocalFile } from "../src/reasoning/open.js";

test("resolveOpenLaunch uses open on darwin", () => {
  assert.deepEqual(resolveOpenLaunch("/tmp/review.html", { platform: "darwin", isWsl: false }), {
    command: "open",
    args: ["/tmp/review.html"],
  });
});

test("resolveOpenLaunch uses cmd start on win32", () => {
  assert.deepEqual(resolveOpenLaunch("C:/tmp/review.html", { platform: "win32", isWsl: false }), {
    command: "cmd",
    args: ["/c", "start", "", "C:/tmp/review.html"],
  });
});

test("resolveOpenLaunch uses xdg-open on linux non-WSL", () => {
  assert.deepEqual(resolveOpenLaunch("/tmp/review.html", { platform: "linux", isWsl: false }), {
    command: "xdg-open",
    args: ["/tmp/review.html"],
  });
});

test("resolveOpenLaunch marks linux WSL as requiring a windows path", () => {
  assert.deepEqual(resolveOpenLaunch("/tmp/review.html", { platform: "linux", isWsl: true }), {
    command: "cmd.exe",
    args: ["/c", "start", "", "/tmp/review.html"],
    needsWindowsPath: true,
  });
});

test("openLocalFile launches directly for non-WSL platforms", async () => {
  const launched = [];
  const result = await openLocalFile("/tmp/review.html", {
    platform: "linux",
    isWsl: false,
    launch: async (command, args) => {
      launched.push({ command, args });
    },
  });

  assert.deepEqual(launched, [{ command: "xdg-open", args: ["/tmp/review.html"] }]);
  assert.deepEqual(result, { command: "xdg-open", args: ["/tmp/review.html"] });
});

test("openLocalFile translates path and launches cmd.exe in WSL mode", async () => {
  const launched = [];
  const translated = [];
  const result = await openLocalFile("/home/me/review.html", {
    platform: "linux",
    isWsl: true,
    translateToWindowsPath: async (filePath) => {
      translated.push(filePath);
      return "C:\\Users\\me\\review.html";
    },
    launch: async (command, args) => {
      launched.push({ command, args });
    },
  });

  assert.deepEqual(translated, ["/home/me/review.html"]);
  assert.deepEqual(launched, [{
    command: "cmd.exe",
    args: ["/c", "start", "", "C:\\Users\\me\\review.html"],
  }]);
  assert.deepEqual(result, {
    command: "cmd.exe",
    args: ["/c", "start", "", "C:\\Users\\me\\review.html"],
  });
});

test("openLocalFile falls back to canonical cmd.exe path when cmd.exe is missing on PATH", async () => {
  const launched = [];
  const result = await openLocalFile("/home/me/review.html", {
    platform: "linux",
    isWsl: true,
    translateToWindowsPath: async () => "C:\\Users\\me\\review.html",
    launch: async (command, args) => {
      launched.push({ command, args });
      if (command === "cmd.exe") {
        const error = new Error("not found");
        error.code = "ENOENT";
        throw error;
      }
    },
  });

  assert.deepEqual(launched, [
    { command: "cmd.exe", args: ["/c", "start", "", "C:\\Users\\me\\review.html"] },
    { command: "/mnt/c/Windows/System32/cmd.exe", args: ["/c", "start", "", "C:\\Users\\me\\review.html"] },
  ]);
  assert.deepEqual(result, {
    command: "/mnt/c/Windows/System32/cmd.exe",
    args: ["/c", "start", "", "C:\\Users\\me\\review.html"],
  });
});

test("detectWsl returns a boolean", () => {
  assert.equal(typeof detectWsl(), "boolean");
});
