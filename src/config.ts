/**
 * Runtime configuration, loaded from environment variables.
 *
 * Sovereignty note: this server talks ONLY to your Invoice Ninja instance.
 * Point INVOICE_NINJA_URL at your self-hosted box (e.g. Exoscale Zürich) and
 * no data ever transits a third-party SaaS bridge.
 */

export interface Config {
  /** Base URL of the Invoice Ninja instance, WITHOUT a trailing /api/v1. */
  baseUrl: string;
  /** Company API token from Settings > Account Management > Integrations > API Tokens. */
  token: string;
  /** Optional X-Api-Secret (only relevant if api_secret is set in your .env on the IN side). */
  secret?: string;
  /** When false (default), all write/mutating tools are disabled. Opt-in only. */
  allowWrites: boolean;
  /**
   * Safe mode: writes are on, but nothing is sent or settled. Leaves out in_invoice_action, in_quote_action and
   * in_create_payment, and narrows in_task_action to archive and restore. Hosts with their own approval gate
   * (ALVIREQ) run with writes on and safe mode on, so drafts, clients, expenses and time entries work while
   * emailing, marking paid, cancelling and deleting stay in Invoice Ninja.
   */
  safeMode: boolean;
  /** Tool names that are never registered (INVOICE_NINJA_DISABLED_TOOLS, comma-separated). */
  disabledTools: Set<string>;
  /** Per-request timeout in milliseconds. */
  timeoutMs: number;
  /** Hard cap on per_page to avoid dumping huge payloads into the model context. */
  maxPerPage: number;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const rawUrl = env.INVOICE_NINJA_URL?.trim();
  const token = env.INVOICE_NINJA_TOKEN?.trim();

  if (!rawUrl) {
    throw new Error(
      "INVOICE_NINJA_URL is required (e.g. https://invoicing.example.ch). " +
        "Do NOT include /api/v1 — it is appended automatically.",
    );
  }
  if (!token) {
    throw new Error(
      "INVOICE_NINJA_TOKEN is required. Create one under " +
        "Settings > Account Management > Integrations > API Tokens.",
    );
  }

  // Normalise: strip trailing slashes and an accidental /api/v1 suffix.
  const baseUrl = rawUrl.replace(/\/+$/, "").replace(/\/api\/v1$/, "");

  return {
    baseUrl,
    token,
    secret: env.INVOICE_NINJA_SECRET?.trim() || undefined,
    allowWrites: bool(env.INVOICE_NINJA_ALLOW_WRITES, false),
    safeMode: bool(env.INVOICE_NINJA_SAFE_MODE, false),
    disabledTools: new Set(
      (env.INVOICE_NINJA_DISABLED_TOOLS ?? "")
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean),
    ),
    timeoutMs: Number(env.INVOICE_NINJA_TIMEOUT_MS ?? 30_000),
    maxPerPage: Number(env.INVOICE_NINJA_MAX_PER_PAGE ?? 100),
  };
}
