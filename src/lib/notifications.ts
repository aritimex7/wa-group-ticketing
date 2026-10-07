import "server-only";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { groups, notifications } from "@/db/schema";

/**
 * Notifikasi untuk leader - SPEC section 5 dan section 15.
 *
 * section 5 : "Grup baru: kalau webhook datang dari grup yang belum ada di tabel
 *         groups, buat recordnya dengan is_monitored = FALSE dan kirim
 *         notifikasi ke leader."
 * section 15: alarm gateway putus dan alarm "sepi padahal jam ramai".
 *
 * Sebelum berkas ini ada, barisnya ditulis rajin ke tabel notifications dan
 * tidak pernah dibaca siapa pun. Itu lebih buruk daripada tidak ada notifikasi
 * sama sekali: sistemnya terlihat seolah memberi tahu, padahal tidak - dan
 * grup baru yang belum dipantau berarti pesan klien masuk tanpa disimpan.
 */

export type Notif = {
  id: number;
  kind: string;
  title: string;
  detail: Record<string, unknown> | null;
  createdAt: Date;
  /** khusus new_group: apakah grupnya sudah diaktifkan leader. */
  sudahDipantau: boolean | null;
  groupJid: string | null;
};

/** Yang belum dibaca, terbaru dulu. */
export async function belumDibaca(limit = 20): Promise<Notif[]> {
  const rows = await db
    .select({
      id: notifications.id,
      kind: notifications.kind,
      title: notifications.title,
      detail: notifications.detail,
      createdAt: notifications.createdAt,
    })
    .from(notifications)
    .where(and(eq(notifications.forRole, "leader"), isNull(notifications.readAt)))
    .orderBy(desc(notifications.createdAt))
    .limit(limit);

  /* Untuk notifikasi grup baru, keadaan grupnya sekarang jauh lebih berguna
     daripada judulnya: "sudah diaktifkan" berarti tidak perlu tindakan lagi. */
  const jids = rows
    .map((r) => (r.detail as { jid?: string } | null)?.jid)
    .filter((j): j is string => typeof j === "string");

  const keadaan = new Map<string, boolean>();
  if (jids.length) {
    const g = await db
      .select({ jid: groups.jid, isMonitored: groups.isMonitored })
      .from(groups)
      .where(sql`${groups.jid} IN (${sql.join(jids.map((j) => sql`${j}`), sql`, `)})`);
    for (const x of g) keadaan.set(x.jid, x.isMonitored);
  }

  return rows.map((r) => {
    const jid = (r.detail as { jid?: string } | null)?.jid ?? null;
    return {
      ...r,
      detail: r.detail as Record<string, unknown> | null,
      groupJid: jid,
      sudahDipantau: jid ? (keadaan.get(jid) ?? null) : null,
    };
  });
}

export async function jumlahBelumDibaca(): Promise<number> {
  const r = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(notifications)
    .where(and(eq(notifications.forRole, "leader"), isNull(notifications.readAt)));
  return Number(r[0]?.n ?? 0);
}

export async function tandaiDibaca(id: number): Promise<void> {
  await db.update(notifications).set({ readAt: new Date() }).where(eq(notifications.id, id));
}

export async function tandaiSemuaDibaca(): Promise<void> {
  await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(and(eq(notifications.forRole, "leader"), isNull(notifications.readAt)));
}

/**
 * Grup yang terdeteksi tapi belum pernah ditinjau leader.
 *
 * Ini pertanyaan yang sebenarnya ingin dijawab leader - bukan "ada notifikasi
 * apa", tapi "ada grup yang pesannya sedang TIDAK disimpan?".
 *
 * is_monitored IKUT DIKEMBALIKAN dan pemanggilnya WAJIB memakainya. Sejak
 * ops.auto_monitor_new_groups boleh dinyalakan, "belum ditinjau" tidak lagi
 * berarti "tidak disimpan": grup bisa langsung menyala begitu ada pesan
 * pertama dan tetap menunggu leader memberinya nama. Dua keadaan itu butuh
 * kalimat yang berbeda, dan menyamakannya membuat panel Perlu Perhatian
 * mengumumkan kehilangan data yang tidak terjadi - persis jenis alarm palsu
 * yang bikin orang berhenti membaca panelnya.
 */
export async function grupBaru() {
  return db
    .select({
      jid: groups.jid,
      name: groups.name,
      createdAt: groups.createdAt,
      isMonitored: groups.isMonitored,
    })
    .from(groups)
    .where(isNull(groups.acknowledgedAt))
    .orderBy(desc(groups.createdAt));
}
