/**
 * Layar "peran Anda tidak boleh membuka halaman ini".
 *
 * Satu komponen untuk ketiga halaman berperan (Leader, Setelan, Pantau SLA).
 * Sebelumnya tiap halaman menulis kalimatnya sendiri, dan ketiganya sudah
 * terlanjur berbeda bunyi - persis cara penyimpangan kecil tumbuh: tidak ada
 * yang salah waktu ditulis, tapi tidak ada juga yang menjaganya tetap sama.
 *
 * Kenapa boleh sesingkat ini tanpa menjelaskan siapa yang berhak: menu ketiga
 * halaman itu memang TIDAK ditampilkan ke peran yang tidak berhak (lihat
 * layout). Jadi yang sampai ke layar ini hanya orang yang mengetik alamatnya
 * sendiri atau mengikuti tautan basi - bukan orang yang sedang mencari jalan
 * masuk dan perlu diberi tahu harus minta ke siapa.
 */
export function TanpaAkses() {
  return (
    <div className="grid h-full place-items-center px-6">
      <p className="text-[22px] text-ink-muted" style={{ letterSpacing: "-0.01em" }}>
        No Access
      </p>
    </div>
  );
}
