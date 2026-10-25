import nodemailer from "nodemailer";

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`GitHub Secret ${name} が設定されていません`);
  return value;
}

export async function sendAvailabilityMail({ park, newSlots, reservationUrl }) {
  if (newSlots.length === 0) return;
  if (process.env.DRY_RUN === "1") {
    console.log(`[DRY RUN] ${park}: ${newSlots.length}件を通知予定`);
    return;
  }
  const host = required("SMTP_HOST");
  const port = Number(process.env.SMTP_PORT || 465);
  const user = required("SMTP_USER");
  const pass = required("SMTP_PASS");
  const to = "sp.m.wi1994@gmail.com";

  const transporter = nodemailer.createTransport({ host, port, secure: port === 465, auth: { user, pass } });
  const lines = newSlots.map(slot => `・${slot.date} ${slot.time}（空き ${slot.count}面）`);
  await transporter.sendMail({
    from: process.env.MAIL_FROM || user,
    to,
    subject: `【テニス空き】${park}に空きが出ました`,
    text: `${park}で新しい空きを検出しました。\n\n${lines.join("\n")}\n\n予約画面：${reservationUrl}\n\n※通知時点の情報です。予約を保証するものではありません。`
  });
}

export async function sendTestMail() {
  const host = required("SMTP_HOST");
  const port = Number(process.env.SMTP_PORT || 465);
  const user = required("SMTP_USER");
  const pass = required("SMTP_PASS");
  const to = "sp.m.wi1994@gmail.com";

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass }
  });
  await transporter.sendMail({
    from: process.env.MAIL_FROM || user,
    to,
    subject: "【テニス空き通知】メール送信テスト",
    text: "これは都立公園テニスコート空き通知システムの送信テストです。\n\nこのメールが届けば、GitHub ActionsからSMTP経由でメールを送信できています。\n実際の空き通知とは異なり、予約枠の検出は行っていません。"
  });
}
