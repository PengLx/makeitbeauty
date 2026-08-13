/**
 * Canvas-side loading of the session user's uploaded fonts: fetch
 * GET /v1/fonts/{id}/file (owner-only), parse it as a FontFace and register
 * it on document.fonts so canvas text measures in the real face — the same
 * parity goal as the self-hosted built-ins in index.css.
 *
 * Cached per font id for the session: font files are immutable (re-uploading
 * makes a new id), so a face is fetched and parsed at most once. Entries are
 * deliberately never removed from document.fonts — a deleted font's face
 * lingering until reload is harmless (the design falls back to Inter the
 * moment its fontFamily key goes), while eager cleanup would churn re-fetches
 * every time a design toggles a family.
 */
import { fontFileUrl, type UserFont } from "./api";

/** In-flight/settled loads by font id; failures clear so a retry can work. */
const faces = new Map<string, Promise<boolean>>();

/**
 * Ensures `font` is registered with the browser. Resolves true once the face
 * is usable, false when loading isn't possible (no DOM — tests — or the
 * fetch/parse failed; canvas text then simply stays on the Inter fallback).
 */
export function ensureFontFace(font: UserFont): Promise<boolean> {
  if (
    typeof document === "undefined" ||
    typeof FontFace === "undefined" ||
    !document.fonts
  ) {
    return Promise.resolve(false);
  }
  const cached = faces.get(font.id);
  if (cached) return cached;

  const load = (async () => {
    const res = await fetch(fontFileUrl(font.id));
    if (!res.ok) throw new Error(`font file fetch failed: HTTP ${res.status}`);
    const buffer = await res.arrayBuffer();
    // Buffer-sourced faces parse eagerly; load() surfaces parse failures.
    const face = new FontFace(font.family, buffer, {
      weight: String(font.weight || 400),
    });
    await face.load();
    document.fonts.add(face);
    return true;
  })().catch(() => {
    faces.delete(font.id); // transient failure — leave the door open to retry
    return false;
  });

  faces.set(font.id, load);
  return load;
}
