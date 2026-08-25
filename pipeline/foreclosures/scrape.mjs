// Scrape pending foreclosure (Notice of Substitute Trustee Sale) filings from
// the Dallas County Clerk's public records portal (dallas.tx.publicsearch.us).
//
// Texas trustee sales happen the first Tuesday of each month and notices must
// be filed 21+ days ahead, so the portal's "Foreclosures" department with a
// future sale-date window is a live list of every pending foreclosure.
//
// The portal only renders results for real browser navigations (plain HTTP
// requests get an empty SSR shell), so this uses Playwright. Row metadata is
// read from the results table; each row's document id comes from its
// checkbox input id ("table-checkbox-<docId>").
//
// Usage:
//   npm install            # once (downloads Chromium)
//   node scrape.mjs        # writes ../../public/data/dallas_foreclosures.json
//
// Options:
//   --months <n>   sale-date window from today, default 8
//   --out <path>   output file
//   --limit <n>    page size, default 50 (what the site uses)

import { chromium } from "playwright";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf("--" + name);
  return i >= 0 ? args[i + 1] : dflt;
};
const MONTHS = Number(opt("months", 8));
const LIMIT = Number(opt("limit", 250));
const OUT = resolve(HERE, opt("out", "../../public/data/dallas_foreclosures.json"));
const PAGE_DELAY_MS = 1200;

const ymd = (d) =>
  `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;

const start = new Date();
const end = new Date();
end.setMonth(end.getMonth() + MONTHS);
const dateRange = `${ymd(start)}%2C${ymd(end)}`;

const resultsURL = (offset) =>
  `https://dallas.tx.publicsearch.us/results?department=FC&instrumentDateRange=${dateRange}` +
  `&keywordSearch=false&limit=${LIMIT}&offset=${offset}&searchOcrText=false&searchType=quickSearch`;

const browser = await chromium.launch();
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/151.0 Safari/537.36 dirtfound.com data pipeline";

const notices = [];
let total = null;

for (let offset = 0; total === null || offset < total; offset += LIMIT) {
  // The portal only hydrates results reliably on the first navigation of a
  // session, so each page gets its own fresh browser context. Hydration can
  // take 10s+; retry a slow page once.
  let context = null, page = null, ready = false;
  for (let attempt = 0; attempt < 2 && !ready; attempt++) {
    if (context) await context.close();
    context = await browser.newContext({ userAgent: UA });
    page = await context.newPage();
    await page.goto(resultsURL(offset), { waitUntil: "domcontentloaded" });
    ready = !!(await page
      .waitForSelector('[role="row"] input[id^="table-checkbox-"]', { timeout: 60000 })
      .catch(() => null));
    if (!ready) console.warn(`  offset ${offset}: rows never rendered (attempt ${attempt + 1})`);
  }

  if (total === null) {
    const bodyText = await page.evaluate(() => document.body.textContent);
    const m = bodyText.match(/of\s+([\d,]+)\s+results/);
    total = m ? Number(m[1].replace(/,/g, "")) : 0;
    console.log(`${total} pending foreclosure notices (sale dates next ${MONTHS} months)`);
    if (!total) break;
  }

  const rows = await page.evaluate(() => {
    return [...document.querySelectorAll('[role="row"]')]
      .map((row) => {
        const input = row.querySelector('input[id^="table-checkbox-"]');
        if (!input) return null;
        const cells = [...row.querySelectorAll('[role="cell"], [role="gridcell"], td')].map((c) =>
          c.textContent.trim()
        );
        // cells: [checkbox, actions, viewed, docType, recorded, saleDate, docNumber, city]
        const docId = input.id.replace("table-checkbox-", "");
        if (!/^\d+$/.test(docId)) return null; // skip the header's select-all box
        return {
          doc_id: docId,
          doc_type: cells[3] || "",
          recorded: cells[4] || "",
          sale_date: cells[5] || "",
          doc_number: cells[6] || "",
          city: cells[7] || "",
        };
      })
      .filter(Boolean);
  });

  if (!rows.length) { await context.close(); break; } // defensive: stop rather than loop forever
  for (const r of rows) {
    notices.push({ ...r, url: `https://dallas.tx.publicsearch.us/doc/${r.doc_id}` });
  }
  console.log(`  offset ${offset}: +${rows.length} (${notices.length}/${total})`);
  await page.waitForTimeout(PAGE_DELAY_MS);
  await context.close();
}

await browser.close();

// De-dupe on doc_id (paging can shift if new filings land mid-scrape).
const seen = new Set();
const unique = notices.filter((n) => !seen.has(n.doc_id) && seen.add(n.doc_id));

const out = {
  scraped_at: new Date().toISOString(),
  source: "Dallas County Clerk — dallas.tx.publicsearch.us (Foreclosures department)",
  county: "Dallas",
  sale_date_range: [ymd(start), ymd(end)],
  count: unique.length,
  notices: unique,
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(out, null, 1) + "\n");
console.log(`wrote ${unique.length} notices → ${OUT}`);
