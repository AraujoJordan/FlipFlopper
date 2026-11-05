// Secret masking for what the conversation draws: API keys, tokens and passwords are
// shown with their first characters and `*` for the rest, so screen shares and
// screenshots don't leak them. Display only: copy actions and model input keep the
// original text. Pure, linear-time and idempotent (it runs on streaming text).
import { maskSecretsEnabled } from "./settings";

/** Keep the first `n` characters (at most a third of the value) and star the rest. */
const mask = (value: string, n = 8): string => {
  const kept = Math.min(n, Math.floor(value.length / 3));
  return value.slice(0, kept) + "*".repeat(value.length - kept);
};

const TOKENS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{20,}/g, // OpenAI / Anthropic style keys
  /\bgh[pousr]_[A-Za-z0-9]{30,}/g, // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{40,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack
  /\bAIza[0-9A-Za-z_-]{35}\b/g, // Google API key
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT
];

const PEM = /-----BEGIN ([A-Z ]*)PRIVATE KEY-----[\s\S]*?-----END \1PRIVATE KEY-----/g;
const URL_PASSWORD = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)([^\s@/]+)(@)/gi;
const BEARER = /\b(Bearer\s+)([A-Za-z0-9._~+/-]{20,}=*)/g;
// NAME=value / NAME: value / "name": "value" where the name ends in a secret-ish word.
const ASSIGNMENT = /\b([A-Za-z0-9_.-]*(?:API[_-]?KEY|SECRET|TOKEN|PASSWORD|PASSWD))(?![A-Za-z0-9])(["']?\s*[=:]\s*)(["']?)([^\s"'\\]{8,})/gi;

export function maskSecrets(text: string): string {
  if (text.length < 8) return text;
  let out = text.replace(PEM, "-----BEGIN $1PRIVATE KEY-----\n********\n-----END $1PRIVATE KEY-----");
  out = out.replace(URL_PASSWORD, (_m, head: string, password: string, at: string) => head + "*".repeat(Math.max(password.length, 3)) + at);
  for (const pattern of TOKENS) out = out.replace(pattern, (token) => mask(token));
  out = out.replace(BEARER, (_m, head: string, token: string) => head + mask(token));
  return out.replace(ASSIGNMENT, (match, name: string, sep: string, quote: string, value: string) =>
    // Already masked, placeholders and variable references are left alone.
    value.includes("*") || /^[$<{%(\[]/.test(value) || value.startsWith("process.env") ? match : name + sep + quote + mask(value, 4));
}

/** Mask for drawing, honoring the "Mask secrets" setting. */
export const maskForDisplay = (text: string): string => (maskSecretsEnabled() ? maskSecrets(text) : text);
