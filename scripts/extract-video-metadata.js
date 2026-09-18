#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env --allow-run=yt-dlp

import { parseAllDocuments, stringify } from "npm:yaml@2.9.1";

const FEED = "feed.yaml";

const toIso = (raw) =>
  /^\d{8}$/.test(raw)
    ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`
    : "";

async function ytDlp(args) {
  const { stdout, success, code } = await new Deno.Command("yt-dlp", {
    args: ["--no-warnings", ...args],
    stdout: "piped",
    stderr: "inherit",
  }).output();

  if (!success) {
    throw new Error(`yt-dlp a échoué (code ${code}) : ${args.join(" ")}`);
  }

  return new TextDecoder().decode(stdout);
}

async function uploadsPlaylistUrl(channelUrl) {
  const out = await ytDlp([
    "--flat-playlist",
    "--playlist-end",
    "1",
    "-O",
    "%(playlist_channel_id)s",
    channelUrl,
  ]);
  const channelId = out.split("\n").map((line) => line.trim()).filter(Boolean)[0];

  if (!channelId?.startsWith("UC")) {
    throw new Error(`ID de chaîne introuvable pour ${channelUrl}`);
  }

  return `https://www.youtube.com/playlist?list=UU${channelId.slice(2)}`;
}

async function listEntries(playlistUrl, lang, withDates) {
  const args = [
    "--flat-playlist",
    "-O",
    '{"titre": %(title)j, "date": "%(upload_date|)s", "url": %(webpage_url)j}',
    "--extractor-args",
    `youtube:lang=${lang}`,
  ];
  if (withDates) {
    args.push("--extractor-args", "youtubetab:approximate_date");
  }
  args.push(playlistUrl);

  const out = await ytDlp(args);
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function fetchVideos(channelUrl) {
  const playlistUrl = await uploadsPlaylistUrl(channelUrl);
  const en = await listEntries(playlistUrl, "en", true);
  const fr = await listEntries(playlistUrl, "fr", false);
  const frTitles = new Map(fr.map((entry) => [entry.url, entry.titre]));

  return en
    .filter((entry) => !entry.url.includes("/shorts/"))
    .map((entry) => {
      const enTitle = entry.titre.trim();
      const frTitle = (frTitles.get(entry.url) ?? enTitle).trim();
      const title =
        frTitle && enTitle && frTitle !== enTitle
          ? { fr: frTitle, en: enTitle }
          : { fr: frTitle || enTitle };
      return { title, date: toIso(entry.date), url: entry.url };
    })
    .reverse();
}

function normalizeEntry(entry) {
  const { titre, ...rest } = entry;
  if (typeof titre === "string") {
    return { title: { fr: titre }, ...rest };
  }
  return entry;
}

function mergeVideos(existing, fetched) {
  const fetchedUrls = new Set(fetched.map((v) => v.url));
  const extras = existing
    .filter((v) => v.url && !fetchedUrls.has(v.url))
    .map(normalizeEntry);
  return [...fetched, ...extras].sort((a, b) =>
    (a.date ?? "").localeCompare(b.date ?? ""),
  );
}

const docs = parseAllDocuments(await Deno.readTextFile(FEED));
const rendered = [];

for (const doc of docs) {
  const data = doc.toJS() ?? {};
  if (typeof data.url === "string" && data.url) {
    console.error(`→ ${data.url}`);
    data.videos = mergeVideos(data.videos ?? [], await fetchVideos(data.url));
  }
  rendered.push(stringify(data, { lineWidth: 0 }).trimEnd());
}

await Deno.writeTextFile(FEED, rendered.join("\n---\n") + "\n");
