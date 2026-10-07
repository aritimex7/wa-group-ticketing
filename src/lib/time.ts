/**
 * Format waktu untuk UI berbahasa Indonesia.
 *
 * Aturan tampilan timer (section 9.1: "angka berjalan"):
 *   < 1 jam    ->  "12:04"      detik ikut berdetak, karena di rentang inilah
 *                               agen masih bisa menyelamatkan SLA
 *   1-24 jam   ->  "3j 07m"     detik sudah tidak relevan, dan angka yang
 *                               berkedip tiap detik selama 3 jam itu kebisingan
 *   > 24 jam   ->  "2h 04j"
 */

export const WIB = "Asia/Jakarta";

export function durationLabel(ms: number): string {
  if (ms < 0) ms = 0;
  const totalSec = Math.floor(ms / 1000);
  const sec = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  const min = totalMin % 60;
  const totalHour = Math.floor(totalMin / 60);
  const hour = totalHour % 24;
  const day = Math.floor(totalHour / 24);

  if (day > 0) return `${day}h ${String(hour).padStart(2, "0")}j`;
  if (totalHour > 0) return `${totalHour}j ${String(min).padStart(2, "0")}m`;
  return `${String(totalMin).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

/** Seberapa sering baris ini perlu digambar ulang. Tidak semua butuh 1 detik. */
export function tickIntervalMs(ms: number): number {
  return ms < 3_600_000 ? 1_000 : 30_000;
}

/**
 * Durasi dalam kata: "40 detik", "12 menit", "1 jam 20 menit", "2 hari 3 jam".
 *
 * Dipakai untuk angka yang DIBACA sekali lalu dipikirkan - waktu respon khas,
 * tooltip, teks pembaca layar. Bedakan dari durationLabel() yang dipakai timer
 * berjalan: di sana bentuk "12:04" menang karena lebarnya tetap dan mudah
 * dipindai berderet; di sini kata-kata menang karena tidak perlu diterjemahkan
 * dulu di kepala.
 *
 * Satuan berhenti di dua tingkat. "1 jam 20 menit 13 detik" lebih presisi tapi
 * tidak lebih berguna - tidak ada keputusan yang berubah karena 13 detik itu.
 */
export function durationWords(ms: number): string {
  if (ms < 0) ms = 0;
  const detik = Math.round(ms / 1000);
  if (detik < 60) return `${detik} detik`;

  const menit = Math.floor(detik / 60);
  if (menit < 60) {
    const sisaDetik = detik % 60;
    return sisaDetik ? `${menit} menit ${sisaDetik} detik` : `${menit} menit`;
  }

  const jam = Math.floor(menit / 60);
  const sisaMenit = menit % 60;
  if (jam < 24) return sisaMenit ? `${jam} jam ${sisaMenit} menit` : `${jam} jam`;

  const hari = Math.floor(jam / 24);
  const sisaJam = jam % 24;
  return sisaJam ? `${hari} hari ${sisaJam} jam` : `${hari} hari`;
}

const clockFmt = new Intl.DateTimeFormat("id-ID", {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: WIB,
});

const dateFmt = new Intl.DateTimeFormat("id-ID", {
  day: "numeric",
  month: "short",
  timeZone: WIB,
});

const fullFmt = new Intl.DateTimeFormat("id-ID", {
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: WIB,
});

/**
 * Kunci hari untuk MEMBANDINGKAN, bukan untuk ditampilkan.
 *
 * dateFmt sengaja tanpa tahun karena "23 Agu 2026" boros di layar. Tapi
 * memakainya untuk membandingkan hari adalah bug: "23 Agu" tahun lalu sama
 * persis dengan "23 Agu" hari ini, jadi pesan setahun lalu ditulis "hari ini".
 * Belum sering terlihat sekarang karena datanya baru sehari; akan langsung
 * kelihatan begitu arsip lama diimpor (section 4.7).
 */
const dayKeyFmt = new Intl.DateTimeFormat("en-CA", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  timeZone: WIB,
});

const yearFmt = new Intl.DateTimeFormat("en-CA", { year: "numeric", timeZone: WIB });

/** "14.03" - konvensi Indonesia memakai titik, bukan titik dua. */
export function clock(d: Date): string {
  return clockFmt.format(d).replace(":", ".");
}

/** "23 Agu", atau "23 Agu 2025" kalau bukan tahun ini - tahun hanya muncul
 *  saat ia benar-benar membedakan. */
export function dayMonth(d: Date, now = new Date()): string {
  const tahun = yearFmt.format(d);
  return tahun === yearFmt.format(now) ? dateFmt.format(d) : `${dateFmt.format(d)} ${tahun}`;
}

export function fullStamp(d: Date): string {
  return fullFmt.format(d);
}

/** "hari ini 14.03" / "kemarin 23.51" / "3 Agu 09.12" */
export function smartStamp(d: Date, now = new Date()): string {
  const dayOf = (x: Date) => dayKeyFmt.format(x);
  const yesterday = new Date(now.getTime() - 86_400_000);
  if (dayOf(d) === dayOf(now)) return `hari ini ${clock(d)}`;
  if (dayOf(d) === dayOf(yesterday)) return `kemarin ${clock(d)}`;
  return `${dayMonth(d, now)} ${clock(d)}`;
}

/**
 * "15.02" kalau hari ini, "kemarin 23.51" / "3 Agu 09.12" kalau bukan.
 *
 * Bedanya dengan smartStamp() cuma satu: hari ini TIDAK diberi awalan "hari
 * ini". Dipakai di baris papan, tempat hampir semua isinya memang hari ini -
 * awalan yang sama berulang di dua belas baris berturut-turut jadi kebisingan,
 * dan justru menenggelamkan baris yang tanggalnya beda sendiri.
 */
export function jamRingkas(d: Date, now = new Date()): string {
  return dayKeyFmt.format(d) === dayKeyFmt.format(now) ? clock(d) : smartStamp(d, now);
}

/** Awal hari ini menurut zona WIB, dikembalikan sebagai Date UTC. */
export function startOfTodayWib(now = new Date()): Date {
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: WIB,
  }).format(now);
  return new Date(`${parts}T00:00:00+07:00`);
}

/** Jam berapa (0-23) menurut WIB - dipakai grafik volume per jam (section 10). */
export function hourWib(d: Date): number {
  return Number(
    new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hour12: false, timeZone: WIB }).format(d),
  );
}
