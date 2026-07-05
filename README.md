# Neville's Song Stripper

Paste a YouTube link, get an MP3 back with the lead vocal removed and
everything else — instruments, backing/harmony vocals — intact.

See `PLAN.md` for the full architecture writeup. This file is just the
setup steps to get it live.

## Layout

- `web/` — the frontend (Next.js). Deploys to Vercel.
- `modal_app/app.py` — the separation pipeline (yt-dlp → UVR karaoke
  model → mp3). Deploys to Modal.

## 1. Deploy the backend to Modal

You'll need a free Modal account (you don't have one yet — this covers it).

```bash
pip install modal
modal setup          # opens a browser to log in / create an account
modal deploy modal_app/app.py
```

When it finishes, it prints a URL that looks like:

```
https://your-username--neville-song-stripper-web.modal.run
```

That's your API base URL — copy it, you need it in the next step.

**First-run note:** the first request after deploying will be slow
(downloading the ~200MB separation model), then fast on every request
after that since Modal keeps it cached.

**If deploy fails on the model name:** the karaoke model catalog in the
`audio-separator` library occasionally gets renamed on upgrade. If you see
an error mentioning `KARAOKE_MODEL`, run this to see what's currently
available and swap the constant near the top of `modal_app/app.py`:

```bash
pip install "audio-separator[cpu]"
python3 -c "from audio_separator.separator import Separator; import json; print(list(Separator().list_supported_model_files()['MDXC'].keys()))"
```

Anything with "Karaoke" in the name works the same way — it removes the
lead vocal and keeps the rest.

## 2. Deploy the frontend to Vercel

1. Import this repo into Vercel.
2. Set the project's **Root Directory** to `web`.
3. Add an environment variable:
   - `NEXT_PUBLIC_STRIPPER_API_URL` = the Modal URL from step 1 (no
     trailing slash).
4. Deploy.

That's it — Vercel will build and host the one page; it calls your Modal
URL directly from the browser, so there's nothing else to wire up.

## 3. Try it

Open the Vercel URL, paste a real YouTube song link, tap **Remove the
singer**, wait a minute or two, tap **Download MP3**. On Android/ChromeOS
the share sheet on that download already offers "Save to Drive" — no
extra setup needed for that part.

## Cost expectations

- Vercel: free hobby tier.
- Modal: pay-per-use, scales to zero between requests. Modal's free
  monthly credit (~$30) should comfortably cover occasional personal use
  on CPU. If songs feel too slow, Modal also supports adding a GPU to the
  `run_pipeline` function for a small per-second cost — see the `gpu=`
  parameter on `@app.function` in Modal's docs.
