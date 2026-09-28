# Missing-file reads

`media/chat.js` keeps a failed read/view neutral when its failure detail has
an explicit missing-file signature: `ENOENT`, `No such file or directory`,
or `File does not exist`. Permission/access denials and I/O errors stay red,
including mixed missing-file/permission failures. Shell, edit, search, fetch
and list failures are not neutralized. Successful file contents are never
used to infer a failure.

The row says `<file> — doesn't exist yet`. The original failure text remains
in the expandable row; the provider's failed status is unchanged. The same
rule runs for live calls, updates, replay, grouped rows and single flat rows
on all surfaces. `markToolFailed` and `applyToolFailure` own the presentation;
`toolLabel` gives rebuilt rows the same wording.

## Evidence checked locally (2026-09-28)

- **Muse:** owner-supplied missing-read message: `No such file or directory
  (os error 2); requested relative path …`. `adapters/muse/projection.mts`
  sends a failed `read_file` as `kind: "other"` with `title: "read_file"` and
  `failureReason` on `rawOutput.message` (a failed update carries no ACP text
  content); the row treats that title as a read.
- **Grok:** `test/webview-helpers.test.ts` and the image-read captures in
  `docs/internal/ACP-feedback.md` establish the `rawOutput.FileReadError`
  variant. The latter also records that a delegated `fs/read_text_file`
  error is wrapped verbatim. `src/acp.ts` forwards the read handler's error,
  and the filesystem handler returns Node's `ENOENT: no such file or
  directory, open '…'` for a missing file. This tests the delegated read
  shape; no new live capture of Grok's native reader was made.
- **Claude:** the installed `@agentclientprotocol/claude-agent-acp/dist/tools.js`
  maps `Read` to `kind: "read"`; `toolUpdateFromToolResult` sends `is_error`
  text through `toAcpContentUpdate`, with failed status. The installed
  `@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe` contains the Read
  error literal `File does not exist.` alongside its file-read diagnostics.
  The binary was inspected as data, never executed.
- **Codex:** the installed `@agentclientprotocol/codex-acp/dist/index.js`
  maps a parsed command action `read` to `kind: "read"`, a `Read file '…'`
  title and `locations[].path`. `completeCommandExecutionEvent` retains
  failed status and places command output in `rawOutput.formatted_output`
  with `exit_code`. Missing POSIX reads therefore use the shell's
  `cat: …: No such file or directory` text in that envelope. Its own
  `looksLikeCommandFailure` also recognizes `No such file or directory`
  and `ENOENT`. This is adapter inspection, not a new model-turn capture.

`test/missing-file-read.dom.test.ts` exercises these envelopes, including
the real Muse projection, sparse Claude updates, late updates after flatten,
expanded detail, successful text, unrelated tools, and permission/I/O failures.
