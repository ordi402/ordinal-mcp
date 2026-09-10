#!/usr/bin/env node
/**
 * Ordinal MCP — a local bridge that lets an agent pay for marketplace calls
 * from its own wallet.
 *
 * The x402 `exact` scheme needs an EIP-712 signature from the payer for every
 * payment, so whatever pays has to hold the key. Running here rather than on
 * the marketplace is what keeps that key with its owner: browsing is forwarded
 * to Ordinal untouched, and only the signing step happens locally. Ordinal
 * receives a signature and recovers the payer from it — never the key.
 *
 * Configure with:
 *   ORDINAL_PRIVATE_KEY   payer key, 0x + 64 hex. Without it, browsing and free
 *                         trials still work and paid calls report why they cannot.
 *   ORDINAL_URL           marketplace origin. Defaults to the hosted one.
 *   ORDINAL_MCP_TOKEN     only if the marketplace's own endpoint is gated.
 */
import { createInterface } from "node:readline";
import { privateKeyToAccount } from "viem/accounts";
import { x402Client } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";

const SITE = (process.env.ORDINAL_URL ?? "https://www.ordinal402.xyz").replace(/\/+$/, "");
const REMOTE = `${SITE}/api/mcp`;
const TOKEN = process.env.ORDINAL_MCP_TOKEN?.trim() ?? "";
const KEY = process.env.ORDINAL_PRIVATE_KEY?.trim() ?? "";

const PROTOCOL_VERSION = "2025-06-18";
const KEY_PATTERN = /^0x[0-9a-fA-F]{64}$/;

const account = KEY_PATTERN.test(KEY) ? privateKeyToAccount(KEY as `0x${string}`) : null;

/** Internal to this bridge: the agent never asks for a challenge itself. */
const HIDDEN_TOOLS = new Set(["get_payment_challenge"]);

type Json = Record<string, unknown>;

const WALLET_TOOL = {
  name: "wallet_address",
  title: "Show the paying wallet",
  description:
    "Reports which wallet this bridge will pay from, and whether a key is configured at all. Useful before a paid call.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
};

let nextId = 0;
async function remote(method: string, params: Json): Promise<Json> {
  const res = await fetch(REMOTE, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++nextId, method, params }),
  });
  if (res.status === 401) {
    throw new Error(
      `${SITE} requires a token. Set ORDINAL_MCP_TOKEN in this server's env.`,
    );
  }
  const body = (await res.json()) as { result?: Json; error?: { message?: string } };
  if (body.error) throw new Error(body.error.message ?? "Marketplace returned an error");
  return body.result ?? {};
}

function textResult(value: unknown, isError = false): Json {
  return {
    content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

/** Unwraps a tool result whose payload is JSON encoded inside a text block. */
function payloadOf(result: Json): Json {
  const text = (result.content as { text?: string }[] | undefined)?.[0]?.text;
  if (!text) return {};
  try {
    return JSON.parse(text) as Json;
  } catch {
    return {};
  }
}

/**
 * Signs the marketplace's challenge and calls the service with it.
 *
 * The challenge is fetched, signed here, and only the signature travels back.
 * Ordinal settles it and records the call against the address recovered from
 * that signature, so the payer is whoever holds this key.
 */
async function payAndCall(args: Json): Promise<Json> {
  if (!account) {
    return textResult(
      {
        error: "No wallet configured, so this bridge cannot pay.",
        fix: "Set ORDINAL_PRIVATE_KEY to a 0x-prefixed 32-byte private key in this MCP server's env.",
        alternative: "try_service runs the same provider for free without settling a payment.",
        note: "The key stays on this machine. Only the signature it produces is sent to the marketplace.",
      },
      true,
    );
  }

  const challengeResult = await remote("tools/call", {
    name: "get_payment_challenge",
    arguments: { service: args.service, input: args.input ?? {} },
  });
  const challengePayload = payloadOf(challengeResult);
  if (challengeResult.isError || challengePayload.error || !challengePayload.paymentRequired) {
    return textResult(challengePayload.error ?? challengePayload, true);
  }

  const challenge = decodePaymentRequiredHeader(String(challengePayload.paymentRequired));
  const accepted = (challenge as unknown as { accepts: Record<string, string>[] }).accepts[0];

  // USDG is not one of x402's default assets, so the payer must opt in to it.
  const client = new x402Client()
    .register(accepted.network as `${string}:${string}`, new ExactEvmScheme(account))
    .setSpendControls({ allowedAssets: true });

  let signature: string;
  try {
    signature = encodePaymentSignatureHeader(await client.createPaymentPayload(challenge as never));
  } catch (error) {
    return textResult(
      {
        error: `Could not sign the payment: ${error instanceof Error ? error.message : String(error)}`,
        payer: account.address,
        hint: "The payer needs USDG for the price and a one-time Permit2 approval of USDG.",
      },
      true,
    );
  }

  const paid = await remote("tools/call", {
    name: "call_service",
    arguments: { ...args, paymentSignature: signature },
  });
  return { ...paid, content: paid.content };
}

async function handle(method: string, params: Json): Promise<Json> {
  if (method === "initialize") {
    return {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: "ordinal-mcp", version: "0.1.0" },
      instructions:
        `Ordinal marketplace at ${SITE}. Browse with list_services and get_service_details, `
        + "trial for free with try_service, and pay for a real call with call_service — which "
        + "settles from this machine's own wallet on Robinhood Chain.",
    };
  }

  if (method === "ping") return {};

  if (method === "tools/list") {
    const upstream = await remote("tools/list", {});
    const tools = ((upstream.tools as Json[] | undefined) ?? []).filter(
      (t) => !HIDDEN_TOOLS.has(String(t.name)),
    );
    for (const tool of tools) {
      if (tool.name !== "call_service") continue;
      // The bridge supplies the signature, so asking the agent for one would be
      // asking it to do the one thing it cannot.
      const schema = tool.inputSchema as { properties?: Record<string, unknown> } | undefined;
      if (schema?.properties) delete schema.properties.paymentSignature;
      tool.description =
        `Execute a real paid call, settled on Robinhood Chain from this machine's wallet`
        + `${account ? ` (${account.address})` : " (no key configured yet)"}. `
        + "The payment is signed locally; the private key never leaves this machine. "
        + "Returns the provider response plus the settlement transaction.";
    }
    return { tools: [...tools, WALLET_TOOL] };
  }

  if (method === "tools/call") {
    const name = String(params.name ?? "");
    const args = (params.arguments as Json) ?? {};

    if (name === "wallet_address") {
      return textResult(
        account
          ? { configured: true, payer: account.address, marketplace: SITE,
              note: "This wallet signs locally and pays for call_service." }
          : { configured: false, marketplace: SITE,
              fix: "Set ORDINAL_PRIVATE_KEY in this MCP server's env to enable paid calls." },
      );
    }

    if (name === "call_service") return payAndCall(args);
    if (HIDDEN_TOOLS.has(name)) return textResult(`${name} is handled by this bridge.`, true);

    return remote("tools/call", params);
  }

  throw new Error(`Unsupported method: ${method}`);
}

function send(message: Json): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let request: { id?: unknown; method?: string; params?: Json };
  try {
    request = JSON.parse(trimmed);
  } catch {
    return;
  }

  // Notifications carry no id and expect no reply.
  const { id, method, params } = request;
  if (id === undefined || id === null) return;

  handle(String(method ?? ""), params ?? {})
    .then((result) => send({ jsonrpc: "2.0", id, result }))
    .catch((error: unknown) =>
      send({
        jsonrpc: "2.0",
        id,
        error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
      }),
    );
});

if (KEY && !account) {
  process.stderr.write(
    "ordinal-mcp: ORDINAL_PRIVATE_KEY is set but is not a 0x-prefixed 32-byte hex key. Paid calls are disabled.\n",
  );
}
