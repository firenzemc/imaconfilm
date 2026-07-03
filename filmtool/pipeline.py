"""Film development pipeline: decode -> pedestal -> density inversion -> tone.

Validated on Imacon C-41 negative strips. The orange mask is removed and the
negative inverted in a single density-space operation (divide by the per-channel
film base in log space). Tone/white-balance are parameterised so the UI can
offer a neutral picker + exposure/contrast sliders.
"""
import numpy as np
from fff import FFFImage

EPS = 1.0


def open_strip(path):
    return FFFImage(path)


def estimate_pedestal(small):
    """Scanner black floor (uniform across channels)."""
    return np.array([float(small[..., c].min()) for c in range(3)], dtype=np.float32)


def estimate_base(small, ped):
    """Clear C-41 film base = the least-dense pixels = highest red transmission.

    Excludes near-saturated pixels (light leaks / specular clips scan brighter
    than the orange base and would otherwise be mistaken for it). Returns the
    base RGB *above* the pedestal (the Dmin reference)."""
    r = small[..., 0]
    valid = small.max(axis=2) < 0.95 * 65535.0
    rv = r[valid]
    if rv.size < 100:  # almost everything clipped -> fall back
        rv, valid = r.reshape(-1), np.ones(r.shape, bool)
    thr = np.percentile(rv, 99.5)
    sel = small[valid & (r >= thr)].reshape(-1, 3)
    base = np.median(sel, axis=0) - ped
    return np.clip(base, 1.0, None).astype(np.float32)


def is_negative(base_rgb):
    """Orange mask => red transmits far more than blue. Heuristic guess."""
    return float(base_rgb[0] / max(base_rgb[2], 1.0)) > 1.35


def density(raw, ped, base_rgb):
    """Per-channel density above film base; base->0, dense(bright scene)->high.
    This single op removes the orange mask AND inverts."""
    lin = np.clip(raw.astype(np.float32) - ped, EPS, None)
    return np.clip(np.log10(base_rgb[None, None, :] / lin), 0.0, None)


def auto_params(small, ped, base_rgb):
    """Derive default tone params from the whole strip so frames are consistent.

    White balance: grey-world over the bright, near-neutral pixels (snow/sky),
    NOT per-channel percentiles (those balance different scene points per channel
    and over-correct toward blue). dmax sets exposure from the luminance range.
    """
    D = density(small, ped, base_rgb)
    lum = D.mean(axis=2)
    dmax = float(np.percentile(lum, 99.5))
    bright = lum > np.percentile(lum, 80)
    bp = D[bright].reshape(-1, 3)
    spread = bp.max(axis=1) - bp.min(axis=1)
    neutral = bp[spread < np.percentile(spread, 50)] if len(bp) else bp
    src = neutral if len(neutral) > 50 else bp
    m = src.mean(axis=0) if len(src) else np.ones(3, np.float32)
    ref = float(m.mean())
    wb = np.clip(ref / np.clip(m, 1e-3, None), 0.6, 1.7).astype(np.float32)
    return {
        "mode": "negative" if is_negative(base_rgb) else "positive",
        "wb_gain": wb.tolist(),
        "dmax": dmax,
        "exposure": 1.0,
        "contrast": 1.0,
        "gamma": 2.2,
        "black": 0.0,
    }


def wb_from_neutral(raw_patch, ped, base_rgb):
    """Given a patch the user marked neutral, return per-channel wb gains that
    make it grey (equalise its density across channels)."""
    D = density(raw_patch, ped, base_rgb).reshape(-1, 3)
    Dn = np.median(D, axis=0)
    ref = float(np.mean(Dn))
    return (ref / np.clip(Dn, 1e-3, None)).astype(np.float32).tolist()


def develop(raw, ped, base_rgb, params, out16=False):
    """Develop a raw uint16 RGB crop into a positive RGB image.

    raw: (h,w,3) uint16 (or float). Returns uint8 (default) or uint16.
    """
    mode = params.get("mode", "negative")
    exposure = float(params.get("exposure", 1.0))
    contrast = float(params.get("contrast", 1.0))
    gamma = float(params.get("gamma", 2.2))
    black = float(params.get("black", 0.0))

    if mode == "negative":
        wb = np.asarray(params.get("wb_gain", [1.0, 1.0, 1.0]), dtype=np.float32)
        dmax = float(params.get("dmax", 2.0))
        D = density(raw, ped, base_rgb)
        D = D * wb[None, None, :]
        x = (D / max(dmax, 1e-3)) * exposure
    else:  # positive / slide: just scale linear to white point, no inversion
        wp = np.asarray(params.get("white_lin", base_rgb), dtype=np.float32)
        lin = np.clip(raw.astype(np.float32) - ped, EPS, None)
        x = (lin / wp[None, None, :]) * exposure

    # black point, contrast (pivot 0.5), gamma encode
    if black > 0:
        x = (x - black) / (1.0 - black)
    x = np.clip(x, 0.0, 1.0)
    if contrast != 1.0:
        x = np.clip((x - 0.5) * contrast + 0.5, 0.0, 1.0)
    x = x ** (1.0 / max(gamma, 1e-3))

    if out16:
        return (np.clip(x, 0, 1) * 65535.0 + 0.5).astype(np.uint16)
    return (np.clip(x, 0, 1) * 255.0 + 0.5).astype(np.uint8)


def develop_linear(raw, ped, base_rgb, params, norm="neutral"):
    """Inverted + mask-removed 16-bit master with NO tone curve (flat/linear),
    to be graded downstream (e.g. Capture One). Same density-space inversion as
    develop(), but skips black/contrast/gamma. Two normalisations:

      neutral (default)  grey-world WB + shared Dmax -> flatter, greyer, most
                         grading latitude.
      per_channel        each channel's 0.5/99.5 percentile stretched to [0,1]
                         (the reference method); punchier but can cast per channel.

    Positive/slide mode falls back to a plain linear white-point scale. Returns
    uint16 (0-65535)."""
    if params.get("mode", "negative") != "negative":
        wp = np.asarray(params.get("white_lin", base_rgb), dtype=np.float32)
        lin = np.clip(raw.astype(np.float32) - ped, EPS, None)
        x = np.clip(lin / wp[None, None, :], 0.0, 1.0)
        return (x * 65535.0 + 0.5).astype(np.uint16)

    D = density(raw, ped, base_rgb)
    if norm == "per_channel":
        x = np.empty_like(D)
        for c in range(3):
            lo, hi = np.percentile(D[..., c], (0.5, 99.5))
            x[..., c] = (D[..., c] - lo) / max(float(hi - lo), 1e-6)
    else:  # neutral
        wb = np.asarray(params.get("wb_gain", [1.0, 1.0, 1.0]), dtype=np.float32)
        dmax = float(params.get("dmax", 2.0))
        x = (D * wb[None, None, :]) / max(dmax, 1e-3)
    x = np.clip(x, 0.0, 1.0)
    return (x * 65535.0 + 0.5).astype(np.uint16)


def suggest_cuts(small, ped, base_rgb, axis=0):
    """Best-effort frame-gap detection along `axis` (0 = vertical strip).

    Inter-frame clear base has density ~0; content has density > 0. We look for
    low-density valleys. Near-contiguous frames make this only a first guess —
    the UI lets the user drag boundaries. Returns sorted cut positions (full-res).
    """
    D = density(small, ped, base_rgb)
    energy = D.max(axis=2)  # per-pixel content strength
    prof = energy.mean(axis=1 if axis == 0 else 0)  # per-row content level
    n = len(prof)
    # smooth
    k = max(3, n // 100)
    kern = np.ones(k) / k
    sm = np.convolve(prof, kern, mode="same")
    lo, hi = sm.min(), sm.max()
    if hi - lo < 1e-6:
        return []
    norm = (sm - lo) / (hi - lo)
    thr = 0.35
    gap = norm < thr
    # gap runs -> cut at each run centre, ignore the leading/trailing film edges
    cuts = []
    i = 0
    full = small.shape[axis]
    scale = full / n
    while i < n:
        j = i
        while j < n and gap[j]:
            j += 1
        if j > i and (j - i) >= max(2, k // 2):
            c = (i + j) // 2
            cuts.append(int(c * scale))
        i = j + 1 if j == i else j
    # drop cuts at the very edges (film leader)
    cuts = [c for c in cuts if 0.01 * full < c < 0.99 * full]
    return sorted(cuts)


def suggest_vcrop(small, ped, base_rgb):
    """Detect the opaque scanner-holder mask at the film-width (strip-x) edges.

    The holder is dense in EVERY row -> a high, flat density plateau at both
    strip-x ends (it shows up cream/white in the positive). Image content sits
    between the plateaus. Trim the plateaus. Returns (v0, v1) display-y fractions
    (v = 1 - strip_x / W). Falls back to [0,1] when there is no clear plateau.
    """
    D = density(small, ped, base_rgb)
    col = D.max(axis=2).mean(axis=0)  # per strip-x mean content density
    n = len(col)
    edge = float(np.median(np.r_[col[: max(1, n // 30)], col[-max(1, n // 30):]]))
    mid = float(np.median(col[n // 3: 2 * n // 3]))
    if edge - mid < 0.3:  # no distinct dense holder plateau -> nothing to trim
        return [0.0, 1.0]
    thr = mid + 0.55 * (edge - mid)
    x_lo = 0
    while x_lo < n // 2 and col[x_lo] > thr:
        x_lo += 1
    x_hi = n - 1
    while x_hi > n // 2 and col[x_hi] > thr:
        x_hi -= 1
    pad = max(1, n // 200)
    x_lo = min(n // 2, x_lo + pad) / n
    x_hi = max(n // 2, x_hi - pad) / n
    # v = 1 - strip_x/W
    return [round(1 - x_hi, 4), round(1 - x_lo, 4)]


def orient(arr, rotation=-90, flip_h=False, flip_v=False):
    """Apply rotation (deg, multiple of 90) and flips. Frames are stored rotated
    90deg in the vertical strip, so the default brings them to landscape."""
    k = int(round((rotation % 360) / 90)) % 4
    if k:
        arr = np.rot90(arr, k=k)
    if flip_h:
        arr = arr[:, ::-1]
    if flip_v:
        arr = arr[::-1, :]
    return np.ascontiguousarray(arr)
