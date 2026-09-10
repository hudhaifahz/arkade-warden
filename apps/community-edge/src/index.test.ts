import assert from "node:assert/strict";
import test from "node:test";
import { handleRequest } from "./handler.js";

const origin = (handler: (request: Request) => Response | Promise<Response>) => ({
  fetch: async (request: Request) => handler(request),
});

test("serves a public alpha description without contacting arkd", async () => {
  let called = false;
  const response = await handleRequest(new Request("https://node.example/"), origin(() => {
    called = true;
    return new Response();
  }));
  assert.equal(response.status, 200);
  assert.equal(called, false);
  assert.equal(((await response.json()) as { status: string }).status, "mainnet-alpha");
});

test("forwards only the stock public API and strips private credentials", async () => {
  const response = await handleRequest(new Request("https://node.example/v1/info?probe=1", {
    headers: { authorization: "secret", cookie: "private=1" },
  }), origin((request) => {
    assert.equal(new URL(request.url).pathname, "/v1/info");
    assert.equal(new URL(request.url).search, "?probe=1");
    assert.equal(request.headers.has("authorization"), false);
    assert.equal(request.headers.has("cookie"), false);
    return Response.json({ network: "bitcoin" }, { headers: { "set-cookie": "should-not-leak=1" } });
  }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("set-cookie"), null);
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  assert.deepEqual(await response.json(), { network: "bitcoin" });
});

test("blocks owner, admin, unsupported method, and oversized requests", async () => {
  const unreachable = origin(() => {
    throw new Error("must not call origin");
  });
  assert.equal((await handleRequest(new Request("https://node.example/owner"), unreachable)).status, 404);
  assert.equal((await handleRequest(new Request("https://node.example/v1/admin/wallet"), unreachable)).status, 404);
  assert.equal((await handleRequest(new Request("https://node.example/v1/info", { method: "DELETE" }), unreachable)).status, 405);
  assert.equal((await handleRequest(new Request("https://node.example/v1/txs", {
    method: "POST",
    headers: { "content-length": "2000001" },
    body: "x",
  }), unreachable)).status, 413);
});

test("health reflects origin reachability without exposing operator details", async () => {
  const healthy = await handleRequest(
    new Request("https://node.example/healthz"),
    origin(() => Response.json({ private: "not returned" })),
  );
  assert.equal(healthy.status, 200);
  assert.equal(await healthy.text(), "ok\n");
  const unhealthy = await handleRequest(
    new Request("https://node.example/healthz"),
    origin(() => {
      throw new Error("offline");
    }),
  );
  assert.equal(unhealthy.status, 503);
});
