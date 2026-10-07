import { NextResponse, type NextRequest } from "next/server";

/**
 * Penjaga lapis luar. Sengaja TIPIS - middleware berjalan di runtime edge yang
 * tidak bisa menyentuh Postgres, jadi keputusan yang butuh database (daftar IP
 * dari setelan, status aktif agen) dilakukan di lib/auth.ts pada runtime Node.
 *
 * Di sini hanya dua hal:
 *   1. daftar IP dari environment - pagar kasar yang tetap jalan walau DB mati
 *   2. arahkan yang belum punya cookie ke /masuk, supaya tidak setiap halaman
 *      perlu menuliskan pengalihan itu sendiri
 */

const PUBLIC_PATHS = ["/masuk", "/api/webhook", "/api/cron", "/api/sehat"];

function ipMatches(ip: string, rule: string): boolean {
  if (!rule.includes("/")) return ip === rule;
  const [net, bitsRaw] = rule.split("/");
  const bits = Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const toInt = (s: string) => {
    const p = s.split(".");
    if (p.length !== 4) return null;
    let n = 0;
    for (const x of p) {
      const v = Number(x);
      if (!Number.isInteger(v) || v < 0 || v > 255) return null;
      n = (n << 8) | v;
    }
    return n >>> 0;
  };
  const a = toInt(ip);
  const b = toInt(net);
  if (a === null || b === null) return false;
  if (bits === 0) return true;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return (a & mask) === (b & mask);
}

/**
 * IP peminta, dihitung sama persis dengan `clientIp()` di lib/auth.ts.
 *
 * Versi sebelumnya di berkas ini mengambil `x-forwarded-for.split(",")[0]` -
 * entri PALING KIRI. Entri itu ditulis oleh peminta, bukan oleh proxy: Caddy
 * dan nginx MENAMBAHKAN ke rantai, tidak menimpanya. Jadi siapa pun di luar
 * cukup mengirim `X-Forwarded-For: <ip kantor>` untuk menembus daftar ini -
 * rantainya jadi "<ip kantor>, <ip asli>" dan yang terbaca justru yang
 * dikarang. Pagar yang bisa dilangkahi dengan satu header lebih berbahaya
 * daripada tidak ada pagar, karena orang mengira dirinya terlindungi.
 *
 * Yang benar: hitung dari KANAN sebanyak ACCESS_PROXY_HOPS, karena entri
 * paling kanan ditulis proxy terdekat - satu-satunya yang tidak bisa dikarang
 * peminta. Tanpa proxy (hops=0, bawaan) header itu tidak dipercaya sama
 * sekali dan fungsi ini mengembalikan null.
 *
 * Akibatnya disengaja: ACCESS_IP_ALLOWLIST terisi + ACCESS_PROXY_HOPS=0 di
 * belakang reverse proxy = semua orang ditolak. Gagal ke arah tertutup, bukan
 * terbuka. Lihat peringatan di .env.example dan docs/DEPLOY.md.
 */
function ipKlien(req: NextRequest): string | null {
  const hops = Number(process.env.ACCESS_PROXY_HOPS ?? "0");
  if (!Number.isInteger(hops) || hops < 1) return null;

  const fwd = req.headers.get("x-forwarded-for");
  if (!fwd) return req.headers.get("x-real-ip");

  const rantai = fwd
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const idx = rantai.length - hops;
  return idx >= 0 ? (rantai[idx] ?? null) : null;
}

export default function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  const envList = (process.env.ACCESS_IP_ALLOWLIST ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (envList.length && !pathname.startsWith("/api/webhook")) {
    const ip = ipKlien(req);
    if (!ip || !envList.some((rule) => ipMatches(ip, rule))) {
      return new NextResponse("Akses hanya dari jaringan kantor.", { status: 403 });
    }
  }

  if (PUBLIC_PATHS.some((p) => pathname.startsWith(p))) return NextResponse.next();

  if (!req.cookies.has("wa_sesi")) {
    const url = req.nextUrl.clone();
    url.pathname = "/masuk";
    url.searchParams.set("lanjut", pathname);
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
