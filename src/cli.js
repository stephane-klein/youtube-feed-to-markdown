#!/usr/bin/env node

import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { loadConfig, loadEnv, settingsFromConfig } from "./config.js";
import { runExtract } from "./extract-video-metadata.js";
import { runDownloadVtt } from "./download-vtt.js";
import { runGenerateMarkdown } from "./generate-markdown.js";
import { runMarkdownStats } from "./markdown-stats.js";

const { version } = createRequire(import.meta.url)("../package.json");

const SETTING_KEYS = [
  "model",
  "endpoint",
  "apiKey",
  "session",
  "concurrency",
  "ytdlpConcurrency",
  "retryDelays",
  "maxOutputTokens",
];

const handle = (run) => async (argv) => {
  try {
    await run(argv);
  } catch (error) {
    console.error(`error: ${error.message}`);
    process.exitCode = 1;
  }
};

const config = {
  describe: "Path to the YAML configuration file",
  type: "string",
  default: "youtube_to_markdown.yaml",
};

const project = (argv) => {
  const yaml = loadConfig(argv.config);
  const settings = { ...settingsFromConfig(yaml) };
  for (const key of SETTING_KEYS) {
    if (argv[key] !== undefined) settings[key] = argv[key];
  }
  const dir = resolve(dirname(argv.config), yaml.contents_path ?? "contents");
  return { path: argv.config, config: yaml, feed: yaml.feed ?? [], settings, dir };
};

yargs(hideBin(process.argv))
  .scriptName("youtube-to-markdown")
  .config(loadEnv())
  .option("config", config)
  .command(
    "extract-video-metadata",
    "Fetch the channel videos from YouTube into the configuration file",
    (yargs) =>
      yargs
        .option("force-dates", {
          describe: "Fetch every upload date again, ignoring the known ones",
          type: "boolean",
          default: false,
        }),
    handle(async (argv) => {
      const { path, config: yaml } = project(argv);
      await runExtract({ path, config: yaml, forceDates: argv.forceDates });
    }),
  )
  .command(
    "download-vtt",
    "Download the VTT transcripts of the marked videos",
    () => {},
    handle(async (argv) => {
      const { feed, dir } = project(argv);
      await runDownloadVtt({ feed, dir });
    }),
  )
  .command(
    "generate-markdown",
    "Turn the VTT transcripts into Markdown prose with an LLM",
    (yargs) =>
      yargs
        .option("model", {
          describe: "LLM model id (default: model_id in the configuration)",
          type: "string",
        })
        .option("endpoint", {
          describe: "OpenAI-compatible chat completions endpoint",
          type: "string",
        })
        .option("api-key", {
          describe: "API key (defaults to OPENAI_API_KEY)",
          type: "string",
        })
        .option("session", {
          describe: "Value of the X-OpenCode-Session header",
          type: "string",
        })
        .option("concurrency", {
          describe: "Maximum number of concurrent LLM calls (default: 6)",
          type: "number",
        })
        .option("ytdlp-concurrency", {
          describe: "Maximum number of concurrent transcript downloads (default: 2)",
          type: "number",
        })
        .option("retry-delays", {
          describe: "Comma-separated retry delays in seconds (default: 10,30,60)",
          type: "string",
        })
        .option("max-output-tokens", {
          describe: "Override the computed output token budget",
          type: "number",
        })
        .option("force", {
          describe: "Regenerate every Markdown file",
          type: "boolean",
          default: false,
        }),
    handle(async (argv) => {
      const { feed, settings, dir } = project(argv);
      await runGenerateMarkdown({ feed, ...settings, dir, force: argv.force });
    }),
  )
  .command(
    "markdown-stats",
    "Report global tokens, cost and time from the Markdown frontmatter",
    () => {},
    handle(async (argv) => {
      const { dir } = project(argv);
      await runMarkdownStats({ dir });
    }),
  )
  .demandCommand(1, "Use one of the available commands")
  .strictCommands()
  .recommendCommands()
  .version(version)
  .help()
  .parse();
