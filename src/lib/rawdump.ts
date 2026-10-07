/**
 * Fase 0 - dump payload mentah ke berkas JSONL (SPEC section 14).
 *
 *   "Jalankan diam-diam 2-3 hari, dump raw_payload ke file JSON.
 *    Periksa bentuk nyatanya: format LID vs PN, isi contextInfo, tipe media.
 *    Baru tulis parser berdasarkan temuan itu."
 *
 * Dua aturan berkas ini:
 *   1. Tidak boleh pernah menggagalkan ingestion. Kalau disk penuh atau folder
 *      tidak bisa ditulis, webhook tetap harus 200 dan pesan tetap masuk DB.
 *   2. Isinya percakapan klien. var/raw sudah masuk .gitignore - jangan pernah
 *      dikeluarkan dari sana.
 */
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

const DIR = path.join(process.cwd(), "var", "raw");

let ready: Promise<void> | null = null;
function ensureDir(): Promise<void> {
  ready ??= mkdir(DIR, { recursive: true }).then(() => void 0);
  return ready;
}

export function rawDumpEnabled(): boolean {
  // Menyala secara default. Matikan lewat FASE0_DUMP=off kalau Fase 0 sudah lewat.
  return (process.env.FASE0_DUMP ?? "on").toLowerCase() !== "off";
}

function fileForToday(): string {
  const d = new Date().toISOString().slice(0, 10);
  return path.join(DIR, `${d}.jsonl`);
}

/**
 * Satu baris JSON per webhook. Sengaja menyimpan body utuh - justru bagian
 * yang belum kita pahami itulah yang perlu dibaca nanti.
 */
export async function dumpRaw(
  provider: string,
  body: unknown,
  meta: { warnings?: string[]; parsedKinds?: string[] } = {},
): Promise<void> {
  if (!rawDumpEnabled()) return;
  try {
    await ensureDir();
    const line =
      JSON.stringify({
        at: new Date().toISOString(),
        provider,
        parsedKinds: meta.parsedKinds ?? [],
        warnings: meta.warnings ?? [],
        body,
      }) + "\n";
    await appendFile(fileForToday(), line, "utf8");
  } catch (err) {
    // Sengaja hanya dicatat. Ingestion lebih penting daripada dump.
    console.error("[fase0] gagal menulis dump:", (err as Error).message);
  }
}
