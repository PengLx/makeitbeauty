import { useId } from "react";
import type { ReactNode } from "react";
import {
  type DesignAnimation,
  type DesignNode,
  type FontWeight,
  type TextAlign,
  type ImageNode,
  type InstanceNode,
  type RectNode,
  type TextNode,
} from "@/lib/design";
import type { KitComponent, KitProp } from "@/hooks/useKit";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface Props {
  node: DesignNode | null;
  /** Kit metadata for the selected instance node's component, if loaded. */
  kit: KitComponent | undefined;
  onPatch: (id: string, patch: Partial<DesignNode>) => void;
}

/** Right-column property editor for the selected node. */
export function Inspector({ node, kit, onPatch }: Props) {
  if (!node) {
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-center">
        <p className="text-xs leading-relaxed text-muted-foreground">
          No node selected.
          <br />
          Click a node on the canvas, or insert one from the palette.
        </p>
      </div>
    );
  }

  const patch = (p: Partial<DesignNode>) => onPatch(node.id, p);

  return (
    <div className="flex-1 space-y-4 overflow-y-auto p-4">
      <div className="flex items-center justify-between">
        <span className="font-mono text-xs text-muted-foreground">{node.id}</span>
        <span className="rounded-md bg-secondary px-1.5 py-0.5 font-mono text-[10px] uppercase text-secondary-foreground">
          {node.type}
        </span>
      </div>

      <Section title="Layout">
        <div className="grid grid-cols-2 gap-2">
          <NumberField label="X" value={node.x} onCommit={(v) => patch({ x: v })} />
          <NumberField label="Y" value={node.y} onCommit={(v) => patch({ y: v })} />
          <NumberField label="W" value={node.w} min={1} onCommit={(v) => patch({ w: v })} />
          <NumberField label="H" value={node.h} min={1} onCommit={(v) => patch({ h: v })} />
        </div>
        <Field label={`Opacity · ${Math.round((node.opacity ?? 1) * 100)}%`}>
          <Slider
            value={[Math.round((node.opacity ?? 1) * 100)]}
            min={0}
            max={100}
            step={1}
            onValueChange={([v]) =>
              patch({ opacity: v === 100 ? undefined : v / 100 })
            }
          />
        </Field>
      </Section>

      <Separator />
      <TypeSection node={node} kit={kit} patch={patch} />
      <Separator />
      <AnimationSection node={node} patch={patch} />
    </div>
  );
}

function TypeSection({
  node,
  kit,
  patch,
}: {
  node: DesignNode;
  kit: KitComponent | undefined;
  patch: (p: Partial<DesignNode>) => void;
}) {
  switch (node.type) {
    case "text":
      return <TextSection node={node} patch={patch} />;
    case "rect":
      return <RectSection node={node} patch={patch} />;
    case "image":
      return (
        <Section title="Image">
          <Field label="Fit">
            <Select
              value={node.fit ?? "cover"}
              onValueChange={(v) => patch({ fit: v as ImageNode["fit"] })}
            >
              <SelectTrigger size="sm" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="cover">cover</SelectItem>
                <SelectItem value="contain">contain</SelectItem>
                <SelectItem value="fill">fill</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        </Section>
      );
    case "instance":
      return <InstanceSection node={node} kit={kit} patch={patch} />;
  }
}

function TextSection({ node, patch }: { node: TextNode; patch: (p: Partial<DesignNode>) => void }) {
  const s = node.style ?? {};
  const setStyle = (next: Partial<TextNode["style"]>) =>
    patch({ style: { ...s, ...next } });
  return (
    <Section title="Text">
      <Field label="Content">
        <Textarea
          value={node.text}
          rows={3}
          spellCheck={false}
          className="font-mono text-xs"
          placeholder="Text — {{path.to.field}} binds data"
          onChange={(e) => patch({ text: e.target.value })}
        />
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <NumberField
          label="Size"
          value={s.fontSize ?? 16}
          min={1}
          max={512}
          onCommit={(v) => setStyle({ fontSize: v })}
        />
        <Field label="Weight">
          <Select
            value={String(s.fontWeight ?? 400)}
            onValueChange={(v) => setStyle({ fontWeight: Number(v) as FontWeight })}
          >
            <SelectTrigger size="sm" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[100, 200, 300, 400, 500, 600, 700, 800, 900].map((w) => (
                <SelectItem key={w} value={String(w)}>
                  {w}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>
      <ColorField
        label="Color"
        value={s.color ?? "#000000"}
        onCommit={(v) => setStyle({ color: v })}
      />
      <Field label="Align">
        <Select
          value={s.align ?? "left"}
          onValueChange={(v) => setStyle({ align: v as TextAlign })}
        >
          <SelectTrigger size="sm" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="left">left</SelectItem>
            <SelectItem value="center">center</SelectItem>
            <SelectItem value="right">right</SelectItem>
          </SelectContent>
        </Select>
      </Field>
    </Section>
  );
}

function RectSection({ node, patch }: { node: RectNode; patch: (p: Partial<DesignNode>) => void }) {
  const s = node.style ?? {};
  const setStyle = (next: Partial<RectNode["style"]>) =>
    patch({ style: { ...s, ...next } });
  return (
    <Section title="Rectangle">
      <ColorField
        label="Fill"
        value={s.fill ?? "transparent"}
        onCommit={(v) => setStyle({ fill: v })}
      />
      <NumberField
        label="Corner radius"
        value={s.radius ?? 0}
        min={0}
        onCommit={(v) => setStyle({ radius: v })}
      />
      <ColorField
        label="Stroke"
        value={s.stroke ?? ""}
        placeholder="none"
        onCommit={(v) => setStyle({ stroke: v || undefined })}
      />
      <NumberField
        label="Stroke width"
        value={s.strokeWidth ?? 0}
        min={0}
        onCommit={(v) => setStyle({ strokeWidth: v || undefined })}
      />
    </Section>
  );
}

function InstanceSection({
  node,
  kit,
  patch,
}: {
  node: InstanceNode;
  kit: KitComponent | undefined;
  patch: (p: Partial<DesignNode>) => void;
}) {
  if (!kit) {
    return (
      <Section title="Component">
        <p className="font-mono text-xs text-muted-foreground">{node.component}</p>
        <p className="text-xs text-muted-foreground">
          Kit metadata unavailable — prop editing needs the API running.
        </p>
      </Section>
    );
  }
  const setProp = (key: string, value: unknown) =>
    patch({ props: { ...node.props, [key]: value } });

  return (
    <Section title={kit.title}>
      <p className="font-mono text-[10px] text-muted-foreground">{kit.id}</p>
      {Object.entries(kit.props).map(([key, prop]) => (
        <PropField
          key={key}
          name={key}
          prop={prop}
          value={node.props?.[key]}
          onCommit={(v) => setProp(key, v)}
        />
      ))}
    </Section>
  );
}

/** One dynamic prop editor, typed by the kit component's metadata. */
function PropField({
  name,
  prop,
  value,
  onCommit,
}: {
  name: string;
  prop: KitProp;
  value: unknown;
  onCommit: (v: unknown) => void;
}) {
  const current = value ?? prop.default ?? "";
  if (prop.type === "number") {
    return (
      <NumberField
        label={name}
        title={prop.description}
        value={typeof current === "number" ? current : Number(current) || 0}
        onCommit={onCommit}
      />
    );
  }
  const text = String(current);
  // "color"-typed props, plus string props whose value looks like a color,
  // get a swatch next to the text input.
  if (prop.type === "color" || /^#[0-9a-fA-F]{3,8}$/.test(text)) {
    return <ColorField label={name} title={prop.description} value={text} onCommit={onCommit} />;
  }
  return (
    <Field label={name} title={prop.description}>
      <Input
        value={text}
        className="h-8 text-xs"
        onChange={(e) => onCommit(e.target.value)}
      />
    </Field>
  );
}

function AnimationSection({
  node,
  patch,
}: {
  node: DesignNode;
  patch: (p: Partial<DesignNode>) => void;
}) {
  const anim = node.animation;
  const setAnim = (next: Partial<DesignAnimation>) => {
    if (!anim) return;
    patch({ animation: { ...anim, ...next } });
  };
  return (
    <Section title="Animation">
      <Field label="Preset">
        <Select
          value={anim?.preset ?? "none"}
          onValueChange={(v) =>
            patch({
              animation:
                v === "none"
                  ? undefined
                  : { ...anim, preset: v as DesignAnimation["preset"] },
            })
          }
        >
          <SelectTrigger size="sm" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">none</SelectItem>
            <SelectItem value="fadeIn">fadeIn</SelectItem>
            <SelectItem value="pulse">pulse</SelectItem>
            <SelectItem value="float">float</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      {anim && (
        <>
          <div className="grid grid-cols-2 gap-2">
            <NumberField
              label="Duration ms"
              value={anim.durationMs ?? 800}
              min={1}
              max={60000}
              onCommit={(v) => setAnim({ durationMs: v })}
            />
            <NumberField
              label="Delay ms"
              value={anim.delayMs ?? 0}
              min={0}
              max={60000}
              onCommit={(v) => setAnim({ delayMs: v })}
            />
          </div>
          <div className="flex items-center justify-between">
            <Label className="text-xs text-muted-foreground">Loop</Label>
            <Switch
              checked={anim.loop ?? false}
              onCheckedChange={(loop) => setAnim({ loop })}
            />
          </div>
        </>
      )}
    </Section>
  );
}

/* ---------- small field primitives ---------- */

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2.5">
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </h3>
      {children}
    </section>
  );
}

function Field({
  label,
  title,
  children,
}: {
  label: string;
  title?: string;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <div className="space-y-1" title={title}>
      <Label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </Label>
      <div id={id}>{children}</div>
    </div>
  );
}

function NumberField({
  label,
  value,
  min,
  max,
  title,
  onCommit,
}: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  title?: string;
  onCommit: (v: number) => void;
}) {
  return (
    <Field label={label} title={title}>
      <Input
        type="number"
        value={value}
        min={min}
        max={max}
        className="h-8 text-xs"
        onChange={(e) => {
          const v = Math.round(Number(e.target.value));
          if (Number.isFinite(v)) onCommit(v);
        }}
      />
    </Field>
  );
}

function ColorField({
  label,
  value,
  title,
  placeholder,
  onCommit,
}: {
  label: string;
  value: string;
  title?: string;
  placeholder?: string;
  onCommit: (v: string) => void;
}) {
  const isHex = /^#[0-9a-fA-F]{6}$/.test(value);
  return (
    <Field label={label} title={title}>
      <div className="flex items-center gap-1.5">
        <input
          type="color"
          value={isHex ? value : "#000000"}
          aria-label={`${label} swatch`}
          className="size-8 shrink-0 cursor-pointer rounded-md border border-input bg-transparent p-0.5"
          onChange={(e) => onCommit(e.target.value)}
        />
        <Input
          value={value}
          placeholder={placeholder ?? "#rrggbb"}
          spellCheck={false}
          className="h-8 font-mono text-xs"
          onChange={(e) => onCommit(e.target.value)}
        />
      </div>
    </Field>
  );
}
