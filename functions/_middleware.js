// Runs before every request (pages and /api/*).
// Gates the whole site behind a single shared password (env.SITE_PASSWORD),
// so only people who know it can open the site.
// Cloudflare Pages serves login.html at the clean URL "/login" and redirects
// "/login.html" requests to "/login" — both must stay public, or that
// redirect loops forever against the auth check below.
const PUBLIC_PATHS = new Set(["/login.html", "/login", "/api/login", "/api/logout", "/api/health"]);

export async function onRequest(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);

  if (PUBLIC_PATHS.has(url.pathname)) {
    return next();
  }

  // No password configured yet: let requests through so the on-page
  // "API 연결 상태" warning can tell the owner what's missing.
  if (!env.SITE_PASSWORD) {
    return next();
  }

  const cookieHeader = request.headers.get("Cookie") || "";
  const match = cookieHeader.match(/(?:^|;\s*)did_auth=([^;]+)/);
  const token = match ? decodeURIComponent(match[1]) : "";
  const expected = await sha256Hex(env.SITE_PASSWORD);

  if (token === expected) {
    return next();
  }

  const accept = request.headers.get("Accept") || "";
  if (accept.includes("text/html")) {
    const next_ = encodeURIComponent(url.pathname + url.search);
    return Response.redirect(`${url.origin}/login?next=${next_}`, 302);
  }

  return new Response(JSON.stringify({ error: "unauthorized", message: "로그인이 필요합니다." }), {
    status: 401,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

async function sha256Hex(str) {
  const data = new TextEncoder().encode(str);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
