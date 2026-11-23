// Issue 07: the option contract. Every instance needs `base_url` and a non-empty
// `groups` list, group ids are valid and unique across ALL instances, names are not
// blank. Each violation names the offending field, and the plugin reports it before
// it sends a single request or registers anything.

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { makeContext, stubModelsFetch } from "./helpers/context.js"
import newapiProvider from "../src/index.js"

const GROUP = { id: "packy-work", name: "Packy Work" }
const INSTANCE = { base_url: "https://newapi.example.com", groups: [GROUP] }

interface InvalidCase {
  readonly name: string
  readonly options: Record<string, unknown>
  /** The offending field the message has to name. */
  readonly field: RegExp
  /** Why the value was rejected. */
  readonly reason: RegExp
}

const instance = (overrides: Record<string, unknown>) => ({ ...INSTANCE, ...overrides })
const groupAt = (instanceIndex: number, groupIndex: number) =>
  new RegExp(String.raw`providers\[${instanceIndex}\]\.groups\[${groupIndex}\]`)

const INVALID_GROUP_IDS = ["", "-leading-dash", "has space", "dot.sep", "_underscore"]

const CASES: readonly InvalidCase[] = [
  { name: "missing `providers`", options: {}, field: /`providers`/, reason: /missing required option/ },
  { name: "`providers` that is not an array", options: { providers: {} }, field: /`providers`/, reason: /must be an array/ },
  { name: "an empty `providers` list", options: { providers: [] }, field: /`providers`/, reason: /at least one/ },
  {
    name: "an instance that is not an object",
    options: { providers: ["https://newapi.example.com"] },
    field: /providers\[0\]/,
    reason: /must be an object/,
  },
  {
    name: "an instance without `base_url`",
    options: { providers: [{ groups: [GROUP] }] },
    field: /providers\[0\]\.base_url/,
    reason: /required/,
  },
  {
    name: "a `base_url` that is not a string",
    options: { providers: [instance({ base_url: 42 })] },
    field: /providers\[0\]\.base_url/,
    reason: /must be a string/,
  },
  {
    name: "an instance without `groups`",
    options: { providers: [instance({ groups: undefined })] },
    field: /providers\[0\]\.groups/,
    reason: /must be an array/,
  },
  {
    name: "a `groups` list that is not an array",
    options: { providers: [instance({ groups: { id: "packy-work", name: "Packy Work" } })] },
    field: /providers\[0\]\.groups/,
    reason: /must be an array/,
  },
  {
    name: "an empty `groups` list",
    options: { providers: [instance({ groups: [] })] },
    field: /providers\[0\]\.groups/,
    reason: /at least one/,
  },
  {
    name: "a group that is not an object",
    options: { providers: [instance({ groups: [GROUP, "personal"] })] },
    field: groupAt(0, 1),
    reason: /must be an object/,
  },
  ...INVALID_GROUP_IDS.map((id): InvalidCase => ({
    name: `the group id ${JSON.stringify(id)}`,
    options: { providers: [instance({ groups: [{ ...GROUP, id }] })] },
    field: /providers\[0\]\.groups\[0\]\.id/,
    reason: /identifier/,
  })),
  {
    name: "a group id repeated inside one instance",
    options: { providers: [instance({ groups: [GROUP, { id: "packy-work", name: "Packy Again" }] })] },
    field: groupAt(0, 1),
    reason: /duplicate group id `packy-work`/,
  },
  {
    name: "a group id repeated across instances",
    options: { providers: [INSTANCE, { base_url: "https://other.example.com", groups: [{ id: "packy-work", name: "Same" }] }] },
    field: groupAt(1, 0),
    reason: /duplicate group id `packy-work`/,
  },
  {
    name: "a blank group name",
    options: { providers: [instance({ groups: [{ id: "packy-work", name: " \t " }] })] },
    field: /providers\[0\]\.groups\[0\]\.name/,
    reason: /non-empty/,
  },
  {
    name: "a group name that is not a string",
    options: { providers: [instance({ groups: [{ id: "packy-work", name: 42 }] })] },
    field: /providers\[0\]\.groups\[0\]\.name/,
    reason: /non-empty/,
  },
  {
    name: "a `cache` that is not a boolean",
    options: { cache: "yes", providers: [INSTANCE] },
    field: /`cache`/,
    reason: /must be a boolean/,
  },
  {
    name: "an unknown field on an instance",
    options: { providers: [instance({ disabled: true })] },
    field: /providers\[0\]/,
    reason: /unknown field `disabled`/,
  },
  {
    name: "an unknown field on a group",
    options: { providers: [instance({ groups: [{ ...GROUP, extra: "x" }] })] },
    field: groupAt(0, 0),
    reason: /unknown field `extra`/,
  },
]

describe("options: validation happens before the network", () => {
  for (const testCase of CASES) {
    it(`rejects ${testCase.name}, naming the field and the reason`, async () => {
      const { context, drafts } = makeContext({ options: testCase.options })
      const { requests, restore } = stubModelsFetch({ object: "list", data: [] })
      try {
        await assert.rejects(
          async () => {
            await newapiProvider.setup(context)
          },
          (error: unknown) => {
            const message = String((error as Error).message)
            assert.match(message, /newapi-provider config error/, "reported as a config error")
            assert.match(message, testCase.field, `names the field: ${message}`)
            assert.match(message, testCase.reason, `states the reason: ${message}`)
            return true
          },
        )
      } finally {
        restore()
      }

      assert.deepEqual(requests, [], "no discovery request leaves for an invalid config")
      assert.equal(drafts.integrationTransforms, 0, "no integration is registered")
      assert.equal(drafts.providerTransforms, 0, "no provider is registered")
      assert.equal(drafts.commandTransforms, 0, "no command is registered")
    })
  }
})
