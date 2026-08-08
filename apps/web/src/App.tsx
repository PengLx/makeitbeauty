import { useState } from "react";
import demoDesign from "./fixtures/demo-design.json";
import { Palette } from "./components/Palette";
import { EditorTabs, type EditorTab } from "./components/EditorTabs";
import { CodePane } from "./components/CodePane";
import { PreviewPane } from "./components/PreviewPane";
import { Inspector } from "./components/Inspector";
import { usePreview } from "./hooks/usePreview";

export default function App() {
  const [tab, setTab] = useState<EditorTab>("design");
  // `code` is the source of truth the user edits; `design` is the last
  // successfully parsed document (what the preview renders).
  const [code, setCode] = useState(() => JSON.stringify(demoDesign, null, 2));
  const [design, setDesign] = useState<unknown>(demoDesign);
  const [parseError, setParseError] = useState<string | null>(null);

  // Lives at the App level so the preview survives tab switches.
  const preview = usePreview(design);

  function handleCodeChange(next: string) {
    setCode(next);
    try {
      setDesign(JSON.parse(next));
      setParseError(null);
    } catch (e) {
      setParseError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="flex h-screen flex-col bg-[#0d1117] text-[#e6edf3]">
      <header className="flex shrink-0 items-center gap-3 border-b border-[#30363d] bg-[#010409] px-4 py-2.5">
        <span className="text-sm font-semibold">MakeItBeauty</span>
        <span className="rounded-full border border-[#30363d] px-2 py-0.5 text-[10px] uppercase tracking-wider text-[#7d8590]">
          editor
        </span>
        <span className="ml-auto truncate text-xs text-[#7d8590]">
          {(demoDesign as { name?: string }).name ?? "Untitled design"}
        </span>
      </header>

      <div className="flex min-h-0 flex-1">
        <Palette />

        <main className="flex min-w-0 flex-1 flex-col">
          <EditorTabs tab={tab} onSelect={setTab} />
          {tab === "design" ? (
            <PreviewPane preview={preview} />
          ) : (
            <CodePane
              code={code}
              onChange={handleCodeChange}
              parseError={parseError}
            />
          )}
        </main>

        <Inspector />
      </div>
    </div>
  );
}
