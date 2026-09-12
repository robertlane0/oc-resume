/**
 * Resume plugin — provides `/resume` and its alias `/continue`.
 *
 * - `/resume` → reloads the last session and sends "Continue"
 * - `/resume <custom message>` → reloads the last session and sends the custom message
 * - `/continue` behaves exactly like `/resume` (same with custom message)
 *
 * Implementation:
 * - `config` hook registers the `resume` command template plus the `continue` alias.
 * - `resume` tool performs the actual reload (list sessions → pick last →
 *   promptAsync → best-effort TUI switch + toast).
 * - `command.execute.before` hook intercepts both invocations so the
 *   reload happens even before the LLM runs, then rewrites the command parts
 *   to a short acknowledgement (avoiding a double tool call).
 *
 * Install in exactly ONE place (project `.opencode/plugin/` OR global
 * `~/.config/opencode/plugins/`). The same plugin file installed in both
 * places makes the hook fire twice and delivers the message twice.
 */

import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"

export const DEFAULT_RESUME_MESSAGE = "Continue"

export const RESUME_COMMAND = "resume"
export const CONTINUE_COMMAND = "continue"
export const RESUME_TOOL = "resume"

type SessionLike = {
  id: string
  parentID?: string
  title?: string
  time?: { created?: number; updated?: number }
  [key: string]: unknown
}

/** Resolve the message to send: trimmed custom text, or "Continue" when empty. */
export function resolveResumeMessage(raw?: string): string {
  const text = (raw ?? "").trim()
  return text.length > 0 ? text : DEFAULT_RESUME_MESSAGE
}

/** Unwrap `session.list` responses across SDK shapes (array or `{ data: [...] }`). */
export function unwrapSessions(response: unknown): SessionLike[] {
  if (!response) return []
  if (Array.isArray(response)) return response as SessionLike[]
  if (typeof response === "object" && response !== null && Array.isArray((response as any).data)) {
    return (response as any).data as SessionLike[]
  }
  return []
}

/**
 * Pick the last session from a list already sorted by most-recently-updated.
 * Excludes the current session (the one `/resume` was invoked from).
 * Prefers root sessions (no `parentID`, matching `opencode run --continue`),
 * falling back to the most recent session of any kind.
 */
export function pickLastSession(sessions: SessionLike[], currentSessionID?: string): SessionLike | undefined {
  const filtered = currentSessionID ? sessions.filter((s) => s?.id !== currentSessionID) : [...sessions]
  if (filtered.length === 0) return undefined
  return filtered.find((s) => !s?.parentID) ?? filtered[0]
}

/** List sessions (scoped to `directory` when provided) and pick the last one. */
export async function findLastSession(
  client: any,
  opts: { currentSessionID?: string; directory?: string },
): Promise<SessionLike | undefined> {
  const listArgs = opts.directory ? { query: { directory: opts.directory } } : undefined
  let response: unknown
  try {
    response = await client.session.list(listArgs)
  } catch {
    // Fallback for SDKs with a flat signature: list({ directory })
    response = await client.session.list(
      opts.directory ? { directory: opts.directory } : undefined,
    )
  }
  return pickLastSession(unwrapSessions(response), opts.currentSessionID)
}

/** Send `message` to `sessionID` without blocking on the LLM response. */
export async function sendResumeMessage(
  client: any,
  opts: { sessionID: string; message: string; directory?: string },
): Promise<void> {
  const parts = [{ type: "text" as const, text: opts.message }]
  const query = opts.directory ? { directory: opts.directory } : undefined
  // Preferred: async prompt (returns immediately, session keeps running).
  try {
    await client.session.promptAsync({ path: { id: opts.sessionID }, body: { parts }, query })
    return
  } catch {}
  try {
    // v2-style flat signature fallback.
    await client.session.promptAsync({ sessionID: opts.sessionID, parts } as any)
    return
  } catch {}
  // Last resort: blocking prompt with noReply (still delivers the message).
  await client.session.prompt({ path: { id: opts.sessionID }, body: { parts, noReply: true }, query } as any)
}

/** Best-effort: navigate the attached TUI to `sessionID`. Ignores errors (headless/CLI). */
export async function switchToSession(client: any, sessionID: string): Promise<void> {
  try {
    await client.tui.publish({
      body: { type: "tui.session.select", properties: { sessionID } },
    } as any)
  } catch {}
}

/** Best-effort: show a TUI toast. Ignores errors (headless/CLI). */
export async function toast(client: any, message: string, variant: "info" | "success" | "warning" | "error" = "info"): Promise<void> {
  try {
    await client.tui.showToast({ body: { message, variant } })
  } catch {}
}

/**
 * Reload the last session and send it `message` (default "Continue").
 * Returns the resumed session and the message actually sent.
 */
export async function resumeLastSession(
  client: any,
  opts: { currentSessionID?: string; directory?: string; message?: string },
): Promise<{ session: SessionLike; message: string }> {
  const message = resolveResumeMessage(opts.message)
  const session = await findLastSession(client, opts)
  if (!session) throw new Error("No previous session found to resume.")
  await sendResumeMessage(client, { sessionID: session.id, message, directory: opts.directory })
  await switchToSession(client, session.id)
  await toast(client, `Resumed session ${session.title ? `"${session.title}" ` : ""}(${session.id})`, "success")
  return { session, message }
}

/**
 * Replace the command's parts IN PLACE.
 *
 * The server calls this hook as `trigger(name, input, { parts })`, keeps
 * using its own `parts` array reference, and discards the return value — so
 * reassigning `output.parts = [...]` is silently ignored. The LLM would then
 * see the original template ("use the resume tool...") and send a SECOND
 * message via the tool on top of the one already sent below.
 */
function setCommandParts(output: { parts: unknown[] }, text: string): void {
  output.parts.splice(0, output.parts.length, { type: "text", text } as never)
}

export const ResumePlugin: Plugin = async ({ client, directory }) => {
  return {
    config: async (cfg) => {
      cfg.command ??= {}
      const template = [
        `Use the ${RESUME_TOOL} tool to reload the most recent session (excluding the current session) and send it a message to continue.`,
        ``,
        `Message to send: $ARGUMENTS`,
        ``,
        `If the message above is empty, send "${DEFAULT_RESUME_MESSAGE}" instead.`,
        `After the tool succeeds, briefly confirm which session was resumed and with what message.`,
      ].join("\n")
      cfg.command[RESUME_COMMAND] = {
        description: "Reload the last session and continue (default: Continue)",
        template,
      }
      cfg.command[CONTINUE_COMMAND] = {
        description: "Alias of /resume: reload the last session and continue",
        template,
      }
    },

    tool: {
      [RESUME_TOOL]: tool({
        description:
          "Reload the most recent session (excluding the current one) and send it a message to continue. Defaults to \"Continue\" when no message is given. Also navigates the TUI to that session when attached.",
        args: {
          message: tool.schema
            .string()
            .optional()
            .describe(
              `Message to send to the resumed session. Defaults to "${DEFAULT_RESUME_MESSAGE}" when omitted or empty.`,
            ),
        },
        async execute(args, ctx) {
          const result = await resumeLastSession(client, {
            currentSessionID: (ctx as any)?.sessionID,
            directory: (ctx as any)?.directory ?? directory,
            message: (args as any)?.message,
          })
          const title = (result.session.title as string) || result.session.id
          return {
            title: `Resumed ${title}`,
            output: `Resumed session "${title}" (${result.session.id}) with message: ${JSON.stringify(result.message)}`,
            metadata: { sessionID: result.session.id, message: result.message },
          }
        },
      }),
    },

    "command.execute.before": async (input, output) => {
      if (input.command !== RESUME_COMMAND && input.command !== CONTINUE_COMMAND) return
      const requested = resolveResumeMessage(input.arguments)
      try {
        const result = await resumeLastSession(client, {
          currentSessionID: input.sessionID,
          directory,
          message: requested,
        })
        const title = (result.session.title as string) || result.session.id
        setCommandParts(
          output,
          `The resume has already been performed: reloaded session "${title}" (${result.session.id}) and sent it ${JSON.stringify(result.message)}. Briefly confirm this to the user. Do not call any tools.`,
        )
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        setCommandParts(
          output,
          `Failed to resume the last session: ${detail}. Report this failure to the user. Do not call any tools.`,
        )
      }
    },
  }
}

export default {
  id: "resume",
  server: ResumePlugin,
}
