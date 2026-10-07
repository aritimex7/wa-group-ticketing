import Link from "next/link";
import { requireAgent } from "@/lib/auth";
import { BOARD_TABS, boardCounts, isBoardTab, loadColumn, personalStats } from "@/lib/queries";
import { getSetting } from "@/lib/settings";
import { TicketRow } from "@/components/TicketRow";
import { selfIdentity } from "@/lib/identity";
import { kontakTersimpan } from "@/lib/orang";
import type { BoardTab } from "@/lib/queries";

export const dynamic = "force-dynamic";

/**
 * Papan tiket agen - SPEC section 9.
 *
 * PENYIMPANGAN DARI section 9.1 (diminta pemilik): spesifikasi meminta tiga kolom
 * bersebelahan; di sini ketiganya jadi tab, satu daftar tampil penuh lebar.
 * Konsekuensi yang diterima: agen tidak lagi melihat sekilas siapa sedang
 * menangani apa - harus pindah ke tab Progress dulu.
 *
 * Tab dipilih lewat query string, bukan state di klien. Alasannya: papan ini
 * menyegarkan diri tiap ada peristiwa realtime (lihat components/Realtime),
 * dan state klien akan hilang tiap penyegaran. Lewat URL, tab bertahan - dan
 * bonusnya bisa di-bookmark.
 *
 * section 9.6 yang tetap TIDAK ada di sini: perbandingan antar agen (milik leader).
 */
export default async function BoardPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const user = await requireAgent();
  const sp = await searchParams;
  const tab: BoardTab = isBoardTab(sp.tab) ? sp.tab : "open";

  const [counts, tickets, warnPct, stats] = await Promise.all([
    boardCounts(),
    loadColumn(tab),
    getSetting("sla.warn_threshold_pct"),
    personalStats(user.id),
  ]);
  /* Nama kontak berlaku lintas grup dan di-cache satu kali untuk seluruh
     aplikasi, jadi ini bukan satu panggilan gateway per baris papan. */
  const kontak = await kontakTersimpan();

  const active = BOARD_TABS.find((t) => t.key === tab)!;
  const kami = selfIdentity();
  /* Satu stempel untuk seluruh halaman - lihat catatan di komponen Elapsed. */
  const now = Date.now();

  return (
    <div className="flex h-full flex-col">
      <PersonalStrip stats={stats} />

      {/* ----------------------------- bar tab ----------------------------- */}
      <nav className="rule-b flex shrink-0 items-end gap-1 bg-paper px-4" aria-label="Status tiket">
        {BOARD_TABS.map((t) => {
          const on = t.key === tab;
          return (
            <Link
              key={t.key}
              href={t.key === "open" ? "/" : `/?tab=${t.key}`}
              aria-current={on ? "page" : undefined}
              className={[
                "-mb-px flex items-baseline gap-2 border-b-2 px-3 py-2.5 transition-colors",
                on
                  ? "border-accent text-ink"
                  : "border-transparent text-ink-muted hover:border-rule-strong hover:text-ink",
              ].join(" ")}
            >
              <span className="micro" style={{ color: "inherit" }}>
                {t.label}
              </span>
              <span className={`tnum text-[13px] ${on ? "text-ink" : "text-ink-faint"}`}>
                {counts[t.key]}
              </span>
            </Link>
          );
        })}
        <span className="ml-auto hidden py-3 text-[11.5px] text-ink-faint sm:block">{active.hint}</span>
      </nav>

      {/* ----------------------------- daftar ----------------------------- */}
      <div className="scroll-y min-h-0 flex-1">
        {tickets.length === 0 ? (
          <Empty tab={tab} />
        ) : (
          tickets.map((t) => (
            <TicketRow
              key={t.id}
              t={t}
              variant={tab}
              warnPct={warnPct}
              meAgentId={user.id}
              kami={kami}
              kontak={kontak}
              now={now}
            />
          ))
        )}
      </div>
    </div>
  );
}

function Empty({ tab }: { tab: BoardTab }) {
  const copy: Record<BoardTab, { title: string; body: string }> = {
    open: {
      title: "Tidak ada yang menunggu.",
      body: "Tidak ada pesan klien yang menunggu balasan.",
    },
    progress: {
      title: "Belum ada yang diambil.",
      body: "Tiket berpindah ke sini begitu ada yang membukanya.",
    },
    done: {
      title: "Belum ada yang selesai hari ini.",
      body: "",
    },
  };
  const c = copy[tab];
  return (
    <div className="px-4 py-12">
      <p className="text-[14px] text-ink-muted">{c.title}</p>
      {c.body ? <p className="mt-1 text-[13px] text-ink-faint">{c.body}</p> : null}
    </div>
  );
}

/**
 * section 9.3 statistik pribadi.
 *
 * "Agen harus bisa melihat angkanya sendiri - sama persis dengan yang dilihat
 *  leader. Metrik yang hanya terlihat dari atas lebih cepat diakali daripada
 *  diperbaiki."
 *
 * Atas keputusan pemilik, yang ditampilkan tinggal dua angka: berapa yang
 * ditangani dan berapa yang lewat SLA. Dua median dipindahkan sepenuhnya ke
 * dashboard leader.
 */
function PersonalStrip({ stats }: { stats: { handled: number; breaches: number } }) {
  return (
    <div className="rule-b flex flex-wrap items-baseline gap-x-7 gap-y-1 bg-surface px-4 py-2">
      <span className="micro">Hari ini</span>
      <Stat label="ditangani" value={String(stats.handled)} />
      <Stat
        label="lewat SLA"
        value={String(stats.breaches)}
        tone={stats.breaches > 0 ? "var(--st-breach)" : undefined}
      />
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <span className="tnum text-[14px]" style={tone ? { color: tone } : undefined}>
        {value}
      </span>
      <span className="text-[11.5px] text-ink-faint">{label}</span>
    </span>
  );
}
