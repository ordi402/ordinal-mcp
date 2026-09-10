# @ordinal402/ordinal-mcp

Pay for [Ordinal](https://www.ordinal402.xyz) marketplace calls from your own
wallet, in Claude Code or Codex.

x402's `exact` scheme needs an EIP-712 signature from the payer for every
payment, so whatever pays has to hold the key. This bridge runs on your machine
for exactly that reason: browsing is forwarded to Ordinal untouched, and only
the signing happens here. Ordinal receives a signature and recovers your address
from it — never the key.

## Install

Nothing to install. Both clients run it on demand.

**Claude Code**

```bash
claude mcp add ordinal -e ORDINAL_PRIVATE_KEY=0xYOUR_KEY -- npx -y @ordinal402/ordinal-mcp@latest
```

**Codex** — add to `~/.codex/config.toml`:

```toml
[mcp_servers.ordinal]
command = "npx"
args = ["-y", "@ordinal402/ordinal-mcp@latest"]

[mcp_servers.ordinal.env]
ORDINAL_PRIVATE_KEY = "0xYOUR_KEY"
```

Leave the key out and everything still works except paid calls — browsing and
free trials need no wallet at all.

## Before your first paid call

The payer wallet needs, on Robinhood Chain (chain id 4663):

- **USDG** for the service price
- **a little ETH** — only for the one-time approval below
- **a one-time Permit2 approval** of USDG:

```bash
cast send 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168 \
  "approve(address,uint256)" \
  0x000000000022D473030F116dDEE9F6B43aC78BA3 \
  0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff \
  --private-key 0xYOUR_KEY --rpc-url <robinhood-rpc>
```

After that every payment is gasless for you — Ordinal's relayer broadcasts and
pays the gas. You only ever sign.

Use a plain EOA. Permit2 treats an address that holds code as a smart wallet and
calls `isValidSignature` on it; if that contract does not implement ERC-1271 the
settlement reverts.

## Tools

| Tool | Cost | What it does |
|---|---|---|
| `list_services` | free | Browse the catalogue. Filter by `query`, `category`, `maxPrice`. |
| `get_service_details` | free | Input/output schema, price, x402 terms. Read before calling. |
| `try_service` | free | Runs the provider for real. Settles nothing, records nothing. |
| `call_service` | **paid** | Signs locally, settles on chain, returns the response and the transaction. |
| `check_payment_status` | free | Look up a settlement transaction. |
| `wallet_address` | free | Which wallet will pay, and whether a key is configured. |

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `ORDINAL_PRIVATE_KEY` | — | Payer key, `0x` + 64 hex. Without it, paid calls explain why they cannot run. |
| `ORDINAL_URL` | `https://www.ordinal402.xyz` | Marketplace origin. |
| `ORDINAL_MCP_TOKEN` | — | Only if the marketplace endpoint is gated. |

## Why this is safe to give a key

Asking for a private key is the largest thing software can ask of you, so this
package is small enough to read in full and published in a way you can verify.

- **The source is here.** `src/index.ts` is around 200 lines. The key appears in
  exactly one place: constructing a viem account that signs typed data locally.
- **It is never transmitted.** Search the source for the key variable. It is
  never placed in a request body, a header, a URL, a file, or a log line.
- **The published package is provenance-signed.** npm ties the tarball to the
  commit in this repository and the GitHub Actions run that built it, so the
  code you read here is the code you install. Check it on the package page.
- **It only ever signs.** The bridge cannot move funds on its own. Every payment
  is a signature over a challenge that names the exact amount and recipient, and
  the marketplace settles that one payment and nothing else.
- **Nothing is required.** Leave the key unset and browsing and free trials
  still work.

Use a wallet funded with only what you intend to spend. That is good practice
with any agent, not a caveat specific to this one.

## What is sent where

```
list_services / get_service_details / try_service
   → forwarded to the marketplace. No key involved.

call_service
   → fetch the 402 challenge from the marketplace
   → sign it HERE, with your key, on this machine
   → send only the signature
   → the marketplace settles it and records the call against your address
```

Your private key is read from this process's environment and used to sign. It is
never written anywhere, never logged, and never sent over the network.
