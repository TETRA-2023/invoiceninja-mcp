#!/usr/bin/env node
/**
 * Streamable-HTTP transport entry point — for running the server remotely behind a gateway or reverse proxy.
 * Protect the endpoint with MCP_BEARER_TOKEN; see ./httpApp.ts.
 */
import { createServer as createHttpServer } from "node:http";
import { loadConfig } from "./config.js";
import { createHandler } from "./httpApp.js";

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? "127.0.0.1";
const BEARER = process.env.MCP_BEARER_TOKEN?.trim();

// Fail at start, not on the first request, when the address or token is missing.
try {
  loadConfig();
} catch (err) {
  process.stderr.write(`invoiceninja-mcp: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}

// TETRA fork: an endpoint reachable beyond the loopback must have a bearer.
if (!BEARER && !["127.0.0.1", "localhost", "::1"].includes(HOST)) {
  process.stderr.write(`invoiceninja-mcp: MCP_BEARER_TOKEN is required when listening on ${HOST}.\n`);
  process.exit(1);
}

const httpServer = createHttpServer(createHandler({ bearer: BEARER }));

httpServer.listen(PORT, HOST, () => {
  process.stderr.write(
    `invoiceninja-mcp: streamable-http on http://${HOST}:${PORT}/mcp` +
      `${BEARER ? " (bearer auth on)" : " (NO AUTH — set MCP_BEARER_TOKEN!)"}\n`,
  );
});
