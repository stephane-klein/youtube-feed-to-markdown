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
