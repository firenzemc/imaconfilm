"""Hasselblad/Imacon FFF reader.

FFF (Flexible File Format) from Flextight scanners is a big-endian TIFF
container holding uncompressed 16-bit interleaved RGB scan data (the scanner
is a trilinear CCD, so there is no Bayer mosaic to demosaic). We parse the
first IFD generically and expose the pixel plane as a zero-copy numpy memmap.
"""

import struct
import numpy as np

# TIFF tag numbers we care about
T_WIDTH = 256
T_LENGTH = 257
T_BITS = 258
T_COMPRESSION = 259
T_PHOTOMETRIC = 262
T_STRIP_OFFSETS = 273
T_SAMPLES = 277
T_ROWS_PER_STRIP = 278
T_STRIP_BYTECOUNTS = 279

_TYPE_SIZE = {1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8}


class FFFImage:
    """Lazily mapped FFF scan. Use .memmap() to get an (H, W, 3) uint16 view."""

    def __init__(self, path):
        self.path = str(path)
        self._parse()

    def _parse(self):
        with open(self.path, "rb") as f:
            head = f.read(8)
            if head[:2] != b"MM":
                raise ValueError(f"{self.path}: not a big-endian TIFF/FFF (magic={head[:2]!r})")
            self.endian = ">"
            magic = struct.unpack(">H", head[2:4])[0]
            if magic != 42:
                raise ValueError(f"{self.path}: bad TIFF magic {magic}")
            ifd_off = struct.unpack(">I", head[4:8])[0]
            f.seek(ifd_off)
            n = struct.unpack(">H", f.read(2))[0]
            tags = {}
            for _ in range(n):
                tag, typ, cnt = struct.unpack(">HHI", f.read(8))
                valbytes = f.read(4)
                size = _TYPE_SIZE.get(typ, 1) * cnt
                if size <= 4:
                    tags[tag] = self._decode_inline(typ, cnt, valbytes, f)
                else:
                    off = struct.unpack(">I", valbytes)[0]
                    tags[tag] = ("@", typ, cnt, off)
            self._tags = tags

        def scalar(tag, default=None):
            v = tags.get(tag, default)
            if isinstance(v, tuple) and v and v[0] == "@":
                # deferred; resolve scalar by reading from file
                return self._read_deferred(v)[0]
            if isinstance(v, list):
                return v[0]
            return v

        self.width = int(scalar(T_WIDTH))
        self.height = int(scalar(T_LENGTH))
        self.samples = int(scalar(T_SAMPLES, 3))
        self.compression = int(scalar(T_COMPRESSION, 1))
        self.photometric = int(scalar(T_PHOTOMETRIC, 2))
        bits = tags.get(T_BITS)
        if isinstance(bits, tuple):
            bits = self._read_deferred(bits)
        self.bits = list(bits) if isinstance(bits, (list, tuple)) else [int(bits)]
        self.strip_offset = int(scalar(T_STRIP_OFFSETS))
        self.strip_bytecount = int(scalar(T_STRIP_BYTECOUNTS))

        if self.compression != 1:
            raise NotImplementedError(f"{self.path}: compression={self.compression} not supported")
        if self.samples != 3 or any(b != 16 for b in self.bits[:3]):
            raise NotImplementedError(
                f"{self.path}: expected 16-bit RGB, got samples={self.samples} bits={self.bits}"
            )
        expect = self.width * self.height * 3 * 2
        if self.strip_bytecount != expect:
            raise ValueError(
                f"{self.path}: strip bytecount {self.strip_bytecount} != {expect} (w*h*3*2)"
            )

    def _decode_inline(self, typ, cnt, valbytes, f):
        if typ in (3, 8):
            vals = struct.unpack(">" + "H" * cnt, valbytes[: 2 * cnt])
        elif typ in (4, 9):
            vals = struct.unpack(">" + "I" * cnt, valbytes[: 4 * cnt])
        elif typ in (1, 2, 6, 7):
            vals = tuple(valbytes[:cnt])
        else:
            vals = (struct.unpack(">I", valbytes)[0],)
        return list(vals) if cnt > 1 else vals[0]

    def _read_deferred(self, deferred):
        _, typ, cnt, off = deferred
        with open(self.path, "rb") as f:
            f.seek(off)
            raw = f.read(_TYPE_SIZE.get(typ, 1) * cnt)
        if typ in (3, 8):
            return list(struct.unpack(">" + "H" * cnt, raw))
        if typ in (4, 9):
            return list(struct.unpack(">" + "I" * cnt, raw))
        if typ == 5:  # rational
            return [struct.unpack(">II", raw[i : i + 8]) for i in range(0, len(raw), 8)]
        return list(raw)

    def memmap(self):
        """Return an (H, W, 3) big-endian uint16 memmap view (zero copy)."""
        return np.memmap(
            self.path,
            dtype=">u2",
            mode="r",
            offset=self.strip_offset,
            shape=(self.height, self.width, 3),
        )

    def __repr__(self):
        return f"<FFFImage {self.width}x{self.height} 16bit RGB '{self.path}'>"
