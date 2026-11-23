// Round-trips through the REAL per-protocol adapters against a local mock upstream:
// each protocol reaches its own derived root (including proxy prefixes) with its
// own auth header, carries the upstream model id, streams text, round-trips tool
// calls and reports usage. All fixtures are protocol wire formats; the adapters
// under test are the ones the plugin registers.

import { describe, it, afterEach } from "node:test"
import assert from "node:assert/strict"
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http"
import { ai, tool } from "@opencode/ai"
import { Schema } from "effect"
import * as anthropic from "@opencode/ai/providers/anthropic"
import * as google from "@opencode/ai/providers/google"
import * as openaiCompatible from "@opencode/ai/providers/openai-compatible"
import * as responses from "@opencode/ai/providers/openai-compatible/responses"

interface RecordedRequest {
  path: string
  headers: Record<string, string | undefined>
  body: Record<string, unknown>
}

interface MockUpstream {
  url: string
  requests: RecordedRequest[]
  stop: () => Promise<void>
}

function sse(frames: string[]): string {
  return frames.map((frame) => `data: ${frame}\n\n`).join("")
}

const anthropicText = (text: string) =>
  sse([
    JSON.stringify({ type: "message_start", message: { id: "msg_1", usage: { input_tokens: 5 } } }),
    JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }),
    JSON.stringify({ type: "content_block_stop", index: 0 }),
    JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } }),
    JSON.stringify({ type: "message_stop" }),
  ])

const anthropicToolUse = (callId: string, name: string, args: string) =>
  sse([
    JSON.stringify({ type: "message_start", message: { id: "msg_1", usage: { input_tokens: 9 } } }),
    JSON.stringify({
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: callId, name },
    }),
    JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: args } }),
    JSON.stringify({ type: "content_block_stop", index: 0 }),
    JSON.stringify({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 4 } }),
    JSON.stringify({ type: "message_stop" }),
  ])

const chatText = (text: string) =>
  sse([
    JSON.stringify({ choices: [{ delta: { role: "assistant", content: text } }] }),
    JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 1 } }),
    "[DONE]",
  ])

const chatToolCall = (callId: string, name: string, args: string) =>
  sse([
    JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: callId, type: "function", function: { name, arguments: args } }] } }] }),
    JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 9, completion_tokens: 4 } }),
    "[DONE]",
  ])

const geminiText = (text: string) =>
  sse([
    JSON.stringify({
      candidates: [{ content: { parts: [{ text }], role: "model" }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 },
    }),
  ])

const geminiToolCall = (name: string, args: Record<string, unknown>) =>
  sse([
    JSON.stringify({
      candidates: [
        { content: { parts: [{ functionCall: { name, args } }], role: "model" }, finishReason: "STOP" },
      ],
      usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 4 },
    }),
  ])

const completedResponses = (text: string, usage: Record<string, unknown>) =>
  sse([
    JSON.stringify({ type: "response.output_item.added", output_index: 0, item: { type: "message", role: "assistant", id: "msg_1" } }),
    JSON.stringify({ type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: text }),
    JSON.stringify({
      type: "response.completed",
      response: {
        id: "resp_mock",
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }],
        usage,
      },
    }),
  ])

function startUpstream(handler: (req: RecordedRequest, respond: (status: number, contentType: string, body: string) => void) => void): Promise<MockUpstream> {
  const requests: RecordedRequest[] = []
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = ""
    req.on("data", (chunk: Buffer) => (raw += chunk.toString()))
    req.on("end", () => {
      const recorded: RecordedRequest = {
        path: req.url ?? "",
        headers: {
          authorization: req.headers["authorization"] as string | undefined,
          "x-api-key": req.headers["x-api-key"] as string | undefined,
          "x-goog-api-key": req.headers["x-goog-api-key"] as string | undefined,
        },
        body: raw === "" ? {} : (JSON.parse(raw) as Record<string, unknown>),
      }
      requests.push(recorded)
      handler(recorded, (status, contentType, body) => {
        res.writeHead(status, { "content-type": contentType })
        res.end(body)
      })
    })
  })
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port
      resolve({
        url: `http://127.0.0.1:${port}`,
        requests,
        stop: () => new Promise((done) => server.close(() => done())),
      })
    })
  })
}

const cleanupQueue: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const stop of cleanupQueue.splice(0).reverse()) await stop()
})

async function withUpstream(handler: Parameters<typeof startUpstream>[0]) {
  const upstream = await startUpstream(handler)
  cleanupQueue.push(upstream.stop)
  return upstream
}

const echoCity = tool({
  name: "echo_city",
  description: "Echo a city",
  input: Schema.Struct({ city: Schema.String }),
  success: Schema.Struct({ city: Schema.String }),
  execute: ({ city }: { city: string }) => {
    executedCities.push(city)
    return { city }
  },
})
const executedCities: string[] = []

describe("real protocol adapters against a local mock upstream", () => {
  it("openai-compatible chat: /proxy/v1/chat/completions, Bearer auth, upstream id, streaming text", async () => {
    const upstream = await withUpstream((req, respond) => {
      respond(200, "text/event-stream", chatText("Hello from chat"))
    })
    const model = openaiCompatible.model("m-chat", {
      apiKey: "sk-fake-chat",
      baseURL: `${upstream.url}/proxy/v1`,
    })

    const response = await ai.generate({ model, prompt: "Say hi" })
    const request = upstream.requests[0]!
    assert.match(request.path, /\/proxy\/v1\/chat\/completions$/, "the proxy prefix and chat route are preserved")
    assert.equal(request.headers.authorization, "Bearer sk-fake-chat")
    assert.equal(request.body["model"], "m-chat")
    assert.equal(request.body["stream"], true)
    assert.match(
      (response.message?.content ?? []).map((part) => (part.type === "text" ? (part.text ?? "") : "")).join(""),
      /Hello from chat/,
    )
    assert.equal(response.usage?.outputTokens, 1)
  })

  it("openai-compatible chat: tool call round-trip carries the tool result back", async () => {
    executedCities.length = 0
    let callCount = 0
    const upstream = await withUpstream((req, respond) => {
      callCount++
      respond(200, "text/event-stream", callCount === 1 ? chatToolCall("call_1", "echo_city", '{"city":"Berlin"}') : chatText("Berlin it is"))
    })
    const model = openaiCompatible.model("m-chat", { apiKey: "sk-fake-chat", baseURL: `${upstream.url}/proxy/v1` })

    const collected = await ai.collect(ai.loop({ model, prompt: "Echo Berlin", tools: [echoCity] }))

    assert.deepEqual(executedCities, ["Berlin"], "the tool really executed locally")
    assert.match(collected.text, /Berlin it is/)
    const followUp = upstream.requests[1]!
    assert.match(followUp.path, /\/proxy\/v1\/chat\/completions$/)
    const messages = followUp.body["messages"] as Array<Record<string, unknown>>
    assert.ok(
      messages.some((message) => message["role"] === "tool" || message["role"] === "tool_result"),
      "the follow-up carries the tool result",
    )
  })

  it("anthropic: /proxy/v1/messages with x-api-key auth, upstream id, streaming text", async () => {
    const upstream = await withUpstream((req, respond) => {
      respond(200, "text/event-stream", anthropicText("Hello from anthropic"))
    })
    const model = anthropic.model("m-claude", {
      apiKey: "sk-fake-anthropic",
      baseURL: `${upstream.url}/proxy/v1`,
    })

    const response = await ai.generate({ model, prompt: "Say hi" })
    const request = upstream.requests[0]!
    assert.match(request.path, /\/proxy\/v1\/messages/, "the anthropic route stays under the proxy root (query params allowed)")
    assert.equal(request.headers["x-api-key"], "sk-fake-anthropic")
    assert.equal(request.body["model"], "m-claude")
    assert.match(
      (response.message?.content ?? []).map((part) => (part.type === "text" ? (part.text ?? "") : "")).join(""),
      /Hello from anthropic/,
    )
  })

  it("anthropic: tool_use round-trip carries the tool result back", async () => {
    executedCities.length = 0
    let callCount = 0
    const upstream = await withUpstream((req, respond) => {
      callCount++
      respond(200, "text/event-stream", callCount === 1 ? anthropicToolUse("call_1", "echo_city", '{"city":"Berlin"}') : anthropicText("Berlin it is"))
    })
    const model = anthropic.model("m-claude", { apiKey: "sk-fake-anthropic", baseURL: `${upstream.url}/proxy/v1` })

    const collected = await ai.collect(ai.loop({ model, prompt: "Echo Berlin", tools: [echoCity] }))

    assert.deepEqual(executedCities, ["Berlin"], "the tool really executed locally")
    assert.match(collected.text, /Berlin it is/)
    const followUp = upstream.requests[1]!
    const messages = followUp.body["messages"] as Array<Record<string, unknown>>
    assert.ok(
      messages.some((message) => JSON.stringify(message).includes("tool_result")),
      "the follow-up carries the anthropic tool result",
    )
  })

  it("gemini: /proxy/v1beta/models/<id>:streamGenerateContent with x-goog-api-key auth", async () => {
    const upstream = await withUpstream((req, respond) => {
      respond(200, "text/event-stream", geminiText("Hello from gemini"))
    })
    const model = google.model("m-gemini", {
      apiKey: "sk-fake-gemini",
      baseURL: `${upstream.url}/proxy/v1beta`,
    })

    const response = await ai.generate({ model, prompt: "Say hi" })
    const request = upstream.requests[0]!
    assert.match(request.path, /\/proxy\/v1beta\/models\/m-gemini:streamGenerateContent/, "the gemini route keeps the upstream id and v1beta root")
    assert.equal(request.headers["x-goog-api-key"], "sk-fake-gemini")
    assert.match(
      (response.message?.content ?? []).map((part) => (part.type === "text" ? (part.text ?? "") : "")).join(""),
      /Hello from gemini/,
    )
  })

  it("gemini: functionCall round-trip carries the function response back", async () => {
    executedCities.length = 0
    let callCount = 0
    const upstream = await withUpstream((req, respond) => {
      callCount++
      respond(200, "text/event-stream", callCount === 1 ? geminiToolCall("echo_city", { city: "Berlin" }) : geminiText("Berlin it is"))
    })
    const model = google.model("m-gemini", { apiKey: "sk-fake-gemini", baseURL: `${upstream.url}/proxy/v1beta` })

    const collected = await ai.collect(ai.loop({ model, prompt: "Echo Berlin", tools: [echoCity] }))

    assert.deepEqual(executedCities, ["Berlin"], "the tool really executed locally")
    assert.match(collected.text, /Berlin it is/)
    const followUp = upstream.requests[1]!
    assert.match(followUp.path, /models\/m-gemini:streamGenerateContent/)
    assert.ok(
      JSON.stringify(followUp.body).includes("functionResponse"),
      "the follow-up carries the gemini function response",
    )
  })

  it("openai responses: /proxy/v1/responses with Bearer auth, upstream id, streaming text", async () => {
    const upstream = await withUpstream((req, respond) => {
      respond(200, "text/event-stream", completedResponses("Hello from responses", { input_tokens: 5, output_tokens: 2 }))
    })
    const model = responses.model("m-resp", {
      apiKey: "sk-fake-responses",
      baseURL: `${upstream.url}/proxy/v1`,
    })

    const response = await ai.generate({ model, prompt: "Say hi" })
    const request = upstream.requests[0]!
    assert.match(request.path, /\/proxy\/v1\/responses$/, "the responses route keeps the proxy root")
    assert.equal(request.headers.authorization, "Bearer sk-fake-responses")
    assert.equal(request.body["model"], "m-resp")
    assert.match(
      (response.message?.content ?? []).map((part) => (part.type === "text" ? (part.text ?? "") : "")).join(""),
      /Hello from responses/,
    )
    assert.equal(response.usage?.outputTokens, 2)
  })
})
