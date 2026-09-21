const assert = require("node:assert/strict");
const handler = require("../api/[...path].js");

async function run() {
  let statusCode;
  let payload;
  await handler(
    { method: "GET", query: { path: ["health"] }, headers: {} },
    {
      status(code) { statusCode = code; return this; },
      json(body) { payload = body; },
    },
  );
  assert.equal(statusCode, 200);
  assert.deepEqual(payload, { ok: true });
  console.log("Health endpoint passed.");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
