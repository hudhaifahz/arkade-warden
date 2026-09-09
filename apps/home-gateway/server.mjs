import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const listenHost = process.env.LISTEN_HOST ?? "127.0.0.1";
const listenPort = Number(process.env.PORT ?? "3270");
const ownerToken = process.env.OWNER_CONSOLE_TOKEN;
const escrowDirectory = process.env.ESCROW_DIRECTORY;
const npmPath = process.env.NPM_PATH ?? "npm";
const walletOrigin = process.env.WALLET_ORIGIN ?? "http://127.0.0.1:3203";
const arkOrigin = process.env.ARKADE_ORIGIN ?? "http://127.0.0.1:7270";
const adminOrigin = process.env.ARKADE_ADMIN_ORIGIN ?? "http://127.0.0.1:7271";

if (!ownerToken || ownerToken.length < 32) {
  throw new Error("OWNER_CONSOLE_TOKEN must be at least 32 characters");
}
if (!escrowDirectory) throw new Error("ESCROW_DIRECTORY is required");

const tokenDigest = createHash("sha256").update(ownerToken).digest();
const failedLogins = new Map();
const sessionSignature = (expires) =>
  createHmac("sha256", ownerToken).update(`owner:${expires}`).digest("base64url");

const parseCookies = (value = "") =>
  Object.fromEntries(
    value
      .split(";")
      .map((part) => part.trim().split("="))
      .filter(([name, cookieValue]) => name && cookieValue)
      .map(([name, ...rest]) => [name, rest.join("=")]),
  );

const isAuthorized = (request) => {
  const cookie = parseCookies(request.headers.cookie).fc_arkade_session;
  if (!cookie) return false;
  const [expiresText, signature] = cookie.split(".");
  const expires = Number(expiresText);
  if (!Number.isSafeInteger(expires) || expires < Date.now()) return false;
  const expected = sessionSignature(expires);
  const received = Buffer.from(signature ?? "");
  const expectedBuffer = Buffer.from(expected);
  return (
    received.length === expectedBuffer.length &&
    timingSafeEqual(received, expectedBuffer)
  );
};

const securityHeaders = {
  "cache-control": "no-store",
  "content-security-policy":
    "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "x-robots-tag": "noindex, nofollow",
};

const send = (response, status, body, headers = {}) => {
  response.writeHead(status, { ...securityHeaders, ...headers });
  response.end(body);
};

const json = (response, status, value, headers = {}) =>
  send(response, status, JSON.stringify(value), {
    "content-type": "application/json; charset=utf-8",
    ...headers,
  });

const readBody = async (request, maxBytes = 8_192) => {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > maxBytes) throw new Error("Request body too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
};

const encodePayload = (value) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");

const runEscrow = async (command, payload) => {
  const args = ["--silent", "run", "escrow", "--", command];
  if (payload !== undefined) args.push(encodePayload(payload));
  const { stdout } = await execFileAsync(npmPath, args, {
    cwd: escrowDirectory,
    timeout: 120_000,
    maxBuffer: 2_000_000,
    env: process.env,
  });
  return JSON.parse(stdout);
};

const escrowErrorMessage = (error) => {
  const stderr = String(error?.stderr ?? error?.message ?? "");
  const match = stderr.match(/Error: ([^\n]+)/);
  return match?.[1] ?? "Escrow request could not be completed";
};

const loginPage = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>Frontier Crown Arkade</title>
<style>:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;min-height:100vh;background:#080b0f;color:#f5f7fa;font:16px/1.45 system-ui,-apple-system,sans-serif;display:grid;place-items:center;padding:24px}.card{width:min(100%,420px);background:#111821;border:1px solid #26303d;border-radius:20px;padding:26px;box-shadow:0 24px 70px #0008}h1{font-size:24px;margin:0 0 8px}.muted{color:#9ba9b8;margin:0 0 22px}input,button{width:100%;font:inherit;border-radius:12px;padding:14px}input{color:#fff;background:#080b0f;border:1px solid #344150;margin-bottom:12px}button{border:0;background:#f59e0b;color:#17100a;font-weight:750}#message{min-height:24px;color:#fca5a5;margin-top:12px}</style></head>
<body><main class="card"><h1>Frontier Crown Arkade</h1><p class="muted">Private owner access. Your wallet seed remains on this device.</p><form id="login"><input id="token" type="password" autocomplete="current-password" placeholder="Owner access token" required><button>Unlock</button></form><div id="message"></div></main>
<script>login.addEventListener('submit',async(e)=>{e.preventDefault();message.textContent='';const r=await fetch('/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:token.value})});if(r.ok){token.value='';location.href='/owner'}else{message.textContent='Access denied'}})</script></body></html>`;

const ownerPage = readFileSync(new URL("./owner.html", import.meta.url), "utf8");

const proxy = async (request, response, origin, path, transformWallet = false) => {
  const target = new URL(path, origin);
  const headers = { ...request.headers };
  delete headers.host;
  delete headers.cookie;
  const abortController = new AbortController();
  response.on("close", () => {
    if (!response.writableEnded) abortController.abort();
  });
  const init = {
    method: request.method,
    headers,
    redirect: "manual",
    signal: abortController.signal,
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = await readBody(request, 2_000_000);
  }
  const upstream = await fetch(target, init);
  const responseHeaders = Object.fromEntries(upstream.headers.entries());
  delete responseHeaders["content-length"];
  // Node's fetch transparently decodes compressed upstream bodies. Forwarding
  // the original encoding header would make the browser try to decode them a
  // second time.
  delete responseHeaders["content-encoding"];
  responseHeaders["cache-control"] = "no-store";
  responseHeaders["x-robots-tag"] = "noindex, nofollow";
  if (transformWallet && target.pathname.endsWith(".js")) {
    let body = Buffer.from(await upstream.arrayBuffer());
    const scheme = request.headers["x-forwarded-proto"] === "https" ? "https" : "http";
    const forwardedHost = String(request.headers["x-forwarded-host"] ?? request.headers.host);
    const publicOrigin = `${scheme}://${forwardedHost}`;
    body = Buffer.from(body.toString("utf8").replaceAll("http://localhost:7270", publicOrigin));
    response.writeHead(upstream.status, responseHeaders);
    return response.end(body);
  }

  response.writeHead(upstream.status, responseHeaders);
  if (request.method === "HEAD" || !upstream.body) return response.end();

  // Arkade initializes wallet subscriptions over long-lived SSE endpoints.
  // Buffering those responses means the first byte never reaches the browser,
  // so ServiceWorkerWallet initialization times out. Stream all unmodified
  // responses, including /v1/batch/events and /v1/txs, as they arrive.
  const responseStream = Readable.fromWeb(upstream.body);
  responseStream.on("error", (error) => {
    // Closing a wallet tab or losing mobile connectivity aborts its SSE fetch.
    // That is normal stream lifecycle, not a gateway failure.
    if (error?.name === "AbortError" || response.destroyed) return;
    console.error("Arkade proxy stream failed", error);
    response.destroy(error);
  });
  responseStream.pipe(response);
};

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host ?? "localhost"}`);
    if (url.pathname === "/healthz") return send(response, 200, "ok\n", { "content-type": "text/plain" });
    if (url.pathname === "/login" && request.method === "GET") return send(response, 200, loginPage, { "content-type": "text/html; charset=utf-8" });
    if (url.pathname === "/auth/login" && request.method === "POST") {
      const clientId = String(request.headers["cf-connecting-ip"] ?? request.socket.remoteAddress ?? "unknown");
      const now = Date.now();
      const prior = failedLogins.get(clientId);
      if (prior && prior.resetAt > now && prior.count >= 8) {
        return json(response, 429, { error: "Try again later" }, { "retry-after": "900" });
      }
      const body = JSON.parse((await readBody(request)).toString("utf8"));
      const received = createHash("sha256").update(String(body.token ?? "")).digest();
      if (!timingSafeEqual(received, tokenDigest)) {
        const current = prior && prior.resetAt > now ? prior : { count: 0, resetAt: now + 15 * 60 * 1000 };
        current.count += 1;
        failedLogins.set(clientId, current);
        return json(response, 401, { error: "Access denied" });
      }
      failedLogins.delete(clientId);
      const expires = Date.now() + 24 * 60 * 60 * 1000;
      const secure = request.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
      return json(response, 200, { ok: true }, { "set-cookie": `fc_arkade_session=${expires}.${sessionSignature(expires)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400${secure}` });
    }
    if (!isAuthorized(request)) {
      if (url.pathname.startsWith("/v1/") || url.pathname.startsWith("/owner/api/")) return json(response, 401, { error: "Authentication required" });
      response.writeHead(302, { location: "/login", ...securityHeaders });
      return response.end();
    }
    if (url.pathname === "/owner" && request.method === "GET") return send(response, 200, ownerPage, { "content-type": "text/html; charset=utf-8" });
    if (url.pathname === "/owner/api/status" && request.method === "GET") {
      const [escrow, warden, status, address, balance] = await Promise.all([
        runEscrow("status"),
        runEscrow("dashboard"),
        fetch(`${adminOrigin}/v1/admin/wallet/status`).then((r) => r.json()),
        fetch(`${adminOrigin}/v1/admin/wallet/address`).then((r) => r.json()),
        fetch(`${adminOrigin}/v1/admin/wallet/balance`).then((r) => r.json()),
      ]);
      return json(response, 200, { escrow, warden, operator: { status, address: address.address, balance } });
    }
    if (url.pathname === "/owner/api/warden/dashboard" && request.method === "GET") {
      try {
        return json(response, 200, await runEscrow("dashboard"));
      } catch (error) {
        return json(response, 400, { error: escrowErrorMessage(error) });
      }
    }
    if (url.pathname === "/owner/api/warden/contracts" && request.method === "POST") {
      try {
        const body = JSON.parse((await readBody(request, 16_384)).toString("utf8"));
        return json(response, 201, await runEscrow("create-managed", body));
      } catch (error) {
        return json(response, 400, { error: escrowErrorMessage(error) });
      }
    }
    if (url.pathname === "/owner/api/warden/bind" && request.method === "POST") {
      try {
        const body = JSON.parse((await readBody(request, 16_384)).toString("utf8"));
        return json(response, 200, await runEscrow("bind-mobile", body));
      } catch (error) {
        return json(response, 400, { error: escrowErrorMessage(error) });
      }
    }
    if (url.pathname === "/owner/api/warden/prepare" && request.method === "POST") {
      try {
        const body = JSON.parse((await readBody(request, 8_192)).toString("utf8"));
        return json(response, 200, await runEscrow("prepare-mobile", body));
      } catch (error) {
        return json(response, 400, { error: escrowErrorMessage(error) });
      }
    }
    if (url.pathname === "/owner/api/warden/submit-ark" && request.method === "POST") {
      try {
        const body = JSON.parse((await readBody(request, 250_000)).toString("utf8"));
        return json(response, 200, await runEscrow("submit-mobile-ark", body));
      } catch (error) {
        return json(response, 400, { error: escrowErrorMessage(error) });
      }
    }
    if (url.pathname === "/owner/api/warden/finalize" && request.method === "POST") {
      try {
        const body = JSON.parse((await readBody(request, 500_000)).toString("utf8"));
        return json(response, 200, await runEscrow("finalize-mobile", body));
      } catch (error) {
        return json(response, 400, { error: escrowErrorMessage(error) });
      }
    }
    if (url.pathname === "/owner/api/warden/claim-seller" && request.method === "POST") {
      try {
        const body = JSON.parse((await readBody(request, 16_384)).toString("utf8"));
        return json(response, 200, await runEscrow("claim-seller", body));
      } catch (error) {
        return json(response, 400, { error: escrowErrorMessage(error) });
      }
    }
    if (url.pathname === "/owner/api/warden/recover-seller" && request.method === "POST") {
      try {
        const body = JSON.parse((await readBody(request, 8_192)).toString("utf8"));
        return json(response, 200, await runEscrow("recover-seller", body));
      } catch (error) {
        return json(response, 400, { error: escrowErrorMessage(error) });
      }
    }
    if (url.pathname === "/owner/api/warden/rollover/start" && request.method === "POST") {
      try {
        const body = JSON.parse((await readBody(request, 16_384)).toString("utf8"));
        return json(response, 200, await runEscrow("start-rollover", body));
      } catch (error) {
        return json(response, 400, { error: escrowErrorMessage(error) });
      }
    }
    if (url.pathname === "/owner/api/warden/rollover/preauthorize" && request.method === "POST") {
      try {
        const body = JSON.parse((await readBody(request, 16_384)).toString("utf8"));
        return json(response, 200, await runEscrow("preauthorize-rollover", body));
      } catch (error) {
        return json(response, 400, { error: escrowErrorMessage(error) });
      }
    }
    if (url.pathname === "/owner/api/warden/rollover/activation-plan" && request.method === "POST") {
      try {
        const body = JSON.parse((await readBody(request, 16_384)).toString("utf8"));
        return json(response, 200, await runEscrow("delegated-rollover-activation-plan", body));
      } catch (error) {
        return json(response, 400, { error: escrowErrorMessage(error) });
      }
    }
    if (url.pathname === "/owner/api/warden/recovery/start" && request.method === "POST") {
      try {
        const body = JSON.parse((await readBody(request, 16_384)).toString("utf8"));
        return json(response, 200, await runEscrow("start-recovery", body));
      } catch (error) {
        return json(response, 400, { error: escrowErrorMessage(error) });
      }
    }
    const rolloverMatch = url.pathname.match(/^\/owner\/api\/warden\/rollover\/([0-9a-f-]{36})$/i);
    if (rolloverMatch && request.method === "GET") {
      try {
        return json(response, 200, await runEscrow("rollover-status", { sessionId: rolloverMatch[1] }));
      } catch (error) {
        return json(response, 400, { error: escrowErrorMessage(error) });
      }
    }
    const rolloverSignMatch = url.pathname.match(/^\/owner\/api\/warden\/rollover\/([0-9a-f-]{36})\/sign$/i);
    if (rolloverSignMatch && request.method === "POST") {
      try {
        const body = JSON.parse((await readBody(request, 1_100_000)).toString("utf8"));
        return json(response, 200, await runEscrow("rollover-sign", {
          sessionId: rolloverSignMatch[1],
          requestId: body.requestId,
          signedPsbt: body.signedPsbt,
        }));
      } catch (error) {
        return json(response, 400, { error: escrowErrorMessage(error) });
      }
    }
    const recoveryMatch = url.pathname.match(/^\/owner\/api\/warden\/recovery\/([0-9a-f-]{36})$/i);
    if (recoveryMatch && request.method === "GET") {
      try {
        return json(response, 200, await runEscrow("recovery-status", { sessionId: recoveryMatch[1] }));
      } catch (error) {
        return json(response, 400, { error: escrowErrorMessage(error) });
      }
    }
    const recoverySignMatch = url.pathname.match(/^\/owner\/api\/warden\/recovery\/([0-9a-f-]{36})\/sign$/i);
    if (recoverySignMatch && request.method === "POST") {
      try {
        const body = JSON.parse((await readBody(request, 1_100_000)).toString("utf8"));
        return json(response, 200, await runEscrow("recovery-sign", {
          sessionId: recoverySignMatch[1],
          requestId: body.requestId,
          signedPsbt: body.signedPsbt,
        }));
      } catch (error) {
        return json(response, 400, { error: escrowErrorMessage(error) });
      }
    }
    if (url.pathname.startsWith("/v1/")) return await proxy(request, response, arkOrigin, `${url.pathname}${url.search}`);
    return await proxy(request, response, walletOrigin, `${url.pathname}${url.search}`, true);
  } catch (error) {
    console.error(error);
    return json(response, 502, { error: "Local Arkade service unavailable" });
  }
});

server.listen(listenPort, listenHost, () => {
  console.log(`Arkade mobile gateway listening on http://${listenHost}:${listenPort}`);
});

// Polling only rotates after the CLI independently confirms the active contract
// is expired and has no spendable VTXOs. Without a mobile binding this is a
// read-only no-op.
setInterval(() => {
  runEscrow("ensure-active").catch((error) => console.error("Escrow readiness check failed", escrowErrorMessage(error)));
}, 60_000).unref();
