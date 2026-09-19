# youtube-feed-to-markdown

I collect the videos of a few YouTube channels into `feed.yaml`, using
[yt-dlp](https://github.com/yt-dlp/yt-dlp) to fetch the metadata.

## Install

```sh
$ mise install
```

## Run

```sh
$ mise run extract-video-metadata
→ https://www.youtube.com/@le_science4all
→ https://www.youtube.com/@MonsieurPhi
```

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

