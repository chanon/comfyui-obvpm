// The Artius asset browser's drag payload, decoded in ONE place for the
// pack: cards carry no File objects, only a JSON payload under a custom
// MIME (assets carry root_id/folder_path/filename). Load Images & Compose
// reads it to accept drops from the browser.

export const ARTIUS_MIME = "application/x-timesaver-artius-asset";
export const ARTIUS_ROUTE_BASE = "/asset_browser";

export function readArtiusAssets(e) {
    let raw = "";
    try {
        raw = e?.dataTransfer?.getData(ARTIUS_MIME) || "";
    } catch { /* getData throws outside drop dispatch */ }
    if (!raw) raw = window.__tsArtiusDraggedAsset || "";
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw);
        return (Array.isArray(parsed) ? parsed : [parsed]).filter(Boolean);
    } catch (err) {
        console.log("[obvpm-artius] unparseable Artius payload:", err);
        return null;
    }
}

export function artiusRelativePath(asset) {
    if (!asset?.filename) return "";
    const folder = String(asset.folder_path || "")
        .replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
    return folder ? `${folder}/${asset.filename}` : String(asset.filename);
}
