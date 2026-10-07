/**
 * Kosongkan seluruh data operasional. Akun agen dan konfigurasi tetap.
 *
 *   npm run db:reset          -- pratinjau, tidak menghapus apa pun
 *   npm run db:reset -- --ya  -- benar-benar hapus
 *
 * DIHAPUS
 *   messages, tickets, ticket_events, triage_bucket, agent_seen, outbox,
 *   notifications, gateway_events, archive_messages, groups
 *
 * DIPERTAHANKAN, dan alasannya
 *   agents          menghapusnya = kehilangan login, dan section 4.2 melarang DELETE
 *                   agen sama sekali (statistik lama ikut rusak). Nonaktifkan
 *                   lewat Setelan kalau memang tidak dipakai lagi.
 *   sessions        bukan data, cuma keadaan login. Dibiarkan supaya tidak
 *                   melempar semua orang keluar di tengah kerja.
 *   settings +      section 4.6: jejak perubahan setelan tidak boleh diputus. Justru
 *   settings_audit  setelah reset, riwayat "target SLA pernah berapa" makin penting.
 *   ignored_phrases konfigurasi hasil pemikiran, bukan data percobaan.
 *   quick_replies
 *
 * TIDAK DISENTUH: var/raw/*.jsonl (dump Fase 0). Berkas itu tetap ada di disk
 * dan masih bisa diputar ulang - artinya percakapan klien BELUM benar-benar
 * hilang dari mesin ini. Hapus sendiri kalau memang itu yang diinginkan.
 */
import "dotenv/config";
import { sql } from "drizzle-orm";
import { db, getSql } from "../src/db";

const jalankan = process.argv.includes("--ya");

const TABEL_DIHAPUS = [
  "agent_seen",
  "outbox",
  "ticket_events",
  "triage_bucket",
  "tickets",
  "messages",
  "notifications",
  "gateway_events",
  "archive_messages",
  "groups",
] as const;

const TABEL_DIPERTAHANKAN = [
  "agents",
  "sessions",
  "settings",
  "settings_audit",
  "ignored_phrases",
  "quick_replies",
] as const;

async function hitung(tabel: readonly string[]): Promise<[string, number][]> {
  const out: [string, number][] = [];
  for (const t of tabel) {
    const r = (await db.execute(sql`SELECT count(*)::int AS n FROM ${sql.identifier(t)}`)) as unknown as {
      n: number;
    }[];
    out.push([t, Number(r[0]?.n ?? 0)]);
  }
  return out;
}

async function main() {
  const hapus = await hitung(TABEL_DIHAPUS);
  const simpan = await hitung(TABEL_DIPERTAHANKAN);
  const total = hapus.reduce((a, [, n]) => a + n, 0);

  console.log("\nAKAN DIHAPUS");
  for (const [t, n] of hapus) console.log(`  ${t.padEnd(18)} ${n}`);
  console.log("\nDIPERTAHANKAN");
  for (const [t, n] of simpan) console.log(`  ${t.padEnd(18)} ${n}`);

  if (!jalankan) {
    console.log(`\n${total} baris akan dihapus. Ini baru pratinjau.`);
    console.log("Tambahkan --ya untuk benar-benar menghapus:\n  npm run db:reset -- --ya\n");
    return;
  }

  if (total === 0) {
    console.log("\nSudah kosong - tidak ada yang dihapus.\n");
    return;
  }

  /* Satu transaksi, urut mengikuti arah foreign key: anak dulu, induk terakhir.
     Kalau satu langkah gagal, tidak ada yang setengah terhapus. */
  await db.transaction(async (tx) => {
    for (const t of TABEL_DIHAPUS) {
      await tx.execute(sql`DELETE FROM ${sql.identifier(t)}`);
    }
  });

  const sesudah = await hitung(TABEL_DIHAPUS);
  console.log("\nSESUDAH");
  for (const [t, n] of sesudah) console.log(`  ${t.padEnd(18)} ${n}`);
  console.log("\nCatatan: var/raw/*.jsonl tidak disentuh - payload mentah masih di disk.\n");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await getSql().end();
  });
