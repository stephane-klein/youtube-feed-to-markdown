import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative } from "node:path";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { APICallError, generateText } from "ai";
import { Listr, ListrLogger, ProcessOutput } from "listr2";
import { stringify } from "yaml";
import {
  DEFAULT_DIR,
  downloadVtt,
  exists,
  titleForLang,
  videoJobs,
  writeMarker,
} from "./vtt.js";

const SYSTEM = [
  "You convert a YouTube video transcript into clean, readable Markdown prose.",
  "- Write in the same language as the transcript.",
  "- Do not summarize and do not add facts that are not in the transcript.",
  "- Merge the fragmented cues into full sentences and paragraphs.",
  "- You may add section headings (##, ###) when the transcript clearly moves between topics.",
  "- Do not add a main title, it is provided separately.",
  "- Do not wrap the output in code fences.",
  "- Output only the Markdown body.",
].join("\n");

const WIDTH = 80;

const PRICES = {
  "mimo-v2.5": { input: 0.14, output: 0.28, cachedInput: 0.0028 }
};

function cachedInputTokens(usage) {
  const details = usage?.inputTokenDetails ?? {};
  return details.cacheReadTokens ?? usage?.cachedInputTokens ?? 0;
}

function estimateCost(modelId, usage) {
  const price = PRICES[modelId];
  if (!price || !usage) return null;

  const details = usage.inputTokenDetails ?? {};
  const cached = cachedInputTokens(usage);
  const input =
    details.noCacheTokens ?? Math.max((usage.inputTokens ?? 0) - cached, 0);

  return (
    (input / 1e6) * price.input +
    (cached / 1e6) * (price.cachedInput ?? 0) +
    ((usage.outputTokens ?? 0) / 1e6) * price.output
  );
}

const OUTPUT_FACTOR = 2;
const OUTPUT_FLOOR = 2048;
const OUTPUT_CEILING = 32768;

function outputBudget(transcript, override) {
  if (override !== undefined && override !== null && override !== "") {
    return Number(override);
  }

  const inputTokens = Math.ceil(transcript.length / 3.5);
  return Math.min(
    OUTPUT_CEILING,
    Math.max(OUTPUT_FLOOR, Math.ceil(inputTokens * OUTPUT_FACTOR)),
  );
}

function metricsLine(modelId, usage, elapsed, cost) {
  return [
    modelId,
    `llm ${elapsed.toFixed(1)}s`,
    usage
      ? `${usage.inputTokens ?? 0} in / ${usage.outputTokens ?? 0} out`
      : "usage ?",
    cost === null ? null : `~$${cost.toFixed(6)}`,
  ]
    .filter(Boolean)
    .join("  ");
}

function frontmatter(job, { modelId, usage, elapsed, cost, finishReason }) {
  const data = {
    source_url: job.url,
    video_title: titleForLang(job.titles, job.lang),
    generated_at: new Date().toISOString(),
    llm: {
      model: modelId,
      duration_seconds: Number(elapsed.toFixed(1)),
      input_tokens: usage?.inputTokens ?? null,
      cached_input_tokens: usage ? cachedInputTokens(usage) : null,
      output_tokens: usage?.outputTokens ?? null,
      estimated_cost_usd: cost === null ? null : Number(cost.toFixed(6)),
      finish_reason: finishReason,
    },
  };

  return `---\n${stringify(data, { lineWidth: 0 }).trimEnd()}\n---\n\n`;
}

const isHeading = (text) => /^#{1,6}\s/.test(text);

const isStructured = (text) =>
  text
    .split("\n")
    .some((line) => /^\s*(-|\*|\d+\.)\s/.test(line) || /^\s*\|/.test(line));

function wrapText(text) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";

  for (const word of words) {
    if (!line) {
      line = word;
    } else if (line.length + 1 + word.length <= WIDTH) {
      line += ` ${word}`;
    } else {
      lines.push(line);
      line = word;
    }
  }

  if (line) lines.push(line);
  return lines.join("\n");
}

function hardWrap(body) {
  return body
    .split(/\n{2,}/)
    .map((block) => {
      const text = block.trim();
      if (!text) return "";
      if (isHeading(text) || isStructured(text)) return text;
      return wrapText(text.replace(/\s*\n\s*/g, " "));
    })
    .join("\n\n");
}

function vttToText(vtt) {
  const lines = vtt
    .split(/\r?\n/)
    .map((line) => line.replace(/<[^>]*>/g, "").trim())
    .filter(
      (line) =>
        line &&
        !line.startsWith("WEBVTT") &&
        !line.startsWith("Kind:") &&
        !line.startsWith("Language:") &&
        !line.includes("-->") &&
        !/^\d+$/.test(line),
    );

  const out = [];
  for (const line of lines) {
    if (out[out.length - 1] !== line) out.push(line);
  }
  return out.join("\n");
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isRetryable(error) {
  return APICallError.isInstance(error) && error.isRetryable;
}

function retryDelayMs(error, fallbackMs) {
  const headers = APICallError.isInstance(error)
    ? error.responseHeaders
    : undefined;
  let headerMs;
  if (headers?.["retry-after-ms"] !== undefined) {
    headerMs = Number.parseFloat(headers["retry-after-ms"]);
  } else if (headers?.["retry-after"] !== undefined) {
    const seconds = Number.parseFloat(headers["retry-after"]);
    headerMs = Number.isNaN(seconds)
      ? Date.parse(headers["retry-after"]) - Date.now()
      : seconds * 1000;
  }

  if (!Number.isFinite(headerMs) || headerMs <= 0) return fallbackMs;
  return Math.max(headerMs, fallbackMs);
}

export function describeError(error, attempts) {
  const suffix = ` after ${attempts} attempt(s)`;
  if (!APICallError.isInstance(error)) return `${error.message}${suffix}`;

  const status = error.statusCode ? `HTTP ${error.statusCode}` : "API error";
  const body = error.responseBody?.trim().replace(/\s+/g, " ").slice(0, 200);
  return `${status} ${error.message}${suffix}${body ? `: ${body}` : ""}`;
}

function parseRetryDelays(value) {
  return `${value}`
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => Number(item) * 1000)
    .filter((item) => Number.isFinite(item) && item >= 0);
}

export function createModel({ modelId, endpoint, apiKey, session }) {
  const provider = createOpenAICompatible({
    name: "opencode",
    apiKey,
    baseURL: endpoint.replace(/\/chat\/completions\/?$/, ""),
    headers: session ? { "X-OpenCode-Session": session } : {},
  });
  return provider(modelId);
}

async function toMarkdown(
  { model, retryDelays, maxOutputTokens },
  title,
  transcript,
  onRetry,
) {
  const totalAttempts = retryDelays.length + 1;

  for (let attempt = 1;; attempt++) {
    const started = performance.now();
    try {
      const { text, usage, finishReason } = await generateText({
        model,
        system: SYSTEM,
        prompt: `Title: ${title}\n\nTranscript:\n${transcript}`,
        temperature: 0.2,
        maxOutputTokens: outputBudget(transcript, maxOutputTokens),
        maxRetries: 0,
      });
      const elapsed = (performance.now() - started) / 1000;

      const body = text
        .trim()
        .replace(/^```[a-z]*\n?/, "")
        .replace(/\n?```$/, "")
        .trim();

      return { body, usage, finishReason, elapsed };
    } catch (error) {
      if (!isRetryable(error) || attempt > retryDelays.length) {
        throw new Error(describeError(error, attempt), { cause: error });
      }
      const waitMs = retryDelayMs(error, retryDelays[attempt - 1]);
      onRetry?.(attempt + 1, totalAttempts, waitMs);
      await delay(waitMs);
    }
  }
}

async function forEachConcurrent(items, limit, worker) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const item = items[next++];
        await worker(item);
      }
    }),
  );
}

export async function runGenerateMarkdown({
  feed = [],
  model: modelId,
  endpoint,
  apiKey,
  session,
  concurrency = 6,
  ytdlpConcurrency = 2,
  retryDelays = "10,30,60",
  maxOutputTokens,
  force = false,
  dir = DEFAULT_DIR,
} = {}) {
  const key = apiKey ?? process.env.OPENAI_API_KEY;
  if (!key) throw new Error("api key is not set (--api-key or OPENAI_API_KEY)");
  if (!modelId) throw new Error("model is not set (--model)");
  if (!endpoint) throw new Error("endpoint is not set (--endpoint)");

  const RETRY_DELAYS = parseRetryDelays(retryDelays);
  const llmConcurrency = Number(concurrency);
  const vttConcurrency = Number(ytdlpConcurrency);

  const model = createModel({ modelId, endpoint, apiKey: key, session });

  await mkdir(dir, { recursive: true });

  const jobs = feed.flatMap((channel) =>
    (channel.videos ?? [])
      .filter((video) => video.generate_markdown)
      .flatMap((video) => videoJobs(video, dir, channel.folder_slug)),
  );

  console.error(`${jobs.length} markdown(s) to generate with ${modelId}`);

  const stats = {
    generated: 0,
    already: 0,
    skipped: 0,
    errors: 0,
    totalSeconds: 0,
    totalInput: 0,
    totalOutput: 0,
    totalCost: 0,
    costKnown: true,
  };

  const rendererOptions = {
    logger: new ListrLogger({
      processOutput: new ProcessOutput(process.stderr, process.stderr),
    }),
    showErrorMessage: true,
    collapseErrors: false,
    collapseSkips: false,
    icon: {
      SKIPPED: "–",
      SKIPPED_WITH_COLLAPSE: "–",
      SKIPPED_WITHOUT_COLLAPSE: "–",
    },
    color: {
      SKIPPED: (message) => message,
      SKIPPED_WITH_COLLAPSE: (message) => message,
      SKIPPED_WITHOUT_COLLAPSE: (message) => message,
    },
  };

  const phaseOptions = { outputBar: 20, persistentOutput: true };

  const pending = [];
  for (const job of jobs) {
    if (!force && (await exists(`${job.base}.md`))) stats.already++;
    else pending.push(job);
  }

  const downloadTask = {
    title: "Download transcripts",
    rendererOptions: phaseOptions,
    task: async (_ctx, task) => {
      const total = jobs.length;
      if (total === 0) {
        task.skip("no video");
        return;
      }

      const pendingSet = new Set(pending);
      let available = 0;
      const items = [];
      for (const job of jobs) {
        if (await exists(job.vtt)) {
          available++;
        } else if (pendingSet.has(job)) {
          items.push(job);
        }
      }
      task.title = `Download transcripts (${available}/${total})`;

      await forEachConcurrent(items, vttConcurrency, async (job) => {
        const name = relative(dir, `${job.base}.md`);
        try {
          if (await exists(job.marker)) {
            stats.skipped++;
            task.output = `skipped (no transcript)  ${name}`;
            return;
          }

          await mkdir(dirname(job.vtt), { recursive: true });
          const status = await downloadVtt(job.url, job.lang, job.vtt);
          if (status === "missing") {
            await writeMarker(job.marker, job.url);
            stats.skipped++;
            task.output = `skipped (no transcript)  ${name}`;
          } else if (status === "error") {
            stats.errors++;
            task.output = `error (download failed)  ${name}`;
          } else {
            available++;
            task.output = `downloaded  ${name}`;
          }
        } catch (error) {
          stats.errors++;
          task.output = `error (${error.message})  ${name}`;
        } finally {
          task.title = `Download transcripts (${available}/${total})`;
        }
      });
    },
  };

  const generateTask = {
    title: "Generate markdown",
    rendererOptions: phaseOptions,
    task: async (_ctx, task) => {
      const items = [];
      for (const job of pending) {
        if (await exists(job.vtt)) items.push(job);
      }
      if (items.length === 0) {
        task.skip("nothing to generate");
        return;
      }

      const already = stats.already > 0 ? `, ${stats.already} already` : "";
      task.title =
        `Generate markdown (${stats.already}/${jobs.length}${already})`;
      await forEachConcurrent(items, llmConcurrency, async (job) => {
        const md = `${job.base}.md`;
        const name = relative(dir, md);
        try {
          const transcript = vttToText(await readFile(job.vtt, "utf8"));
          const { body, usage, finishReason, elapsed } = await toMarkdown(
            { model, retryDelays: RETRY_DELAYS, maxOutputTokens },
            job.title,
            transcript,
            (nextAttempt, totalAttempts, waitMs) => {
              task.output = `retrying in ${Math.round(waitMs / 1000)}s ` +
                `(attempt ${nextAttempt}/${totalAttempts})  ${name}`;
            },
          );

          stats.totalSeconds += elapsed;
          stats.totalInput += usage?.inputTokens ?? 0;
          stats.totalOutput += usage?.outputTokens ?? 0;
          const cost = estimateCost(modelId, usage);
          if (cost === null) stats.costKnown = false;
          else stats.totalCost += cost;
          const metrics = metricsLine(modelId, usage, elapsed, cost);

          if (finishReason !== "stop") {
            stats.errors++;
            task.output = `error (finishReason=${finishReason})  ${name}`;
            return;
          }

          const front = frontmatter(job, {
            modelId,
            usage,
            elapsed,
            cost,
            finishReason,
          });
          await mkdir(dirname(md), { recursive: true });
          await writeFile(
            md,
            `${front}# ${job.title}\n\n${hardWrap(body)}\n`,
          );
          stats.generated++;
          task.output = `generated  ${name}  ${metrics}`;
        } catch (error) {
          stats.errors++;
          task.output = `error (${error.message})  ${name}`;
        } finally {
          const upToDate = stats.already + stats.generated;
          task.title = `Generate markdown (${upToDate}/${jobs.length}${already})`;
        }
      });
    },
  };

  await new Listr([downloadTask, generateTask], {
    exitOnError: false,
    rendererOptions,
    fallbackRenderer: "simple",
    fallbackRendererOptions: rendererOptions,
  }).run();

  console.error(
    `summary: ${stats.generated} generated, ${stats.already} already generated, ${stats.skipped} skipped, ${stats.errors} error`,
  );
  const seconds = stats.totalSeconds.toFixed(1);
  console.error(
    `total: ${seconds}s, ${stats.totalInput} in / ${stats.totalOutput} out${
      stats.costKnown ? `, ~$${stats.totalCost.toFixed(6)}` : ""
    }`,
  );
}
