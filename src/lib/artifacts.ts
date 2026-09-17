import "server-only";
import fs from "node:fs";
import { promises as files } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { RECORDING_DIR, SNAPSHOT_DIR } from "./database";
import { HttpError } from "./http";
import { validSessionId, SNAPSHOT_FILE_RE, MAX_PNG_DATA_URL_CHARS } from "./schemas";
import { getFinalImageReference, getRecordingSession } from "./sessionQueries";
import { finishRecording, ownsJob, resetMissingRecording, type JobAttempt } from "./sessionJobs";
import type { TimelineEvent } from "./types";

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_RECORDING_BYTES = 2 * 1024 * 1024 * 1024;
function sessionDirectory(id: string) {
  if (!validSessionId(id)) throw new HttpError(404, "not found");
  return path.resolve(SNAPSHOT_DIR, id);
}
function within(root: string, candidate: string): string {
  const file = path.resolve(candidate);
  if (!file.startsWith(path.resolve(root) + path.sep)) throw new HttpError(404, "not found");
  return file;
}

export function decodeImage(dataUrl: string) {
  if (dataUrl.length > MAX_PNG_DATA_URL_CHARS) throw new HttpError(413, "image too large");
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!match) throw new HttpError(400, "image data URL required");
  const bytes = Buffer.from(match[2], "base64");
  const extension = match[1];
  const valid = extension === "png" ? bytes.subarray(0, 8).equals(PNG_MAGIC)
    : extension === "jpeg" ? bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
    : bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP";
  if (!valid) throw new HttpError(400, "image content does not match its type");
  return { bytes, extension, mimeType: `image/${extension}` };
}

export async function saveSnapshot(id: string, startMs: number, dataUrl: string): Promise<string> {
  const image = decodeImage(dataUrl);
  if (image.extension !== "png") throw new HttpError(400, "png data URL required");
  const directory = sessionDirectory(id);
  await files.mkdir(directory, { recursive: true });
  const name = `${Math.round(startMs)}.png`;
  if (!SNAPSHOT_FILE_RE.test(name)) throw new HttpError(400, "invalid snapshot time");
  // Each milestone is immutable. A retried upload cannot replace an earlier image.
  try { await files.writeFile(path.join(directory, name), image.bytes, { flag: "wx" }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  return name;
}

export async function readSnapshot(id: string, name: string): Promise<Buffer | null> {
  if (!SNAPSHOT_FILE_RE.test(name)) return null;
  try { return await files.readFile(path.join(sessionDirectory(id), name)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

export async function saveFinalImage(id: string, dataUrl: string): Promise<string> {
  const image = decodeImage(dataUrl);
  const directory = sessionDirectory(id);
  await files.mkdir(directory, { recursive: true });
  const file = path.join(directory, `final-${randomUUID()}.${image.extension}`);
  await files.writeFile(file, image.bytes, { flag: "wx" });
  return file;
}

export async function discardFinalImage(id: string, file: string): Promise<void> {
  await files.rm(within(sessionDirectory(id), file), { force: true });
}

export async function readFinalImage(id: string): Promise<{ bytes: Buffer; mimeType: string } | null> {
  const reference = getFinalImageReference(id);
  if (!reference) return null;
  if (reference.path) {
    const file = within(sessionDirectory(id), reference.path);
    const extension = path.extname(file).slice(1);
    if (!["png", "jpeg", "webp"].includes(extension)) return null;
    try { return { bytes: await files.readFile(file), mimeType: `image/${extension}` }; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  if (reference.inline) {
    try { return decodeImage(reference.inline); } catch { return null; }
  }
  return null;
}

export async function gradingImages(id: string, timeline: TimelineEvent[]) {
  const images: { type: "input_image"; image_url: string; detail: "high" }[] = [];
  const names = timeline.filter((e) => e.kind === "snapshot").slice(0, 10).map((e) => e.file);
  for (const name of names) {
    const bytes = await readSnapshot(id, name);
    if (bytes) images.push({ type: "input_image", image_url: `data:image/png;base64,${bytes.toString("base64")}`, detail: "high" });
  }
  const final = await readFinalImage(id);
  if (final) images.push({ type: "input_image", image_url: `data:${final.mimeType};base64,${final.bytes.toString("base64")}`, detail: "high" });
  return images;
}

export async function availableRecording(id: string): Promise<string | null> {
  const row = getRecordingSession(id);
  if (!row?.recordingPath || row.recordingStatus !== "done") return null;
  let file: string;
  try { file = within(RECORDING_DIR, row.recordingPath); }
  catch { return null; }
  try { if ((await files.stat(file)).isFile()) return file; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  resetMissingRecording(id, row.recordingPath);
  return null;
}

/** Download privately, validate the container, then publish a complete file for the current owner. */
export async function publishRecording(response: Response, attempt: JobAttempt, signal: AbortSignal): Promise<void> {
  if (attempt.kind !== "recording" || !validSessionId(attempt.id) || !/^[a-f0-9-]{36}$/.test(attempt.token)) throw new Error("invalid recording attempt");
  if (!response.body) throw new Error("empty recording response");
  if (Number(response.headers.get("content-length")) > MAX_RECORDING_BYTES) throw new Error("recording too large");
  await files.mkdir(RECORDING_DIR, { recursive: true });
  const file = path.join(RECORDING_DIR, `${attempt.id}-${attempt.token}.wav`);
  const temporary = `${file}.part`;
  let published = false;
  let bytes = 0;
  let header = Buffer.alloc(0);
  let validated = false;
  const validate = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > MAX_RECORDING_BYTES) return callback(new Error("recording too large"));
      if (!validated) {
        header = Buffer.concat([header, chunk]);
        if (header.length < 12) return callback();
        if (header.subarray(0, 4).toString() !== "RIFF" || header.subarray(8, 12).toString() !== "WAVE") {
          return callback(new Error("recording is not WAV audio"));
        }
        validated = true;
        this.push(header); header = Buffer.alloc(0); callback();
      } else callback(null, chunk);
    },
    flush(callback) { callback(validated && bytes >= 44 ? null : new Error("truncated WAV recording")); },
  });
  try {
    await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream), validate,
      fs.createWriteStream(temporary, { flags: "wx" }), { signal });
    signal.throwIfAborted();
    if (!ownsJob(attempt)) throw new Error("recording attempt expired or superseded");
    await files.rename(temporary, file);
    if (!finishRecording(attempt, file)) throw new Error("recording attempt expired or superseded");
    published = true;
  } finally {
    await files.rm(temporary, { force: true });
    if (!published) await files.rm(file, { force: true });
  }
}

export async function serveRecording(file: string, request: Request): Promise<Response> {
  file = within(RECORDING_DIR, file);
  const { size } = await files.stat(file);
  const headers = { "Content-Type": "audio/wav", "Accept-Ranges": "bytes" };
  const range = request.headers.get("range");
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    const suffix = match && !match[1] && match[2] ? Number(match[2]) : null;
    const start = suffix != null ? Math.max(0, size - suffix) : Number(match?.[1]);
    const end = suffix != null || !match?.[2] ? size - 1 : Math.min(Number(match[2]), size - 1);
    if (!match || (!match[1] && !match[2]) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) {
      return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
    }
    return new Response(Readable.toWeb(fs.createReadStream(file, { start, end })) as ReadableStream, {
      status: 206, headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": String(end - start + 1) },
    });
  }
  return new Response(Readable.toWeb(fs.createReadStream(file)) as ReadableStream, { headers: { ...headers, "Content-Length": String(size) } });
}
