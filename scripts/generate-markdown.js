#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env --allow-net=opencode.ai --allow-run=yt-dlp --allow-sys=hostname

import { createOpenAICompatible } from "npm:@ai-sdk/openai-compatible@3.0.51";
import { generateText } from "npm:ai@7.0.105";
import { parseAllDocuments } from "npm:yaml@2.9.1";
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

const width = String(jobs.length).length;
let generated = 0;
let already = 0;
let skipped = 0;
let errors = 0;
let totalSeconds = 0;
let totalInput = 0;
let totalOutput = 0;
let totalCost = 0;
let costKnown = true;

for (const [index, job] of jobs.entries()) {
  const prefix = `[${String(index + 1).padStart(width)}/${jobs.length}]`;
  const name = `${job.base.slice(DIR.length + 1)}.md`;
  const md = `${job.base}.md`;

  const report = (status, note) =>
    console.error(
      `${prefix} ${status.padEnd(18)} ${name}${note ? ` ${note}` : ""}`,
    );

  if (await exists(md)) {
    already++;
    report("already generated");
    continue;
  }

  let note = "";
  if (!(await exists(job.vtt))) {
    if (await exists(job.marker)) {
      skipped++;
      report("skipped", "(no transcript)");
      continue;
    }

    const status = await downloadVtt(job.url, job.lang, job.vtt);
    if (status === "missing") {
      await writeMarker(job.marker, job.url);
      skipped++;
      report("skipped", "(no transcript)");
      continue;
    }
    if (status === "error") {
      errors++;
      report("error", "(transcript download failed, will retry on next run)");
      continue;
    }
    note = "(transcript downloaded)";
  }

  try {
    const transcript = vttToText(await Deno.readTextFile(job.vtt));
    const { body, usage, finishReason, elapsed } = await toMarkdown(
      job.title,
      transcript,
    );

    totalSeconds += elapsed;
    totalInput += usage?.inputTokens ?? 0;
    totalOutput += usage?.outputTokens ?? 0;
    const cost = estimateCost(usage);
    if (cost === null) costKnown = false;
    else totalCost += cost;
    const metrics = metricsLine(usage, elapsed, cost);

    if (finishReason !== "stop") {
      errors++;
      report("error", `(finishReason=${finishReason}: output truncated)`);
      console.error(`      ${metrics}`);
      continue;
    }

    await Deno.writeTextFile(md, `# ${job.title}\n\n${hardWrap(body)}\n`);
    generated++;
    report("generated", note);
    console.error(`      ${metrics}`);
  } catch (error) {
    errors++;
    report("error", `(${error.message})`);
  }
}

console.error(
  `summary: ${generated} generated, ${already} already generated, ${skipped} skipped, ${errors} error`,
);
console.error(
  `total: ${totalSeconds.toFixed(1)}s, ${totalInput} in / ${totalOutput} out${
    costKnown ? `, ~$${totalCost.toFixed(6)}` : ""
  }`,
);
