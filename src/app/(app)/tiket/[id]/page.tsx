import Link from "next/link";
import { notFound } from "next/navigation";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { agents, quickReplies, ticketEvents, tickets } from "@/db/schema";
import { requireAgent } from "@/lib/auth";
import { loadTicket, ticketAnchor } from "@/lib/queries";
import { loadThread, resolveMissingParent } from "@/lib/thread";
import { pendingForTicket } from "@/lib/outbox";
import { getSetting } from "@/lib/settings";
import { Thread, MissingParent } from "@/components/Thread";
import { Compose } from "@/components/Compose";
import { PendingOutbox } from "@/components/PendingOutbox";
import { Elapsed } from "@/components/Elapsed";
import { clock, durationWords, smartStamp } from "@/lib/time";
import { denganDari, kembaliAman, labelKembali } from "@/lib/kembali";
import { daftarTag, kontakTersimpan, orangGrup } from "@/lib/orang";
import { indeksPeserta } from "@/lib/mention";
import { namaOrang, selfIdentity, toIdentity } from "@/lib/identity";

export const dynamic = "force-dynamic";

/* Chat pribadi tidak "dipicu" oleh apa pun - tiap pesan yang masuk ke sana
   memang ditujukan ke kita. Kalimatnya beda, bukan cuma katanya. */
const PEMICU: Record<string, string> = {
  mention: "Dipicu oleh mention dari",
  reply: "Dipicu oleh swipe-reply dari",
  dm: "Chat pribadi dari",
};

const AKSI: Record<string, string> = {
  created: "tiket dibuat",
  claim: "diambil",
  release: "dilepas",
  auto_release: "dilepas otomatis",
  takeover: "diambil alih",
  reply_sent: "balasan dikirim",
  send_failed: "kirim gagal",
  mark_on_check: "ditandai on check",
  mark_resolved: "ditandai selesai",
  mark_not_for_us: "bukan untuk kami",
  bulk_closed: "ikut ditutup",
  note_updated: "catatan diubah",
  merged: "pesan susulan masuk",
  undo: "dibatalkan",
};

export default async function TicketPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ dari?: string }>;
}) {
  const me = await requireAgent();
  const id = Number((await params).id);
  const kembali = kembaliAman((await searchParams).dari);
  if (!Number.isInteger(id)) notFound();

  const t = await loadTicket(id);
  if (!t) notFound();

  const anchor = await ticketAnchor(id);

  const [thread, pending, warnPct, onCheckText, templates, history, peserta] = await Promise.all([
    loadThread(anchor.stanzaId, anchor.groupJid, t.id),
    pendingForTicket(id),
    getSetting("sla.warn_threshold_pct"),
    getSetting("ops.on_check_text"),
    db.select().from(quickReplies).where(eq(quickReplies.isActive, true)).orderBy(quickReplies.sortOrder),
    db
      .select({
        action: ticketEvents.action,
        toValue: ticketEvents.toValue,
        createdAt: ticketEvents.createdAt,
        agentName: agents.name,
      })
      .from(ticketEvents)
      .leftJoin(agents, eq(agents.id, ticketEvents.agentId))
      .where(eq(ticketEvents.ticketId, id))
      .orderBy(desc(ticketEvents.createdAt))
      .limit(30),
    /* section 12 sasaran mention. Ikut Promise.all supaya panggilan gateway ini
       tidak menambah waktu buka halaman - ia berjalan berbarengan dengan utas. */
    orangGrup(t.groupJid),
  ]);
  const [kontak, daftar] = await Promise.all([kontakTersimpan(), daftarTag()]);
  /* Satu stempel untuk seluruh halaman - lihat catatan di komponen Elapsed. */
  const now = Date.now();

  /* section 12: berapa anggota tiap daftar yang BENAR-BENAR ada di grup ini.
     Dihitung di server karena di sinilah daftar peserta grupnya ada; kotak
     balas cuma menampilkannya. */
  const idxPeserta = indeksPeserta(peserta);
  const daftarSiap = daftar.map((d) => ({
    ...d,
    adaDiGrup: d.anggota.filter((a) => (a.lid && idxPeserta.has(a.lid)) || (a.pn && idxPeserta.has(a.pn)))
      .length,
  }));

  /* section 7.2: kalau induk yang di-reply tidak ada di database, jangan tampilkan
     kutipan kosong - tampilkan cuplikan dari payload plus kandidat dari arsip. */
  const parentMissing =
    anchor.replyToStanzaId !== null && !thread.some((m) => m.stanzaId === anchor.replyToStanzaId);
  const missing = parentMissing ? await resolveMissingParent(anchor.quotedSnippet, t.groupJid) : null;

  /* Di chat pribadi "nama grup" adalah lawan bicaranya; JID-nya sudah identitas
     orang itu, jadi nama kontak tersimpan tetap menang. */
  const groupName = t.isDm
    ? namaOrang(kontak, toIdentity(t.groupJid), t.groupName)
    : (t.groupName ?? t.groupJid.replace(/@g\.us$/, ""));

  async function saveNote(formData: FormData) {
    "use server";
    const { requireAgent } = await import("@/lib/auth");
    const user = await requireAgent();
    const note = String(formData.get("note") ?? "").slice(0, 2000);
    const ticketId = Number(formData.get("ticketId"));
    await db.update(tickets).set({ note }).where(eq(tickets.id, ticketId));
    await db.insert(ticketEvents).values({ ticketId, agentId: user.id, action: "note_updated" });
    const { revalidatePath } = await import("next/cache");
    revalidatePath(`/tiket/${ticketId}`);
  }

  return (
    <div className="flex h-full">
      <div className="flex min-w-0 flex-1 flex-col">
        {/* ---------------- kepala ---------------- */}
        <header className="rule-b shrink-0 bg-surface px-5 py-3">
          <div className="flex items-baseline gap-3">
            <Link href={kembali} className="text-[13px] text-ink-muted hover:text-ink">
              &larr; {labelKembali(kembali)}
            </Link>
            <span className="tnum text-[12px] text-ink-faint">tiket #{t.id}</span>
          </div>

          <div className="mt-1.5 flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <h1 className="text-[22px] leading-tight">{groupName}</h1>
            {t.clientLabel ? <span className="micro text-ink-faint">{t.clientLabel}</span> : null}
            <Link
              /* Jalan pulang ikut dibawa BERANTAI: dari chat grup kembali ke
                 tiket ini, dan dari tiket ini kembali ke tab asalnya. */
              href={denganDari(
                `/grup/${encodeURIComponent(t.groupJid)}?pada=${encodeURIComponent(t.triggeredAt.toISOString())}`,
                denganDari(`/tiket/${t.id}`, kembali),
              )}
              className="ml-auto btn h-7 text-[12.5px]"
            >
              {t.isDm ? "Lihat chat" : "Lihat chat grup"}
            </Link>
          </div>

          <p className="mt-1 text-[12.5px] text-ink-muted">
            {PEMICU[t.triggerType]}{" "}
            <span className="text-ink">
              {namaOrang(kontak, { pn: t.senderPn, lid: t.senderLid }, t.senderPushName)}
            </span> pukul{" "}
            <span className="tnum">{clock(t.triggeredAt)}</span>
            {t.likelyNotOurs ? (
              <>
                {" "}
                &middot;{" "}
                <span className="text-st-doubt">
                  kemungkinan bukan untuk kita - pengirim sedang membalas orang lain
                </span>
              </>
            ) : null}
          </p>
        </header>

        {/* ---------------- utas ---------------- */}
        <div className="scroll-y min-h-0 flex-1">
          {missing ? (
            <MissingParent
              quotedSnippet={missing.quotedSnippet}
              candidates={missing.candidates}
              groupJid={t.groupJid}
            />
          ) : null}
          <Thread
            messages={thread}
            hideQuoteFor={missing ? anchor.stanzaId : null}
            peserta={peserta}
            kami={selfIdentity()}
            kontak={kontak}
          />
          {/* section 9.4: balasan yang belum tuntas sampai ke WhatsApp tetap terlihat. */}
          <PendingOutbox
            ticketId={t.id}
            items={pending.map((p) => ({
              id: p.id,
              body: p.body,
              status: p.status,
              attempts: p.attempts,
              lastError: p.lastError,
              releaseAt: p.releaseAt.toISOString(),
              agentName: p.agentName,
            }))}
          />
        </div>

        {/* ---------------- kotak balas ---------------- */}
        <Compose
          ticketId={t.id}
          groupJid={t.groupJid}
          groupName={groupName}
          anchorStanzaId={anchor.stanzaId}
          status={t.status}
          claimedBy={t.claimedBy}
          claimedByName={t.claimedByName}
          meId={me.id}
          meSignature={me.signatureCode}
          quickReplies={templates.map((q) => ({ id: q.id, title: q.title, body: q.body }))}
          onCheckText={onCheckText}
          peserta={peserta}
          daftar={daftarSiap}
          isDm={t.isDm}
        />
      </div>

      {/* ---------------- rel kanan ---------------- */}
      <aside className="hidden w-[276px] shrink-0 border-l border-rule bg-paper xl:block">
        <div className="scroll-y h-full px-4 py-4">
          <section>
            <h2 className="micro">Jam berjalan</h2>
            <div className="mt-2 space-y-3">
              <div>
                <p className="text-[11.5px] text-ink-faint">Balasan pertama</p>
                <Elapsed
                  from={t.triggeredAt}
                  until={t.firstResponseAt}
                  targetMin={t.slaTargetFrMin}
                  warnPct={warnPct}
                  now={now}
                />
                <p className="mt-1 text-[11.5px] text-ink-faint">target {t.slaTargetFrMin} menit</p>
              </div>
              <div>
                <p className="text-[11.5px] text-ink-faint">Tuntas</p>
                <Elapsed
                  from={t.triggeredAt}
                  until={t.resolvedAt}
                  targetMin={t.slaTargetResMin}
                  warnPct={warnPct}
                  now={now}
                />
                <p className="mt-1 text-[11.5px] text-ink-faint">target {t.slaTargetResMin} menit</p>
              </div>
            </div>
          </section>

          {/* section 4.4 catatan serah terima antar shift. */}
          <section className="mt-6">
            <h2 className="micro">Catatan serah terima</h2>
            <form action={saveNote} className="mt-2">
              <input type="hidden" name="ticketId" value={t.id} />
              <textarea
                name="note"
                defaultValue={(await noteOf(t.id)) ?? ""}
                className="field min-h-[72px] resize-y text-[12.5px]"
                placeholder="Yang perlu diketahui shift berikutnya..."
              />
              <button className="btn mt-1.5 h-7 w-full text-[12.5px]" type="submit">
                Simpan catatan
              </button>
            </form>
          </section>

          <section className="mt-6">
            <h2 className="micro">Riwayat</h2>
            <ol className="mt-2 space-y-1.5">
              {history.map((h, i) => (
                <li key={i} className="flex items-baseline gap-2 text-[12px]">
                  <time className="tnum shrink-0 text-ink-faint" dateTime={h.createdAt.toISOString()}>
                    {clock(h.createdAt)}
                  </time>
                  <span className="text-ink-muted">
                    {AKSI[h.action] ?? h.action}
                    {h.agentName ? <span className="text-ink"> &middot; {h.agentName}</span> : null}
                  </span>
                </li>
              ))}
              {history.length === 0 ? <li className="text-[12px] text-ink-faint">belum ada.</li> : null}
            </ol>
            {history.length ? (
              <p className="mt-2 text-[11px] text-ink-faint">
                dibuat {smartStamp(t.triggeredAt)} &middot; {durationWords(Date.now() - t.triggeredAt.getTime())} lalu
              </p>
            ) : null}
          </section>
        </div>
      </aside>
    </div>
  );
}

async function noteOf(id: number): Promise<string | null> {
  const rows = await db.select({ note: tickets.note }).from(tickets).where(eq(tickets.id, id)).limit(1);
  return rows[0]?.note ?? null;
}
