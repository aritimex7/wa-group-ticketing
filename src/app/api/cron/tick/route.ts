import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { jalankanDetak } from "@/lib/tick";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Pintu luar untuk detak berkala (systemd timer, cron, pm2).
 *
 * Isinya sengaja tipis: seluruh pekerjaannya ada di lib/tick.ts, dipakai
 * bersama src/instrumentation.ts. Waktu logikanya masih ditulis dua kali,
 * separuh tugas diam-diam tidak pernah jalan - lihat catatan di lib/tick.ts.
 *
 * Tidak perlu dipanggil kalau INTERNAL_TICKER menyala (default): proses web
 * sudah menggerakkannya sendiri. Aman dipanggil berbarengan: flushDue mengambil
 * barisnya dengan UPDATE atomik (predikat status ada di WHERE luar - lihat
 * claimDue), dan detak yang menumpuk ditolak, bukan diantrekan.
 */
export async function POST(req: NextRequest) {
  /* Dikecualikan dari proxy auth supaya cron bisa memanggilnya tanpa cookie.
     Tanpa token, orang luar bisa memaksa outbox melempar pesan lebih cepat
     dari jendela undo. */
  const expected = process.env.CRON_TOKEN;
  if (!expected) {
    if (process.env.NODE_ENV === "production") {
      return NextResponse.json({ ok: false, error: "CRON_TOKEN belum diisi" }, { status: 503 });
    }
  } else {
    const got = req.nextUrl.searchParams.get("token") ?? req.headers.get("x-cron-token");
    if (!tokenCocok(got, expected)) return NextResponse.json({ ok: false }, { status: 401 });
  }

  /* Satu detak pada satu waktu, per proses.
     Detak yang lambat (gateway diam sampai batas 20 detik) sebelumnya menumpuk:
     pemanggil di luar tidak tahu yang sebelumnya belum selesai, dan tiap detak
     memegang koneksi Postgres sendiri. Menolak yang menumpuk lebih jujur
     daripada mengantrekannya - pekerjaannya toh akan dikerjakan detak
     berikutnya. */
  if (sedangBerjalan) {
    return NextResponse.json({ ok: true, dilewati: "detak sebelumnya belum selesai" });
  }
  sedangBerjalan = true;
  try {
    const hasil = await jalankanDetak();
    return NextResponse.json({ ok: true, ...hasil });
  } finally {
    sedangBerjalan = false;
  }
}

let sedangBerjalan = false;

/**
 * Perbandingan token yang lamanya tidak bergantung isi.
 *
 * `a !== b` berhenti di karakter pertama yang berbeda, jadi lama jawabannya
 * membocorkan berapa karakter awal yang sudah benar. Untuk token acak
 * panjang lewat jaringan ini serangan yang sangat sulit - tapi ongkos
 * menutupnya satu fungsi, jadi tidak ada alasan membiarkannya.
 */
function tokenCocok(got: string | null, expected: string): boolean {
  if (!got) return false;
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export const GET = POST;
