import { clock, smartStamp } from "@/lib/time";
import { parseSignature } from "@/lib/signature";
import { potongMention, teksMention, type Peserta } from "@/lib/mention";
import { namaOrang, type PetaNama } from "@/lib/identity";
import type { ThreadMessage } from "@/lib/thread";
import type { ArchiveCandidate } from "@/lib/thread";

/**
 * Utas percakapan - SPEC section 7.1.
 *
 * Bentuknya sengaja TRANSKRIP, bukan gelembung chat.
 *
 * Alasannya bukan selera. Panel ini dipakai untuk membaca cepat "apa yang
 * sebenarnya terjadi di utas ini" sebelum membalas. Gelembung chat memboroskan
 * separuh lebar layar untuk ruang kosong, memaksa mata zig-zag kiri-kanan, dan
 * kalau dibuat mirip WhatsApp malah bikin agen ragu apakah dia sedang melihat
 * WhatsApp yang asli. Transkrip: satu kolom, nama di atas, isi di bawah.
 * Pesan tim ditandai rel aksen di tepi kiri.
 *
 * Tiga hal yang dibenahi setelah utas nyata pertama jadi sulit dibaca:
 *
 *  1. JAM PINDAH KE REL KIRI, dan muncul di SETIAP pesan. Sebelumnya jam hanya
 *     ikut baris nama, jadi pesan beruntun dari orang yang sama tidak punya
 *     penanda batas sama sekali - dua pertanyaan berbeda terbaca seperti satu
 *     paragraf. Sekarang jam jadi kolom yang bisa dipindai lurus ke bawah,
 *     sekaligus batas antar pesan. Relnya sejajar dengan rel timer di papan.
 *  2. BARIS BALASAN MENAMPILKAN ISINYA, bukan cuma nama. "membalas Ayu Lestari"
 *     tidak menjawab pertanyaan yang sebenarnya di utas panjang. Bentuk ini
 *     dipinjam dari Discord dan alasannya sama: sekali lihat sudah tahu
 *     nyambung ke mana, tanpa harus melompat dulu. Tautannya tetap bekerja.
 *  3. TANDA TANGAN "#dsp xx" KELUAR DARI BADAN PESAN. Ia terkirim di akhir tiap
 *     balasan tim, jadi di transkrip ia memakan satu baris penuh pada setiap
 *     pesan kita - separuh utas isinya pengulangan. Tetap ditampilkan sebagai
 *     penanda kecil (buktinya harus tetap terlihat), hanya tidak lagi
 *     berpura-pura jadi isi pesan.
 */
export function Thread({
  messages,
  /** Pesan yang kutipannya sudah ditampilkan di blok "sebelum sistem aktif" di
   *  atas utas - jangan diulang lagi di dalam barisnya. */
  hideQuoteFor = null,
  /** section 12 peserta grup, untuk mengubah "@123456789012345" jadi "@Budi". */
  peserta = [],
  kami,
  /** nama kontak tersimpan - dipakai lebih dulu daripada pushName. */
  kontak,
}: {
  messages: ThreadMessage[];
  hideQuoteFor?: string | null;
  peserta?: Peserta[];
  kami?: { pn: string | null; lid: string | null };
  kontak?: PetaNama;
}) {
  if (!messages.length) {
    return <p className="px-5 py-8 text-[13px] text-ink-faint">Utas ini belum punya pesan lain.</p>;
  }

  /* Nama DAN cuplikan tiap pesan yang ada di utas ini, untuk baris balasan. */
  const hadir = new Map<string, { nama: string; cuplikan: string }>();
  for (const m of messages) {
    hadir.set(m.stanzaId, {
      nama:
        m.direction === "out"
          ? (m.agentName ?? "tim")
          : namaOrang(kontak, { pn: m.senderPn, lid: m.senderLid }, m.senderPushName),
      cuplikan: ringkasIsi(m, peserta, kami),
    });
  }

  return (
    <ol className="px-5 py-4">
      {messages.map((m, i) => {
        const prev = messages[i - 1];
        const sameSpeaker =
          prev &&
          prev.direction === m.direction &&
          prev.senderPushName === m.senderPushName &&
          m.createdAt.getTime() - prev.createdAt.getTime() < 5 * 60_000;

        return (
          <ThreadItem
            key={m.stanzaId}
            m={m}
            grouped={Boolean(sameSpeaker)}
            balasKe={m.replyToStanzaId ? (hadir.get(m.replyToStanzaId) ?? null) : null}
            balasKeId={m.replyToStanzaId}
            sembunyikanKutipan={m.stanzaId === hideQuoteFor}
            peserta={peserta}
            kami={kami}
            kontak={kontak}
          />
        );
      })}
    </ol>
  );
}

/** id jangkar untuk satu pesan. Stanza id memuat karakter yang tidak aman di
 *  selector CSS/fragment URL, jadi dibersihkan dulu - konsisten di kedua sisi. */
export function anchorId(stanzaId: string): string {
  return "pesan-" + stanzaId.replace(/[^A-Za-z0-9_-]/g, "_");
}

/**
 * Tanda tangan dipisah dari badan pesan.
 *
 * Dua penjagaan, dan dua-duanya soal yang sama: jangan sampai yang ditampilkan
 * berbeda dari yang benar-benar terkirim.
 *
 *  - Hanya untuk pesan KELUAR. "#dsp" adalah kesepakatan internal tim; kalau
 *    klien kebetulan mengetiknya, itu isi pesan dia - bukan tanda tangan kita,
 *    dan tidak boleh diperlakukan sebagai embel-embel.
 *  - Hanya kalau ia MENUTUP pesan. Kalau "#dsp ay" ada di tengah kalimat,
 *    memotongnya merusak kalimat itu.
 */
function pisahTandaTangan(
  body: string | null,
  keluar: boolean,
): { isi: string | null; tanda: string | null } {
  if (!body || !keluar) return { isi: body, tanda: null };
  const sig = parseSignature(body);
  if (!sig) return { isi: body, tanda: null };

  const sesudah = body.slice(sig.index + sig.raw.length);
  if (sesudah.trim().length) return { isi: body, tanda: null }; // bukan di akhir

  const isi = body.slice(0, sig.index).replace(/\s+$/, "");
  return { isi: isi.length ? isi : null, tanda: sig.raw.trim() };
}

/**
 * section 12: tampilkan mention sebagai nama, bukan angka.
 *
 * Di grup akun ini WhatsApp menulis mention sebagai "@<LID>", jadi tanpa ini
 * seluruh utas berisi "bang @123456789012345". Bentuk itu benar di kabel dan
 * tidak terbaca oleh manusia mana pun. Angka yang tidak dikenali dibiarkan apa
 * adanya - lebih baik terlihat janggal daripada hilang diam-diam.
 */
export function Ditandai({
  teks,
  peserta,
  kami,
}: {
  teks: string;
  peserta: Peserta[];
  kami?: { pn: string | null; lid: string | null };
}) {
  const bagian = potongMention(teks, peserta, kami);
  if (bagian.length === 1 && bagian[0].t === "teks") return <>{teks}</>;
  return (
    <>
      {bagian.map((b, i) =>
        b.t === "tag" ? (
          <span key={i} className="font-medium" style={{ color: "var(--accent)" }}>
            {b.v}
          </span>
        ) : (
          <span key={i}>{b.v}</span>
        ),
      )}
    </>
  );
}

/** Satu baris ringkas isi pesan - untuk baris balasan bergaya Discord. */
function ringkasIsi(
  m: ThreadMessage,
  peserta: Peserta[],
  kami?: { pn: string | null; lid: string | null },
): string {
  if (m.isDeleted) return "pesan dihapus";
  const { isi } = pisahTandaTangan(m.body, m.direction === "out");
  const teks = isi && teksMention(isi, peserta, kami).replace(/\s+/g, " ").trim();
  if (teks) return teks;
  if (m.mediaMeta) return `[${m.mediaMeta.mimetype?.split("/")[1] ?? "berkas"}]`;
  return "tanpa teks";
}

function ThreadItem({
  m,
  grouped,
  balasKe,
  balasKeId,
  sembunyikanKutipan,
  peserta,
  kami,
  kontak,
}: {
  m: ThreadMessage;
  grouped: boolean;
  /** nama + cuplikan pesan yang di-reply, kalau pesannya ada di utas ini. */
  balasKe: { nama: string; cuplikan: string } | null;
  balasKeId: string | null;
  sembunyikanKutipan: boolean;
  peserta: Peserta[];
  kami?: { pn: string | null; lid: string | null };
  kontak?: PetaNama;
}) {
  const isTeam = m.direction === "out";
  const who = isTeam
    ? (m.agentName ?? (m.signatureCode ? `tim (#dsp ${m.signatureCode})` : "tim (tidak teratribusi)"))
    : namaOrang(kontak, { pn: m.senderPn, lid: m.senderLid }, m.senderPushName);

  const { isi, tanda } = pisahTandaTangan(m.body, isTeam);

  return (
    <li
      id={anchorId(m.stanzaId)}
      className={`pesan grid grid-cols-[44px_1fr] gap-3 ${grouped ? "mt-1" : "mt-3.5 first:mt-0"}`}
    >
      {/* Rel jam. Ada di SETIAP pesan, termasuk yang beruntun - itulah yang
          memberi batas antar pesan tanpa perlu garis pemisah, sekaligus kolom
          angka yang bisa dipindai lurus ke bawah. */}
      <time
        className="tnum pt-px text-right text-[11.5px] leading-[1.35] text-ink-faint"
        dateTime={m.createdAt.toISOString()}
        title={smartStamp(m.createdAt)}
      >
        {clock(m.createdAt)}
      </time>

      {/* Rel kiri dipasang di SEMUA pesan, warnanya saja yang berbeda. Kalau
          hanya pesan tim yang punya rel, badan teksnya bergeser beberapa piksel
          dari pesan klien dan tepi kiri utas jadi bergerigi - mata membaca
          gerigi itu sebagai struktur yang sebenarnya tidak ada. */}
      <div
        className="border-l-2 pl-3"
        style={{ borderColor: isTeam ? "var(--accent)" : "transparent" }}
      >
        {!grouped ? (
          <div className="flex flex-wrap items-baseline gap-x-3">
            <span className="micro" style={{ color: isTeam ? "var(--accent)" : "var(--ink)" }}>
              {who}
            </span>
            {isTeam && !m.agentId ? (
              /* section 10 kesehatan data: balasan tanpa agent_id tidak teratribusi.
                 Ditandai di tempat kejadiannya, bukan cuma di laporan leader. */
              <span className="text-[11px] text-st-doubt">bukan dari dashboard</span>
            ) : null}
          </div>
        ) : null}

        {/* Baris balasan bergaya Discord: nama DAN cuplikan isinya, satu baris,
            dipotong kalau panjang. Yang ingin diketahui agen bukan "membalas
            siapa" tapi "membalas yang mana" - dan di utas panjang satu orang
            bisa mengirim delapan pesan. Tetap tautan: diklik, melompat ke
            pesannya dan menyorotnya. */}
        {balasKe && balasKeId ? (
          <a
            href={`#${anchorId(balasKeId)}`}
            className="mt-0.5 flex max-w-[68ch] items-baseline gap-1.5 text-[11.5px] text-ink-faint transition-colors hover:text-ink"
            title={`Lompat ke pesan ${balasKe.nama}`}
          >
            <span className="shrink-0 opacity-70">&#8627;</span>
            <span className="shrink-0" style={{ color: "var(--ink-muted)" }}>
              {balasKe.nama}
            </span>
            <span className="truncate">{balasKe.cuplikan}</span>
          </a>
        ) : m.quotedSnippet && !grouped && !sembunyikanKutipan ? (
          <p className="mt-1 max-w-[68ch] border-l border-rule pl-2.5 text-[12.5px] text-ink-faint truncate-2">
            {m.quotedSnippet}
          </p>
        ) : null}

        {m.isDeleted ? (
          /* section 12: tandai, jangan ikut hilang dari tiket. */
          <p className="mt-1 text-[13px] italic text-ink-faint">Pesan ini dihapus pengirim.</p>
        ) : (
          /* Lebar baca dibatasi. Panel ini bisa selebar 900px, dan baris sepanjang
             itu membuat mata kehilangan awal baris berikutnya - keluhan "sulit
             dibaca" yang paling sering ternyata soal panjang baris, bukan ukuran
             huruf. */
          <p className="mt-1 max-w-[68ch] whitespace-pre-wrap text-[13.5px] leading-relaxed">
            {isi ? (
              <Ditandai teks={isi} peserta={peserta} kami={kami} />
            ) : (
              <span className="italic text-ink-faint">tanpa teks</span>
            )}
            {m.isEdited ? <span className="ml-2 text-[11px] text-ink-faint">(diedit)</span> : null}
          </p>
        )}

        {/* Tetap terlihat - buktinya bahwa balasan ini bertanda tangan - tapi
            tidak lagi memakan satu baris penuh di tiap pesan tim. */}
        {tanda ? <span className="mt-0.5 inline-block text-[11px] text-ink-faint">{tanda}</span> : null}

        {m.mediaMeta ? <MediaLine meta={m.mediaMeta} stanzaId={m.stanzaId} groupJid={m.groupJid} /> : null}
      </div>
    </li>
  );
}

/**
 * section 12: media TIDAK disimpan. Yang ada di database cuma metadata; berkasnya
 * diambil on-demand lewat gateway dan langsung di-stream ke browser.
 * Kalau sudah kedaluwarsa, tampilkan pesan jelas - bukan tombol yang gagal diam-diam.
 */
function MediaLine({
  meta,
  stanzaId,
  groupJid,
}: {
  meta: NonNullable<ThreadMessage["mediaMeta"]>;
  stanzaId: string;
  groupJid: string;
}) {
  const size = meta.fileLength ? formatBytes(meta.fileLength) : null;
  return (
    <div className="mt-1.5 flex items-baseline gap-2 text-[12.5px]">
      <span className="tnum text-ink-faint">[{meta.mimetype?.split("/")[1] ?? "berkas"}]</span>
      <span className="truncate text-ink">{meta.fileName ?? "tanpa nama"}</span>
      {size ? <span className="tnum shrink-0 text-ink-faint">{size}</span> : null}
      <a
        className="ml-auto shrink-0 text-accent underline-offset-2 hover:underline"
        href={`/api/media/${encodeURIComponent(stanzaId)}?grup=${encodeURIComponent(groupJid)}`}
        target="_blank"
        rel="noreferrer"
      >
        Unduh
      </a>
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/* ------------------- section 7.2 pesan dari sebelum sistem aktif ------------------- */

export function MissingParent({
  quotedSnippet,
  candidates,
  groupJid,
}: {
  quotedSnippet: string | null;
  candidates: ArchiveCandidate[];
  groupJid: string;
}) {
  return (
    <div className="rule-b bg-sunk px-5 py-3">
      <p className="micro">Membalas pesan dari sebelum sistem aktif</p>

      {quotedSnippet ? (
        <p className="mt-2 border-l-2 border-rule-strong pl-3 text-[13px] text-ink">{quotedSnippet}</p>
      ) : (
        /* section 7.2: "Jangan tampilkan kutipan kosong." */
        <p className="mt-2 text-[13px] text-ink-muted">
          WhatsApp tidak ikut mengirim cuplikan pesan yang dibalas.
        </p>
      )}

      {candidates.length > 0 ? (
        <div className="mt-3">
          <p className="micro text-ink-faint">Kemungkinan cocok dari arsip</p>
          <ul className="mt-1.5 space-y-1.5">
            {candidates.map((c) => (
              <li key={c.id} className="text-[12.5px]">
                <span className="tnum text-ink-faint">{smartStamp(c.sentAt)}</span>
                <span className="mx-2 text-ink">{c.senderName ?? "?"}</span>
                <span className="text-ink-muted">{c.body.slice(0, 140)}</span>
              </li>
            ))}
          </ul>
          {/* Jujur soal derajat keyakinan: arsip dicocokkan lewat teks, bukan ID. */}
          <p className="mt-2 text-[11.5px] text-ink-faint">
            Dicocokkan lewat isi teks, bukan ID pesan - bisa saja salah. Tidak pernah dihitung dalam SLA.
          </p>
        </div>
      ) : null}

      <a
        className="mt-3 inline-block text-[12.5px] text-accent underline-offset-2 hover:underline"
        href={`https://wa.me/`}
        target="_blank"
        rel="noreferrer"
        title={groupJid}
      >
        Buka WhatsApp
      </a>
    </div>
  );
}
