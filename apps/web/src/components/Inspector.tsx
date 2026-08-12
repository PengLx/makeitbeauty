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
  ANIMATION_PRESETS,
} from "@/lib/design";
import type { KitComponent, KitProp } from "@/hooks/useKit";
import type { ConnectorInfo } from "@/lib/api";
import { BindingControl, FieldSelect, type BindingKind } from "@/components/BindingControl";
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
  /** Connector list from the one shared /v1/connectors load; [] when unavailable. */
  connectors: ConnectorInfo[];
  /**
   * Component Studio mode: `connectors` is the synthetic "props" source
   * (§7.5 — components may only reference {{props.*}}, never connector
   * data), so the binding surfaces re-label from data language to props.
   */
  propsOnly?: boolean;
  onPatch: (id: string, patch: Partial<DesignNode>) => void;
}

/** Right-column property editor for the selected node. */
export function Inspector({ node, kit, connectors, propsOnly, onPatch }: Props) {
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
      <TypeSection
        node={node}
        kit={kit}
        connectors={connectors}
        propsOnly={propsOnly}
        patch={patch}
      />
      <Separator />
      <AnimationSection node={node} patch={patch} />
    </div>
  );
}

function TypeSection({
  node,
  kit,
  connectors,
  propsOnly,
  patch,
}: {
  node: DesignNode;
  kit: KitComponent | undefined;
  connectors: ConnectorInfo[];
  propsOnly?: boolean;
  patch: (p: Partial<DesignNode>) => void;
}) {
  switch (node.type) {
    case "text":
      return (
        <TextSection
          node={node}
          connectors={connectors}
          propsOnly={propsOnly}
          patch={patch}
        />
      );
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
      return <InstanceSection node={node} kit={kit} connectors={connectors} patch={patch} />;
  }
}

function TextSection({
  node,
  connectors,
  propsOnly,
  patch,
}: {
  node: TextNode;
  connectors: ConnectorInfo[];
  propsOnly?: boolean;
  patch: (p: Partial<DesignNode>) => void;
}) {
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
          placeholder={
            propsOnly
              ? "Text — {{props.name}} fills a prop slot"
              : "Text — {{path.to.field}} binds data"
          }
          onChange={(e) => patch({ text: e.target.value })}
        />
      </Field>
      {connectors.some((c) => (c.fields ?? []).length > 0) && (
        <Field label={propsOnly ? "Insert prop" : "Insert field"}>
          {/* value stays "" so the trigger always shows the placeholder;
              selecting appends the {{connector.path}} template to the content
              (v0: end-of-text, not cursor position). Text is compositional —
              string AND number fields both insert; numbers stringify. */}
          <FieldSelect
            connectors={connectors}
            value=""
            placeholder={propsOnly ? "Insert {{props.*}}…" : "Bind connector data…"}
            onPick={(path) => patch({ text: `${node.text}{{${path}}}` })}
          />
        </Field>
      )}
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
  connectors,
  patch,
}: {
  node: InstanceNode;
  kit: KitComponent | undefined;
  connectors: ConnectorInfo[];
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
          // node.id in the key resets BindingControl's local mode state
          // (data-intent, remembered custom value) when selection changes.
          key={`${node.id}:${key}`}
          name={key}
          prop={prop}
          value={node.props?.[key]}
          connectors={connectors}
          onCommit={(v) => setProp(key, v)}
        />
      ))}
    </Section>
  );
}

/**
 * One dynamic prop editor, typed by the kit component's metadata. Every prop
 * is bindable: a BindingControl whose kind follows the kit prop type, so e.g.
 * progress-bar's percent offers exactly the number-typed connector fields.
 * The renderer accepts "{{path}}" strings for number props (mergeProps
 * coerces numeric strings), so bound values round-trip as strings.
 */
function PropField({
  name,
  prop,
  value,
  connectors,
  onCommit,
}: {
  name: string;
  prop: KitProp;
  value: unknown;
  connectors: ConnectorInfo[];
  onCommit: (v: unknown) => void;
}) {
  const kind: BindingKind = prop.type === "number" ? "number" : "string";
  const current = value ?? prop.default ?? (kind === "number" ? 0 : "");
  return (
    <Field label={name} title={prop.description}>
      <BindingControl
        kind={kind}
        value={
          typeof current === "string" || typeof current === "number"
            ? current
            : String(current)
        }
        fields={connectors}
        onChange={onCommit}
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
            {ANIMATION_PRESETS.map((p) => (
              <SelectItem key={p.value} value={p.value}>
                <span className="font-mono">{p.value}</span>
                <span className="ml-2 text-xs text-muted-foreground">
                  {p.hint}
                </span>
              </SelectItem>
            ))}
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
