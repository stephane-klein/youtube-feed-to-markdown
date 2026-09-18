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
    date: 2016-09-19
    url: https://www.youtube.com/watch?v=PxRPpdzmbUQ
    download_vtt:
      fr: true
```

Then:

```sh
$ mise run download_vtt
21 transcript(s) to check
[ 1/21] downloaded         2016-09-19_le-sol-accelere-t-il-vraiment-vers-le-haut-debattonsmieux.fr.vtt
[ 2/21] already downloaded 2016-09-19_les-synonymes-a-connotations-opposees-debattonsmieux.fr.vtt
[ 3/21] missing            2017-09-19_favoriser-l-honnetete-democratie-18.fr.vtt
…
summary: 1 downloaded, 1 already downloaded, 1 missing, 0 error
```

For each marked video, the task writes the subtitle to
`contents/<date>_<slug>.<lang>.vtt`, for example
`contents/2016-09-19_pourquoi-est-il-si-fou-relativite-1.fr.vtt`. It prefers
manual subtitles and falls back to the auto-generated ones. A file that already
exists is left untouched, so running the task again only fetches new
transcripts. The `extract-video-metadata` task keeps the `download_vtt`
field.

When a video has no subtitle at all, the task writes a `<…>.vtt.missing`
marker and stops trying. I delete that marker to force a new attempt.

