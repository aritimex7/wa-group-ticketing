import { NextResponse } from "next/server";
import { destroySession } from "@/lib/auth";

export const runtime = "nodejs";

/**
 * Keluar. Sesi dicabut di database, bukan sekadar cookie dihapus - section 6.3
 * memakai keaktifan sesi untuk auto-release claim, jadi baris sesinya harus
 * benar-benar mati supaya tiket yang dipegang ikut dilepas.
 */
export async function POST(req: Request) {
  await destroySession();

  // Di belakang Caddy, req.url bisa memakai alamat internal (mis. localhost:3100).
  // Redirect harus kembali ke host yang dilihat browser, bukan alamat internal app.
  const headers = req.headers;
  const host = headers.get("x-forwarded-host") ?? headers.get("host") ?? "tiket.domain-anda.com";
  const proto = headers.get("x-forwarded-proto") ?? "https";
  const publicUrl = new URL("/masuk", `${proto}://${host}`);
  return NextResponse.redirect(publicUrl, { status: 303 });
}
