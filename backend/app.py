# -*- coding: utf-8 -*-
"""FastAPI server for Toby Satranç PWA (serves both Toby 2 API and built PWA frontend)."""
from __future__ import annotations

import json
import os
import socket
import sys
import threading
import time
import urllib.request
import webbrowser
import zipfile
from contextlib import asynccontextmanager
from pathlib import Path
from typing import List, Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from sample_games import SAMPLE_GAMES
from toby_engine import TobyEngine, find_toby_binary

MANIFEST_URL = "https://toby.tribychess.org/toby_manifest.json"


def _app_base_dir() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent.parent


def _dist_dir() -> Path:
    if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
        bundled = Path(sys._MEIPASS) / "frontend" / "dist"  # type: ignore[attr-defined]
        if bundled.is_dir():
            return bundled
    return Path(__file__).resolve().parent.parent / "frontend" / "dist"


def _get_lan_ip() -> Optional[str]:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:  # noqa: BLE001
        return None


def ensure_toby_downloaded_if_missing() -> Optional[str]:
    """On first run (especially Windows .exe), download official Toby 2 Light if missing."""
    existing = find_toby_binary()
    if existing:
        return existing

    if os.environ.get("TOBY_AUTO_DOWNLOAD", "1") != "1":
        return None

    target_dir = _app_base_dir()
    platform_key = "windows" if os.name == "nt" else "linux"
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
        "Accept": "*/*",
    }
    print("\n[Toby Satranç] Toby 2 motoru bulunamadı. Resmi paket indiriliyor...")
    try:
        manifest_req = urllib.request.Request(MANIFEST_URL, headers=headers)
        with urllib.request.urlopen(manifest_req, timeout=25) as resp:
            manifest = json.loads(resp.read().decode("utf-8"))
        filename = manifest[platform_key]["light"]["fichier"]
        url = f"https://toby.tribychess.org/{filename}"
        zip_path = target_dir / filename
        print(f"[Toby Satranç] İndiriliyor: {url}", flush=True)

        dl_req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(dl_req, timeout=60) as resp:
            total_size = int(resp.headers.get("Content-Length") or 0)
            downloaded = 0
            last_pct = -1
            with open(zip_path, "wb") as out_f:
                while True:
                    chunk = resp.read(262144)
                    if not chunk:
                        break
                    out_f.write(chunk)
                    downloaded += len(chunk)
                    if total_size > 0:
                        pct = min(100, int(downloaded * 100 / total_size))
                        if pct >= last_pct + 5:
                            last_pct = pct
                            mb_done = downloaded / (1024 * 1024)
                            mb_tot = total_size / (1024 * 1024)
                            print(f"[Toby Satranç] İndirme: %{pct} ({mb_done:.0f} / {mb_tot:.0f} MB)", flush=True)

        print("[Toby Satranç] Arşiv açılıyor...", flush=True)
        with zipfile.ZipFile(zip_path, "r") as zf:
            zf.extractall(target_dir)
        zip_path.unlink(missing_ok=True)
        binary = find_toby_binary()
        if binary and os.name != "nt":
            os.chmod(binary, 0o755)
        print(f"[Toby Satranç] Toby 2 kuruldu: {binary}\n", flush=True)
        return binary
    except Exception as exc:  # noqa: BLE001
        print(f"[Toby Satranç] Otomatik indirme başarısız: {exc}")
        print("[Toby Satranç] Manuel kurulum: https://toby.tribychess.org adresinden Toby-light zip'ini indirip 'Toby' klasörünü bu .exe yanına çıkarın.")
        return None


engine = TobyEngine()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    try:
        if not engine.binary_path:
            engine.binary_path = find_toby_binary()
        engine.start()
    except Exception as exc:  # noqa: BLE001
        engine.error = str(exc)
    yield
    engine.close()


app = FastAPI(title="Toby Satranç API", version="2.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


class AnalyzeRequest(BaseModel):
    fen: Optional[str] = None
    moves: Optional[List[str]] = None
    white_rating: int = Field(default=2000, ge=0, le=3600)
    black_rating: int = Field(default=2000, ge=0, le=3600)
    time_control: str = "Classical"
    rating_source: str = "FIDE"


class PlayRequest(AnalyzeRequest):
    sampling_mode: str = "human"  # "human" | "top"


class ReviewRequest(BaseModel):
    pgn: Optional[str] = None
    moves: Optional[List[str]] = None
    white_rating: Optional[int] = None
    black_rating: Optional[int] = None
    time_control: str = "Classical"
    white_name: Optional[str] = None
    black_name: Optional[str] = None
    result: Optional[str] = None


@app.get("/api/health")
def health():
    return {
        "ok": engine.ready,
        "engine": "Toby - The Oracle By Yosha",
        "version": engine.version,
        "binary": engine.binary_path,
        "error": engine.error,
    }


@app.get("/api/sample-games")
def sample_games():
    return {"games": SAMPLE_GAMES}


@app.post("/api/analyze")
def analyze(req: AnalyzeRequest):
    try:
        return engine.analyze_position(
            fen=req.fen,
            moves=req.moves,
            white_rating=req.white_rating,
            black_rating=req.black_rating,
            time_control=req.time_control,
            rating_source=req.rating_source,
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/play")
def play(req: PlayRequest):
    try:
        return engine.play_move(
            fen=req.fen,
            moves=req.moves,
            white_rating=req.white_rating,
            black_rating=req.black_rating,
            time_control=req.time_control,
            rating_source=req.rating_source,
            sampling_mode=req.sampling_mode,
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/review")
def review(req: ReviewRequest):
    def event_stream():
        try:
            for item in engine.review_game_stream(
                pgn_text=req.pgn,
                uci_moves=req.moves,
                white_rating=req.white_rating,
                black_rating=req.black_rating,
                time_control=req.time_control,
                white_name=req.white_name,
                black_name=req.black_name,
                result_str=req.result,
            ):
                yield f"data: {json.dumps(item, ensure_ascii=False)}\n\n"
        except Exception as exc:  # noqa: BLE001
            yield f"data: {json.dumps({'type': 'error', 'message': str(exc)}, ensure_ascii=False)}\n\n"

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# Serve built PWA frontend from frontend/dist (supports both dev and PyInstaller bundle)
DIST_DIR = _dist_dir()
if DIST_DIR.is_dir():
    assets_dir = DIST_DIR / "assets"
    if assets_dir.is_dir():
        app.mount("/assets", StaticFiles(directory=str(assets_dir)), name="assets")
    icons_dir = DIST_DIR / "icons"
    if icons_dir.is_dir():
        app.mount("/icons", StaticFiles(directory=str(icons_dir)), name="icons")

    @app.get("/manifest.webmanifest")
    def manifest():
        return FileResponse(DIST_DIR / "manifest.webmanifest", media_type="application/manifest+json")

    @app.get("/sw.js")
    def service_worker():
        return FileResponse(DIST_DIR / "sw.js", media_type="application/javascript")

    @app.get("/{full_path:path}")
    def spa_fallback(full_path: str):
        candidate = DIST_DIR / full_path
        if full_path and candidate.is_file():
            return FileResponse(candidate)
        return FileResponse(DIST_DIR / "index.html")


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("PORT", "8080"))
    if getattr(sys, "frozen", False):
        found = ensure_toby_downloaded_if_missing()
        if found:
            engine.binary_path = found

    lan_ip = _get_lan_ip()
    print("=" * 56)
    print("  Toby Satranç PWA (Toby 2 - The Oracle By Yosha)")
    print(f"  Bilgisayar : http://127.0.0.1:{port}")
    if lan_ip:
        print(f"  Telefon    : http://{lan_ip}:{port}  (Aynı Wi-Fi)")
    print("=" * 56, flush=True)

    if getattr(sys, "frozen", False):
        def _open_browser():
            time.sleep(2.5)
            webbrowser.open(f"http://127.0.0.1:{port}")

        threading.Thread(target=_open_browser, daemon=True).start()

    uvicorn.run(app, host="0.0.0.0", port=port, reload=False)
