// POST /api/logout — clears the login cookie.
export async function onRequestPost() {
  const headers = new Headers({ "content-type": "application/json; charset=utf-8" });
  headers.append("Set-Cookie", "did_auth=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax");
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
}
