"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { actCancelSend, actClaim, actNotForUs, actResolve, actSend, actUndoNotForUs } from "@/app/(app)/actions";
import { namaDitandai, tokenMention, type DaftarTag, type Peserta } from "@/lib/mention";

type Props = {
  ticketId: number;
  groupJid: string;
  groupName: string;
  /** pesan asli klien - balasan selalu menempel ke sini (section 6.7). */
  anchorStanzaId: string;
  status: "open" | "on_progress" | "closed" | "not_for_us";
  claimedBy: number | null;
  claimedByName: string | null;
  meId: number;
  meSignature: string;
  quickReplies: { id: number; title: string; body: string }[];
  /** section 6.7 kalimat penahan baku, dipakai kalau kotak balas kosong. */
  onCheckText: string;
  /** section 12 peserta grup - sasaran mention. Kosong kalau gateway tak terjangkau. */
  peserta: Peserta[];
  /** section 12 daftar tag, sudah disaring ke anggota yang ada di grup ini. */
  daftar: (DaftarTag & { adaDiGrup: number })[];
  /** true = chat pribadi. Mengubah kalimat pengaman, bukan cuma satu kata. */
  isDm: boolean;
};

/** Satu baris di menu "@": bisa satu daftar, bisa satu orang. */
type Saran =
  | { jenis: "daftar"; d: DaftarTag & { adaDiGrup: number } }
  | { jenis: "orang"; o: Peserta };

const LAST_GROUP_KEY = "wa-grup-terakhir";
const MAKS_SARAN = 8;

export function Compose(props: Props) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [pending, startTransition] = useTransition();
  const [notice, setNotice] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const [held, setHeld] = useState<{ id: string; until: number } | null>(null);
  const [groupWarn, setGroupWarn] = useState(false);
  const idemRef = useRef<string>(newKey());
  const areaRef = useRef<HTMLTextAreaElement>(null);

  const locked = props.claimedBy !== null && props.claimedBy !== props.meId;
  const finished = props.status === "closed" || props.status === "not_for_us";

  /* ------------------------ section 12 menandai orang ------------------------ */

  /* Kata yang sedang diketik sesudah "@", plus posisi "@"-nya. null = menu tutup. */
  const [tagMenu, setTagMenu] = useState<{ q: string; awal: number } | null>(null);
  const [sorot, setSorot] = useState(0);

  /* Daftar di ATAS orang. Yang mengetik "@" sesudah membuat daftar hampir
     selalu mencari daftarnya; orang per orang selalu bisa dicari dengan
     mengetik namanya. Daftar yang nol anggotanya di grup ini tidak
     ditawarkan sama sekali - memilihnya cuma akan ditolak saat kirim. */
  const saran = useMemo((): Saran[] => {
    if (!tagMenu) return [];
    const q = tagMenu.q.toLowerCase();

    const daftar: Saran[] = props.daftar
      .filter((d) => d.adaDiGrup > 0)
      .filter((d) => !q || d.slug.toLowerCase().includes(q) || d.label.toLowerCase().includes(q))
      .map((d) => ({ jenis: "daftar" as const, d }));

    const orang: Saran[] = props.peserta
      .filter((o) => {
        if (!q) return true;
        return (
          o.nama.toLowerCase().includes(q) ||
          (o.pn?.includes(q) ?? false) ||
          (o.lid?.includes(q) ?? false)
        );
      })
      .map((o) => ({ jenis: "orang" as const, o }));

    return [...daftar, ...orang].slice(0, MAKS_SARAN);
  }, [tagMenu, props.peserta, props.daftar]);

  /* Siapa yang BENAR-BENAR tertandai di teks sekarang. Dihitung ulang dari teks,
     bukan diingat dari klik: agen sering memilih orang lalu menghapus lagi
     tulisannya, dan daftar yang mengingat klik akan berbohong. */
  const ditandai = useMemo(
    () => namaDitandai(text, props.peserta, props.daftar),
    [text, props.peserta, props.daftar],
  );

  const ketik = (nilai: string, caret: number) => {
    setText(nilai);
    if (!props.peserta.length) return;
    /* "@" hanya membuka menu di awal kata - supaya alamat email dan "harga@50"
       tidak ikut memunculkannya. */
    const cocok = /(?:^|\s)@([^\s@]{0,30})$/.exec(nilai.slice(0, caret));
    if (!cocok) {
      setTagMenu(null);
      return;
    }
    setTagMenu({ q: cocok[1], awal: caret - cocok[1].length - 1 });
    setSorot(0);
  };

  /* Yang disisipkan adalah ANGKA, bukan nama - itu satu-satunya bentuk yang
     dikenali WhatsApp, dan kotak balas harus memperlihatkan apa yang benar-benar
     dikirim. Barisan "Menandai:" di bawahnya yang membuatnya terbaca manusia. */
  const pilihTag = (s: Saran) => {
    const el = areaRef.current;
    /* Daftar disisipkan sebagai NAMANYA, bukan langsung mekar jadi belasan
       angka: kalimat agen harus tetap terbaca sewaktu ditulis. Mekarnya
       terjadi di server saat kirim, dan hasilnya sudah kelihatan di baris
       "Menandai" di bawah kotak. */
    const token = s.jenis === "daftar" ? s.d.slug : tokenMention(s.o);
    if (!el || !tagMenu || !token) return;
    const akhir = el.selectionStart ?? tagMenu.awal + tagMenu.q.length + 1;
    setText(text.slice(0, tagMenu.awal) + "@" + token + " " + text.slice(akhir));
    setTagMenu(null);
    const pos = tagMenu.awal + token.length + 2;
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  };

  /* section 9.2 "Otomatis claim saat dibuka."
     Dilakukan dari klien, bukan saat render server, supaya membuka halaman tidak
     jadi GET yang mengubah data (mis. saat di-prefetch browser). Server tetap
     memeriksa ulang kepemilikan saat tombol kirim ditekan - section 6.3. */
  useEffect(() => {
    if (props.status === "open" && props.claimedBy === null) {
      void actClaim(props.ticketId).then(() => router.refresh());
    }
  }, [props.status, props.claimedBy, props.ticketId, router]);

  /* section 9.2 "Munculkan konfirmasi kalau grupnya berbeda dari tiket yang terakhir
     dibuka." Salah kirim ke grup lain adalah kesalahan paling fatal dan paling
     sering, dan penyebabnya hampir selalu berpindah tiket terlalu cepat. */
  useEffect(() => {
    const last = sessionStorage.getItem(LAST_GROUP_KEY);
    if (last && last !== props.groupJid) setGroupWarn(true);
    sessionStorage.setItem(LAST_GROUP_KEY, props.groupJid);
  }, [props.groupJid]);

  /* Hitung mundur jendela undo. */
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!held) return;
    const id = setInterval(() => setTick((n) => n + 1), 250);
    return () => clearInterval(id);
  }, [held]);

  useEffect(() => {
    if (held && Date.now() >= held.until) {
      setHeld(null);
      router.refresh();
    }
  }, [tick, held, router]);

  const send = (opts: { isOnCheck?: boolean; markResolved?: boolean }) => {
    /* On check boleh tanpa teks - server yang mengisi kalimat bakunya (section 6.7).
       Sebelumnya tombolnya sudah dibuka tapi penjaga di sini tidak ikut diubah,
       jadi tombolnya bisa diklik dan tidak terjadi apa-apa. */
    if (pending) return;
    if (!text.trim() && !opts.isOnCheck) return;
    setNotice(null);

    startTransition(async () => {
      const res = await actSend({
        ticketId: props.ticketId,
        idempotencyKey: idemRef.current,
        body: text,
        replyToStanzaId: props.anchorStanzaId,
        isOnCheck: opts.isOnCheck ?? false,
        markResolved: opts.markResolved ?? false,
        alsoCloseTicketIds: [],
      });

      if (!res.ok) {
        setNotice({ tone: "bad", text: res.message });
        return;
      }

      // Kunci baru untuk kiriman berikutnya. Kunci lama tetap dipegang server,
      // jadi klik ganda pada kiriman yang sama tidak pernah menghasilkan dua pesan.
      idemRef.current = newKey();
      setText("");
      if (res.outboxId && res.releaseAt) {
        setHeld({ id: res.outboxId, until: new Date(res.releaseAt).getTime() });
      }
      router.refresh();
    });
  };

  /* Penanda TERSENDIRI, bukan `pending` milik transisi umum.
     `pending` ikut menyala saat router.refresh() sesudah kirim masih berjalan,
     dan selama itu tombol Batalkan mati - terukur ~280ms di mesin ini, tapi
     bisa jauh lebih lama di mesin lambat atau halaman berat. Klik yang jatuh
     di jendela mati itu hilang tanpa suara, dan agen baru sadar pesannya sudah
     sampai. Undo adalah pengaman; ia tidak boleh dimatikan oleh pekerjaan lain
     yang tidak ada hubungannya. */
  const [membatalkan, setMembatalkan] = useState(false);

  const undo = () => {
    if (!held || membatalkan) return;
    setMembatalkan(true);
    startTransition(async () => {
      const res = await actCancelSend(held.id, props.ticketId);
      setMembatalkan(false);
      setHeld(null);
      setNotice({ tone: res.ok ? "ok" : "bad", text: res.message ?? "" });
      if (!res.ok) setText(""); // sudah terkirim - jangan kembalikan teks, nanti dobel
      router.refresh();
    });
  };

  const simple = (fn: () => Promise<{ ok: boolean; message?: string }>) =>
    startTransition(async () => {
      const res = await fn();
      setNotice({ tone: res.ok ? "ok" : "bad", text: res.message ?? "" });
      router.refresh();
    });

  /* --------------------------- keadaan khusus --------------------------- */

  if (props.status === "not_for_us") {
    return (
      <Bar>
        <p className="text-[13px] text-ink-muted">Tiket ini ditandai bukan untuk kami.</p>
        <button
          className="btn ml-auto"
          disabled={pending}
          onClick={() => simple(() => actUndoNotForUs(props.ticketId))}
        >
          Kembalikan ke antrean
        </button>
      </Bar>
    );
  }

  if (held) {
    const left = Math.max(0, Math.ceil((held.until - Date.now()) / 1000));
    return (
      <Bar tone="hold">
        <span className="tnum text-[15px]">{left}</span>
        <p className="text-[13px]">
          Progress kirim ke {props.isDm ? "japri" : "grup"}{" "}
          <strong className="font-semibold">{props.groupName}</strong>.
        </p>
        <button className="btn btn-danger ml-auto" onClick={undo} disabled={membatalkan}>
          Batalkan
        </button>
      </Bar>
    );
  }

  return (
    /* relative-nya di SINI, bukan di sekitar kotak balas: menu tandai naik ke
       atas, dan kalau jangkarnya kotak balas ia menimpa baris nama grup - baris
       pengaman section 9.2 yang justru harus terbaca sewaktu mengetik. */
    <div className="relative rule-t bg-surface">
      {/* section 9.2: nama grup ditampilkan besar dan mencolok DI DEKAT kotak balas.
          Bukan cuma di kepala halaman - mata agen ada di sini saat mengetik. */}
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-5 pt-3">
        <span className="micro text-ink-faint">
          {props.isDm ? "Membalas japri ke" : "Membalas ke grup"}
        </span>
        <strong className="text-[16px] font-semibold tracking-[-0.015em]">{props.groupName}</strong>
        {groupWarn ? (
          <span className="inline-flex items-center gap-1.5 text-[12px] text-st-open">
            <span className="dot" style={{ background: "var(--st-open)" }} />
            {props.isDm ? "japri, bukan grup - dan berbeda dari tiket sebelumnya" : "grup berbeda dari tiket sebelumnya"}
            <button
              type="button"
              className="ml-1 underline underline-offset-2"
              onClick={() => setGroupWarn(false)}
            >
              paham
            </button>
          </span>
        ) : null}
      </div>

      {locked ? (
        /* section 6.3: agen lain melihat "Sedang ditangani {nama}", kotak balas nonaktif. */
        <div className="flex items-center gap-3 px-5 py-4">
          <p className="text-[13px] text-ink-muted">
            Sedang ditangani <strong className="text-ink">{props.claimedByName}</strong>. Kotak balas nonaktif.
          </p>
          <a href={`/tiket/${props.ticketId}/ambil-alih`} className="btn ml-auto">
            Ambil alih
          </a>
        </div>
      ) : (
        <>
          {props.quickReplies.length ? (
            /* Diberi label "SISIPKAN" karena chip di sini MENGISI kotak balas,
               sementara tombol di bawah MENGIRIM. Tanpa label, template bernama
               "On check" berdiri persis di sebelah tombol aksi "On check" dan
               agen tidak bisa menebak mana yang langsung mengirim. */
            <div className="flex flex-wrap items-center gap-1.5 px-5 pt-2.5">
              <span className="micro mr-1 shrink-0">Sisipkan</span>
              {props.quickReplies.map((q) => (
                <button
                  key={q.id}
                  type="button"
                  className="btn btn-quiet h-6 px-2 text-[12px]"
                  onClick={() => {
                    setText((t) => (t ? `${t}\n${q.body}` : q.body));
                    areaRef.current?.focus();
                  }}
                >
                  {q.title}
                </button>
              ))}
            </div>
          ) : null}

          <div className="px-5 pt-2.5">
            {tagMenu && saran.length ? (
              /* Menu duduk DI ATAS kotak, bukan di bawahnya: kotak balas sudah
                 menempel ke dasar layar, jadi daftar yang turun ke bawah akan
                 terpotong tepi jendela. Yang ditimpanya cuma riwayat pesan -
                 tidak apa-apa, itu bukan yang sedang dibaca saat mengetik. */
              <ul
                role="listbox"
                aria-label="Tandai orang di grup"
                className="absolute bottom-full left-5 z-20 mb-1 max-h-[236px] w-[300px] overflow-y-auto rounded-[6px] border border-rule bg-surface py-1 shadow-lg"
              >
                {saran.map((s, i) => (
                  <li key={s.jenis === "daftar" ? `d:${s.d.slug}` : `o:${s.o.pn ?? ""}|${s.o.lid ?? ""}`}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={i === sorot}
                      className="flex w-full items-baseline gap-2 px-3 py-1.5 text-left"
                      style={{ background: i === sorot ? "var(--sunk)" : "transparent" }}
                      onMouseEnter={() => setSorot(i)}
                      /* mousedown, bukan click: click datang sesudah blur, dan
                         blur sudah menutup menunya duluan. */
                      onMouseDown={(e) => {
                        e.preventDefault();
                        pilihTag(s);
                      }}
                    >
                      {s.jenis === "daftar" ? (
                        <>
                          <span className="truncate text-[13px]" style={{ color: "var(--accent)" }}>
                            {s.d.label}
                          </span>
                          {/* Jumlahnya yang ADA DI GRUP INI, bukan jumlah anggota
                              daftar - itu yang menentukan berapa orang benar-benar
                              dapat notifikasi. */}
                          <span className="ml-auto shrink-0 text-[11px] text-ink-faint">
                            {s.d.adaDiGrup} orang di grup ini
                          </span>
                        </>
                      ) : (
                        <>
                          <span className="truncate text-[13px]">{s.o.nama}</span>
                          {s.o.pn ? (
                            <span className="tnum ml-auto shrink-0 text-[11px] text-ink-faint">+{s.o.pn}</span>
                          ) : null}
                        </>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}

            <textarea
              ref={areaRef}
              className="field min-h-[84px] resize-y"
              placeholder={
                props.peserta.length
                  ? `Ketik balasan... "@" untuk menandai orang, tanda tangan #dsp ${props.meSignature} otomatis`
                  : `Ketik balasan... tanda tangan #dsp ${props.meSignature} disisipkan otomatis`
              }
              value={text}
              disabled={pending || finished}
              onChange={(e) => ketik(e.target.value, e.target.selectionStart ?? e.target.value.length)}
              onBlur={() => setTagMenu(null)}
              onKeyDown={(e) => {
                if (tagMenu && saran.length) {
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setSorot((n) => (n + 1) % saran.length);
                    return;
                  }
                  if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setSorot((n) => (n - 1 + saran.length) % saran.length);
                    return;
                  }
                  if (e.key === "Enter" || e.key === "Tab") {
                    e.preventDefault();
                    pilihTag(saran[sorot]);
                    return;
                  }
                  if (e.key === "Escape") {
                    e.preventDefault();
                    setTagMenu(null);
                    return;
                  }
                }
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") send({ markResolved: false });
              }}
              /* Panah dan klik memindahkan caret tanpa mengubah teks, jadi
                 onChange tidak jalan dan menu bisa tertinggal terbuka. */
              onKeyUp={(e) => {
                if (e.key.startsWith("Arrow") || e.key === "Home" || e.key === "End") {
                  const el = e.currentTarget;
                  ketik(el.value, el.selectionStart ?? el.value.length);
                }
              }}
            />

            {ditandai.length ? (
              /* Kotak balas memperlihatkan angka; baris ini memperlihatkan siapa.
                 Tanpanya agen tidak punya cara memeriksa apakah yang ditandai
                 benar orangnya sebelum pesan masuk ke grup klien. */
              <p className="mt-1.5 text-[11.5px] text-ink-faint">
                Menandai{" "}
                <span style={{ color: "var(--accent)" }}>{ditandai.map((n) => "@" + n).join(", ")}</span>
              </p>
            ) : null}
          </div>

          {notice ? (
            <p
              role="alert"
              className="px-5 pt-2.5 text-[13px]"
              style={{ color: notice.tone === "ok" ? "var(--st-done)" : "var(--st-breach)" }}
            >
              {notice.text}
            </p>
          ) : null}

          <div className="flex flex-wrap items-center gap-2 px-5 py-3">
            {/* section 9.5 target desain: dari notifikasi sampai balasan terkirim
                maksimal 2 klik. Karena itu "Kirim & selesai" jadi tombol utama -
                jalur yang paling sering dipakai tidak boleh butuh dua langkah. */}
            <button
              className="btn btn-primary"
              disabled={pending || !text.trim() || finished}
              onClick={() => send({ markResolved: true })}
            >
              Kirim &amp; selesai
            </button>
            <button
              className="btn"
              disabled={pending || !text.trim() || finished}
              onClick={() => send({ markResolved: false })}
            >
              Kirim saja
            </button>
            {/* section 6.7 "on check" = balasan penahan. Mengisi first_response_at,
                TIDAK mengisi resolved_at.

                Sengaja TIDAK ikut mati saat kotak balas kosong. Ini aksi yang
                paling sering dipakai dan isinya selalu kalimat yang sama;
                memaksa mengetik dulu membuang seluruh gunanya dan melanggar
                target section 9.5 "maksimal 2 klik". Kalau kosong, server memakai
                kalimat dari Setelan > Operasional. */}
            <button
              className="btn"
              disabled={pending || finished}
              onClick={() => send({ isOnCheck: true })}
              title={
                text.trim()
                  ? "Kirim teks ini sebagai balasan penahan. Jam balasan pertama berhenti, tiket tetap terbuka."
                  : `Kirim balasan penahan baku: "${props.onCheckText}". Jam balasan pertama berhenti, tiket tetap terbuka.`
              }
            >
              On check
            </button>

            <span className="mx-1 h-5 w-px bg-rule" aria-hidden />

            <button
              className="btn"
              disabled={pending || finished}
              onClick={() => simple(() => actResolve(props.ticketId))}
            >
              Tandai selesai
            </button>
            <button
              className="btn btn-danger ml-auto"
              disabled={pending || finished}
              onClick={() => simple(() => actNotForUs(props.ticketId))}
            >
              Bukan untuk kami
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function Bar({ children, tone }: { children: React.ReactNode; tone?: "hold" }) {
  return (
    <div
      className="rule-t flex items-center gap-3 px-5 py-4"
      style={{ background: tone === "hold" ? "var(--accent-soft)" : "var(--surface)" }}
    >
      {children}
    </div>
  );
}

function newKey(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `k-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
