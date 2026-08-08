#!/usr/bin/env node
import { serve } from "./http.js";

function numberFromEnv(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? n : fallback;
}

async function main() {
  const host = process.env.WAYCONTEXT_SERVICE_HOST || "127.0.0.1";
  const port = numberFromEnv("WAYCONTEXT_SERVICE_PORT", 4747);
  const { server } = await serve({ host, port });

  const stop = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };

  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

main().catch(() => {
  process.exit(1);
});
