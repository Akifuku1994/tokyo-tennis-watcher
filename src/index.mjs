import { readFile, writeFile } from "node:fs/promises";
import { sendAvailabilityMail } from "./mail.mjs";
import { scanPark } from "./scraper.mjs";

const config = JSON.parse(
  await readFile(new URL("../config.json", import.meta.url), "utf8")
);

const stateUrl = new URL("../data/state.json", import.meta.url);
const state = JSON.parse(await readFile(stateUrl, "utf8"));
const now = new Date();

const forcedPark = process.env.PARK_NAME;
const parks = forcedPark ? [forcedPark] : config.parks;

console.log(`監視対象: ${parks.join("、")}`);

for (const park of parks) {
  console.log(`確認中: ${park}`);

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

  console.log(
    `${park}: 空き ${slots.length}件、新規 ${newSlots.length}件`
  );
}

state.cooldownUntil = null;

await writeFile(
  stateUrl,
  `${JSON.stringify(state, null, 2)}\n`
);

console.log(
  `::notice title=監視完了::対象の${parks.length}公園すべてを確認しました`
);
