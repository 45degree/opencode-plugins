import { createEngine, renderTemplate, type TemplateContext } from "./engine.js"
import type { HookEvent, HookName, SystemPart } from "./types.js"

export interface RenderDiagnostic {
  readonly kind: HookName
  readonly segment: number
  readonly line?: number
}

export interface Renderer {
  renderEvent(kind: HookName, event: HookEvent): RenderDiagnostic[]
}

function isTextPart(part: SystemPart): part is SystemPart & { text: string } {
  return part.type === "text" && typeof part.text === "string"
}

const LINE_HINT = /\[\s*Line\s+(\d+)/

// Nunjucks reports template-relative positions inside the error message rather
// than on the error object, and the message can quote template content. Only
// the bare line number is extracted; the message itself is never recorded.
function lineHint(error: unknown): number | undefined {
  const message = error instanceof Error ? error.message : String(error)
  const match = LINE_HINT.exec(message)
  return match === null ? undefined : Number(match[1])
}

// Template context is rebuilt from the event on every call: each request sees
// its own provider, model and agent, never the previous request's values.
function templateContext(event: HookEvent): TemplateContext {
  return {
    provider: event.model.providerID,
    model: event.model.id,
    agent: typeof event.agent === "string" ? event.agent : null,
  }
}

export function createRenderer(): Renderer {
  const engine = createEngine()

  const renderEvent = (kind: HookName, event: HookEvent): RenderDiagnostic[] => {
    const context = templateContext(event)
    const diagnostics: RenderDiagnostic[] = []
    // Text parts are rendered in place, one by one: order, segment boundaries,
    // metadata and non-text parts are never touched. A segment that fails to
    // render keeps its original text and the remaining segments continue.
    event.system.forEach((part: SystemPart, segment: number) => {
      if (!isTextPart(part)) return
      try {
        part.text = renderTemplate(engine, part.text, context)
      } catch (error) {
        diagnostics.push({ kind, segment, line: lineHint(error) })
      }
    })
    return diagnostics
  }

  return { renderEvent }
}
