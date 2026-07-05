# Neville's Song Stripper — plan

## What it does

Paste a YouTube link, tap one button, get an MP3 back with the lead
vocal removed and everything else — instruments and backing/harmony
vocals — left intact.

## How the two hard problems get solved

1. **Getting audio off YouTube.** `yt-dlp` (free, open source) pulls the
   best audio stream. No API key, no per-call cost.
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

- **Frontend — Vercel.** A single Next.js page (`web/`). One input, one
  button, one download link at a time. No accounts, no settings menu.
- **Backend — Modal.** A Python serverless app (`modal_app/app.py`) that
  does `yt-dlp` → `ffmpeg` → UVR karaoke separation → `ffmpeg` mp3, and
  exposes it over HTTP. Modal scales to zero between requests — no idle
  server bill — and gives ~$30/month free credit, which comfortably covers
  one household's occasional use. **Vercel alone can't run this part**:
  its serverless functions can't hold multi-GB ML model files, run
  PyTorch/ONNX inference, or run for the several minutes separation takes.
  Splitting frontend (Vercel) from heavy compute (Modal) is what makes
  "cheap cheap cheap" and "runs on Vercel" both true at once.
- **Delivery.** Plain MP3 download link — no Google Drive API integration.
  Tapping download on Android/ChromeOS already offers "Save to Drive" from
  the native share sheet, with zero OAuth setup, zero token-expiry
  surprises for Neville.
- **Access.** Unlisted link only, no PIN (your call). Worth revisiting if
  the link ever gets shared beyond the household.

## Known limitation: YouTube blocking cloud IPs

yt-dlp downloads sometimes fail (`Video unavailable`, `HTTP Error 403`)
regardless of the specific song or video — this is YouTube's anti-bot
system flagging Modal's (or any cloud provider's) IP address, not a bug in
this app. It's tested identically across multiple videos and every
internal yt-dlp "client" mode. Mitigations already in place: yt-dlp is
always installed unpinned (gets fixes as soon as they ship), a JS runtime
(deno) is installed in the image since yt-dlp increasingly needs one, and
`formats=missing_pot` tells it to still try even without YouTube's newer
proof-of-origin token. None of these fix a genuine IP-reputation block.

If failures are frequent, the standard next step is passing yt-dlp a
`cookies.txt` exported from a real, logged-in browser session (via a
Modal Secret, never committed to the repo) — authenticated requests get
much more lenient treatment than anonymous datacenter traffic. Not built
yet since it needs a real browser session to export from and has to be
refreshed occasionally; worth doing if this keeps happening.

Check `modal app logs neville-song-stripper` (or the Logs tab in Modal's
dashboard) for the real yt-dlp/ffmpeg output on any failure — every stage
of the pipeline logs there now.

## Legal/ethical note

Downloading YouTube audio for personal, non-shared use is common
hobbyist practice but technically against YouTube's Terms of Service.
Keeping this private — not published anywhere, not a public product,
output files not redistributed — keeps the risk essentially theoretical.

## Build order

1. ~~Confirm the karaoke separation model exists and its API matches what
   the code expects~~ — done (see `modal_app/app.py` comments).
2. ~~Backend pipeline as Modal app~~ — done, needs deployment.
3. ~~One-page frontend in the theme~~ — done, needs deployment.
4. Deploy `modal_app/app.py` to Modal, get its web URL.
5. Deploy `web/` to Vercel with `NEXT_PUBLIC_STRIPPER_API_URL` set to that
   URL. See `README.md` for exact steps.
6. Test the real end-to-end tap-to-download flow on Neville's actual
   device.
