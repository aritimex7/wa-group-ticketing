import Link from "next/link";
import { Elapsed } from "./Elapsed";
import { denganDari, jalurPapan } from "@/lib/kembali";
import { jamRingkas } from "@/lib/time";
import { teksMention } from "@/lib/mention";
import { namaOrang, toIdentity, type PetaNama } from "@/lib/identity";
import type { BoardTicket } from "@/lib/queries";

const TYPE_LABEL: Record<string, string> = {
  image: "gambar",
  video: "video",
  document: "dokumen",
  audio: "suara",
  sticker: "stiker",
  location: "lokasi",
};

/**
 * Satu baris antrean.
 *
 * Kenapa baris, bukan kartu: gaya terang-editorial sering dituduh boros ruang,
 * dan memang begitu kalau tiap tiket dibungkus kotak ber-shadow. Yang memakan
 * tempat adalah kotaknya, bukan warnanya. Di sini pemisahnya cuma garis rambut.
 *
 * Terukur di 1440x900 dengan tata letak tab: 63px per baris, SERAGAM - karena
 * penanda duduk di kolom kanan, bukan menumpuk di bawah teks. Sekitar 12 baris
 * per layar tanpa scroll, dan cuplikan pesan dapat ~1140px sebelum terpotong
 * (di tata letak tiga kolom dulu cuma ~330px, hampir selalu kepotong).
 *
 * Rel kiri selebar 64px berisi timer semua baris sejajar, sehingga mata bisa
 * memindai satu kolom angka dari atas ke bawah tanpa melompat-lompat.
 */
export function TicketRow({
  t,
  variant,
  warnPct,
  meAgentId,
  kami,
  kontak,
  now,
}: {
  t: BoardTicket;
  variant: "open" | "progress" | "done";
  warnPct: number;
  meAgentId: number;
  /** section 12 identitas kita, supaya "@<LID kita>" di cuplikan tampil "@kami". */
  kami?: { pn: string | null; lid: string | null };
  /** nama kontak tersimpan - dipakai lebih dulu daripada pushName. */
  kontak?: PetaNama;
  /** stempel waktu server, satu untuk seluruh halaman - lihat Elapsed. */
  now?: number;
}) {
  const sender = namaOrang(kontak, { pn: t.senderPn, lid: t.senderLid }, t.senderPushName);
  /* Di chat pribadi, "nama grup" adalah lawan bicaranya - dan JID-nya sendiri
     sudah identitas orang itu, jadi nama kontak tersimpan bisa dipakai walaupun
     kolom name di tabel masih berisi pushName lama. */
  const judul = t.isDm
    ? namaOrang(kontak, toIdentity(t.groupJid), t.groupName)
    : (t.groupName ?? t.groupJid.replace(/@g\.us$/, ""));
  const typeTag = TYPE_LABEL[t.msgType];
  /* Cuplikan papan tidak punya daftar peserta grup - memanggil gateway sekali
     per baris jelas tidak masuk akal. Yang bisa dikenali tanpa data tambahan
     cuma nomor kita sendiri, dan justru itu mention yang paling sering muncul:
     hampir setiap tiket lahir dari seseorang menandai kita. */
  const snippet = t.body ? teksMention(t.body, [], kami).replace(/\s+/g, " ").trim() : undefined;
  const mine = t.claimedBy === meAgentId;
  /* Diambil dari STATUS tiketnya, bukan dari tab yang sedang dibuka. Sekarang
     keduanya kebetulan sejalan, tapi status itulah alasan sebenarnya - penanda
     disembunyikan karena perkaranya sudah selesai, bukan karena kebetulan
     sedang dilihat dari daftar Done. */
  const aktif = t.status === "open" || t.status === "on_progress";

  const until = variant === "done" ? (t.resolvedAt ?? t.closedAt) : null;
  const target = variant === "done" ? t.slaTargetResMin : t.slaTargetFrMin;

  return (
    <Link
      /* Bawa tab asalnya. Tanpa ini, kembali dari tiket yang dibuka dari Done
         selalu mendarat di Open, dan agen harus mencari tabnya lagi tiap kali. */
      href={denganDari(`/tiket/${t.id}`, jalurPapan(variant))}
      className={[
        "grid grid-cols-[64px_1fr] gap-3 px-4 py-2.5 rule-b transition-colors",
        "hover:bg-sunk focus-visible:bg-sunk",
        t.hasFailedSend ? "bg-tint-breach" : mine ? "bg-tint-mine" : "",
      ].join(" ")}
    >
      <div className="pt-px">
        <Elapsed from={t.triggeredAt} until={until} targetMin={target} warnPct={warnPct} now={now} />
      </div>

      {/* Dua blok: teks yang boleh menyusut, penanda yang tidak.
          Di layar lebar penanda naik ke kanan supaya lebar yang didapat dari
          tata letak tab dipakai untuk kalimat klien, bukan jadi ruang kosong. */}
      <div className="min-w-0 md:flex md:items-start md:gap-6">
        <div className="min-w-0 md:flex-1">
          <div className="flex items-baseline gap-2">
            {/* Nama grup adalah hal pertama yang dibaca. section 9.2: salah kirim ke
                grup lain adalah kesalahan paling fatal dan paling sering. */}
            <span className="truncate text-[14.5px] font-semibold leading-tight">
              {judul}
            </span>
            {/* Chat pribadi kelihatan berbeda sejak baris papan. Tanpa ini,
                "salah kirim ke grup lain" (section 9.2) berubah jadi risiko baru:
                membalas ke japri padahal mengira sedang di grup klien. */}
            {t.isDm ? <span className="micro shrink-0 text-ink-faint">japri</span> : null}
            {t.clientLabel ? (
              <span className="micro shrink-0 text-ink-faint">{t.clientLabel}</span>
            ) : null}
          </div>

          <p className="mt-1 truncate text-[13px] text-ink-muted">
            {/* Jam pesan TERAKHIR di tiket ini, bukan jam pesan pemicu - rel
                kiri sudah memberi lamanya menunggu, yang belum ada adalah
                "kapan percakapan ini terakhir bergerak".

                Ditaruh di baris kedua, bukan barisnya sendiri: baris papan
                tingginya seragam 63px dan muat dua belas di satu layar; baris
                ketiga menaikkannya seperempat dan memotong dua baris terakhir
                dari pandangan. */}
            <span className="tnum text-ink-faint">{jamRingkas(t.lastMessageAt)}</span>
            <span className="text-ink-faint"> &middot; </span>
            {/* Di japri pengirimnya SELALU orang yang sama dengan judul barisnya.
                Mengulangnya cuma memakan lebar yang seharusnya jadi kalimat
                klien - "Rina Wijaya . Rina Wijaya . pagi bang". */}
            {t.isDm ? null : (
              <>
                <span className="text-ink">{sender}</span>
                <span className="text-ink-faint"> &middot; </span>
              </>
            )}
            {typeTag ? <span className="tnum text-[11.5px] text-ink-faint">[{typeTag}] </span> : null}
            {snippet || <span className="italic text-ink-faint">tanpa teks</span>}
          </p>
        </div>

        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 empty:mt-0 md:mt-0.5 md:shrink-0 md:flex-col md:items-end md:gap-y-1.5">
          {variant === "progress" && t.claimedByName ? (
            <Flag tone={mine ? "done" : "progress"}>
              {mine ? "Anda menangani" : `Ditangani ${t.claimedByName}`}
            </Flag>
          ) : null}

          {variant === "done" && t.claimedByName ? (
            <Flag tone="idle">{t.claimedByName}</Flag>
          ) : null}

          {/* section 6.9 pesan susulan yang belum dijawab. Bukan tiket baru, tapi
              tetap harus kelihatan - cuplikan di kiri cuma pesan pertama.

              Tidak muncul di tiket yang sudah selesai. "Belum dijawab" adalah
              ajakan bertindak, dan pada perkara yang sudah ditutup ajakan itu
              tidak menuju ke mana-mana: agen membukanya, tidak menemukan yang
              perlu dikerjakan, lalu belajar mengabaikan penanda ini - termasuk
              di tab Open, tempat ia justru berarti. */}
          {t.susulan > 0 && aktif ? (
            <Flag tone="open">
              {t.susulan === 1 ? "1 pesan susulan" : `${t.susulan} pesan susulan`} belum dijawab
            </Flag>
          ) : null}

          {/* section 6.4 penanda kuning: tetap di antrean, hanya diturunkan prioritasnya. */}
          {t.likelyNotOurs ? <Flag tone="doubt">Mungkin bukan untuk kita</Flag> : null}

          {/* section 9.4 kirim gagal tidak boleh hilang diam-diam. */}
          {t.hasFailedSend ? <Flag tone="breach">Kirim gagal - teks masih tersimpan</Flag> : null}

          {/* section 6.8 peringatan lunak. Tidak menghalangi, hanya membuat sadar. */}
          {t.siblings > 0 && variant !== "done" ? (
            <Flag tone="idle">
              {t.siblings} tiket lain terbuka {t.isDm ? "dari orang ini" : "di grup ini"}
            </Flag>
          ) : null}
        </div>
      </div>
    </Link>
  );
}

const TONE: Record<string, string> = {
  open: "var(--st-open)",
  progress: "var(--st-progress)",
  done: "var(--st-done)",
  breach: "var(--st-breach)",
  doubt: "var(--st-doubt)",
  idle: "var(--st-idle)",
};

/**
 * Penanda status. Warna TIDAK PERNAH jadi satu-satunya pembeda - selalu ada
 * teksnya. Sekitar 1 dari 12 laki-laki kesulitan membedakan merah dan hijau,
 * dan tim ini empat orang.
 */
export function Flag({ tone, children }: { tone: keyof typeof TONE | string; children: React.ReactNode }) {
  const color = TONE[tone] ?? TONE.idle;
  return (
    <span className="inline-flex items-center gap-1.5 text-[11.5px] leading-none" style={{ color }}>
      <span className="dot" style={{ background: color }} />
      {children}
    </span>
  );
}
