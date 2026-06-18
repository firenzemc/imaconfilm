"""FastAPI service: develop Imacon FFF film negatives (crop + mask removal).

Run:  uv run uvicorn server:app --host 0.0.0.0 --port 8788
Reachable across the tailnet at http://<tailscale-host>:8788/

Coordinate model
----------------
The strip is native (H, W). The browser preview is rot90(k=1) -> a wide
filmstrip. Clients use normalised coords on that preview:
  u in [0,1] along the wide axis  == strip row   ->  y = u * H
  v in [0,1] along the tall axis  == strip col   ->  x = (1 - v) * W
A frame is [u0,u1] x [v0,v1] (v defaults to full width).
"""
import io
import os
import json
import threading
from pathlib import Path

import numpy as np
import tifffile
from PIL import Image, ImageCms
from fastapi import FastAPI, HTTPException
from fastapi.responses import Response, FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import pipeline as P

# Allowed root for browsing / reading / writing. Docker sets FILMTOOL_ROOT=/data;
# locally it defaults to the repo root so the bundled fff/ stays browsable.
# Every client path is resolved relative to this root and confined inside it.
ALLOWED_ROOT = Path(os.environ.get("FILMTOOL_ROOT")
                    or Path(__file__).resolve().parent.parent).resolve()
STATIC = Path(__file__).resolve().parent / "static"
ANALYSIS_DS = 8  # downsample for whole-strip stats/preview

# sRGB ICC profile embedded into exported TIFF/JPEG so darktable/Lightroom read
# the colour space instead of guessing. develop() encodes ~gamma 2.2, which
# sRGB approximates well enough for a finished positive.
ICC_SRGB = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()

app = FastAPI(title="filmtool")

_lock = threading.Lock()
_cache = {}  # abs-path str -> {img, mm, small, ped, base, params, cuts_u, vcrop, path}


def _resolve(rel):
    """Resolve a client path (relative to ALLOWED_ROOT) and confine it there.

    Paths legitimately contain separators now, so the guard is "must resolve
    under the allowed root" (resolve() also collapses any .. and symlinks)."""
    p = (ALLOWED_ROOT / (rel or "").lstrip("/")).resolve()
    if not p.is_relative_to(ALLOWED_ROOT):
        raise HTTPException(400, "path escapes root")
    return p


def _strip(rel):
    """Open + cache an FFF strip and its coarse analysis, keyed by abs path."""
    path = _resolve(rel)
    if not path.is_file():
        raise HTTPException(404, f"{rel} not found")
    key = str(path)
    with _lock:
        c = _cache.get(key)
        if c:
            return c
    img = P.open_strip(str(path))
    mm = img.memmap()
    small = np.ascontiguousarray(mm[::ANALYSIS_DS, ::ANALYSIS_DS, :]).astype(np.float32)
    ped = P.estimate_pedestal(small)
    base = P.estimate_base(small, ped)
    params = P.auto_params(small, ped, base)
    cuts = P.suggest_cuts(small, ped, base)
    cuts_u = [cc / img.height for cc in cuts]
    vcrop = P.suggest_vcrop(small, ped, base)
    c = dict(img=img, mm=mm, small=small, ped=ped, base=base,
             params=params, cuts_u=cuts_u, vcrop=vcrop, path=path)
    with _lock:
        _cache[key] = c
    return c


def _jpeg(arr, quality=88):
    buf = io.BytesIO()
    Image.fromarray(arr).save(buf, "JPEG", quality=quality)
    return Response(buf.getvalue(), media_type="image/jpeg")


def _crop_raw(c, u0, u1, v0, v1, max_px=2400):
    """Read a frame's raw uint16 crop (downsampled so the long edge <= max_px)."""
    H, W = c["img"].height, c["img"].width
    y0, y1 = sorted((int(u0 * H), int(u1 * H)))
    x0, x1 = sorted((int((1 - v1) * W), int((1 - v0) * W)))
    y0 = max(0, y0); y1 = min(H, max(y1, y0 + 1))
    x0 = max(0, x0); x1 = min(W, max(x1, x0 + 1))
    dy, dx = y1 - y0, x1 - x0
    step = max(1, int(max(dy, dx) / max_px))
    crop = np.ascontiguousarray(c["mm"][y0:y1:step, x0:x1:step, :])
    return crop, (y0, y1, x0, x1)


# ----------------------------- API -----------------------------------------

def _rel(p):
    """Path relative to ALLOWED_ROOT as POSIX ('' for the root itself)."""
    r = p.relative_to(ALLOWED_ROOT).as_posix()
    return "" if r == "." else r


def _is_fff(p):
    return p.is_file() and p.suffix.lower() == ".fff"


@app.get("/api/dirs")
def list_dirs(path: str = ""):
    """List sub-directories (with .fff counts) under `path` for the browser."""
    base = _resolve(path)
    if not base.is_dir():
        raise HTTPException(404, "not a directory")
    dirs = []
    for d in sorted(x for x in base.iterdir() if x.is_dir() and not x.name.startswith(".")):
        try:
            n = sum(1 for x in d.iterdir() if _is_fff(x))
        except PermissionError:
            n = 0
        dirs.append(dict(name=d.name, path=_rel(d), fff=n))
    return dict(cwd=_rel(base), at_root=(base == ALLOWED_ROOT),
                dirs=dirs, fff=sum(1 for x in base.iterdir() if _is_fff(x)))


@app.get("/api/files")
def list_files(dir: str = ""):
    base = _resolve(dir)
    if not base.is_dir():
        raise HTTPException(404, "not a directory")
    out = []
    for p in sorted(x for x in base.iterdir() if _is_fff(x)):
        try:
            img = P.open_strip(str(p))
            out.append(dict(name=p.name, path=_rel(p), width=img.width,
                            height=img.height, size=p.stat().st_size))
        except Exception as e:
            out.append(dict(name=p.name, path=_rel(p), error=str(e)))
    return out


@app.get("/api/strip")
def strip_preview(path: str):
    c = _strip(path)
    small = c["small"]
    # quick positive so the user sees a recognisable filmstrip for cutting
    pos = P.develop(small, c["ped"], c["base"], c["params"])
    disp = np.rot90(pos, k=1)  # landscape filmstrip
    # scale so long edge ~1600
    h, w = disp.shape[:2]
    scale = 1600 / max(h, w)
    if scale < 1:
        disp = np.array(Image.fromarray(disp).resize(
            (int(w * scale), int(h * scale)), Image.BILINEAR))
    return _jpeg(disp)


@app.get("/api/analyze")
def analyze(path: str):
    c = _strip(path)
    return dict(
        path=path,
        width=c["img"].width, height=c["img"].height,
        pedestal=c["ped"].tolist(),
        base=c["base"].tolist(),
        params=c["params"],
        cuts_u=c["cuts_u"],
        vcrop=c.get("vcrop", [0.0, 1.0]),
        mode=c["params"]["mode"],
    )


class FrameReq(BaseModel):
    path: str
    u0: float
    u1: float
    v0: float = 0.0
    v1: float = 1.0
    rotation: int = 90
    flip_h: bool = False
    flip_v: bool = False
    params: dict
    max_px: int = 1400


@app.post("/api/frame")
def frame_preview(req: FrameReq):
    c = _strip(req.path)
    crop, _ = _crop_raw(c, req.u0, req.u1, req.v0, req.v1, req.max_px)
    pos = P.develop(crop, c["ped"], c["base"], req.params)
    pos = P.orient(pos, req.rotation, req.flip_h, req.flip_v)
    return _jpeg(pos)


class SampleReq(BaseModel):
    path: str
    u0: float
    u1: float
    v0: float = 0.0
    v1: float = 1.0
    rotation: int = 90
    flip_h: bool = False
    flip_v: bool = False
    fx: float  # click position on the ORIENTED frame preview, normalised
    fy: float
    kind: str  # 'neutral' | 'base'
    params: dict


@app.post("/api/sample")
def sample(req: SampleReq):
    c = _strip(req.path)
    crop, _ = _crop_raw(c, req.u0, req.u1, req.v0, req.v1, 1600)
    oriented = P.orient(crop, req.rotation, req.flip_h, req.flip_v)
    oh, ow = oriented.shape[:2]
    py, px = int(req.fy * oh), int(req.fx * ow)
    r = max(3, min(oh, ow) // 50)
    patch = oriented[max(0, py - r):py + r + 1, max(0, px - r):px + r + 1, :]
    patch = patch.reshape(-1, 3).astype(np.float32)
    if req.kind == "base":
        base = np.clip(np.median(patch, axis=0) - c["ped"], 1.0, None)
        c["base"] = base.astype(np.float32)
        # refresh auto params/dmax with new base
        c["params"].update(P.auto_params(c["small"], c["ped"], c["base"]))
        return dict(base=c["base"].tolist(), params=c["params"])
    else:  # neutral white balance
        wb = P.wb_from_neutral(patch, c["ped"], c["base"])
        return dict(wb_gain=wb)


class ExportFrame(BaseModel):
    u0: float
    u1: float
    v0: float = 0.0
    v1: float = 1.0
    rotation: int = 90
    flip_h: bool = False
    flip_v: bool = False
    params: dict
    out_name: str


class ExportReq(BaseModel):
    path: str
    frames: list[ExportFrame]
    formats: list[str] = ["jpg", "tiff"]
    raw: bool = False       # un-developed: export the cropped raw scanner data
    margin: float = 0.1     # raw mode: grow the crop on every side (film-base ref)


@app.post("/api/export")
def export(req: ExportReq):
    c = _strip(req.path)
    src = c["path"]
    dest = src.parent / src.stem  # subfolder next to the source file
    dest.mkdir(parents=True, exist_ok=True)
    written = []
    for fr in req.frames:
        if req.raw:
            # No inversion / WB / tone — write the raw 16-bit scanner crop so the
            # negative is developed later (e.g. darktable's negadoctor). Grow the
            # crop on every side so clear film base is kept as a colour reference.
            m = max(0.0, req.margin)
            du, dv = (fr.u1 - fr.u0) * m, (fr.v1 - fr.v0) * m
            crop, _ = _crop_raw(c, fr.u0 - du, fr.u1 + du, fr.v0 - dv, fr.v1 + dv,
                                max_px=10 ** 9)
            out = P.orient(crop.astype(np.uint16), fr.rotation, fr.flip_h, fr.flip_v)
            p = dest / f"{fr.out_name}.tiff"
            # linear 16-bit, no ICC (a raw negative, not an sRGB image yet)
            tifffile.imwrite(str(p), out, photometric="rgb", compression="adobe_deflate")
            written.append(str(p))
            continue
        crop, box = _crop_raw(c, fr.u0, fr.u1, fr.v0, fr.v1, max_px=10 ** 9)
        want16 = "tiff" in req.formats
        pos = P.develop(crop, c["ped"], c["base"], fr.params, out16=want16)
        pos = P.orient(pos, fr.rotation, fr.flip_h, fr.flip_v)
        if "tiff" in req.formats:
            p = dest / f"{fr.out_name}.tiff"
            # Pillow has no 48-bit RGB mode; tifffile writes 16-bit RGB cleanly.
            # adobe_deflate is lossless; tag 34675 embeds the sRGB ICC profile.
            tifffile.imwrite(str(p), pos, photometric="rgb",
                             compression="adobe_deflate",
                             extratags=[(34675, 7, len(ICC_SRGB), ICC_SRGB, True)])
            written.append(str(p))
        if "jpg" in req.formats:
            arr8 = pos if pos.dtype == np.uint8 else (pos >> 8).astype(np.uint8)
            p = dest / f"{fr.out_name}.jpg"
            Image.fromarray(arr8).save(p, "JPEG", quality=95, icc_profile=ICC_SRGB)
            written.append(str(p))
    return dict(out_dir=str(dest), files=written)


# static UI
app.mount("/", StaticFiles(directory=str(STATIC), html=True), name="static")
