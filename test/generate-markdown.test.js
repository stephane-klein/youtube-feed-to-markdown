import assert from "node:assert/strict";
import test from "node:test";
import {
  budgetForPart,
  chunkPrompt,
  cleanBody,
  createLimiter,
  plannedBudget,
  smoothPrompt,
  sumUsage,
} from "../src/generate-markdown.js";

const usage = (input, output, cached = 0, reasoning = 0) => ({
  inputTokens: input,
  outputTokens: output,
  totalTokens: input + output,
  inputTokenDetails: { noCacheTokens: input - cached, cacheReadTokens: cached },
  outputTokenDetails: { textTokens: output - reasoning, reasoningTokens: reasoning },
});

test("plannedBudget doubles the input estimate within the ceiling", () => {
  assert.equal(plannedBudget("", 384000), 2048);
  assert.equal(plannedBudget("x".repeat(35000), 384000), 20000);
  assert.equal(plannedBudget("x".repeat(35000), 10000), 10000);
});

test("budgetForPart prefers an explicit max_output_tokens override", () => {
  const text = "x".repeat(35000);
  assert.equal(budgetForPart(text, { maxOutputTokens: "4000", ceiling: 384000 }), 4000);
  assert.equal(budgetForPart(text, { ceiling: 384000 }), 20000);
  assert.equal(budgetForPart(text, { maxOutputTokens: "", ceiling: 5000 }), 5000);
});

test("chunkPrompt keeps the single-part prompt unchanged", () => {
  assert.equal(
    chunkPrompt("Title", "body", 0, 1),
    "Title: Title\n\nTranscript:\nbody",
  );
});

test("chunkPrompt marks multi-part transcripts", () => {
  const prompt = chunkPrompt("Title", "body", 1, 3);
  assert.match(prompt, /part 2 of 3/);
  assert.match(prompt, /part 2\/3/);
});

test("smoothPrompt exposes both sides of the junction", () => {
  const prompt = smoothPrompt("previous", "next");
  assert.match(prompt, /previous/);
  assert.match(prompt, /next/);
});

test("sumUsage sums every usage field", () => {
  const total = sumUsage([usage(100, 50, 20, 10), usage(10, 5, 0, 2)]);
  assert.equal(total.inputTokens, 110);
  assert.equal(total.outputTokens, 55);
  assert.equal(total.totalTokens, 165);
  assert.equal(total.inputTokenDetails.cacheReadTokens, 20);
  assert.equal(total.outputTokenDetails.reasoningTokens, 12);
});

test("sumUsage returns null without any usage", () => {
  assert.equal(sumUsage([]), null);
  assert.equal(sumUsage([undefined]), null);
});

test("cleanBody strips code fences", () => {
  assert.equal(cleanBody("```markdown\nhello\n```"), "hello");
  assert.equal(cleanBody("hello"), "hello");
});

test("createLimiter caps the number of concurrent tasks", async () => {
  const limiter = createLimiter(2);
  let active = 0;
  let peak = 0;
  const task = () =>
    new Promise((resolve) => {
      active++;
      peak = Math.max(peak, active);
      setTimeout(() => {
        active--;
        resolve("done");
      }, 5);
    });

  const results = await Promise.all(
    Array.from({ length: 6 }, () => limiter(task)),
  );
  assert.deepEqual(results, Array(6).fill("done"));
  assert.equal(peak, 2);
});
