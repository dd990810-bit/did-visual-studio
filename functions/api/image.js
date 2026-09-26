// POST /api/image
// multipart/form-data: prompt (string), size (string, e.g. "1024x1024"), image (0+ files, reference images),
//                       mask (optional 1 file, PNG with alpha — transparent=edit, opaque=preserve; requires exactly 1 image)
// returns: { image_base64 } on success, or { error, message } on failure
export async function onRequestPost(context) {
  const { request, env } = context;

  if (!env.OPENAI_API_KEY) {
    return json(
      { error: "missing_api_key", message: "OPENAI_API_KEY 시크릿이 설정되지 않았습니다. Cloudflare Pages 프로젝트 설정에서 추가해주세요." },
      500
    );
  }

  let form;
  try {
    form = await request.formData();
  } catch (e) {
    return json({ error: "invalid_form", message: "요청 형식이 올바르지 않습니다." }, 400);
  }

  const prompt = String(form.get("prompt") || "");
  if (!prompt.trim()) {
    return json({ error: "empty_prompt", message: "프롬프트가 비어 있습니다." }, 400);
  }

  const size = String(form.get("size") || "1024x1024");
  const refImages = form.getAll("image").filter((v) => v && typeof v !== "string");
  const maskFile = form.get("mask");
  const hasMask = maskFile && typeof maskFile !== "string";

  if (hasMask && refImages.length !== 1) {
    return json(
      { error: "invalid_mask_usage", message: "mask를 사용할 때는 image가 정확히 1장이어야 합니다." },
      400
    );
  }

  try {
    let res;

    if (refImages.length > 0) {
      const upstream = new FormData();
      upstream.append("model", "gpt-image-1");
      upstream.append("prompt", prompt);
      upstream.append("size", size);
      for (const f of refImages) {
        upstream.append("image[]", f, f.name || "reference.png");
      }
      if (hasMask) {
        upstream.append("mask", maskFile, maskFile.name || "mask.png");
      }
      res = await fetch("https://api.openai.com/v1/images/edits", {
        method: "POST",
        headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` },
        body: upstream,
      });
    } else {
      res = await fetch("https://api.openai.com/v1/images/generations", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.OPENAI_API_KEY}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "gpt-image-1", prompt, size }),
      });
    }

    const data = await res.json();

    if (!res.ok) {
      const message = (data && data.error && data.error.message) || res.statusText || "알 수 없는 오류";
      return json({ error: "upstream_error", message }, 502);
    }

    const b64 = data && data.data && data.data[0] && data.data[0].b64_json;
    if (!b64) {
      return json({ error: "no_image", message: "이미지 응답을 받지 못했습니다." }, 502);
    }

    return json({ image_base64: b64 });
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
