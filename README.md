# Neville's Song Stripper

Upload a song file, get an MP3 back with the lead vocal removed and
everything else — instruments, backing/harmony vocals — intact.

See `PLAN.md` for the full architecture writeup (including why this is
upload-based rather than a pasted YouTube link — short version: YouTube
actively blocks cloud servers trying to download from it, and that fight
wasn't winnable). This file is just the setup steps to get it live —
**iPad/browser-only path first**, terminal path further down if you ever
have a real computer handy.

## Layout

- `web/` — the frontend (Next.js). Deploys to Vercel.
- `modal_app/app.py` — the separation pipeline (upload → UVR karaoke
  model → mp3). Deploys to Modal.
- `.github/workflows/deploy-modal.yml` — runs `modal deploy` for you on
  GitHub's servers, so nothing has to run on your own device.

## 1. Deploy the backend to Modal — from just a browser

Modal's login normally wants a CLI + local browser. Skip that entirely by
creating an API token instead (pure web page) and letting GitHub Actions
do the deploy.

1. On your iPad, go to **modal.com**, sign up free (GitHub/Google login
   is fine).
2. In the Modal dashboard, go to **Settings → API Tokens** → **New Token**.
   It shows a **Token ID** and **Token Secret** once — keep that page open,
   you need both in the next step.
3. Go to this repo on **github.com** → **Settings → Secrets and variables
   → Actions** → **New repository secret**. Add two:
   - `MODAL_TOKEN_ID` = the Token ID from step 2
   - `MODAL_TOKEN_SECRET` = the Token Secret from step 2
4. Go to the **Actions** tab of this repo → **Deploy Modal backend** in
   the left sidebar → **Run workflow** → pick the
   `claude/neville-vocal-removal-site-g6luhi` branch → **Run workflow**.
5. Wait a minute or two, then open the completed run and scroll to the
   **job summary** at the top — it prints the live Modal URL, formatted
   for copy-paste, e.g.:

   ```
   https://your-username--neville-song-stripper-web.modal.run
   ```

   Copy that — you need it in the next step.

**First song after deploying will be slow** (a few extra minutes to
download the ~1-2GB separation model once); every song after that reuses
the cached model and goes back to the normal 1-4 minutes.

**If the deploy step fails mentioning `KARAOKE_MODEL`:** the model catalog
in the `audio-separator` library occasionally gets renamed on upgrade.
Edit `modal_app/app.py` directly on github.com (pencil icon on the file →
edit in browser → commit to this branch), swap in another model name with
"Karaoke" in it, and re-run the workflow. `PLAN.md` has more detail on
picking one.

## 2. Deploy the frontend to Vercel

All web UI, no terminal needed either way:

1. Import this repo into Vercel.
2. Set the project's **Root Directory** to `web`.
3. Add an environment variable:
   - `NEXT_PUBLIC_STRIPPER_API_URL` = the Modal URL from step 1 (no
     trailing slash).
4. Deploy.

Vercel builds and hosts the one page; it calls your Modal URL directly
from the browser, so there's nothing else to wire up.

## 3. Try it

Open the Vercel URL, tap **Tap to choose a file**, pick a song file
already on the device, tap **Remove the singer**, wait, tap **Download
MP3**. On Android/ChromeOS the share sheet on that download already
offers "Save to Drive" — no extra setup needed for that part.

## Cost expectations

- Vercel: free hobby tier.
- GitHub Actions: free tier minutes comfortably cover the occasional
  minute-long deploy job.
- Modal: pay-per-use, scales to zero between requests. Modal's free
  monthly credit (~$30) should comfortably cover occasional personal use
  on CPU.

## Alternative: deploying from an actual terminal

If you ever get access to a real computer, this is more direct than the
GitHub Actions path above:

```bash
pip install modal
modal setup          # opens a browser to log in / create an account
modal deploy modal_app/app.py
```

It prints the same kind of `*.modal.run` URL — use it the same way in
Vercel's environment variable.
