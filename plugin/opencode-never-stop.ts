import type { Plugin } from "@opencode-ai/plugin"
import type { Event, Part, SessionStatus, AssistantMessage } from "@opencode-ai/sdk"
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

type ThresholdSpec =
  | { kind: "percent"; percent: number }
  | { kind: "tokens"; tokens: number }

type WatchedSession = {
  spec: ThresholdSpec
  message: string
  armed: boolean
}

export const OpenCodeNeverStop: Plugin = async ({ client, directory }) => {
  let config = loadConfig(directory)
  let enabled = false
  const monitored = new Set<string>()
  const tracked = new Map<string, TrackedSession>()
  const contextWatched = new Map<string, WatchedSession>()
  const modelLimits = new Map<string, number>()
  const warnedMissingLimit = new Set<string>()

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

  const parseThreshold = (raw: string): ThresholdSpec | null => {
    const token = raw.trim().split(/\s+/)[0]
    if (!token || !/^\d+$/.test(token)) return null
    const value = parseInt(token, 10)
    if (value < 100) return { kind: "percent", percent: value }
    return { kind: "tokens", tokens: value }
  }

  const parseWatchArgs = (raw: string): { spec: ThresholdSpec; message: string } | null => {
    const trimmed = raw.trim()
    const specText = trimmed.split(/\s+/)[0]
    if (!specText) return null
    const message = trimmed.slice(specText.length).trim()
    if (!message) return null
    const spec = parseThreshold(specText)
    if (!spec) return null
    return { spec, message }
  }

  const cacheModelLimits = async (): Promise<boolean> => {
    try {
      const { providers } = unwrap(await client.config.providers({ query: { directory } }))
      for (const provider of providers) {
        for (const [modelID, model] of Object.entries(provider.models ?? {})) {
          if (typeof model.limit?.context === "number" && model.limit.context > 0) {
            modelLimits.set(`${provider.id}/${modelID}`, model.limit.context)
          }
        }
      }
      return true
    } catch (err) {
      await log("warn", `failed to read model limits: ${String(err)}`)
      return false
    }
  }

  const startContextWatch = async (sessionID: string, spec: ThresholdSpec, message: string) => {
    if (spec.kind === "percent") await cacheModelLimits()
    contextWatched.set(sessionID, { spec, message, armed: true })
    await log("info", `started context watch for session ${sessionID}`, {
      threshold: spec,
    })
  }

  const stopContextWatch = async (sessionID: string) => {
    contextWatched.delete(sessionID)
    await log("info", `stopped context watch for session ${sessionID}`)
  }

  const fireContextAlert = async (sessionID: string, watch: WatchedSession) => {
    if (!watch.armed) return
    watch.armed = false
    try {
      await client.session.promptAsync({
        path: { id: sessionID },
        body: { parts: [{ type: "text", text: watch.message }] },
      })
      await log("info", `context threshold reached for session ${sessionID}; nudged agent`)
    } catch (err) {
      await log("error", `context nudge to session ${sessionID} failed: ${String(err)}`)
    }
  }

  const onAssistantMessage = async (info: AssistantMessage) => {
    const watch = contextWatched.get(info.sessionID)
    if (!watch) return
    const tokens = info.tokens
    const total = tokens.input + tokens.cache.read + tokens.cache.write
    if (total <= 0) return
    if (watch.spec.kind === "tokens") {
      if (total >= watch.spec.tokens) await fireContextAlert(info.sessionID, watch)
      else watch.armed = true
      return
    }
    let limit = modelLimits.get(`${info.providerID}/${info.modelID}`)
    if (!limit) {
      await cacheModelLimits()
      limit = modelLimits.get(`${info.providerID}/${info.modelID}`)
    }
    if (!limit) {
      if (!warnedMissingLimit.has(info.sessionID)) {
        warnedMissingLimit.add(info.sessionID)
        await log("warn", `cannot compute context % for ${info.providerID}/${info.modelID}: no model limit`, {
          total,
        })
      }
      return
    }
    if ((total / limit) * 100 >= watch.spec.percent) await fireContextAlert(info.sessionID, watch)
    else watch.armed = true
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
      contextWatched.clear()
      modelLimits.clear()
      warnedMissingLimit.clear()
      if (timer) clearTimeout(timer)
    },
    "command.execute.before": async (input, output) => {
      // prompt.ts keeps its own reference to the parts array, so the hook
      // must mutate it in place instead of rebinding output.parts
      if (input.command === "opencode-never-stop") {
        output.parts.splice(0, output.parts.length, {
          type: "text",
          synthetic: true,
          text: "Plugin notification (no task, no action needed): opencode-never-stop monitoring for this session is now ENABLED. Informational only — reply with one short confirmation and take no further action.",
        } as Part)
        await start(input.sessionID)
      } else if (input.command === "opencode-stop") {
        output.parts.splice(0, output.parts.length, {
          type: "text",
          synthetic: true,
          text: "Plugin notification (no task, no action needed): opencode-never-stop monitoring for this session is now DISABLED. Informational only — reply with one short confirmation and take no further action.",
        } as Part)
        await stop()
      } else if (input.command === "opencode-never-proceed-after") {
        const parsed = parseWatchArgs(input.arguments ?? "")
        if (parsed) {
          await startContextWatch(input.sessionID, parsed.spec, parsed.message)
        } else {
          await log("warn", `opencode-never-proceed-after: expected '<threshold> <message>'`)
        }
      } else if (input.command === "opencode-never-proceed-after-stop") {
        await stopContextWatch(input.sessionID)
      }
    },
    "tool.execute.before": async (input) => {
      onActivity(input.sessionID)
    },
    event: async ({ event }: { event: Event }) => {
      if (!enabled && contextWatched.size === 0) return
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
          if (event.properties.info.role === "assistant") {
            await onAssistantMessage(event.properties.info)
          } else {
            onActivity(event.properties.info.sessionID)
          }
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
          contextWatched.delete(event.properties.info.id)
          break
      }
    },
  }
}