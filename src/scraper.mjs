import { chromium, errors as playwrightErrors } from "playwright";
import { addDays, tokyoDate } from "./calendar.mjs";

const BLOCK_TEXT =
  /ご指定のページはアクセスできません|過剰な回数のアクセス|しばらく経ってから|Access Denied|Too Many Requests/i;
const NAVIGATION_TIMEOUT = 30_000;
const OPEN_PARK_RETRIES = 2;

export class AccessBlockedError extends Error {}
export class SiteUnavailableError extends Error {}

async function ensureUsable(page) {
  const currentUrl = page.url();
  if (
    currentUrl.startsWith("chrome-error://") ||
    currentUrl === "about:blank"
  ) {
    throw new SiteUnavailableError(
      `予約サイトの読み込みに失敗しました: ${currentUrl}`
    );
  }

  const body = await page.locator("body").innerText().catch(() => "");
  if (BLOCK_TEXT.test(body)) {
    throw new AccessBlockedError(
      "予約システムがアクセスを制限しています"
    );
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function openParkOnce(page, baseUrl, parkName) {
  await page.goto(baseUrl, {
    waitUntil: "domcontentloaded",
    timeout: NAVIGATION_TIMEOUT
  });
  await page.waitForTimeout(3_000);
  await ensureUsable(page);

  const searchButton = page.getByRole("button", {
    name: /こだわり検索/
  });
  await searchButton.waitFor({ state: "visible" });
  await Promise.all([
    page.waitForURL(/rsvWTranceKodawariAction\.do/, {
      waitUntil: "domcontentloaded"
    }),
    searchButton.click()
  ]);
  await page.waitForTimeout(2_000);
  await ensureUsable(page);

  const parkLink = page
    .locator("a", { hasText: parkName })
    .filter({
      hasText: new RegExp(`^${escapeRegExp(parkName)}$`)
    })
    .first();

  if ((await parkLink.count()) === 0) {
    throw new Error(`公園が見つかりません: ${parkName}`);
  }

  const target = await parkLink.getAttribute("data-target");
  if (!target) {
    throw new Error(`公園詳細を特定できません: ${parkName}`);
  }

  await parkLink.click();
  const vacancyButton = page
    .locator(target)
    .getByRole("button", { name: "空き検索" })
    .last();
  await vacancyButton.waitFor({ state: "visible" });
  await Promise.all([
    page.waitForURL(/rsvWOpeKodawariSearchAction\.do/, {
      waitUntil: "domcontentloaded"
    }),
    vacancyButton.click()
  ]);
  await page.waitForTimeout(2_000);
  await ensureUsable(page);
}

async function openPark(page, baseUrl, parkName) {
  let lastError;

  for (let attempt = 1; attempt <= OPEN_PARK_RETRIES; attempt += 1) {
    try {
      console.log(
        `${parkName}: 予約サイトを開きます (${attempt}/${OPEN_PARK_RETRIES})`
      );
      await openParkOnce(page, baseUrl, parkName);
      return;
    } catch (error) {
      if (error instanceof AccessBlockedError) throw error;
      lastError = error;
      console.error(
        `${parkName}: 接続失敗 (${attempt}/${OPEN_PARK_RETRIES}): ${error.message}`
      );
      if (attempt < OPEN_PARK_RETRIES) {
        await page.goto("about:blank").catch(() => {});
        await page.waitForTimeout(10_000);
      }
    }
  }

  throw new SiteUnavailableError(
    `${OPEN_PARK_RETRIES}回接続しましたが応答がありません: ${lastError?.message || "原因不明"}`
  );
}

async function openMonthView(page) {
  if ((await page.locator("#monthly.show").count()) === 0) {
    await page.locator('[data-target="#monthly"]').click();
  }
  await page.waitForFunction(
    () =>
      document.querySelectorAll('#month-info td[id^="month_"]').length > 0
  );
  await ensureUsable(page);
}

async function readTargetDatesInMonth(page, minimumDate) {
  return page.locator('#month-info td[id^="month_"]').evaluateAll(
    (cells, minDate) =>
      cells.flatMap(cell => {
        const match = cell.id.match(/^month_(\d{8})$/);
        if (!match) return [];
        const compact = match[1];
        const iso = `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
        if (iso < minDate) return [];
        const day = cell.querySelector(":scope > div > span:first-child");
        const isTargetDay =
          day?.classList.contains("saturday") ||
          day?.classList.contains("holiday");
        const status =
          cell.querySelector("img.calendar-status")?.getAttribute("alt") || "";
        return isTargetDay && /空き/.test(status) ? [compact] : [];
      }),
    minimumDate
  );
}

async function nextMonth(page) {
  const before = (await page.locator("#month-head").innerText()).trim();
  await page.locator("#next-month").click();
  await page.waitForFunction(previous => {
    const loading = document.querySelector("#loadingmonth");
    const changed =
      document.querySelector("#month-head")?.textContent?.trim() !== previous;
    const finished = !loading || loading.style.display === "none";
    return changed && finished;
  }, before);
  await ensureUsable(page);
}

async function readSlotsForDate(page, compact) {
  await page.evaluate(date => window.selectDay(Number(date)), compact);
  await page.waitForFunction(
    date =>
      document.querySelectorAll(`#week-info td[id^="${date}_"]`).length > 0,
    compact
  );
  await page.waitForTimeout(800);
  await ensureUsable(page);

  return page.locator(`#week-info td[id^="${compact}_"]`).evaluateAll(
    (cells, date) =>
      cells.flatMap(cell => {
        const status =
          cell.querySelector("img.calendar-status")?.getAttribute("alt") || "";
        if (status !== "空き" && !cell.classList.contains("available")) {
          return [];
        }
        const time =
          cell.parentElement?.querySelector("th")?.textContent
            ?.replace(/\s+/g, "")
            .trim() || "時間不明";
        const rawCount =
          cell.querySelector('input[id^="A_"]')?.getAttribute("value") ||
          cell.querySelector(".calendar-availability span")?.textContent ||
          "1";
        const countMatch = String(rawCount).match(/\d+/);
        const count = countMatch ? Number(countMatch[0]) : 1;
        return [{
          date: `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`,
          time,
          count
        }];
      }),
    compact
  );
}

export async function scanPark(config, parkName, now = new Date()) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    locale: "ja-JP",
    timezoneId: config.timezone
  });
  const page = await context.newPage();
  page.setDefaultTimeout(NAVIGATION_TIMEOUT);
  page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT);

  try {
    await openPark(page, config.baseUrl, parkName);
    await openMonthView(page);
    const minimumDate = addDays(
      tokyoDate(now),
      config.ignoreWithinDays + 1
    );
    const slots = [];

    for (const date of (await readTargetDatesInMonth(page, minimumDate)).sort()) {
      slots.push(...(await readSlotsForDate(page, date)));
    }
    await nextMonth(page);
    for (const date of (await readTargetDatesInMonth(page, minimumDate)).sort()) {
      slots.push(...(await readSlotsForDate(page, date)));
    }

    return slots.sort((a, b) =>
      `${a.date}_${a.time}`.localeCompare(`${b.date}_${b.time}`)
    );
  } catch (error) {
    if (
      error instanceof AccessBlockedError ||
      error instanceof SiteUnavailableError
    ) {
      throw error;
    }
    if (
      error instanceof playwrightErrors.TimeoutError ||
      /ERR_|chrome-error:\/\//i.test(error.message || "")
    ) {
      throw new SiteUnavailableError(error.message);
    }
    throw error;
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}
