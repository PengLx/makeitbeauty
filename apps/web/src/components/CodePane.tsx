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
        className="flex-1 resize-none bg-[#0d1117] p-4 font-mono text-[13px] leading-relaxed
          text-[#e6edf3] outline-none placeholder:text-[#484f58]"
        placeholder="Design JSON…"
      />
      <div
        className={`border-t px-4 py-2 text-xs ${
          parseError
            ? "border-[#f8514966] bg-[#f851491a] text-[#f85149]"
            : "border-[#30363d] bg-[#010409] text-[#484f58]"
        }`}
      >
        {parseError ? (
          <>
            <span className="font-medium">Invalid JSON:</span> {parseError} —
            preview shows the last valid design.
          </>
        ) : (
          "Valid JSON — preview updates as you type (500 ms debounce)."
        )}
      </div>
    </div>
  );
}
