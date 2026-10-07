/**
 * Reset TOTAL: seluruh data operasional DAN seluruh akun agen dihapus, lalu
 * dibuatkan 2 akun baru (leader + sla). Diminta pemilik untuk memulai bersih
 * dari instance uji ini - agen selain dua ini akan dibuat manual lewat Setelan.
 *
 * PENYIMPANGAN SADAR dari section 4.2 ("JANGAN pernah DELETE agen, nonaktifkan
 * saja - statistik lama ikut rusak"). Skrip ini melanggarnya dengan sengaja,
 * atas instruksi eksplisit pemilik, karena instance ini memang untuk uji coba
 * dan seluruh riwayatnya memang ingin dibuang.
 *
 *   npm run db:reset-total          -- pratinjau, tidak mengubah apa pun
 *   npm run db:reset-total -- --ya  -- benar-benar jalankan
 *
 * DIHAPUS SELURUHNYA
 *   messages, tickets, ticket_events, triage_bucket, agent_seen, outbox,
 *   notifications, gateway_events, archive_messages, groups, sessions, agents
 *
 * DIPERTAHANKAN (isinya), tapi jejak "siapa yang membuat/mengubah" DIBERSIHKAN
 * karena agen lama akan lenyap - lihat KOLOM_DIKOSONGKAN
 *   settings, settings_audit, ignored_phrases, quick_replies,
 *   internal_numbers, mention_lists, mention_list_members
 *
 * TIDAK DISENTUH: var/raw/*.jsonl. Payload mentah tetap di disk.
 */
import "dotenv/config";
import { sql } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { db, getSql } from "../src/db";

const jalankan = process.argv.includes("--ya");

const TABEL_DIHAPUS = [
  "ticket_events",
  "agent_seen",
  "outbox",
  "triage_bucket",
  "tickets",
  "messages",
  "notifications",
  "gateway_events",
  "archive_messages",
  "groups",
  "sessions",
  "agents",
] as const;

/** [tabel, kolom] yang menunjuk ke agents.id tapi TABELNYA tidak ikut dihapus. */
const KOLOM_DIKOSONGKAN = [
  ["settings", "updated_by"],
  ["settings_audit", "changed_by"],
  ["ignored_phrases", "created_by"],
  ["internal_numbers", "created_by"],
  ["mention_lists", "created_by"],
] as const;

const AKUN_BARU = [
  { username: "leader", name: "Leader", role: "leader", signatureCode: "ld" },
  { username: "sla", name: "Pemantau SLA", role: "sla", signatureCode: "sl" },
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
  const total = hapus.reduce((a, [, n]) => a + n, 0);

  console.log("\nAKAN DIHAPUS SELURUHNYA");
  for (const [t, n] of hapus) console.log(`  ${t.padEnd(16)} ${n}`);

  console.log("\nDIPERTAHANKAN, kolom pembuat/pengubah dikosongkan");
  for (const [t, k] of KOLOM_DIKOSONGKAN) console.log(`  ${t}.${k}`);

  console.log("\nAKUN BARU");
  for (const a of AKUN_BARU) console.log(`  ${a.username.padEnd(10)} role=${a.role.padEnd(7)} #dsp ${a.signatureCode}`);
  console.log(`  password sama untuk keduanya: ${process.env.SEED_PASSWORD || "rahasia123"}`);

  if (!jalankan) {
    console.log(`\n${total} baris akan dihapus, 5 akun lama lenyap, 2 akun baru dibuat. Ini baru pratinjau.`);
    console.log("Tambahkan --ya untuk benar-benar menjalankan:\n  npm run db:reset-total -- --ya\n");
    return;
  }

  const sandi = await bcrypt.hash(process.env.SEED_PASSWORD || "rahasia123", 11);

  await db.transaction(async (tx) => {
    for (const [t, k] of KOLOM_DIKOSONGKAN) {
      await tx.execute(sql`UPDATE ${sql.identifier(t)} SET ${sql.identifier(k)} = NULL`);
    }
    for (const t of TABEL_DIHAPUS) {
      await tx.execute(sql`DELETE FROM ${sql.identifier(t)}`);
    }
    for (const a of AKUN_BARU) {
      await tx.execute(sql`
        INSERT INTO agents (name, username, password_hash, signature_code, role)
        VALUES (${a.name}, ${a.username}, ${sandi}, ${a.signatureCode}, ${a.role})
      `);
    }
  });

  const sesudah = await hitung(TABEL_DIHAPUS);
  console.log("\nSESUDAH");
  for (const [t, n] of sesudah) console.log(`  ${t.padEnd(16)} ${n}`);

  const akun = (await db.execute(sql`SELECT id, username, name, role FROM agents ORDER BY id`)) as unknown as Record<
    string,
    unknown
  >[];
  console.log("\nAKUN SEKARANG");
  console.table(akun);
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
