import { test } from "node:test";
import assert from "node:assert/strict";
import { ConfigError, loadConfig } from "../src/config.js";

const ENV = { INVOICE_NINJA_URL: "https://env.example.ch/", INVOICE_NINJA_TOKEN: "env-token" };

test("address and token come from the environment", () => {
  const cfg = loadConfig(ENV);
  assert.equal(cfg.baseUrl, "https://env.example.ch");
  assert.equal(cfg.token, "env-token");
  assert.equal(cfg.allowWrites, false);
  assert.equal(cfg.safeMode, false);
});

test("an internal http address is accepted from the environment, /api/v1 is dropped", () => {
  assert.equal(loadConfig({ ...ENV, INVOICE_NINJA_URL: "http://nginx/api/v1/" }).baseUrl, "http://nginx");
});

test("missing environment values fail", () => {
  assert.throws(() => loadConfig({}), (e: unknown) => e instanceof ConfigError && e.code === "missing_credentials");
  assert.throws(() => loadConfig({ INVOICE_NINJA_URL: "https://x.ch" }), /INVOICE_NINJA_TOKEN/);
});

test("the upstream request-credentials flag does not replace the environment", () => {
  const cfg = loadConfig({ ...ENV, INVOICE_NINJA_REQUIRE_REQUEST_CREDENTIALS: "true" });
  assert.equal(cfg.baseUrl, "https://env.example.ch");
  assert.equal(cfg.token, "env-token");
});

test("safe mode and the deny list come from the environment", () => {
  const cfg = loadConfig({ ...ENV, INVOICE_NINJA_SAFE_MODE: "true", INVOICE_NINJA_DISABLED_TOOLS: "in_a, in_b" });
  assert.equal(cfg.safeMode, true);
  assert.deepEqual([...cfg.disabledTools], ["in_a", "in_b"]);
});
