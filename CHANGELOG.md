# Changelog

## 2.2.24

- Log the raw `session/page` response shape when it yields no records.

## 2.2.23

- Write `session/page` failures to the bridge log. A failed page used to be
  swallowed into an empty record list, which looked like a task that never
  finished.

## 2.2.22

- Log the loaded plugin version and a one-shot page diagnostic (record count,
  max seq, recent record types) to the bridge log, so a mismatch between the
  installed files and the running DSH process is visible.
- Route watchdog tick failures to the bridge log instead of only the host
  logger.

## 2.2.21

- Unwrap `{ type: "event", event }` records returned by the current DSH
  `session/page` API. Without this, the console could not find the user prompt,
  assistant reply, or `turn/end`, so a task stayed "running" forever and kept
  sending progress messages even though DSH had already answered.

## 2.2.20

- Resolve a cold session through `sessionController.resolveAgent()` before
  changing its permission preset. After a DSH restart, persisted sessions are
  not in the live session registry, so permission changes previously failed
  with "DSH 权限服务不可用，或会话当前不在运行栈中".

## 2.2.19

- Destroy the previous gateway socket immediately on stop or replacement, so a
  reconnect can no longer leave two QQ gateway connections receiving the same
  message and replying twice.
- Keep a process-wide single active gateway across DSH plugin reloads. When a
  new module instance boots after a profile rebuild, it stops the previous
  instance's gateway before connecting.

## 2.2.18

- Deduplicate inbound QQ messages by `msg_id`, so a message delivered twice
  (for example by an orphaned gateway connection) no longer produces two replies.
- Keep inline command labels in the plain-text fallback instead of stripping the
  tags and leaving empty `「」` placeholders.
- Destroy gateway sockets after a failed close handshake and reject stale
  WebSocket upgrades, preventing old connections from surviving a reconnect.

## 2.2.17

- Pass an `AbortSignal` to `sessionController.prompt()` and `page()`, fixing
  `Cannot read properties of undefined (reading 'throwIfAborted')` on every
  outbound message with newer DSH hosts.
- Only offer reasoning efforts the selected model actually declares. Models
  without a declared effort list now offer "default" only, and unsupported
  values are rejected with a clear message instead of a host error.

## 2.2.16

- Restore the original bottom menu: projects + 对话 + 设置 + 更多.
- Keep selectable tags inside cards for projects, conversations, report modes,
  current conversation, session operations, and busy-task choices.
- Use inline command tags instead of multi-row keyboards, which QQ C2C rejects.

## 2.2.14

- Replace multi-row keyboards with inline selectable command tags.
- Add real QQ API verification for project cards.

## 2.2.13

- Attach a fresh `msg_id` to control replies so QQ treats them as passive replies.
- Add plain-text fallback when Markdown or keyboards are rejected.

## 2.2.10

- Model names are directly selectable.
- Reasoning efforts are ordered high to low; `off` is shown as `强度0（关闭）`.

## 2.2.1

- Persist AppID and DPAPI-protected AppSecret across DSH restarts.
- Connect immediately after saving credentials.
- Add the DSH model catalog and WorkBuddy cached models.

## 2.0.0

- First DSH-native QQ console: gateway, menu, task confirmation, progress,
  queueing, steering, interruption, attachments, models and permissions.
