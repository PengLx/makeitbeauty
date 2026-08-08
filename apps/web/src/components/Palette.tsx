/** Kit v0 components. Static for now; drag-to-canvas lands with the canvas editor. */
const KIT_V0 = [
  { id: "kit/stat-card", label: "Stat card", desc: "Number + label + trend" },
  { id: "kit/text-banner", label: "Text banner", desc: "Headline with accent bar" },
  { id: "kit/progress-bar", label: "Progress bar", desc: "Value against a goal" },
];

export function Palette() {
  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-[#30363d] bg-[#010409]">
      <div className="border-b border-[#30363d] px-4 py-3">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-[#7d8590]">
          Components
        </h2>
      </div>
      <ul className="flex-1 overflow-y-auto p-2">
        {KIT_V0.map((c) => (
          <li
            key={c.id}
            className="mb-1 cursor-not-allowed rounded-md border border-transparent px-3 py-2 hover:border-[#30363d] hover:bg-[#161b22]"
            title="Available in Phase 1"
          >
            <div className="text-sm font-medium text-[#e6edf3]">{c.label}</div>
            <div className="text-xs text-[#7d8590]">{c.desc}</div>
            <div className="mt-0.5 font-mono text-[10px] text-[#484f58]">{c.id}</div>
          </li>
        ))}
      </ul>
      <p className="border-t border-[#30363d] px-4 py-3 text-xs leading-relaxed text-[#7d8590]">
        Official kit lands in{" "}
        <span className="font-medium text-[#58a6ff]">Phase 1</span> — these
        entries are placeholders.
      </p>
    </aside>
  );
}
