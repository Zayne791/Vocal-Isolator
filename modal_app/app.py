"""
Neville's Song Stripper - separation pipeline, deployed on Modal.

Flow: a YouTube link comes in -> yt-dlp pulls the audio -> a UVR
karaoke-style model splits out the lead vocal -> what's left
(instrumental + backing vocals) is converted to mp3 and handed back.

Deploy with:  modal deploy modal_app/app.py
Local test:   modal run modal_app/app.py --youtube-url "<link>"
"""

import base64

import modal

# Confirmed present in audio-separator 0.44.2's model catalog (see README for
# how that was checked). If this ever 404s after a library upgrade, run
# `Separator().list_supported_model_files()` and pick another "Karaoke" entry -
# UVR_MDXNET_KARA_2.onnx is the fallback with the same instrumental+backing-
# vocals behavior, just a slightly lower separation score.
KARAOKE_MODEL = "mel_band_roformer_karaoke_aufr33_viperx_sdr_10.1956.ckpt"

app = modal.App("neville-song-stripper")

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg", "curl", "unzip")
    .pip_install(
        "yt-dlp",
        "audio-separator[cpu]",
        "fastapi[standard]",
    )
    # yt-dlp increasingly needs a JS runtime to solve YouTube's playback
    # challenges - deno is the one it looks for by default. Doesn't fix
    # IP-reputation blocks (see YT_DLP_EXTRA_ARGS below and PLAN.md), but
    # it's a real, separate failure mode worth closing off.
    .run_commands("curl -fsSL https://deno.land/install.sh | sh -s -- -y")
    .env({"PATH": "/root/.deno/bin:$PATH"})
)

# Extra yt-dlp flags: use the JS runtime above, and don't hard-fail just
# because a PO token (YouTube's newer anti-bot proof-of-origin check)
# couldn't be minted - degraded formats are still better than nothing.
YT_DLP_EXTRA_ARGS = [
    "--js-runtimes",
    "deno",
    "--extractor-args",
    "youtube:formats=missing_pot",
]

# Modal spins up a fresh container per call - without this, every single
# song would re-download the ~1-2GB separation model from scratch. This
# volume persists that download across calls, so only the very first run
# after a deploy pays the download cost.
model_cache = modal.Volume.from_name("neville-song-stripper-models", create_if_missing=True)
MODEL_CACHE_DIR = "/cache/audio-separator-models"


def _tail_error(text: str) -> str:
    """Pull the most useful line out of a CLI tool's stderr for the UI."""
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    error_lines = [line for line in lines if line.upper().startswith("ERROR")]
    if error_lines:
        return error_lines[-1]
    return lines[-1] if lines else "no error output"


@app.function(
    image=image,
    timeout=900,
    cpu=4,
    memory=4096,
    volumes={"/cache": model_cache},
)
def run_pipeline(youtube_url: str) -> dict:
    import glob
    import os
    import subprocess
    import sys
    import tempfile

    from audio_separator.separator import Separator

    def log(message: str) -> None:
        # Shows up in `modal app logs neville-song-stripper` and the Modal
        # dashboard's Logs tab for this app.
        print(f"[{youtube_url}] {message}", flush=True, file=sys.stderr)

    work_dir = tempfile.mkdtemp()
    input_template = os.path.join(work_dir, "input.%(ext)s")

    log("Starting yt-dlp download")
    download = subprocess.run(
        [
            "yt-dlp",
            "-x",
            "--audio-format",
            "wav",
            "--no-playlist",
            *YT_DLP_EXTRA_ARGS,
            "-o",
            input_template,
            youtube_url,
        ],
        capture_output=True,
        text=True,
    )
    log(f"yt-dlp exited {download.returncode}")
    if download.stdout:
        log(f"yt-dlp stdout tail:\n{download.stdout[-2000:]}")
    if download.stderr:
        log(f"yt-dlp stderr tail:\n{download.stderr[-2000:]}")

    if download.returncode != 0:
        raise RuntimeError(
            "Couldn't download audio from that link. "
            f"yt-dlp said: {_tail_error(download.stderr)}"
        )

    input_matches = glob.glob(os.path.join(work_dir, "input.*"))
    if not input_matches:
        raise RuntimeError("Couldn't find a downloaded audio file for that link.")
    input_path = input_matches[0]
    log(f"Downloaded {input_path}")

    log(f"Loading separation model {KARAOKE_MODEL}")
    separator = Separator(output_dir=work_dir, model_file_dir=MODEL_CACHE_DIR)
    separator.load_model(model_filename=KARAOKE_MODEL)
    model_cache.commit()
    log("Running separation")
    output_files = separator.separate(input_path)
    log(f"Separation produced: {output_files}")

    instrumental_path = next(
        (
            os.path.join(work_dir, name)
            for name in output_files
            if "instrumental" in name.lower()
        ),
        None,
    )
    if instrumental_path is None:
        raise RuntimeError("Separation finished, but no instrumental track came out of it.")

    mp3_path = os.path.join(work_dir, "output.mp3")
    log("Converting to mp3")
    convert = subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-i",
            instrumental_path,
            "-codec:a",
            "libmp3lame",
            "-b:a",
            "192k",
            mp3_path,
        ],
        capture_output=True,
        text=True,
    )
    if convert.returncode != 0:
        log(f"ffmpeg stderr tail:\n{convert.stderr[-2000:]}")
        raise RuntimeError(f"Couldn't convert the separated track to mp3: {_tail_error(convert.stderr)}")

    title_result = subprocess.run(
        ["yt-dlp", "--get-title", "--no-playlist", *YT_DLP_EXTRA_ARGS, youtube_url],
        capture_output=True,
        text=True,
    )
    title = title_result.stdout.strip() or "song"

    with open(mp3_path, "rb") as f:
        audio_bytes = f.read()

    log("Done")
    return {
        "filename": f"{title} (no lead vocal).mp3",
        "audio_base64": base64.b64encode(audio_bytes).decode("ascii"),
    }


@app.function(image=image)
@modal.asgi_app()
def web():
    from fastapi import FastAPI, Request
    from fastapi.middleware.cors import CORSMiddleware
    from fastapi.responses import JSONResponse

    web_app = FastAPI()
    web_app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @web_app.post("/start")
    async def start(request: Request):
        body = await request.json()
        youtube_url = (body.get("youtube_url") or "").strip()
        if not youtube_url:
            return JSONResponse({"error": "Paste a YouTube link first."}, status_code=400)

        call = run_pipeline.spawn(youtube_url)
        return {"call_id": call.object_id}

    @web_app.get("/status")
    async def status(call_id: str):
        call = modal.FunctionCall.from_id(call_id)
        try:
            result = call.get(timeout=0)
        except TimeoutError:
            return {"state": "pending"}
        except Exception as exc:  # noqa: BLE001 - surface any pipeline failure to the UI
            return {"state": "error", "message": str(exc)}
        return {"state": "done", **result}

    return web_app
