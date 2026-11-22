#!/usr/bin/env node
// Fake `claude` CLI for tests (tests/worker.test.ts). Never used in production.
//   FAKE_CLAUDE_MODE=ok|garbage|notloggedin|usagelimit|slow|fenced   (default ok)
// In ok/fenced mode the page's `notes` carry diagnostics the test asserts on:
//   env:ANTHROPIC_API_KEY=absent|present, env:WORKER_TOKEN=..., argv-has-image=true|false,
//   flags-ok=true|false, cwd-empty=true|false, stdin-ok=true|false

import { readdirSync } from "node:fs";

const argv = process.argv.slice(2);
const mode = process.env.FAKE_CLAUDE_MODE || "ok";

if (argv.includes("--version")) {
  console.log("9.9.9 (Claude Code)");
  process.exit(0);
}
if (argv.includes("--help")) {
  console.log(`Usage: claude [options] [command] [prompt]
Options:
  -p, --print                       Print response and exit
  --tools <tools...>                Built-in tools to make available
  --restricted                      Restricted mode
  --strict-mcp-config               Only use MCP servers from --mcp-config
  --no-session-persistence          Don't save sessions
  --input-format <format>           "text" (default), or "stream-json"
  --output-format <format>          "text", "json", or "stream-json"
  --json-schema <schema>            JSON Schema for structured output
  --system-prompt <prompt>          System prompt
  --verbose                         Override the verbose setting
  --model <model>                   Model
  -v, --version                     Output the version number`);
  process.exit(0);
}

const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");

// `claude auth status` (heartbeat login check; makes no model call)
if (argv[0] === "auth" && argv[1] === "status") {
  if (mode === "notloggedin") {
    out({ loggedIn: false, authMethod: "none" });
    process.exit(1);
  }
  out({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "team" });
  process.exit(0);
}

const page = (notes) => ({
  sheet_number: "3", sheet_title: "MOTOR STARTER", sheet_status: "content",
  components: [{
    tag: "Q1", device_type: "MPCB", description: "Motor protection breaker", rating: "13-18A", setting: "16A",
    coil_voltage: null, poles: "3P", contact_config: null, colour: null, function: null, relay_type: null,
    quantity: 1, sheets: [], make: null, manufacturer_pn: null, motor_flc_a: 15.5, motor_kw: 7.5,
  }],
  terminal_blocks: [{ tag: "X1", terminal_type: "FEED-THROUGH", rating: "2.5sqmm", terminals: ["1", "2"], count: 2 }],
  notes,
});

// Text-prompt mode (used by --check): `claude -p ... --output-format json "<prompt>"`
if (!argv.includes("stream-json")) {
  if (mode === "notloggedin") {
    out({ type: "result", subtype: "success", is_error: true, result: "Not logged in · Please run /login" });
    process.exit(1);
  }
  out({ type: "result", subtype: "success", is_error: false, result: "OK" });
  process.exit(0);
}

let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (stdin += c));
process.stdin.on("end", async () => {
  out({ type: "system", subtype: "init", model: "fake-model-1", tools: [] });
  let msg = null;
  try { msg = JSON.parse(stdin.trim()); } catch { /* reported below */ }
  const content = msg?.message?.content || [];
  const img = content.find((c) => c.type === "image");
  const txt = content.find((c) => c.type === "text");
  const data = img?.source?.data || "";
  const stdinOk = msg?.type === "user" && !!data && /^This is page \d+ of the drawing set\./.test(txt?.text || "");
  const at = (f) => argv.indexOf(f);
  const flagsOk =
    argv[0] === "-p" && at("--tools") >= 0 && argv[at("--tools") + 1] === "" && argv.includes("--restricted") &&
    argv.includes("--strict-mcp-config") && argv.includes("--no-session-persistence") && at("--json-schema") >= 0 &&
    at("--system-prompt") >= 0 && !argv.includes("--bare") && !argv.some((a) => /dangerously|bypass/i.test(a));
  const argvHasImage = data.length > 0 && argv.some((a) => a.includes(data.slice(0, 64)));
  let cwdEmpty = false;
  try { cwdEmpty = readdirSync(process.cwd()).length === 0; } catch { /* false */ }
  const notes = [
    `env:ANTHROPIC_API_KEY=${process.env.ANTHROPIC_API_KEY ? "present" : "absent"}`,
    `env:ANTHROPIC_AUTH_TOKEN=${process.env.ANTHROPIC_AUTH_TOKEN ? "present" : "absent"}`,
    `env:ANTHROPIC_BASE_URL=${process.env.ANTHROPIC_BASE_URL ? "present" : "absent"}`,
    `env:WORKER_TOKEN=${process.env.WORKER_TOKEN ? "present" : "absent"}`,
    `argv-has-image=${argvHasImage}`,
    `flags-ok=${flagsOk}`,
    `cwd-empty=${cwdEmpty}`,
    `stdin-ok=${stdinOk}`,
  ];

  switch (mode) {
    case "garbage":
      out({ type: "result", subtype: "success", is_error: false, result: "Sorry, I can't read this drawing." });
      return process.exit(0);
    case "notloggedin":
      process.stderr.write("Invalid API key · Please run /login\n");
      out({ type: "result", subtype: "success", is_error: true, result: "Not logged in · Please run /login" });
      return process.exit(1);
    case "usagelimit":
      // Claude Code's plan-limit message: "...|<epoch seconds of the reset>"
      out({ type: "result", subtype: "success", is_error: true, result: `Claude AI usage limit reached|${process.env.FAKE_CLAUDE_RESET || "1900000000"}` });
      return process.exit(1);
    case "slow":
      setTimeout(() => process.exit(0), 600000);
      return;
    case "fenced":
      out({ type: "result", subtype: "success", is_error: false, result: "```json\n" + JSON.stringify(page(notes)) + "\n```" });
      return process.exit(0);
    default: {
      const p = page(notes);
      out({ type: "result", subtype: "success", is_error: false, result: JSON.stringify(p), structured_output: p });
      return process.exit(0);
    }
  }
});
