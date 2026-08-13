import { useEffect, useState } from "react";
import { listFonts, type FontList } from "@/lib/api";
import { subscribeFontCache } from "@/lib/fontCache";
import { ensureFontFace } from "@/lib/fontFaces";
import { referencedFontFamilies } from "@/lib/fonts";
import type { DesignDoc } from "@/lib/design";

export interface FontsState {
  /** null until loaded; stays null on 401/unavailable (pickers degrade to
      the built-in families pinned in lib/fonts.ts). */
  fonts: FontList | null;
}

/**
 * Loads GET /v1/fonts ONCE per editor for the font picker and the canvas's
 * FontFace registration, refetching when the upload dialog uploads/deletes a
 * font (fontCache invalidation — the useConnectors pattern). Deliberately
 * silent on failure: the picker still offers built-ins, and the management
 * UI with inline errors lives in the upload dialog.
 */
export function useFonts(): FontsState {
  const [fonts, setFonts] = useState<FontList | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => subscribeFontCache(() => setVersion((n) => n + 1)), []);

  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        setFonts(await listFonts(controller.signal));
      } catch {
        if (controller.signal.aborted) return;
        setFonts(null);
      }
    })();
    return () => controller.abort();
  }, [version]);

  return { fonts };
}

/**
 * Registers a FontFace for each of MY uploaded fonts whose family the open
 * design references (canvas parity — text must measure in the face the
 * renderer will use). Runs on every design change but is cheap: fontFaces.ts
 * caches per font id, so each face is fetched at most once per session.
 */
export function useDesignFontFaces(
  fonts: FontList | null,
  design: DesignDoc | null,
): void {
  useEffect(() => {
    if (!fonts || !design) return;
    const referenced = new Set(referencedFontFamilies(design));
    for (const font of fonts.mine) {
      if (referenced.has(font.family)) void ensureFontFace(font);
    }
  }, [fonts, design]);
}
