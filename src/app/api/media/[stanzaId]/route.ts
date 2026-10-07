import { NextResponse, type NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { messages } from "@/db/schema";
import { jagaRoute, requireAgent } from "@/lib/auth";
import { gateway } from "@/lib/gateway";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Unduh media on-demand - SPEC section 12.
 *
 *   "Media TIDAK disimpan. Agen klik unduh -> gateway mengambil dari WhatsApp
 *    -> stream langsung ke browser. Tidak ada file tersimpan di server, tidak
 *    ada di database, tidak ada aturan retensi."
 *
 * Konsekuensi yang sudah diterima: link media WhatsApp kedaluwarsa dalam
 * hitungan hari. Kalau gagal, tampilkan pesan jelas - jangan pura-pura berhasil.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ stanzaId: string }> }) {
  const jaga = await jagaRoute(requireAgent);
  if (!jaga.ok) return NextResponse.json({ error: jaga.pesan }, { status: jaga.status });

  const { stanzaId } = await ctx.params;
  const groupJid = req.nextUrl.searchParams.get("grup");
  if (!groupJid) return NextResponse.json({ error: "parameter grup wajib" }, { status: 400 });

  const rows = await db
    .select({ mediaMeta: messages.mediaMeta, groupJid: messages.groupJid })
    .from(messages)
    .where(eq(messages.stanzaId, stanzaId))
    .limit(1);

  const row = rows[0];
  if (!row) return NextResponse.json({ error: "pesan tidak ditemukan" }, { status: 404 });
  // Jangan biarkan parameter query menentukan grup mana yang boleh dibaca.
  if (row.groupJid !== groupJid) return NextResponse.json({ error: "grup tidak cocok" }, { status: 400 });

  let media;
  try {
    media = await gateway().fetchMedia(stanzaId, row.groupJid);
  } catch {
    media = null;
  }

  if (!media || media.expired || !media.body) {
    return new NextResponse(
      "Media sudah kedaluwarsa di WhatsApp dan tidak bisa diunduh lagi. Buka pesannya langsung di WhatsApp.",
      { status: 410, headers: { "Content-Type": "text/plain; charset=utf-8" } },
    );
  }

  // section 12: nama file asli dipertahankan. Ini sering jadi bug - masuk daftar uji.
  const fileName = media.fileName || row.mediaMeta?.fileName || stanzaId;
  const safe = fileName.replace(/["\\\r\n]/g, "_");

  return new NextResponse(media.body, {
    headers: {
      "Content-Type": media.mimetype,
      "Content-Disposition": `attachment; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      "Cache-Control": "private, no-store",
    },
  });
}
