import { useEffect, useId, useRef, useState } from "react";
import { compileTw } from "@makeitbeauty/twc";
import {
  applyCompletion,
  currentToken,
  suggestCompletions,
  TW_EXAMPLES,
} from "@/lib/tw";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

/** One debounce window covers both the lint pass and the document commit. */
const DEBOUNCE_MS = 300;
const HINT_CYCLE_MS = 5000;

interface Props {
  /** Committed tw string (node.tw / canvas.tw); "" when the key is unset. */
  value: string;
  /**
   * Commit sink. `undefined` drops the key entirely (updateNode and the
   * Editor's patchCanvas both delete undefined keys), so cleared fields
   * serialize away instead of leaving `"tw": ""` litter.
   */
  onCommit: (tw: string | undefined) => void;
  /** Muted caption under the field (e.g. the instance no-op note). */
  note?: string;
}

/**
 * The "Styles" field: a monospace auto-growing textarea over node.tw /
 * canvas.tw. Typing debounces ~300ms, then compileTw lints locally (warnings
 * render as amber chips — same compiler the renderer runs, so editor lint =
 * render-time warnings) and the value commits. A plain CATALOG-derived
 * suggestion list completes the token being typed; a muted hint line cycles
 * example strings so an empty field still teaches what tw can do.
 *
 * Draft state is local; parents MUST key this component by the edited
 * entity (e.g. key={node.id}) so selection changes reset the draft.
 */
export function TwField({ value, onCommit, note }: Props) {
  const id = useId();
  const [draft, setDraft] = useState(value);
  // Lint the initial value eagerly: selecting a node with a stale bad class
  // should show its chips without requiring a keystroke.
  const [warnings, setWarnings] = useState<string[]>(
    () => (value === "" ? [] : compileTw(value).warnings),
  );
  const [focused, setFocused] = useState(false);
  const [hintIndex, setHintIndex] = useState(0);

  const timer = useRef<number | null>(null);
  /** Draft text awaiting commit; null when clean. */
  const pending = useRef<string | null>(null);
  // Latest commit callback — parents pass inline arrows, and the unmount
  // flush below must not capture a stale one.
  const onCommitRef = useRef(onCommit);
  onCommitRef.current = onCommit;

  function commit(text: string) {
    const trimmed = text.trim();
    onCommitRef.current(trimmed === "" ? undefined : trimmed);
  }

  function flush() {
    if (timer.current != null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    if (pending.current == null) return;
    const text = pending.current;
    pending.current = null;
    setWarnings(compileTw(text).warnings);
    commit(text);
  }

  function schedule(next: string) {
    pending.current = next;
    if (timer.current != null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(flush, DEBOUNCE_MS);
  }

  // Unmount (node switch / panel close): cancel the timer but never lose the
  // last keystrokes — commit straight from the ref, without touching state.
  useEffect(() => {
    return () => {
      if (timer.current != null) window.clearTimeout(timer.current);
      if (pending.current != null) {
        const text = pending.current;
        pending.current = null;
        const trimmed = text.trim();
        onCommitRef.current(trimmed === "" ? undefined : trimmed);
      }
    };
  }, []);

  // Rotate the hint examples while mounted; cheap enough to just always run.
  useEffect(() => {
    const handle = window.setInterval(
      () => setHintIndex((i) => (i + 1) % TW_EXAMPLES.length),
      HINT_CYCLE_MS,
    );
    return () => window.clearInterval(handle);
  }, []);

  const token = currentToken(draft);
  const suggestions = focused ? suggestCompletions(token) : [];

  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between">
        <Label htmlFor={id} className="text-xs text-muted-foreground">
          Styles
        </Label>
        <span className="font-mono text-[10px] text-muted-foreground/60">tw</span>
      </div>
      <Textarea
        id={id}
        value={draft}
        rows={1}
        spellCheck={false}
        autoComplete="off"
        autoCapitalize="off"
        placeholder="bg-gradient-to-r from-… shadow-lg"
        // field-sizing-content (ui/textarea) auto-grows; just lower the floor.
        className="min-h-8 py-1.5 font-mono text-xs leading-relaxed md:text-xs"
        onChange={(e) => {
          setDraft(e.target.value);
          schedule(e.target.value);
        }}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          flush();
        }}
      />
      {suggestions.length > 0 && (
        <ul className="overflow-hidden rounded-md border bg-popover">
          {suggestions.map((s) => (
            <li key={s.prefix}>
              <button
                type="button"
                // mousedown (not click) so the textarea never blurs — blur
                // would flush the commit and close this list before click.
                onMouseDown={(e) => {
                  e.preventDefault();
                  const next = applyCompletion(draft, s.prefix);
                  setDraft(next);
                  schedule(next);
                }}
                title={s.doc}
                className="flex w-full items-baseline gap-2 px-2 py-1 text-left transition-colors hover:bg-accent"
              >
                <code className="font-mono text-xs">{s.prefix}</code>
                <span className="truncate text-[10px] text-muted-foreground">
                  {s.kind}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {warnings.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {warnings.map((w) => (
            <span
              key={w}
              className="rounded-full border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] leading-tight text-amber-500"
            >
              {w}
            </span>
          ))}
        </div>
      )}
      <p className="truncate font-mono text-[10px] text-muted-foreground/70">
        e.g. {TW_EXAMPLES[hintIndex]}
      </p>
      {note && (
        <p className="text-[11px] leading-snug text-muted-foreground">{note}</p>
      )}
    </div>
  );
}
