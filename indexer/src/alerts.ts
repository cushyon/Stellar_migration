import { prisma } from "./db.js";
import { config } from "./config.js";

/// An alert has a stable `key`, so the same problem is one alert whatever the
/// numbers in its message say. A cycle reports every alert that is true now.
export interface Alert {
  key: string;
  message: string;
}

type Log = { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void };

/// Compare the alerts of this cycle with the ones that are open, then send what
/// changed: a new alert, a reminder after `ALERT_REPEAT_MINUTES`, or a message
/// when an alert clears. A channel that fails never stops the cycle.
export async function notifyAlerts(vault: string, alerts: Alert[], log?: Log): Promise<void> {
  const open = await prisma.alertState.findMany({ where: { vault, active: true } });
  const openByKey = new Map(open.map((row) => [row.key, row]));
  const now = new Date();
  const repeatMs = config.alerts.repeatMinutes * 60_000;

  for (const alert of alerts) {
    const id = `${vault}:${alert.key}`;
    const existing = openByKey.get(alert.key);

    if (!existing) {
      await prisma.alertState.upsert({
        where: { id },
        create: { id, vault, key: alert.key, message: alert.message, active: true, lastSentAt: now },
        update: { message: alert.message, active: true, firstSeenAt: now, lastSentAt: now, resolvedAt: null },
      });
      await send(`ALERT ${alert.key}: ${alert.message}`, vault, log);
      continue;
    }

    const due = !existing.lastSentAt || now.getTime() - existing.lastSentAt.getTime() >= repeatMs;
    if (due) {
      const since = Math.round((now.getTime() - existing.firstSeenAt.getTime()) / 60_000);
      await prisma.alertState.update({ where: { id }, data: { message: alert.message, lastSentAt: now } });
      await send(`STILL OPEN ${alert.key} (${since} min): ${alert.message}`, vault, log);
    } else {
      await prisma.alertState.update({ where: { id }, data: { message: alert.message } });
    }
    openByKey.delete(alert.key);
  }

  // Whatever stayed in the map is not true any more.
  for (const [key, row] of openByKey) {
    await prisma.alertState.update({
      where: { id: row.id },
      data: { active: false, resolvedAt: now },
    });
    await send(`CLEARED ${key}: ${row.message}`, vault, log);
  }
}

/// Send one line to every channel that is configured. Each channel is tried on
/// its own, so one broken channel does not hide the other.
async function send(text: string, vault: string, log?: Log): Promise<void> {
  const line = `[${config.alerts.label}] ${text} (vault ${vault.slice(0, 6)}...)`;
  log?.warn(`[alert] ${text}`);

  const { telegramBotToken, telegramChatId, webhookUrl, timeoutMs } = config.alerts;

  if (telegramBotToken && telegramChatId) {
    try {
      const response = await fetch(`https://api.telegram.org/bot${telegramBotToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: telegramChatId, text: line }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) log?.error(`[alert] telegram answered ${response.status}`);
    } catch (e) {
      log?.error(`[alert] telegram failed: ${(e as Error).message}`);
    }
  }

  if (webhookUrl) {
    try {
      const response = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: line, vault }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) log?.error(`[alert] webhook answered ${response.status}`);
    } catch (e) {
      log?.error(`[alert] webhook failed: ${(e as Error).message}`);
    }
  }
}
