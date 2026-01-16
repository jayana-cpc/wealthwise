"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { Loader2, MessageCircle, Pointer, Send, Sparkles, X } from "lucide-react"
import { usePathname } from "next/navigation"

import { AssistantMessage, SelectionPayload } from "@/lib/assistant/types"
import { cn } from "@/lib/utils"

type ResolvedTarget = {
  element: Element
  strategy: SelectionPayload["selectorStrategy"]
}

type AssistantLaunchPayload = {
  mode?: "default" | "survey"
  dock?: "left" | "right"
  prompt?: string
}

type DisplayLabel = {
  full: string
  compact: string
}

const CHAT_STORAGE_KEY = "ww-assistant-chat-v1"
const MAX_TEXT_LENGTH = 800
const MAX_HTML_LENGTH = 1200
const MAX_PAYLOAD_BYTES = 20_000
const DISPLAY_LABEL_LIMIT = 80
const SURVEY_QUESTIONS = [
  "What's your main goal? (smoother ride, faster growth, balanced risk, or keep it simple)",
  "How much trading is okay when we adjust your portfolio? (small changes, some changes, or lots of changes)",
  "Stay long-only, or okay with borrowing or betting against stocks (shorting)? (long-only or open to it)",
  "Do you want many smaller positions or a more focused set? (many, focused, or no preference)",
]
const SUPPORTED_METHODS_TEXT =
  "Only choose methods available in-app: Equal Weight, Inverse Volatility, Global Minimum Variance, Equal Risk Contribution (Risk Parity), Hierarchical Risk Parity, Maximum Diversification, or any methods returned by our optimizer list."
const ALLOWED_CONTROLS_TEXT =
  "Only reference controls the user sees: method selector, lookback (1Y/3Y/5Y/MAX), benchmark (SPY/IWM), covariance (shrinkage/sample/EWMA), return proxy (shrunk mean/historical mean/momentum), and Run optimization. Do not mention sliders or settings that are not on the page."

function truncate(text: string, limit: number) {
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

function sanitizeHtmlSnippet(html: string) {
  const strippedHandlers = html.replace(/\son[a-zA-Z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/g, "")
  return truncate(strippedHandlers, MAX_HTML_LENGTH)
}

function deriveName(element: Element, ariaLabel?: string | null) {
  if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim()
  const heading = element.querySelector("h1,h2,h3,h4,h5,h6,strong")
  if (heading?.textContent?.trim()) return truncate(heading.textContent.trim(), 120)
  const labelledBy = (element as HTMLElement).getAttribute("aria-labelledby")
  if (labelledBy) {
    const labelEl = document.getElementById(labelledBy)
    if (labelEl?.textContent?.trim()) return truncate(labelEl.textContent.trim(), 120)
  }
  const label = element.closest("label")
  if (label?.textContent?.trim()) return truncate(label.textContent.trim(), 120)
  const text = element.textContent?.trim()
  if (text) return truncate(text, 200)
  return null
}

function getClassHint(element: Element) {
  const classList = Array.from(element.classList || [])
  if (!classList.length) return null
  return classList.slice(0, 3).join(" ")
}

function summarizeAncestor(element: Element) {
  const ancestors: SelectionPayload["ancestorSummary"] = []
  let current: Element | null = element.parentElement
  while (current && ancestors.length < 3) {
    if (current === document.body) break
    const wwId = current.getAttribute("data-ww-id")
    const role = current.getAttribute("role")
    const label = deriveName(current, current.getAttribute("aria-label"))
    ancestors.push({
      wwId: wwId || undefined,
      role: role || undefined,
      tag: current.tagName.toLowerCase(),
      label: label || undefined,
    })
    current = current.parentElement
  }
  return ancestors
}

function resolveTarget(element: Element | null): ResolvedTarget | null {
  if (!element) return null
  if (element.closest("[data-ww-assistant-root]")) return null

  const hasSemanticRole = (el: Element) => {
    const role = el.getAttribute("role")
    const tag = el.tagName.toLowerCase()
    const semanticTags = ["button", "a", "input", "select", "textarea", "summary"]
    const semanticRoles = ["button", "tab", "link", "option", "menuitem", "switch"]
    return role ? semanticRoles.includes(role) : semanticTags.includes(tag)
  }

  const findAncestor = (
    predicate: (el: Element) => boolean
  ): { el: Element; strategy: SelectionPayload["selectorStrategy"] } | null => {
    let current: Element | null = element
    while (current && current !== document.documentElement) {
      if (predicate(current)) {
        return { el: current, strategy: "semantic" }
      }
      current = current.parentElement
    }
    return null
  }

  let current: Element | null = element
  while (current && current !== document.documentElement) {
    const wwId = current.getAttribute("data-ww-id")
    if (wwId) {
      return { element: current, strategy: "ww-id" }
    }
    current = current.parentElement
  }

  current = element
  while (current && current !== document.documentElement) {
    const testId = current.getAttribute("data-testid")
    if (testId) {
      return { element: current, strategy: "testid" }
    }
    current = current.parentElement
  }

  const semanticAncestor = findAncestor(hasSemanticRole)
  if (semanticAncestor) return { element: semanticAncestor.el, strategy: "semantic" }

  current = element
  while (current && current !== document.documentElement) {
    const text = current.textContent?.trim() ?? ""
    const ariaLabel = current.getAttribute("aria-label")
    if ((text && text.length <= 240) || ariaLabel) {
      return { element: current, strategy: "text" }
    }
    current = current.parentElement
  }

  return { element, strategy: "fallback" }
}

function buildSelectionPayload(target: ResolvedTarget): SelectionPayload | null {
  const el = target.element
  if (!el.getBoundingClientRect) return null
  const rect = el.getBoundingClientRect()
  const wwId = el.getAttribute("data-ww-id")
  const testId = el.getAttribute("data-testid")
  const ariaLabel = el.getAttribute("aria-label")

  const rawHtml = "outerHTML" in el ? (el as HTMLElement).outerHTML : ""
  const outerHTMLSnippet = rawHtml ? sanitizeHtmlSnippet(rawHtml) : null
  const visibleText = el.textContent ? truncate(el.textContent.trim(), MAX_TEXT_LENGTH) : null

  const payload: SelectionPayload = {
    pagePath: `${window.location.pathname}${window.location.search}`,
    timestamp: new Date().toISOString(),
    selectorStrategy: target.strategy,
    wwId: wwId || null,
    testId: testId || null,
    tag: el.tagName.toLowerCase(),
    id: el.id || null,
    classHint: getClassHint(el),
    role: el.getAttribute("role"),
    ariaLabel,
    name: deriveName(el, ariaLabel),
    visibleText,
    boundingRect: {
      top: rect.top,
      left: rect.left,
      width: rect.width,
      height: rect.height,
    },
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
    },
    outerHTMLSnippet,
    ancestorSummary: summarizeAncestor(el),
    semanticType: (el as HTMLElement).dataset.wwSemanticType ?? null,
    semanticKey: (el as HTMLElement).dataset.wwSemanticKey ?? null,
    displayValue: (el as HTMLElement).dataset.wwDisplayValue ?? null,
    asOfDate: (el as HTMLElement).dataset.wwAsOf ?? null,
    units: (el as HTMLElement).dataset.wwUnits ?? null,
  }

  const encoded = JSON.stringify(payload)
  if (encoded.length > MAX_PAYLOAD_BYTES) {
    payload.outerHTMLSnippet = null
    payload.visibleText = payload.visibleText ? truncate(payload.visibleText, MAX_TEXT_LENGTH / 2) : null
  }

  return payload
}

function buildDisplayLabel(selection: SelectionPayload | null): DisplayLabel | null {
  if (!selection) return null
  const label = selection.wwId || selection.semanticKey || selection.name || selection.tag
  if (!label) return null
  return {
    full: label,
    compact: truncate(label, DISPLAY_LABEL_LIMIT),
  }
}

function SelectionChip({
  selection,
  label,
  onClear,
}: {
  selection: SelectionPayload | null
  label: DisplayLabel | null
  onClear: () => void
}) {
  if (!selection || !label) return null
  const meta = [selection.semanticType || selection.role, selection.tag].filter(Boolean).join(" • ")
  return (
    <div className="mt-2 flex items-start gap-3 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-white">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-center gap-2">
          <span className="rounded-full bg-indigo-500/20 px-2 py-0.5 text-[11px] font-semibold uppercase text-indigo-100">
            Referenced
          </span>
          <span className="min-w-0 truncate font-semibold text-white" title={label.full}>
            {label.compact}
          </span>
        </div>
        {meta && <div className="text-[11px] text-blue-100/80">{meta}</div>}
      </div>
      <button
        type="button"
        onClick={onClear}
        className="mt-0.5 shrink-0 text-blue-100/80 transition hover:text-white"
        aria-label="Clear referenced element"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}

function renderInline(text: string) {
  const tokens = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g)
  return tokens.map((token, idx) => {
    if (token.startsWith("**") && token.endsWith("**")) {
      return (
        <strong key={`b-${idx}`} className="font-semibold text-white">
          {token.slice(2, -2)}
        </strong>
      )
    }
    if (token.startsWith("`") && token.endsWith("`")) {
      return (
        <code
          key={`code-${idx}`}
          className="rounded bg-white/10 px-1 py-0.5 text-xs font-mono text-indigo-100"
        >
          {token.slice(1, -1)}
        </code>
      )
    }
    return <span key={`t-${idx}`}>{token}</span>
  })
}

function renderMessageContent(content: string) {
  const blocks = content.split(/\n{2,}/)
  return blocks.map((block, idx) => {
    const lines = block.split("\n").filter((l) => l.trim().length > 0)
    const isList = lines.length > 1 && lines.every((l) => l.trim().startsWith("-"))

    if (isList) {
      return (
        <ul key={`list-${idx}`} className="ml-4 list-disc space-y-1 text-blue-100/90">
          {lines.map((line, li) => (
            <li key={`li-${idx}-${li}`}>{renderInline(line.replace(/^\s*-\s*/, ""))}</li>
          ))}
        </ul>
      )
    }

    return (
      <p key={`p-${idx}`} className={idx > 0 ? "mt-2" : ""}>
        {renderInline(block)}
      </p>
    )
  })
}

export function WealthWiseAssistant() {
  const pathname = usePathname()
  const isDashboardRoute = pathname?.startsWith("/dashboard") ?? false
  const [isOpen, setIsOpen] = useState(() => isDashboardRoute)
  const [pickerActive, setPickerActive] = useState(false)
  const [hoverRect, setHoverRect] = useState<SelectionPayload["boundingRect"] | null>(null)
  const [selection, setSelection] = useState<SelectionPayload | null>(null)
  const [dockSide, setDockSide] = useState<"left" | "right">("right")
  const [surveyMode, setSurveyMode] = useState(false)
  const [surveyStep, setSurveyStep] = useState(0)
  const [surveyAnswers, setSurveyAnswers] = useState<string[]>([])
  const [messages, setMessages] = useState<AssistantMessage[]>([
    {
      role: "assistant",
      content:
        "Hi, I’m the WealthWise assistant. Select a UI element to get a tailored explanation, then ask a question.",
    },
  ])
  const [input, setInput] = useState("")
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const lastHoverRef = useRef<ResolvedTarget | null>(null)

  useEffect(() => {
    if (isDashboardRoute) {
      setIsOpen(true)
    }
  }, [isDashboardRoute, pathname])

  useEffect(() => {
    const stored = typeof window !== "undefined" ? localStorage.getItem(CHAT_STORAGE_KEY) : null
    if (stored) {
      try {
        const parsed = JSON.parse(stored) as AssistantMessage[]
        if (Array.isArray(parsed) && parsed.length) {
          setMessages(parsed)
        }
      } catch {
        // ignore malformed cache
      }
    }
  }, [])

  useEffect(() => {
    if (typeof window === "undefined") return
    const handleLaunch = (event: Event) => {
      const detail = (event as CustomEvent<AssistantLaunchPayload>).detail || {}
      setDockSide(detail.dock === "left" ? "left" : "right")
      setIsOpen(true)
      setPickerActive(false)
      if (detail.mode === "survey") {
        const kickoff = detail.prompt || `Question 1 of ${SURVEY_QUESTIONS.length}: ${SURVEY_QUESTIONS[0]}`
        setSurveyMode(true)
        setSurveyStep(0)
        setSurveyAnswers([])
        setMessages([{ role: "assistant", content: kickoff }])
        setSelection(null)
        setInput("")
        return
      }
      setSurveyMode(false)
      setSurveyStep(0)
      setSurveyAnswers([])
    }

    window.addEventListener("ww-assistant-open", handleLaunch as EventListener)
    return () => window.removeEventListener("ww-assistant-open", handleLaunch as EventListener)
  }, [])

  useEffect(() => {
    if (typeof window === "undefined") return
    try {
      localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(messages))
    } catch {
      // best effort
    }
  }, [messages])

  useEffect(() => {
    if (!pickerActive) {
      setHoverRect(null)
      document.body.classList.remove("ww-assistant-picking")
      return
    }

    document.body.classList.add("ww-assistant-picking")

    const handleMove = (event: MouseEvent) => {
      const el = document.elementFromPoint(event.clientX, event.clientY)
      const resolved = resolveTarget(el)
      if (!resolved) {
        setHoverRect(null)
        lastHoverRef.current = null
        return
      }
      lastHoverRef.current = resolved
      const rect = resolved.element.getBoundingClientRect()
      setHoverRect({
        top: rect.top,
        left: rect.left,
        width: rect.width,
        height: rect.height,
      })
    }

    const handleClick = (event: MouseEvent) => {
      const target = event.target as Element | null
      if (target?.closest("[data-ww-assistant-root]")) return
      event.preventDefault()
      event.stopPropagation()
      const el = document.elementFromPoint(event.clientX, event.clientY)
      const resolved = resolveTarget(el)
      if (resolved) {
        const payload = buildSelectionPayload(resolved)
        if (payload) {
          setSelection(payload)
        }
      }
      setPickerActive(false)
    }

    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault()
        setPickerActive(false)
      }
    }

    const handleScroll = () => {
      if (lastHoverRef.current) {
        const rect = lastHoverRef.current.element.getBoundingClientRect()
        setHoverRect({
          top: rect.top,
          left: rect.left,
          width: rect.width,
          height: rect.height,
        })
      }
    }

    const handleMouseLeave = (event: MouseEvent) => {
      if (!event.relatedTarget) {
        setHoverRect(null)
        lastHoverRef.current = null
      }
    }

    document.addEventListener("mousemove", handleMove, true)
    document.addEventListener("click", handleClick, true)
    window.addEventListener("keydown", handleKey, true)
    window.addEventListener("scroll", handleScroll, true)
    window.addEventListener("mouseout", handleMouseLeave, true)

    return () => {
      document.removeEventListener("mousemove", handleMove, true)
      document.removeEventListener("click", handleClick, true)
      window.removeEventListener("keydown", handleKey, true)
      window.removeEventListener("scroll", handleScroll, true)
      window.removeEventListener("mouseout", handleMouseLeave, true)
      document.body.classList.remove("ww-assistant-picking")
      setHoverRect(null)
    }
  }, [pickerActive])

  const handleSend = async () => {
    const trimmed = input.trim()
    if (!trimmed || sending) return
    const nextMessages = [...messages, { role: "user" as const, content: trimmed }]
    setMessages(nextMessages)
    setInput("")
    setSending(true)
    setError(null)

    if (surveyMode && surveyStep < SURVEY_QUESTIONS.length) {
      const answers = [...surveyAnswers]
      answers[surveyStep] = trimmed
      setSurveyAnswers(answers)
      const nextStep = surveyStep + 1

      if (nextStep < SURVEY_QUESTIONS.length) {
        setSurveyStep(nextStep)
        setMessages([
          ...nextMessages,
          {
            role: "assistant",
            content: `Question ${nextStep + 1} of ${SURVEY_QUESTIONS.length}: ${SURVEY_QUESTIONS[nextStep]}`,
          },
        ])
        setSending(false)
        return
      }

      setSurveyStep(nextStep)
      const summary = SURVEY_QUESTIONS.map((q, idx) => {
        const ans = idx === surveyStep ? trimmed : answers[idx] ?? "(not answered)"
        return `Q${idx + 1}: ${q}\nA: ${ans}`
      }).join("\n")

      const finalPrompt =
        `${summary}\n\n${SUPPORTED_METHODS_TEXT}\n` +
        `${ALLOWED_CONTROLS_TEXT}\n` +
        "Pick the single best optimizer from that list and guide the user to run it in the app. " +
        "Respond with: (1) Method label to click in the UI, (2) Why it fits their answers, " +
        '(3) A short "Do this now" list: method to click, lookback to choose, benchmark to pick, and which covariance/return proxy to use. ' +
        "Keep it brief and actionable for a beginner."

      const pendingMessages = [
        ...nextMessages,
        {
          role: "assistant" as const,
          content: "Thanks. I'll choose the best optimizer for you and tell you what to click next.",
        },
      ]
      setMessages(pendingMessages)

      try {
        const res = await fetch("/api/ai/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages: [...nextMessages, { role: "user" as const, content: finalPrompt }],
            selection,
          }),
        })
        if (!res.ok) {
          const body = await res.json().catch(() => null)
          const detail = body?.error || body?.message || body?.detail || "Assistant request failed."
          throw new Error(detail)
        }
        const data = (await res.json()) as { reply: string }
        setMessages([...pendingMessages, { role: "assistant", content: data.reply }])
        setSurveyMode(false)
        setSurveyStep(0)
        setSurveyAnswers([])
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unable to reach assistant.")
      } finally {
        setSending(false)
      }

      return
    }

    try {
      const res = await fetch("/api/ai/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: nextMessages,
          selection,
        }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        const detail = body?.error || body?.message || body?.detail || "Assistant request failed."
        throw new Error(detail)
      }
      const data = (await res.json()) as { reply: string }
      setMessages([...nextMessages, { role: "assistant", content: data.reply }])
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to reach assistant.")
    } finally {
      setSending(false)
    }
  }

  const toggleOpen = () => {
    setIsOpen((prev) => !prev)
    setPickerActive(false)
  }

  const togglePicker = () => {
    setPickerActive((prev) => !prev)
    setIsOpen(true)
  }

  const clearChat = () => {
    setMessages([
      {
        role: "assistant",
        content:
          "New chat started. Pick a UI element and ask what it means or how to interpret it.",
      },
    ])
    setSelection(null)
    setSurveyMode(false)
    setSurveyStep(0)
    setSurveyAnswers([])
  }

  const selectionLabel = useMemo(() => {
    if (!selection) return null
    return buildDisplayLabel(selection)
  }, [selection])

  return (
    <div
      data-ww-assistant-root
      className={cn(
        "fixed bottom-4 z-[2147483000] flex flex-col",
        dockSide === "left" ? "left-4 items-start" : "right-4 items-end"
      )}
    >
      {hoverRect && pickerActive && (
        <div
          className="pointer-events-none fixed rounded-xl border border-indigo-400/60 bg-indigo-500/10 shadow-[0_0_0_2px_rgba(99,102,241,0.35)]"
          style={{
            top: hoverRect.top - 4,
            left: hoverRect.left - 4,
            width: hoverRect.width + 8,
            height: hoverRect.height + 8,
          }}
        />
      )}

      {isOpen && (
        <div
          className="mb-3 w-[420px] min-w-[320px] max-w-[92vw] resize rounded-2xl border border-white/10 bg-gradient-to-br from-[#0c1230] via-[#0b1029] to-[#060814] shadow-2xl shadow-indigo-900/40 backdrop-blur"
          style={{ resize: "both", overflow: "auto" }}
        >
          <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
            <div className="flex items-center gap-2 text-sm font-semibold text-white">
              <Sparkles className="h-4 w-4 text-indigo-300" />
              WealthWise Assistant
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={clearChat}
                className="rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-blue-100/80 transition hover:border-white/30 hover:bg-white/10"
              >
                Clear
              </button>
              <button
                type="button"
                onClick={toggleOpen}
                className="rounded-full p-1 text-blue-100 transition hover:bg-white/10 hover:text-white"
                aria-label="Close assistant"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>

          <div className="max-h-[520px] space-y-3 overflow-y-auto px-4 py-3 text-sm text-blue-100/85">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={togglePicker}
                className={cn(
                  "inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-semibold transition",
                  pickerActive
                    ? "border-indigo-400/70 bg-indigo-500/20 text-white"
                    : "border-white/15 bg-white/5 text-blue-100 hover:border-white/30 hover:bg-white/10"
                )}
              >
                <Pointer className="h-3.5 w-3.5" />
                {pickerActive ? "Cancel select" : "Select element"}
              </button>
              {selectionLabel && (
                <span
                  className="max-w-[240px] truncate rounded-full bg-white/10 px-3 py-1 text-xs font-semibold text-indigo-100"
                  title={selectionLabel.full}
                >
                  {selectionLabel.compact}
                </span>
              )}
            </div>

            <SelectionChip selection={selection} label={selectionLabel} onClear={() => setSelection(null)} />

            {messages.map((msg, idx) => (
              <div
                key={`${msg.role}-${idx}-${msg.content.slice(0, 12)}`}
                className={cn(
                  "flex",
                  msg.role === "assistant" ? "justify-start" : "justify-end"
                )}
              >
                <div
                  className={cn(
                    "max-w-[90%] rounded-2xl px-3 py-2 leading-relaxed",
                    msg.role === "assistant"
                      ? "bg-white/5 text-white"
                      : "bg-indigo-500/20 text-white"
                  )}
                >
                  {renderMessageContent(msg.content)}
                </div>
              </div>
            ))}

            {error && (
              <div className="rounded-xl border border-rose-400/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-100">
                {error}
              </div>
            )}
          </div>

          <div className="border-t border-white/10 px-4 py-3">
            <div className="flex items-end gap-2">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder={
                  selection
                    ? "Ask about the selected element..."
                    : "Select a UI element, then ask a question..."
                }
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault()
                    handleSend()
                  }
                }}
                className="min-h-[56px] flex-1 resize-none rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white outline-none ring-offset-0 transition placeholder:text-blue-100/60 focus:border-indigo-400/60 focus:ring-0"
              />
              <button
                type="button"
                onClick={handleSend}
                disabled={sending}
                className="flex h-11 w-11 items-center justify-center rounded-xl bg-indigo-500 text-white shadow-lg shadow-indigo-900/40 transition hover:bg-indigo-400 disabled:cursor-not-allowed disabled:opacity-60"
                aria-label="Send message"
              >
                {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              </button>
            </div>
            
          </div>
        </div>
      )}

      <button
        type="button"
        onClick={toggleOpen}
        className="flex h-12 w-12 items-center justify-center rounded-full bg-gradient-to-br from-indigo-500 via-blue-500 to-purple-600 text-white shadow-2xl shadow-indigo-900/40 transition hover:-translate-y-0.5 hover:shadow-indigo-900/60"
        aria-label="Open WealthWise assistant"
      >
        <MessageCircle className="h-6 w-6" />
      </button>
    </div>
  )
}
