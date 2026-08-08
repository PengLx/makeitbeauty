interface Props {
  code: string;
  onChange: (next: string) => void;
  /** JSON.parse error for the current text, if any. */
  parseError: string | null;
}

/** Code mode: the raw design document, editable as JSON. */
export function CodePane({ code, onChange, parseError }: Props) {
  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <textarea
        value={code}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        aria-label="Design JSON"
        className="flex-1 resize-none bg-background p-4 font-mono text-[13px] leading-relaxed
          text-foreground outline-none placeholder:text-muted-foreground"
        placeholder="Design JSON…"
      />
      <div
        className={`border-t px-4 py-2 text-xs ${
          parseError
            ? "border-destructive/40 bg-destructive/10 text-destructive"
            : "bg-card text-muted-foreground"
        }`}
      >
        {parseError ? (
          <>
            <span className="font-medium">Invalid JSON:</span> {parseError} —
            preview shows the last valid design.
          </>
        ) : (
          "Valid JSON — canvas and preview update as you type (500 ms debounce)."
        )}
      </div>
    </div>
  );
}
