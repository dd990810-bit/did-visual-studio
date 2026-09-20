// POST /api/write
// body: { prompt: string }
// returns: { text } on success, or { error, message } on failure
export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: "invalid_json", message: "요청 형식이 올바르지 않습니다." }, 400);
  }

  const prompt = body && body.prompt ? String(body.prompt) : "";
  if (!prompt.trim()) {
    return json({ error: "empty_prompt", message: "프롬프트가 비어 있습니다." }, 400);
  }

  if (!env.ANTHROPIC_API_KEY) {
    return json(
      { error: "missing_api_key", message: "ANTHROPIC_API_KEY 시크릿이 설정되지 않았습니다. Cloudflare Pages 프로젝트 설정에서 추가해주세요." },
      500
    );
  }

  const model = env.CLAUDE_MODEL || "claude-sonnet-4-5";

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    const data = await res.json();

    if (!res.ok) {
      const message = (data && data.error && data.error.message) || res.statusText || "알 수 없는 오류";
      return json({ error: "upstream_error", message }, 502);
    }

    const text = ((data && data.content) || []).map((b) => b.text || "").join("");
    if (!text) {
      return json({ error: "empty_completion", message: "응답 텍스트를 받지 못했습니다." }, 502);
    }

    return json({ text });
  } catch (e) {
    return json({ error: "network_error", message: String((e && e.message) || e) }, 502);
  }
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
