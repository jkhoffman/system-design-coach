/**
 * Compact structural summary of an Excalidraw scene for the interviewer model.
 * Budget: ~1,800 chars (~450 tokens) so it fits a single session.thinking.append.
 */

export interface ExcalidrawElementLike {
  id: string;
  type: string;
  isDeleted?: boolean;
  version?: number;
  x: number;
  y: number;
  width: number;
  height: number;
  containerId?: string | null;
  boundElements?: { type: string; id: string }[] | null;
  startBinding?: { elementId: string } | null;
  endBinding?: { elementId: string } | null;
  text?: string;
}

/** Key used to detect real element changes (ignores selection/scroll appState). */
export function elementsVersionKey(elements: readonly ExcalidrawElementLike[]): string {
  return elements
    .map((e) => `${e.id}:${e.version ?? 0}:${e.isDeleted ? 1 : 0}`)
    .sort()
    .join("|");
}

function shortId(id: string): string {
  return id.slice(0, 4);
}

function trunc(s: string, n: number): string {
  const clean = s.replace(/\s+/g, " ").trim();
  return clean.length > n ? clean.slice(0, n - 1) + "…" : clean;
}

const SHAPES = new Set(["rectangle", "ellipse", "diamond", "frame"]);
const CONNECTORS = new Set(["arrow", "line"]);

export function summarizeScene(elements: readonly ExcalidrawElementLike[], maxChars = 1800): string {
  const live = elements.filter((e) => !e.isDeleted);
  if (live.length === 0) return "Whiteboard is empty.";

  // Scene bounds → 3x3 position buckets
  const xs = live.map((e) => e.x);
  const ys = live.map((e) => e.y);
  const x2s = live.map((e) => e.x + e.width);
  const y2s = live.map((e) => e.y + e.height);
  const minX = Math.min(...xs), minY = Math.min(...ys);
  const maxX = Math.max(...x2s), maxY = Math.max(...y2s);
  const w = Math.max(maxX - minX, 1), h = Math.max(maxY - minY, 1);
  const col = (e: ExcalidrawElementLike) =>
    ["left", "center", "right"][Math.min(2, Math.floor(((e.x + e.width / 2 - minX) / w) * 3))];
  const row = (e: ExcalidrawElementLike) =>
    ["top", "middle", "bottom"][Math.min(2, Math.floor(((e.y + e.height / 2 - minY) / h) * 3))];
  const pos = (e: ExcalidrawElementLike) => {
    const r = row(e), c = col(e);
    return r === "middle" ? c : `${r}-${c}`;
  };

  const byId = new Map(live.map((e) => [e.id, e]));

  // Bound text: text elements with containerId belong to their shape's label
  const labelOf = new Map<string, string>();
  const freeTexts: ExcalidrawElementLike[] = [];
  for (const e of live) {
    if (e.type !== "text" || !e.text?.trim()) continue;
    if (e.containerId && byId.has(e.containerId)) {
      const prev = labelOf.get(e.containerId);
      labelOf.set(e.containerId, prev ? `${prev} ${e.text}` : e.text);
    } else {
      freeTexts.push(e);
    }
  }
  const label = (e: ExcalidrawElementLike) =>
    labelOf.get(e.id) ? `"${trunc(labelOf.get(e.id)!, 24)}"` : `#${shortId(e.id)}`;

  const shapes = live
    .filter((e) => SHAPES.has(e.type))
    .sort((a, b) => a.y - b.y || a.x - b.x);
  const connectors = live.filter((e) => CONNECTORS.has(e.type));
  const other = live.filter((e) => !SHAPES.has(e.type) && !CONNECTORS.has(e.type) && e.type !== "text");

  const lines: string[] = [];

  lines.push(
    "SHAPES: " +
      (shapes.length
        ? shapes
            .map((e) => `${e.type === "rectangle" ? "rect" : e.type} ${label(e)} @${pos(e)}`)
            .join("; ")
        : "none")
  );

  lines.push(
    "FLOWS: " +
      (connectors.length
        ? connectors
            .map((e) => {
              const s = e.startBinding ? label(byId.get(e.startBinding.elementId) ?? e) : "?";
              const t = e.endBinding ? label(byId.get(e.endBinding.elementId) ?? e) : "?";
              return `${s} ${e.type === "arrow" ? "->" : "--"} ${t}`;
            })
            .join("; ")
        : "none")
  );

  if (freeTexts.length) {
    lines.push(
      "LABELS: " + freeTexts.map((e) => `"${trunc(e.text!, 40)}" @${pos(e)}`).join("; ")
    );
  }
  if (other.length) {
    const counts = new Map<string, number>();
    for (const e of other) counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
    lines.push(
      "OTHER: " + [...counts].map(([t, n]) => `${n} ${t}`).join(", ")
    );
  }

  let out = lines.join("\n");
  if (out.length > maxChars) {
    // Drop positional detail first, then truncate flows
    out = out.replace(/ @[a-z-]+/g, "");
    if (out.length > maxChars) out = out.slice(0, maxChars - 20) + "… (truncated)";
  }
  return out;
}
