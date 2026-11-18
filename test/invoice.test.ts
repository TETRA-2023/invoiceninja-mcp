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
      if (path.startsWith("/api/v1/invoices") || path.startsWith("/api/v1/quotes")) {
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

test("in_create_quote sends po_number, terms, footer, notes, document tax and due_date", async () => {
  const c = await connect();
  const args = { ...draft, date: "2026-11-18", due_date: "2026-12-18", footer: "Footer", private_notes: "Internal" };
  const r = (await c.callTool({ name: "in_create_quote", arguments: args })) as { isError?: boolean };
  assert.notEqual(r.isError, true);
  const sent = bodies.at(-1)!;
  assert.equal(sent.method, "POST");
  assert.equal(sent.path, "/api/v1/quotes");
  assert.equal(sent.body.po_number, "REF-1");
  assert.equal(sent.body.terms, "Payment terms");
  assert.equal(sent.body.footer, "Footer");
  assert.equal(sent.body.private_notes, "Internal");
  assert.equal(sent.body.public_notes, "Note");
  assert.equal(sent.body.tax_name1, "VAT");
  assert.equal(sent.body.tax_rate1, 20);
  assert.equal(sent.body.date, "2026-11-18");
  assert.equal(sent.body.due_date, "2026-12-18");
  const lines = sent.body.line_items as Record<string, unknown>[];
  assert.equal(lines[0]!.custom_value1, "EN > FR");
  for (const l of lines) assert.equal(l.tax_rate1, undefined);
  await c.close();
});

test("in_create_quote maps valid_until onto due_date", async () => {
  const c = await connect();
  const r = (await c.callTool({ name: "in_create_quote", arguments: { ...draft, valid_until: "2026-12-31" } })) as { isError?: boolean };
  assert.notEqual(r.isError, true);
  const sent = bodies.at(-1)!;
  assert.equal(sent.body.due_date, "2026-12-31");
  assert.equal("valid_until" in sent.body, false);
  await c.close();
});

test("in_update_quote sends a sparse PUT and never a status", async () => {
  const c = await connect();
  const r = (await c.callTool({
    name: "in_update_quote",
    arguments: { id: "q1", po_number: "REF-2", due_date: "2027-01-15", tax_name1: "VAT", tax_rate1: 20, status_id: "2" },
  })) as { isError?: boolean };
  assert.notEqual(r.isError, true);
  const sent = bodies.at(-1)!;
  assert.equal(sent.method, "PUT");
  assert.equal(sent.path, "/api/v1/quotes/q1");
  assert.equal(sent.body.po_number, "REF-2");
  assert.equal(sent.body.due_date, "2027-01-15");
  assert.equal(sent.body.tax_rate1, 20);
  assert.equal("status_id" in sent.body, false);
  assert.equal("id" in sent.body, false);
  assert.equal("line_items" in sent.body, false);
  await c.close();
});

test("safe mode keeps in_quote_action out and in_update_quote in", async () => {
  const c = await connect();
  const names = (await c.listTools()).tools.map((t) => t.name);
  assert.ok(names.includes("in_update_quote"));
  assert.ok(!names.includes("in_quote_action"));
  await c.close();
});
