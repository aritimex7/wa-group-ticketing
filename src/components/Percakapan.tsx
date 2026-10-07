import { clock, dayMonth } from "@/lib/time";
import { anchorId, Ditandai } from "@/components/Thread";
import type { Peserta } from "@/lib/mention";
import { namaOrang, type PetaNama } from "@/lib/identity";
import type { ThreadMessage } from "@/lib/thread";

/**
 * Tampilan "Lihat chat grup" - SPEC section 7.3.
 *
 *   "Membuka percakapan grup apa adanya di sekitar jam tiket, bisa di-scroll
 *    seperti WhatsApp. Read-only."
 *
 * SENGAJA BERBEDA dari panel utas di halaman tiket, dan bedanya berdasar:
 *
 *   Panel utas (components/Thread) dipakai untuk MEMINDAI - "apa yang terjadi
 *   di utas ini" dalam dua detik sebelum membalas. Transkrip padat menang di
 *   sana; gelembung memboroskan separuh lebar layar.
 *
 *   Halaman ini dipakai untuk MEMBACA percakapan sebagaimana terjadi, dan
 *   spesifikasinya sendiri menyebut "seperti WhatsApp". Di sini gelembung dan
 *   perataan kiri-kanan justru yang benar: pertanyaan utamanya bukan "apa
 *   isinya" tapi "siapa bilang apa, dan siapa yang belum dijawab". Rata kanan
 *   menjawab itu tanpa perlu dibaca.
 *
 * Radius gelembungnya tetap kecil (6px) supaya tidak keluar dari sistem visual
 * yang lain, dan tidak ada bayangan - pemisahnya warna latar, bukan tumpukan.
 */
export function Percakapan({
  messages,
  /** section 12 peserta grup, supaya mention tampil sebagai nama. */
  peserta = [],
  kami,
  /** nama kontak tersimpan - dipakai lebih dulu daripada pushName. */
  kontak,
}: {
  messages: ThreadMessage[];
  peserta?: Peserta[];
  kami?: { pn: string | null; lid: string | null };
  kontak?: PetaNama;
}) {
  if (!messages.length) {
    return (
      <p className="px-5 py-10 text-[13px] text-ink-muted">
        Tidak ada pesan tersimpan di sekitar waktu itu.
      </p>
    );
  }

  let hariTerakhir = "";

  /* Pesan mana saja yang ADA di jendela ini. Kutipan hanya jadi tautan kalau
     induknya benar-benar termuat - jendela dibatasi jumlah baris, jadi pesan
     yang dibalas bisa saja tertinggal di luar layar. Tautan yang menuju tempat
     kosong lebih buruk daripada tidak ada tautan. */
  const hadir = new Set(messages.map((m) => m.stanzaId));

  return (
    <div className="mx-auto max-w-[860px] px-4 py-4">
      {messages.map((m, i) => {
        const hari = dayMonth(m.createdAt);
        const gantiHari = hari !== hariTerakhir;
        hariTerakhir = hari;

        const prev = messages[i - 1];
        const samaBicara =
          !gantiHari &&
          prev &&
          prev.direction === m.direction &&
          prev.senderPushName === m.senderPushName &&
          prev.agentId === m.agentId &&
          m.createdAt.getTime() - prev.createdAt.getTime() < 5 * 60_000;

        return (
          <div key={m.stanzaId}>
            {gantiHari ? <PemisahHari label={hari} /> : null}
            <Gelembung
              m={m}
              sembunyikanNama={Boolean(samaBicara)}
              indukAda={Boolean(m.replyToStanzaId && hadir.has(m.replyToStanzaId))}
              peserta={peserta}
              kami={kami}
              kontak={kontak}
            />
          </div>
        );
      })}
    </div>
  );
}

/** Pemisah hari - garis rambut dengan label di tengah. */
function PemisahHari({ label }: { label: string }) {
  return (
    <div className="my-5 flex items-center gap-3" role="separator">
      <span className="h-px flex-1 bg-rule" />
      <span className="micro shrink-0">{label}</span>
      <span className="h-px flex-1 bg-rule" />
    </div>
  );
}

function Gelembung({
  m,
  sembunyikanNama,
  indukAda,
  peserta,
  kami,
  kontak,
}: {
  m: ThreadMessage;
  sembunyikanNama: boolean;
  /** pesan yang dibalas termuat di jendela ini, jadi kutipannya boleh jadi tautan. */
  indukAda: boolean;
  peserta: Peserta[];
  kami?: { pn: string | null; lid: string | null };
  kontak?: PetaNama;
}) {
  const kita = m.direction === "out";

  const nama = kita
    ? (m.agentName ??
      (m.signatureCode ? `Tim - #dsp ${m.signatureCode}` : "Tim - tidak teratribusi"))
    : namaOrang(kontak, { pn: m.senderPn, lid: m.senderLid }, m.senderPushName);

  return (
    <div className={`mt-1.5 flex ${kita ? "justify-end" : "justify-start"}`}>
      <div className={`max-w-[72%] min-w-0 ${kita ? "items-end" : "items-start"} flex flex-col`}>
        {!sembunyikanNama ? (
          <span
            className="micro mb-1 px-0.5"
            style={{ color: kita ? "var(--accent)" : "var(--ink-muted)" }}
          >
            {nama}
          </span>
        ) : null}

        <div
          id={anchorId(m.stanzaId)}
          className="pesan gelembung rounded-[6px] border px-3 py-2"
          style={
            {
              "--gel-bg": kita ? "var(--accent-soft)" : "var(--surface)",
              borderColor: kita ? "transparent" : "var(--rule)",
            } as React.CSSProperties
          }
        >
          {m.quotedSnippet ? (
            /* Kutipan yang bisa diklik, sama seperti di utas tiket: melompat ke
               pesan aslinya dan menyorotnya. Hanya kalau pesan itu memang
               termuat di jendela ini. */
            indukAda && m.replyToStanzaId ? (
              <a
                href={`#${anchorId(m.replyToStanzaId)}`}
                className="mb-1.5 block border-l-2 pl-2 text-[12px] text-ink-faint truncate-2 transition-colors hover:text-ink"
                style={{ borderColor: "var(--rule-strong)" }}
                title="Lompat ke pesan yang dibalas"
              >
                <Ditandai teks={m.quotedSnippet} peserta={peserta} kami={kami} />
              </a>
            ) : (
              <p className="mb-1.5 border-l-2 pl-2 text-[12px] text-ink-faint truncate-2" style={{ borderColor: "var(--rule-strong)" }}>
                <Ditandai teks={m.quotedSnippet} peserta={peserta} kami={kami} />
              </p>
            )
          ) : null}

          {m.isDeleted ? (
            /* section 12: tandai, jangan ikut hilang. */
            <p className="text-[13px] italic text-ink-faint">Pesan ini dihapus pengirim.</p>
          ) : (
            <p className="whitespace-pre-wrap break-words text-[13.5px] leading-relaxed">
              {m.body ? (
                <Ditandai teks={m.body} peserta={peserta} kami={kami} />
              ) : (
                <span className="italic text-ink-faint">tanpa teks</span>
              )}
            </p>
          )}

          {m.mediaMeta ? (
            <p className="mt-1 text-[12px] text-ink-muted">
              <span className="tnum text-ink-faint">
                [{m.mediaMeta.mimetype?.split("/")[1] ?? "berkas"}]
              </span>{" "}
              {m.mediaMeta.fileName ?? "tanpa nama"}
            </p>
          ) : null}

          <div className="mt-1 flex items-center justify-end gap-2">
            {m.isEdited ? <span className="text-[10.5px] text-ink-faint">diedit</span> : null}
            {kita && !m.agentId ? (
              /* section 10: balasan tanpa agent_id tidak teratribusi. Ditandai di
                 tempat kejadiannya, bukan cuma di laporan leader. */
              <span className="text-[10.5px]" style={{ color: "var(--st-doubt)" }}>
                bukan dari dashboard
              </span>
            ) : null}
            <time className="tnum text-[10.5px] text-ink-faint" dateTime={m.createdAt.toISOString()}>
              {clock(m.createdAt)}
            </time>
          </div>
        </div>
      </div>
    </div>
  );
}
