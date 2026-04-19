/**
 * types — wire-level shapes passed between the Chromium extension and
 * the native host.
 *
 * This file is the single source of truth for message shapes at the
 * native-messaging boundary. `native-host.js` consumes them via JSDoc
 * `@type {import("./src/types").*}` annotations so the existing JS
 * keeps its runtime while the type checker sees a proper contract.
 *
 * When you add / change a message:
 *   1. Update the discriminated union below.
 *   2. Update `native-host.js` to handle the new variant.
 *   3. Update the extension-side sender (`extension/src/messaging/native.js`)
 *      — TODO: share this file across both packages once we have a
 *      workspace.
 */

// ── Inbound (extension → host) ───────────────────────────────────────

export interface MaxQueryMessage {
  type: "max_query";
  id: string;
  /** Dynamic user text (tab info, memories, conversation tail, prompt). */
  prompt: string;
  /** Cached static system prompt (~5 min TTL on Anthropic side). */
  system?: string;
  /** Optional pasted images attached to this turn. */
  images?: InlineImage[];
  /** Override the default model (validated against a strict allowlist). */
  model?: string;
  /** Additional tool whitelist override. Rare. */
  allowedTools?: string[];
}

export interface MaxCancelMessage {
  type: "max_cancel";
  id: string;
}

export interface PingMessage {
  type: "ping";
  id: string;
}

export interface DiagMessage {
  type: "diag";
}

export interface CancelAllMessage {
  type: "cancel_all";
}

export interface LoadUserDataMessage {
  type: "load_user_data";
  id: string;
}

export interface SaveUserDataMessage {
  type: "save_user_data";
  id: string;
  /** Arbitrary user-controlled JSON. Host persists under ~/.config/claude-companion/. */
  data: unknown;
}

/**
 * Anything else — forwarded verbatim to the MCP server over TCP.
 * Typical examples: `tool_request`, `tool_response`.
 */
export interface ForwardedMessage {
  type: string;
  [key: string]: unknown;
}

export type InboundMessage =
  | MaxQueryMessage
  | MaxCancelMessage
  | PingMessage
  | DiagMessage
  | CancelAllMessage
  | LoadUserDataMessage
  | SaveUserDataMessage
  | ForwardedMessage;

// ── Outbound (host → extension) ──────────────────────────────────────

export interface ReadyMessage {
  type: "ready";
  claudeBin: string;
  ts: number;
  tcpPort: number;
}

export interface MaxEventMessage {
  type: "max_event";
  id: string;
  event: unknown; // claude CLI streams arbitrary JSON events
}

export interface MaxErrorMessage {
  type: "max_error";
  id: string;
  error: string;
}

export interface MaxDoneMessage {
  type: "max_done";
  id: string;
}

export interface PongMessage {
  type: "pong";
  id: string;
}

export interface ToolRequestMessage {
  type: "tool_request";
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export type OutboundMessage =
  | ReadyMessage
  | MaxEventMessage
  | MaxErrorMessage
  | MaxDoneMessage
  | PongMessage
  | ToolRequestMessage;

// ── Attached images ──────────────────────────────────────────────────

export interface InlineImage {
  /** base64-encoded image data (no data: URL prefix). */
  base64: string;
  /** MIME type — restricted at the host to image/(png|jpeg|jpg|webp|gif). */
  mediaType?: string;
}

// ── Config ────────────────────────────────────────────────────────────

/**
 * Shape of `~/.config/claude-companion/config.json`.
 * Written with mode 0o600; readable only by the user that installed.
 */
export interface HostConfig {
  /** Crypto-random 32-byte hex string for TCP authentication. */
  sharedSecret: string;
  /** Session identifier for per-instance routing. */
  sessionId: string;
  /** Unix epoch ms when the config was created. */
  createdAt?: number;
}
