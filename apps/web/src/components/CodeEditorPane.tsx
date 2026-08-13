import { useMemo, useRef } from "react";
import type { KeyboardEvent, UIEvent } from "react";
import { CODE_MAX_BYTES, utf8ByteLength } from "@/lib/component";
import { cn } from "@/lib/utils";

/**
 * JetBrains Mono first (loaded via @fontsource in index.css — the same face
 * the renderer embeds), then the platform monospace stack.
 */
const MONO_STACK =
  "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

/** Shared metrics so the gutter's line numbers track the textarea exactly. */
const CODE_FONT_SIZE = 13;
const CODE_LINE_HEIGHT = 1.6;

interface Props {
  code: string;
  onChange: (next: string) => void;
}

/**
 * Studio center pane for kind "code" drafts (§7.6): the render-function
 * source, editable as plain text — a component IS one pure function, so the
 * surface is a focused monospace editor, not a canvas. Line numbers track
 * scroll; Tab inserts two spaces; the footer counts UTF-8 bytes against the
 * 64 KiB source cap (schema `code` maxLength = sandbox maxSourceBytes) and
 * carries the one publish gotcha prose can trip: the props-only walk scans
 * EVERY string — descriptions included — for {{…}} templates.
 */
export function CodeEditorPane({ code, onChange }: Props) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);

  const bytes = useMemo(() => utf8ByteLength(code), [code]);
  const overLimit = bytes > CODE_MAX_BYTES;
  const lineCount = useMemo(() => code.split("\n").length, [code]);
  // Gutter width follows the digit count so it never jumps mid-edit.
  const gutterCh = Math.max(3, String(lineCount).length + 1);

  /** Tab inserts spaces instead of leaving the editor (code-editor idiom). */
  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key !== "Tab" || e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) {
      return;
    }
    e.preventDefault();
    const el = e.currentTarget;
    const start = el.selectionStart ?? code.length;
    const end = el.selectionEnd ?? start;
    onChange(code.slice(0, start) + "  " + code.slice(end));
    // Restore the caret after React re-renders the controlled value.
    requestAnimationFrame(() => {
      el.selectionStart = el.selectionEnd = start + 2;
    });
  }

  /** Keep the line-number column glued to the textarea's vertical scroll. */
  function handleScroll(e: UIEvent<HTMLTextAreaElement>) {
    if (gutterRef.current) {
      gutterRef.current.scrollTop = e.currentTarget.scrollTop;
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex min-h-0 flex-1">
        <div
          ref={gutterRef}
          aria-hidden
          className="shrink-0 overflow-hidden border-r bg-card py-3 text-right select-none"
          style={{
            width: `${gutterCh}ch`,
            fontFamily: MONO_STACK,
            fontSize: CODE_FONT_SIZE,
            lineHeight: CODE_LINE_HEIGHT,
          }}
        >
          <div className="pr-2 text-muted-foreground/50">
            {Array.from({ length: lineCount }, (_, i) => (
              <div key={i}>{i + 1}</div>
            ))}
          </div>
        </div>
        <textarea
          ref={textareaRef}
          value={code}
          wrap="off"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          aria-label="Component render function source"
          placeholder={"function render({ props, frame }) {\n  return [];\n}"}
          className="min-w-0 flex-1 resize-none overflow-auto bg-background px-3 py-3
            whitespace-pre text-foreground outline-none placeholder:text-muted-foreground"
          style={{
            fontFamily: MONO_STACK,
            fontSize: CODE_FONT_SIZE,
            lineHeight: CODE_LINE_HEIGHT,
            tabSize: 2,
          }}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          onScroll={handleScroll}
        />
      </div>
      <div
        className={cn(
          "flex shrink-0 items-center gap-3 border-t px-4 py-2 text-xs",
          overLimit
            ? "border-destructive/40 bg-destructive/10 text-destructive"
            : "bg-card text-muted-foreground",
        )}
      >
        <p className="min-w-0 flex-1 truncate">
          {overLimit ? (
            <>
              <span className="font-medium">Over the source limit</span> — the
              sandbox rejects components over 64 KB; trim before publishing.
            </>
          ) : (
            <>
              render(&#123; props, frame &#125;) → nodes · publish scans every
              string for bindings, so keep literal{" "}
              <code className="font-mono text-[11px]">{"{{…}}"}</code> out of
              prop descriptions and other prose.
            </>
          )}
        </p>
        <span
          className={cn(
            "shrink-0 font-mono tabular-nums",
            overLimit && "font-semibold",
          )}
        >
          {(bytes / 1024).toFixed(1)} / 64 KB
        </span>
      </div>
    </div>
  );
}
