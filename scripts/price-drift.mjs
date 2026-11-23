#!/usr/bin/env node
/* global process, console, fetch */ // Compare Google's on-demand BigQuery prices with the built-in table.
// Exits 1 when a price changed or a location was added or removed, so the nightly run fails.
// Auth: ACCESS_TOKEN (CI), or `gcloud auth print-access-token` locally. QUOTA_PROJECT sets the
// project billed for the (free) Catalog API call. Usage: node scripts/price-drift.mjs
import { execFileSync } from "node:child_process";
import {
  ON_DEMAND_PRICE_PER_TIB,
  ON_DEMAND_PRICES_AS_OF,
} from "../packages/core/src/region-prices.ts";

const SKUS = "https://cloudbilling.googleapis.com/v1/services/24E6-581D-38E5/skus";
// The table keeps at most 4 decimals (8.59375 is written 8.5938).
const TOLERANCE = 0.0001;

const token =
  process.env.ACCESS_TOKEN ||
  execFileSync("gcloud", ["auth", "print-access-token"], { encoding: "utf8" }).trim();
const headers = { Authorization: `Bearer ${token}` };
if (process.env.QUOTA_PROJECT) headers["x-goog-user-project"] = process.env.QUOTA_PROJECT;

/** Every BigQuery SKU, across pages. */
async function fetchSkus() {
  const skus = [];
  let pageToken = "";
  do {
    const url = `${SKUS}?pageSize=5000${pageToken ? `&pageToken=${pageToken}` : ""}`;
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`Catalog API ${res.status}: ${await res.text()}`);
    const page = await res.json();
    skus.push(...(page.skus ?? []));
    pageToken = page.nextPageToken ?? "";
  } while (pageToken);
  return skus;
}

/** The per-TiB price after the free tier: the last tiered rate. */
function pricePerTib(sku) {
  const expr = sku.pricingInfo?.[0]?.pricingExpression;
  if (expr?.usageUnit !== "TiBy") throw new Error(`${sku.description}: unit ${expr?.usageUnit}`);
  const { units, nanos } = expr.tieredRates.at(-1).unitPrice;
  return Number(units) + nanos / 1e9;
}

/** Catalog prices keyed like the table: `US`/`EU` for the multi-region SKU, else the region. */
function catalogPrices(skus) {
  const prices = {};
  for (const sku of skus) {
    if (sku.category?.resourceGroup !== "OnDemandAnalysis") continue;
    if (sku.description === "Analysis") {
      const price = pricePerTib(sku);
      for (const region of sku.serviceRegions) {
        const key = { us: "US", europe: "EU" }[region];
        if (!key) throw new Error(`"Analysis" SKU has an unknown multi-region: ${region}`);
        prices[key] = price;
      }
      continue;
    }
    const match = /^Analysis \((.+)\)$/.exec(sku.description);
    if (match) prices[match[1]] = pricePerTib(sku);
  }
  return prices;
}

const catalog = catalogPrices(await fetchSkus());
if (Object.keys(catalog).length < 10) {
  throw new Error(
    `Only ${Object.keys(catalog).length} prices found: has the catalog changed shape?`,
  );
}

const problems = [];
for (const [location, price] of Object.entries(catalog)) {
  const ours = ON_DEMAND_PRICE_PER_TIB[location];
  if (ours === undefined) problems.push(`added    ${location}: ${price}`);
  else if (Math.abs(ours - price) > TOLERANCE) {
    problems.push(`changed  ${location}: ${ours} -> ${price}`);
  }
}
for (const location of Object.keys(ON_DEMAND_PRICE_PER_TIB)) {
  if (!(location in catalog)) problems.push(`removed  ${location}`);
}

const count = Object.keys(catalog).length;
if (problems.length === 0) {
  console.log(`All ${count} on-demand prices match the table (as of ${ON_DEMAND_PRICES_AS_OF}).`);
} else {
  console.log(`Google's on-demand prices differ from the table (as of ${ON_DEMAND_PRICES_AS_OF}):`);
  for (const line of problems.sort()) console.log(`  ${line}`);
  console.log(
    "Update packages/core/src/region-prices.ts and ON_DEMAND_PRICES_AS_OF, then run pnpm vitest run -u.",
  );
  process.exitCode = 1;
}
