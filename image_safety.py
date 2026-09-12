"""Pack-owned image boundaries; independent of the installed core's path checks."""
import hashlib
import math
import ntpath
import os
import stat

from PIL import Image
import folder_paths

MAX_LAYERS = 64
MAX_JSON_BYTES = 256 * 1024
MAX_FILE_BYTES = 64 * 1024 * 1024
MAX_TOTAL_FILE_BYTES = 256 * 1024 * 1024
MAX_FRAMES = 128
MAX_PIXELS = 32 * 1024 * 1024
MAX_TOTAL_PIXELS = 64 * 1024 * 1024
MAX_SIDE = 16384
MAX_CANVAS_PIXELS = 32 * 1024 * 1024


def image_path(name):
    """Resolve only regular files confined to input/output/temp (including symlinks).

    Absolute paths are accepted only inside the selected root. Both slash styles
    are checked, even on POSIX, so workflows cannot change meaning across hosts.
    """
    if not isinstance(name, str) or not name or len(name) > 4096 or "\0" in name:
        raise ValueError("Invalid image path: expected a nonempty filename (at most 4096 characters)")
    root = folder_paths.get_input_directory()
    for kind in ("input", "output", "temp"):
        suffix = " [%s]" % kind
        if name.endswith(suffix):
            name = name[:-len(suffix)]
            root = getattr(folder_paths, "get_%s_directory" % kind)()
            break
    portable = name.replace("\\", "/")
    if not portable or ".." in portable.split("/") or portable.startswith("//"):
        raise ValueError("Invalid image path: traversal and UNC paths are not allowed")
    # Reject drive-relative paths and Windows absolute paths on non-Windows hosts.
    drive, tail = ntpath.splitdrive(name)
    if drive and (not tail.startswith(("/", "\\")) or os.name != "nt"):
        raise ValueError("Invalid image path: drive-relative or foreign absolute path")
    if ":" in tail:
        raise ValueError("Invalid image path: alternate data streams are not allowed")
    root = os.path.realpath(root)
    path = os.path.realpath(os.path.join(root, portable))
    try:
        confined = os.path.commonpath((root, path)) == root
    except ValueError:
        confined = False
    if not confined:
        raise ValueError("Invalid image path: file is outside its annotated directory")
    info = os.stat(path)
    if not stat.S_ISREG(info.st_mode):
        raise ValueError("Invalid image path: not a regular file")
    if info.st_size > MAX_FILE_BYTES:
        raise ValueError("Image exceeds the 64 MiB input-file limit")
    return path


def bounded_text(text, limit=MAX_JSON_BYTES, what="Image JSON"):
    if not isinstance(text, str) or len(text) > limit or len(text.encode("utf-8")) > limit:
        raise ValueError("%s exceeds the %d byte limit or is not text" % (what, limit))
    return text


def finite_number(value, name, lo, hi):
    try:
        number = float(value)
    except (ValueError, TypeError, OverflowError):
        raise ValueError("%s must be a finite number" % name) from None
    if not math.isfinite(number) or not lo <= number <= hi:
        raise ValueError("%s must be finite and between %s and %s" % (name, lo, hi))
    return number


def check_pixels(width, height, total=0, canvas=False):
    cap = MAX_CANVAS_PIXELS if canvas else MAX_PIXELS
    if width < 1 or height < 1 or max(width, height) > MAX_SIDE or width * height > cap:
        raise ValueError("Image/canvas exceeds the 16384 side or 32 Mi-pixel safety limit")
    total += width * height
    if total > MAX_TOTAL_PIXELS:
        raise ValueError("Images exceed the 64 Mi-pixel aggregate decoded limit")
    return total


# Bounds metadata scanning without retaining compressed image data. These are
# structural checks, not replacement decoders; Pillow still validates codecs.
MAX_CONTAINER_BLOCKS = 262144


def _header(fp, length):
    data = fp.read(length)
    if len(data) != length:
        raise ValueError("Truncated image container header")
    return data


def _skip(fp, length, end):
    if length < 0 or fp.tell() + length > end:
        raise ValueError("Image container block extends beyond the file")
    fp.seek(length, os.SEEK_CUR)


def _frame_budget(width, height, frames, total, animation):
    if frames < 1 or (animation and frames > MAX_FRAMES):
        raise ValueError("Animation exceeds the 128 frame limit or has no frames")
    check_pixels(width, height)
    total += width * height * (frames if animation else 1)
    if total > MAX_TOTAL_PIXELS:
        raise ValueError("Images exceed the 64 Mi-pixel aggregate decoded limit")
    return total


def _gif_preflight(fp, end, total, animation):
    header = _header(fp, 13)
    width = int.from_bytes(header[6:8], "little")
    height = int.from_bytes(header[8:10], "little")
    check_pixels(width, height)  # logical screen, before Pillow's first _seek
    if header[10] & 128:
        _skip(fp, 3 << ((header[10] & 7) + 1), end)
    blocks = 0
    frames = 0
    while True:
        blocks += 1
        if blocks > MAX_CONTAINER_BLOCKS:
            raise ValueError("Image container exceeds the structural block limit")
        kind = _header(fp, 1)
        if kind == b";":
            if not frames:
                raise ValueError("GIF contains no frames")
            return total
        if kind == b",":
            descriptor = _header(fp, 9)
            x, y, w, h = (int.from_bytes(descriptor[i:i + 2], "little")
                          for i in (0, 2, 4, 6))
            # GIF can grow the logical screen on later frames. Disposal 2/3
            # allocates the descriptor rectangle even during Image.open/seek.
            check_pixels(w, h)
            width, height = max(width, x + w), max(height, y + h)
            check_pixels(width, height)
            frames += 1
            if animation and frames > MAX_FRAMES:
                raise ValueError("Animation exceeds the 128 frame limit")
            if animation or frames == 1:
                total = check_pixels(width, height, total)
            if descriptor[8] & 128:
                _skip(fp, 3 << ((descriptor[8] & 7) + 1), end)
            _header(fp, 1)  # LZW minimum code size, not image data
        elif kind == b"!":
            _header(fp, 1)  # extension label; every extension uses sub-blocks
        else:
            raise ValueError("Invalid GIF block")
        while True:
            blocks += 1
            if blocks > MAX_CONTAINER_BLOCKS:
                raise ValueError("Image container exceeds the structural block limit")
            size = _header(fp, 1)[0]
            if not size:
                break
            _skip(fp, size, end)


def _chunks(fp, end, png=False):
    """PNG/RIFF chunk headers only; skip payloads, with bounded work and seeks."""
    for _ in range(MAX_CONTAINER_BLOCKS):
        if fp.tell() == end:
            return
        head = _header(fp, 8)
        size = int.from_bytes(head[:4] if png else head[4:],
                              "big" if png else "little")
        kind = head[4:] if png else head[:4]
        payload_end = fp.tell() + size
        next_chunk = payload_end + (4 if png else size % 2)
        if next_chunk > end:
            raise ValueError("Image container chunk extends beyond the file")
        yield kind, size, payload_end
        fp.seek(next_chunk)
    raise ValueError("Image container exceeds the structural block limit")


def _png_preflight(fp, end, total, animation):
    _header(fp, 8)
    width = height = 0
    declared = None
    frames = 0
    default_image = False
    idat = False
    for kind, size, _ in _chunks(fp, end, png=True):
        if not width and kind != b"IHDR":
            raise ValueError("PNG must start with IHDR")
        if kind == b"IHDR":
            if width or size != 13:
                raise ValueError("Invalid or repeated PNG IHDR")
            header = _header(fp, 13)
            width = int.from_bytes(header[:4], "big")
            height = int.from_bytes(header[4:8], "big")
            check_pixels(width, height)  # APNG background disposal fills this canvas
        elif kind == b"acTL":
            if declared is not None or size != 8 or idat or frames:
                raise ValueError("Invalid APNG animation control")
            declared = int.from_bytes(_header(fp, 8)[:4], "big")
            _frame_budget(width, height, declared, total, animation)
        elif kind == b"fcTL":
            if declared is None or size != 26:
                raise ValueError("Invalid APNG frame control")
            header = _header(fp, 26)
            w, h, x, y = (int.from_bytes(header[i:i + 4], "big")
                          for i in (4, 8, 12, 16))
            check_pixels(w, h)
            if x + w > width or y + h > height:
                raise ValueError("APNG frame/disposal rectangle exceeds its canvas")
            frames += 1
            if frames > declared:
                raise ValueError("APNG frame count disagrees with animation control")
        elif kind == b"IDAT":
            if not idat:
                default_image = frames == 0
                idat = True
        elif kind == b"IEND":
            if not idat or size or (declared is not None and frames != declared):
                raise ValueError("Invalid PNG/APNG frame count or image data")
            return _frame_budget(width, height,
                                 frames + int(default_image), total, animation)
    raise ValueError("PNG has no IEND")


def _webp_bitstream(fp, kind, size):
    if kind == b"VP8 ":
        if size < 10:
            raise ValueError("Truncated WebP VP8 header")
        header = _header(fp, 10)
        if header[0] & 1 or header[3:6] != b"\x9d\x01\x2a":
            raise ValueError("WebP must contain a VP8 key frame")
        width = int.from_bytes(header[6:8], "little") & 0x3fff
        height = int.from_bytes(header[8:10], "little") & 0x3fff
    else:
        if size < 5:
            raise ValueError("Truncated WebP VP8L header")
        header = _header(fp, 5)
        bits = int.from_bytes(header[1:], "little")
        if header[0] != 0x2f or bits >> 29:
            raise ValueError("Invalid WebP VP8L header")
        width, height = (bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1
    check_pixels(width, height)
    return width, height


def _webp_preflight(fp, end, total, animation):
    header = _header(fp, 12)
    if int.from_bytes(header[4:8], "little") + 8 != end:
        raise ValueError("WebP RIFF length disagrees with file size")
    canvas = None
    still = None
    frames = 0
    animated = False
    for kind, size, payload_end in _chunks(fp, end):
        if kind == b"VP8X":
            if canvas or still or frames or size != 10:
                raise ValueError("Invalid WebP extended header")
            header = _header(fp, 10)
            canvas = (int.from_bytes(header[4:7], "little") + 1,
                      int.from_bytes(header[7:10], "little") + 1)
            check_pixels(*canvas)
            animated = bool(header[0] & 2)
        elif kind == b"ANMF":
            if not canvas or not animated or size < 16 or still:
                raise ValueError("Invalid WebP animation frame")
            header = _header(fp, 16)
            x, y, w, h = (int.from_bytes(header[i:i + 3], "little")
                          for i in (0, 3, 6, 9))
            w, h = w + 1, h + 1
            check_pixels(w, h)
            if 2 * x + w > canvas[0] or 2 * y + h > canvas[1]:
                raise ValueError("WebP frame/disposal rectangle exceeds its canvas")
            frames += 1
            _frame_budget(*canvas, frames, total, animation)
            bitstream = None
            for subkind, subsize, _ in _chunks(fp, payload_end):
                if subkind in (b"VP8 ", b"VP8L"):
                    if bitstream:
                        raise ValueError("Repeated WebP frame bitstream")
                    bitstream = _webp_bitstream(fp, subkind, subsize)
            if bitstream != (w, h):
                raise ValueError("WebP frame dimensions disagree with its bitstream")
        elif kind in (b"VP8 ", b"VP8L"):
            if still or animated or frames:
                raise ValueError("Invalid WebP still image")
            still = _webp_bitstream(fp, kind, size)
    if animated:
        return _frame_budget(*canvas, frames, total, animation)
    if still is None or (canvas and still != canvas):
        raise ValueError("WebP canvas dimensions disagree with its bitstream")
    return _frame_budget(*still, 1, total, animation)


def _container_preflight(path, total, animation):
    """No pixel allocation/native decoder calls. Dispatch by bytes, never suffix.

    GIF/APNG disposal and WebP decoder construction can allocate during open,
    so those three containers are preflighted from their headers. Everything
    else is left to Pillow, as the stock Load Image does: the pixel limits
    still apply once the image is open, before any frame is retained.
    Returns (format, total); format is None for a container Pillow will
    identify itself.
    """
    with open(path, "rb") as fp:
        end = os.fstat(fp.fileno()).st_size
        if end > MAX_FILE_BYTES:
            raise ValueError("Image exceeds the 64 MiB input-file limit")
        signature = fp.read(12)
        fp.seek(0)
        if signature[:6] in (b"GIF87a", b"GIF89a"):
            return "GIF", _gif_preflight(fp, end, total, animation)
        if signature[:8] == b"\x89PNG\r\n\x1a\n":
            return "PNG", _png_preflight(fp, end, total, animation)
        if signature[:4] == b"RIFF" and signature[8:12] == b"WEBP":
            return "WEBP", _webp_preflight(fp, end, total, animation)
        if signature[:3] == b"\xff\xd8\xff":
            return "JPEG", total
        if signature[:2] == b"BM":
            return "BMP", total
        if signature[:4] in (b"II*\0", b"MM\0*", b"II+\0", b"MM\0+"):
            return "TIFF", total
    return None, total


def open_checked_image(path):
    """Open a previously confined path, pinned to its preflighted plugin when there is one."""
    image_format, _ = _container_preflight(path, 0, False)
    return Image.open(path, formats=[image_format] if image_format else None)


def inspect_images(names, animation=False):
    """Check *all* file sizes before opening, then bounded frame headers before tensors.

    GIF/APNG/WebP container headers are checked without calling Pillow first.
    This covers disposal/decoder allocations inside open/seek, not just tensors.
    The remaining supported plugins describe tiles lazily; bound each before load.
    """
    paths = [image_path(name) for name in names]
    if sum(os.stat(path).st_size for path in paths) > MAX_TOTAL_FILE_BYTES:
        raise ValueError("Images exceed the 256 MiB aggregate input-file limit")
    preflight_total = 0
    formats = []
    for path in paths:
        image_format, preflight_total = _container_preflight(path, preflight_total, animation)
        formats.append(image_format)
    total = 0
    counts = []
    for path, image_format in zip(paths, formats):
        count = 0
        with Image.open(path, formats=[image_format] if image_format else None) as img:
            while True:
                total = check_pixels(*img.size, total)
                count += 1
                if not animation:
                    break
                try:
                    img.seek(count)
                except EOFError:
                    break
                if count >= MAX_FRAMES:
                    raise ValueError("Animation exceeds the 128 frame limit")
        counts.append(count)
    return paths, counts


def hash_images(names, prefix=b""):
    # No whole-file read, and all paths/sizes are validated before any read.
    paths = [image_path(name) for name in names]
    if sum(os.stat(path).st_size for path in paths) > MAX_TOTAL_FILE_BYTES:
        raise ValueError("Images exceed the 256 MiB aggregate input-file limit")
    digest = hashlib.sha256(prefix)
    for path in paths:
        read = 0
        with open(path, "rb") as stream:
            while True:
                chunk = stream.read(1024 * 1024)
                if not chunk:
                    break
                read += len(chunk)
                if read > MAX_FILE_BYTES:
                    raise ValueError("Image grew beyond the input-file limit while hashing")
                digest.update(chunk)
    return digest.hexdigest()
