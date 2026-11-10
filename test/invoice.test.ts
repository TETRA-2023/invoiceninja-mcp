import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createHandler } from "../src/httpApp.js";

const BEARER = "test-bearer";
const TOKEN = "token-env";

/** A fake Invoice Ninja that records the body of every invoice write. */
let ninja: Server;
let ninjaUrl = "";
const bodies: { method: string; path: string; body: Record<string, unknown> }[] = [];
const servers: Server[] = [];

before(async () => {
  ninja = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      const path = (req.url ?? "").split("?")[0]!;
      if (path.startsWith("/api/v1/invoices")) {
        const body = raw ? JSON.parse(raw) : {};
        bodies.push({ method: req.method ?? "", path, body });
        return res.end(JSON.stringify({ data: { id: "inv1", ...body } }));
      }
      res.writeHead(404).end(JSON.stringify({ message: "not here" }));
    });
  });
  await new Promise<void>((r) => ninja.listen(0, "127.0.0.1", r));
  ninjaUrl = `http://127.0.0.1:${(ninja.address() as AddressInfo).port}`;
});

after(async () => {
  for (const s of [...servers, ninja]) await new Promise<void>((r) => s.close(() => r()));
});

async function connect() {
  const env = {
    INVOICE_NINJA_URL: ninjaUrl,
    INVOICE_NINJA_TOKEN: TOKEN,
    INVOICE_NINJA_ALLOW_WRITES: "true",
    INVOICE_NINJA_SAFE_MODE: "true",
  };
  const s = createServer(createHandler({ bearer: BEARER, env }));
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  servers.push(s);
  const client = new Client({ name: "test", version: "0" });
  const url = new URL(`http://127.0.0.1:${(s.address() as AddressInfo).port}/mcp`);
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${BEARER}` } } }));
  return client;
}

const draft = {
  client_id: "client1",
  po_number: "REF-1",
  terms: "Payment terms",
  public_notes: "Note",
  tax_name1: "VAT",
  tax_rate1: 20,
  line_items: [
    { product_key: "Translation", cost: 0.1, quantity: 1000, custom_value1: "EN > FR" },
    { product_key: "Review", cost: 100, quantity: 1 },
  ],
};

test("in_create_invoice sends the document tax and the line custom values, and no line tax", async () => {
  const c = await connect();
  const r = (await c.callTool({ name: "in_create_invoice", arguments: draft })) as { isError?: boolean };
  assert.notEqual(r.isError, true);
  const sent = bodies.at(-1)!;
  assert.equal(sent.method, "POST");
  assert.equal(sent.body.tax_name1, "VAT");
  assert.equal(sent.body.tax_rate1, 20);
  assert.equal(sent.body.po_number, "REF-1");
  assert.equal(sent.body.terms, "Payment terms");
  assert.equal(sent.body.public_notes, "Note");
  const lines = sent.body.line_items as Record<string, unknown>[];
  assert.equal(lines[0]!.custom_value1, "EN > FR");
  for (const l of lines) assert.equal(l.tax_rate1, undefined);
  await c.close();
});

test("in_update_invoice sends the document tax", async () => {
  const c = await connect();
  const r = (await c.callTool({ name: "in_update_invoice", arguments: { id: "inv1", tax_name1: "VAT", tax_rate1: 20 } })) as { isError?: boolean };
  assert.notEqual(r.isError, true);
  const sent = bodies.at(-1)!;
  assert.equal(sent.method, "PUT");
  assert.equal(sent.body.tax_name1, "VAT");
  assert.equal(sent.body.tax_rate1, 20);
  await c.close();
});

test("the line custom value is declared in the tool schema", async () => {
  const c = await connect();
  const tool = (await c.listTools()).tools.find((t) => t.name === "in_create_invoice")!;
  const schema = JSON.stringify(tool.inputSchema);
  assert.match(schema, /"tax_rate1"/);
  assert.match(schema, /"custom_value1"/);
  await c.close();
});
