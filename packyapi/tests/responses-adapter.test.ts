// The plugin registers `@opencode/ai/providers/openai-compatible/responses` and points
// it at `https://www.packyapi.ai/v1`. These tests drive THAT real adapter against a
// local mock upstream (fake keys only): the wire path, Bearer auth, upstream model id,
// basic output, streaming, tool roundtrip, errors and usage all come from the real
// adapter code, not a reimplementation of the protocol.
//
// Full inference inside a real OpenCode host is verified separately by the parent.

import { describe, it, afterEach } from "node:test"
import assert from "node:assert/strict"
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http"
import { ai, tool } from "@opencode/ai"
import { Schema } from "effect"
import * as responses from "@opencode/ai/providers/openai-compatible/responses"
import { buildProviderInfo } from "../src/catalog.js"

interface RecordedRequest {
  path: string
  authorization: string | undefined
  body: Record<string, unknown>
}

function sse(events: Array<Record<string, unknown>>): string {
  return events.map((event) => `event: ${event["type"]}\ndata: ${JSON.stringify(event)}\n\n`).join("")
}

const completedText = (text: string, usage: Record<string, unknown>) =>
  sse([
    { type: "response.output_item.added", output_index: 0, item: { type: "message", role: "assistant", id: "msg_1" } },
    { type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: text },
    {
      type: "response.completed",
      response: {
        id: "resp_mock",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text }],
          },
        ],
        usage,
      },
    },
  ])

interface MockUpstream {
  url: string
  requests: RecordedRequest[]
  stop: () => Promise<void>
}

/** Start a local upstream that answers every /v1/responses call with the given handler. */
function startUpstream(
  handler: (req: RecordedRequest, respond: (status: number, contentType: string, body: string) => void) => void,
): Promise<MockUpstream> {
  const requests: RecordedRequest[] = []
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = ""
    req.on("data", (chunk: Buffer) => (raw += chunk.toString()))
    req.on("end", () => {
      const recorded: RecordedRequest = {
        path: req.url ?? "",
        authorization: req.headers["authorization"],
        body: raw === "" ? {} : (JSON.parse(raw) as Record<string, unknown>),
      }
      requests.push(recorded)
      recorded.body = recorded.body
      handler(recorded, (status, contentType, body) => {
        res.writeHead(status, { "content-type": contentType })
        res.end(body)
      })
    })
  })
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      const port = typeof address === "object" && address !== null ? address.port : 0
      resolve({
        url: `http://127.0.0.1:${port}/v1`,
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

async function withUpstream(
  handler: (req: RecordedRequest, respond: (status: number, contentType: string, body: string) => void) => void,
) {
  const upstream = await startUpstream(handler)
  cleanupQueue.push(upstream.stop)
  const model = responses.model("resp-1", { apiKey: "sk-fake-responses", baseURL: upstream.url })
  return { upstream, model }
}

describe("real Responses adapter against a mock upstream", () => {
  it("sends POST {baseURL}/responses with Bearer auth and the upstream model id, and parses output + usage", async () => {
    const { upstream, model } = await withUpstream((req, respond) => {
      respond(200, "text/event-stream", completedText("Hello from mock", { input_tokens: 5, output_tokens: 2 }))
    })

    const response = await ai.generate({ model, prompt: "Say hi" })

    const request = upstream.requests[0]
    assert.ok(request, "one request reached the mock upstream")
    assert.equal(request.path, "/v1/responses")
    assert.equal(request.authorization, "Bearer sk-fake-responses")
    assert.equal(request.body["model"], "resp-1")
    assert.equal(request.body["stream"], true)

    const text = (response.message?.content ?? [])
      .map((part) => (part.type === "text" ? (part.text ?? "") : ""))
      .join("")
    assert.match(text, /Hello from mock/)
    assert.equal(response.usage?.inputTokens, 5)
    assert.equal(response.usage?.outputTokens, 2)
  })

  it("streams text deltas and a finish event with usage", async () => {
    const { model } = await withUpstream((req, respond) => {
      respond(
        200,
        "text/event-stream",
        sse([
          { type: "response.output_item.added", output_index: 0, item: { type: "message", role: "assistant", id: "msg_1" } },
          { type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: "Hel" },
          { type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: "lo" },
          {
            type: "response.completed",
            response: {
              id: "resp_mock",
              output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Hello" }] }],
              usage: { input_tokens: 3, output_tokens: 1 },
            },
          },
        ]),
      )
    })

    const collected = await ai.collect(ai.stream({ model, prompt: "Say hi" }))
    assert.match(collected.text, /Hello/)
    assert.equal(collected.usage?.outputTokens, 1)
  })

  it("round-trips a tool call: upstream asks, local tool executes, follow-up carries the tool output", async () => {
    let callCount = 0
    let executedArg: string | undefined
    const { upstream, model } = await withUpstream((req, respond) => {
      callCount++
      if (callCount === 1) {
        respond(
          200,
          "text/event-stream",
          sse([
            {
              type: "response.output_item.added",
              output_index: 0,
              item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "echo_city", arguments: "" },
            },
            {
              type: "response.completed",
              response: {
                id: "resp_tool",
                output: [
                  {
                    type: "function_call",
                    id: "fc_1",
                    call_id: "call_1",
                    name: "echo_city",
                    arguments: JSON.stringify({ city: "Berlin" }),
                  },
                ],
                usage: { input_tokens: 9, output_tokens: 4 },
              },
            },
          ]),
        )
        return
      }
      respond(200, "text/event-stream", completedText("Berlin it is", { input_tokens: 20, output_tokens: 3 }))
    })

    const weather = tool({
      name: "echo_city",
      description: "Echo a city",
      input: Schema.Struct({ city: Schema.String }),
      success: Schema.Struct({ city: Schema.String }),
      execute: ({ city }: { city: string }) => {
        executedArg = city
        return { city }
      },
    })

    const collected = await ai.collect(ai.loop({ model, prompt: "Echo Berlin", tools: [weather] }))

    assert.equal(executedArg, "Berlin", "the tool really executed locally")
    assert.match(collected.text, /Berlin it is/, "final answer after the tool roundtrip")
    const followUp = upstream.requests[1]
    assert.ok(followUp, "follow-up request sent after the tool call")
    const input = followUp.body["input"] as Array<Record<string, unknown>>
    assert.ok(
      input.some((item) => item["type"] === "function_call" || item["call_id"] === "call_1"),
      "follow-up input replays the assistant tool call",
    )
    assert.ok(
      input.some((item) => item["type"] === "function_call_output"),
      "follow-up input carries the tool result",
    )
  })

  it("maps an auth rejection to an error whose message never contains the key", async () => {
    const { model } = await withUpstream((req, respond) => {
      respond(401, "application/json", JSON.stringify({ error: { message: "bad credential" } }))
    })

    await assert.rejects(
      () => ai.generate({ model, prompt: "Say hi" }),
      (error: unknown) => {
        const message = String((error as Error)?.message ?? error)
        assert.ok(message.length > 0, "an error is reported")
        assert.doesNotMatch(message, /sk-fake-responses/, "error message never contains the key")
        return true
      },
    )
  })

  it("registers a provider whose package + baseURL settings feed the real adapter route", () => {
    const info = buildProviderInfo({ id: "packy-work", name: "Packy Work" }, "https://www.packyapi.ai/v1")
    assert.equal(info.package, "@opencode/ai/providers/openai-compatible/responses")
    const model = responses.model("any-model", {
      apiKey: "sk-fake-responses",
      baseURL: info.settings?.baseURL as string,
    })
    assert.equal(model.route.protocol, "open-responses")
    assert.equal(model.route.endpoint.path, "/responses")
    assert.equal(model.route.endpoint.baseURL, "https://www.packyapi.ai/v1")
  })
})
