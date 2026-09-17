/**
 * Compact structural summary of an Excalidraw scene for the interviewer model.
 * Budget: ~1,400 chars so it fits comfortably in a single session.thinking.append.
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
  boundElements?: readonly { type: string; id: string }[] | null;
  startBinding?: { elementId: string } | null;
  endBinding?: { elementId: string } | null;
  text?: string;
  startArrowhead?: string | null;
  endArrowhead?: string | null;
  points?: readonly (readonly [number, number])[];
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
const directedArrowhead = (value?: string | null) => value != null && value !== "line";

export function summarizeScene(elements: readonly ExcalidrawElementLike[], maxChars = 1400): string {
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
  const shapes = live
    .filter((e) => SHAPES.has(e.type))
    .sort((a, b) => a.y - b.y || a.x - b.x);

  const contains = (e: ExcalidrawElementLike, x: number, y: number, padding: number) => {
    const left = Math.min(e.x, e.x + e.width) - padding;
    const right = Math.max(e.x, e.x + e.width) + padding;
    const top = Math.min(e.y, e.y + e.height) - padding;
    const bottom = Math.max(e.y, e.y + e.height) + padding;
    return x >= left && x <= right && y >= top && y <= bottom;
  };
  const shapeAt = (x: number, y: number, padding = 16) => {
    let best: ExcalidrawElementLike | null = null;
    let bestArea = Infinity;
    for (const shape of shapes) {
      if (!contains(shape, x, y, padding)) continue;
      const area = (Math.abs(shape.width) + padding * 2) * (Math.abs(shape.height) + padding * 2);
      if (area < bestArea) {
        best = shape;
        bestArea = area;
      }
    }
    return best;
  };

  // Bound text belongs to its container; free text inside a shape labels it too.
  const labelOf = new Map<string, string>();
  const addLabel = (id: string, text: string) => {
    const prev = labelOf.get(id);
    labelOf.set(id, prev ? `${prev} ${text}` : text);
  };
  const freeTexts: ExcalidrawElementLike[] = [];
  for (const e of live) {
    if (e.type !== "text" || !e.text?.trim()) continue;
    if (e.containerId && byId.has(e.containerId)) {
      addLabel(e.containerId, e.text);
      continue;
    }
    const host = shapeAt(e.x + e.width / 2, e.y + e.height / 2);
    if (host) addLabel(host.id, e.text);
    else freeTexts.push(e);
  }
  const label = (e: ExcalidrawElementLike) =>
    labelOf.get(e.id) ? `"${trunc(labelOf.get(e.id)!, 24)}"` : `#${shortId(e.id)}`;

  const connectorPoint = (e: ExcalidrawElementLike, end: "start" | "end") => {
    const point = e.points?.length
      ? end === "start"
        ? e.points[0]
        : e.points[e.points.length - 1]
      : end === "start"
        ? ([0, 0] as const)
        : ([e.width, e.height] as const);
    return { x: e.x + point[0], y: e.y + point[1] };
  };
  const endpointElement = (
    e: ExcalidrawElementLike,
    binding: { elementId: string } | null | undefined,
    end: "start" | "end"
  ) => {
    const bound = binding ? byId.get(binding.elementId) : undefined;
    if (bound && SHAPES.has(bound.type)) return bound;
    const point = connectorPoint(e, end);
    return shapeAt(point.x, point.y);
  };

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
              const source = endpointElement(e, e.startBinding, "start");
              const target = endpointElement(e, e.endBinding, "end");
              const s = source ? label(source) : "?";
              const t = target ? label(target) : "?";
              const connectorLabel = labelOf.get(e.id) ? ` "${trunc(labelOf.get(e.id)!, 24)}"` : "";
              const hasStartArrow = directedArrowhead(e.startArrowhead);
              const hasEndArrow = directedArrowhead(e.endArrowhead);
              const flow =
                hasStartArrow && hasEndArrow
                  ? `${s} <-> ${t}`
                  : hasStartArrow
                    ? `${t} -> ${s}`
                    : e.type === "arrow"
                      ? `${s} -> ${t}`
                      : `${s} -- ${t}`;
              return flow + connectorLabel;
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
