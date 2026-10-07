import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { clientIp, createSession, getSession, ipAllowed, verifyPassword } from "@/lib/auth";
import { kembaliAman } from "@/lib/kembali";
import { checkRateLimit, resetRateLimit } from "@/lib/rate-limit";
import { headers } from "next/headers";

export const dynamic = "force-dynamic";

async function masuk(formData: FormData) {
  "use server";

  const username = String(formData.get("username") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  const lanjut = String(formData.get("lanjut") ?? "/");

  const ip = await clientIp();
  if (!(await ipAllowed(ip))) redirect("/masuk?galat=ip");

  // Rate limit berdasarkan IP — maks 5 percobaan per menit
  const ipKey = ip ?? "unknown";
  const { blocked } = checkRateLimit(ipKey, 5, 60_000);
  if (blocked) redirect("/masuk?galat=batas");

  const rows = await db.select().from(agents).where(eq(agents.username, username)).limit(1);
  const agent = rows[0];

  /*
   * Tetap jalankan verifikasi walau user tidak ada, supaya lama responsnya
   * tidak membocorkan username mana yang terdaftar.
   *
   * Nilai di bawah WAJIB hash bcrypt yang sah, dan itu bukan formalitas.
   * Sebelumnya di sini ada "$2b$11$" diikuti nol - bentuknya mirip hash, tapi
   * bcrypt menolaknya seketika. Hasil ukurannya: jalur "user tidak ada" selesai
   * 0,2 ms sementara jalur "user ada" memakan 108 ms. Selisih itu justru oracle
   * yang komentar di atas ini berjanji mencegahnya - siapa pun dengan stopwatch
   * bisa memetakan username mana yang terdaftar. Yang membuat perlindungan ini
   * nyata adalah bcrypt benar-benar mengerjakan 2^11 putaran, dan itu hanya
   * terjadi kalau salt-nya sah.
   *
   * Ini hash dari sandi acak 32 byte yang tidak disimpan di mana pun, jadi tidak
   * ada masukan yang bisa mencocokinya. Sekalipun cocok, `!agent` di bawah tetap
   * menolak - dua lapis, bukan satu.
   *
   * Kalau cost di hashPassword() (lib/auth.ts, saat ini 11) diubah, ganti juga
   * hash ini dengan cost yang sama. Kalau tidak, selisih waktunya kembali.
   */
  const dummy = "$2b$11$CFJzYEyFssaxeYojXreCweuRGEhEDzcJnLu//ovVZmGkNkOrjPD4i";
  const ok = await verifyPassword(password, agent?.passwordHash ?? dummy);

  if (!agent || !ok) redirect("/masuk?galat=salah");
  // section 4.2 agen dinonaktifkan, bukan dihapus - yang nonaktif tidak boleh masuk.
  if (!agent.isActive) redirect("/masuk?galat=nonaktif");

  // Login berhasil — reset rate limit
  resetRateLimit(ipKey);

  const ua = (await headers()).get("user-agent");
  await createSession(agent.id, ip, ua);
  /* startsWith("/") saja TIDAK cukup: "//situslain.com" juga diawali garis
     miring, dan peramban membacanya sebagai URL protokol-relatif ke domain
     lain. Pemeriksaan yang benar sudah ada di lib/kembali.ts - dipakai ulang
     supaya cuma ada satu tempat yang memutuskan jalan pulang itu aman. */
  redirect(kembaliAman(lanjut, "/"));
}

const PESAN: Record<string, string> = {
  salah: "Nama pengguna atau kata sandi tidak cocok.",
  nonaktif: "Akun ini sudah dinonaktifkan. Hubungi team leader.",
  ip: "Dashboard hanya bisa dibuka dari jaringan kantor.",
  batas: "Terlalu banyak percobaan. Coba lagi setelah 1 menit.",
};

export default async function MasukPage({
  searchParams,
}: {
  searchParams: Promise<{ galat?: string; lanjut?: string }>;
}) {
  if (await getSession()) redirect("/");
  const sp = await searchParams;
  const pesan = sp.galat ? (PESAN[sp.galat] ?? "Tidak bisa masuk.") : null;

  return (
    <div className="grid min-h-dvh place-items-center px-6">
      <div className="w-full max-w-[320px]">
        <p className="micro text-ink" style={{ letterSpacing: "0.16em" }}>
          DISPATCH&nbsp;WHATSAPP
        </p>
        <h1 className="mt-6 text-[20px]">Masuk</h1>

        <form action={masuk} className="mt-7 space-y-3">
          <input type="hidden" name="lanjut" value={sp.lanjut ?? "/"} />

          <label className="block">
            <span className="micro">Nama pengguna</span>
            <input
              name="username"
              autoComplete="username"
              autoFocus
              required
              className="field mt-1.5"
              spellCheck={false}
            />
          </label>

          <label className="block">
            <span className="micro">Kata sandi</span>
            <input
              name="password"
              type="password"
              autoComplete="current-password"
              required
              className="field mt-1.5"
            />
          </label>

          {pesan ? (
            <p role="alert" className="text-[13px] text-st-breach">
              {pesan}
            </p>
          ) : null}

          <button type="submit" className="btn btn-primary mt-1 w-full">
            Masuk
          </button>
        </form>
      </div>
    </div>
  );
}
