// E2E harness for the warm CLI pool — talks REAL native-messaging frames
// (4-byte LE length prefix + JSON) to native-host.js, exactly like the
// browser does, and measures time-to-first-event cold vs warm.
//
// MANUAL test: `node e2e-warm.mjs` from host/. It runs THREE tiny real
// claude queries (haiku ×2 + sonnet ×1 — a few hundred tokens of Max
// quota), so it is deliberately NOT named *.test.js and never runs under
// `node --test`. Expected output ends with something like:
//   RESULT: cold=~1500ms warm=~45ms saving=~1450ms
// and the q2 lines must include "warm CLI adopted".
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HOST = fileURLToPath(new URL("./native-host.js", import.meta.url));
const host = spawn("node", [HOST], { stdio: ["pipe", "pipe", "pipe"] });

host.stderr.on("data", (c) => process.stdout.write("[host-stderr] " + c.toString()));

let buf = Buffer.alloc(0);
const waiters = [];
host.stdout.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  while (buf.length >= 4) {
    const len = buf.readUInt32LE(0);
    if (buf.length < 4 + len) break;
    const msg = JSON.parse(buf.subarray(4, 4 + len).toString("utf-8"));
    buf = buf.subarray(4 + len);
    onMsg(msg);
  }
});

function onMsg(msg) {
  const brief = msg.type === "max_event"
    ? `max_event(${msg.event?.type}${msg.event?.subtype ? ":" + msg.event.subtype : ""})`
    : msg.type + (msg.line ? `: ${msg.line}` : "") + (msg.error ? ` ERROR=${msg.error}` : "")
      + (msg.type === "max_done" ? ` exit=${msg.exitCode} stderr=${JSON.stringify(msg.stderr || "")}` : "");
  console.log(`  <- [${msg.id || "-"}] ${brief}`);
  for (let i = waiters.length - 1; i >= 0; i--) {
    if (waiters[i].match(msg)) waiters.splice(i, 1)[0].resolve(msg);
  }
}

function send(obj) {
  const body = Buffer.from(JSON.stringify(obj), "utf-8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  host.stdin.write(Buffer.concat([header, body]));
}

function waitFor(match, timeoutMs = 90_000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout waiting")), timeoutMs);
    waiters.push({ match, resolve: (m) => { clearTimeout(t); resolve(m); } });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runQuery(id, model) {
  const t0 = Date.now();
  send({ type: "max_query", id, prompt: "Reply with exactly one word: pong", model });
  const first = await waitFor((m) => m.id === id && (m.type === "max_event" || m.type === "max_error"));
  const tFirst = Date.now() - t0;
  if (first.type === "max_error") throw new Error(`${id} max_error: ` + first.error);
  await waitFor((m) => m.id === id && m.type === "max_done");
  return { tFirst, tDone: Date.now() - t0 };
}

try {
  await waitFor((m) => m.type === "ready", 15_000);
  console.log("host ready.\n--- Q1 (cold spawn) ---");
  const q1 = await runQuery("q1", "haiku");
  console.log(`Q1 cold: first-event ${q1.tFirst}ms, done ${q1.tDone}ms`);

  console.log("\n(waiting 4s for post-turn warm-up to boot — also proves the warm proc\n survives well past claude's 3s plain-stdin timeout, thanks to stream-json input)");
  await sleep(4000);

  console.log("--- Q2 (must log 'warm CLI adopted') ---");
  const q2 = await runQuery("q2", "haiku");
  console.log(`Q2 warm: first-event ${q2.tFirst}ms, done ${q2.tDone}ms`);

  console.log("\n--- Q3 (model switch → signature miss → fresh spawn expected) ---");
  const q3 = await runQuery("q3", "sonnet");
  console.log(`Q3 (signature miss, cold): first-event ${q3.tFirst}ms`);

  console.log(`\nRESULT: cold=${q1.tFirst}ms warm=${q2.tFirst}ms saving=${q1.tFirst - q2.tFirst}ms`);
  host.stdin.end(); // host shutdown must also kill the warm proc — check task manager if paranoid
  await sleep(1500);
  process.exit(0);
} catch (e) {
  console.error("E2E FAILED:", e.message);
  host.stdin.end();
  await sleep(1000);
  process.exit(1);
}
