"""
Neville's Song Stripper - separation pipeline, deployed on Modal.

Flow: an audio file is uploaded -> a UVR karaoke-style model splits it
into two stems (the lead vocal, and everything else - instrumental +
backing vocals) -> both stems are converted to mp3 and handed back so
the frontend can remix them at any vocal level, not just fully removed.

Deploy with:  modal deploy modal_app/app.py
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
    .apt_install("ffmpeg")
    .pip_install(
        "audio-separator[gpu]",
        "fastapi[standard]",
        "python-multipart",
    )
)

# Modal spins up a fresh container per call - without this, every single
# song would re-download the ~1-2GB separation model from scratch. This
# volume persists that download across calls, so only the very first run
# after a deploy pays the download cost.
model_cache = modal.Volume.from_name("neville-song-stripper-models", create_if_missing=True)
MODEL_CACHE_DIR = "/cache/audio-separator-models"


def _tail_error(text: str) -> str:
    """Pull the most useful line out of ffmpeg's stderr for the UI."""
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
    gpu="T4",
    volumes={"/cache": model_cache},
)
def run_pipeline(audio_bytes: bytes, original_filename: str) -> dict:
    import os
    import subprocess
    import sys
    import tempfile

    from audio_separator.separator import Separator

    def log(message: str) -> None:
        # Shows up in `modal app logs neville-song-stripper` and the Modal
        # dashboard's Logs tab for this app.
        print(f"[{original_filename}] {message}", flush=True, file=sys.stderr)

    work_dir = tempfile.mkdtemp()
    input_ext = os.path.splitext(original_filename)[1] or ".mp3"
    raw_path = os.path.join(work_dir, f"upload{input_ext}")
    with open(raw_path, "wb") as f:
        f.write(audio_bytes)
    log(f"Saved upload ({len(audio_bytes)} bytes) to {raw_path}")

    # Normalize whatever got uploaded - mp3, m4a, a video file with an
    # audio track, anything ffmpeg understands - into a clean wav. Avoids
    # depending on the separation library's own format support, and means
    # picking the "wrong" file type on a phone (e.g. audio saved inside an
    # mp4 container) still just works.
    input_path = os.path.join(work_dir, "input.wav")
    log("Normalizing upload to wav")
    normalize = subprocess.run(
        ["ffmpeg", "-y", "-i", raw_path, input_path],
        capture_output=True,
        text=True,
    )
    if normalize.returncode != 0:
        log(f"ffmpeg stderr:\n{normalize.stderr}")
        raise RuntimeError(f"Couldn't read that file as audio: {_tail_error(normalize.stderr)}")

    log(f"Loading separation model {KARAOKE_MODEL}")
    separator = Separator(output_dir=work_dir, model_file_dir=MODEL_CACHE_DIR)
    separator.load_model(model_filename=KARAOKE_MODEL)
    model_cache.commit()
    log("Running separation")
    output_files = separator.separate(input_path)
    log(f"Separation produced: {output_files}")

    def find_stem(keyword: str) -> str:
        path = next(
            (
                os.path.join(work_dir, name)
                for name in output_files
                if keyword in name.lower()
            ),
            None,
        )
        if path is None:
            raise RuntimeError(f"Separation finished, but no {keyword} track came out of it.")
        return path

    instrumental_path = find_stem("instrumental")
    vocals_path = find_stem("vocals")

    def to_mp3(source_path: str, out_name: str) -> bytes:
        out_path = os.path.join(work_dir, out_name)
        log(f"Converting {out_name} to mp3")
        convert = subprocess.run(
            [
                "ffmpeg",
                "-y",
                "-i",
                source_path,
                "-codec:a",
                "libmp3lame",
                "-b:a",
                "192k",
                out_path,
            ],
            capture_output=True,
            text=True,
        )
        if convert.returncode != 0:
            log(f"ffmpeg stderr:\n{convert.stderr}")
            raise RuntimeError(f"Couldn't convert the separated track to mp3: {_tail_error(convert.stderr)}")
        with open(out_path, "rb") as f:
            return f.read()

    instrumental_bytes = to_mp3(instrumental_path, "instrumental.mp3")
    vocals_bytes = to_mp3(vocals_path, "vocals.mp3")

    title = os.path.splitext(original_filename)[0] or "song"

    log("Done")
    return {
        "title": title,
        "instrumental_base64": base64.b64encode(instrumental_bytes).decode("ascii"),
        "vocals_base64": base64.b64encode(vocals_bytes).decode("ascii"),
    }


@app.function(image=image)
@modal.asgi_app()
def web():
    from fastapi import FastAPI, File, UploadFile
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
    async def start(file: UploadFile = File(...)):
        audio_bytes = await file.read()
        if not audio_bytes:
            return JSONResponse({"error": "That file looks empty. Try a different one."}, status_code=400)

        call = run_pipeline.spawn(audio_bytes, file.filename or "song.mp3")
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
