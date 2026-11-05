/**
 * The streamable-HTTP request handler, separate from ./http.ts so tests can run it on a port of their own.
 *
 * Stateless mode: each POST /mcp builds a fresh server and transport from the environment. Request headers never
 * change the configuration (TETRA fork, see ./config.ts).
 */
import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ConfigError } from "./config.js";
import { createServer } from "./server.js";

export interface HttpOptions {
  /** MCP_BEARER_TOKEN; without it the endpoint is open. */
  bearer?: string;
  env?: NodeJS.ProcessEnv;
  path?: string;
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

/** Constant-time comparison of the Authorization header with the expected one. */
function authorized(header: string | undefined, expected: Buffer): boolean {
  const got = Buffer.from(header ?? "", "utf8");
  return got.length === expected.length && timingSafeEqual(got, expected);
}

export function createHandler(opts: HttpOptions = {}): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const env = opts.env ?? process.env;
  const bearer = opts.bearer?.trim() || undefined;
  const expected = bearer ? Buffer.from(`Bearer ${bearer}`, "utf8") : undefined;
  const path = opts.path ?? "/mcp";

  return async (req, res) => {
    if (req.method === "GET" && req.url === "/healthz") return json(res, 200, { status: "ok" });

    const url = (req.url ?? "").split("?")[0];
    if (url !== path) return json(res, 404, { error: "Not found" });

    if (expected && !authorized(req.headers.authorization, expected)) return json(res, 401, { error: "Unauthorized" });

    if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" }, { Allow: "POST" });

    let server: ReturnType<typeof createServer>;
    try {
      server = createServer(env);
    } catch (err) {
      if (err instanceof ConfigError) return json(res, 500, { error: err.code });
      return json(res, 500, { error: "server_error" });
    }

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      transport.close();
      server.close();
    });

    try {
      const body = await readBody(req);
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      if (!res.headersSent) json(res, 400, { error: err instanceof Error ? err.message : "Bad request" });
    }
  };
}
