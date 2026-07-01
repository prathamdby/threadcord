import { serve } from "@hono/node-server";
import { createApp } from "./app.js";

const { app, config } = await createApp();

serve({
  fetch: app.fetch,
  port: config.PORT,
});

console.log(`[threadcord] HTTP server listening on port ${config.PORT}`);
