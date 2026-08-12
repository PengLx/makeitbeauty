// The class catalog: every utility family the compiler understands, for
// editor autocomplete and lint. Kept in lockstep with compileTw by the
// test suite (a CATALOG snapshot plus one compile test per family).

export interface CatalogEntry {
  /** Class prefix the family answers to (exact class for prefix-less forms). */
  prefix: string;
  kind:
    | "color"
    | "gradient"
    | "typography"
    | "radius"
    | "border"
    | "shadow"
    | "opacity"
    | "spacing";
  doc: string;
}

export const CATALOG: readonly CatalogEntry[] = [
  {
    prefix: "bg-",
    kind: "color",
    doc: "Background color: bg-{family}-{50..950} (Tailwind v4 palette), bg-black|white|transparent, or bg-[#hex|rgb()|hsl()|named] -> backgroundColor.",
  },
  {
    prefix: "bg-gradient-to-",
    kind: "gradient",
    doc: "Gradient direction: t|tr|r|br|b|bl|l|tl (0/45/90/135/180/225/270/315deg). Combine with from-/via-/to- stops -> backgroundImage: linear-gradient().",
  },
  {
    prefix: "from-",
    kind: "gradient",
    doc: "Gradient start color (0% stop): palette or arbitrary [..] color. Requires bg-gradient-to-*.",
  },
  {
    prefix: "via-",
    kind: "gradient",
    doc: "Gradient middle color (50% stop): palette or arbitrary [..] color. Requires bg-gradient-to-*.",
  },
  {
    prefix: "to-",
    kind: "gradient",
    doc: "Gradient end color (100% stop): palette or arbitrary [..] color. Requires bg-gradient-to-*.",
  },
  {
    prefix: "text-",
    kind: "color",
    doc: "Text color: palette or arbitrary [..] color -> color. (Sizes like text-lg are not supported.)",
  },
  {
    prefix: "font-",
    kind: "typography",
    doc: "Font weight: thin|extralight|light|normal|medium|semibold|bold|extrabold|black or 100..900 -> fontWeight (number).",
  },
  {
    prefix: "tracking-",
    kind: "typography",
    doc: "Letter spacing: tighter|tight|normal|wide|wider|widest (em values on a 16px basis) or [Npx] -> letterSpacing.",
  },
  {
    prefix: "leading-",
    kind: "typography",
    doc: "Line height: none|tight|snug|normal|relaxed|loose or unitless [N] -> lineHeight (number).",
  },
  {
    prefix: "rounded",
    kind: "radius",
    doc: "Border radius: rounded (4px), -none|-sm|-md|-lg|-xl|-2xl|-3xl, -full (9999px), or -[Npx] -> borderRadius.",
  },
  {
    prefix: "border",
    kind: "border",
    doc: "Border: border (1px) and border-0|2|4|8 set borderWidth + borderStyle solid; border-{palette} or border-[..] set borderColor.",
  },
  {
    prefix: "shadow",
    kind: "shadow",
    doc: "Box shadow: shadow, -sm|-md|-lg|-xl|-2xl|-none (standard Tailwind strings, hardcoded) or shadow-[..] matching a strict grammar (2-4 lengths, one color; url()/var() rejected) -> boxShadow.",
  },
  {
    prefix: "opacity-",
    kind: "opacity",
    doc: "Opacity: 0..100 in steps of 5 (opacity-60 -> 0.6) or [0.x] -> opacity (number).",
  },
  {
    prefix: "p-",
    kind: "spacing",
    doc: "Padding on all sides: p-{0..12} on the 4px scale -> paddingTop/Right/Bottom/Left.",
  },
  {
    prefix: "px-",
    kind: "spacing",
    doc: "Horizontal padding: px-{0..12} on the 4px scale -> paddingLeft/Right.",
  },
  {
    prefix: "py-",
    kind: "spacing",
    doc: "Vertical padding: py-{0..12} on the 4px scale -> paddingTop/Bottom.",
  },
];
