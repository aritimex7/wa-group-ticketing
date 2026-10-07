"use server";

import { revalidatePath } from "next/cache";
import { and, eq, inArray, ne } from "drizzle-orm";
import { db } from "@/db";
import {
  agents,
  groups,
  ignoredPhrases,
  internalNumbers,
  mentionListMembers,
  mentionLists,
  quickReplies,
} from "@/db/schema";
import { hashPassword, requireLeader } from "@/lib/auth";
import { writeSetting, type SettingKey } from "@/lib/settings";
import { invalidateFilterCache } from "@/lib/tickets";
import { normalizeMsisdn, toIdentity, DOMAIN_PN, DOMAIN_LID } from "@/lib/identity";
import { gateway } from "@/lib/gateway";
import { handleGroupMeta } from "@/lib/ingest";

export type Hasil = { ok: boolean; pesan: string };

const num = (fd: FormData, k: string, d: number) => {
  const v = Number(fd.get(k));
  return Number.isFinite(v) ? v : d;
};
const bool = (fd: FormData, k: string) => fd.get(k) === "on" || fd.get(k) === "true";

/** Nilai dari form tidak boleh dipercaya - hanya tiga peran yang sah. */
function bacaPeran(v: FormDataEntryValue | null): "agent" | "leader" | "sla" {
  return v === "leader" ? "leader" : v === "sla" ? "sla" : "agent";
}

function refresh() {
  // Varian "layout" wajib: sejak Setelan dipecah jadi tab, revalidasi
  // "/setelan" saja tidak menyentuh /setelan/grup dan kawan-kawannya, jadi
  // tab yang baru disimpan akan menampilkan nilai lama.
  revalidatePath("/setelan", "layout");
  revalidatePath("/");
  revalidatePath("/leader");
}

/* --------------------------------- SLA & pemicu --------------------------------- */

export async function simpanSla(fd: FormData): Promise<void> {
  const me = await requireLeader();
  const pairs: [SettingKey, number][] = [
    ["sla.first_response_min", num(fd, "fr", 15)],
    ["sla.resolution_min", num(fd, "res", 120)],
    ["sla.warn_threshold_pct", num(fd, "warn", 80)],
  ];
  // writeSetting selalu menulis settings_audit (section 4.6) - tidak ada jalan pintas.
  for (const [k, v] of pairs) await writeSetting(k, v, me.id);
  refresh();
}

export async function simpanPemicu(fd: FormData): Promise<void> {
  const me = await requireLeader();
  await writeSetting("trigger.mention_creates_ticket", bool(fd, "mention"), me.id);
  await writeSetting("ingest.dm_enabled", bool(fd, "dm"), me.id);
  await writeSetting("trigger.dm_creates_ticket", bool(fd, "dmTiket"), me.id);
  await writeSetting("trigger.reply_creates_ticket", bool(fd, "reply"), me.id);
  await writeSetting("ticket.merge_window_min", Math.max(0, num(fd, "gabung", 120)), me.id);
  refresh();
}

export async function simpanTandaTangan(fd: FormData): Promise<void> {
  const me = await requireLeader();
  await writeSetting("signature.prefix", String(fd.get("prefix") ?? "#dsp").trim() || "#dsp", me.id);
  await writeSetting("signature.auto_insert", bool(fd, "auto"), me.id);
  await writeSetting("signature.lenient_match", bool(fd, "lenient"), me.id);
  refresh();
}

export async function simpanOperasional(fd: FormData): Promise<void> {
  const me = await requireLeader();
  await writeSetting("ops.auto_release_min", num(fd, "release", 10), me.id);
  await writeSetting("ops.undo_seconds", num(fd, "undo", 5), me.id);
  await writeSetting("ops.session_idle_min", num(fd, "idle", 15), me.id);
  await writeSetting("ops.auto_monitor_new_groups", bool(fd, "autopantau"), me.id);
  await writeSetting(
    "ops.on_check_text",
    String(fd.get("oncheck") ?? "").trim() || "Baik, kami cek dulu ya. Mohon ditunggu.",
    me.id,
  );
  refresh();
}

export async function simpanAlarm(fd: FormData): Promise<void> {
  const me = await requireLeader();
  await writeSetting("gateway.alert_after_min", num(fd, "after", 3), me.id);
  await writeSetting("gateway.quiet_alert_min", num(fd, "quiet", 45), me.id);
  await writeSetting("gateway.busy_hours", [num(fd, "busyFrom", 8), num(fd, "busyTo", 21)], me.id);
  refresh();
}

export async function simpanIpAllowlist(fd: FormData): Promise<void> {
  const me = await requireLeader();
  const list = String(fd.get("daftar") ?? "")
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
  await writeSetting("access.ip_allowlist", list, me.id);
  refresh();
}

/* ------------------------------------ grup ------------------------------------ */

/**
 * Simpan SEMUA baris grup dari satu form, satu tombol.
 *
 * Setiap baris yang terkirim ditulis - termasuk yang tidak disentuh. Jadi satu
 * klik Simpan sekaligus menandai seluruh daftar sudah ditinjau: tanda BARU,
 * BELUM DITINJAU hilang dari semuanya, bukan cuma dari yang diubah. Itu memang
 * yang diminta - tombolnya berarti "daftar ini sudah saya lihat dan beginilah
 * seharusnya", bukan "tolong simpan yang berubah saja".
 *
 * Yang perlu diingat: `monitorDecidedAt` ikut tercap untuk semua baris, dan
 * kolom itu yang dipakai ingest.ts:158 untuk memutuskan apakah auto-pantau
 * (ops.auto_monitor_new_groups) masih boleh menyalakan grup saat pesan masuk.
 * Sesudah Simpan pertama, auto-pantau tidak akan lagi menyentuh grup yang sudah
 * ada di daftar ini - hanya grup yang lahir sesudahnya. Pengaktifan grup
 * lama jadi urusan tombol ini dan tombol Tarik nama grup.
 */
export async function simpanSemuaGrup(fd: FormData): Promise<void> {
  await requireLeader();

  /* Baris dikirim dengan akhiran indeks (jid.0, nama.0, ...). `jid.i` selalu ada,
     jadi indeks yang hilang berarti daftarnya habis. */
  let ditulis = 0;

  for (let i = 0; fd.has(`jid.${i}`); i++) {
    const jid = String(fd.get(`jid.${i}`));
    const fr = String(fd.get(`fr.${i}`) ?? "").trim();
    const res = String(fd.get(`res.${i}`) ?? "").trim();
    const cap = new Date();

    await db
      .update(groups)
      .set({
        // section 4.1 default nonaktif; ini satu-satunya tempat grup diaktifkan.
        // Checkbox yang tidak dicentang TIDAK terkirim - ketidakhadirannya itulah "false".
        isMonitored: bool(fd, `pantau.${i}`),
        clientLabel: String(fd.get(`label.${i}`) ?? "").trim() || null,
        name: String(fd.get(`nama.${i}`) ?? "").trim() || null,
        slaFirstResponseMin: fr ? Number(fr) : null,
        slaResolutionMin: res ? Number(res) : null,
        acknowledgedAt: cap,
        monitorDecidedAt: cap,
      })
      // JID karangan tidak cocok dengan baris mana pun - 0 baris tersentuh.
      .where(eq(groups.jid, jid));
    ditulis++;
  }

  if (!ditulis) return;
  refresh();
}

/* ------------------------------------ agen ------------------------------------ */

export async function tambahAgen(fd: FormData): Promise<void> {
  await requireLeader();

  const name = String(fd.get("nama") ?? "").trim();
  const username = String(fd.get("username") ?? "").trim().toLowerCase();
  const password = String(fd.get("sandi") ?? "");
  const code = String(fd.get("kode") ?? "").trim().toLowerCase();
  const role = bacaPeran(fd.get("role"));

  if (!name || !username || password.length < 8 || !code) return;

  // section 4.2 signature_code UNIQUE, wajib divalidasi. Constraint database sudah
  // menjaga, tapi ditolak lebih awal supaya pesannya bisa dimengerti manusia.
  const bentrok = await db.select({ id: agents.id }).from(agents).where(eq(agents.signatureCode, code)).limit(1);
  if (bentrok.length) return;

  await db.insert(agents).values({
    name,
    username,
    passwordHash: await hashPassword(password),
    signatureCode: code,
    role,
  });
  refresh();
}

export async function ubahAgen(fd: FormData): Promise<void> {
  await requireLeader();
  const id = Number(fd.get("id"));
  const code = String(fd.get("kode") ?? "").trim().toLowerCase();

  if (code) {
    const bentrok = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.signatureCode, code), ne(agents.id, id)))
      .limit(1);
    if (bentrok.length) return; // kode kembar - tolak diam, UI menampilkan nilai lama
  }

  await db
    .update(agents)
    .set({
      role: bacaPeran(fd.get("role")),
      // section 4.2 NONAKTIFKAN, jangan pernah DELETE.
      isActive: bool(fd, "aktif"),
      ...(code ? { signatureCode: code } : {}),
    })
    .where(eq(agents.id, id));
  refresh();
}

export async function resetSandi(fd: FormData): Promise<void> {
  await requireLeader();
  const id = Number(fd.get("id"));
  const sandi = String(fd.get("sandi") ?? "");
  if (sandi.length < 8) return;
  await db.update(agents).set({ passwordHash: await hashPassword(sandi) }).where(eq(agents.id, id));
  refresh();
}

/* ------------------------- nomor internal & frasa ------------------------- */

export async function tambahNomorInternal(fd: FormData): Promise<void> {
  const me = await requireLeader();
  const raw = String(fd.get("nomor") ?? "").trim();
  if (!raw) return;

  // section 3.1 dua kolom. LID tidak bisa diturunkan dari nomor, jadi kalau leader
  // hanya tahu nomornya, kolom lid dibiarkan kosong - bukan ditebak.
  const lidRaw = String(fd.get("lid") ?? "").trim();
  const id = toIdentity(
    `${normalizeMsisdn(raw)}@${DOMAIN_PN}`,
    lidRaw ? `${lidRaw}@${DOMAIN_LID}` : null,
  );

  await db.insert(internalNumbers).values({
    label: String(fd.get("label") ?? "").trim() || null,
    pn: id.pn,
    lid: id.lid,
    createdBy: me.id,
  });
  invalidateFilterCache();
  refresh();
}

export async function hapusNomorInternal(fd: FormData): Promise<void> {
  await requireLeader();
  await db
    .update(internalNumbers)
    .set({ isActive: false })
    .where(eq(internalNumbers.id, Number(fd.get("id"))));
  invalidateFilterCache();
  refresh();
}

export async function tambahFrasa(fd: FormData): Promise<void> {
  const me = await requireLeader();
  const phrase = String(fd.get("frasa") ?? "").trim();
  if (!phrase) return;
  await db.insert(ignoredPhrases).values({
    phrase,
    matchMode: fd.get("mode") === "prefix" ? "prefix" : "exact",
    createdBy: me.id,
  });
  invalidateFilterCache();
  refresh();
}

export async function hapusFrasa(fd: FormData): Promise<void> {
  await requireLeader();
  await db.update(ignoredPhrases).set({ isActive: false }).where(eq(ignoredPhrases.id, Number(fd.get("id"))));
  invalidateFilterCache();
  refresh();
}

/* ------------------------------ balasan cepat ------------------------------ */

/* --------------------- 12 daftar tag --------------------- */

/** Nama yang diketik sesudah "@": huruf kecil, tanpa spasi, tanpa "@". */
function bersihkanSlug(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^@+/, "")
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30);
}

export async function tambahDaftarTag(fd: FormData): Promise<void> {
  const me = await requireLeader();
  const slug = bersihkanSlug(String(fd.get("slug") ?? ""));
  /* Harus diawali huruf - kalau diawali angka ia tidak akan pernah cocok
     dengan pola daftar, dan malah bisa tertukar dengan mention orang. */
  if (!slug || !/^[a-z]/.test(slug)) return;

  await db
    .insert(mentionLists)
    .values({
      slug,
      label: String(fd.get("label") ?? "").trim() || slug,
      createdBy: me.id,
    })
    /* Slug yang sama pernah dinonaktifkan? Hidupkan lagi, jangan menolak diam-diam. */
    .onConflictDoUpdate({
      target: mentionLists.slug,
      set: { isActive: true, label: String(fd.get("label") ?? "").trim() || slug },
    });
  refresh();
}

export async function hapusDaftarTag(fd: FormData): Promise<void> {
  await requireLeader();
  await db
    .update(mentionLists)
    .set({ isActive: false })
    .where(eq(mentionLists.id, Number(fd.get("id"))));
  refresh();
}

export async function tambahAnggotaDaftar(fd: FormData): Promise<void> {
  await requireLeader();
  const listId = Number(fd.get("listId"));
  const raw = String(fd.get("nomor") ?? "").trim();
  if (!listId || !raw) return;

  // section 3.1 dua kolom. LID tidak bisa diturunkan dari nomor - dibiarkan kosong.
  const lidRaw = String(fd.get("lid") ?? "").trim();
  const id = toIdentity(
    `${normalizeMsisdn(raw)}@${DOMAIN_PN}`,
    lidRaw ? `${lidRaw}@${DOMAIN_LID}` : null,
  );
  if (!id.pn && !id.lid) return;

  await db.insert(mentionListMembers).values({
    listId,
    pn: id.pn,
    lid: id.lid,
    label: String(fd.get("label") ?? "").trim() || null,
  });
  refresh();
}

export async function hapusAnggotaDaftar(fd: FormData): Promise<void> {
  await requireLeader();
  await db.delete(mentionListMembers).where(eq(mentionListMembers.id, Number(fd.get("id"))));
  refresh();
}

export async function tambahTemplate(fd: FormData): Promise<void> {
  await requireLeader();
  const title = String(fd.get("judul") ?? "").trim();
  const body = String(fd.get("isi") ?? "").trim();
  if (!title || !body) return;
  await db.insert(quickReplies).values({ title, body });
  refresh();
}

export async function hapusTemplate(fd: FormData): Promise<void> {
  await requireLeader();
  await db.update(quickReplies).set({ isActive: false }).where(eq(quickReplies.id, Number(fd.get("id"))));
  refresh();
}

/**
 * Tarik nama semua grup dari WhatsApp sekaligus.
 *
 * Peristiwa groups.upsert hanya datang saat grup dibuat atau namanya diubah -
 * grup yang sudah lama ada tidak pernah mengirimkannya. Tanpa tombol ini,
 * nama grup lama selamanya kosong dan leader harus mengetik satu per satu.
 *
 * Nama yang sudah diketik leader tidak ditimpa (lihat handleGroupMeta).
 */
export async function sinkronNamaGrup(): Promise<void> {
  await requireLeader();
  let daftar: { jid: string; subject: string | null }[] = [];
  try {
    daftar = await gateway().fetchGroups();
  } catch (err) {
    console.error("[setelan] gagal menarik daftar grup:", (err as Error).message);
    return;
  }
  for (const g of daftar) await handleGroupMeta(g.jid, g.subject);

  /*
   * PERMINTAAN PEMILIK: setiap tarikan daftar langsung mencentang Pantau.
   *
   * Ini membalik keputusan yang ditulis di ingest.ts:371 - di sana disengaja
   * bahwa grup yang lahir dari tarikan daftar tetap nonaktif, supaya satu klik
   * tidak menyalakan belasan grup sekaligus. Sekarang justru itu yang diminta:
   * yang dibeli, tidak ada pesan yang lewat hanya karena belum dicentang; yang
   * dibayar, isi SEMUA grup yang diikuti nomor ini ikut tersimpan - termasuk
   * grup pribadi yang bukan klien.
   *
   * Tanpa syarat, jadi grup yang sebelumnya sengaja dimatikan akan menyala lagi
   * di tarikan berikutnya. Itu konsekuensi yang diminta ("setiap"), bukan
   * kelalaian - kalau suatu grup harus tetap mati, matikan lewat Simpan dan
   * jangan menekan tombol ini lagi, atau tambahkan syarat monitorDecidedAt di
   * sini.
   *
   * Hanya menyentuh grup yang benar-benar ada di tarikan ini; baris lain di
   * tabel tidak ikut.
   */
  const jids = daftar.map((g) => g.jid);
  if (jids.length) {
    await db
      .update(groups)
      .set({ isMonitored: true })
      .where(and(inArray(groups.jid, jids), eq(groups.isMonitored, false)));
  }

  refresh();
}
