import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Endpoint pemantauan luar (uptime monitor). Sengaja tanpa auth dan tanpa data sensitif. */
export async function GET() {
  try {
    await db.execute(sql`SELECT 1`);
    return NextResponse.json({ ok: true, db: "up" });
  } catch (err) {
    /* Pesan galat Postgres memuat host, nama basis data, dan kadang nama
       pengguna. Endpoint ini tanpa autentikasi - yang di luar cukup tahu
       hidup atau mati. Detailnya ke log server, bukan ke jawaban. */
    console.error("[sehat] database tidak terjangkau:", (err as Error).message);
    return NextResponse.json({ ok: false, db: "down" }, { status: 503 });
  }
}
