import "server-only";
import { sql } from "drizzle-orm";
import { db, ts } from "@/db";
import { gatewayEvents, notifications } from "@/db/schema";
import { gateway } from "@/lib/gateway";
import { autoReleaseStale } from "@/lib/tickets";
import { flushDue } from "@/lib/outbox";
import { getSettings } from "@/lib/settings";
import { publish } from "@/lib/events";
import { hourWib } from "@/lib/time";

/**
 * Pekerjaan berkala. SATU tempat, dipanggil dua pintu:
 * src/instrumentation.ts (proses web) dan /api/cron/tick (cron luar).
 *
 * Dulu keempat tugas ini hanya ada di dalam route handler, dan
 * instrumentation.ts memanggil sendiri dua di antaranya. Akibatnya pemantauan
 * gateway dan alarm "sepi padahal jam ramai" TIDAK PERNAH jalan kecuali ada
 * yang menembak endpoint-nya - dan tidak ada yang menembak.
 *
 * Yang hilang karena itu persis mimpi buruk section 15: gateway bisa putus dan
 * tidak ada satu pun yang memberi tahu. Duplikasi logika di dua pintu adalah
 * cara paling mudah menciptakan lubang seperti itu, jadi sekarang tidak ada
 * duplikasi sama sekali.
 */
export type HasilDetak = {
  released: number;
  sent: number;
  failed: number;
  gateway: string;
  quietAlert: boolean;
};

export async function jalankanDetak(): Promise<HasilDetak> {
  const [released, outboxRes, gw, quiet] = await Promise.all([
    autoReleaseStale(), // section 6.3
    flushDue(), // section 9.4
    pollGateway(), // section 15
    checkQuiet(), // section 15
  ]);

  return { released, ...outboxRes, gateway: gw, quietAlert: quiet };
}

/**
 * section 15 "Gateway putus tanpa ketahuan - ini mimpi buruknya: dashboard terlihat
 * normal, antrean sepi, tim santai, padahal pesan masuk terus."
 *
 * Webhook connection.update saja tidak cukup: kalau gateway MATI, tidak ada
 * yang mengirim webhook apa pun. Jadi kita yang bertanya, bukan menunggu.
 */
async function pollGateway(): Promise<string> {
  let state = "error";
  try {
    state = (await gateway().status()).state;
  } catch {
    state = "disconnected";
  }

  const last = await db
    .select({ state: gatewayEvents.state, createdAt: gatewayEvents.createdAt })
    .from(gatewayEvents)
    .orderBy(sql`${gatewayEvents.createdAt} DESC`)
    .limit(1);

  if (last[0]?.state === state) {
    if (state !== "connected") await maybeAlertDown(last[0].createdAt);
    return state;
  }

  await db.insert(gatewayEvents).values({
    instance: process.env.GATEWAY_INSTANCE ?? "default",
    state: state as "connected" | "disconnected" | "qr_required" | "error",
    detail: { sumber: "polling" },
  });
  await publish({ t: "gateway", state });
  return state;
}

async function maybeAlertDown(since: Date): Promise<void> {
  const cfg = await getSettings(["gateway.alert_after_min"] as const);
  const downMin = (Date.now() - since.getTime()) / 60_000;
  if (downMin < cfg["gateway.alert_after_min"]) return;

  // Jangan membanjiri: satu peringatan per 15 menit.
  const recent = await db.execute(sql`
    SELECT 1 FROM notifications
    WHERE kind = 'gateway_down' AND created_at > now() - interval '15 minutes'
    LIMIT 1
  `);
  if ((recent as unknown as unknown[]).length) return;

  await db.insert(notifications).values({
    kind: "gateway_down",
    title: `Gateway terputus lebih dari ${Math.round(downMin)} menit`,
    detail: { sejak: since.toISOString() },
  });
  await publish({ t: "notification", kind: "gateway_down" });
}

/**
 * section 15 "Sepi beneran vs sepi karena rusak: alarm kalau tidak ada pesan masuk
 * melebihi ambang, padahal jam ramai."
 *
 * Menangkap kelas kegagalan yang tidak terlihat dari status koneksi: sesi
 * "tersambung" tapi webhook tidak pernah sampai karena URL salah, firewall,
 * atau grup ter-nonaktif tanpa sengaja.
 */
async function checkQuiet(): Promise<boolean> {
  const cfg = await getSettings(["gateway.quiet_alert_min", "gateway.busy_hours"] as const);
  const [from, to] = cfg["gateway.busy_hours"];
  const hour = hourWib(new Date());
  if (hour < from || hour >= to) return false;

  const rows = await db.execute(sql`SELECT max(ingested_at) AS at FROM messages`);
  const at = (rows as unknown as { at: string | null }[])[0]?.at;
  // Database kosong bukan "sepi mencurigakan" - belum ada apa-apa untuk dibandingkan.
  if (!at) return false;

  const quietMin = (Date.now() - new Date(at).getTime()) / 60_000;
  if (quietMin < cfg["gateway.quiet_alert_min"]) return false;

  const recent = await db.execute(sql`
    SELECT 1 FROM notifications
    WHERE kind = 'quiet_hours' AND created_at > now() - interval '30 minutes'
    LIMIT 1
  `);
  if ((recent as unknown as unknown[]).length) return false;

  await db.insert(notifications).values({
    kind: "quiet_hours",
    title: `Tidak ada pesan masuk ${Math.round(quietMin)} menit padahal jam ramai`,
    detail: { terakhir: at },
  });
  await publish({ t: "notification", kind: "quiet_hours" });
  return true;
}

void ts;
