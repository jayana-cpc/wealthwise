export type ChatRole = "user" | "assistant"

export type AssistantMessage = {
  role: ChatRole
  content: string
}

export type BoundingRect = {
  top: number
  left: number
  width: number
  height: number
}

export type ViewportInfo = {
  width: number
  height: number
  scrollX: number
  scrollY: number
}

export type AncestorSummary = {
  wwId?: string | null
  role?: string | null
  tag: string
  label?: string | null
}

export type SelectionPayload = {
  pagePath: string
  timestamp: string
  selectorStrategy: "ww-id" | "testid" | "semantic" | "text" | "fallback"
  wwId?: string | null
  testId?: string | null
  tag: string
  id?: string | null
  classHint?: string | null
  role?: string | null
  ariaLabel?: string | null
  name?: string | null
  visibleText?: string | null
  boundingRect: BoundingRect
  viewport: ViewportInfo
  outerHTMLSnippet?: string | null
  ancestorSummary?: AncestorSummary[]
  semanticType?: string | null
  semanticKey?: string | null
  displayValue?: string | null
  asOfDate?: string | null
  units?: string | null
}

export type ChatRequestBody = {
  messages: AssistantMessage[]
  selection?: SelectionPayload | null
  userContext?: Record<string, unknown> | null
  model?: string
}
