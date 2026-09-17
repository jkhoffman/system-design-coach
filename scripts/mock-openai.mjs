import http from "node:http";
import { gradeReport, promptSpec } from "./mock-fixtures.mjs";

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > 10 * 1024 * 1024) {
        request.destroy(new Error("request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function json(response, status, body) {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(text),
  });
  response.end(text);
}

function wavBytes() {
  const sampleRate = 8000;
  const channels = 2;
  const bytesPerSample = 2;
  const frames = sampleRate / 2;
  const dataSize = frames * channels * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * bytesPerSample, 28);
  buffer.writeUInt16LE(channels * bytesPerSample, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < frames; i++) {
    const sample = Math.round(Math.sin((i / sampleRate) * Math.PI * 440) * 8000);
    buffer.writeInt16LE(sample, 44 + i * 4);
    buffer.writeInt16LE(sample, 46 + i * 4);
  }
  return buffer;
}

function openAiResponse(body, output) {
  const text = JSON.stringify(output);
  return {
    id: `resp_mock_${Date.now().toString(36)}`,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    model: body.model ?? "mock-model",
    output_text: text,
    output: [
      {
        id: "msg_mock",
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    ],
    error: null,
    incomplete_details: null,
    instructions: body.instructions ?? null,
    metadata: null,
    parallel_tool_calls: true,
    temperature: null,
    tool_choice: "auto",
    tools: [],
    top_p: null,
    status: "completed",
    usage: {
      input_tokens: 0,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 0,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 0,
    },
  };
}

export async function startMockOpenAI({ host = "127.0.0.1", port = 0, apiKey = "mock-key" } = {}) {
  const counts = {
    liveCreate: 0,
    recordingGet: 0,
    responses: 0,
    gradeResponses: 0,
    promptResponses: 0,
  };
  const liveSessions = new Map();
  const wav = wavBytes();
  let nextLiveId = 1;

  const server = http.createServer(async (request, response) => {
    try {
      if (request.headers.authorization !== `Bearer ${apiKey}`) {
        json(response, 401, { error: "invalid mock authorization" });
        return;
      }
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? host}`);

      if (request.method === "POST" && url.pathname === "/v1/live/sessions") {
        const body = JSON.parse(await readBody(request));
        if (typeof body?.transport?.sdp !== "string" || !body.transport.sdp) {
          json(response, 400, { error: "missing SDP offer" });
          return;
        }
        counts.liveCreate++;
        const id = `live_mock_${nextLiveId++}`;
        liveSessions.set(id, { createdAt: Date.now(), body });
        json(response, 200, {
          id,
          session: { id },
          transport: { type: "webrtc", sdp: "mock-webrtc-answer" },
        });
        return;
      }

      const recordingMatch = /^\/v1\/live\/sessions\/([^/]+)\/content$/.exec(url.pathname);
      if (request.method === "GET" && recordingMatch) {
        const id = decodeURIComponent(recordingMatch[1]);
        if (!liveSessions.has(id)) {
          json(response, 404, { error: "unknown mock live session" });
          return;
        }
        counts.recordingGet++;
        response.writeHead(200, {
          "Content-Type": "audio/wav",
          "Content-Length": wav.length,
        });
        response.end(wav);
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/responses") {
        const body = JSON.parse(await readBody(request));
        counts.responses++;
        const schemaName = body?.text?.format?.name;
        if (schemaName === "grade_report") {
          counts.gradeResponses++;
          json(response, 200, openAiResponse(body, gradeReport()));
          return;
        }
        if (schemaName === "prompt_spec") {
          counts.promptResponses++;
          json(response, 200, openAiResponse(body, promptSpec()));
          return;
        }
        json(response, 400, { error: `unsupported mock response schema: ${schemaName ?? "none"}` });
        return;
      }

      json(response, 404, { error: `unknown mock OpenAI route: ${request.method} ${url.pathname}` });
    } catch (error) {
      json(response, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  return {
    server,
    host,
    port: actualPort,
    baseUrl: `http://${host}:${actualPort}/v1`,
    counts,
    liveSessions,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}
