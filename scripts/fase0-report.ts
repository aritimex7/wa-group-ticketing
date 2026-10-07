/**
 * Pembaca hasil Fase 0 - SPEC section 14.
 *
 *   "Jalankan diam-diam 2-3 hari, dump raw_payload ke file JSON.
 *    Periksa bentuk nyatanya: format LID vs PN, isi contextInfo, tipe media.
 *    Baru tulis parser berdasarkan temuan itu."
 *
 * Berkas ini adalah alat untuk langkah "periksa bentuk nyatanya". Ia membaca
 * var/raw/*.jsonl dan menjawab pertanyaan yang menentukan benar-salahnya parser:
 *
 *   - field mana saja yang benar-benar ada di payload (bukan yang kita kira ada)
 *   - participant keluar sebagai LID atau PN, dan seberapa sering
 *   - berapa persen pesan reply yang membawa contextInfo.participant
 *   - tipe pesan apa saja yang nyata muncul
 *   - peringatan apa yang paling sering dikeluarkan adapter
 *
 * Jalankan:  npm run fase0:report
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const DIR = path.join(process.cwd(), "var", "raw");
const MAX_DEPTH = 6;

type Row = { at: string; provider: string; warnings?: string[]; parsedKinds?: string[]; body: unknown };

async function main() {
  let files: string[];
  try {
    files = (await readdir(DIR)).filter((f) => f.endsWith(".jsonl")).sort();
  } catch {
    console.error(`Folder ${DIR} belum ada. Jalankan gateway dulu dengan FASE0_DUMP=on.`);
    process.exitCode = 1;
    return;
  }

  if (!files.length) {
    console.error("Belum ada berkas dump. Biarkan Fase 0 berjalan beberapa hari dulu.");
    process.exitCode = 1;
    return;
  }

  const paths = new Map<string, number>();
  const events = new Map<string, number>();
  const kinds = new Map<string, number>();
  const warnings = new Map<string, number>();
  const msgTypes = new Map<string, number>();
  const domains = new Map<string, number>();

  let total = 0;
  let replies = 0;
  let repliesWithParticipant = 0;
  let withMentions = 0;

  for (const f of files) {
    const text = await readFile(path.join(DIR, f), "utf8");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let row: Row;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      total++;

      for (const w of row.warnings ?? []) bump(warnings, w);
      for (const k of row.parsedKinds ?? []) bump(kinds, k);

      const body = row.body as Record<string, unknown>;
      bump(events, String(body?.event ?? body?.["type"] ?? "(tanpa event)"));

      walk(body, "", paths, domains, msgTypes, 0);

      const ctx = findCtx(body);
      if (ctx?.stanzaId) {
        replies++;
        if (ctx.participant) repliesWithParticipant++;
      }
      if (Array.isArray(ctx?.mentionedJid) && ctx.mentionedJid.length) withMentions++;
    }
  }

  const pct = (n: number, d: number) => (d ? `${((n / d) * 100).toFixed(1)}%` : "-");

  console.log(`\n=== LAPORAN FASE 0 ===`);
  console.log(`Berkas    : ${files.length} (${files[0]} .. ${files[files.length - 1]})`);
  console.log(`Payload   : ${total}`);

  console.log(`\n--- Event ---`);
  table(events);

  console.log(`\n--- Hasil parse adapter ---`);
  table(kinds);

  console.log(`\n--- PERTANYAAN KUNCI section 3: LID vs PN ---`);
  console.log(`Domain identitas yang muncul di payload:`);
  table(domains);
  console.log(
    `\nKalau "@lid" muncul sama sering atau lebih sering dari "@s.whatsapp.net",\n` +
      `pencocokan identitas WAJIB memakai kedua kolom. Kalau "@lid" TIDAK PERNAH\n` +
      `muncul, jangan lega dulu - cek lagi setelah beberapa hari, migrasi LID\n` +
      `berjalan bertahap per akun.`,
  );

  console.log(`\n--- contextInfo (inti fitur reply) ---`);
  console.log(`Payload dengan contextInfo.stanzaId       : ${replies}`);
  console.log(`  di antaranya punya .participant         : ${repliesWithParticipant} (${pct(repliesWithParticipant, replies)})`);
  console.log(`Payload dengan mentionedJid tidak kosong  : ${withMentions}`);
  console.log(
    `\nKalau persentase .participant jauh di bawah 100%, deteksi "orang me-reply\n` +
      `pesan kita" akan gagal diam-diam untuk sisanya - persis peringatan section 3.`,
  );

  console.log(`\n--- Tipe pesan yang nyata muncul ---`);
  table(msgTypes);

  console.log(`\n--- Peringatan adapter (terbanyak dulu) ---`);
  table(warnings, 20);

  console.log(`\n--- Field yang muncul di payload ---`);
  console.log(`(hanya yang muncul >= 1% dari total; pakai ini untuk mengoreksi adapter)`);
  table(paths, 60, Math.max(1, total * 0.01));

  console.log("");
}

function bump(m: Map<string, number>, k: string) {
  m.set(k, (m.get(k) ?? 0) + 1);
}

function table(m: Map<string, number>, limit = 30, min = 0) {
  const rows = [...m.entries()].filter(([, n]) => n >= min).sort((a, b) => b[1] - a[1]).slice(0, limit);
  if (!rows.length) {
    console.log("  (kosong)");
    return;
  }
  const w = Math.max(...rows.map(([k]) => k.length));
  for (const [k, n] of rows) console.log(`  ${k.padEnd(w)}  ${String(n).padStart(6)}`);
}

/** Kumpulkan jalur field yang benar-benar ada, plus domain JID yang terlihat. */
function walk(
  node: unknown,
  prefix: string,
  paths: Map<string, number>,
  domains: Map<string, number>,
  msgTypes: Map<string, number>,
  depth: number,
) {
  if (depth > MAX_DEPTH || node === null || node === undefined) return;

  if (typeof node === "string") {
    const at = node.lastIndexOf("@");
    if (at > 0 && node.length < 80) bump(domains, node.slice(at));
    return;
  }
  if (typeof node !== "object") return;

  if (Array.isArray(node)) {
    for (const v of node.slice(0, 5)) walk(v, `${prefix}[]`, paths, domains, msgTypes, depth + 1);
    return;
  }

  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    const p = prefix ? `${prefix}.${k}` : k;
    bump(paths, p);
    // Nama kunci di bawah "message" adalah jenis pesannya (imageMessage, dll).
    if (prefix.endsWith("message") && k.endsWith("Message")) bump(msgTypes, k);
    if (k === "messageType" && typeof v === "string") bump(msgTypes, v);
    walk(v, p, paths, domains, msgTypes, depth + 1);
  }
}

function findCtx(node: unknown, depth = 0): Record<string, unknown> | null {
  if (depth > MAX_DEPTH || !node || typeof node !== "object") return null;
  const rec = node as Record<string, unknown>;
  if (rec.contextInfo && typeof rec.contextInfo === "object") return rec.contextInfo as Record<string, unknown>;
  for (const v of Object.values(rec)) {
    const found = findCtx(v, depth + 1);
    if (found) return found;
  }
  return null;
}

void main();
