import { existsSync, readFileSync } from "node:fs";
import { parse } from "smol-toml";

export function loadConfig(path) {
  if (!existsSync(path)) return {};
  return parse(readFileSync(path, "utf8"));
}

const ENV = {
  feed: "YT_TO_MD_FEED",
  model: "YT_TO_MD_MODEL_ID",
  endpoint: "YT_TO_MD_OPENAIAPI_ENDPOINT",
  apiKey: "YT_TO_MD_API_KEY",
  session: "YT_TO_MD_X_OPENCODE_SESSION",
  concurrency: "YT_TO_MD_CONCURRENCY",
  ytdlpConcurrency: "YT_TO_MD_YTDLP_CONCURRENCY",
  retryDelays: "YT_TO_MD_RETRY_DELAYS",
  maxOutputTokens: "YT_TO_MD_MAX_OUTPUT_TOKENS",
};

export function loadEnv(env = process.env) {
  return Object.fromEntries(
    Object.entries(ENV)
      .map(([key, name]) => [key, env[name]])
      .filter(([, value]) => value !== undefined),
  );
}

