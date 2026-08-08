export type EditorTab = "design" | "code";

interface Props {
  tab: EditorTab;
  onSelect: (tab: EditorTab) => void;
}

const TABS: { id: EditorTab; label: string }[] = [
  { id: "design", label: "Design" },
  { id: "code", label: "Code" },
];

/** Center-pane tab switcher between the canvas preview and the JSON source. */
export function EditorTabs({ tab, onSelect }: Props) {
  return (
    <div className="flex items-center gap-1 border-b border-[#30363d] bg-[#010409] px-3">
      {TABS.map((t) => (
        <button
          key={t.id}
          onClick={() => onSelect(t.id)}
          className={`-mb-px border-b-2 px-4 py-2.5 text-sm transition-colors ${
            tab === t.id
              ? "border-[#f78166] font-medium text-[#e6edf3]"
              : "border-transparent text-[#7d8590] hover:text-[#e6edf3]"
          }`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
