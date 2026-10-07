import Link from "next/link";

/**
 * Halaman penolakan.
 *
 * Sengaja MENYEBUTKAN alasannya dan memberi jalan keluar. Halaman kosong atau
 * 403 telanjang membuat orang mengira sistemnya rusak, lalu mereka melapor -
 * dan waktu tim habis untuk menjelaskan sesuatu yang seharusnya sudah tertulis
 * di layar.
 */
export function TolakAkses({
  judul = "Halaman ini bukan untuk peran Anda",
  pesan,
  tautan,
  labelTautan,
}: {
  judul?: string;
  pesan: string;
  tautan?: string;
  labelTautan?: string;
}) {
  return (
    <div className="grid h-full place-items-center px-6">
      <div className="max-w-[420px] text-center">
        <h1 className="text-[20px]">{judul}</h1>
        <p className="mt-2 text-[13.5px] text-ink-muted">{pesan}</p>
        {tautan ? (
          <Link href={tautan} className="btn btn-primary mt-5 inline-flex">
            {labelTautan ?? "Kembali"}
          </Link>
        ) : null}
      </div>
    </div>
  );
}

/** Penolakan khas peran "sla": ia pemantau, bukan pekerja. */
export function TolakAksesSla() {
  return (
    <TolakAkses
      pesan="Peran pemantau SLA hanya bisa melihat angka tim, tidak menangani tiket. Kalau Anda memang perlu membalas pesan, minta team leader mengubah peran akun Anda."
      tautan="/sla"
      labelTautan="Buka Pantau SLA"
    />
  );
}
