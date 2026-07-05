# Neville's Song Stripper — plan

## What it does

Upload a song file, tap one button, get an MP3 back with the lead vocal
removed and everything else — instruments and backing/harmony vocals —
left intact.

## History: this used to work off a pasted YouTube link

The original design took a YouTube link and used `yt-dlp` to pull the
audio server-side. That was abandoned after extensive real testing:
YouTube's anti-bot system blocks/challenges cloud IPs (Modal's, and any
other cloud provider's) hard enough that no combination of fixes held up
reliably:

1. A JS runtime (deno) - necessary but not sufficient on its own.
2. A PO token provider (`bgutil-ytdlp-pot-provider`) - genuinely helped
   (confirmed working, got a real proof-of-origin token), but YouTube
   still returned `LOGIN_REQUIRED` regardless, since that specific check
   demands an authenticated session, not just a valid token.
3. Cookies from a real, logged-in browser session - this got furthest
   (one full successful run, proving the rest of the pipeline correct),
   but the exported session got invalidated within minutes, most likely
   because Google's fraud detection flags a session cookie being used
   from a wildly different IP (a residential export vs. Modal's
   datacenter IP) and rotates it as a security response. The standard
   community mitigations (private-window export, ~2 week typical
   lifespan) don't reliably apply here for the same reason.

None of this is a bug in this app — it's YouTube's infrastructure
actively fighting exactly this kind of automated access, and winning.
Continuing to chase it would mean either a recurring paid residential
proxy (real ongoing cost, still not guaranteed) or accepting permanent
fragility. **Decision: drop server-side YouTube extraction entirely.**
Whatever legal means Zayne/Neville use to get a song onto a device is
now out of this app's scope — the app's job starts at "here's an audio
file."

## How it works now

1. **Upload.** The browser sends an audio file straight to the backend.
   No extraction, no bot-detection surface at all.
2. **Removing only the lead singer.** Plain "vocal remover" models (Spleeter,
   stock Demucs) only split vocals-vs-instrumental as one blob — they don't
   keep backing vocals. The actual fit is the "karaoke" model family from the
   Ultimate Vocal Remover (UVR) community, run via the `audio-separator`
   Python library — these are trained specifically to pull out the lead
   voice and leave backing vocals + instrumental behind. That's a free model
   file, not a paid API.

Caveat that's worth remembering: separation quality depends on the song.
Great on tracks where backing vocals are a distinct harmony/"oohs" part
(most pop/rock/soul). Weaker when lead and backup are tightly doubled on
the same line.

## Architecture (decided)

- **Frontend — Vercel.** A single Next.js page (`web/`). One file-picker,
  one button, one download link at a time. No accounts, no settings menu.
- **Backend — Modal.** A Python serverless app (`modal_app/app.py`) that
  takes an uploaded file straight to UVR karaoke separation → `ffmpeg`
  mp3, exposed over HTTP. Modal scales to zero between requests — no idle
  server bill — and gives ~$30/month free credit, which comfortably covers
  one household's occasional use. **Vercel alone can't run this part**:
  its serverless functions can't hold multi-GB ML model files, run
  PyTorch/ONNX inference, or run for the several minutes separation takes.
  Splitting frontend (Vercel) from heavy compute (Modal) is what makes
  "cheap cheap cheap" and "runs on Vercel" both true at once. This is now
  a genuinely simple image — just `ffmpeg` + the separation library, no
  Node, no browser automation, no secrets to manage.
- **Delivery.** Plain MP3 download link — no Google Drive API integration.
  Tapping download on Android/ChromeOS already offers "Save to Drive" from
  the native share sheet, with zero OAuth setup, zero token-expiry
  surprises for Neville.
- **Access.** Unlisted link only, no PIN (your call). Worth revisiting if
  the link ever gets shared beyond the household.

## Legal/ethical note

This app itself only separates a file you already have — it doesn't
download or redistribute anything. However you get that file onto a
device is between you and whatever service it came from.

## Build order

1. ~~Confirm the karaoke separation model exists and its API matches what
   the code expects~~ — done (see `modal_app/app.py` comments).
2. ~~YouTube-link based pipeline~~ — built, tested extensively, abandoned
   due to YouTube's IP/bot blocking (see History above).
3. ~~File-upload based pipeline~~ — done, needs deployment.
4. ~~One-page frontend in the theme~~ — done, needs deployment.
5. Deploy `modal_app/app.py` to Modal, get its web URL.
6. Deploy `web/` to Vercel with `NEXT_PUBLIC_STRIPPER_API_URL` set to that
   URL. See `README.md` for exact steps.
7. Test the real end-to-end tap-to-download flow on Neville's actual
   device, with a real song file.
