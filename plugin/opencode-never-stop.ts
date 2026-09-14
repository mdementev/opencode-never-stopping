import type { Plugin } from "@opencode-ai/plugin"
import type { Event, Part, SessionStatus } from "@opencode-ai/sdk"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

type DataResult<T> = { data?: T; error?: unknown }

const unwrap = <T>(res: DataResult<T> | T): T => {
  const obj = res as { data?: T }
  if (obj && typeof obj === "object" && "data" in obj) {
    if (obj.data === undefined) throw new Error("empty response from opencode API")
    return obj.data
  }
  return res as T
}

type NeverStopConfig = {
  checkIntervalSeconds: number
  message: string
}

const DEFAULT_MESSAGE =
  "Have you done all your assignments? If anything is left, continue \u2014 or spend some more time double-checking your work."

const DEFAULT_CONFIG: NeverStopConfig = {
  checkIntervalSeconds: 15,
  message: DEFAULT_MESSAGE,
}

function loadConfig(directory: string): NeverStopConfig {
  const override = process.env.OPENCODE_NEVER_STOP_CONFIG?.trim()
  const candidates = [
    ...(override ? [override] : []),
    join(directory, ".opencode", "opencode-never-stop.json"),
    join(homedir(), ".config", "opencode", "opencode-never-stop.json"),
  ]
  for (const file of candidates) {
    if (!existsSync(file)) continue
    try {
      const raw = JSON.parse(readFileSync(file, "utf8"))
      const checkIntervalSeconds =
        typeof raw.checkIntervalSeconds === "number" && raw.checkIntervalSeconds > 0
          ? raw.checkIntervalSeconds
          : DEFAULT_CONFIG.checkIntervalSeconds
      const message =
        typeof raw.message === "string" && raw.message.trim() ? raw.message : DEFAULT_CONFIG.message
      return { checkIntervalSeconds, message }
    } catch (err) {
      console.error(`opencode-never-stop: failed to parse ${file}: ${String(err)}`)
    }
  }
  return { ...DEFAULT_CONFIG }
}

type TrackedSession = {
  idleSince: number | null
}

export const OpenCodeNeverStop: Plugin = async ({ client, directory }) => {
  let config = loadConfig(directory)
  let enabled = false
  const monitored = new Set<string>()
  const tracked = new Map<string, TrackedSession>()

  const log = async (level: "info" | "warn" | "error", message: string, extra?: Record<string, unknown>) => {
    try {
      await client.app.log({ body: { service: "opencode-never-stop", level, message, extra } })
    } catch {
      // logging must never break the plugin
    }
  }

  const toast = (message: string, variant: "info" | "success" | "warning" | "error" = "info") => {
    try {
      void client.tui.showToast({ body: { message, variant } })
    } catch {
      // TUI may not be attached
    }
  }

  const track = (sessionID: string): TrackedSession => {
    let state = tracked.get(sessionID)
    if (!state) {
      state = { idleSince: null }
      tracked.set(sessionID, state)
    }
    return state
  }

  const refreshStatus = async (sessionID: string): Promise<SessionStatus | undefined> => {
    const statuses = unwrap(await client.session.status({ query: { directory } }))
    return statuses?.[sessionID]
  }

  const start = async (sessionID: string) => {
    config = loadConfig(directory)
    enabled = true
    monitored.clear()
    tracked.clear()
    monitored.add(sessionID)
    track(sessionID)
    try {
      const status = await refreshStatus(sessionID)
      // per opencode semantics a session absent from the status map is idle
      if (!status || status.type === "idle") {
        const state = track(sessionID)
        if (state.idleSince === null) state.idleSince = Date.now()
      }
    } catch (err) {
      await log("warn", `failed to read initial session status: ${String(err)}`)
    }
    await log("info", `started monitoring session ${sessionID}`, {
      checkIntervalSeconds: config.checkIntervalSeconds,
    })
    toast("Never stop: monitoring ON", "success")
    schedule()
  }

  const stop = async () => {
    enabled = false
    monitored.clear()
    tracked.clear()
    await log("info", "stopped monitoring")
    toast("Never stop: monitoring OFF", "warning")
  }

  const nudge = async (sessionID: string) => {
    try {
      await client.session.promptAsync({
        path: { id: sessionID },
        body: { parts: [{ type: "text", text: config.message }] },
      })
      await log("info", `nudged session ${sessionID}`)
    } catch (err) {
      await log("error", `nudge to session ${sessionID} failed: ${String(err)}`)
    }
  }

  const tick = async () => {
    if (!enabled || monitored.size === 0) return
    let statuses: Record<string, SessionStatus>
    try {
      statuses = unwrap(await client.session.status({ query: { directory } }))
    } catch (err) {
      await log("warn", `status poll failed: ${String(err)}`)
      return
    }
    const now = Date.now()
    for (const sessionID of monitored) {
      const status = statuses[sessionID]
      const state = track(sessionID)
      // opencode removes idle sessions from the status map, so absence = idle
      if (status && status.type !== "idle") {
        state.idleSince = null
        continue
      }
      if (state.idleSince === null) {
        state.idleSince = now
      } else if (now - state.idleSince >= config.checkIntervalSeconds * 1000) {
        await nudge(sessionID)
        state.idleSince = now
      }
    }
  }

  let timer: ReturnType<typeof setTimeout> | null = null

  const schedule = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(async () => {
      try {
        await tick()
      } catch (err) {
        await log("error", `tick failed: ${String(err)}`)
      }
      schedule()
    }, Math.max(1000, config.checkIntervalSeconds * 1000))
  }
  schedule()

  const onActivity = (sessionID: string) => {
    if (!monitored.has(sessionID)) return
    track(sessionID).idleSince = null
  }

  return {
    dispose: async () => {
      enabled = false
      monitored.clear()
      tracked.clear()
      if (timer) clearTimeout(timer)
    },
    "command.execute.before": async (input, output) => {
      // prompt.ts keeps its own reference to the parts array, so the hook
      // must mutate it in place instead of rebinding output.parts
      if (input.command === "opencode-never-stop") {
        output.parts.splice(0, output.parts.length, {
          type: "text",
          text: "opencode-never-stop: monitoring enabled.",
        } as Part)
        await start(input.sessionID)
      } else if (input.command === "opencode-stop") {
        output.parts.splice(0, output.parts.length, {
          type: "text",
          text: "opencode-never-stop: monitoring disabled.",
        } as Part)
        await stop()
      }
    },
    "tool.execute.before": async (input) => {
      onActivity(input.sessionID)
    },
    event: async ({ event }: { event: Event }) => {
      if (!enabled) return
      switch (event.type) {
        case "session.status": {
          if (monitored.has(event.properties.sessionID)) {
            const state = track(event.properties.sessionID)
            state.idleSince =
              event.properties.status.type === "idle" ? (state.idleSince ?? Date.now()) : null
          }
          break
        }
        case "session.idle": {
          if (monitored.has(event.properties.sessionID)) {
            const state = track(event.properties.sessionID)
            if (state.idleSince === null) state.idleSince = Date.now()
          }
          break
        }
        case "message.part.updated":
          onActivity(event.properties.part.sessionID)
          break
        case "message.updated":
          onActivity(event.properties.info.sessionID)
          break
        case "permission.replied":
          onActivity(event.properties.sessionID)
          break
        case "session.created":
          if (monitored.has(event.properties.info.id)) track(event.properties.info.id)
          break
        case "session.deleted":
          monitored.delete(event.properties.info.id)
          tracked.delete(event.properties.info.id)
          break
      }
    },
  }
}