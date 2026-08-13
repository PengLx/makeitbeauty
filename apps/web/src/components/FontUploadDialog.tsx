import { useId, useRef, useState } from "react";
import { Loader2, Trash2 } from "lucide-react";
import {
  ApiError,
  deleteFont,
  toApiError,
  uploadFont,
  type UserFont,
} from "@/lib/api";
import {
  familyFromFilename,
  validateFontFile,
  FONT_FILE_ACCEPT,
  FONT_MAX_COUNT,
} from "@/lib/fonts";
import { invalidateFontCache } from "@/lib/fontCache";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/** Compact inline failure line (client pre-check or the §8 error envelope). */
function InlineError({ error }: { error: { code: string; message: string } }) {
  return (
    <p role="alert" className="text-[11px] text-destructive">
      {error.message}{" "}
      <code className="font-mono text-[10px] opacity-70">[{error.code}]</code>
    </p>
  );
}

/**
 * One uploaded font in the manage list: identity + Delete behind a confirm —
 * deleting downgrades every design using the family to the Inter fallback
 * (render warning, never a failure), so the confirm says exactly that.
 */
function FontRow({ font, onChanged }: { font: UserFont; onChanged: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  async function remove() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await deleteFont(font.id);
      setConfirming(false);
      onChanged();
    } catch (e) {
      setError(toApiError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="flex items-center justify-between gap-2 rounded-lg border px-3 py-1.5">
      <p className="min-w-0 truncate text-xs">
        <span className="font-medium">{font.family}</span>{" "}
        <span className="text-muted-foreground">
          · {font.weight} · {font.format} · {Math.max(1, Math.round(font.size / 1024))} KB
        </span>
      </p>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={`Delete ${font.family} (${font.weight})`}
        className="shrink-0 text-muted-foreground hover:text-destructive"
        onClick={() => {
          setError(null);
          setConfirming(true);
        }}
      >
        <Trash2 />
      </Button>
      <ConfirmDialog
        open={confirming}
        onOpenChange={(next) => {
          if (!busy) setConfirming(next);
        }}
        title={`Delete “${font.family}” (${font.weight})?`}
        description={
          <>
            The font file is removed from your account. Designs that use{" "}
            {font.family} keep rendering, but fall back to Inter until you
            upload it again.
          </>
        }
        confirmLabel={busy ? "Deleting…" : "Delete font"}
        destructive
        busy={busy}
        error={error}
        onConfirm={() => void remove()}
      />
    </li>
  );
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The session user's uploads (GET /v1/fonts mine) for the manage list. */
  mine: UserFont[];
  /** Fired with the created font after a successful upload — the picker
      selects the new family. List refreshes ride the fontCache invalidation. */
  onUploaded: (font: UserFont) => void;
}

/**
 * Upload + manage dialog for the user's own fonts (font-system contract):
 * file input (TTF/OTF/WOFF only — WOFF2 is pre-checked client-side with the
 * satori explanation before the server would 400 the same way), family name
 * prefilled from the filename, weight 400/700, POST /v1/fonts multipart with
 * the §8 error envelope surfacing inline. Uploads are private: only the
 * owner's designs can use them, and community components can't reference
 * them at all.
 */
export function FontUploadDialog({ open, onOpenChange, mine, onUploaded }: Props) {
  const fileId = useId();
  const familyId = useId();
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [family, setFamily] = useState("");
  // Once the user edits the family by hand, picking another file stops
  // overwriting their text with the filename-derived prefill.
  const [familyTouched, setFamilyTouched] = useState(false);
  const [weight, setWeight] = useState<"400" | "700">("400");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code: string; message: string } | null>(
    null,
  );

  const atLimit = mine.length >= FONT_MAX_COUNT;

  function reset() {
    setFile(null);
    setFamily("");
    setFamilyTouched(false);
    setWeight("400");
    setError(null);
    if (fileRef.current) fileRef.current.value = "";
  }

  function handleOpenChange(next: boolean) {
    onOpenChange(next);
    if (!next) reset();
  }

  function handleFile(next: File | null) {
    setFile(next);
    setError(null);
    if (next && (!familyTouched || family.trim() === "")) {
      setFamily(familyFromFilename(next.name));
      setFamilyTouched(false);
    }
  }

  async function upload() {
    if (busy) return;
    if (!file) {
      setError({ code: "no_file", message: "Choose a font file first." });
      return;
    }
    const trimmed = family.trim();
    if (trimmed === "") {
      setError({ code: "no_family", message: "Give the font a family name." });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // Pre-checks mirror the server (extension, 5MB, magic bytes — WOFF2
      // gets the explanatory message); the server remains the boundary.
      const bytes = new Uint8Array(await file.arrayBuffer());
      const invalid = validateFontFile(file.name, file.size, bytes);
      if (invalid !== null) {
        setError(invalid);
        return;
      }
      const font = await uploadFont(file, trimmed, Number(weight));
      invalidateFontCache();
      reset();
      onUploaded(font);
    } catch (e) {
      setError(toApiError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>My fonts</DialogTitle>
          <DialogDescription>
            Upload a font to use it in your own designs. Community components
            stick to the built-in families, so uploads never leave your
            account.
          </DialogDescription>
        </DialogHeader>

        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            void upload();
          }}
        >
          <div className="space-y-1">
            <Label htmlFor={fileId} className="text-xs text-muted-foreground">
              Font file
            </Label>
            <Input
              id={fileId}
              ref={fileRef}
              type="file"
              accept={FONT_FILE_ACCEPT}
              disabled={busy}
              className="h-8 text-xs"
              onChange={(e) => handleFile(e.target.files?.[0] ?? null)}
            />
          </div>
          <div className="grid grid-cols-[1fr_auto] gap-2">
            <div className="space-y-1">
              <Label htmlFor={familyId} className="text-xs text-muted-foreground">
                Family name
              </Label>
              <Input
                id={familyId}
                value={family}
                placeholder="e.g. Space Grotesk"
                disabled={busy}
                spellCheck={false}
                className="h-8 text-xs"
                onChange={(e) => {
                  setFamily(e.target.value);
                  setFamilyTouched(true);
                }}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Weight</Label>
              <Select
                value={weight}
                onValueChange={(v) => setWeight(v as "400" | "700")}
                disabled={busy}
              >
                <SelectTrigger size="sm" className="w-24">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="400">400</SelectItem>
                  <SelectItem value="700">700</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          {error ? (
            <InlineError error={error} />
          ) : (
            <p className="text-[11px] text-muted-foreground">
              TTF, OTF or WOFF · 5 MB per file · {FONT_MAX_COUNT} fonts per
              account. WOFF2 isn't supported (the renderer's layout engine
              can't parse it).
            </p>
          )}
          <Button
            type="submit"
            size="sm"
            disabled={busy || !file || family.trim() === "" || atLimit}
          >
            {busy ? (
              <>
                <Loader2 data-icon="inline-start" className="animate-spin" />
                Uploading…
              </>
            ) : (
              "Upload font"
            )}
          </Button>
          {atLimit && (
            <p className="text-[11px] text-amber-500">
              Font limit reached ({FONT_MAX_COUNT}) — delete one below to
              upload another.
            </p>
          )}
        </form>

        {mine.length > 0 && (
          <div className="space-y-1.5">
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Uploaded
            </h3>
            <ul className="space-y-1.5">
              {mine.map((font) => (
                <FontRow
                  key={font.id}
                  font={font}
                  onChanged={invalidateFontCache}
                />
              ))}
            </ul>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
