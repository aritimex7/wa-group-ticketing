/**
 * Tanda tangan balasan "#dsp {kode}" - SPEC section 11.
 *
 * Penting (section 6.1): ini TANDA TANGAN BALASAN TIM, bukan pemicu tiket.
 * Menemukan "#dsp ab" di sebuah pesan tidak pernah membuat tiket.
 *
 * section 17 menyinggung hal yang gampang terlewat: di data lama hampir pasti ada
 * varian salah ketik ("#dps ab", "#dsp  ab", "#dspab"). Selain parse ketat,
 * berkas ini menyediakan pencari kandidat salah ketik untuk panel Kesehatan
 * Data - supaya balasan yang selama ini tidak terhitung bisa ketahuan.
 */

export type SignatureMatch = {
  code: string;
  /** posisi awal kecocokan di teks, untuk highlight di UI. */
  index: number;
  raw: string;
};

const CODE = "[A-Za-z0-9]{1,8}";

function buildRegex(prefix: string, lenient: boolean): RegExp {
  // "#dsp" -> "dsp"
  const bare = prefix.replace(/^#/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return lenient
    ? // "#dsp ab", "#DSP  ab", "#dspab", "# dsp ab"
      new RegExp(`#\\s*${bare}\\s*(${CODE})\\b`, "gi")
    : new RegExp(`#${bare} (${CODE})\\b`, "g");
}

/** Ambil kecocokan terakhir - tanda tangan lazimnya di akhir pesan. */
export function parseSignature(
  text: string | null | undefined,
  opts: { prefix?: string; lenient?: boolean } = {},
): SignatureMatch | null {
  if (!text) return null;
  const { prefix = "#dsp", lenient = true } = opts;
  const re = buildRegex(prefix, lenient);

  let last: SignatureMatch | null = null;
  for (const m of text.matchAll(re)) {
    last = { code: m[1].toLowerCase(), index: m.index ?? 0, raw: m[0] };
  }
  return last;
}

export function buildSignature(code: string, prefix = "#dsp"): string {
  return `${prefix} ${code.toLowerCase()}`;
}

/**
 * Sisipkan tanda tangan kalau belum ada (section 11 "sisip otomatis saat kirim").
 * Kalau agen sudah mengetik tanda tangannya sendiri, jangan digandakan.
 */
export function ensureSignature(body: string, code: string, prefix = "#dsp"): string {
  const found = parseSignature(body, { prefix, lenient: true });
  if (found?.code === code.toLowerCase()) return body;
  const trimmed = body.replace(/\s+$/, "");
  return trimmed.length ? `${trimmed}\n\n${buildSignature(code, prefix)}` : buildSignature(code, prefix);
}

/**
 * Cari sesuatu yang MIRIP tanda tangan tapi tidak dikenali sebagai kode agen
 * yang valid. Hasilnya bukan untuk dipakai atribusi - hanya untuk ditunjukkan
 * ke leader: "12 balasan memakai '#dps ay', mungkin salah ketik dari '#dsp ay'".
 */
export function findSignatureAnomalies(
  text: string | null | undefined,
  validCodes: Set<string>,
  prefix = "#dsp",
): string[] {
  if (!text) return [];
  const bare = prefix.replace(/^#/, "");
  // Tangkap pola "#<3-4 huruf><spasi opsional><kode>" apa pun, lalu buang yang benar.
  const loose = new RegExp(`#\\s*([A-Za-z]{2,5})\\s*(${CODE})\\b`, "gi");
  const out: string[] = [];

  for (const m of text.matchAll(loose)) {
    const tag = m[1].toLowerCase();
    const code = m[2].toLowerCase();
    const tagIsRight = tag === bare.toLowerCase();
    if (tagIsRight && validCodes.has(code)) continue; // benar, lewati
    if (!tagIsRight && levenshtein(tag, bare.toLowerCase()) > 1) continue; // bukan varian
    out.push(m[0].trim());
  }
  return out;
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(
        prev[j] + 1,
        prev[j - 1] + 1,
        diag + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      diag = tmp;
    }
  }
  return prev[b.length];
}
