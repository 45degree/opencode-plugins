import nunjucks from "nunjucks"

export const BLOCK_START = "<!-- {%"
export const BLOCK_END = "%} -->"

export interface TemplateContext {
  provider: string
  model: string
  agent: string | null
}

// One engine per plugin setup. Only the block delimiters are customized so
// conditional tags can live inside HTML comments and stay hidden in Markdown
// previews. Parsing stays fully native Nunjucks: no syntax subset, no sandbox,
// no source filtering. Loading this plugin therefore means trusting every
// template source that can reach a system prompt.
export function createEngine(): nunjucks.Environment {
  const engine = new nunjucks.Environment(undefined, {
    tags: { blockStart: BLOCK_START, blockEnd: BLOCK_END },
  })
  engine.addGlobal("matches", matches)
  return engine
}

// JavaScript RegExp semantics returning a boolean. A fresh RegExp is built for
// every call, so stateful flags like /g never carry matching state across
// requests. An invalid pattern or flags throws and becomes a rendering error
// for the calling segment.
export function matches(value: unknown, pattern: string, flags?: string): boolean {
  return new RegExp(pattern, flags).test(String(value))
}

// A fresh context object per request so values never leak between requests.
export function renderTemplate(engine: nunjucks.Environment, text: string, context: TemplateContext): string {
  return engine.renderString(text, { ...context })
}
