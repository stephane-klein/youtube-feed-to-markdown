import { writeFile } from "node:fs/promises";
import { stringify } from "yaml";
import { runYtDlp } from "./ytdlp.js";

const DATE_CHUNK = 50;

const toIso = (raw) =>
  /^\d{8}$/.test(raw)
    ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`
    : "";

async function ytDlp(args, { allowFailure = false } = {}) {
  const { stdout } = await runYtDlp(args, { stderr: "inherit", allowFailure });
  return stdout;
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

async function listEntries(playlistUrl, lang) {
  const args = [
    "--flat-playlist",
    "-O",
    '{"titre": %(title)j, "url": %(webpage_url)j}',
    "--extractor-args",
    `youtube:lang=${lang}`,
  ];
  args.push(playlistUrl);

  const out = await ytDlp(args);
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

const videoId = (url) => /[?&]v=([\w-]+)/.exec(url)?.[1] ?? url;

async function fetchExactDates(urls) {
  const dates = new Map();

  for (let i = 0; i < urls.length; i += DATE_CHUNK) {
    const chunk = urls.slice(i, i + DATE_CHUNK);
    console.error(
      `  exact dates ${Math.min(i + DATE_CHUNK, urls.length)}/${urls.length}`,
    );
    const out = await ytDlp(
      [
        "--skip-download",
        "--no-playlist",
        "--ignore-errors",
        "--print",
        "%(id)s|%(upload_date)s",
        ...chunk,
      ],
      { allowFailure: true },
    );

    for (const line of out.split("\n").filter(Boolean)) {
      const [id, raw] = line.split("|");
      const iso = toIso(raw ?? "");
      if (id && iso) dates.set(id, iso);
    }
  }

  return dates;
}

async function fetchVideos(channelUrl, knownDates) {
  const playlistUrl = await uploadsPlaylistUrl(channelUrl);
  const en = await listEntries(playlistUrl, "en");
  const fr = await listEntries(playlistUrl, "fr");
  const frTitles = new Map(fr.map((entry) => [entry.url, entry.titre]));

  const videos = en
    .filter((entry) => !entry.url.includes("/shorts/"))
    .map((entry) => {
      const enTitle = entry.titre.trim();
      const frTitle = (frTitles.get(entry.url) ?? enTitle).trim();
      const title =
        frTitle && enTitle && frTitle !== enTitle
          ? { fr: frTitle, en: enTitle }
          : { fr: frTitle || enTitle };
      return { title, url: entry.url };
    });

  const missing = videos
    .filter((video) => !knownDates.has(videoId(video.url)))
    .map((video) => video.url);
  const fetched = await fetchExactDates(missing);

  for (const video of videos) {
    const id = videoId(video.url);
    video.date = knownDates.get(id) ?? fetched.get(id) ?? "";
  }

  return videos
    .map((video) => ({ title: video.title, date: video.date, url: video.url }))
    .reverse();
}

function normalizeEntry(entry) {
  const { titre, ...rest } = entry;
  if (typeof titre === "string") {
    return { title: { fr: titre }, ...rest };
  }
  return entry;
}

const MANAGED_KEYS = new Set(["title", "date", "url", "titre"]);

function userFields(entry) {
  return Object.fromEntries(
    Object.entries(entry).filter(([key]) => !MANAGED_KEYS.has(key)),
  );
}

function mergeVideos(existing, fetched) {
  const existingByUrl = new Map(
    existing.filter((v) => v.url).map((v) => [v.url, v]),
  );
  const merged = fetched.map((video) => {
    const previous = existingByUrl.get(video.url);
    return previous
      ? { ...video, ...userFields(previous), date: video.date || previous.date }
      : video;
  });
  const fetchedUrls = new Set(fetched.map((v) => v.url));
  const extras = existing
    .filter((v) => v.url && !fetchedUrls.has(v.url))
    .map(normalizeEntry);
  return [...merged, ...extras].sort((a, b) =>
    (a.date ?? "").localeCompare(b.date ?? ""),
  );
}

export async function runExtract({
  path = "youtube_to_markdown.yaml",
  config = {},
  forceDates = false,
} = {}) {
  for (const channel of config.feed ?? []) {
    if (typeof channel.url !== "string" || !channel.url) continue;

    const videos = channel.videos ?? [];
    const knownDates = forceDates
      ? new Map()
      : new Map(
        videos
          .filter((video) => video.url && video.date)
          .map((video) => [videoId(video.url), video.date]),
      );
    console.error(`→ ${channel.url}`);
    channel.videos = mergeVideos(
      videos,
      await fetchVideos(channel.url, knownDates),
    );
  }

  await writeFile(path, stringify(config, { lineWidth: 0 }));
}
