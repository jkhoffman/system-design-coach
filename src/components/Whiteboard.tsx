"use client";

import dynamic from "next/dynamic";
import "@excalidraw/excalidraw/index.css";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { AppState } from "@excalidraw/excalidraw/types";
import type { OrderedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { BinaryFiles } from "@excalidraw/excalidraw/types";

const Excalidraw = dynamic(
  async () => (await import("@excalidraw/excalidraw")).Excalidraw,
  { ssr: false, loading: () => <div className="grid h-full place-items-center text-neutral-500">Loading whiteboard…</div> }
);

export default function Whiteboard({
  onApi,
  onChange,
}: {
  onApi: (api: ExcalidrawImperativeAPI) => void;
  onChange: (
    elements: readonly OrderedExcalidrawElement[],
    appState: AppState,
    files: BinaryFiles
  ) => void;
}) {
  return (
    <div className="h-full w-full [&_.excalidraw]:bg-[#111]">
      <Excalidraw
        excalidrawAPI={onApi}
        onChange={onChange}
        theme="dark"
        UIOptions={{
          canvasActions: {
            loadScene: false,
            saveToActiveFile: false,
            export: false,
            saveAsImage: false,
          },
        }}
      />
    </div>
  );
}
