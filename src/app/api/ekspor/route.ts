import { NextResponse, type NextRequest } from "next/server";
import { sql } from "drizzle-orm";
import { db, ts } from "@/db";
import { jagaRoute, requireLeader } from "@/lib/auth";
import { sinceOf, type Rentang } from "@/lib/leader";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Export CSV (section 10). Satu baris per tiket, plus kolom turunan yang biasanya
 * jadi alasan orang membuka Excel: isi balasan, selisih waktu, status SLA.
 *
 * Tiket not_for_us ikut diekspor tapi ditandai jelas, supaya siapa pun yang
 * mengolah lanjut di Excel tidak diam-diam memasukkannya ke hitungan (section 8).
 *
 * Rentang bisa ditentukan dua cara:
 *   ?dari=2026-08-01&sampai=2026-08-23   tanggal bebas (dipakai form di UI)
 *   ?rentang=hari|minggu|bulan           pintasan lama, tetap didukung
 */
export async function GET(req: NextRequest) {
  const jaga = await jagaRoute(requireLeader);
  if (!jaga.ok) return NextResponse.json({ error: jaga.pesan }, { status: jaga.status });

  const q = req.nextUrl.searchParams;
  const { dari, sampai, label } = tentukanRentang(q.get("dari"), q.get("sampai"), q.get("rentang"));

  const rows = (await db.execute(sql`
    SELECT
      t.id,
      coalesce(g.name, g.jid)                                   AS grup,
      g.client_label                                            AS label_klien,
      t.status,
      t.trigger_type                                            AS pemicu,
      t.likely_not_ours                                         AS mungkin_bukan_kita,
      m.sender_push_name                                        AS pengirim,
      replace(coalesce(m.body, ''), E'\n', ' ')                 AS isi_pesan,
      /* Isi balasan pertama tim. Diutamakan pesan yang BENAR-BENAR terkirim dan
         tercatat kembali dari WhatsApp; kalau tidak bisa dikaitkan lewat reply
         (mis. dibalas tanpa swipe), jatuh ke teks yang tersimpan di outbox. */
      replace(coalesce(bal.body, ob.body, ''), E'\n', ' ')      AS isi_balasan,
      coalesce(bal.oleh, ob.oleh)                               AS balasan_oleh,
      t.triggered_at                                            AS masuk,
      t.first_response_at                                       AS balas_pertama,
      t.resolved_at                                             AS tuntas,
      fr.name                                                   AS oleh_balas_pertama,
      rb.name                                                   AS oleh_tuntas,
      t.sla_target_fr_min                                       AS target_balas_menit,
      t.sla_target_res_min                                      AS target_tuntas_menit,
      round(EXTRACT(EPOCH FROM (t.first_response_at - t.triggered_at)) / 60.0, 1) AS balas_menit,
      round(EXTRACT(EPOCH FROM (t.resolved_at - t.triggered_at)) / 60.0, 1)       AS tuntas_menit,
      CASE
        WHEN t.status = 'not_for_us' THEN 'tidak dihitung'
        WHEN t.first_response_at IS NULL THEN 'belum dibalas'
        WHEN t.first_response_at - t.triggered_at > make_interval(mins => t.sla_target_fr_min) THEN 'lewat'
        ELSE 'dalam target'
      END AS status_sla
    FROM tickets t
    JOIN groups g   ON g.jid = t.group_jid
    JOIN messages m ON m.stanza_id = t.stanza_id
    LEFT JOIN agents fr ON fr.id = t.first_responder_id
    LEFT JOIN agents rb ON rb.id = t.resolved_by
    LEFT JOIN LATERAL (
      SELECT m2.body,
             coalesce(a2.name, nullif('#dsp ' || coalesce(m2.signature_code, ''), '#dsp ')) AS oleh
      FROM messages m2
      LEFT JOIN agents a2 ON a2.id = m2.agent_id
      WHERE m2.direction = 'out' AND m2.reply_to_stanza_id = t.stanza_id
      ORDER BY m2.created_at ASC LIMIT 1
    ) bal ON true
    LEFT JOIN LATERAL (
      SELECT o.body, a3.name AS oleh
      FROM outbox o
      LEFT JOIN agents a3 ON a3.id = o.agent_id
      WHERE o.ticket_id = t.id AND o.status = 'sent'
      ORDER BY o.created_at ASC LIMIT 1
    ) ob ON true
    WHERE t.triggered_at >= ${ts(dari)} AND t.triggered_at < ${ts(sampai)}
    ORDER BY t.triggered_at DESC
  `)) as unknown as Record<string, unknown>[];

  /* Kepala kolom ditulis eksplisit supaya berkas kosong TETAP punya kepala.
     Dulu diambil dari baris pertama, jadi "tidak ada tiket pada rentang itu"
     menghasilkan berkas berisi satu kata "id" - di Excel itu terlihat sama
     persis dengan export yang rusak. */
  const HEADERS = [
    "id", "grup", "label_klien", "status", "pemicu", "mungkin_bukan_kita", "pengirim",
    "isi_pesan", "isi_balasan", "balasan_oleh", "masuk", "balas_pertama", "tuntas",
    "oleh_balas_pertama", "oleh_tuntas", "target_balas_menit", "target_tuntas_menit",
    "balas_menit", "tuntas_menit", "status_sla",
  ];

  const esc = (v: unknown): string => {
    if (v === null || v === undefined) return "";
    const s = v instanceof Date ? v.toISOString() : String(v);
    return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const csv = [
    HEADERS.join(","),
    ...rows.map((row) => HEADERS.map((h) => esc(row[h])).join(",")),
  ].join("\r\n");

  // BOM supaya Excel di Windows membaca UTF-8 dengan benar - tanpa ini nama
  // grup dan isi pesan berhuruf non-ASCII berantakan.
  return new NextResponse("﻿" + csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="tiket-${label}.csv"`,
    },
  });
}

/** Tanggal WIB (YYYY-MM-DD) -> Date UTC di awal hari itu. */
function awalHariWib(iso: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const d = new Date(`${iso}T00:00:00+07:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Tanggalnya INKLUSIF di kedua ujung: "1 sampai 23" berarti seluruh hari ke-23
 * ikut, bukan berhenti pukul 00.00. Orang menulis rentang tanggal dengan cara
 * itu; kalau sistem menafsirkan beda, laporannya kehilangan satu hari penuh
 * tanpa ada yang sadar.
 */
function tentukanRentang(
  dariRaw: string | null,
  sampaiRaw: string | null,
  rentangRaw: string | null,
): { dari: Date; sampai: Date; label: string } {
  const a = dariRaw ? awalHariWib(dariRaw) : null;
  const b = sampaiRaw ? awalHariWib(sampaiRaw) : null;

  if (a && b) {
    /* Tukar DULU, baru tambah satu hari ke ujung atas.
       Urutan terbalik pernah salah di sini: menambah sehari ke tanggal "sampai"
       yang ternyata lebih awal, lalu membandingkan, menghasilkan rentang yang
       geser satu hari dan berkas kosong untuk tanggal yang jelas ada isinya. */
    const [awal, akhirHari] = a <= b ? [a, b] : [b, a];
    const akhir = new Date(akhirHari.getTime() + 86_400_000);
    return { dari: awal, sampai: akhir, label: `${dariRaw}_sd_${sampaiRaw}` };
  }

  const r = (["hari", "minggu", "bulan"] as const).includes(rentangRaw as Rentang)
    ? (rentangRaw as Rentang)
    : "hari";
  return { dari: sinceOf(r), sampai: new Date(Date.now() + 86_400_000), label: r };
}
