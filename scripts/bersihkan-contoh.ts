/**
 * Buang data contoh dari `npm run db:seed`, sisakan data WhatsApp asli.
 *
 *   npm run db:bersihkan          -- tampilkan apa yang AKAN dihapus, tanpa menghapus
 *   npm run db:bersihkan -- --ya  -- benar-benar hapus
 *
 * Yang DIPERTAHANKAN, dan alasannya:
 *
 *   akun agen        menghapusnya berarti kehilangan login. section 4.2 juga melarang
 *                    DELETE agen sama sekali - nonaktifkan lewat Setelan kalau
 *                    memang tidak dipakai lagi.
 *   grup nyata       apa pun yang JID-nya bukan bawaan seed.
 *   frasa & template konfigurasi yang berguna ("ok", "siap", "makasih"), bukan
 *                    data palsu. Hapus lewat halaman Setelan kalau tidak cocok.
 *   settings + audit section 4.6 - jejak perubahan setelan tidak boleh diputus.
 *
 * Aman diulang: kalau sudah bersih, tidak ada yang dihapus.
 */
import "dotenv/config";
import { sql } from "drizzle-orm";
import { db, getSql } from "../src/db";

/** JID grup contoh yang dibuat seed. Sengaja dicocokkan persis, bukan pola longgar,
 *  supaya tidak ada grup asli yang ikut terhapus karena namanya kebetulan mirip. */
const JID_CONTOH = [
  "6281100000001-1600000001@g.us",
  "6281100000002-1600000002@g.us",
  "6281100000003-1600000003@g.us",
  "6281100000004-1600000004@g.us",
  "6281100000005-1600000005@g.us",
];

const jalankan = process.argv.includes("--ya");

/**
 * Daftar untuk klausa IN.
 *
 * Jangan pakai `= ANY(${array})`: template `sql` drizzle memecah array jadi
 * banyak parameter terpisah, bukan satu parameter bertipe array, sehingga
 * Postgres menolak dengan "op ANY/ALL (array) requires array on right side".
 * Ini kerabat dekat jebakan Date di src/db/index.ts - keduanya soal apa yang
 * BISA diikat template `sql` sebagai satu parameter.
 */
const daftar = (nilai: string[]) => sql.join(nilai.map((v) => sql`${v}`), sql`, `);

async function hitung(): Promise<Record<string, number>> {
  const r = (await db.execute(sql`
    SELECT
      (SELECT count(*) FROM groups   WHERE jid IN (${daftar(JID_CONTOH)}))                    AS grup_contoh,
      (SELECT count(*) FROM groups   WHERE jid NOT IN (${daftar(JID_CONTOH)}))              AS grup_nyata,
      (SELECT count(*) FROM messages WHERE stanza_id LIKE 'SEED%')                      AS pesan_seed,
      (SELECT count(*) FROM messages WHERE stanza_id NOT LIKE 'SEED%')                  AS pesan_nyata,
      (SELECT count(*) FROM tickets  WHERE stanza_id LIKE 'SEED%')                      AS tiket_seed,
      (SELECT count(*) FROM tickets  WHERE stanza_id NOT LIKE 'SEED%')                  AS tiket_nyata,
      (SELECT count(*) FROM outbox)                                                     AS outbox,
      (SELECT count(*) FROM agents)                                                     AS agen
  `)) as unknown as Record<string, unknown>[];
  const row = r[0] ?? {};
  return Object.fromEntries(Object.entries(row).map(([k, v]) => [k, Number(v ?? 0)]));
}

async function main() {
  const sebelum = await hitung();

  console.log("\nSEBELUM");
  for (const [k, v] of Object.entries(sebelum)) console.log(`  ${k.padEnd(14)} ${v}`);

  const adaYangDihapus =
    sebelum.grup_contoh + sebelum.pesan_seed + sebelum.tiket_seed + sebelum.outbox > 0;

  if (!adaYangDihapus) {
    console.log("\nSudah bersih - tidak ada data contoh yang tersisa.\n");
    return;
  }

  if (!jalankan) {
    console.log("\nYANG AKAN DIHAPUS");
    console.log(`  ${sebelum.grup_contoh} grup contoh, ${sebelum.pesan_seed} pesan seed,`);
    console.log(`  ${sebelum.tiket_seed} tiket seed, ${sebelum.outbox} baris outbox`);
    console.log("\nYANG DIPERTAHANKAN");
    console.log(`  ${sebelum.agen} akun agen, ${sebelum.grup_nyata} grup nyata,`);
    console.log(`  ${sebelum.pesan_nyata} pesan nyata, ${sebelum.tiket_nyata} tiket nyata,`);
    console.log(`  frasa yang diabaikan, balasan cepat, settings + settings_audit`);
    console.log("\nIni baru pratinjau. Tambahkan --ya untuk benar-benar menghapus:");
    console.log("  npm run db:bersihkan -- --ya\n");
    return;
  }

  /* Satu transaksi: kalau ada satu langkah gagal, tidak ada yang setengah terhapus.
     Urutannya mengikuti arah foreign key - anak dulu, induk belakangan. */
  await db.transaction(async (tx) => {
    // outbox lebih dulu: ia menunjuk ke tickets, dan semua isinya kiriman percobaan.
    await tx.execute(sql`DELETE FROM outbox`);

    // penanda & keranjang yang menunjuk ke pesan/tiket seed
    await tx.execute(sql`DELETE FROM agent_seen WHERE ticket_id IN (
      SELECT id FROM tickets WHERE stanza_id LIKE 'SEED%')`);
    await tx.execute(sql`DELETE FROM triage_bucket WHERE stanza_id LIKE 'SEED%'`);

    // ticket_events ikut terhapus lewat ON DELETE CASCADE, tapi dieksplisitkan
    // supaya tidak bergantung pada perilaku yang tidak terlihat di berkas ini.
    await tx.execute(sql`DELETE FROM ticket_events WHERE ticket_id IN (
      SELECT id FROM tickets WHERE stanza_id LIKE 'SEED%')`);

    await tx.execute(sql`DELETE FROM tickets  WHERE stanza_id LIKE 'SEED%'`);
    await tx.execute(sql`DELETE FROM messages WHERE stanza_id LIKE 'SEED%'`);
    await tx.execute(sql`DELETE FROM groups   WHERE jid IN (${daftar(JID_CONTOH)})`);
  });

  const sesudah = await hitung();
  console.log("\nSESUDAH");
  for (const [k, v] of Object.entries(sesudah)) console.log(`  ${k.padEnd(14)} ${v}`);
  console.log("");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await getSql().end();
  });
