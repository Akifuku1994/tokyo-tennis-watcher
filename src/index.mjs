import { readFile, writeFile } from "node:fs/promises";
import { sendAvailabilityMail } from "./mail.mjs";
import {
  AccessBlockedError,
  SiteUnavailableError,
  scanPark
} from "./scraper.mjs";

const ERROR_NOTIFICATION_THRESHOLD = 10;

const config = JSON.parse(
  await readFile(new URL("../config.json", import.meta.url), "utf8")
);

const stateUrl = new URL("../data/state.json", import.meta.url);
const state = JSON.parse(await readFile(stateUrl, "utf8"));
const now = new Date();
const forcedPark = process.env.PARK_NAME?.trim();

const parks = forcedPark ? [forcedPark] : config.parks;

if (parks.length === 0) {
  throw new Error("監視対象が見つかりません");
}

state.parks ||= {};
state.consecutiveFailedRuns ||= 0;
delete state.cooldownUntil;
delete state.lastSuccessfulCheckAt;
delete state.lastRunAt;

async function saveState() {
  await writeFile(stateUrl, `${JSON.stringify(state, null, 2)}\n`);
}

console.log(`監視対象: ${parks.join("、")}`);

let successfulParks = 0;
const failures = [];

for (const park of parks) {
  console.log(`確認中: ${park}`);

  try {
    const slots = await scanPark(config, park, now);
    const previous = state.parks[park] || [];
    const previousKeys = new Set(
      previous.map(slot => `${slot.date}|${slot.time}`)
    );
    const newSlots = slots.filter(
      slot => !previousKeys.has(`${slot.date}|${slot.time}`)
    );

    await sendAvailabilityMail({
      park,
      newSlots,
      reservationUrl: config.reservationUrl
    });

    state.parks[park] = slots;
    successfulParks += 1;

    console.log(
      `${park}: 空き ${slots.length}件、新規 ${newSlots.length}件`
    );
  } catch (error) {
    const reason =
      error instanceof AccessBlockedError
        ? "予約システムのアクセス制限を検知しました"
        : error instanceof SiteUnavailableError
          ? error.message
          : error?.message || String(error);

    failures.push({ park, reason });

    console.log(
      `::warning title=${park}を確認できませんでした::${reason}`
    );
  }
}

const toleratedFailures = parks.length >= 6 ? 1 : 0;
const runFailed = failures.length > toleratedFailures;

if (runFailed) {
  state.consecutiveFailedRuns += 1;
} else {
  state.consecutiveFailedRuns = 0;
}

await saveState();

if (runFailed) {
  const details = failures
    .map(({ park, reason }) => `${park}: ${reason}`)
    .join(" / ");
  const consecutive = state.consecutiveFailedRuns;

  if (consecutive === ERROR_NOTIFICATION_THRESHOLD) {
    console.error(
      `::error title=監視が10回連続で失敗しました::成功 ${successfulParks}/${parks.length}公園。確認失敗: ${details}`
    );
    throw new Error(
      `監視未完了が${ERROR_NOTIFICATION_THRESHOLD}回連続しました: 成功 ${successfulParks}/${parks.length}公園`
    );
  }

  const status =
    consecutive < ERROR_NOTIFICATION_THRESHOLD
      ? `エラー通知まであと ${ERROR_NOTIFICATION_THRESHOLD - consecutive}回`
      : "10回目に通知済み";

  console.log(
    `::notice title=監視失敗を一時保留::連続 ${consecutive}回目（${status}）。成功 ${successfulParks}/${parks.length}公園。確認失敗: ${details}`
  );
} else if (failures.length === 1) {
  const [{ park, reason }] = failures;
  console.log(
    `::notice title=一部確認できませんでした::成功 ${successfulParks}/${parks.length}公園。未確認: ${park}（${reason}）。連続失敗には数えません`
  );
} else {
  console.log(
    `::notice title=監視完了::対象 ${parks.length}公園をすべて確認しました`
  );
}
