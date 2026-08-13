import { useState } from "react";
import { Upload } from "lucide-react";
import type { FontList } from "@/lib/api";
import {
  DEFAULT_FONT_FAMILY,
  fontPickerGroups,
  fontStackFor,
} from "@/lib/fonts";
import { FontUploadDialog } from "@/components/FontUploadDialog";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/** Sentinel item value: opens the upload dialog instead of picking a family. */
const UPLOAD_ITEM = "__upload__";

interface Props {
  /** style.fontFamily — undefined means the Inter default (key dropped). */
  value: string | undefined;
  /** GET /v1/fonts list (useFonts); null/omitted degrades to built-ins. */
  fonts?: FontList | null;
  /**
   * Component Studio mode: built-in families only plus the isolation note —
   * community components may never reference a private upload (§7.5), and
   * the picker surfaces that rule instead of leaving it to the server's
   * publish-time rejection.
   */
  studio?: boolean;
  /** undefined = back to the Inter default (the key is dropped). */
  onChange: (family: string | undefined) => void;
}

/**
 * Font family select for the Inspector's text section: Built-in group
 * (everyone), My fonts group (the session user's uploads, Editor only) and
 * an Upload item opening the manage dialog. Item labels render in their own
 * face where the browser has it (built-ins always — index.css; uploads once
 * the canvas loaded them).
 */
export function FontPicker({ value, fonts, studio, onChange }: Props) {
  const [uploadOpen, setUploadOpen] = useState(false);
  const groups = fontPickerGroups(fonts ?? null, value, { builtinOnly: studio });
  const current = value ?? DEFAULT_FONT_FAMILY;

  return (
    <>
      <Select
        value={current}
        onValueChange={(v) => {
          if (v === UPLOAD_ITEM) {
            // Not a family: open the dialog; the controlled value snaps back.
            setUploadOpen(true);
            return;
          }
          onChange(v === DEFAULT_FONT_FAMILY ? undefined : v);
        }}
      >
        <SelectTrigger size="sm" className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectLabel>Built-in</SelectLabel>
            {groups.builtin.map((family) => (
              <SelectItem key={family} value={family}>
                <span style={{ fontFamily: fontStackFor(family) }}>{family}</span>
              </SelectItem>
            ))}
          </SelectGroup>
          {!studio && groups.mine.length > 0 && (
            <SelectGroup>
              <SelectLabel>My fonts</SelectLabel>
              {groups.mine.map((family) => (
                <SelectItem key={family} value={family}>
                  <span style={{ fontFamily: fontStackFor(family) }}>{family}</span>
                </SelectItem>
              ))}
            </SelectGroup>
          )}
          {groups.missing && (
            // Keeps the trigger readable when the design references a family
            // that isn't offered (deleted upload, someone else's font) —
            // rendering falls back to Inter with a warning, never a failure.
            <SelectItem value={groups.missing} className="text-muted-foreground">
              {groups.missing} (unavailable)
            </SelectItem>
          )}
          {!studio && (
            <>
              <SelectSeparator />
              <SelectItem value={UPLOAD_ITEM}>
                <Upload className="size-3.5" aria-hidden />
                Upload font…
              </SelectItem>
            </>
          )}
        </SelectContent>
      </Select>
      {studio && (
        <p className="text-[11px] text-muted-foreground">
          Community components use built-in fonts.
        </p>
      )}
      {!studio && (
        <FontUploadDialog
          open={uploadOpen}
          onOpenChange={setUploadOpen}
          mine={fonts?.mine ?? []}
          onUploaded={(font) => {
            setUploadOpen(false);
            onChange(font.family);
          }}
        />
      )}
    </>
  );
}
