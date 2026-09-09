interface Env {
  ARKADE_ORIGIN: Fetcher;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const publicUrl = new URL(request.url);
    const target = new URL(`${publicUrl.pathname}${publicUrl.search}`, "http://127.0.0.1:3270");
    const headers = new Headers(request.headers);
    headers.set("x-forwarded-host", publicUrl.host);
    headers.set("x-forwarded-proto", "https");
    headers.set("x-forwarded-port", "443");

    const init: RequestInit = {
      method: request.method,
      headers,
      redirect: "manual",
    };
    if (request.method !== "GET" && request.method !== "HEAD") {
      init.body = request.body;
    }

    let originResponse: Response;
    try {
      originResponse = await env.ARKADE_ORIGIN.fetch(new Request(target, init));
    } catch {
      return new Response("The home Arkade service is temporarily offline.", {
        status: 503,
        headers: {
          "cache-control": "no-store",
          "content-type": "text/plain; charset=utf-8",
          "retry-after": "30",
          "x-robots-tag": "noindex, nofollow",
        },
      });
    }

    const responseHeaders = new Headers(originResponse.headers);
    responseHeaders.set("cache-control", "no-store");
    responseHeaders.set("strict-transport-security", "max-age=31536000; includeSubDomains");
    responseHeaders.set("x-robots-tag", "noindex, nofollow");

    const location = responseHeaders.get("location");
    if (location) {
      const redirect = new URL(location, publicUrl);
      if (redirect.hostname === "127.0.0.1" || redirect.hostname === "localhost") {
        redirect.protocol = "https:";
        redirect.host = publicUrl.host;
      }
      responseHeaders.set("location", redirect.toString());
    }

    return new Response(originResponse.body, {
      status: originResponse.status,
      statusText: originResponse.statusText,
      headers: responseHeaders,
    });
  },
} satisfies ExportedHandler<Env>;
