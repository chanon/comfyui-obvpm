// Pack limits, mirrored in image_safety.py. Zero output MP never disables safety.
export const MAX_LAYERS = 64;
export const MAX_LAYER_BYTES = 256 * 1024;
export const MAX_FILE_BYTES = 64 * 1024 * 1024;
export const MAX_TOTAL_FILE_BYTES = 256 * 1024 * 1024;

// CSS quoted-string serialization, not HTML escaping. Hex-escape every code
// point with a terminator so quotes, newlines and trailing hex digits are data.
// Works without CSS.escape on older frontends (NUL follows CSS replacement).
export function cssString(value) {
    return Array.from(String(value), c => `\\${(c.codePointAt(0) || 0xfffd).toString(16)} `).join("");
}

export function parseLayers(value) {
    if (typeof value !== "string" || value.length > MAX_LAYER_BYTES
        || new TextEncoder().encode(value).length > MAX_LAYER_BYTES) {
        throw new Error("Layers JSON exceeds 256 KiB or is not text");
    }
    const data = JSON.parse(value || "[]");
    if (!Array.isArray(data)) throw new Error("Layers must be a JSON array");
    if (data.length > MAX_LAYERS) throw new Error("At most 64 compose layers are allowed");
    return data.map(entry => {
        if (typeof entry === "string") entry = { image: entry };
        if (!entry || typeof entry.image !== "string" || !entry.image
            || entry.image.length > 4096 || entry.image.includes("\0")) {
            throw new Error("Each layer needs a filename (at most 4096 characters)");
        }
        const crop = entry.crop;
        if (crop && ![crop.x, crop.y, crop.w, crop.h].every(v =>
            typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1)) {
            throw new Error("Crop coordinates must be finite numbers between 0 and 1");
        }
        if (entry.aspect && entry.aspect !== "free") {
            const parts = String(entry.aspect).split(":");
            const ratio = Number(parts[0]) / Number(parts[1]);
            if (parts.length !== 2 || !Number.isFinite(ratio) || ratio < 1 / 16384 || ratio > 16384) {
                throw new Error("Invalid layer aspect ratio");
            }
        }
        return { image: entry.image, crop: crop ? { ...crop } : null, aspect: entry.aspect || null };
    });
}

export function checkFiles(files) {
    if (files.some(f => !Number.isFinite(f.size) || f.size > MAX_FILE_BYTES)
        || files.reduce((n, f) => n + f.size, 0) > MAX_TOTAL_FILE_BYTES) {
        throw new Error("Uploads are limited to 64 MiB per file and 256 MiB per batch");
    }
}

export async function boundedBlob(response, limit = MAX_FILE_BYTES) {
    if (Number(response.headers.get("Content-Length")) > limit) throw new Error("Image response exceeds byte limit");
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > limit) throw new Error("Image response exceeds byte limit");
            chunks.push(value);
        }
        return new Blob(chunks, { type: response.headers.get("Content-Type") || "image/png" });
    } finally {
        await reader.cancel();
        reader.releaseLock();
    }
}

export function safePlanInputs(sizes, mp, gap, target) {
    if (sizes.length > MAX_LAYERS || !Number.isFinite(mp) || mp < 0 || mp > 128
        || !Number.isFinite(gap) || gap < 0 || gap > 256
        || sizes.some(s => !s.every(v => Number.isFinite(v) && v > 0 && v <= 16384))
        || sizes.reduce((n, s) => n + s[0] * s[1], 0) > 64 * 1024 * 1024) return false;
    if (typeof target === "number" && (!Number.isFinite(target) || target < 1 / 16384 || target > 16384)) return false;
    return true;
}
