# Security Policy

## Reporting a vulnerability

Do not open a public issue. Open a private security advisory on this repository:
[Security → Report a vulnerability](https://github.com/TETRA-2023/invoiceninja-mcp/security/advisories/new).
Include the affected commit or image digest and the steps to reproduce.

This repository is a fork of
[halviclabs/invoiceninja-mcp](https://github.com/halviclabs/invoiceninja-mcp). If the issue is in code
shared with upstream, please report it to Halvic Labs as well (contact in upstream `package.json`).

## Supported versions

Only the latest image built from `main` (`ghcr.io/tetra-2023/invoiceninja-mcp:sha-<commit>`) receives
fixes.

## Scope

The server exposes an Invoice Ninja company through MCP tools. Its safety model is described in the
README ("Safety model"). In short:

- **Credentials** come only from the environment (`INVOICE_NINJA_URL`, `INVOICE_NINJA_TOKEN`); requests
  cannot change them.
- **HTTP transport**: the server refuses to start without `MCP_BEARER_TOKEN` unless it listens on the
  loopback; the bearer is compared in constant time.
- **Writes** are off by default. With writes on, `INVOICE_NINJA_SAFE_MODE=true` leaves out sending,
  settling, cancelling, deleting and payments.
- **No filesystem access**: no tool reads files on the server.

## Out of scope

- Invoice Ninja itself: report to [invoiceninja/invoiceninja](https://github.com/invoiceninja/invoiceninja).
- Authorisation inside Invoice Ninja: a tool can do what the API token's user can do. Give the token the
  least rights the agent needs.
