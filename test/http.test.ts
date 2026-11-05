import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createHandler } from "../src/httpApp.js";

const BEARER = "test-bearer";
const ENV_TOKEN = "token-env";

/** A fake Invoice Ninja that records every token it receives. */
async function fakeNinja(company: string): Promise<{ server: Server; url: string; seen: string[] }> {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    const token = String(req.headers["x-api-token"] ?? "");
    seen.push(token);
    res.setHeader("Content-Type", "application/json");
    if (token !== ENV_TOKEN) return res.writeHead(401).end(JSON.stringify({ message: "Invalid token" }));
    const path = (req.url ?? "").split("?")[0];
    if (req.method === "GET" && path === "/api/v1/clients") return res.end(JSON.stringify({ data: [] }));
    if (req.method === "POST" && path === "/api/v1/companies/current") return res.end(JSON.stringify({ data: { id: "c1", settings: { name: company } } }));
    res.writeHead(404).end(JSON.stringify({ message: "not here" }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

let ninja: Awaited<ReturnType<typeof fakeNinja>>;
/** Another host named in a request header: it must never receive anything. */
let elsewhere: Awaited<ReturnType<typeof fakeNinja>>;
const servers: Server[] = [];

before(async () => {
  ninja = await fakeNinja("Env Company");
  elsewhere = await fakeNinja("Elsewhere");
});

after(async () => {
  for (const s of [...servers, ninja.server, elsewhere.server]) await new Promise<void>((r) => s.close(() => r()));
});

const baseEnv = () => ({ INVOICE_NINJA_URL: ninja.url, INVOICE_NINJA_TOKEN: ENV_TOKEN });

async function mcpServer(env: NodeJS.ProcessEnv, bearer: string | undefined = BEARER): Promise<string> {
  const s = createServer(createHandler({ bearer, env }));
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  servers.push(s);
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}/mcp`;
}

async function connect(endpoint: string, headers: Record<string, string> = { Authorization: `Bearer ${BEARER}` }) {
  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(endpoint), { requestInit: { headers } }));
  return client;
}

const pingText = async (client: Client) => {
  const r = (await client.callTool({ name: "in_ping", arguments: {} })) as { content: { text: string }[]; isError?: boolean };
  return { text: r.content[0]!.text, isError: r.isError === true };
};

const toolNames = async (env: NodeJS.ProcessEnv) => {
  const c = await connect(await mcpServer(env));
  const names = (await c.listTools()).tools.map((t) => t.name);
  await c.close();
  return names;
};

test("the environment's instance and token are used", async () => {
  const c = await connect(await mcpServer(baseEnv()));
  const ping = JSON.parse((await pingText(c)).text);
  assert.equal(ping.company.name, "Env Company");
  assert.equal(ping.instance, ninja.url);
  await c.close();
});

test("credential headers are ignored: the token never leaves for another host", async () => {
  const endpoint = await mcpServer(baseEnv());
  const urlOnly = { Authorization: `Bearer ${BEARER}`, "X-Invoice-Ninja-Url": elsewhere.url };
  const all = { ...urlOnly, "X-Invoice-Ninja-Token": "token-other", "X-Invoice-Ninja-Safe-Mode": "false" };
  for (const headers of [urlOnly, all]) {
    const c = await connect(endpoint, headers);
    assert.equal(JSON.parse((await pingText(c)).text).company.name, "Env Company");
    await c.close();
  }
  assert.deepEqual(elsewhere.seen, []);
  assert.ok(!ninja.seen.includes("token-other"));
});

test("a wrong or missing bearer is refused", async () => {
  const endpoint = await mcpServer(baseEnv());
  for (const authorization of ["Bearer wrong", "Bearer test-bearerX", "", `bearer ${BEARER}`]) {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: authorization, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.equal(res.status, 401, authorization);
  }
});

test("/healthz is open, other paths are 404", async () => {
  const endpoint = await mcpServer(baseEnv());
  assert.equal((await fetch(endpoint.replace("/mcp", "/healthz"))).status, 200);
  assert.equal((await fetch(endpoint.replace("/mcp", "/other"), { method: "POST" })).status, 404);
});

test("in_upload_document does not exist, whatever the mode", async () => {
  const full = await toolNames({ ...baseEnv(), INVOICE_NINJA_ALLOW_WRITES: "true" });
  assert.ok(full.includes("in_create_invoice"));
  assert.ok(!full.includes("in_upload_document"));
});

test("read-only by default; safe mode leaves out sending and payments", async () => {
  const ro = await toolNames(baseEnv());
  assert.ok(ro.includes("in_list_invoices") && !ro.some((n) => n.startsWith("in_create_")));
  const safe = await toolNames({ ...baseEnv(), INVOICE_NINJA_ALLOW_WRITES: "true", INVOICE_NINJA_SAFE_MODE: "true" });
  assert.ok(safe.includes("in_create_invoice"));
  for (const n of ["in_invoice_action", "in_quote_action", "in_create_payment"]) assert.ok(!safe.includes(n), n);
});

test("a refused token reaches the result without the token, and nothing is logged", async () => {
  const secret = "token-nobody-knows-1234";
  const logged: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
    logged.push(String(chunk));
    return (write as (...a: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stderr.write;
  try {
    const c = await connect(await mcpServer({ INVOICE_NINJA_URL: ninja.url, INVOICE_NINJA_TOKEN: secret }));
    const r = await pingText(c);
    await c.close();
    assert.equal(r.isError, true);
    assert.match(r.text, /401/);
    assert.ok(!r.text.includes(secret));
  } finally {
    process.stderr.write = write;
  }
  assert.ok(!logged.join("").includes(secret));
});
