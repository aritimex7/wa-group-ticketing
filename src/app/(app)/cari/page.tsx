import Link from "next/link";
import { requireAgent } from "@/lib/auth";
import { searchMessages } from "@/lib/thread";
import { smartStamp } from "@/lib/time";
import { denganDari } from "@/lib/kembali";
import { namaOrang, selfIdentity } from "@/lib/identity";
import { teksMention } from "@/lib/mention";
import { kontakTersimpan } from "@/lib/orang";

export const dynamic = "force-dynamic";

/** section 7.3 pencarian teks lintas grup. */
export default async function CariPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  await requireAgent();
  const q = (await searchParams).q?.trim() ?? "";
  /* Hasil pencarian mahal untuk diketik ulang, jadi ikut dibawa sebagai
     jalan pulang - bukan cuma "/cari" yang kosong. */
  const asal = q ? `/cari?q=${encodeURIComponent(q)}` : "/cari";
  const hasil = q ? await searchMessages(q) : [];
  const kami = selfIdentity();
  const kontak = await kontakTersimpan();

  return (
    <div className="scroll-y h-full">
      <div className="mx-auto max-w-[820px] px-5 pb-16">
        <header className="py-7">
          <h1 className="text-[22px]">Cari pesan</h1>
          <form className="mt-4 flex gap-2">
            <input
              name="q"
              defaultValue={q}
              autoFocus
              placeholder="kata kunci..."
              className="field"
              spellCheck={false}
            />
            <button className="btn btn-primary shrink-0">Cari</button>
          </form>
          <p className="mt-2 text-[12px] text-ink-faint">
            Mencari di seluruh pesan grup yang dipantau, sejak gateway tersambung.
          </p>
        </header>

        {q && hasil.length === 0 ? (
          <p className="rule-t py-7 text-[13px] text-ink-muted">Tidak ada yang cocok dengan &ldquo;{q}&rdquo;.</p>
        ) : null}

        <ol>
          {hasil.map((h) => (
            <li key={h.stanzaId} className="rule-b py-3">
              <div className="flex items-baseline gap-3">
                <Link
                  href={denganDari(
                    `/grup/${encodeURIComponent(h.groupJid)}?pada=${encodeURIComponent(h.createdAt.toISOString())}`,
                    asal,
                  )}
                  className="text-[14px] font-semibold hover:underline"
                >
                  {h.groupName ?? h.groupJid}
                </Link>
                <time className="tnum ml-auto shrink-0 text-[11.5px] text-ink-faint">
                  {smartStamp(h.createdAt)}
                </time>
              </div>
              <p className="mt-1 text-[13px] text-ink-muted">
                {/* Untuk pesan kita sendiri, pushName dari WhatsApp berisi
                    "Voce"/"You" - tidak ada gunanya. Tampilkan agennya. */}
                <span className="text-ink">
                  {h.direction === "out"
                    ? (h.agentName ??
                      (h.signatureCode ? `Tim - #dsp ${h.signatureCode}` : "Tim"))
                    : namaOrang(kontak, { pn: h.senderPn, lid: h.senderLid }, h.senderPushName)}
                </span>
                <span className="text-ink-faint"> &middot; </span>
                {/* section 12: hasil cari lintas grup, jadi daftar peserta tiap
                    grup tidak tersedia di sini - yang bisa dikenali cuma nomor
                    kita sendiri, dan itu memang mention yang paling sering ada. */}
                {h.body ? teksMention(h.body, [], kami) : h.body}
              </p>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
