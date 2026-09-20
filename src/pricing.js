import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const MODELS_DEV_URL = "https://models.dev/api.json";
const LITELLM_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;

const CACHE_DIR = join(
  process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"),
  "youtube-to-markdown",
);

const normalizeBase = (url) => url.replace(/\/+$/, "");

async function fetchText(url) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`);
  return response.text();
}

async function loadCachedText(url, name) {
  const file = join(CACHE_DIR, name);
  try {
    const info = await stat(file);
    if (Date.now() - info.mtimeMs < CACHE_TTL_MS) {
      return await readFile(file, "utf8");
    }
  } catch {
    // no fresh cache
  }

  try {
    const text = await fetchText(url);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, text);
    return text;
  } catch (error) {
    return await readFile(file, "utf8").catch(() => {
      throw error;
    });
  }
}

async function loadJson(url, name) {
  return JSON.parse(await loadCachedText(url, name));
}

function findProvider(catalog, base) {
  const candidates = base.endsWith("/v1")
    ? [base, base.slice(0, -"/v1".length)]
    : [base];
  for (const candidate of candidates) {
    for (const provider of Object.values(catalog)) {
      if (provider?.api && normalizeBase(provider.api) === candidate) {
        return provider;
      }
    }
  }
  return null;
}

function indexLitellm(catalog) {
  const providers = new Map();
  for (const [key, entry] of Object.entries(catalog)) {
    const provider = entry?.litellm_provider;
    if (!provider) continue;
    let models = providers.get(provider);
    if (!models) {
      models = new Map();
      providers.set(provider, models);
    }
    const name = key.includes("/") ? key.slice(key.lastIndexOf("/") + 1) : key;
    if (!models.has(name)) models.set(name, entry);
    if (!models.has(key)) models.set(key, entry);
  }
  return providers;
}

const toMinutes = (value) => {
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
};

const isWithinRange = (minutes, start, end) =>
  start === end
    ? true
    : start < end
      ? minutes >= start && minutes < end
      : minutes >= start || minutes < end;

function isOffPeak(windows, at) {
  const day = at.getUTCDay();
  const weekday = day === 0 ? 7 : day;
  const minutes = at.getUTCHours() * 60 + at.getUTCMinutes();
  for (const window of windows ?? []) {
    if (!window?.weekdays?.includes(weekday)) continue;
    const ranges = Array.isArray(window.hours_utc)
      ? window.hours_utc
      : [window.hours_utc];
    for (const range of ranges) {
      if (typeof range !== "string" || !range.includes("-")) continue;
      const [start, end] = range.split("-").map(toMinutes);
      if (isWithinRange(minutes, start, end)) return true;
    }
  }
  return false;
}

const perMillion = (perToken) =>
  typeof perToken === "number" ? perToken * 1e6 : undefined;

function litellmPrice(entry, at) {
  const offPeak =
    entry.off_peak_pricing && isOffPeak(entry.off_peak_pricing.windows, at);
  const rates = offPeak ? entry.off_peak_pricing : entry;
  return {
    input: perMillion(rates.input_cost_per_token),
    output: perMillion(rates.output_cost_per_token),
    cachedInput: perMillion(
      rates.cache_read_input_token_cost ?? rates.input_cost_per_token_cache_hit,
    ),
    peak: entry.off_peak_pricing ? !offPeak : null,
    source: "litellm",
  };
}

function modelsDevPrice(model) {
  const cost = model?.cost;
  if (!cost) return null;
  return {
    input: cost.input,
    output: cost.output,
    cachedInput: cost.cache_read ?? 0,
    peak: null,
    source: "models.dev",
  };
}

export async function loadPricing({ endpoint } = {}) {
  if (!endpoint) return null;
  const base = normalizeBase(endpoint.replace(/\/chat\/completions\/?$/, ""));

  let catalog;
  try {
    catalog = await loadJson(MODELS_DEV_URL, "models-dev.json");
  } catch (error) {
    console.error(`warning: pricing catalog unavailable (${error.message})`);
    return null;
  }

  const provider = findProvider(catalog, base);
  if (!provider) return null;

  let litellm = null;
  try {
    litellm = indexLitellm(await loadJson(LITELLM_URL, "litellm.json")).get(
      provider.id,
    ) ?? null;
  } catch {
    litellm = null;
  }

  return {
    provider: provider.id,
    priceAt(modelId, at = new Date()) {
      const entry = litellm?.get(modelId);
      if (entry) return litellmPrice(entry, at);
      return modelsDevPrice(provider.models?.[modelId]);
    },
    outputLimitAt(modelId) {
      const entry = litellm?.get(modelId);
      const limit =
        entry?.max_output_tokens ??
        provider.models?.[modelId]?.limit?.output ??
        entry?.max_tokens;
      return typeof limit === "number" && limit > 0 ? limit : null;
    },
  };
}
