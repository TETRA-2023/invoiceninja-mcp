import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig } from "./config.js";
import { registerTools } from "./tools.js";

export const SERVER_NAME = "invoiceninja-mcp";
export const SERVER_VERSION = "0.2.1";

/** Build a fully-wired McpServer instance from environment configuration. */
export function createServer(): McpServer {
  const cfg = loadConfig();
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "Tools for an Invoice Ninja (v5) instance. Read tools (in_list_*, in_get_*, " +
        "in_ping, in_outstanding_summary) are always available. Write tools (in_create_*, " +
        "in_update_*, in_invoice_action) exist only when the operator enabled writes; in safe mode the tools " +
        "that email, mark sent or paid, cancel, delete or record payments are left out, so documents stay drafts. " +
        "Invoice/quote creation needs a client_id and at least one line item. When updating a " +
        "client, always resend the full contacts array.",
    },
  );
  registerTools(server, cfg);
  return server;
}
