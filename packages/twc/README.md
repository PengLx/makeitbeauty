# @makeitbeauty/twc

Deterministic Tailwind-subset compiler: a node's `tw` utility string in, a
flat satori-safe style object out. Pure and dependency-free; shared by the
renderer and the editor so semantics never drift. Contract:
`docs/architecture.md` §5.6.

```ts
import { compileTw, CATALOG } from "@makeitbeauty/twc";

const { style, warnings } = compileTw(
  "bg-gradient-to-br from-indigo-500 to-pink-500 rounded-2xl shadow-2xl p-6",
);
// style.backgroundImage === "linear-gradient(135deg, #615fff 0%, #f6339a 100%)"
// CATALOG lists every supported class family for editor autocomplete/lint.
```

Supported families: `bg-` (color, gradients via `bg-gradient-to-*` +
`from-/via-/to-`), `text-`, `font-` (weight), `tracking-`, `leading-`,
`rounded*`, `border*` (width + color), `shadow*` (presets + strict arbitrary
grammar), `opacity-*`, `p-/px-/py-`.

Policy:

- **Whitelist.** Unknown or unsupported classes warn and are dropped — never
  failures, never passthrough.
- **Last wins per property** (Tailwind semantics) for conflicting classes.
- **Deterministic.** The Tailwind v4 palette is baked in as hex
  (`src/palette.ts`, generated from `tailwindcss@4.3.3` theme.css oklch
  values); shadow presets are hardcoded verbatim. Same input → deep-equal
  output.
- **Defense in depth.** Values containing `url(`, `var(`, `;` or newlines are
  dropped with a warning. The compiler can only emit vetted properties; the
  design schema and the SVG output sanitizer remain downstream gates.
