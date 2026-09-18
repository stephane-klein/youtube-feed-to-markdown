#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env --allow-run=yt-dlp

import { parseAllDocuments } from "npm:yaml@2.9.1";

const FEED = "feed.yaml";
const DIR = "contents";

const slugify = (text) =>
  text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

const primaryTitle = (video) => {
  const title = video.title;
  if (typeof title === "string") return title;
  return title?.fr ?? title?.en ?? "";
};

async function ytDlp(args) {
  const { success } = await new Deno.Command("yt-dlp", {
    args: ["--no-warnings", ...args],
    stdout: "piped",
    stderr: "inherit",
  }).output();
  return success;
}

async function exists(path) {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

async function findVtt(dir) {
  for await (const entry of Deno.readDir(dir)) {
    if (entry.isFile && entry.name.endsWith(".vtt")) {
      return `${dir}/${entry.name}`;
    }
  }
  return null;
}

async function writeMarker(path, url) {
  await Deno.writeTextFile(path, `${url}\n${new Date().toISOString()}\n`);
}

async function downloadTo(url, lang, dest) {
  const tmp = await Deno.makeTempDir();
  let failed = false;
  try {
    for (const mode of ["--write-subs", "--write-auto-subs"]) {
      const ok = await ytDlp([
        "--skip-download",
        mode,
        "--sub-langs",
        `^${lang}$`,
        "--sub-format",
        "vtt",
        "-o",
        `${tmp}/sub.%(ext)s`,
        url,
      ]);
      if (!ok) failed = true;
      const vtt = await findVtt(tmp);
      if (vtt) {
        await Deno.copyFile(vtt, dest);
        return "downloaded";
      }
    }
    return failed ? "error" : "missing";
  } finally {
    await Deno.remove(tmp, { recursive: true }).catch(() => {});
  }
}

await Deno.mkdir(DIR, { recursive: true });

const docs = parseAllDocuments(await Deno.readTextFile(FEED));
const jobs = [];

for (const doc of docs) {
  const data = doc.toJS() ?? {};
  for (const video of data.videos ?? []) {
    const langs = Object.entries(video.download_vtt ?? {})
      .filter(([, on]) => on)
      .map(([lang]) => lang);
    if (langs.length === 0 || !video.url) continue;

    const slug = slugify(primaryTitle(video));
    if (!slug) {
      console.error(`empty slug for ${video.url}`);
      continue;
    }

    for (const lang of langs) {
      const dest = `${DIR}/${video.date}_${slug}.${lang}.vtt`;
      jobs.push({ url: video.url, lang, dest, marker: `${dest}.missing` });
    }
  }
}

console.error(`${jobs.length} transcript(s) to check`);

const width = String(jobs.length).length;
let downloaded = 0;
let present = 0;
let missing = 0;
let errors = 0;

for (const [index, job] of jobs.entries()) {
  const prefix = `[${String(index + 1).padStart(width)}/${jobs.length}]`;
  const name = job.dest.slice(DIR.length + 1);

  if (await exists(job.dest)) {
    present++;
    console.error(`${prefix} ${"already downloaded".padEnd(18)} ${name}`);
    continue;
  }

  if (await exists(job.marker)) {
    missing++;
    console.error(`${prefix} ${"missing".padEnd(18)} ${name}`);
    continue;
  }

  const status = await downloadTo(job.url, job.lang, job.dest);
  if (status === "downloaded") {
    downloaded++;
    console.error(`${prefix} ${"downloaded".padEnd(18)} ${name}`);
  } else if (status === "missing") {
    await writeMarker(job.marker, job.url);
    missing++;
    console.error(`${prefix} ${"missing".padEnd(18)} ${name}`);
  } else {
    errors++;
    console.error(`${prefix} ${"error".padEnd(18)} ${name} (will retry on next run)`);
  }
}

console.error(
  `summary: ${downloaded} downloaded, ${present} already downloaded, ${missing} missing, ${errors} error`,
);
