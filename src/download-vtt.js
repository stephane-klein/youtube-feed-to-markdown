import { mkdir } from "node:fs/promises";
import { DIR, downloadVtt, exists, videoJobs, writeMarker } from "./vtt.js";

export async function runDownloadVtt({ feed = [] } = {}) {
  await mkdir(DIR, { recursive: true });

  const jobs = feed.flatMap((channel) =>
    (channel.videos ?? []).flatMap((video) => videoJobs(video)),
  );

  console.error(`${jobs.length} transcript(s) to check`);

  const width = String(jobs.length).length;
  let downloaded = 0;
  let present = 0;
  let missing = 0;
  let errors = 0;

  for (const [index, job] of jobs.entries()) {
    const prefix = `[${String(index + 1).padStart(width)}/${jobs.length}]`;
    const name = job.vtt.slice(DIR.length + 1);

    if (await exists(job.vtt)) {
      present++;
      console.error(`${prefix} ${"already downloaded".padEnd(18)} ${name}`);
      continue;
    }

    if (await exists(job.marker)) {
      missing++;
      console.error(`${prefix} ${"missing".padEnd(18)} ${name}`);
      continue;
    }

    const status = await downloadVtt(job.url, job.lang, job.vtt);
    if (status === "downloaded") {
      downloaded++;
      console.error(`${prefix} ${"downloaded".padEnd(18)} ${name}`);
    } else if (status === "missing") {
      await writeMarker(job.marker, job.url);
      missing++;
      console.error(`${prefix} ${"missing".padEnd(18)} ${name}`);
    } else {
      errors++;
      console.error(
        `${prefix} ${"error".padEnd(18)} ${name} (will retry on next run)`,
      );
    }
  }

  console.error(
    `summary: ${downloaded} downloaded, ${present} already downloaded, ${missing} missing, ${errors} error`,
  );
}
