// GET /api/health
// returns which API keys are configured, so the frontend can show a setup warning if not.
export async function onRequestGet(context) {
  const { env } = context;
  return new Response(
    JSON.stringify({
      ok: true,
      anthropic: Boolean(env.ANTHROPIC_API_KEY),
      openai: Boolean(env.OPENAI_API_KEY),
      sitePassword: Boolean(env.SITE_PASSWORD),
    }),
    { status: 200, headers: { "content-type": "application/json; charset=utf-8" } }
  );
}
