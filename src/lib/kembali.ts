/**
 * Tautan "kembali" yang benar-benar kembali.
 *
 * Sebelum ini setiap tautan kembali ditulis mati ke "/", jadi apa pun jalan
 * yang dilalui agen selalu berakhir di tab Open. Buka tiket dari tab Done,
 * tekan kembali, hilang - tab Done harus dicari ulang. Lihat chat grup dari
 * sebuah tiket, tekan kembali, tiketnya hilang.
 *
 * Jalur asal dibawa di query string `dari`, bukan disimpan di state klien.
 * Alasannya sama seperti tab papan memakai query string: halaman-halaman ini
 * menyegarkan diri sendiri tiap ada peristiwa realtime, dan state klien akan
 * ikut hilang tiap penyegaran. Lewat URL ia bertahan, dan tautannya bisa
 * dikirim ke rekan lengkap dengan jalan pulangnya.
 */

const MAKS = 512;

/**
 * Saring `dari` sebelum dipakai sebagai href.
 *
 * Isi query string ditulis siapa saja - termasuk penyerang yang mengirim
 * tautan ke agen. "//situslain.com" dan "/\situslain.com" DIBACA BROWSER
 * sebagai alamat luar walau diawali garis miring, jadi meloloskannya berarti
 * membuka pintu open redirect: agen mengklik "kembali" di dashboard sendiri
 * dan mendarat di halaman masuk palsu.
 */
export function kembaliAman(raw: string | null | undefined, bawaan = "/"): string {
  if (!raw || raw.length > MAKS) return bawaan;
  if (!raw.startsWith("/")) return bawaan;
  if (raw.startsWith("//")) return bawaan;

  /* Daftar-IZIN, bukan daftar-larang. Isinya persis karakter yang sah di
     jalur dan query URL. Menyaring dengan daftar larangan berarti harus
     menebak semua yang berbahaya; dengan daftar izin, yang tidak terpikir
     otomatis ikut ditolak - termasuk karakter kontrol, spasi, tanda kutip,
     dan garis miring terbalik yang membuat "/\situslain.com" dibaca browser
     sebagai alamat luar. */
  if (!/^[A-Za-z0-9._~!$&'()*+,;=:@\/?%#[\]-]*$/.test(raw)) return bawaan;

  return raw;
}

/**
 * Nama tempat yang dituju, supaya tombolnya menyebut ke MANA ia pergi.
 *
 * "Kembali" saja tidak cukup: kalau agen sampai di sebuah tiket lewat tiga
 * lompatan, satu-satunya cara tahu tombol itu membawanya ke mana adalah
 * menekannya. Menyebutkan tujuannya membuat tombol bisa dipercaya tanpa
 * dicoba dulu.
 */
export function labelKembali(path: string): string {
  const [jalur, kueri = ""] = path.split("?");

  if (jalur === "/") {
    const tab = new URLSearchParams(kueri).get("tab");
    if (tab === "progress") return "Progress";
    if (tab === "done") return "Done";
    return "Chat";
  }

  const tiket = /^\/tiket\/(\d+)$/.exec(jalur);
  if (tiket) return `Tiket #${tiket[1]}`;

  if (jalur === "/cari") return "Cari";
  if (jalur.startsWith("/grup/")) return "Chat grup";
  if (jalur === "/leader") return "Leader";
  return "Kembali";
}

/** Jalur papan untuk satu tab. Tab open tinggal di "/" supaya URL-nya bersih. */
export function jalurPapan(tab: "open" | "progress" | "done"): string {
  return tab === "open" ? "/" : `/?tab=${tab}`;
}

/** Tempelkan `dari` ke sebuah jalur, sekali encode, tanpa menebak pemisahnya. */
export function denganDari(jalur: string, dari: string): string {
  const pemisah = jalur.includes("?") ? "&" : "?";
  return `${jalur}${pemisah}dari=${encodeURIComponent(dari)}`;
}
