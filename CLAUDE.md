# Plate: notes for Claude

Plate is a calorie and macro tracker web app (installable PWA), heading for the App Store later.

## The app
- Live at https://omerfauzan.github.io/plate/ via GitHub Pages from `main`.
- Plain HTML/CSS/JS in one `index.html`, plus `sw.js` (offline cache), `manifest.webmanifest` and icons. No frameworks, no build step.
- Data lives in `localStorage` under keys starting with `plate-`, with backup and restore as copyable JSON. No accounts yet.
- Features:
  - guided setup (BMR via Mifflin-St Jeor, suggested targets)
  - Today view: calorie ring, macro bars, "est" burn breakdown, week strip, meals grouped Meal 1 / Meal 2 / Snack, quick add, copy meal to today, weight / steps / gym per day
  - Stats: week / month / all time, 7-day average, running deficit, weight trend, macro split, weekday averages, top foods, "Worth a look" insights with a scale-vs-estimate check
  - Settings: targets, burn numbers, Auto / Light / Dark theme
  - AI food entry (step 1, built): Add food takes plain words. Pieces that match My foods (`S.mine`) or the built-in `foods.json` are scaled locally with no AI; the rest go to the Cloudflare Worker in `worker/`. Review, edit, "fix in words", confirm saves to My foods. Worker URL goes in `AI_URL_DEFAULT` in `index.html` (`plate-ai-url` in localStorage overrides it for testing).
- Burn = BMR x 1.2 + standing extra + max(0, steps - 3000) x kcal per step + gym. On target = within +/-10%. Fat change = deficit / 7700.

## AI rules
- Use the Gemini API free tier for now, with the provider switchable to the Claude API later.
- Never put any API key in the website or the repo. Keys live only in a Cloudflare Worker as a secret. Omer adds keys himself and never pastes them in chat.
- The app must tell users that food descriptions go to an AI service, and that all numbers are estimates, not medical advice.
- Never commit anyone's personal food logs or backups to this public repo.

## Roadmap
- Step 1: AI food entry. Type what you ate in plain words, get items with kcal, macros, assumptions and a range, edit, then confirm. Confirmed foods go into a personal food list. Seed a built-in list of common Australian takeaway and supermarket foods.
- Step 2 (later): App Store launch with accounts, cloud sync, React Native / Expo, a privacy policy and probably a subscription. Design step 1 so it carries over.

## How to work with Omer
- Go step by step and check before big decisions. Show the plan first.
- Make code and files ready to use as-is. Keep explanations casual and simple, not AI-sounding.
- Be honest and direct, and say so if an idea won't work.
- Test at phone width (about 390px) before pushing: add, edit, delete, reload to check data stays, light and dark mode, and AI flows with a mocked response.
- Bump the `CACHE` version in `sw.js` on every change to `index.html`.
- Commits: lowercase, natural-sounding subjects, each with a proper description of what changed and why. Keep `README.md` updated.
