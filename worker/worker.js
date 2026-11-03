// Plate AI worker.
// Takes a plain-words food description from the Plate app, asks an AI model for
// items with calories and macros, checks the reply, and returns strict JSON.
// The API key lives here as a Cloudflare secret. It is never sent to the app.
//
// Settings (Cloudflare dashboard > Worker > Settings > Variables and Secrets):
//   GEMINI_API_KEY   secret, required while PROVIDER is gemini
//   CLAUDE_API_KEY   secret, only needed if PROVIDER is claude
//   PROVIDER         "gemini" (default) or "claude"
//   GEMINI_MODEL     default "gemini-2.5-flash"
//   CLAUDE_MODEL     default "claude-haiku-5-5"
//   ALLOWED_ORIGINS  comma list, default "https://omerfauzan.github.io"
//   DEVICE_LIMIT     AI requests per device per day, default 30
//   IP_LIMIT         AI requests per IP address per day, default 60
//   DAILY_LIMIT      AI requests for the whole app per day, default 300
// Binding: a KV namespace bound as LIMITS (holds the daily counters).

const MAX_TEXT = 600;
const MAX_ITEMS = 25;

const ITEM_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'Short clear food name, e.g. "Mandi rice (oily)"' },
    said: { type: 'string', description: "The user's own words for this item, copied from their text" },
    qty: { type: 'number', description: 'How many / how much, in unit' },
    unit: { type: 'string', description: 'g, ml, or a count word like bar, piece, serve, sandwich' },
    grams: { type: 'number', description: 'Estimated total edible weight in grams, 0 if unknown' },
    kcal: { type: 'number' },
    p: { type: 'number', description: 'protein g' },
    f: { type: 'number', description: 'fat g' },
    c: { type: 'number', description: 'carbs g' },
    lo: { type: 'number', description: 'low end of likely kcal range' },
    hi: { type: 'number', description: 'high end of likely kcal range' },
    assumption: { type: 'string', description: 'What you assumed, short, e.g. "~85 g each, assumed oily"' },
    ref: { type: 'string', description: 'The ref of a known item this is, else empty' },
    changed: { type: 'boolean', description: 'In fix mode: true if this item was changed by the instruction' },
  },
  required: ['name', 'said', 'qty', 'unit', 'grams', 'kcal', 'p', 'f', 'c', 'lo', 'hi', 'assumption', 'ref', 'changed'],
};
const RESULT_SCHEMA = {
  type: 'object',
  properties: {
    items: { type: 'array', items: ITEM_SCHEMA },
    note: { type: 'string', description: 'One short line for the user if something was unclear, else empty' },
  },
  required: ['items', 'note'],
};

const RULES = `You estimate calories and macros for a food tracking app used in Australia.
Return JSON only, matching the schema.

How to read the text:
- Split it into separate food items. "rice with garlic sauce" is 2 items. Sauces, sides and drinks are their own items.
- Expect typos and spelling variants (noshu/noushu, haneet/haneeth, tahari/tehari, facaccia, peices). Use the right spelling in name, but copy the user's words into said.
- Quantities can be "2", "1/2", "half", "quarter", "300 gram", "40 ml", "2 small bowl", "few pieces". "little bit" / "bit of" means a small amount, about 20 g.
- Rice and meat weights are cooked weight unless the user says raw.
- Australian labels use kJ. If the user gives kJ, kcal = kJ / 4.184. If the user gives a calorie or kJ number, use it exactly.
- Restaurant and takeaway food (El Jannah, kebab shops, mandi, HSP, Lebanese, Pakistani, Bangladeshi) is usually oilier than home cooking. Say so in assumption.
- Use typical Australian portion sizes when none is given and say what you assumed, e.g. "~85 g each" or "medium, ~330 g edible".
- p, f, c are grams for the whole item (all of qty). kcal should roughly equal 4p + 4c + 9f.
- lo and hi are a realistic kcal range for the whole item. Wider when the portion is a guess.
- assumption is short and plain, under 70 characters.
- Known items: some parts of the text may already be worked out and listed with a ref. Include each one once with that ref and its numbers exactly as given. Do not re-estimate them. If the user's saved foods list has a food they clearly mean, use its numbers (scaled to the amount) and set ref to its ref.
- Never give medical advice. If something is not food or makes no sense, skip it and say so in note.`;

function cors(origin, env) {
  const allowed = (env.ALLOWED_ORIGINS || 'https://omerfauzan.github.io').split(',').map((s) => s.trim()).filter(Boolean);
  const local = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin || '');
  const ok = origin && (allowed.includes(origin) || local);
  return {
    ok,
    headers: {
      'Access-Control-Allow-Origin': ok ? origin : allowed[0] || '',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    },
  };
}

function reply(body, status, headers) {
  return new Response(JSON.stringify(body), { status, headers: { ...headers, 'Content-Type': 'application/json' } });
}

const num = (v, max) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(max, Math.round(n * 10) / 10);
};
const str = (v, max) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);

// Keep only what we expect, in the shape we expect.
function cleanItem(o) {
  if (!o || typeof o !== 'object') return null;
  const name = str(o.name, 80);
  if (!name) return null;
  const kcal = Math.round(num(o.kcal, 6000));
  let lo = Math.round(num(o.lo, 8000));
  let hi = Math.round(num(o.hi, 8000));
  if (!lo || lo > kcal) lo = Math.round(kcal * 0.85);
  if (!hi || hi < kcal || hi > kcal * 3 + 100) hi = Math.round(kcal * 1.15);
  return {
    name,
    said: str(o.said, 120),
    qty: num(o.qty, 10000) || 1,
    unit: str(o.unit, 20) || 'serve',
    grams: Math.round(num(o.grams, 10000)),
    kcal,
    p: num(o.p, 600),
    f: num(o.f, 600),
    c: num(o.c, 900),
    lo,
    hi,
    assumption: str(o.assumption, 120),
    ref: str(o.ref, 40),
    changed: o.changed === true,
  };
}

function cleanKnown(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 20).map((k) => ({
    ref: str(k && k.ref, 40),
    name: str(k && k.name, 80),
    said: str(k && k.said, 120),
    portion: str(k && k.portion, 60),
    kcal: num(k && k.kcal, 6000),
    p: num(k && k.p, 600),
    f: num(k && k.f, 600),
    c: num(k && k.c, 900),
  })).filter((k) => k.ref && k.name);
}

function buildPrompt(body) {
  const known = cleanKnown(body.known);
  const saved = cleanKnown(body.saved);
  if (body.mode === 'fix') {
    const items = Array.isArray(body.items) ? body.items.slice(0, MAX_ITEMS).map(cleanItem).filter(Boolean) : [];
    return `FIX MODE. The user already has this list of items:
${JSON.stringify(items)}

They wrote what they ate as: ${JSON.stringify(str(body.original, MAX_TEXT))}
Now they want this change: ${JSON.stringify(str(body.text, MAX_TEXT))}

Return the whole updated list. Keep items that the change does not touch exactly as they are, with the same ref and changed=false. Set changed=true on items you add or change.${saved.length ? `\nTheir saved foods (use these numbers if one fits): ${JSON.stringify(saved)}` : ''}`;
  }
  return `The user ate: ${JSON.stringify(str(body.text, MAX_TEXT))}
${known.length ? `Already worked out (include each once with its ref, numbers unchanged): ${JSON.stringify(known)}` : 'Nothing is already worked out.'}
${saved.length ? `Their saved foods (use these numbers if one fits): ${JSON.stringify(saved)}` : ''}
Set changed=false on every item.`;
}

// ---------- providers ----------
// Both return the parsed JSON object. To switch, set PROVIDER and add that key.

function toGeminiSchema(s) {
  const out = { type: s.type.toUpperCase() };
  if (s.description) out.description = s.description;
  if (s.properties) {
    out.properties = {};
    for (const k in s.properties) out.properties[k] = toGeminiSchema(s.properties[k]);
    out.required = s.required;
    out.propertyOrdering = Object.keys(s.properties);
  }
  if (s.items) out.items = toGeminiSchema(s.items);
  return out;
}

async function askGemini(prompt, env) {
  if (!env.GEMINI_API_KEY) throw new Error('missing_key');
  const model = env.GEMINI_MODEL || 'gemini-2.5-flash';
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: RULES }] },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.2,
        responseMimeType: 'application/json',
        responseSchema: toGeminiSchema(RESULT_SCHEMA),
      },
    }),
  });
  if (res.status === 429) throw new Error('provider_busy');
  if (!res.ok) throw new Error('provider_error_' + res.status);
  const data = await res.json();
  const parts = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
  const text = parts.map((p) => p.text || '').join('');
  return JSON.parse(text);
}

async function askClaude(prompt, env) {
  if (!env.CLAUDE_API_KEY) throw new Error('missing_key');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.CLAUDE_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: env.CLAUDE_MODEL || 'claude-haiku-5-5',
      max_tokens: 2000,
      system: RULES,
      tools: [{ name: 'food_items', description: 'Return the food items', input_schema: RESULT_SCHEMA }],
      tool_choice: { type: 'tool', name: 'food_items' },
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (res.status === 429 || res.status === 529) throw new Error('provider_busy');
  if (!res.ok) throw new Error('provider_error_' + res.status);
  const data = await res.json();
  const block = (data.content || []).find((b) => b.type === 'tool_use');
  if (!block) throw new Error('bad_reply');
  return block.input;
}

// ---------- daily limits ----------
// Counters in KV, one key per device / IP / whole app per UTC day, gone after 2 days.

async function bump(env, key, limit) {
  const n = Number(await env.LIMITS.get(key)) || 0;
  if (n >= limit) return { ok: false, n };
  try {
    await env.LIMITS.put(key, String(n + 1), { expirationTtl: 172800 });
  } catch (e) {
    // KV allows about one write per second per key. Missing a count now and then is fine.
  }
  return { ok: true, n: n + 1 };
}

async function checkLimits(env, device, ip) {
  if (!env.LIMITS) return { ok: true, left: null };
  const day = new Date().toISOString().slice(0, 10);
  const lim = (v, d) => Math.max(0, Number(v) || d);
  const all = await env.LIMITS.get('all:' + day);
  if ((Number(all) || 0) >= lim(env.DAILY_LIMIT, 300)) return { ok: false, why: 'app' };
  const d = await bump(env, `d:${device}:${day}`, lim(env.DEVICE_LIMIT, 30));
  if (!d.ok) return { ok: false, why: 'device' };
  const i = await bump(env, `ip:${ip}:${day}`, lim(env.IP_LIMIT, 60));
  if (!i.ok) return { ok: false, why: 'ip' };
  await bump(env, 'all:' + day, lim(env.DAILY_LIMIT, 300));
  return { ok: true, left: Math.max(0, lim(env.DEVICE_LIMIT, 30) - d.n) };
}

// ---------- main ----------

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin');
    const c = cors(origin, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: c.ok ? 204 : 403, headers: c.headers });
    if (request.method === 'GET') return reply({ ok: true, app: 'plate-ai' }, 200, c.headers);
    if (request.method !== 'POST') return reply({ error: 'method' }, 405, c.headers);
    if (!c.ok) return reply({ error: 'origin' }, 403, c.headers);

    let body;
    try {
      const raw = await request.text();
      if (raw.length > 20000) return reply({ error: 'too_long' }, 413, c.headers);
      body = JSON.parse(raw);
    } catch (e) {
      return reply({ error: 'bad_request' }, 400, c.headers);
    }
    const text = str(body && body.text, MAX_TEXT + 1);
    const device = str(body && body.device, 64);
    if (!text || text.length > MAX_TEXT) return reply({ error: 'bad_text' }, 400, c.headers);
    if (!/^[a-z0-9-]{8,64}$/i.test(device)) return reply({ error: 'bad_device' }, 400, c.headers);

    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const lim = await checkLimits(env, device, ip);
    if (!lim.ok) return reply({ error: 'limit', why: lim.why }, 429, c.headers);

    const provider = (env.PROVIDER || 'gemini').toLowerCase();
    let out;
    try {
      const prompt = buildPrompt(body);
      out = provider === 'claude' ? await askClaude(prompt, env) : await askGemini(prompt, env);
    } catch (e) {
      const msg = String((e && e.message) || e);
      if (msg === 'provider_busy') return reply({ error: 'busy' }, 503, c.headers);
      if (msg === 'missing_key') return reply({ error: 'not_set_up' }, 500, c.headers);
      return reply({ error: 'ai_failed' }, 502, c.headers);
    }
    const items = (out && Array.isArray(out.items) ? out.items : []).slice(0, MAX_ITEMS).map(cleanItem).filter(Boolean);
    return reply({ items, note: str(out && out.note, 200), left: lim.left, provider }, 200, c.headers);
  },
};
