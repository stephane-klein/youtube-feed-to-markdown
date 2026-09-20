import assert from "node:assert/strict";
import test from "node:test";
import {
  chunkTranscript,
  dedupeAdjacentHeadings,
  estimateTokens,
  firstBlock,
  lastBlock,
  replaceFirstBlock,
} from "../src/chunk.js";

test("estimateTokens uses the 3.5 chars per token ratio", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("abcd"), 2);
  assert.equal(estimateTokens("a".repeat(35)), 10);
});

test("chunkTranscript keeps a short transcript in a single chunk", () => {
  const transcript = "one\ntwo\nthree";
  assert.deepEqual(chunkTranscript(transcript, { targetTokens: 1000 }), [
    transcript,
  ]);
});

test("chunkTranscript splits on line boundaries without losing content", () => {
  const transcript = "a\nb\nc\nd\ne";
  const chunks = chunkTranscript(transcript, { targetTokens: 2 });
  assert.deepEqual(chunks, ["a", "b", "c", "d", "e"]);
  assert.equal(chunks.join("\n"), transcript);
});

test("chunkTranscript never emits an empty list", () => {
  assert.deepEqual(chunkTranscript("", { targetTokens: 10 }), [""]);
});

test("dedupeAdjacentHeadings drops an immediately repeated heading", () => {
  const markdown = "## A\n\n## A\n\nbody";
  assert.equal(dedupeAdjacentHeadings(markdown), "## A\n\nbody");
});

test("dedupeAdjacentHeadings keeps a heading repeated after body text", () => {
  const markdown = "## A\n\ntext\n\n## A\n\nbody";
  assert.equal(dedupeAdjacentHeadings(markdown), markdown);
});

test("firstBlock, lastBlock and replaceFirstBlock operate on the boundaries", () => {
  const markdown = "first paragraph\n\nmiddle\n\nlast paragraph";
  assert.equal(firstBlock(markdown), "first paragraph");
  assert.equal(lastBlock(markdown), "last paragraph");
  assert.equal(
    replaceFirstBlock(markdown, "rewritten"),
    "rewritten\n\nmiddle\n\nlast paragraph",
  );
});
