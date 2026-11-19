import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createHandler } from "../src/httpApp.js";

const BEARER = "test-bearer";

type Row = Record<string, unknown>;

/** A fake Invoice Ninja holding a few expenses; records every write. */
let ninja: Server;
let ninjaUrl = "";
const writes: { method: string; path: string; body: Row }[] = [];
const queries: URLSearchParams[] = [];
const servers: Server[] = [];

const doc = { id: "doc1", name: "receipt.pdf" };
let expenses: Row[] = [];

beforeEach(() => {
  writes.length = 0;
  queries.length = 0;
  expenses = [
    { id: "e1", number: "1CQ9AUGA-0009", vendor_id: "v1", amount: 10, currency_id: "3", is_deleted: false, archived_at: 0, updated_at: 5, payment_date: "", documents: [doc] },
    { id: "e2", number: "1cq9auga-0010", vendor_id: "v1", amount: 10, currency_id: "3", is_deleted: false, archived_at: 0, updated_at: 5, payment_date: "", documents: [] },
    { id: "e3", number: "OLD-1", vendor_id: "v2", amount: 10, currency_id: "1", is_deleted: true, archived_at: 9, updated_at: 9, payment_date: "", documents: [] },
    { id: "e4", number: "ARCH-1", vendor_id: "v2", amount: 10, currency_id: "1", is_deleted: false, archived_at: 9, updated_at: 9, payment_date: "", documents: [] },
  ];
});

before(async () => {
  ninja = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      const url = new URL(req.url ?? "/", "http://x");
      const path = url.pathname;
      const body = raw ? (JSON.parse(raw) as Row) : {};
      if (path === "/api/v1/expenses" && req.method === "GET") {
        queries.push(url.searchParams);
        const f = (url.searchParams.get("filter") ?? "").toLowerCase();
        const per = Number(url.searchParams.get("per_page") ?? 20);
        const page = Number(url.searchParams.get("page") ?? 1);
        const hits = expenses.filter((e) => `${e.number} ${e.public_notes ?? ""}`.toLowerCase().includes(f));
        return res.end(JSON.stringify({ data: hits.slice((page - 1) * per, page * per) }));
      }
      if (path === "/api/v1/expenses" && req.method === "POST") {
        writes.push({ method: "POST", path, body });
        return res.end(JSON.stringify({ data: { id: "new", ...body } }));
      }
      const m = path.match(/^\/api\/v1\/expenses\/(\w+)$/);
      if (m) {
        const e = expenses.find((x) => x.id === m[1]);
        if (!e) return res.writeHead(404).end(JSON.stringify({ message: "not found" }));
        if (req.method === "GET") return res.end(JSON.stringify({ data: e }));
        writes.push({ method: req.method ?? "", path, body });
        return res.end(JSON.stringify({ data: { ...e, ...body } }));
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

async function connect(extraEnv: Record<string, string> = {}) {
  const env = {
    ...extraEnv,
    INVOICE_NINJA_URL: ninjaUrl,
    INVOICE_NINJA_TOKEN: "token-env",
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

type Result = { isError?: boolean; content: { text: string }[] };
const call = async (c: Client, name: string, args: Row) => (await c.callTool({ name, arguments: args })) as Result;
const json = (r: Result) => JSON.parse(r.content[0]!.text) as Row;

test("safe mode exposes the expense read and write tools", async () => {
  const c = await connect();
  const names = (await c.listTools()).tools.map((t) => t.name);
  for (const n of ["in_list_expenses", "in_get_expense", "in_create_expense", "in_update_expense"]) assert.ok(names.includes(n), n);
  await c.close();
});

test("in_create_expense sends number, dates and taxes; vendor_id is optional, amount is not", async () => {
  const c = await connect();
  const args = {
    vendor_id: "v1", number: "INV166891906", amount: 4, date: "2026-11-16", payment_date: "2026-11-16",
    currency_id: "3", tax_name1: "TVA", tax_rate1: 20, private_notes: "p",
  };
  const r = await call(c, "in_create_expense", args);
  assert.notEqual(r.isError, true, r.content[0]!.text);
  const sent = writes.at(-1)!;
  assert.equal(sent.method, "POST");
  assert.deepEqual(sent.body, args);
  const noVendor = await call(c, "in_create_expense", { amount: 12.5, private_notes: "bank fee" });
  assert.notEqual(noVendor.isError, true, noVendor.content[0]!.text);
  const noAmount = await call(c, "in_create_expense", { vendor_id: "v1" });
  assert.equal(noAmount.isError, true);
  await c.close();
});

test("in_create_expense refuses a number already taken, case-insensitively and in any state", async () => {
  const c = await connect();
  for (const number of ["1cq9auga-0009", "OLD-1", "arch-1"]) {
    const r = await call(c, "in_create_expense", { vendor_id: "v1", amount: 1, number });
    assert.equal(r.isError, true, number);
    assert.match(r.content[0]!.text, /already exists/);
  }
  assert.equal(writes.length, 0);
  assert.equal(queries.at(-1)!.get("status"), "active,archived,deleted");
  const forced = await call(c, "in_create_expense", { vendor_id: "v1", amount: 1, number: "OLD-1", allow_duplicate: true });
  assert.notEqual(forced.isError, true);
  assert.equal(writes.length, 1);
  await c.close();
});

test("in_update_expense changes the number, allows a case fix on its own number, refuses another's", async () => {
  const c = await connect();
  const own = await call(c, "in_update_expense", { id: "e2", number: "1CQ9AUGA-0010" });
  assert.notEqual(own.isError, true, own.content[0]!.text);
  assert.equal(writes.at(-1)!.body.number, "1CQ9AUGA-0010");
  assert.equal(writes.at(-1)!.body.currency_id, "3"); // currency preserved
  const clash = await call(c, "in_update_expense", { id: "e2", number: "1cq9auga-0009" });
  assert.equal(clash.isError, true);
  assert.equal(writes.length, 1);
  await c.close();
});

test("in_list_expenses reports state, documents_count, payment_date and updated_at", async () => {
  const c = await connect();
  const out = json(await call(c, "in_list_expenses", { status: "all" }));
  const rows = out.expenses as Row[];
  const by = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.equal(by.e1!.state, "active");
  assert.equal(by.e1!.documents_count, 1);
  assert.equal(by.e3!.state, "deleted");
  assert.equal(by.e4!.state, "archived");
  assert.ok("payment_date" in by.e1! && "updated_at" in by.e1! && "is_deleted" in by.e1!);
  assert.equal("documents" in by.e1!, false);
  await c.close();
});

test("in_get_expense returns the full record with documents and state", async () => {
  const c = await connect();
  const e = json(await call(c, "in_get_expense", { id: "e3" }));
  assert.equal(e.state, "deleted");
  assert.deepEqual(e.documents, []);
  const e1 = json(await call(c, "in_get_expense", { id: "e1" }));
  assert.deepEqual(e1.documents, [doc]);
  await c.close();
});

test("the duplicate check reads every page of the search", async () => {
  // 25 rows whose notes contain the number, then the exact match last; MAX_PER_PAGE=10 forces three pages.
  for (let i = 0; i < 25; i++) expenses.unshift({ id: `n${i}`, number: `N${i}`, public_notes: "ref 77", is_deleted: false, archived_at: 0 });
  expenses.push({ id: "x77", number: "77", vendor_id: "v1", is_deleted: false, archived_at: 0 });
  const c = await connect({ INVOICE_NINJA_MAX_PER_PAGE: "10" });
  const r = await call(c, "in_create_expense", { vendor_id: "v1", amount: 1, number: "77" });
  assert.equal(r.isError, true);
  assert.match(r.content[0]!.text, /x77/);
  assert.equal(writes.length, 0);
  await c.close();
});

test("an empty or blank number is rejected, never sent", async () => {
  const c = await connect();
  for (const number of ["", "   "]) {
    assert.equal((await call(c, "in_update_expense", { id: "e1", number })).isError, true, JSON.stringify(number));
    assert.equal((await call(c, "in_create_expense", { vendor_id: "v1", amount: 1, number })).isError, true, JSON.stringify(number));
  }
  assert.equal(writes.length, 0);
  const trimmed = await call(c, "in_create_expense", { vendor_id: "v1", amount: 1, number: "  NEW-1 " });
  assert.notEqual(trimmed.isError, true);
  assert.equal(writes.at(-1)!.body.number, "NEW-1");
  await c.close();
});
