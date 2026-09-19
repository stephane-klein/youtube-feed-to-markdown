#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env --allow-net=opencode.ai --allow-run=yt-dlp --allow-sys=hostname

import { createOpenAICompatible } from "npm:@ai-sdk/openai-compatible@3.0.51";
import { generateText } from "npm:ai@7.0.105";
import { parseAllDocuments } from "npm:yaml@2.9.1";
import { Listr, ListrLogger, ProcessOutput } from "npm:listr2@11.1.0";
import { DIR, downloadVtt, exists, videoJobs, writeMarker } from "./vtt.js";

const FEED = "feed.yaml";

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

const apiKey = Deno.env.get("OPENAI_API_KEY");
const modelId = Deno.env.get("OPENAIAPI_MODEL_ID");
const endpoint = Deno.env.get("OPENAIAPI_ENDPOINT");
const session = Deno.env.get("X_OPENCODE_SESSION");

if (!apiKey) throw new Error("OPENAI_API_KEY is not set");
if (!modelId) throw new Error("OPENAIAPI_MODEL_ID is not set");
if (!endpoint) throw new Error("OPENAIAPI_ENDPOINT is not set");

const llmConcurrency = Number(Deno.env.get("OPENAIAPI_CONCURRENCY") ?? 6);
const vttConcurrency = Number(Deno.env.get("YTDLP_CONCURRENCY") ?? 2);

const provider = createOpenAICompatible({
  name: "opencode",
  apiKey,
  baseURL: endpoint.replace(/\/chat\/completions\/?$/, ""),
  headers: session ? { "X-OpenCode-Session": session } : {},
});

const model = provider(modelId);

const WIDTH = 80;

const PRICES = {
  "mimo-v2.5": { input: 0.14, output: 0.28, cachedInput: 0.0028 }
};

function estimateCost(usage) {
  const price = PRICES[modelId];
  if (!price || !usage) return null;

  const details = usage.inputTokenDetails ?? {};
  const cached = details.cacheReadTokens ?? usage.cachedInputTokens ?? 0;
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

function outputBudget(transcript) {
  const override = Deno.env.get("OPENAIAPI_MAX_OUTPUT_TOKENS");
  if (override) return Number(override);

  const inputTokens = Math.ceil(transcript.length / 3.5);
  return Math.min(
    OUTPUT_CEILING,
    Math.max(OUTPUT_FLOOR, Math.ceil(inputTokens * OUTPUT_FACTOR)),
  );
}

function metricsLine(usage, elapsed, cost) {
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

async function toMarkdown(title, transcript) {
  const started = performance.now();
  const { text, usage, finishReason } = await generateText({
    model,
    system: SYSTEM,
    prompt: `Title: ${title}\n\nTranscript:\n${transcript}`,
    temperature: 0.2,
    maxOutputTokens: outputBudget(transcript),
  });
  const elapsed = (performance.now() - started) / 1000;

  const body = text
    .trim()
    .replace(/^```[a-z]*\n?/, "")
    .replace(/\n?```$/, "")
    .trim();

  return { body, usage, finishReason, elapsed };
}

await Deno.mkdir(DIR, { recursive: true });

const docs = parseAllDocuments(await Deno.readTextFile(FEED));
const jobs = [];

for (const doc of docs) {
  const data = doc.toJS() ?? {};
  for (const video of data.videos ?? []) {
    if (!video.generate_markdown) continue;
    jobs.push(...videoJobs(video));
  }
}

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

const pending = [];
for (const job of jobs) {
  if (await exists(`${job.base}.md`)) stats.already++;
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
      const name = `${job.base.slice(DIR.length + 1)}.md`;
      try {
        if (await exists(job.marker)) {
          stats.skipped++;
          task.output = `skipped (no transcript)  ${name}`;
          return;
        }

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
      const name = `${job.base.slice(DIR.length + 1)}.md`;
      const md = `${job.base}.md`;
      try {
        const transcript = vttToText(await Deno.readTextFile(job.vtt));
        const { body, usage, finishReason, elapsed } = await toMarkdown(
          job.title,
          transcript,
        );

        stats.totalSeconds += elapsed;
        stats.totalInput += usage?.inputTokens ?? 0;
        stats.totalOutput += usage?.outputTokens ?? 0;
        const cost = estimateCost(usage);
        if (cost === null) stats.costKnown = false;
        else stats.totalCost += cost;
        const metrics = metricsLine(usage, elapsed, cost);

        if (finishReason !== "stop") {
          stats.errors++;
          task.output = `error (finishReason=${finishReason})  ${name}`;
          return;
        }

        await Deno.writeTextFile(md, `# ${job.title}\n\n${hardWrap(body)}\n`);
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
