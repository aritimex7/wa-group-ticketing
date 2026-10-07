/**
 * Login per agen + pembatas IP kantor - SPEC section 2.2, section 11.
 *
 * Catatan arsitektur yang jujur: pembatasan IP paling benar dipasang di reverse
 * proxy (nginx/Caddy) atau firewall VPS, bukan di aplikasi. Yang di sini adalah
 * lapisan KEDUA - berguna kalau proxy salah konfigurasi, dan memberi leader
 * tempat mengatur daftarnya tanpa masuk SSH. Jangan jadikan satu-satunya.
 */
import "server-only";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { SignJWT, jwtVerify } from "jose";
import bcrypt from "bcryptjs";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { agents, sessions, type Agent } from "@/db/schema";
import { getSetting } from "@/lib/settings";

const COOKIE = "wa_sesi";
const MAX_AGE_S = 60 * 60 * 24 * 30;

function secret(): Uint8Array {
  const s = process.env.AUTH_SECRET;
  if (!s || s.length < 32) {
    throw new Error("AUTH_SECRET wajib diisi minimal 32 karakter. Lihat .env.example.");
  }
  return new TextEncoder().encode(s);
}

/* ------------------------------- kata sandi ------------------------------- */

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 11);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

/* --------------------------------- sesi --------------------------------- */

export type SessionUser = Pick<Agent, "id" | "name" | "role" | "signatureCode" | "shift">;

export async function createSession(agentId: number, ip: string | null, ua: string | null): Promise<void> {
  const rows = await db.insert(sessions).values({ agentId, ip, userAgent: ua }).returning({ id: sessions.id });
  const sid = rows[0].id;

  const token = await new SignJWT({ sid, aid: agentId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${MAX_AGE_S}s`)
    .sign(secret());

  const jar = await cookies();
  jar.set(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: MAX_AGE_S,
  });
}

export async function destroySession(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(COOKIE)?.value;
  if (token) {
    try {
      const { payload } = await jwtVerify(token, secret());
      await db
        .update(sessions)
        .set({ revokedAt: new Date() })
        .where(eq(sessions.id, payload.sid as string));
    } catch {
      /* token sudah tidak sah - tidak apa-apa */
    }
  }
  jar.delete(COOKIE);
}

/** Null kalau belum login atau sesinya sudah dicabut. */
export async function getSession(): Promise<{ user: SessionUser; sid: string } | null> {
  const jar = await cookies();
  const token = jar.get(COOKIE)?.value;
  if (!token) return null;

  try {
    const { payload } = await jwtVerify(token, secret());
    const sid = payload.sid as string;

    const rows = await db
      .select({
        id: agents.id,
        name: agents.name,
        role: agents.role,
        signatureCode: agents.signatureCode,
        shift: agents.shift,
        isActive: agents.isActive,
      })
      .from(sessions)
      .innerJoin(agents, eq(agents.id, sessions.agentId))
      .where(and(eq(sessions.id, sid), isNull(sessions.revokedAt)))
      .limit(1);

    const row = rows[0];
    // section 4.2 agen dinonaktifkan, bukan dihapus - sesinya harus ikut mati.
    if (!row || !row.isActive) return null;

    return { sid, user: { id: row.id, name: row.name, role: row.role, signatureCode: row.signatureCode, shift: row.shift } };
  } catch {
    return null;
  }
}

/**
 * Heartbeat. Dipakai auto-release claim (section 6.3): tiket dilepas kalau agennya
 * logout ATAU tidak aktif melebihi durasi di setelan.
 */
export async function touchSession(sid: string): Promise<void> {
  await db.update(sessions).set({ lastSeenAt: new Date() }).where(eq(sessions.id, sid));
}

/* ------------------------------- pembatas IP ------------------------------- */

/**
 * IP klien - dan kenapa ini lebih rumit daripada kelihatannya.
 *
 * `x-forwarded-for` DITULIS OLEH SIAPA SAJA yang bisa menjangkau aplikasi ini.
 * Mengambil entri paling KIRI seperti sebelumnya berarti pembatas "IP kantor"
 * di Setelan bisa dilewati dengan satu baris header:
 *
 *     curl -H "X-Forwarded-For: <ip kantor>" https://...
 *
 * Yang bisa dipercaya cuma entri yang ditambahkan oleh proxy KITA SENDIRI, dan
 * itu ada di sebelah KANAN - satu posisi per proxy. Jumlahnya tidak bisa
 * ditebak dari dalam kode, jadi harus dinyatakan:
 *
 *     ACCESS_PROXY_HOPS=0   tidak ada proxy (bawaan) - header diabaikan total
 *     ACCESS_PROXY_HOPS=1   satu proxy (nginx/Caddy) di depan aplikasi
 *
 * Dengan 0, fungsi ini mengembalikan null, dan ipAllowed() menolak SEMUANYA
 * selama daftar IP diisi. Itu memang disengaja: pembatas yang bisa dilewati
 * satu header lebih berbahaya daripada pembatas yang mengunci dengan berisik,
 * karena yang pertama membuat orang merasa terlindungi padahal tidak.
 */
export async function clientIp(): Promise<string | null> {
  const hops = Number(process.env.ACCESS_PROXY_HOPS ?? "0");
  if (!Number.isInteger(hops) || hops < 1) return null;

  const h = await headers();
  const fwd = h.get("x-forwarded-for");
  if (!fwd) return h.get("x-real-ip");

  const rantai = fwd
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  /* Hitung dari kanan: entri terakhir ditulis proxy terdekat. Kalau rantainya
     lebih pendek daripada jumlah proxy yang dijanjikan, ada yang tidak beres -
     jangan menebak, kembalikan null. */
  const idx = rantai.length - hops;
  return idx >= 0 ? (rantai[idx] ?? null) : null;
}

/** Cocokkan IPv4 terhadap satu entri: "203.0.113.7" atau "203.0.113.0/24". */
export function ipMatches(ip: string, entry: string): boolean {
  const rule = entry.trim();
  if (!rule) return false;
  if (!rule.includes("/")) return ip === rule;

  const [net, bitsRaw] = rule.split("/");
  const bits = Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;

  const toInt = (s: string): number | null => {
    const parts = s.split(".");
    if (parts.length !== 4) return null;
    let n = 0;
    for (const p of parts) {
      const v = Number(p);
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

export async function ipAllowed(ip: string | null): Promise<boolean> {
  const list = await getSetting("access.ip_allowlist");
  if (!list.length) return true; // kosong = tidak dibatasi (hanya untuk pengembangan)
  if (!ip) {
    /* Daftar diisi tapi IP tidak bisa dipastikan. Biasanya karena
       ACCESS_PROXY_HOPS belum diisi - dan itu perlu terbaca di log, bukan
       cuma jadi 403 misterius yang dikira bug login. */
    console.warn("[akses] daftar IP aktif tapi IP klien tidak bisa dipastikan - cek ACCESS_PROXY_HOPS");
    return false;
  }
  return list.some((entry) => ipMatches(ip, entry));
}

/* -------------------------------- penjaga -------------------------------- */

export class AccessDenied extends Error {
  constructor(public kind: "auth" | "ip" | "role") {
    super(kind);
  }
}

/**
 * Sudah login, IP kantor lolos. TIDAK memeriksa peran.
 * Dipakai kerangka aplikasi (topbar) yang harus tetap tampil untuk semua peran.
 */
export async function requireUser(): Promise<SessionUser> {
  if (!(await ipAllowed(await clientIp()))) throw new AccessDenied("ip");
  const s = await getSession();
  if (!s) throw new AccessDenied("auth");
  void touchSession(s.sid); // sengaja tidak di-await: heartbeat tidak boleh memperlambat render
  return s.user;
}

/**
 * Boleh menangani tiket.
 *
 * Peran "sla" DITOLAK di sini, dan itu inti perannya: ia pemantau, bukan
 * pekerja. Penolakannya di server, bukan sekadar menyembunyikan menu -
 * mengetik /tiket/12 langsung pun tidak tembus.
 */
export async function requireAgent(): Promise<SessionUser> {
  const user = await requireUser();
  /* Peran "sla" dialihkan ke dashboardnya, bukan dilempar ke halaman error.
     Penjagaannya tetap di SERVER - mengetik /tiket/12 langsung pun tidak
     menampilkan apa pun - tapi orangnya mendarat di tempat yang berguna,
     lengkap dengan penjelasan kenapa (lihat parameter ?tolak). */
  if (user.role === "sla") redirect("/sla?tolak=1");
  return user;
}

export async function requireLeader(): Promise<SessionUser> {
  const user = await requireUser();
  if (user.role !== "leader") throw new AccessDenied("role");
  return user;
}

/** Boleh melihat dashboard SLA: peran sla dan leader. */
export async function requireSlaView(): Promise<SessionUser> {
  const user = await requireUser();
  if (user.role !== "sla" && user.role !== "leader") throw new AccessDenied("role");
  return user;
}

/**
 * Bungkus penjaga untuk ROUTE HANDLER.
 *
 * Route handler tidak punya UI untuk menampilkan pesan, dan AccessDenied yang
 * lolos ke atas jadi 500 - terbaca sebagai "server rusak" padahal sebenarnya
 * "Anda tidak berhak". Bedanya penting saat ada yang melapor.
 */
export async function jagaRoute<T>(
  penjaga: () => Promise<T>,
): Promise<{ ok: true; user: T } | { ok: false; status: number; pesan: string }> {
  try {
    return { ok: true, user: await penjaga() };
  } catch (err) {
    if (err instanceof AccessDenied) {
      if (err.kind === "ip") return { ok: false, status: 403, pesan: "Akses hanya dari jaringan kantor." };
      if (err.kind === "role") return { ok: false, status: 403, pesan: "Peran Anda tidak berhak membuka ini." };
      return { ok: false, status: 401, pesan: "Silakan masuk dulu." };
    }
    throw err;
  }
}
