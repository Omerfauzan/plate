# Plate AI worker

A small Cloudflare Worker that sits between the Plate app and the AI (Claude Haiku). It:

- holds the Claude API key as a secret (it never goes in the app or this repo)
- only answers requests from the Plate website
- asks Claude for strict JSON (food items with kcal, protein, fat, carbs, a range and the assumption made) using structured outputs, then checks the numbers before sending them back
- limits AI use to 30 requests per device per day, 60 per IP address, and 300 for the whole app per day, so nobody can run up the bill

Cost: Cloudflare is free. Claude Haiku 5.5 costs $0.10 per million input tokens and $0.50 per million output tokens. One food entry is roughly 1,500 tokens in and 500 out, so about **$0.0004 per entry (around 40 cents per 1,000)**. At the full 300-a-day cap that's about $3.60 a month.

Plate only sends the food text you type (plus matching foods from your list), never your name, weight or log, and the app tells users this before the first AI use.

---

## Setup (all in the browser)

Menu names on these sites move around a bit. If a button isn't exactly where it says, look for the closest match.

### 1. Get a Claude API key

1. Go to **https://console.anthropic.com** and sign up or log in.
2. Add some credit: **Settings** → **Billing** → **Buy credits** (a few dollars lasts a long time at these prices).
3. Optional but smart: **Settings** → **Limits** → set a monthly **spend limit** (e.g. $5), so it can never surprise you.
4. Go to **API keys** → **Create key**. Name it `plate-ai`.
5. Click **Copy**. Keep the tab open, you'll paste it in step 5.
   Don't paste it anywhere else: not in chat, not in the code, not in a note in the repo. You can't see it again after closing, but you can always make a new one.

### 2. Make a Cloudflare account

1. Go to **https://dash.cloudflare.com/sign-up** and sign up (free plan, no card needed).
2. Confirm your email.

### 3. Create the Worker

1. In the Cloudflare dashboard, open **Workers & Pages** in the left menu (it can be under **Compute**).
2. Click **Create** → **Create Worker** (or **Start with Hello World!**).
3. Name it **`plate-ai`** and click **Deploy**.
4. Click **Edit code** (top right of the Worker page).
5. Delete everything in the editor. Open [the raw `worker.js`](https://raw.githubusercontent.com/Omerfauzan/plate/main/worker/worker.js), press Ctrl+A, Ctrl+C, and paste it in.
6. Click **Deploy** (top right). "Version saved" is not enough, it has to say deployed.

### 4. Create the KV store for the daily limits

1. In the left menu, open **Storage & Databases** → **KV** (can also be under **Workers & Pages** → **KV**).
2. Click **Create** (or **Create a namespace**), name it **`plate-limits`**, click **Add** / **Create**.
3. Go back to **Workers & Pages** → **plate-ai** → **Settings** → **Bindings**.
4. Click **Add** → **KV namespace**.
5. Variable name: **`LIMITS`** (exactly, capitals). KV namespace: **plate-limits**. Click **Save** / **Deploy**.

### 5. Add the Claude key as a secret

1. Still in **plate-ai** → **Settings** → **Variables and Secrets**, click **Add**.
2. Type: **Secret**.
3. Variable name: **`CLAUDE_API_KEY`**.
4. Value: paste the key from step 1.
5. Click **Deploy** / **Save**.

### 6. Check it works

1. Open the worker URL (e.g. `https://plate-ai.yourname.workers.dev`). You should see `{"ok":true,"app":"plate-ai","version":6}`. The version number tells you which code is live; if it's lower than the `VERSION` at the top of `worker.js`, the new code isn't deployed yet.
2. Open the same URL with **`/check`** on the end. This tests the key and the model without using any tokens.
   - `"ok":true` means it's all working.
   - `"key_set":false` means the `CLAUDE_API_KEY` secret is missing or misspelled.
   - `"limits_bound":false` means the `LIMITS` KV binding is missing (step 4).
   - `"problem"` shows what Anthropic said, e.g. `authentication_error` (copy the key again, or make a new one).

## If the app says "The AI didn't work this time"

The message ends with the reason in brackets. You can also see every request in Cloudflare: **plate-ai** → **Observability** → click a request to open it. Each one logs lines like `plate-ai v6 parse`, `asking claude claude-haiku-5-5`, then `claude claude-haiku-5-5 200 2400ms` or the error.

If it says your credit ran out (`billing` / `credit balance`), top up in the Anthropic console.

---

## Optional settings

In **plate-ai** → **Settings** → **Variables and Secrets**, add any of these as plain **Text** variables:

| Name | Default | What it does |
|---|---|---|
| `DEVICE_LIMIT` | `30` | AI requests per device per day |
| `IP_LIMIT` | `60` | AI requests per IP address per day (stops someone faking device IDs) |
| `DAILY_LIMIT` | `300` | AI requests for everyone combined per day |
| `CLAUDE_MODEL` | `claude-haiku-5-5` | Which Claude model to use. `claude-sonnet-5-5` is smarter but about 20 times the price |
| `ALLOWED_ORIGINS` | `https://omerfauzan.github.io` | Websites allowed to use the worker (comma separated). Localhost always works for testing. |
| `PROVIDER` | `claude` | Set to `gemini` to use Google Gemini instead (needs a `GEMINI_API_KEY` secret) |
| `GEMINI_MODEL` | `gemini-flash-latest` | Only used when `PROVIDER` is `gemini` |

The limits reset at midnight UTC (11 am Sydney time in summer). Cloudflare's free KV allows 1,000 writes a day and each AI request uses up to 3, so keep `DAILY_LIMIT` at 300 or less on the free plan.

### Updating the worker

When `worker.js` changes in the repo: **plate-ai** → **Edit code** → select all, paste the new version → **Deploy**. Your key and settings stay put.

---

## What the app sends and gets back

`POST` to the worker URL:

```json
{
  "mode": "parse",
  "text": "2 noshu bars, half chicken from El Jannah",
  "device": "random-id-made-on-the-phone",
  "known": [{ "ref": "k0", "name": "Noshu bar", "said": "2 noshu bars", "portion": "2 bar", "kcal": 260, "p": 3.2, "f": 20.4, "c": 7.2 }],
  "saved": []
}
```

- `known`: parts the app already matched from your food list. The AI must keep them as they are.
- `saved`: other foods from your list that might be relevant.
- For "fix in words", `mode` is `"fix"`, `text` is the instruction, `original` is the first text and `items` is the current list.

Reply:

```json
{
  "items": [
    { "name": "Noshu bar", "said": "2 noshu bars", "qty": 2, "unit": "bar", "grams": 64,
      "kcal": 260, "p": 3.2, "f": 20.4, "c": 7.2, "lo": 250, "hi": 270,
      "assumption": "from your list", "ref": "k0", "changed": false }
  ],
  "note": "",
  "left": 29
}
```

Errors come back as `{ "error": "...", "detail": "..." }` (detail is the reason, never the key): `limit` (429, daily limit hit), `busy` (503, AI provider busy), `slow` (504, AI took over 25 s), `not_set_up` (key missing), `ai_failed`, `bad_text`, `origin`.
