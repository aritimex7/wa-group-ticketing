import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { gateway } from "@/lib/gateway";
import { dumpRaw } from "@/lib/rawdump";
import { ingestEvents } from "@/lib/ingest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Penerima webhook gateway - SPEC section 5 dan section 14 (Fase 0).
 *
 * Dua sikap yang dipegang endpoint ini:
 *
 *  1. SELALU balas 200 selama body-nya terbaca. Gateway yang menerima 500 akan
 *     mengulang kiriman, dan pengulangan tanpa henti saat ada bug parser justru
 *     memperbesar kerusakan. Kegagalan dicatat, bukan dilempar balik.
 *
 *  2. Dump dulu, proses kemudian. Kalau parser kita salah, payload aslinya
 *     sudah aman di var/raw dan bisa diputar ulang. Ini seluruh alasan Fase 0
 *     ada: "baru tulis parser berdasarkan bentuk nyata itu".
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ provider: string }> }) {
  const { provider } = await ctx.params;

  // Hanya provider resmi yang boleh menjadi pintu masuk webhook produksi.
  // Tanpa guard ini, setiap path di bawah /api/webhook/* diterima sebagai
  // nilai provider dinamis (mis. /foo atau /*).
  if (provider !== "evolution") {
    return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
  }

  /**
   * Endpoint ini SATU-SATUNYA jalan masuk data ke database, dan ia harus bisa
   * dicapai gateway tanpa cookie login - jadi ia dikecualikan dari proxy auth.
   * Tanpa token, siapa pun yang bisa menjangkau port ini dapat menyuntikkan
   * pesan palsu ke antrean tim. Karena itu token TIDAK opsional di produksi.
   */
  const expected = process.env.WEBHOOK_TOKEN;
  if (!expected) {
    if (process.env.NODE_ENV === "production") {
      console.error("[webhook] WEBHOOK_TOKEN kosong - webhook ditolak. Isi di .env.");
      return NextResponse.json({ ok: false, error: "webhook belum dikonfigurasi" }, { status: 503 });
    }
    console.warn("[webhook] WEBHOOK_TOKEN kosong - endpoint terbuka. Hanya boleh saat pengembangan lokal.");
  } else {
    const got = req.nextUrl.searchParams.get("token") ?? req.headers.get("x-webhook-token");
    if (!tokenCocok(got, expected)) {
      return NextResponse.json({ ok: false, error: "token webhook salah" }, { status: 401 });
    }
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "body bukan JSON" }, { status: 400 });
  }

  const adapter = gateway();
  if (adapter.name !== provider) {
    // Bukan error fatal - cuma pertanda URL webhook di gateway belum diperbarui.
    console.warn(`[webhook] URL memakai "${provider}" tapi GATEWAY_PROVIDER="${adapter.name}"`);
  }

  const events = adapter.parse(body);
  const warnings = events.flatMap((e) => (e.kind === "message" ? e.warnings : []));

  // Dump dijalankan tanpa ditunggu; kegagalan menulis berkas tidak boleh
  // menahan ingestion (lihat lib/rawdump.ts).
  void dumpRaw(adapter.name, body, { warnings, parsedKinds: events.map((e) => e.kind) });

  try {
    const summary = await ingestEvents(events);
    return NextResponse.json({ ok: true, ...summary });
  } catch (err) {
    console.error("[webhook] ingestion gagal:", err);
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 200 });
  }
}

/** Perbandingan yang lamanya tidak bergantung isi - lihat catatan di cron/tick. */
function tokenCocok(got: string | null, expected: string): boolean {
  if (!got) return false;
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Sebagian gateway memverifikasi URL webhook lewat GET sebelum mengaktifkannya. */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ provider: string }> }) {
  const { provider } = await ctx.params;
  if (provider !== "evolution") {
    return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}

/** Jangan biarkan Next.js membuat OPTIONS otomatis untuk provider acak. */
export async function OPTIONS(_req: NextRequest, ctx: { params: Promise<{ provider: string }> }) {
  const { provider } = await ctx.params;
  if (provider !== "evolution") {
    return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
  }
  return new NextResponse(null, { status: 204 });
}
