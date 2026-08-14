import { chromium } from "playwright";
import { addDays, tokyoDate } from "./calendar.mjs";

const BLOCK_TEXT = /ご指定のページはアクセスできません|過剰な回数のアクセス|しばらく経ってから|Access Denied|Too Many Requests/i;

export class AccessBlockedError extends Error {}

async function ensureUsable(page) {
  const body = await page.locator("body").innerText().catch(() => "");
  if (BLOCK_TEXT.test(body)) throw new AccessBlockedError("予約システムがアクセスを制限しています");
}

async function waitForCalendar(page) {
  await page.waitForFunction(() => document.querySelectorAll('#week-info td[id]').length > 0, null, { timeout: 30_000 });
}

async function openPark(page, baseUrl, parkName) {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await page.waitForTimeout(4_000);
  await ensureUsable(page);

  await page.getByRole("button", { name: /こだわり検索/ }).click();
  await page.waitForURL(/rsvWTranceKodawariAction\.do/, { timeout: 30_000 });
  await page.waitForTimeout(3_000);
  await ensureUsable(page);

  const parkLink = page.locator("a", { hasText: parkName }).filter({ hasText: new RegExp(`^${escapeRegExp(parkName)}$`) }).first();
  if (await parkLink.count() === 0) throw new Error(`公園が見つかりません: ${parkName}`);
  await parkLink.click();

  const target = await parkLink.getAttribute("data-target");
  if (!target) throw new Error(`公園詳細を特定できません: ${parkName}`);
  const detail = page.locator(target);
  await detail.getByRole("button", { name: "空き検索" }).click();
  await page.waitForURL(/rsvWOpeKodawariSearchAction\.do/, { timeout: 30_000 });
  await page.waitForTimeout(3_000);
  await ensureUsable(page);
  await waitForCalendar(page);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function openMonthView(page) {
  const toggle = page.locator('[data-target="#monthly"]');
  if ((await page.locator("#monthly.show").count()) === 0) await toggle.click();
  await page.waitForFunction(() => document.querySelectorAll('#month-info td[id^="month_"]').length > 0, null, { timeout: 30_000 });
}

async function readTargetDatesInMonth(page, minimumDate) {
  return page.locator('#month-info td[id^="month_"]').evaluateAll((cells, minDate) => cells.flatMap((cell) => {
    const match = cell.id.match(/^month_(\d{8})$/);
    if (!match) return [];
    const compact = match[1];
    const iso = `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
    if (iso < minDate) return [];
    const day = cell.querySelector(":scope > div > span:first-child");
    const isTargetDay = day?.classList.contains("saturday") || day?.classList.contains("holiday");
    const status = cell.querySelector("img.calendar-status")?.getAttribute("alt") || "";
    return isTargetDay && /空き/.test(status) ? [compact] : [];
  }), minimumDate);
}

async function monthHead(page) {
  return (await page.locator("#month-head").innerText()).trim();
}

async function nextMonth(page) {
  const before = await monthHead(page);
  await page.locator("#next-month").click();
  await page.waitForFunction(previous => {
    const loading = document.querySelector("#loadingmonth");
    return document.querySelector("#month-head")?.textContent?.trim() !== previous && loading?.style.display === "none";
  }, before, { timeout: 30_000 });
}

async function readSlotsForDate(page, compact) {
  await page.evaluate(date => window.selectDay(Number(date)), compact);
  await page.waitForFunction(date => document.querySelectorAll(`#week-info td[id^="${date}_"]`).length > 0, compact, { timeout: 30_000 });
  await page.waitForTimeout(800);

  return page.locator(`#week-info td[id^="${compact}_"]`).evaluateAll((cells, date) => cells.flatMap(cell => {
    const status = cell.querySelector("img.calendar-status")?.getAttribute("alt") || "";
    if (status !== "空き" && !cell.classList.contains("available")) return [];
    const time = cell.parentElement?.querySelector("th")?.textContent?.replace(/\s+/g, "").trim() || "時間不明";
    const count = Number(cell.querySelector('input[id^="A_"]')?.getAttribute("value") || cell.querySelector(".calendar-availability span")?.textContent || 1);
    return [{ date: `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`, time, count }];
  }), compact);
}

export async function scanPark(config, parkName, now = new Date()) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ locale: "ja-JP", timezoneId: config.timezone });
  const page = await context.newPage();
  try {
    await openPark(page, config.baseUrl, parkName);
    await openMonthView(page);
    const minimumDate = addDays(tokyoDate(now), config.ignoreWithinDays + 1);
    const slots = [];
    const currentMonthDates = await readTargetDatesInMonth(page, minimumDate);
    for (const date of currentMonthDates.sort()) {
      slots.push(...await readSlotsForDate(page, date));
    }
    await nextMonth(page);
    const nextMonthDates = await readTargetDatesInMonth(page, minimumDate);
    for (const date of nextMonthDates.sort()) {
      slots.push(...await readSlotsForDate(page, date));
    }
    return slots.sort((a, b) => `${a.date}_${a.time}`.localeCompare(`${b.date}_${b.time}`));
  } finally {
    await context.close();
    await browser.close();
  }
}
