/**
 * Server-side helper for proxying Cohorly ingestion requests through a
 * first-party Next.js route, so browsers call your own domain instead of
 * the Cohorly server directly (avoids ad-blockers, keeps apiHost private).
 *
 * Usage (app/api/cohorly/[...path]/route.ts):
 *
 *   export const { POST } = createCohorlyProxy({ apiHost: "https://cohorly-service.velloalabs.com" });
 *
 * Then point the client SDK's apiHost at "/api/cohorly" and it will
 * transparently forward POST /api/cohorly/track (etc.) upstream.
 *
 * Typed loosely against the platform Request/Response globals (available in
 * both Node.js Route Handlers and the Edge runtime) so this package doesn't
 * need "next" as a hard dependency.
 *
 * ## Token modes
 *
 * There are two ways to attach a project token to ingested data:
 *
 * 1. Client-side: pass `token` to `CohorlyProvider` / `init()` (from
 *    `@cohorly/react` / `@cohorly/web`). The token ships in the browser
 *    bundle and is included in every request body the client sends, which
 *    this proxy then forwards upstream unmodified.
 * 2. Server-side (this option): pass `token` here instead. The token stays
 *    out of the client bundle entirely; this proxy injects it into every
 *    forwarded /track event's properties and every /engage or /alias body
 *    before relaying the request upstream. Leave `token` unset on the
 *    client SDK when using this mode.
 */
export interface CohorlyProxyOptions {
  /**
   * Upstream Cohorly ingestion API to relay to. Defaults to the hosted
   * endpoint (`https://cohorly-service.velloalabs.com`); only set this to
   * point at a different deployment.
   */
  apiHost?: string;
  /** Upstream paths allowed to be forwarded. Defaults to track/engage/alias. */
  allowedPaths?: string[];
  /**
   * Project token injected server-side into every forwarded /track event's
   * properties and every /engage or /alias body. Use this to keep the token
   * out of client bundles instead of passing it to the client SDK's `init`.
   */
  token?: string;
}

interface RouteContext {
  params?: { path?: string[] } | Promise<{ path?: string[] }>;
}

export interface CohorlyProxyHandlers {
  POST(request: Request, context?: RouteContext): Promise<Response>;
}

const DEFAULT_API_HOST = "https://cohorly-service.velloalabs.com";

export function createCohorlyProxy(options: CohorlyProxyOptions = {}): CohorlyProxyHandlers {
  const apiHost = (options.apiHost ?? DEFAULT_API_HOST).replace(/\/$/, "");
  const allowed = new Set(options.allowedPaths ?? ["track", "engage", "alias"]);

  async function POST(request: Request, context?: RouteContext): Promise<Response> {
    const resolvedParams = context?.params ? await context.params : undefined;
    const segments = resolvedParams?.path ?? segmentsFromUrl(request.url);
    const target = segments[segments.length - 1];

    if (!target || !allowed.has(target)) {
      return new Response(JSON.stringify({ error: "unknown cohorly proxy path" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }

    let body = await request.text();
    if (options.token) {
      body = injectToken(body, target, options.token);
    }
    let upstream: Response;
    try {
      upstream = await fetch(`${apiHost}/${target}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
    } catch {
      return new Response(JSON.stringify({ error: "cohorly upstream unreachable" }), {
        status: 502,
        headers: { "content-type": "application/json" },
      });
    }

    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: {
        "content-type": upstream.headers.get("content-type") ?? "application/json",
      },
    });
  }

  return { POST };
}

function segmentsFromUrl(url: string): string[] {
  const { pathname } = new URL(url);
  return pathname.split("/").filter(Boolean);
}

/**
 * Injects `token` server-side into a forwarded ingestion body. `/track`
 * bodies are `{ event, properties }` (or an array of those) and get the
 * token stamped into `properties.token`; `/engage` and `/alias` bodies get a
 * top-level `token` field, each of which may also be a single object or an
 * array. Falls back to the original raw text if parsing fails, so a
 * malformed body still gets relayed upstream (and rejected there) instead of
 * throwing here.
 */
function injectToken(rawBody: string, target: string, token: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return rawBody;
  }

  const withToken = <T extends Record<string, unknown>>(item: T): T => {
    if (target === "track") {
      return {
        ...item,
        properties: { ...(item as { properties?: Record<string, unknown> }).properties, token },
      };
    }
    return { ...item, token };
  };

  const next = Array.isArray(parsed) ? parsed.map((item) => withToken(item)) : withToken(parsed as Record<string, unknown>);
  return JSON.stringify(next);
}
