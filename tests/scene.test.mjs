import assert from "node:assert/strict";
import { test } from "node:test";
import { summarizeScene } from "../src/lib/summarizeScene.ts";

test("scene", () => {
  const shape = (id, x) => ({ id, type: "rectangle", x, y: 0, width: 100, height: 50 });
  const connector = (overrides) => ({
    id: "edge",
    type: "arrow",
    x: 100,
    y: 25,
    width: 100,
    height: 0,
    startBinding: { elementId: "client" },
    endBinding: { elementId: "server" },
    ...overrides,
  });
  const elements = [shape("client", 0), shape("server", 200)];
  assert.match(
    summarizeScene([...elements, connector({ startArrowhead: null, endArrowhead: "arrow" })]),
    /#clie -> #serv/
  );
  assert.match(
    summarizeScene([...elements, connector({ startArrowhead: "arrow", endArrowhead: null })]),
    /#serv -> #clie/
  );
  assert.match(
    summarizeScene([...elements, connector({ startArrowhead: "arrow", endArrowhead: "arrow" })]),
    /#clie <-> #serv/
  );
  assert.match(
    summarizeScene([
      ...elements,
      connector({
        startBinding: null,
        endBinding: null,
        points: [[0, 0], [100, 0]],
        startArrowhead: null,
        endArrowhead: "arrow",
      }),
    ]),
    /#clie -> #serv/
  );
  const labeledScene = summarizeScene([
    ...elements,
    { id: "label", type: "text", x: 20, y: 15, width: 60, height: 20, text: "Client" },
  ]);
  assert.match(labeledScene, /rect "Client" @left/);
  assert.doesNotMatch(labeledScene, /LABELS:/);
});
