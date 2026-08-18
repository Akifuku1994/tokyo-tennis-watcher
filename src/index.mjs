import { readFile, writeFile } from "node:fs/promises";
import { sendAvailabilityMail } from "./mail.mjs";
import {
  AccessBlockedError,
  SiteUnavailableError,
  scanPark
} from "./scraper.mjs";

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

await saveState();

if (failures.length > 0) {
  const details = failures
    .map(({ park, reason }) => `${park}: ${reason}`)
    .join(" / ");

  console.error(
    `::error title=監視未完了::成功 ${successfulParks}/${parks.length}公園。確認失敗: ${details}`
  );
  throw new Error(
    `監視未完了: 成功 ${successfulParks}/${parks.length}公園`
  );
}

console.log(
  `::notice title=監視完了::対象 ${parks.length}公園をすべて確認しました`
);
