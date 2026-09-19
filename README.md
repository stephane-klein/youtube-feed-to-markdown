# youtube-feed-to-markdown

I collect the videos of a few YouTube channels into `feed.yaml`, using
[yt-dlp](https://github.com/yt-dlp/yt-dlp) to fetch the metadata.

## Requirements

- Node.js 22 or later;
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) on your `PATH`.

The scripts run yt-dlp with `--js-runtimes node`: solving YouTube's JavaScript
challenges requires an external JavaScript runtime, and Node.js — already
required here — does the job.

## Install

[mise](https://mise.jdx.dev/) installs both yt-dlp and Node.js:

```sh
$ mise install
```

## Run

```sh
$ mise run extract-video-metadata
→ https://www.youtube.com/@le_science4all
→ https://www.youtube.com/@MonsieurPhi
```

The same commands are exposed as npm scripts: `npm run extract-video-metadata`,
`npm run download-vtt`, `npm run generate-markdown` and `npm run markdown-stats`.

The script reads the channel URLs from `feed.yaml`, asks yt-dlp for each
channel's videos, and writes the result back into the file. I run it from time
to time: it is idempotent, so a new run only adds the videos that are missing.

## feed.yaml

A multi-document YAML file, one document per channel. I only set the channel
URL, and the script fills the rest:

```yaml
url: https://www.youtube.com/@le_science4all
---
url: https://www.youtube.com/@MonsieurPhi
```

## Transcripts

I mark the videos I want as transcripts with a `download_vtt` field:

```yaml
  - title:
      fr: Pourquoi π est-il si fou ? Relativité 1
      en: Why is π so crazy? Relativity 1
    date: 2016-02-12
    url: https://www.youtube.com/watch?v=PxRPpdzmbUQ
    download_vtt:
      fr: true
```

Then:

```sh
$ mise run download_vtt
21 transcript(s) to check
[ 1/21] downloaded         2016-07-14_le-sol-accelere-t-il-vraiment-vers-le-haut-debattonsmieux.fr.vtt
[ 2/21] already downloaded 2016-08-25_les-synonymes-a-connotations-opposees-debattonsmieux.fr.vtt
[ 3/21] missing            2017-06-26_favoriser-l-honnetete-democratie-18.fr.vtt
…
summary: 1 downloaded, 1 already downloaded, 1 missing, 0 error
```

For each marked video, the task writes the subtitle to
`contents/<date>_<slug>.<lang>.vtt`, for example
`contents/2016-02-12_pourquoi-est-il-si-fou-relativite-1.fr.vtt`. It prefers
manual subtitles and falls back to the auto-generated ones. A file that already
exists is left untouched, so running the task again only fetches new
transcripts. The `extract-video-metadata` task keeps the `download_vtt`
field.

When a video has no subtitle at all, the task writes a `<…>.vtt.missing`
marker and stops trying. I delete that marker to force a new attempt.

## Markdown

I mark the videos I want as Markdown with `generate_markdown`. The transcript is
downloaded first if it is not there yet:

```yaml
    download_vtt:
      fr: true
    generate_markdown:
      fr: true
```

Before the first run, create `.secret.sh` from `.secret.sh.example` and put your
API key in it; mise sources that file automatically:

```sh
$ cp .secret.sh.example .secret.sh
$ $EDITOR .secret.sh
```

Then:

```sh
$ mise run generate_markdown
74 markdown(s) to generate with mimo-v2.5
✔ Download transcripts (73/74)
  › downloaded  2017-08-04_nietzsche-la-morale-des-winners-genealogie-de-la-morale-1-2.fr.md
  › skipped (no transcript)  2017-06-26_favoriser-l-honnetete-democratie-18.fr.md
✔ Generate markdown (73/74, 37 already)
  › generated  2017-10-13_le-scepticisme-le-trilemme-d-agrippa-grain-de-philo-14-ep-2.fr.md  mimo-v2.5  llm 87.1s  4428 in / 3262 out  ~$0.000927
  …
summary: 36 generated, 37 already generated, 1 skipped, 0 error
total: 3135.6s, 159408 in / 117432 out, ~$0.033372
```

The task sends each transcript to an LLM through ai-sdk, configured with
`OPENAI_API_KEY`, `OPENAIAPI_MODEL_ID` and `OPENAIAPI_ENDPOINT`, and gets back
Markdown prose with section headings when the talk needs them. Paragraphs are
hard-wrapped at 80 columns. The result goes to
`contents/<date>_<slug>.<lang>.md`. A second run reports `already generated` and
writes nothing.

The task runs in two sequential phases. `Download transcripts` reports how many
videos have a transcript (`available/total`) and fetches the missing ones, at
most `YTDLP_CONCURRENCY` at a time (default 2); only downloads, skips and errors
are listed. The `Generate markdown` phase then converts the transcripts, at most
`OPENAIAPI_CONCURRENCY` at a time (default 6), reporting the number of up-to-date
Markdown files over the whole feed (`ready/total, N already`). Each phase keeps
only the last 20 events on screen, so it stays bounded even with a large feed.

Retryable API errors (HTTP 408, 409, 429 or >= 500) are retried with growing
delays — 10 s, 30 s, 60 s by default, configurable with `OPENAIAPI_RETRY_DELAYS`
(comma-separated seconds). A `Retry-After` header from the server is honored when
longer than the schedule. Each retry is shown in the phase output; after the last
attempt the file is reported as an error and is retried on the next run.

### Frontmatter

Each generated file starts with a YAML frontmatter describing the run:

```yaml
---
source_url: https://www.youtube.com/watch?v=PxRPpdzmbUQ
video_title: Pourquoi π est-il si fou ? Relativité 1
generated_at: 2026-09-19T10:12:33.456Z
llm:
  model: mimo-v2.5
  duration_seconds: 87.1
  input_tokens: 4428
  cached_input_tokens: 0
  output_tokens: 3262
  estimated_cost_usd: 0.000927
  finish_reason: stop
---
```

`video_title` is the original video title in the file's language and
`generated_at` is the UTC time of the generation. `estimated_cost_usd` is `null`
when the model is not in the price table. Existing files are left untouched: run
`FORCE_MARKDOWN=1 mise run generate_markdown` to regenerate every file, which is
also the way to add the frontmatter to files generated before it existed.

## Stats

`markdown_stats` reads the frontmatter of every `contents/*.md` and prints global
totals — tokens, estimated cost, processing time — with a breakdown per model and
per language:

```sh
$ mise run markdown_stats
contents/ — 43 file(s)
  with frontmatter     3
  without frontmatter  40

tokens
  input                16,134
  cached input         16,000
  output               14,486
  total                30,620

cost
  estimated            $0.004120
  unknown prices       0 file(s)

processing time
  total                395.6s
  mean                 131.9s
  min / max            111.8s / 165.3s

generated_at
  first                2026-09-19T08:56:54.497Z
  last                 2026-09-19T08:57:47.976Z

models
  mimo-v2.5           3 file(s)     16,134 in /    14,486 out  $0.004120

languages
  fr                  3 file(s)     16,134 in /    14,486 out  $0.004120
```

Files without frontmatter (generated before the frontmatter existed) are counted
but left out of the totals.

