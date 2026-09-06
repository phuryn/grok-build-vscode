# Complete Documentation: Google Antigravity (`agy`) & Gemini Integration in `grok-build-vscode`

**Project:** `grok-build-vscode` (VS Code Extension for xAI Grok, OpenAI Codex, Anthropic Claude Code, and Google Antigravity / Gemini)  
**Document Version:** 5.3.0 (Master Documentation including Multimodal Vision & Image Context Architecture, Resilient Relative Path Resolution, Quota Analysis, Plan Mode Review Workflow, Markdown Embedding & Session Persistence)  
**Date:** September 5, 2026  
**Status:** Implemented & verified. Full test suite green (211 files / 4,939 tests, 0 failures). Markdown rendering (`file://` URIs, images, alerts), native Plan Mode (`implementation_plan.md` -> `x.ai/exit_plan_mode`), session listing, session cache, transcript replay, multimodal vision staging via `view_file`, and subproject path resolution are integrated and pushed to the GitHub fork.  
**Reference Binaries:** `%USERPROFILE%\.gemini\bin\agy.exe` (v1.1.26), `@agentclientprotocol/claude-agent-acp`, and legacy `gemini-cli`

---

## Table of Contents

1. [Executive Summary & Background](#1-executive-summary--background)
   - [1.1 The Problem: EOL of Gemini Code Assist for Individuals](#11-the-problem-eol-of-gemini-code-assist-for-individuals)
   - [1.2 The Google Antigravity Platform (`agy`)](#12-the-google-antigravity-platform-agy)
   - [1.3 System Comparison: Legacy `gemini-cli` vs. Google Antigravity `agy`](#13-system-comparison-legacy-gemini-cli-vs-google-antigravity-agy)
2. [Architectural Concept: The `AgyAcpAdapter` Bridge](#2-architectural-concept-the-agyacpadapter-bridge)
   - [2.1 The Bridge & Adapter Pattern](#21-the-bridge--adapter-pattern)
   - [2.2 The Antigravity NDJSON Streaming Protocol](#22-the-antigravity-ndjson-streaming-protocol)
   - [2.3 Protocol Translation Matrix: ACP <-> NDJSON](#23-protocol-translation-matrix-acp---ndjson)
3. [Detailed File and Component Overview](#3-detailed-file-and-component-overview)
   - [3.1 Backend & Protocol Adapter (TypeScript)](#31-backend--protocol-adapter-typescript)
   - [3.2 Host Integration & Context Handling](#32-host-integration--context-handling)
   - [3.3 Webview UI & Styling (JavaScript / SVG / CSS)](#33-webview-ui--styling-javascript--svg--css)
   - [3.4 Configuration & Typing](#34-configuration--typing)
4. [Complete Model Specification (14 Models & Gemini 3 Family)](#4-complete-model-specification-14-models--gemini-3-family)
   - [4.1 Table of Available Antigravity Models](#41-table-of-available-antigravity-models)
   - [4.2 Model Discovery: Static, Not Dynamic](#42-model-discovery-static-not-dynamic)
   - [4.3 Reasoning Effort: The Measured Contract](#43-reasoning-effort-the-measured-contract)
5. [Runtime Milestones & Practical Solutions](#5-runtime-milestones--practical-solutions)
   - [5.1 Context Window Correction (1.0M instead of 200k)](#51-context-window-correction-10m-instead-of-200k)
   - [5.2 Live Tool-Calling Streaming (Step Progress & Terminal Output)](#52-live-tool-calling-streaming-step-progress--terminal-output)
   - [5.3 Workspace Binding (`--add-dir <cwd>`)](#53-workspace-binding---add-dir-cwd)
   - [5.4 Tool Label & Parameter Normalization (`Run git status`)](#54-tool-label--parameter-normalization-run-git-status)
   - [5.5 Extension Startup & Packaging Repair (VSIX `node_modules`)](#55-extension-startup--packaging-repair-vsix-node_modules)
   - [5.6 Markdown Embedding & Link Handling (`file://`, Images, GitHub Alerts)](#56-markdown-embedding--link-handling-file-images-github-alerts)
   - [5.7 Plan Mode & Implementation Plan Review Workflow (`x.ai/exit_plan_mode`)](#57-plan-mode--implementation-plan-review-workflow-xaiexit_plan_mode)
   - [5.8 Session Persistence, Session Listing & Transcript Replay](#58-session-persistence-session-listing--transcript-replay)
   - [5.9 Mode Control (`agent`, `plan`, `yolo`) & CLI Flag Validation](#59-mode-control-agent-plan-yolo--cli-flag-validation)
   - [5.10 Elimination of Flashing Console Windows (`windowsHide` & In-Process PATH Lookup)](#510-elimination-of-flashing-console-windows-windowshide--in-process-path-lookup)
   - [5.11 Multimodal Vision & Image Context Architecture (Stream-JSON Image Limitation & `view_file` Bridge)](#511-multimodal-vision--image-context-architecture-stream-json-image-limitation--view_file-bridge)
   - [5.12 Resilient Relative File Path Resolution (Subproject Discovery & `findInSubtree` Fallback)](#512-resilient-relative-file-path-resolution-subproject-discovery--findinsubtree-fallback)
6. [Token & Session Limits: Root Causes and Fixes](#6-token--session-limits-root-causes-and-fixes)
   - [6.1 What Actually Drove Token Consumption](#61-what-actually-drove-token-consumption)
   - [6.2 Evaluation of the Initial Isolation Fix](#62-evaluation-of-the-initial-isolation-fix)
   - [6.3 Remediation in the Antigravity Adapter](#63-remediation-in-the-antigravity-adapter)
   - [6.4 Cross-Provider Remediation (Claude, Gemini, Codex, Grok)](#64-cross-provider-remediation-claude-gemini-codex-grok)
7. [Quality Assurance & Test Results](#7-quality-assurance--test-results)
   - [7.1 Dedicated Adapter Tests](#71-dedicated-adapter-tests)
   - [7.2 Entire Test Suite (`npm test`)](#72-entire-test-suite-npm-test)
   - [7.3 E2E Checklist in Visual Studio Code](#73-e2e-checklist-in-visual-studio-code)
   - [7.4 Quota Test Bench: Stub, Bench, Live Probe, and Analysis](#74-quota-test-bench-stub-bench-live-probe-and-analysis)
8. [User and Developer Guide](#8-user-and-developer-guide)
   - [8.1 For End Users](#81-for-end-users)
   - [8.2 For Developers (Build, Packaging, Tests)](#82-for-developers-build-packaging-tests)
9. [Universal Diff Support & Revert](#9-universal-diff-support--revert)
   - [9.1 The Gap This Closes](#91-the-gap-this-closes)
   - [9.2 Diff Synthesis in the Antigravity Adapter](#92-diff-synthesis-in-the-antigravity-adapter)
   - [9.3 Single-Edit Revert](#93-single-edit-revert)
   - [9.4 Known Limitations](#94-known-limitations)

---

## 1. Executive Summary & Background

### 1.1 The Problem: EOL of Gemini Code Assist for Individuals
When attempting to authenticate in the legacy `gemini-cli` with a Google account (`gemini auth login`), the OAuth flow failed with the following error message:
```text
Failed to sign in. Message: This client is no longer supported for Gemini Code Assist for individuals.
To continue using Gemini, please migrate to the Antigravity suite of products: https://antigravity.google
```
Google officially sunset the standalone npm package `gemini-cli` and its OAuth backend for individual developers, replacing it with the Antigravity product suite.

### 1.2 The Google Antigravity Platform (`agy`)
The official Google-maintained successor is the **Antigravity CLI (`agy`)**, installed via:
```powershell
irm https://antigravity.google/cli/install.ps1 | iex
```
On Windows developer workstations, the binary is located by default at `%USERPROFILE%\.gemini\bin\agy.exe`. It accesses Google Cloud OAuth credentials directly (`oauth_creds.json`) and provides the latest Gemini 3 models as well as hosted Anthropic and open-weight models.

### 1.3 System Comparison: Legacy `gemini-cli` vs. Google Antigravity `agy`

| Property | Legacy `gemini-cli` (v0.60.0) | Google Antigravity CLI (`agy.exe` v1.1.26) |
| :--- | :--- | :--- |
| **Status & Support** | Deprecated / EOL for individual developers | Official Google standard |
| **Windows Path** | `%APPDATA%\npm\gemini.cmd` | `%USERPROFILE%\.gemini\bin\agy.exe` |
| **Authentication** | OAuth disabled (API-Key only) | Fully integrated Google Account login |
| **Interface** | Native `--acp` (JSON-RPC 2.0) | High-performance NDJSON (`stream-json`) |
| **Model Selection** | Gemini base models only | Multimodal: Gemini 3.8, 3.7, 3.6, 3.1 Pro, Claude Sonnet/Opus 4.6, GPT-OSS 120B |
| **Context Window** | Often 200k fallback | **1,048,576 tokens (1.0M)** for Gemini 3 |
| **Reasoning Control** | ACP Options | Explicit flag `--effort <low\|medium\|high>` |

---

## 2. Architectural Concept: The `AgyAcpAdapter` Bridge

### 2.1 The Bridge & Adapter Pattern
`grok-build-vscode` communicates with external AI agents using the standardized **Agent Client Protocol (ACP)** over `stdio`. Because `agy.exe` lacks a native `--acp` flag, the bridge component `AgyAcpAdapterServer` in `src/agy-acp-adapter.ts` translates in real time between the two protocols:

```
┌──────────────────────────────────────────────────────────────────┐
│                 VS Code Host (grok-build-vscode)                 │
│                 AcpClient (src/acp.ts)                           │
└────────────────────────────────┬─────────────────────────────────┘
                                 │
                   JSON-RPC 2.0 (ACP over stdio)
                                 │
┌────────────────────────────────▼─────────────────────────────────┐
│               AgyAcpAdapterServer (src/agy-acp-adapter.ts)       │
│                                                                  │
│  - ACP Handshake: initialize, session/new, session/load          │
│  - Clean session isolation & conversation lifecycle              │
│  - Dynamic workspace binding (--add-dir <cwd>)                   │
│  - Model and reasoning effort management (--model, --effort)     │
│  - Translation: session/prompt <-> NDJSON {"event":"user",...}   │
│  - Streaming: agent_response <-> session/update (text delta)     │
│  - Tool calls: step_type: tool <-> tool_call / tool_call_update  │
│  - Parameter normalization: PascalCase -> ACP standard keys      │
│  - Thinking token accounting (usage.thinking_tokens)             │
│  - Execution modes: yolo (--dangerously-skip-permissions), plan  │
└────────────────────────────────┬─────────────────────────────────┘
                                 │
                   NDJSON (stream-json over stdio)
                                 │
┌────────────────────────────────▼─────────────────────────────────┐
│                  Google Antigravity CLI                          │
│               (C:\...\.gemini\bin\agy.exe)                       │
└──────────────────────────────────────────────────────────────────┘
```

### 2.2 The Antigravity NDJSON Streaming Protocol
When launched with `--input-format stream-json --output-format stream-json`, `agy.exe` exchanges line-delimited JSON events over `stdio`:
1. **Initialization (`event: init`):**
   ```json
   {
     "event": "init",
     "conversation_id": "9f32bc14-77a8-4e12-b131-7bc92e67a012",
     "init": {
       "cwd": "C:\\my-project",
       "tools": ["run_command", "replace_file_content", "write_to_file", "view_file", "grep_search", "list_dir"],
       "permission_mode": "request-review"
     }
   }
   ```
2. **Streaming Step (`event: step_update`):**
   ```json
   {
     "event": "step_update",
     "step_update": {
       "step_index": 1,
       "state": "DONE",
       "step_type": "agent_response",
       "text_delta": "Analyzing project structure...\n",
       "usage": { "input_tokens": 4200, "output_tokens": 45, "thinking_tokens": 30, "total_tokens": 4275 }
     }
   }
   ```
3. **Tool Execution (`event: step_update` with `step_type: tool`):**
   ```json
   {
     "event": "step_update",
     "step_update": {
       "step_index": 2,
       "state": "ACTIVE",
       "step_type": "tool",
       "tool_name": "run_command",
       "tool_info": { "parameters": { "CommandLine": "git status" } }
     }
   }
   ```
4. **Result (`event: result`):**
   ```json
   {
     "event": "result",
     "result": {
       "status": "SUCCESS",
       "usage": { "input_tokens": 4200, "output_tokens": 120, "thinking_tokens": 60, "total_tokens": 4380 }
     }
   }
   ```

### 2.3 Protocol Translation Matrix: ACP <-> NDJSON

| ACP JSON-RPC 2.0 | Antigravity NDJSON | Adapter Function |
| :--- | :--- | :--- |
| `initialize` | `agy.exe` process spawn | Reports capabilities (`loadSession: true`) |
| `session/new` | Fresh CLI process & reset | Terminates old process, resets `activeConversationId = undefined` |
| `session/load` | Session switch | Cleans up previous state, binds session |
| `session/prompt` | `{"event":"user","message":{...}}` | Writes prompt to `stdin` of `agy` |
| `session/update` | `text_delta` from `agent_response` | Streams text deltas to the VS Code webview |
| `tool_call` | `step_type: tool` (`ACTIVE`) | Renders interactive tool card in chat |
| `tool_call_update` | `step_type: tool` (`DONE`/`ERROR`) | Updates tool card with execution output |
| `usage_update` | `usage` from `step_update`/`result` | Updates donut indicator & thinking tokens |
| `set_config_option` | CLI flags (`--model`, `--effort`) | Manages model selection and reasoning depth |
| `set_mode` | `--dangerously-skip-permissions` / `--mode plan` | YOLO (auto-accept) or plan mode; mid-turn changes are deferred to next prompt |
| `session/cancel` | Process termination | Terminates `agy` and answers the prompt with `stopReason: "cancelled"` |
| `session/list` | Workspace-filtered session query | Returns persisted sessions from `grok-acp-conversations.json` & Antigravity SQLite (`conversation_summaries.db`) |
| `x.ai/exit_plan_mode` | Plan approval process | Intercepts `implementation_plan.md`, presents review card ("Approve & implement"), and switches to `agent` upon approval |
| `_x.ai/interject` | Live steering & feedback | Forwards mid-turn steering comments synchronously to `stdin` of `agy.exe` |
| `session/prompt` (images) | Native `view_file` reference & auto-staging in `~/.gemini/staging` | Bridges ACP image blocks over stream-json CLI limitations and stages files in `~/.gemini/staging` |

---

## 3. Detailed File and Component Overview

### 3.1 Backend & Protocol Adapter (TypeScript)

#### 1. `src/agy-acp-adapter.ts`
- Implements `AgyAcpAdapterServer`.
- Launches `agy.exe` with `--input-format stream-json --output-format stream-json --print-timeout 24h`.
- Dynamically passes `--add-dir <cwd>`, `--add-dir <stagingDir>`, `--model <id>`, `--effort <level>`, and execution modes (`--mode plan` or `--dangerously-skip-permissions`).
- **Session Isolation & Resumption:** Terminates previous processes upon `session/new`, stores `conversation_id` persistently, and resumes existing conversations with `--conversation <id>`.
- **Session Listing & Persistence (`session/list`):** Stores enhanced session metadata (`sessionId`, `conversationId`, `cwd`, `title`, `updatedAt`) in `~/.gemini/grok-acp-conversations.json`. Also reads existing native Antigravity sessions from `conversation_summaries.db`.
- **Transcript Replay (`replayTranscript`):** Reads the native transcript (`transcript.jsonl`) from the Antigravity brain directory on `session/load` and streams previous user and agent messages to restore full chat history in the webview.
- **Multimodal Image Context & Auto-Staging (`stagePromptImage` & `processPromptBlocks`):** Bridges the Antigravity stream-json limitation where `{ type: "image" }` is unsupported on standard input. Automatically stages pasted base64 images into `%USERPROFILE%\.gemini\staging\` (with automatic directory authorization via `--add-dir`), reuses existing disk paths (`knownPath`), strips conflicting Grok-specific "do not access this path" warnings, and provides Gemini with explicit instructions to use `view_file` on the local file path.
- **Plan Mode Interception:** `isImplementationPlanTool()` and `extractPlanText()` detect file modifications to `implementation_plan.md` or tools requesting feedback (`ArtifactMetadata.RequestFeedback: true`). Emits `sessionUpdate: "plan"` and sends an `x.ai/exit_plan_mode` RPC request with a unique UUID. Upon user approval, automatically transitions to `agent` mode.
- **Interjection Forwarding (`_x.ai/interject` / `x.ai/interject`):** Forwards mid-turn user steer input directly as JSON `{"event":"user","message":{...}}` to `stdin` of the running `agy` process.
- **Parameter Normalization:** `normalizeToolInput()` maps PascalCase keys from Antigravity (`CommandLine`, `TargetFile`, `AbsolutePath`, `DirectoryPath`, `Query`) into ACP standard keys (`command`, `file_path`, `directory`, `pattern`).

#### 2. `src/gemini-backend.ts`
- Implements the `AcpBackend` interface for provider `"gemini"`.
- Detects Antigravity via `isAntigravityCli(cliPath)`.
- Launches `agy-acp-adapter.js` as a Node child process with `ELECTRON_RUN_AS_NODE: "1"`, `AGY_PATH`, and `AGY_CWD`.
- Configures the context window of **1,048,576 tokens (1.0M)** for all Gemini 3 models via `contextWindowForModel()`.
- Normalizes token usage, permissions, and context window in `normalizeGeminiUpdate()`.
- Lists sessions via `listGeminiSessions()` and filters by current workspace root.

#### 3. `src/gemini-cli-locator.ts`
- Automatically discovers the Antigravity binary:
  1. Manual configuration `grok.geminiCliPath`
  2. System `PATH` (`agy.exe`, `agy`) via fast in-process checks
  3. `%USERPROFILE%\.gemini\bin\agy.exe` (standard installation location)
  4. Fallback to legacy paths (`gemini.exe`, `npm/gemini.cmd`)
- Helper `isAntigravityCli()` to distinguish between `agy` and legacy `gemini`.
- `hasAntigravityCredentials()` verifies that `oauth_creds.json` exists before reporting Gemini as connected.

#### 4. `src/gemini-model-cache.ts`
- Asynchronous background warmup for Antigravity models.
- Creates a temporary test session in a scratch directory, retrieves model configurations, and caches them for instant access.

#### 5. `src/acp.ts`
- Extends the core ACP `PromptContentBlock` type definition with optional `path?: string` on image blocks (`{ type: "image", data: string, mimeType: string, path?: string }`), preserving original disk locations across the client-adapter protocol boundary.

### 3.2 Host Integration & Context Handling

#### 1. `src/sidebar.ts`
- Registers `"gemini"` in `createProviderBackend()`.
- **Session Cache Integration:** Fully integrates `this.geminiSessionCache` in `buildSessionsList` and `adapterEntriesEligibleForClear`. Ensures Antigravity sessions appear properly in the sidebar session picker.
- **Subproject Link Resolution (`findInWorkspaceSubtree`):** Resolves relative file paths (e.g. `src/agy-acp-adapter.ts`) when working inside parent or multi-root workspaces (such as `GitHub-fetches/grok-build-vscode`), checking active editor paths, subproject folders containing `.git`/`package.json`, and other workspace roots.
- Manages session caches, token donut indicators, and YOLO mode state.
- **Precise Context Scoping:** `steerSend` (mid-turn steering) does **not** inject implicit editor chips (`implicitChips`) during tool loops, preventing token inflation.
- Standard `handleSend` attaches user-selected files and active editor files on the primary turn prompt.

#### 2. `src/media-serve.ts` & `media/file-panel.js`
- `resolveChatOpenFilePath`: Parses `file://` URIs generated by Antigravity markdown links (`file:///C:/...`), normalizes Windows drive letters, and decodes URI entities for opening files in the editor.
- **Subproject Resolution Fallback (`findInSubtree`):** Supports an optional `findInSubtree` callback hook, preserving the architectural invariant `workspaceRoots: [sessionCwd]` while allowing robust subproject fallbacks across nested project repositories.
- Supports embedded media files and project links.

#### 3. `src/prompt-builder.ts`
- Builds ACP prompt blocks from user input, file attachments (`FileChip`), and editor selections.
- Propagates `path: im.path` on image blocks so downstream adapters can directly inspect or stage original local files without re-encoding.
- Enforces truncation limits: `MAX_SELECTION_LINES = 400` and `MAX_SELECTION_CHARS = 20_000` to prevent token spikes.

### 3.3 Webview UI & Styling (JavaScript / SVG / CSS)

#### 1. `media/chat.js`
- High-resolution Gemini spark logo in `PROVIDER_LOGO_PATHS`.
- Displays the correct **1.0M Context Window** in the chat header.
- **Markdown Link Handler:** Intercepts clicks on `file://` URIs and opens the target file directly in VS Code via `openFile`.
- **Markdown Images:** Renders `![alt](src)` safely as `<img class="md-image" ... loading="lazy" />` with scheme protection.
- **GitHub Alerts & Blockquotes:** Parses `> [!NOTE]`, `> [!TIP]`, `> [!IMPORTANT]`, `> [!WARNING]`, and `> [!CAUTION]` into styled alert callouts with badge headers and alert bodies.
- Visualizes live tool cards (`Run git status`, `Edit file`, `Search`) with terminal output and status badges.
- Thinking token visualization during model reasoning.

#### 2. `media/chat.css`
- Styling rules for `.md-image`, `blockquote`, and `.md-alert` (with colors and borders for all 5 alert types).

#### 3. `media/settings.js` & `media/projects-rail.js`
- Full configuration rows for Gemini (model, status, connect/disconnect).
- Displays installed CLI version (`agy v1.1.26`).
- Provider icons in the project navigation rail.

### 3.4 Configuration & Typing

#### 1. `package.json`
- Configuration key:
  ```json
  "grok.geminiCliPath": {
    "type": "string",
    "default": "",
    "description": "Path to the Google Antigravity CLI (`agy.exe`) or Gemini CLI (`gemini`). Empty = auto-discover on PATH and ~/.gemini/bin."
  }
  ```

#### 2. `src/acp-backend.ts`, `src/protocol.ts`, `src/telemetry.ts`
- Full inclusion of `"gemini"` in Zod schemas, IPC message protocols, and telemetry events.

---

## 4. Complete Model Specification (14 Models & Gemini 3 Family)

### 4.1 Table of Available Antigravity Models

Antigravity provides **14 model configurations** dynamically through the `agy` CLI:

| Model ID in `agy` | Display Name in VS Code | Reasoning Effort | Context Window | Output Limit | Primary Purpose |
|:---|:---|:---:|:---:|:---:|:---|
| **`gemini-3.8-flash`** | **Gemini 3.8 Flash** | Low, Medium, High | **1,048,576 tokens (1.0M)** | 65,536 tokens | **Google Flagship:** Autonomous agentic workflows, long-horizon coding |
| **`gemini-3.7-flash`** | **Gemini 3.7 Flash** | Low, Medium, High | **1,048,576 tokens (1.0M)** | 65,536 tokens | High-speed multimodal reasoning, deep code review |
| **`gemini-3.6-flash`** | **Gemini 3.6 Flash** | Low, Medium, High | **1,048,576 tokens (1.0M)** | 65,536 tokens | Balanced performance and economical token usage |
| **`gemini-3.1-pro`** | **Gemini 3.1 Pro** | Low, High | **1,048,576 tokens (1.0M)** | 65,536 tokens | Deep mathematical and algorithmic logic |
| **`claude-sonnet-4-6`** | **Claude Sonnet 4.6 (Thinking)**| Thinking | 200,000 tokens | 64,000 tokens | Anthropic frontier reasoning via Antigravity account |
| **`claude-opus-4-6-thinking`**| **Claude Opus 4.6 (Thinking)**| Thinking | 200,000 tokens | 64,000 tokens | Deep holistic system and architectural design |
| **`gpt-oss-120b-medium`** | **GPT-OSS 120B (Medium)** | Medium | 131,072 tokens | 16,384 tokens | Capable open-weight model |
| *Dynamic Variants* | *(e.g. gemini-3.8-flash-high)* | By suffix | 1,048,576 tokens | 65,536 tokens | Supported via internal parser |

### 4.2 Model Discovery: Static, Not Dynamic

Running `agy models` (1.1.26) outputs **14 entries** where the reasoning tier is embedded in the model name:
```
gemini-3.8-flash-high / -medium / -low      Gemini 3.8 Flash (High/Medium/Low)
gemini-3.7-flash-high / -medium / -low      Gemini 3.7 Flash (…)
gemini-3.6-flash-high / -medium / -low      Gemini 3.6 Flash (…)
gemini-3.1-pro-high / -low                  Gemini 3.1 Pro (…)
claude-sonnet-4-6                           Claude Sonnet 4.6 (Thinking)
claude-opus-4-6-thinking                    Claude Opus 4.6 (Thinking)
gpt-oss-120b-medium                         GPT-OSS 120B (Medium)
```

The extension exposes **base IDs** plus a separate effort picker. This matches how ACP models reasoning effort and aligns with `agy` resolving `--model <base> --effort <level>`.

The adapter answers `session/new`, `session/load`, and `getConfigOptions()` from `DEFAULT_GEMINI_MODELS` in `src/gemini-backend.ts`.

Key implications:
- Models no longer offered by Antigravity would only be detected upon the first turn.
- The model list does not guarantee an active login. Therefore, `warmConnectedGeminiModels` checks credentials (`hasAntigravityCredentials` in `src/gemini-cli-locator.ts`) rather than reporting every installation as connected.

### 4.3 Reasoning Effort: The Measured Contract

Empirically verified against `agy.exe` 1.1.26: a model ID either carries its reasoning level in its suffix **or** requires exactly one `--effort` flag—never both, and never neither:

| Invocation | Result |
| :--- | :--- |
| `--model gemini-3.8-flash` | **Error:** `requires --effort (available: low, medium, high)` |
| `--model gemini-3.8-flash --effort high` | ok |
| `--model gemini-3.8-flash-low` | ok |
| `--model gpt-oss-120b-medium` | ok |
| `--model gpt-oss-120b-medium --effort high` | **Error:** `conflicts with --effort=high` |
| `--model claude-sonnet-4-6 --effort high` | **Error:** `--effort is not supported for model` |
| `--model totally-bogus-model` | **Error:** `not recognized as a known model` |

This establishes two rules:
1. **Models without effort parameters must not receive `--effort`.** Models such as `claude-sonnet-4-6`, `claude-opus-4-6-thinking`, and `gpt-oss-120b-medium` fail at startup if `--effort` is passed. The adapter checks `modelRequiresEffort()` and omits the flag for these models.
2. **"Default" cannot mean omitting the flag.** For Gemini models, omitting `--effort` produces an error. "Default" resolves to `DEFAULT_AGY_EFFORT` = **`medium`**.

Explicitly selected effort levels are passed through unchanged.

---

## 5. Runtime Milestones & Practical Solutions

### 5.1 Context Window Correction (1.0M instead of 200k)
- **Problem:** Chat UI previously displayed a 200k token context window for all Gemini models.
- **Solution:** Implemented `contextWindowForModel(modelId)` in `src/gemini-backend.ts`, setting `_meta.totalContextTokens: 1048576` and reporting it via `normalizeGeminiUpdate`.

### 5.2 Live Tool-Calling Streaming (Step Progress & Terminal Output)
- **Problem:** While Antigravity executed file edits or commands, the UI only displayed "Thinking...", hiding individual steps.
- **Solution:** Added event handler in `src/agy-acp-adapter.ts` for `step.step_type === "tool"`. Maps `ACTIVE` to `tool_call` (`in_progress`) and `DONE`/`ERROR` to `tool_call_update` (`completed`/`failed`).

### 5.3 Workspace Binding (`--add-dir <cwd>`)
- **Problem:** Antigravity created files in its scratch folder `~/.gemini/antigravity-cli/scratch` instead of the VS Code project workspace.
- **Solution:** Updated `src/agy-acp-adapter.ts` to track `this.cwd` dynamically and pass `--add-dir <cwd>` when spawning the CLI.

### 5.4 Tool Label & Parameter Normalization (`Run git status`)
- **Problem:** Command executions were displayed only as `"Run"` and file reads as `"Read"`.
- **Solution:** `normalizeToolInput()` maps PascalCase keys (`CommandLine`, `AbsolutePath`, `TargetFile`) to ACP standard attributes (`command`, `file_path`), rendering descriptive labels like `Run git status` or `Read pom.xml`.

### 5.5 Extension Startup & Packaging Repair (VSIX `node_modules`)
- **Problem:** After building VSIX, the sidebar froze in an infinite loading spinner.
- **Solution:** Removed unintended `--no-dependencies` flag during packaging. All 650 production modules (8.04 MB) are bundled and load properly.

### 5.6 Markdown Embedding & Link Handling (`file://`, Images, GitHub Alerts)
- **Problem:** Antigravity uses markdown elements such as `[file](file:///C:/path/to/file#L10-L20)`, embedded images `![alt](path)`, and GitHub-flavored alerts (`> [!NOTE]`, `> [!TIP]`, `> [!IMPORTANT]`, `> [!WARNING]`, `> [!CAUTION]`). Clicking `file://` links previously treated them as web URLs, images rendered as plain text, and alerts were unformatted.
- **Solution:**
  - **Link Handling (`media/chat.js`):** Intercepts `file://` URIs, normalizes Windows drive letters (`file:///C:/...` -> `C:/...`), decodes characters, and dispatches `openFile`.
  - **Image Rendering (`media/chat.js` & `media/chat.css`):** Parses `![alt](src)` into `<img class="md-image" src="..." alt="..." loading="lazy" />` while blocking unsafe URI schemes.
  - **GitHub Alerts (`media/chat.js` & `media/chat.css`):** Formats alert blockquotes with badge headers, background colors, and distinct borders.
  - **File Panel & Media Serve (`src/media-serve.ts`, `media/file-panel.js`):** `resolveChatOpenFilePath` decodes `file://` URIs transparently.

### 5.7 Plan Mode & Implementation Plan Review Workflow (`x.ai/exit_plan_mode`)
- **Problem:** When in plan mode, Antigravity generates `implementation_plan.md` or calls tools with `ArtifactMetadata.RequestFeedback: true`. The adapter previously did not expose this to the client, leaving sessions stuck in plan mode without presenting the "Approve & implement" review card.
- **Solution:**
  - **Plan Detection (`src/agy-acp-adapter.ts`):** `isImplementationPlanTool()` identifies tool invocations writing to `implementation_plan.md` or specifying `RequestFeedback: true`.
  - **Plan Extraction (`extractPlanText`):** Extracts markdown from `CodeContent`, `ReplacementContent`, or reads the file directly from disk.
  - **Exit Plan Mode Request:** Once the tool step finishes, the adapter emits `sessionUpdate: "plan"` and sends an `x.ai/exit_plan_mode` JSON-RPC request to the client.
  - **Automatic Mode Transition:** When approved (`outcome === "approved"`), transitions to `currentModeId = "agent"`, emits `current_mode_update`, and marks the process for respawn (`respawnBeforeNextPrompt = true`).
  - **Interjection Forwarding (`_x.ai/interject`):** Forwards user comments during planning to `agy` standard input.

### 5.8 Session Persistence, Session Listing & Transcript Replay
- **Problem:** Antigravity sessions were previously not listed in the session picker; only Claude sessions and an empty "New session" appeared.
- **Root Causes:**
  1. `src/sidebar.ts` only referenced `codex` and `claude` in `buildSessionsList` and `adapterEntriesEligibleForClear`, omitting `this.geminiSessionCache`.
  2. `src/agy-acp-adapter.ts` returned `{ sessions: [] }` on `session/list` and stored only simple `sessionId -> conversationId` mappings without titles, `cwd`, or timestamps.
- **Solution:**
  - **Sidebar Integration (`src/sidebar.ts`):** Added `this.geminiSessionCache` to `buildSessionsList` and `adapterEntriesEligibleForClear`.
  - **Metadata Storage (`src/agy-acp-adapter.ts`):** Stores `sessionId`, `conversationId`, `cwd`, cleaned `title` (via `cleanPromptTitle()`), and `updatedAt` in `~/.gemini/grok-acp-conversations.json`.
  - **Workspace Filtering (`session/list`):** `listStoredSessions(targetCwd)` filters sessions by the active workspace directory and sorts descending by timestamp.
  - **Native SQLite Integration:** Queries existing sessions from `~/.gemini/antigravity-cli/conversation_summaries.db` using Node's SQLite module so external sessions are visible.
  - **Transcript Replay (`replayTranscript`):** On `session/load`, reads `transcript.jsonl` from the Antigravity brain directory and streams previous turns as `user_message_chunk` and `agent_message_chunk`.

### 5.9 Mode Control (`agent`, `plan`, `yolo`) & Headless Permissions Contract
- **Modes:**
  - **`agent` (Default):** Standard execution mode. Because `agy.exe` runs headlessly over stdio pipes with `--input-format stream-json`, it lacks an interactive TTY for terminal confirmations and does not support an external permission-prompt protocol over stream-json. The adapter passes `--dangerously-skip-permissions` to the child process so tools do not abort with `"permission check failed ... user denied permission to run command"`. Tool cards and execution progress are streamed in real time to the VS Code webview.
  - **`plan`:** Launches with `--mode plan` and `--dangerously-skip-permissions`. In this mode, `agy.exe` restricts itself to research, exploration (e.g. read-only commands like `git status`, file reads, directory listings), and creating `implementation_plan.md`. The adapter intercepts the plan creation and emits an `x.ai/exit_plan_mode` request, presenting the user with an "Approve & implement" review card in the chat UI.
  - **`yolo`:** Full autonomous tool execution without interactive stops.
- **CLI Verification:** `agy.exe` validates `--mode` strictly, confirming adapter flags match the binary interface.

### 5.10 Elimination of Flashing Console Windows (`windowsHide` & In-Process PATH Lookup)
- **Problem:** On Windows, the first request to Gemini caused a black console/terminal window (`conhost.exe`) to flash on screen for ~250 ms, briefly displaying an error message.
- **Root Cause Analysis:**
  1. **Missing `windowsHide: true` on `execSync`:** During cold start when the CLI path was not yet cached, `locateGeminiCli()` called `defaultWhich("agy.exe")`, executing `where.exe` via `execSync`. Without `windowsHide: true`, Windows spawns a visible console window.
  2. **The "Error" Message:** When searching for non-existent filenames (e.g. `where agy.cmd` or unchecked providers like `where codex.exe`), `where.exe` prints `INFO: Could not find files for the given pattern(s).` with exit code 1. This was the text visible in the flashing window.
  3. **Missing `windowsHide: true` on Spawn:** Neither `AcpClient` (`src/acp.ts`) nor `AgyAcpAdapterServer` (`src/agy-acp-adapter.ts`) specified `windowsHide: true` during child process spawn.
- **Solution:**
  - **In-Process PATH Inspection:** `gemini-cli-locator.ts`, `codex-cli-locator.ts`, `claude-cli-locator.ts`, and `cli-locator.ts` first inspect directories in `process.env.PATH` directly using `existsSync()` and `statSync()`. This completes in <0.1 ms without launching child processes.
  - **`windowsHide: true` & `stdio: ignore` Fallback:** If `execSync` is needed as a fallback, it specifies `windowsHide: true` and `stdio: ["pipe", "pipe", "ignore"]`.
  - **Child Process Spawn:** Both `src/agy-acp-adapter.ts` and `src/acp.ts` set `windowsHide: true` in `spawn()`.

### 5.11 Multimodal Vision & Image Context Architecture (Stream-JSON Image Limitation & `view_file` Bridge)

- **The Problem (Image & Visual Context Ingestion Failure):**
  When a user attached, pasted, or dropped an image (such as an IDE screenshot or UI mockup) into the chat while interacting with Gemini/Antigravity, the model was completely unable to inspect or understand the image.
  Instead, as observed in diagnostic logs and live chats, the model entered a repetitive loop executing PowerShell search commands trying to locate the image by file pattern:
  ```powershell
  Get-ChildItem -Path C:\Users\...\.gemini\antigravity-cli -Filter *image-248575c2* -Recurse -File -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName
  ```
  These searches failed because the image had not been saved in that directory. The model wasted reasoning turns and token budget, apologized to the user, and failed to answer the visual coding question.

- **Root Cause Analysis:**
  A deep-dive CLI probe (`scratch/test-agy-stream.js` and `scratch/test-agy-view-image.js`) revealed three compound factors:
  1. **Antigravity CLI Stream-JSON Limitation:**
     When sending standard ACP image content blocks (`{ type: "image", data: "...", mimeType: "image/png" }`) over `agy.exe --input-format stream-json`, the Antigravity CLI process immediately fails with an explicit error:
     ```text
     stream input content block type "image" is not supported (only "text")
     ```
     Unlike Claude ACP or Grok, Google Antigravity's CLI streaming protocol currently only accepts text blocks on `stdin`.
  2. **Antigravity Native Multimodal Ingestion Mechanism:**
     Empirical testing against `agy.exe` confirmed that Antigravity ingests images into Gemini's multimodal window via its native tool `view_file`:
     ```json
     { "tool_name": "view_file", "parameters": { "AbsolutePath": "C:\\path\\to\\image.png" } }
     ```
     When called on an image file, `view_file` natively reads and feeds the binary image data to Gemini 3.8/3.7 Flash Pro multimodal vision context.
  3. **Legacy Grok Prompt Tag Incompatibility:**
     `prompt-builder.ts` was historically tailored for xAI Grok (which supported inline vision blocks in its CLI and whose file-reading tool crashed on binaries). Grok's prompt builder deliberately emitted a warning in the prompt text:
     ```text
     [Image #1] (image-248575c2.png — local staged copy; thumbnail only; do not access this path)
     ```
     When passed to Antigravity without inline image blocks, this instruction was disastrous: it stripped the image, told Antigravity that a file existed somewhere, but explicitly warned it *"do not access this path"*, provoking the model into guessing and running PowerShell searches for the thumbnail.

- **Architectural Solution:**
  1. **ACP Image Block Origin Preservation (`src/acp.ts` & `src/prompt-builder.ts`):**
     Extended `PromptContentBlock` for image blocks to retain an optional `path?: string` property:
     ```typescript
     export type PromptContentBlock =
       | { type: "text"; text: string }
       | { type: "image"; data: string; mimeType: string; path?: string }
       | { type: "resource"; resource: unknown };
     ```
     `src/prompt-builder.ts` now propagates `path: im.path` when building prompt blocks from attached images.
  2. **Image Auto-Staging (`stagePromptImage` in `src/agy-acp-adapter.ts`):**
     When an image is received without an existing disk path (e.g. pasted from clipboard as raw base64):
     - The adapter writes the binary buffer into a dedicated user staging folder: `%USERPROFILE%\.gemini\staging\agy-img-<hash>.<ext>`.
     - Ensures the directory exists and handles errors gracefully.
  3. **Automatic Workspace & Staging Directory Authorization:**
     During process spawn in `ensureAgyProc()`, the adapter adds `--add-dir <stagingDir>` in addition to `--add-dir <cwd>`. This grants `agy.exe` explicit tool access to read staged images without triggering security permission blocks.
  4. **Prompt Transformation & Conflict Stripping (`processPromptBlocks` in `src/agy-acp-adapter.ts`):**
     Before streaming the prompt to `agy`:
     - Any conflicting legacy warnings (`-- local staged copy; thumbnail only; do not access this path`) are stripped from text blocks.
     - Each image block is converted into a clear, actionable instruction for Antigravity:
       ```text
       [Attached Image #1: Local file located at "C:\Users\...\.gemini\staging\agy-img-....png". Please use the view_file tool on this path to inspect the image content.]
       ```

- **Outcome:**
  Gemini 3.8 / 3.7 now immediately invokes `view_file` on the staged image path upon receiving the prompt, receives full multimodal visual context, and answers screenshot-based queries accurately without entering PowerShell search loops.

### 5.12 Resilient Relative File Path Resolution (Subproject Discovery & `findInSubtree` Fallback)

- **The Problem (Broken Relative Links in Chat):**
  When users clicked file paths referenced in chat responses (e.g. `src/agy-acp-adapter.ts`), VS Code displayed an error toast:
  ```text
  The editor could not be opened because the file was not found:
  c:\Users\zfzfg\Documents\HammerMegaProjekte\GitHub-fetches\src\agy-acp-adapter.ts
  ```
  The file was not found because the VS Code workspace root was opened at `GitHub-fetches`, but the actual git project repository was located in the subfolder `GitHub-fetches/grok-build-vscode`.

- **Root Cause Analysis:**
  1. **Workspace Root vs. Repository Subtree:**
     Developers frequently open parent directories or multi-repository root folders. When an agent runs inside a session or mentions a relative path from the repository root (e.g. `src/agy-acp-adapter.ts`), `resolveChatOpenFilePath` resolved relative paths against `workspaceRoots: [this.sessionCwd(session)]`. If `sessionCwd` pointed to `GitHub-fetches`, joining the relative path produced `GitHub-fetches\src\agy-acp-adapter.ts`, which did not exist on disk.
  2. **Preserving Architectural Test Invariant:**
     `test/media-serve-open.test.ts` line 551 has a strict architectural assertion:
     ```typescript
     expect(body).toMatch(/workspaceRoots:\s*\[\s*this\.sessionCwd\(session\)\s*\]/);
     ```
     Simply swapping or replacing `workspaceRoots` in `src/sidebar.ts` would violate this test invariant.

- **Architectural Solution:**
  1. **Extensible Subproject Hook (`src/media-serve.ts`):**
     Added an optional callback `findInSubtree` to `ResolveChatOpenFilePathOpts`:
     ```typescript
     export interface ResolveChatOpenFilePathOpts {
       workspaceRoots?: string[];
       fileExists?: (p: string) => boolean;
       findInSubtree?: (root: string, relPath: string) => string | undefined;
     }
     ```
     If direct candidates (`path.resolve(root, candidate)`) do not exist, `resolveChatOpenFilePath` invokes `opts.findInSubtree(root, candidate)` across each workspace root.
  2. **Smart Subproject Discovery (`src/sidebar.ts`):**
     Implemented `findInWorkspaceSubtree(root, relPath)`:
     - **Active Editor Heuristic:** If the developer has an open file in the editor (e.g. `grok-build-vscode/src/foo.ts`), it checks if that file's enclosing subproject contains the target relative path.
     - **Subproject Root Inspection:** Scans immediate subfolders of `root` that contain project markers (`.git` or `package.json`). If `<root>/<subproject>/<relPath>` exists, it returns the resolved path.
     - **Multi-Folder Workspace Fallback:** Checks other configured `vscode.workspace.workspaceFolders`.
  3. **Sidebar Wire-Up:**
     `sidebar.ts` passes `findInSubtree: (root, rel) => this.findInWorkspaceSubtree(root, rel)` in `resolveChatOpenPath()`, while maintaining `workspaceRoots: [this.sessionCwd(session)]` exactly as required by the test contract.

- **Outcome:**
  Relative file links in chat notifications now resolve seamlessly across parent folders and nested repositories, opening the target file in the VS Code editor immediately without error toasts.

---

## 6. Token & Session Limits: Root Causes and Fixes

### 6.1 What Actually Drove Token Consumption

Sessions in `grok-build-vscode` previously reached token and session limits faster than in standalone tools. Root causes identified:

1. **Stop Did Not Stop `agy`:** The adapter lacked a `session/cancel` handler. ACP sends cancel as an ID-less notification; it fell into the `default:` branch and was ignored. The stop button and idle timeouts stopped only client-side, while `agy.exe` continued running under `--print-timeout 24h`, consuming quota in the background.
2. **`--effort` Was Hardcoded to `high`:** Always set to `high`, even on "Default" and for models without reasoning support. Every turn engaged maximum reasoning effort.
3. **Reopened Conversations Had No Agent Context:** `session/load` reset `activeConversationId` without loading saved conversation IDs. The UI showed full history, but the agent was unaware of it, requiring users to re-explain context.
4. **Mid-Turn Config/Mode Changes Dropped Active Work:** `set_config_option` and `set_mode` called `killAgyProc()` immediately, aborting the in-flight prompt with "Session terminated or reset" and wasting billed tokens.
5. **Cross-Provider Factors (Also Affecting Claude):**
   - `grok.defaultEffort` was applied to new Claude/Gemini sessions as `session/set_config_option {effort}`.
   - Implicit editor chips persisted across turns, embedding entire files repeatedly without size bounds.
   - "Summarize & Restart" consumed two extra turns, including a full conversation pass.
   - Broad auth recovery rules re-sent entire prompts on billing or subscription notices.

**Excluded as causes:** Title generation (local string truncation), model warmup (`session/new` + `session/delete`, no inference), `/session-info`, history replay, and telemetry.

### 6.2 Evaluation of the Initial Isolation Fix

Commit `8568efb` resolved a legitimate issue—`session/new` inheriting `activeConversationId` within the same adapter instance—but had side effects:
- Each chat session normally receives its own `AcpClient` and adapter process, so cross-session leakage was rare in typical use.
- It caused conversation amnesia because `session/load` wiped `activeConversationId` without restoring it from persistent storage.
- In earlier revisions, `_x.ai/interject` was not handled by the adapter, preventing steer input from reaching `agy`. (This was subsequently resolved in v5.2.0 by implementing interjection forwarding).

### 6.3 Remediation in the Antigravity Adapter

Key changes in `src/agy-acp-adapter.ts`:

| Item | Implementation |
| :--- | :--- |
| **Clean Cancel** | Handled in `session/cancel` -> `cancelActiveTurn()`: terminates process, resolves prompt with `stopReason: "cancelled"`. |
| **Accurate Effort Flags** | Passes `--effort` only for models requiring it (`modelRequiresEffort`). Fixes startup failures for Claude and GPT-OSS models. |
| **Session Resumption** | Maps `acpSessionId -> conversation_id` in `~/.gemini/grok-acp-conversations.json`. Restores context on `session/load`. |
| **Deferred Respawn** | Config/mode changes call `requestRespawn()`. If a turn is running, respawn waits until completion. |
| **No Orphaned Requests** | Rejects a second `session/prompt` if a turn is already active rather than losing request IDs. |
| **Single Reply per Request** | Resolves via `pending.resolve` without sending duplicate JSON-RPC error frames. |
| **Proper `session/delete`** | Terminates child process and removes stored conversation metadata. |
| **Prevent Stderr Deadlocks** | Reads `agy` stderr line-by-line and logs with `[agy]` prefix. |
| **Usage Visibility** | Logs completed turns: `[agy] turn complete in=... out=... thinking=... total=...`. |
| **Interjection Handling** | Implements `_x.ai/interject` and forwards text to `agy` stdin as `{"event":"user","message":{...}}`. |

### 6.4 Cross-Provider Remediation (Claude, Gemini, Codex, Grok)

- **Per-Provider Reasoning Effort:** Added `grok.defaultEffortByProvider` setting; `grok.defaultEffort` remains fallback for Grok only.
- **Selection Bounding:** `MAX_SELECTION_LINES` (400) and `MAX_SELECTION_CHARS` (20,000) in `src/prompt-builder.ts`. Large selections reference line ranges rather than embedding full file contents.
- **Restart Dialog Defaults:** "Just Restart" is listed first, noting the two-turn cost of summarization.
- **Selective Auth Resend:** Re-sends prompts only on authentic credential errors, not billing/subscription limits.

---

## 7. Quality Assurance & Test Results

### 7.1 Dedicated Adapter Tests
`test/agy-acp-adapter.test.ts` contains **24 unit tests** covering:
- `session/new isolates sessions by terminating agy process and resetting conversation id`
- `session/load terminates existing process and resets activeConversationId`
- `continues the same conversation on the next turn` — validates `--conversation` flag on subsequent turns
- `session/load resumes the conversation that session owns, across adapter restarts`
- `session/cancel kills the CLI and answers the running prompt as cancelled`
- `a model switch during a running turn does not throw that turn away`
- `sends exactly as many --effort flags as the model accepts`
- `refuses a second prompt while one is still running`
- `correctly identifies implementation plan tools and extracts plan text`
- `handles implementation plan creation in plan mode, emits exit_plan_mode, and transitions to agent on approval`
- `handles _x.ai/interject and forwards message to agy stdin`
- `cleanPromptTitle parses and cleans titles correctly`
- `session/list returns stored sessions filtered by cwd and sorted by updatedAt`
- `session/prompt stores prompt title and updates timestamp`
- `session/load replays transcript notifications from disk`
- `session/prompt stages base64 image block into staging directory and instructs agy to view_file`
- `session/prompt uses knownPath for image block and strips conflicting do not access warnings`

Related test suites include `test/shared-markdown.dom.test.ts` (20 tests for links, images, alerts), `test/media-serve-open.test.ts` (**23 tests**, including fallback to `findInSubtree` for nested subproject repositories), `test/gemini-cli-locator.test.ts` (17 tests), and `test/gemini-backend.test.ts` (13 tests).

### 7.2 Entire Test Suite (`npm test`)

```bash
npx tsc -p . --noEmit
# Exit code 0 - zero TypeScript compilation errors

npx vitest run
# Test Files  211 passed (211)
#      Tests  4935 passed | 4 skipped (4939)
#   Duration  ~20s
```

All 211 test suites run without requiring external CLI binaries (`grok`, `agy`, or `claude`).

### 7.3 E2E Checklist in Visual Studio Code

1. **Stop:** Start a long-running Gemini turn, click Stop. Expected: no further tool cards, process ends, turn marked cancelled.
2. **Resumption:** Close chat, reload window, reopen chat, ask follow-up question. Expected: model responds with context retained.
3. **Mid-Turn Model Switch:** Expected: running turn completes; model switch takes effect on next turn.
4. **Effort:** Prompt with "Default". Expected: resolved to `medium` in spawn arguments.
5. **Selection:** Select a large file and send three short prompts. Expected: input tokens remain stable rather than compounding.
6. **Login Status:** Without `oauth_creds.json`, Gemini does not report "Connected".
7. **Markdown `file://` Links & Images:** Clicking generated `[file](file:///C:/path/file.ts)` links opens the file in editor. Images and alerts render correctly.
8. **Plan Mode ("Approve & implement"):** In Plan mode, writing `implementation_plan.md` triggers the review card. Clicking "Approve & implement" switches mode to Agent and executes.
9. **Session Listing & Replay:** Reopening VS Code displays stored sessions with titles and timestamps; loading replays full conversation history.
10. **Multimodal Vision & Image Attachments:** Attach or paste an image into chat. Expected: Image is staged to `~/.gemini/staging` (or local disk path preserved), conflicting legacy tags are stripped, and the prompt instructs Gemini to use `view_file`. Gemini calls `view_file` directly and explains image details without PowerShell search loops.
11. **Subproject Relative Link Navigation:** In multi-repo or parent directory workspaces, click a relative link in chat (e.g. `src/agy-acp-adapter.ts`). Expected: Resolves via `findInSubtree` to the active or nested project repository and opens immediately without "file not found" error toast.

---

### 7.4 Quota Test Bench: Stub, Bench, Live Probe, and Analysis

#### a) `node research/agy-quota-bench.cjs` — Mechanism Verification
Compares current adapter against prior baseline using `test/fixtures/fake-agy.cjs`:

| Metric | Baseline (`8568efb`) | Current |
| :--- | ---: | ---: |
| Stop: Tokens after click | 6,400 | **0** |
| Stop: Full turn tokens | 8,000 | **1,200** |
| Stop: Turn response | `end_turn` | `cancelled` |
| Effort "Default": Sent flag | `high` | `medium` |
| Effort "Default": Tokens/turn | 2,400 | 2,200 |
| Model without effort: Flag | `high` | **None** |
| Model without effort: Starts | **No (rejected by CLI)** | **Yes** |
| Mid-turn switch: Discarded tokens | 1,200–1,600 | **0** |
| Mid-turn switch: Outcome | `error: Session reset` | `end_turn` |
| Reopened chat context | Lost | **Preserved** |
| 3,000-line selection: Chars/message | 102,830 | **166** |

#### b) `node research/agy-live-probe.cjs` — Live Binary Probe
Tested against `%USERPROFILE%\.gemini\bin\agy.exe` (1.1.26):
- Turn completes as `end_turn` with accurate usage reporting.
- Follow-up turns retain context.
- Adapter restarts find stored `conversation_id`, spawning with `--conversation <id>` and preserving history.
- Stop mid-turn resolves as `cancelled` and terminates `agy`.
- Baseline system prompt and 57 tool schemas require ~6,600–15,000 input tokens per turn.

#### c) `node research/agy-live-ab.cjs 2` — Live A/B Comparison
Comparing three-turn scripts between baseline and current adapter:
```
Baseline: 73,432 tokens (458 thinking)   --effort high
Current:  73,336 tokens (377 thinking)   --effort medium
Delta:    0%
```
Effort level governs correctness (avoiding startup errors) rather than gross token consumption.

Breakdown across turns:

| Turn | Input Tokens | Output + Thinking |
| :--- | ---: | ---: |
| Turn 1 | 6,638 | 141 |
| Turn 2 | 21,555 | 259 |
| Turn 3 | 28,496 | 392 |

Full conversation history is billed on each turn (`cache_read_tokens` was 0). Primary savings arise from:
- **Stop:** Prevents 20,000–70,000 wasted tokens per cancelled turn.
- **Mid-Turn Model Changes:** Retains completed work.
- **Selection Bounding:** Prevents unbounded compounding across turns.
- **Model Support:** Enables models that previously failed to launch.

#### d) `node research/usage-report.cjs` — Session Usage Tracking
Aggregates usage logs (`[usage] ...` and `[agy] turn complete ...`) from the "Grok Build" output panel.

---

## 8. User and Developer Guide

### 8.1 For End Users
1. **Install Google Antigravity CLI:**
   ```powershell
   irm https://antigravity.google/cli/install.ps1 | iex
   ```
2. **Authenticate with Google:**
   ```powershell
   agy auth login
   ```
3. **Use in VS Code:**
   - Reload VS Code window (`Ctrl + Shift + P` -> `Developer: Reload Window`).
   - The extension discovers `agy.exe` under `%USERPROFILE%\.gemini\bin\agy.exe`.
   - Select **Gemini 3.8 Flash** (1.0M context window).
   - Adjust reasoning effort (`Low`, `Medium`, `High`) as desired.
   - Use the "+" button to start a fresh session.

### 8.2 For Developers (Build, Packaging, Tests)
- **Compile TypeScript:**
  ```bash
  npm run compile
  ```
- **Run Tests:**
  ```bash
  npx vitest run test/agy-acp-adapter.test.ts test/gemini-backend.test.ts
  ```
- **Package VSIX Extension:**
  ```bash
  npx @vscode/vsce package --readme-path README.marketplace.md
  ```
- **Install in VS Code:**
  ```powershell
  code --install-extension grok-vscode-phuryn-4.1.7.vsix --force
  ```

---

## 9. Universal Diff Support & Revert

This section summarizes the universal diff synthesis and single-edit revert architecture implemented across providers.

### 9.1 The Gap This Closes

Antigravity's own tool-call events carry only raw parameters (`TargetFile`,
`CodeContent`, `ReplacementContent`, …) — never an ACP `{type:"diff"}` block.
Before this work, that meant an `agy` edit rendered in chat as a bare
parameter card: no inline diff, no `+A −R` count, no `open diff →`, and (since
Antigravity runs no `session/request_permission`) no permission card either
to hang a diff off. Grok and Codex never had this problem — they emit native
diff blocks.

### 9.2 Diff Synthesis in the Antigravity Adapter

`src/agy-acp-adapter.ts` builds the missing block itself from **disk reads
alone**, before the update ever leaves the adapter process as ACP JSON —
never from the tool's own parameters. A live capture against real `agy`
(1.1.26) settled this: `tool_info.parameters` for `replace_file_content`
carried **only** `TargetFile` — no `TargetContent`, `ReplacementContent`,
`StartLine`, or `EndLine` at all, on either the `ACTIVE` or the `DONE`
step. Those richer fields genuinely exist, but only in Antigravity's own
persistent `transcript.jsonl` (a different, internal conversation log this
adapter never reads) — not on the live `stream-json` wire. Trusting them
produced a degenerate `oldText === newText === ""` diff (a "+0 −0" card,
confirmed live) even though the file visibly changed.

| Tool | Diff source |
|---|---|
| `write_to_file` | Whole-file disk read, before and after. |
| `replace_file_content` | Whole-file disk read, before and after — **not** `TargetContent`/`ReplacementContent` (see above). |
| `multi_replace_file_content` | Same as `replace_file_content`: one whole-file before/after diff, not a `_meta.details[]` per `ReplacementChunks[]` entry (those chunks are equally unconfirmed on the live wire). |
| `sed_file` | **Not synthesized.** Same reasoning, doubly so — its parameter shape has never been captured at all. |

All three land in `synthesizeAgyDiffContent`: the `ACTIVE` step reads disk
(the write hasn't landed yet) and remembers it per `toolCallId`; the `DONE`
step reads disk **again** — this is NOT a cache reuse like a single-read
scheme would suggest, since the "after" text doesn't exist until the write
actually completes. The tradeoff is a whole-file diff instead of a
positioned region/hunk (no gutter line numbers, no per-site `details[]`) —
strictly worse than a real region diff, but correct, which the
parameter-trusting version was not.

**Second live-confirmed gap, same session: agy's own `DONE` notification can
arrive before the write is actually on disk.** Two reads taken right at
`ACTIVE` and right at `DONE` came back byte-identical — same length, same
`mtime` — even though the model's own next tool call (a `git diff` moments
later) showed the change already applied. agy's step-lifecycle event and its
filesystem write are not synchronized. `waitForDiskChangeText` polls for up
to ~3s (20 × 150ms) for the content to actually differ from the `ACTIVE`
snapshot before giving up and using whatever the last read returned —
negligible against a multi-second turn, and the alternative (no poll) was a
confirmed-live "+0 −0" diff a second time, for a different reason than the
parameter gap above. This makes `synthesizeAgyDiffContent` (and the `ACTIVE`/
`DONE` tool notifications it feeds) async; the `DONE` notification for an
edit can now arrive up to ~3s later than the step itself, which the
webview's toolCallId-keyed, idempotent repaint tolerates fine.

**Third live-confirmed gap, same investigation: even the poll budget isn't
always enough.** A capture on a 33KB file showed the write still hadn't
landed after the full poll had elapsed — and the adapter's own "[agy] turn
complete" log line appeared before the poll's give-up log, meaning some
writes are deferred until the whole multi-turn-second reasoning turn
finishes, not just the individual tool step. `synthesizeAgyDiffContent`
queues any edit whose poll gave up (`pendingEditRecheck`); right before the
turn's `result` event resolves the pending prompt, `flushPendingEditRechecks`
does one more (non-polling) disk read per queued edit and, if it has landed
by then, sends a corrective `tool_call_update` for the same `toolCallId` —
the webview repaints it in place since the diff content differs from the
degenerate one it already rendered.

**A fourth wrinkle surfaced testing the third fix: `result` can arrive WHILE
a DONE-phase poll is still mid-flight**, before that edit has even reached
`pendingEditRecheck` — a synchronous `flushPendingEditRechecks` at that point
finds nothing queued yet. Every `synthesizeAgyDiffContent` call for a `DONE`/
`ERROR` step is now tracked in `pendingDiffPromises`; the `result` handler
`await`s all of them (`Promise.allSettled`) before flushing rechecks and
resolving the turn. This delays the `session/prompt` response by however long
the slowest still-running poll needs (worst case ~10s, see below) —
negligible against the turn itself, and the only way to guarantee the
recheck actually sees every edit that was mid-poll.

**A fifth, decisive data point: the write can lag even the fully-awaited
turn-complete signal by more than a minute.** After all four fixes above,
one edit's `equal=true` (no change detected) held even at the `result`-time
recheck — and a manual `git diff` run well after that same session showed
the edit HAD landed, just far later than any turn-scoped wait could
reasonably cover. **This confirmed the delay is not a race to close with a
bigger number — it is effectively unbounded on agy's side.**
`waitForDiskChangeText`'s budget was raised one more time to ~10s (50 ×
200ms, configurable via `diskPollAttempts`/`diskPollDelayMs` — tests inject a
tiny budget so this doesn't cost real suite time) as the last reasonable
increment, and the residual — a stale "+0 −0" card for an edit whose write
lands after that — is accepted as a known limitation rather than chased with
more timing logic. The reliable recovery path is reloading the conversation:
`session/load` replay reads `transcript.jsonl` directly, which (unlike the
live `stream-json` wire) genuinely carries `TargetContent`/
`ReplacementContent`, so a reload always recovers a correct diff regardless
of how long the write took.

**A sixth finding corrected the diagnosis behind the fifth: the write is not
actually slow.** Live testing (real agy, reported directly by the user)
showed the edit reflected in the editor **instantly**, both as an "edited"
indicator and in the file's visible content — contradicting the "write can
lag arbitrarily" framing above. The real mechanism: for a near-instant local
write, `ACTIVE` and `DONE` for the same tool step can both be emitted (and
read from stdout) **after** the file has already changed — there was never a
genuine "before" moment on the wire to read from at `ACTIVE` at all, for any
path the session had already touched. Reading disk at `ACTIVE` for the
*second* edit to a file just reads the *second* edit's own result on both
sides, which is indistinguishable from a slow write producing a degenerate
diff. `sessionFileBaseline` (a `Map<string, string>` living for the
adapter's whole process lifetime, not per-turn) fixes this: every edit's
`DONE` step seeds the map with its resulting content, and the *next* edit to
that same path uses the cached value as `oldText` instead of a live disk
read at `ACTIVE` — sidestepping the race entirely for every edit after the
first to a given path in a session.

**A seventh finding: session reload wiped `sessionFileBaseline` and Windows
path casing caused cache misses.** Reopening a conversation spawns a fresh
adapter process, starting with an empty `sessionFileBaseline`. The next edit
to a previously edited file reverted to an `ACTIVE` disk race. Furthermore,
Windows drive-letter casing (`C:\...` vs `c:/...`) and backslash vs forward
slash differences caused silent map lookup misses. This is solved by:
1. `normalizeBaselineKey(file, cwd)`: Normalizes slashes and lowercases on
   Windows (`win32`).
2. Seeding `sessionFileBaseline` on `session/load`: `replayTranscript`
   collects all touched files and seeds `sessionFileBaseline` from disk once
   replay completes.

**An eighth finding: authoritative live diff extraction directly from
`transcript_full.jsonl`.** Antigravity writes two logs in `.system_generated/logs`:
a token-truncated `transcript.jsonl` and a lossless `transcript_full.jsonl`.
At `DONE` phase in `synthesizeAgyDiffContent`, the adapter checks
`findRecentTranscriptToolCall`. When `agy` has flushed the completed step to
`transcript_full.jsonl`, the exact `TargetContent`, `ReplacementContent`, and
`StartLine` (parsed safely as integer) are extracted directly from the
transcript. This synthesizes a perfect positioned hunk diff with post-edit
gutter line numbers and automatically seeds `sessionFileBaseline` without
relying on filesystem polling.

**A ninth finding: unescaped quotes in truncated `transcript.jsonl`.**
When `transcript_full.jsonl` is not yet available, `findTranscriptPath` falls
back to `transcript.jsonl` (searching `~/.gemini/antigravity/brain` as well).
If truncated lines contain unescaped inner quotes, `unwrapTranscriptStrings`
falls back to regex stripping of outer quotes so `JSON.parse` syntax errors
do not drop diff reconstruction.

Claude (`src/claude-backend.ts`) and native `gemini --acp` (`src/gemini-backend.ts`,
the non-Antigravity path) get the same treatment in their normalizers, from
`old_string`/`new_string`/`file_path` or `file_path`/`content` — the common
Claude-style tool-call shape. A native diff block, once any of these CLIs
sends one, always wins (`mergeDiffIntoContent` is idempotent per path).

### 9.3 Single-Edit Revert & Sparse Lifecycle Updates

Every completed edit's tool row gets a **"revert edit ↶"** button next to
"open diff →" across all four providers (Grok, Codex, Antigravity, Claude).
There is deliberately **no** separate host-side snapshot store: the webview
already holds the diff block it rendered, and sends that same payload back on
revert. The host reconstructs the pre-edit whole file on demand by running
`expandDiffToWholeFile` (`src/diff-view.ts`) against the file's **current**
disk content with `diskIsBefore:false` — the exact reconstruction "open diff
→" already does, just run in reverse (`planEditRevert`). A pure creation
reverts by deleting the file (with a confirmation if its content has since
diverged from what the edit wrote); anything else that can't be located
byte-for-byte on disk anymore is refused as a conflict rather than guessed.

**Revert Conflict Fix in `expandAtSites` (`src/diff-view.ts`):**
During revert, `line = diskIsBefore ? site.oldLine : site.newLine`. For
non-line-neutral edits or edits without explicit `newLine`, `line` is
undefined. Previously, `findAtLine(haystack, needle, undefined)` failed and
aborted with `null`, reporting `"The file has changed since this edit and can't
be safely reverted."` even when the target text was present verbatim.
`expandAtSites` now falls back to `haystack.indexOf(needle)` when `line` is
omitted or not found at the expected line, allowing clean reverts.

**Claude & Provider-Agnostic Sparse Lifecycle Updates (`media/chat.js` & `src/claude-backend.ts`):**
Claude's ACP adapter (`@agentclientprotocol/claude-agent-acp`) emits the
initial `tool_call` with arguments (`rawInput`), but with `status` undefined
or `in_progress` (diff renders, but no revert button). When execution
finishes, it emits a completed `tool_call_update` with `status: "completed"`,
but **omits both `content` and `rawInput`**.
- In `media/chat.js`: `applyToolDiffs(call)` now falls back to
  `item._call.content` and `item._call.rawInput` when `call.content` is
  absent. When transitioning to `completed`, `item._diffSig` repaints the
  detail region and attaches `buildRevertEditButton`.
- In `src/claude-backend.ts`: `ClaudeBackend` maintains `toolDiffsById`,
  caching synthesized diffs across updates and injecting them into sparse
  completed `tool_call_update` messages.

This gives all four providers seamless single-edit revert capability.

### 9.4 Known Limitations

- **`sed_file`** has no diff synthesis (§9.2).
- **Claude Write's "before" side** is always synthesized as `oldText:""` (a
  pure add) — a real disk read would need an async host hook the normalizer,
  deliberately synchronous, doesn't have. Corrected only if Claude later
  sends its own completed diff for the same path.
- **Native `gemini --acp`'s field names are unconfirmed** (`gemini-backend.ts`'s
  fallback assumes Claude's `old_string`/`new_string`/`file_path` shape;
  harmless if wrong, unverified if right) — and after § 9.2's agy capture,
  treat that as the LIKELY case, not the exception.
- **Revert is in-memory only for the current webview session** — there is no
  persisted undo history across a reload; once the diff block scrolls out of
  the transcript and the tab reloads, that edit's revert affordance is gone
  until the underlying `tool_call`/`tool_call_update` replays again.

