export const DIR = "contents";

export const slugify = (text) =>
  text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

export const primaryTitle = (video) => {
  const title = video.title;
  if (typeof title === "string") return title;
  return title?.fr ?? title?.en ?? "";
};

export async function exists(path) {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

async function ytDlp(args) {
  const { success } = await new Deno.Command("yt-dlp", {
    args: ["--no-warnings", ...args],
    stdout: "piped",
    stderr: "null",
  }).output();
  return success;
}

async function findVtt(dir) {
  for await (const entry of Deno.readDir(dir)) {
    if (entry.isFile && entry.name.endsWith(".vtt")) {
      return `${dir}/${entry.name}`;
    }
  }
  return null;
}

export async function writeMarker(path, url) {
  await Deno.writeTextFile(path, `${url}\n${new Date().toISOString()}\n`);
}

export async function downloadVtt(url, lang, dest) {
  const tmp = await Deno.makeTempDir();
  let failed = false;
  try {
    for (const mode of ["--write-subs", "--write-auto-subs"]) {
      const ok = await ytDlp([
        "--skip-download",
        "--sleep-requests",
        "2",
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

export function videoJobs(video) {
  const langs = Object.entries(video.download_vtt ?? {})
    .filter(([, on]) => on)
    .map(([lang]) => lang);
  if (langs.length === 0 || !video.url) return [];

  const slug = slugify(primaryTitle(video));
  if (!slug) return [];

  return langs.map((lang) => {
    const base = `${DIR}/${video.date}_${slug}.${lang}`;
    return {
      url: video.url,
      lang,
      title: primaryTitle(video),
      base,
      vtt: `${base}.vtt`,
      marker: `${base}.vtt.missing`,
    };
  });
}
