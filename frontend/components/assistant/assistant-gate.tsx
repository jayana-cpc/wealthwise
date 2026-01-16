"use client"

import { usePathname } from "next/navigation"

import { WealthWiseAssistant } from "@/components/assistant/assistant-overlay"

const HIDDEN_PATHS = ["/", "/signin"]

export default function AssistantGate() {
  const pathname = usePathname() || "/"
  const isHidden = HIDDEN_PATHS.some((path) =>
    path === "/" ? pathname === "/" : pathname.startsWith(path)
  )

  if (isHidden) return null

  return <WealthWiseAssistant />
}
