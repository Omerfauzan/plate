# Plate AI worker

A small Cloudflare Worker that sits between the Plate app and the AI. It:

- holds the Gemini API key as a secret (it never goes in the app or this repo)
- only answers requests from the Plate website
- asks the AI for strict JSON (food items with kcal, protein, fat, carbs, a range and the assumption made), then checks the numbers before sending them back
- limits AI use to 30 requests per device per day, 60 per IP address, and 300 for the whole app per day, so nobody can burn through the free quota

Everything is free: the Cloudflare free plan and the Gemini API free tier.

> Heads up: on Gemini's free tier, Google may use what's sent to improve its products. Plate only sends the food text you type (plus matching foods from your list), never your name, weight or log, and the app tells users this before the first AI use.

---

## Setup (about 15 minutes, all in the browser)

Menu names on these sites move around a bit. If a button isn't exactly where it says, look for the closest match.

### 1. Get a Gemini API key

1. Go to **https://aistudio.google.com** and sign in with your Google account.
2. Click **Get API key** (left side).
3. Click **Create API key**. If it asks for a project, let it create one.
4. Click **Copy**. Keep the tab open, you'll paste it in step 5.
   Don't paste it anywhere else: not in chat, not in the code, not in a note in the repo.

### 2. Make a Cloudflare account

1. Go to **https://dash.cloudflare.com/sign-up** and sign up (free plan, no card needed).
2. Confirm your email.

### 3. Create the Worker

1. In the Cloudflare dashboard, open **Workers & Pages** in the left menu (it can be under **Compute**).
2. Click **Create** → **Create Worker** (or **Start with Hello World!**).
3. Name it **`plate-ai`** and click **Deploy**.
4. Click **Edit code**.
5. Delete everything in the editor. Open [`worker.js`](worker.js) in this repo, copy all of it, and paste it in.
6. Click **Deploy** (top right).

### 4. Create the KV store for the daily limits

1. In the left menu, open **Storage & Databases** → **KV** (can also be under **Workers & Pages** → **KV**).
2. Click **Create** (or **Create a namespace**), name it **`plate-limits`**, click **Add** / **Create**.
3. Go back to **Workers & Pages** → **plate-ai** → **Settings** → **Bindings**.
4. Click **Add** → **KV namespace**.
5. Variable name: **`LIMITS`** (exactly, capitals). KV namespace: **plate-limits**. Click **Save** / **Deploy**.

### 5. Add the Gemini key as a secret

1. Still in **plate-ai** → **Settings** → **Variables and Secrets**, click **Add**.
2. Type: **Secret**.
3. Variable name: **`GEMINI_API_KEY`**.
4. Value: paste the key from step 1.
5. Click **Deploy** / **Save**.

### 6. Check it works

1. In **plate-ai**, find the URL near the top, something like `https://plate-ai.yourname.workers.dev`.
2. Open it in a browser. You should see `{"ok":true,"app":"plate-ai"}`.
3. Send me that URL. It isn't secret, so it's fine to paste in chat and put in the app.
4. Now open the same URL with **`/check`** on the end, e.g. `https://plate-ai.yourname.workers.dev/check`. This tests the key and the model without using any of your daily AI quota.
   - `"ok":true` means it's all working.
   - `"key_set":false` means the `GEMINI_API_KEY` secret is missing or misspelled.
   - `"limits_bound":false` means the `LIMITS` KV binding is missing (step 4).
   - Under `models`, `"problem"` shows what Google said, e.g. `API key not valid` (copy the key again from AI Studio) or `not found` (the model name changed; the worker already falls back to `gemini-flash-latest`).

## If the app says "The AI didn't work this time"

The message ends with the reason in brackets, straight from Google. Open `/check` (above) to see the same thing. You can also see every error in Cloudflare: **plate-ai** → **Logs** (or **Observability**) → **Begin log stream**, then try again in the app.

That's it.

---

## Optional settings

In **plate-ai** → **Settings** → **Variables and Secrets**, add any of these as plain **Text** variables:

| Name | Default | What it does |
|---|---|---|
| `DEVICE_LIMIT` | `30` | AI requests per device per day |
| `IP_LIMIT` | `60` | AI requests per IP address per day (stops someone faking device IDs) |
| `DAILY_LIMIT` | `300` | AI requests for everyone combined per day |
| `GEMINI_MODEL` | `gemini-flash-latest` | Which Gemini model to use. The default always points at Google's current Flash model; if it fails the worker tries `gemini-2.5-flash` |
| `ALLOWED_ORIGINS` | `https://omerfauzan.github.io` | Websites allowed to use the worker (comma separated). Localhost always works for testing. |
| `PROVIDER` | `gemini` | Set to `claude` to switch to the Claude API |
| `CLAUDE_MODEL` | `claude-haiku-5-5` | Which Claude model to use |

The limits reset at midnight UTC (11 am Sydney time in summer). Cloudflare's free KV allows 1,000 writes a day and each AI request uses up to 3, so keep `DAILY_LIMIT` at 300 or less on the free plan.

### Switching to Claude later

1. Get a key from **https://console.anthropic.com** → **API keys**.
2. Add it as a **Secret** called `CLAUDE_API_KEY`.
3. Add a Text variable `PROVIDER` = `claude`.

The app doesn't change at all. It talks to the worker the same way.

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

Errors come back as `{ "error": "...", "detail": "..." }` (detail is the reason, never the key): `limit` (429, daily limit hit), `busy` (503, AI provider busy), `not_set_up` (key missing), `ai_failed`, `bad_text`, `origin`.
