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

state.parks ||= {};
delete state.lastSuccessfulCheckAt;
delete state.lastRunAt;

function millisecondsUntil(iso) {
  const value = Date.parse(iso || "");
  return Number.isFinite(value) ? value - now.getTime() : 0;
}

async function saveState() {
  await writeFile(stateUrl, `${JSON.stringify(state, null, 2)}\n`);
}

if (!forcedPark && millisecondsUntil(state.cooldownUntil) > 0) {
  console.log(
    `::notice title=監視を休止中::アクセス制限対策のため ${state.cooldownUntil} まで休止します`
  );
  process.exit(0);
}

console.log(`監視対象: ${parks.join("、")}`);

let successfulParks = 0;
let unavailableParks = 0;
let accessBlocked = false;

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
    if (error instanceof AccessBlockedError) {
      const cooldownHours = Number(
        config.accessBlockCooldownHours || 6
      );
      state.cooldownUntil = new Date(
        now.getTime() + cooldownHours * 60 * 60_000
      ).toISOString();
      accessBlocked = true;
      unavailableParks += 1;
      console.log(
        `::warning title=アクセス制限を検知::${state.cooldownUntil} まで監視を休止します`
      );
      break;
    }

    if (error instanceof SiteUnavailableError) {
      unavailableParks += 1;
      console.log(
        `::warning title=${park}を確認できませんでした::${error.message}`
      );
      continue;
    }

    throw error;
  }
}

if (successfulParks > 0 && !accessBlocked) {
  state.cooldownUntil = null;
}

await saveState();

console.log(
  `::notice title=監視完了::成功 ${successfulParks}公園、確認不能 ${unavailableParks}公園`
);
