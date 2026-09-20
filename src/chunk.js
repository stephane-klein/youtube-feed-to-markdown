export const CHARS_PER_TOKEN = 3.5;

export function estimateTokens(text) {
  return Math.ceil(`${text ?? ""}`.length / CHARS_PER_TOKEN);
}

export function chunkTranscript(transcript, { targetTokens }) {
  const target = Math.max(1, Math.floor(Number(targetTokens) || 1));
  const lines = `${transcript ?? ""}`.split("\n");
  const chunks = [];
  let current = [];
  let currentTokens = 0;

  for (const line of lines) {
    const lineTokens = estimateTokens(line) + 1;
    if (current.length > 0 && currentTokens + lineTokens > target) {
      chunks.push(current.join("\n"));
      current = [];
      currentTokens = 0;
    }
    current.push(line);
    currentTokens += lineTokens;
  }

  if (current.length > 0) chunks.push(current.join("\n"));
  return chunks.length > 0 ? chunks : [""];
}

export function splitBlocks(markdown) {
  return `${markdown ?? ""}`.split(/\n{2,}/);
}

export function firstBlock(markdown) {
  return splitBlocks(markdown)[0]?.trim() ?? "";
}

export function lastBlock(markdown) {
  const blocks = splitBlocks(markdown).filter((block) => block.trim());
  return blocks[blocks.length - 1]?.trim() ?? "";
}

export function replaceFirstBlock(markdown, replacement) {
  const blocks = splitBlocks(markdown);
  if (blocks.length === 0) return replacement;
  blocks[0] = replacement;
  return blocks.join("\n\n");
}

export function dedupeAdjacentHeadings(markdown) {
  const lines = `${markdown ?? ""}`.split("\n");
  const out = [];
  let lastHeading = null;

  for (const line of lines) {
    const heading = line.match(/^\s*#{1,6}\s+(.*\S)\s*$/);
    if (heading) {
      const key = heading[1].trim().toLowerCase();
      if (key === lastHeading) continue;
      lastHeading = key;
      out.push(line);
      continue;
    }
    if (line.trim() !== "") lastHeading = null;
    out.push(line);
  }

  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}
