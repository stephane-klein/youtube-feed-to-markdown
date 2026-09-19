#!/usr/bin/env node

import { createRequire } from "node:module";
import { homedir } from "node:os";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { loadConfig, loadEnv } from "./config.js";
import { runExtract } from "./extract-video-metadata.js";
import { runDownloadVtt } from "./download-vtt.js";
import { runGenerateMarkdown } from "./generate-markdown.js";
import { runMarkdownStats } from "./markdown-stats.js";

const { version } = createRequire(import.meta.url)("../package.json");

const handle = (run) => async (argv) => {
  try {
    await run(argv);
  } catch (error) {
    console.error(`error: ${error.message}`);
    process.exitCode = 1;
  }
};

const feed = {
  describe: "Path to the feed YAML file",
  type: "string",
  default: "feed.yaml",
};

yargs(hideBin(process.argv))
  .scriptName("youtube-to-markdown")
  .config({
    ...loadConfig(`${homedir()}/.config/youtube-to-markdown/config.toml`),
    ...loadConfig("./youtube-to-markdown.toml"),
    ...loadEnv(),
  })
  .command(
    "extract-video-metadata",
    "Fetch the channel videos from YouTube into the feed",
    (yargs) =>
      yargs
        .option("feed", feed)
        .option("force-dates", {
          describe: "Fetch every upload date again, ignoring the known ones",
          type: "boolean",
          default: false,
        }),
    handle(runExtract),
  )
  .command(
    "download-vtt",
    "Download the VTT transcripts of the marked videos",
    (yargs) => yargs.option("feed", feed),
    handle(runDownloadVtt),
  )
  .command(
    "generate-markdown",
    "Turn the VTT transcripts into Markdown prose with an LLM",
    (yargs) =>
      yargs
        .option("feed", feed)
        .option("model", {
          describe: "LLM model id",
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
          describe: "Maximum number of concurrent LLM calls",
          type: "number",
          default: 6,
        })
        .option("ytdlp-concurrency", {
          describe: "Maximum number of concurrent transcript downloads",
          type: "number",
          default: 2,
        })
        .option("retry-delays", {
          describe: "Comma-separated retry delays in seconds",
          type: "string",
          default: "10,30,60",
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
    handle(runGenerateMarkdown),
  )
  .command(
    "markdown-stats",
    "Report global tokens, cost and time from the Markdown frontmatter",
    () => {},
    handle(runMarkdownStats),
  )
  .demandCommand(1, "Use one of the available commands")
  .strictCommands()
  .recommendCommands()
  .version(version)
  .help()
  .parse();
