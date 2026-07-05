# Neville's Song Stripper

Paste a YouTube link, get an MP3 back with the lead vocal removed and
everything else — instruments, backing/harmony vocals — intact.

See `PLAN.md` for the full architecture writeup. This file is just the
setup steps to get it live — **iPad/browser-only path first**, terminal
path further down if you ever have a real computer handy.

## Layout

- `web/` — the frontend (Next.js). Deploys to Vercel.
- `modal_app/app.py` — the separation pipeline (yt-dlp → UVR karaoke
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
4. Go to the **Actions** tab of this repo. You should already see one run
   of **"Deploy Modal backend"** (it auto-ran when this workflow file was
   pushed, before you'd added the secrets, so it'll be marked failed ❌ —
   that's expected). Open that run and tap **Re-run all jobs** in the top
   right, now that the secrets are in place.
   - If you don't see that run for some reason, open the **Actions** tab →
     **Deploy Modal backend** in the left sidebar → **Run workflow** →
     pick the `claude/neville-vocal-removal-site-g6luhi` branch → **Run
     workflow**.
5. Wait a few minutes (the first deploy builds the container image), then
   open the completed run and scroll to the **job summary** at the top —
   it prints the live Modal URL, formatted for copy-paste, e.g.:

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

## 1b. Give it YouTube cookies (needed for reliable downloads)

YouTube blocks anonymous requests from cloud servers like Modal's with
`Sign in to confirm you're not a bot` / `LOGIN_REQUIRED`. The only real
fix is passing yt-dlp cookies from an actual logged-in browser session.
This part needs *some* non-iPad browser once (a library computer, a
friend's laptop, anything — it doesn't need to be a device you own) since
iPad Safari can't export these particular cookies. Everything else below
is iPad-friendly.

**Recommended:** use a spare/throwaway Google account for this rather
than your main one — it's the account whose session gets used for every
download, and there's some chance of it getting rate-limited or flagged.

1. On a desktop browser (Chrome, Firefox, or Edge), install a cookie
   export extension — search the browser's extension store for
   **"Get cookies.txt LOCALLY"** (a well-known, widely used one).
2. Go to **youtube.com**, sign in with the account you're using for this.
3. Click the extension's icon → export/download cookies for
   `youtube.com`. You get a `cookies.txt` file.
4. Open that file in a text editor, select all, copy it.
5. Back on your iPad (or wherever): go to **modal.com** → your workspace
   dashboard → **Secrets** → **New Secret**.
6. Create a secret named exactly `youtube-cookies` with one key:
   - Key: `COOKIES_TXT`
   - Value: paste the entire contents of the cookies.txt file
7. Save it.
8. Re-run the "Deploy Modal backend" GitHub Action (same as step 4 in
   section 1 above) so the app picks up the secret.

**When downloads start failing again after a while:** cookies expire
(usually after weeks to months). Repeat steps 1-7 with a fresh export —
same secret name, it just overwrites the old value.

**If you skip this step entirely:** the app still runs, but yt-dlp will
likely hit YouTube's bot-check on most real songs and show a clear error
saying so — nothing crashes, downloads just won't reliably work until
cookies are added.

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

Open the Vercel URL, paste a real YouTube song link, tap **Remove the
singer**, wait, tap **Download MP3**. On Android/ChromeOS the share sheet
on that download already offers "Save to Drive" — no extra setup needed
for that part.

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
