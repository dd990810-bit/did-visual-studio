// POST /api/login  { password }
// On success, sets an HttpOnly cookie so the whole site (gated by
// functions/_middleware.js) becomes accessible from this browser.
export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: "invalid_json", message: "요청 형식이 올바르지 않습니다." }, 400);
  }

  if (!env.SITE_PASSWORD) {
    return json(
      { error: "not_configured", message: "SITE_PASSWORD 시크릿이 아직 설정되지 않았습니다. Cloudflare Pages 설정에서 등록해주세요." },
      500
    );
  }

  const password = body && body.password ? String(body.password) : "";
  if (password !== env.SITE_PASSWORD) {
    return json({ error: "wrong_password", message: "비밀번호가 올바르지 않습니다." }, 401);
  }

  const token = await sha256Hex(env.SITE_PASSWORD);
  const headers = new Headers({ "content-type": "application/json; charset=utf-8" });
  // 30 days. Secure+HttpOnly: never readable/settable from page JS.
  headers.append("Set-Cookie", `did_auth=${token}; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax`);

  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
}

async function sha256Hex(str) {
  const data = new TextEncoder().encode(str);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
