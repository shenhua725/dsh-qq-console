# Changelog

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
