// POST /api/write
// body: { prompt: string, output_schema?: object, max_tokens?: number }
//   - prompt only (웹앱 기존 호출): 이전과 동일하게 동작하고 { text } 를 반환한다.
//   - output_schema 포함(자동화 writer): Anthropic Messages API의 structured outputs
//     (output_config.format = { type: "json_schema", schema })로 schema를 그대로 전달해 모델 출력 자체를 schema로 제한한다.
//     schema는 API가 지원하는 부분집합만 허용하고(모든 object에 additionalProperties:false 필수), 어기면 400으로 거부한다.
//     응답이 끝까지 생성되지 않았으면(max_tokens/refusal 등) 성공으로 돌려주지 않는다(잘린 출력 금지).
// returns: { text } | { text, structured: true, model, stop_reason, schema_sha256 } on success, or { error, message } on failure
export async function onRequestPost(context) {
  return handleWrite(context.request, context.env, fetch);
}

export const STRUCTURED_DEFAULT_MODEL = "claude-sonnet-4-5-20250929";
const MAX_SCHEMA_BYTES = 64 * 1024;
const MAX_OPTIONAL_PARAMS = 24;   // API 한도: 요청당 optional parameter 합계
const ALLOWED_KEYS = new Set(["type", "properties", "required", "additionalProperties", "enum", "const", "pattern", "items", "description", "minItems", "title"]);

export async function handleWrite(request, env, fetchImpl) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: "invalid_json", message: "요청 형식이 올바르지 않습니다." }, 400);
  }

  const hasSchema = body && body.output_schema !== undefined;
  if (hasSchema) {
    const problems = validateOutputSchema(body.output_schema);
    if (problems.length) return json({ error: "invalid_schema", message: "output_schema가 structured outputs 계약을 따르지 않습니다.", problems }, 400);
  }
  if (body && body.max_tokens !== undefined && !(Number.isInteger(body.max_tokens) && body.max_tokens >= 256 && body.max_tokens <= 16000)) {
    return json({ error: "invalid_max_tokens", message: "max_tokens는 256~16000 정수여야 합니다." }, 400);
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

  const upstream = buildUpstreamBody(body, env);

  try {
    const res = await fetchImpl("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(upstream),
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

    if (hasSchema) {
      // 끝까지 생성된 응답만 schema 준수로 인정한다(max_tokens 도달·refusal이면 schema를 만족하지 않을 수 있음)
      if (data.stop_reason !== "end_turn") {
        return json({ error: "structured_incomplete", message: "structured output이 끝까지 생성되지 않았습니다: " + data.stop_reason, stop_reason: data.stop_reason }, 502);
      }
      return json({ text, structured: true, model: upstream.model, stop_reason: data.stop_reason, schema_sha256: await sha256Hex(JSON.stringify(body.output_schema)) });
    }
    return json({ text });
  } catch (e) {
    return json({ error: "network_error", message: String((e && e.message) || e) }, 502);
  }
}

// Anthropic 요청 본문(schema가 있으면 output_config.format으로 그대로 전달 — 변형하지 않음)
export function buildUpstreamBody(body, env) {
  const hasSchema = body.output_schema !== undefined;
  const upstream = {
    model: hasSchema ? (env.CLAUDE_STRUCTURED_MODEL || STRUCTURED_DEFAULT_MODEL) : (env.CLAUDE_MODEL || "claude-sonnet-4-5"),
    max_tokens: body.max_tokens || 4096,
    messages: [{ role: "user", content: String(body.prompt) }],
  };
  if (hasSchema) upstream.output_config = { format: { type: "json_schema", schema: body.output_schema } };
  return upstream;
}

// structured outputs가 지원하는 JSON Schema 부분집합 검사(공식 문서의 제한: minLength/maxLength/maxItems/uniqueItems/수치 제약 미지원,
// minItems는 0·1만, pattern의 lookaround·backreference·\b 미지원, object는 additionalProperties:false 필수, optional parameter ≤ 24)
export function validateOutputSchema(schema) {
  const problems = [];
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return ["output_schema must be an object"];
  if (JSON.stringify(schema).length > MAX_SCHEMA_BYTES) problems.push("output_schema too large");
  if (schema.type !== "object") problems.push("root must be type object");
  let optional = 0;
  (function walk(node, at) {
    if (!node || typeof node !== "object" || Array.isArray(node)) { problems.push(at + ": schema node must be an object"); return; }
    Object.keys(node).forEach((k) => { if (!ALLOWED_KEYS.has(k)) problems.push(at + ": unsupported keyword '" + k + "'"); });
    if (node.type === "object") {
      if (node.additionalProperties !== false) problems.push(at + ": additionalProperties must be false");
      const props = node.properties || {};
      const req = Array.isArray(node.required) ? node.required : [];
      req.forEach((r) => { if (!(r in props)) problems.push(at + ": required '" + r + "' is not a property"); });
      Object.keys(props).forEach((p) => { if (req.indexOf(p) === -1) optional++; walk(props[p], at + "." + p); });
    }
    if (node.type === "array") { if (!node.items) problems.push(at + ": array needs items"); else walk(node.items, at + "[]"); }
    if (node.minItems !== undefined && node.minItems !== 0 && node.minItems !== 1) problems.push(at + ": minItems must be 0 or 1");
    if (node.pattern !== undefined) {
      if (typeof node.pattern !== "string") problems.push(at + ": pattern must be a string");
      else if (/\(\?[=!]|\(\?<[=!]|\\[1-9]|\\[bB]/.test(node.pattern)) problems.push(at + ": pattern uses lookaround/backreference/word boundary");
    }
    if (node.enum !== undefined && (!Array.isArray(node.enum) || node.enum.some((v) => v !== null && typeof v === "object"))) problems.push(at + ": enum must be a list of scalars");
  })(schema, "$");
  if (optional > MAX_OPTIONAL_PARAMS) problems.push("too many optional parameters: " + optional + " > " + MAX_OPTIONAL_PARAMS);
  return problems;
}

async function sha256Hex(str) {
  const data = new TextEncoder().encode(str);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
