// Netlify Function: /.netlify/functions/generate
// Calls Google Gemini with the key stored in Netlify (GEMINI_API_KEY).
// The key never reaches the browser. No npm packages needed (Node 18+ global fetch).

const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models/";
// Main model + a lighter backup if the main one is busy or over its free limit.
const MODELS = [
  { name: (process.env.GEMINI_MODEL || "gemini-3.8-flash"), thinking: "LOW" },
  { name: "gemini-3.5-flash-lite", thinking: "MINIMAL" },
];
const TIMEOUT_MS = 45000; // Netlify allows 60 s for a normal function

const MSG = {
  noKey: "المفتاح غير مضاف في إعدادات Netlify",
  badKey: "مفتاح Gemini غير صحيح. انسخه من جديد من Google AI Studio وحطه في إعدادات Netlify.",
  quota: "وصلنا للحد المجاني لطلبات الذكاء الاصطناعي حالياً. جرّب بعد دقيقة.",
  busy: "خدمة الذكاء الاصطناعي مشغولة حالياً. حاول مرة أخرى بعد قليل.",
  timeout: "التوليد أخذ وقت أطول من اللازم. حاول مرة أخرى.",
  badReq: "الطلب غير مكتمل. أعد تعبئة الحقول وحاول مرة أخرى.",
  empty: "ما وصلنا رد من الذكاء الاصطناعي. حاول مرة أخرى.",
};

function json(status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

// Make sure the page always receives a plain JSON array of ideas.
function normalize(text) {
  let t = String(text || "").replace(/```json/g, "").replace(/```/g, "").trim();
  try {
    const parsed = JSON.parse(t);
    if (Array.isArray(parsed)) return JSON.stringify(parsed);
    if (parsed && typeof parsed === "object") {
      const arr = Object.values(parsed).find(Array.isArray);
      if (arr) return JSON.stringify(arr);
    }
  } catch (e) { /* leave as is; the page will show its error */ }
  return t;
}

async function callGemini(model, key, systemPrompt, userPrompt, withThinking) {
  const generationConfig = { responseMimeType: "application/json", temperature: 1, maxOutputTokens: 8192 };
  if (withThinking && model.thinking) generationConfig.thinkingConfig = { thinkingLevel: model.thinking };
  const body = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: "user", parts: [{ text: userPrompt }] }],
    generationConfig,
  };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(API_BASE + encodeURIComponent(model.name) + ":generateContent", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  } finally {
    clearTimeout(timer);
  }
}

export default async (req) => {
  if (req.method !== "POST") return json(405, { error: badMethodMsg() });

  const key = process.env.GEMINI_API_KEY;
  if (!key || !key.trim()) return json(500, { error: MSG.noKey });

  let systemPrompt, userPrompt;
  try {
    ({ systemPrompt, userPrompt } = await req.json());
  } catch (e) {
    return json(400, { error: MSG.badReq });
  }
  if (typeof systemPrompt !== "string" || typeof userPrompt !== "string" || !userPrompt.trim()
      || systemPrompt.length > 10000 || userPrompt.length > 4000) {
    return json(400, { error: MSG.badReq });
  }

  let lastError = MSG.busy;
  for (const model of MODELS) {
    let r;
    try {
      r = await callGemini(model, key.trim(), systemPrompt, userPrompt, true);
      // If this model rejects the thinking setting, try once without it.
      if (r.status === 400 && /thinking/i.test(JSON.stringify(r.data))) {
        r = await callGemini(model, key.trim(), systemPrompt, userPrompt, false);
      }
    } catch (e) {
      lastError = e && e.name === "AbortError" ? MSG.timeout : MSG.busy;
      console.error("Gemini call failed", model.name, e && e.message);
      continue;
    }

    const errText = JSON.stringify(r.data && r.data.error || "");
    if (r.status === 200) {
      const parts = (((r.data.candidates || [])[0] || {}).content || {}).parts || [];
      const text = parts.filter((p) => !p.thought && typeof p.text === "string").map((p) => p.text).join("");
      if (!text.trim()) { lastError = MSG.empty; continue; }
      // Same shape the page already reads (Anthropic-style), so the render code is unchanged.
      return json(200, { content: [{ type: "text", text: normalize(text) }], model: model.name });
    }

    console.error("Gemini error", model.name, r.status, errText.slice(0, 500));
    if (/API_KEY_INVALID|API key not valid|PERMISSION_DENIED/i.test(errText) || r.status === 401 || r.status === 403) {
      return json(500, { error: MSG.badKey }); // a bad key will not work on the backup model either
    }
    if (r.status === 429) lastError = MSG.quota;
    else if (r.status === 400) lastError = MSG.badReq;
    else lastError = MSG.busy;
    // 404 (model name changed), 429, 5xx: try the backup model
  }
  return json(lastError === MSG.quota ? 429 : 502, { error: lastError });
};

function badMethodMsg() { return "طريقة الطلب غير مسموحة"; }
