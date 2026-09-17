import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { bounded } from "./async";

export function createBoardExporter() {
  let board: ExcalidrawImperativeAPI | null = null;
  const exportImage = async (mimeType: "image/png" | "image/jpeg", signal?: AbortSignal): Promise<string | null> => {
    signal?.throwIfAborted();
    const api = board;
    const elements = api?.getSceneElements().filter((e) => !e.isDeleted);
    if (!api || !elements?.length) return null;
    const { exportToBlob } = await import("@excalidraw/excalidraw");
    signal?.throwIfAborted();
    const blob = await exportToBlob({
      elements, files: api.getFiles(),
      appState: { exportWithDarkMode: true, exportBackground: true },
      mimeType,
      ...(mimeType === "image/jpeg" ? { maxWidthOrHeight: 1600, quality: 0.85 } : {}),
    });
    signal?.throwIfAborted();
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      const abort = () => { reader.abort(); reject(signal?.reason); };
      const cleanup = () => signal?.removeEventListener("abort", abort);
      reader.onload = () => { cleanup(); resolve(reader.result as string); };
      reader.onerror = () => { cleanup(); reject(reader.error); };
      reader.onabort = cleanup;
      signal?.addEventListener("abort", abort, { once: true });
      reader.readAsDataURL(blob);
    });
  };
  return {
    setApi: (api: ExcalidrawImperativeAPI) => { board = api; },
    currentElements: () => board?.getSceneElements() ?? [],
    exportPng: (signal?: AbortSignal) => bounded(exportImage("image/png", signal), 10_000, signal),
    exportLiveImage: (signal?: AbortSignal) => bounded(exportImage("image/jpeg", signal), 10_000, signal),
  };
}
