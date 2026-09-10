const MAX_DECLARED_BODY_BYTES = 2_000_000;
const ALLOWED_METHODS = new Set(["GET", "HEAD", "POST", "OPTIONS"]);

export type ArkadeOrigin = {
  fetch(request: Request): Promise<Response>;
};

const publicHeaders = {
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "POST, GET, HEAD, OPTIONS",
  "access-control-allow-origin": "*",
  "access-control-expose-headers": "grpc-metadata-content-type, grpc-metadata-trailer",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "x-robots-tag": "noindex, nofollow",
};

const respond = (body: BodyInit | null, status: number, extra: HeadersInit = {}) =>
  new Response(body, { status, headers: { ...publicHeaders, ...Object.fromEntries(new Headers(extra)) } });

const isPublicApiPath = (pathname: string) =>
  /^\/v1(?:\/|$)/.test(pathname) && !/(?:^|\/)(?:admin|owner)(?:\/|$)/i.test(pathname);

const forwardedRequest = (request: Request, url: URL) => {
  const headers = new Headers(request.headers);
  headers.delete("authorization");
  headers.delete("cookie");
  headers.delete("host");
  headers.delete("x-forwarded-host");
  headers.delete("x-forwarded-port");
  headers.delete("x-forwarded-proto");
  headers.set("x-forwarded-proto", "https");
  return new Request(new URL(`${url.pathname}${url.search}`, "http://arkade.internal"), {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
    redirect: "manual",
  });
};

const proxy = async (request: Request, origin: ArkadeOrigin) => {
  const url = new URL(request.url);
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (!ALLOWED_METHODS.has(request.method)) {
    return respond("Method not allowed\n", 405, { allow: [...ALLOWED_METHODS].join(", ") });
  }
  if (Number.isFinite(declaredLength) && declaredLength > MAX_DECLARED_BODY_BYTES) {
    return respond("Request too large\n", 413);
  }
  if (!isPublicApiPath(url.pathname)) return respond("Not found\n", 404);

  try {
    const upstream = await origin.fetch(forwardedRequest(request, url));
    const headers = new Headers(upstream.headers);
    headers.delete("set-cookie");
    for (const [name, value] of Object.entries(publicHeaders)) headers.set(name, value);
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    });
  } catch (error) {
    console.error(JSON.stringify({
      event: "arkade-community-origin-failed",
      message: error instanceof Error ? error.message : "unknown",
    }));
    return respond("The Frontier Crown Arkade alpha node is temporarily offline.\n", 503, { "retry-after": "30" });
  }
};

export const handleRequest = async (request: Request, origin: ArkadeOrigin): Promise<Response> => {
  const url = new URL(request.url);
  if (url.pathname === "/" && request.method === "GET") {
    return Response.json({
      name: "Frontier Crown Arkade community node",
      status: "mainnet-alpha",
      api: "/v1",
      documentation: "https://github.com/hudhaifahz/arkade-warden/pull/1",
      warning: "Use only disposable small amounts. No uptime or liquidity guarantee.",
    }, { headers: publicHeaders });
  }
  if (url.pathname === "/healthz" && (request.method === "GET" || request.method === "HEAD")) {
    try {
      const upstream = await origin.fetch(new Request("http://arkade.internal/v1/info"));
      await upstream.body?.cancel();
      return respond(
        request.method === "HEAD" ? null : upstream.ok ? "ok\n" : "unhealthy\n",
        upstream.ok ? 200 : 503,
        { "content-type": "text/plain; charset=utf-8" },
      );
    } catch {
      return respond(request.method === "HEAD" ? null : "unhealthy\n", 503, { "content-type": "text/plain; charset=utf-8" });
    }
  }
  return proxy(request, origin);
};
