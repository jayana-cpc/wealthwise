import { NextRequest, NextResponse } from "next/server"

import { ChatRequestBody } from "@/lib/assistant/types"

export const runtime = "nodejs"

export async function POST(req: NextRequest) {
  let body: ChatRequestBody
  try {
    body = (await req.json()) as ChatRequestBody
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 })
  }

  if (!body?.messages?.length) {
    return NextResponse.json({ error: "messages are required" }, { status: 400 })
  }

  try {
    const backendBase = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:8001"
    const cookie = req.headers.get("cookie")

    const backendRes = await fetch(`${backendBase}/api/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify(body),
      credentials: "include",
    })

    const responseBody = await backendRes.json().catch(() => null)
    return NextResponse.json(responseBody ?? {}, { status: backendRes.status })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error"
    return NextResponse.json({ error: "Assistant call failed", detail: message }, { status: 500 })
  }
}
