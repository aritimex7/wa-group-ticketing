/**
 * Putar ulang payload mentah Fase 0 lewat pipeline ingestion.
 *
 * Ini pasangan yang hilang dari section 14. Spesifikasi menyuruh "dump dulu, tulis
 * parser berdasarkan bentuk nyata itu" - tapi setelah parsernya diperbaiki,
 * payload lama tidak ada gunanya kalau tidak bisa dijalankan ulang.
 *
 * Dua kegunaan nyata:
 *   - memulihkan pesan yang terlanjur dibuang karena grupnya belum dipantau
 *   - menguji perbaikan parser terhadap data asli, bukan data karangan
 *
 * Aman diulang: ingestion memakai onConflictDoNothing pada stanza_id, jadi
 * memutar dump yang sama dua kali tidak menggandakan apa pun.
 *
 *   npm run fase0:putar-ulang                  -- semua berkas di var/raw
 *   npm run fase0:putar-ulang -- 2026-08-23    -- satu tanggal saja
 *   npm run fase0:putar-ulang -- --bersih      -- kosongkan dulu, lalu bangun
 *                                                 ulang dari nol (setelah
 *                                                 parser diperbaiki)
 */
import "dotenv/config";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { getSql } from "../src/db";
import { gateway } from "../src/lib/gateway";
import { ingestEvents } from "../src/lib/ingest";

const DIR = path.join(process.cwd(), "var", "raw");

/**
 * Kosongkan hasil ingestion sebelum memutar ulang.
 *
 * Dibutuhkan setelah PARSER diperbaiki: ingestion memakai onConflictDoNothing
 * pada stanza_id, jadi pesan yang sudah tersimpan akan dilewati begitu saja dan
 * aturan tiket tidak pernah dievaluasi ulang. Tanpa ini, perbaikan parser
 * seolah-olah tidak berpengaruh.
 *
 * Yang dikosongkan hanya turunan dari pesan. Agen, grup, setelan, dan
 * settings_audit tidak disentuh.
 */
async function kosongkan() {
  const { db } = await import("../src/db");
  const { sql } = await import("drizzle-orm");
  await db.transaction(async (tx) => {
    /* Outbox TIDAK dihapus, hanya dilepas dari tiketnya.
       outbox.sent_stanza_id adalah satu-satunya kaitan antara pesan keluar dan
       agen yang mengirimnya (section 4.3). Menghapusnya berarti seluruh balasan hasil
       putar ulang jadi "tidak teratribusi" - merusak justru angka yang paling
       ingin dipercaya leader. */
    await tx.execute(sql`UPDATE outbox SET ticket_id = NULL`);
    await tx.execute(sql`DELETE FROM agent_seen`);
    await tx.execute(sql`DELETE FROM ticket_events`);
    await tx.execute(sql`DELETE FROM triage_bucket`);
    await tx.execute(sql`DELETE FROM tickets`);
    await tx.execute(sql`DELETE FROM messages`);
  });
  console.log("Pesan & tiket dikosongkan - dump tetap utuh, jadi bisa dibangun ulang.");
}

async function main() {
  const bersih = process.argv.includes("--bersih");
  const saring = process.argv.slice(2).find((a) => !a.startsWith("--"));

  if (bersih) await kosongkan();
  const berkas = (await readdir(DIR))
    .filter((f) => f.endsWith(".jsonl"))
    .filter((f) => !saring || f.startsWith(saring))
    .sort();

  if (!berkas.length) {
    console.log("Tidak ada berkas dump yang cocok di var/raw.");
    return;
  }

  const adapter = gateway();
  let baris = 0;
  const total = { stored: 0, ticketsCreated: 0, bucketed: 0, ignored: 0 };
  const peringatan = new Map<string, number>();

  for (const f of berkas) {
    const teks = await readFile(path.join(DIR, f), "utf8");
    for (const line of teks.split("\n")) {
      if (!line.trim()) continue;
      baris++;
      let body: unknown;
      try {
        body = JSON.parse(line).body;
      } catch {
        continue;
      }

      // Sengaja lewat adapter.parse yang SAMA dengan yang dipakai webhook -
      // kalau di sini lolos tapi di produksi gagal, ujinya tidak ada artinya.
      const events = adapter.parse(body);
      const ringkas = await ingestEvents(events);

      total.stored += ringkas.stored;
      total.ticketsCreated += ringkas.ticketsCreated;
      total.bucketed += ringkas.bucketed;
      total.ignored += ringkas.ignored;
      for (const w of ringkas.warnings) peringatan.set(w, (peringatan.get(w) ?? 0) + 1);
    }
  }

  console.log(`\nDiputar ulang: ${baris} payload dari ${berkas.length} berkas`);
  console.log(`  pesan tersimpan   ${total.stored}`);
  console.log(`  tiket dibuat      ${total.ticketsCreated}`);
  console.log(`  masuk keranjang   ${total.bucketed}`);
  console.log(`  diabaikan         ${total.ignored}`);

  if (peringatan.size) {
    console.log("\nPeringatan parser:");
    for (const [w, n] of [...peringatan.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(n).padStart(4)}  ${w}`);
    }
  } else {
    console.log("\nTanpa peringatan parser.");
  }
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
