export function Inspector() {
  return (
    <aside className="flex w-72 shrink-0 flex-col border-l border-[#30363d] bg-[#010409]">
      <div className="border-b border-[#30363d] px-4 py-3">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-[#7d8590]">
          Inspector
        </h2>
      </div>
      <div className="flex flex-1 items-center justify-center p-6 text-center">
        <p className="text-xs leading-relaxed text-[#7d8590]">
          No node selected.
          <br />
          Selected-node properties (position, style, bindings) appear here once
          canvas selection ships.
        </p>
      </div>
    </aside>
  );
}
