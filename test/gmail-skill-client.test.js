import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import test from "node:test";

const script = path.join(process.cwd(), "resources", "preinstalled-skills", "composio-gmail", "run.py");

function runClient(args, proxyURL) {
  return new Promise((resolve, reject) => {
    const child = spawn("python3", [script, ...args], {
      env: { ...process.env, ONECLAW_GMAIL_PROXY_URL: proxyURL },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("Gmail skill client calls the fixed latest-email workflow", async (t) => {
  let payload;
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    payload = JSON.parse(Buffer.concat(chunks).toString());
    response.setHeader("content-type", "application/json");
    response.end('{"method":"latest_emails","data":{"messages":[]}}');
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  const result = await runClient(
    ["latest_emails", "--max-results", "5"],
    `http://127.0.0.1:${address.port}/invoke`,
  );

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(payload, { method: "latest_emails", params: { max_results: 5 } });
  assert.deepEqual(JSON.parse(result.stdout), {
    ok: true,
    method: "latest_emails",
    data: { messages: [] },
  });
});

test("Gmail skill client converts a missing binding into authorization_required", async (t) => {
  const server = http.createServer((_request, response) => {
    response.statusCode = 404;
    response.setHeader("content-type", "application/json");
    response.end('{"error":{"code":"integration_not_found"}}');
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  const result = await runClient(
    ["latest_emails"],
    `http://127.0.0.1:${address.port}/invoke`,
  );

  assert.equal(result.code, 1);
  assert.equal(JSON.parse(result.stdout).code, "authorization_required");
});
