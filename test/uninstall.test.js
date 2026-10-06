import { test } from "node:test";
import assert from "node:assert/strict";
import { stripUpdateCron, UPDATE_CRON_MARKER } from "../src/uninstall.js";

test("stripUpdateCron removes only the marker-tagged line", () => {
  const before = [
    "0 3 * * * /usr/bin/backup",
    `*/5 * * * * "/opt/waycontext/check-update.sh" ${UPDATE_CRON_MARKER}`,
    "@reboot /usr/bin/other",
    "",
  ].join("\n");
  const { content, removed } = stripUpdateCron(before);
  assert.equal(removed, true);
  assert.equal(content, "0 3 * * * /usr/bin/backup\n@reboot /usr/bin/other\n");
});

test("stripUpdateCron reports nothing removed when the marker is absent", () => {
  const before = "0 3 * * * /usr/bin/backup\n";
  const { content, removed } = stripUpdateCron(before);
  assert.equal(removed, false);
  assert.equal(content, before);
});

test("stripUpdateCron leaves an empty crontab when ours was the only entry", () => {
  const { content, removed } = stripUpdateCron(`*/5 * * * * x ${UPDATE_CRON_MARKER}\n`);
  assert.equal(removed, true);
  assert.equal(content, "");
});
