/**
 * Adapter Evolution API v2.
 *
 * ============================ BACA INI DULU ============================
 * Semua bentuk payload dan jalur endpoint di berkas ini adalah TITIK AWAL,
 * bukan kebenaran. SPEC section 3 dan section 14 menyuruh sebaliknya: jalankan Fase 0,
 * kumpulkan payload asli 2-3 hari, baru sesuaikan berkas ini dengan bentuk nyata.
 *
 * Yang paling mungkin meleset dan wajib dicek dari dump:
 *   - letak identitas LID: key.participantLid / key.senderLid / participantAlt
 *   - apakah key.participant berisi PN atau LID di instalasi kamu
 *   - nama event untuk ack dan untuk edit pesan
 *   - bentuk body sendMedia (base64 vs url) di versi yang kamu pasang
 *
 * Endpoint dikumpulkan di satu tempat supaya gampang dikoreksi.
 * =======================================================================
 */
import {
  asRecord,
  extractMediaMeta,
  extractText,
  findContextInfo,
  mapMsgType,
  parseTimestamp,
  pickString,
  type GatewayAdapter,
  type GatewayState,
  type MediaStream,
  type NormalizedEvent,
  type SendDocumentArgs,
  type SendResult,
  type SendTextArgs,
} from "./types";
import {
  DOMAIN_LID,
  DOMAIN_PN,
  isDmJid,
  isPnJid,
  selfIdentity,
  toIdentity,
  userPart,
} from "@/lib/identity";

const EP = {
  sendText: (inst: string) => `/message/sendText/${inst}`,
  sendMedia: (inst: string) => `/message/sendMedia/${inst}`,
  connectionState: (inst: string) => `/instance/connectionState/${inst}`,
  mediaBase64: (inst: string) => `/chat/getBase64FromMediaMessage/${inst}`,
  allGroups: (inst: string) => `/group/fetchAllGroups/${inst}?getParticipants=false`,
  participants: (inst: string, jid: string) =>
    `/group/participants/${inst}?groupJid=${encodeURIComponent(jid)}`,
  contacts: (inst: string) => `/chat/findContacts/${inst}`,
};

function cfg() {
  const base = (process.env.GATEWAY_URL ?? "").replace(/\/$/, "");
  const key = process.env.GATEWAY_API_KEY ?? "";
  const instance = process.env.GATEWAY_INSTANCE ?? "default";
  return { base, key, instance };
}

/*
 * Batas waktu WAJIB ada di sini.
 *
 * Tanpa ini, satu panggilan yang menggantung membekukan seluruh cron tick -
 * terlihat langsung saat menguji kirim ke JID yang tidak ada: prosesnya diam
 * lebih dari dua menit tanpa jawaban apa pun. Yang lebih berbahaya bukan
 * lambatnya, tapi apa yang terjadi sesudahnya: kiriman itu akhirnya dianggap
 * gagal dan dicoba ulang, padahal WhatsApp bisa saja sudah menerimanya. Di
 * situlah pesan kembar lahir. Lihat juga penjaga gema di lib/outbox.ts.
 */
const BATAS_MS = 20_000;

async function call(path: string, init?: RequestInit): Promise<Response> {
  const { base, key } = cfg();
  if (!base) throw new Error("GATEWAY_URL belum diisi.");
  try {
    return await fetch(base + path, {
      ...init,
      headers: { "Content-Type": "application/json", apikey: key, ...(init?.headers ?? {}) },
      cache: "no-store",
      signal: init?.signal ?? AbortSignal.timeout(BATAS_MS),
    });
  } catch (err) {
    /* Bedakan "gateway diam" dari galat lain: yang pertama berarti kita TIDAK
       TAHU pesannya sampai atau tidak, dan itu harus terbaca jelas di
       outbox.last_error saat orang menelusuri pesan kembar. */
    if ((err as Error).name === "TimeoutError" || (err as Error).name === "AbortError") {
      throw new Error(`gateway tidak menjawab dalam ${BATAS_MS / 1000} detik (${path})`);
    }
    throw err;
  }
}

/* --------------------------------- parse --------------------------------- */

function parseMessageUpsert(data: Record<string, unknown>): NormalizedEvent {
  const warnings: string[] = [];
  const key = asRecord(data.key) ?? {};
  const message = data.message;

  // Jika payload berisi secretEncryptedMessage (peta enkripsi edit pada protokol baru),
  // itu adalah penanda edit pesan untuk targetMessageKey
  const secretEnc = asRecord(asRecord(message)?.secretEncryptedMessage);
  if (secretEnc) {
    const targetKey = asRecord(secretEnc.targetMessageKey);
    const targetStanzaId = pickString(targetKey?.id);
    if (targetStanzaId) {
      return {
        kind: "edit",
        stanzaId: targetStanzaId,
        groupJid: pickString(targetKey?.remoteJid, key.remoteJid),
        newBody: null, // Dikirim terenkripsi di payload, ditandai isEdited=true
      };
    }
  }

  const stanzaId = pickString(key.id, data.id);
  const groupJid = pickString(key.remoteJid, data.remoteJid);

  if (!stanzaId) return { kind: "ignored", reason: "tanpa key.id" };
  if (!groupJid) return { kind: "ignored", reason: "tanpa key.remoteJid" };
  /* Status ("@broadcast", "status@broadcast") bukan percakapan - tidak pernah
     jadi tiket dan tidak ada gunanya disimpan. */
  const dm = !groupJid.endsWith("@g.us");
  if (dm && !isDmJid(groupJid)) {
    return { kind: "ignored", reason: `bukan percakapan: ${groupJid}` };
  }

  /* --- identitas pengirim: section 3, dicari di beberapa nama field sekaligus --- */
  const fromMe = key.fromMe === true;

  /* Di GRUP, pengirim ada di key.participant dan remoteJid adalah grupnya.
     Di CHAT PRIBADI tidak ada participant sama sekali - remoteJid ITULAH lawan
     bicaranya. Menyamakan keduanya adalah cara paling gampang menyimpan pesan
     dengan pengirim kosong, lalu heran kenapa tiketnya tidak punya nama. */
  const sender = dm
    ? fromMe
      ? selfIdentity()
      : toIdentity(
          groupJid,
          key.senderPn as string,
          key.senderLid as string,
          key.participantPn as string,
          key.remoteJidAlt as string,
        )
    : toIdentity(
        key.participant as string,
        key.participantPn as string,
        key.participantAlt as string,
        key.senderPn as string,
        key.senderLid as string,
        key.participantLid as string,
        data.participant as string,
      );

  /* Pesan dari kita sendiri tidak membawa key.participant - pengirimnya ya kita.
     Diisi dari config supaya tidak memicu peringatan palsu di setiap balasan. */
  const pengirim = fromMe && !sender.pn && !sender.lid ? selfIdentity() : sender;

  if (!pengirim.pn && !pengirim.lid) {
    warnings.push("identitas pengirim kosong (cek field participant di dump)");
  }
  /* Di chat pribadi LID memang sering tidak ada, dan itu bukan kejanggalan -
     jangan mengotori panel Kesehatan Data dengan peringatan yang selalu benar. */
  if (!pengirim.lid && !fromMe && !dm) warnings.push("LID pengirim tidak ada di payload");

  /* --- context: reply ---
   *
   * BENTUK YANG DIVERIFIKASI (Evolution v2.3.7, dibaca dari dump Fase 0):
   * contextInfo ada di LEVEL ATAS `data`, BERSEBELAHAN dengan `message` -
   * bukan di dalamnya seperti pada Baileys mentah.
   *
   *   data.key.participant       "200000000000099@lid"
   *   data.key.participantAlt    "6281200000099@s.whatsapp.net"
   *   data.key.addressingMode    "lid"
   *   data.message.conversation  "gapapa bang"
   *   data.contextInfo.stanzaId       "3EB0962132..."
   *   data.contextInfo.participant    "123456789012345@lid"
   *   data.contextInfo.quotedMessage  { conversation: "..." }
   *
   * Semula hanya dicari di dalam `message`, jadi SETIAP swipe-reply lolos tanpa
   * terdeteksi - tanpa error apa pun. Pencarian di dalam message tetap
   * dipertahankan sebagai cadangan untuk versi/wrapper yang menaruhnya di sana.
   */
  const ctx = asRecord(data.contextInfo) ?? findContextInfo(message);
  const replyToStanzaId = ctx ? pickString(ctx.stanzaId, ctx.stanzaID) : null;
  const replyToSender = ctx
    ? toIdentity(
        ctx.participant as string,
        ctx.participantAlt as string,
        ctx.participantPn as string,
        ctx.participantLid as string,
      )
    : { pn: null, lid: null };
  if (replyToStanzaId && !replyToSender.pn && !replyToSender.lid) {
    warnings.push("reply tanpa contextInfo.participant");
  }

  const quotedSnippet = ctx ? extractText(ctx.quotedMessage) : null;

  const mentionedRaw = ctx?.mentionedJid;
  const mentionedJids = Array.isArray(mentionedRaw)
    ? mentionedRaw.filter((x): x is string => typeof x === "string")
    : [];

  const { date, guessed } = parseTimestamp(data.messageTimestamp ?? data.timestamp);
  if (guessed) warnings.push("messageTimestamp tidak terbaca, dipakai waktu terima");

  const msgType = mapMsgType(pickString(data.messageType), message);
  const body = extractText(message);
  if (msgType === "text" && body === null) warnings.push("pesan teks tanpa isi terbaca");

  return {
    kind: "message",
    warnings,
    message: {
      stanzaId,
      groupJid,
      sender: pengirim,
      senderPushName: pickString(data.pushName),
      fromMe,
      msgType,
      body,
      replyToStanzaId,
      replyToSender,
      quotedSnippet,
      mentionedJids,
      mediaMeta: extractMediaMeta(message),
      timestamp: date,
      isEdited: Boolean(asRecord(message)?.editedMessage),
    },
  };
}

/**
 * Terjemahkan field `status` jadi tingkat ack WhatsApp.
 * 0 pending - 1 sampai server - 2 sampai perangkat - 3 dibaca - 4 diputar.
 * null = bukan penanda ack.
 */
const PETA_ACK: Record<string, number> = {
  PENDING: 0,
  SERVER_ACK: 1,
  DELIVERY_ACK: 2,
  READ: 3,
  PLAYED: 4,
};

function mapAck(raw: unknown): number | null {
  const s = String(raw ?? "").toUpperCase();
  return s in PETA_ACK ? PETA_ACK[s] : null;
}

function mapConnectionState(raw: unknown): GatewayState {
  const s = String(raw ?? "").toLowerCase();
  if (s === "open" || s === "connected") return "connected";
  if (s === "connecting" || s === "qr" || s === "qrcode") return "qr_required";
  if (s === "close" || s === "closed" || s === "disconnected") return "disconnected";
  return "error";
}

export const evolutionAdapter: GatewayAdapter = {
  name: "evolution",

  parse(body: unknown): NormalizedEvent[] {
    const root = asRecord(body);
    if (!root) return [{ kind: "ignored", reason: "body bukan objek" }];

    const event = String(root.event ?? "").toLowerCase().replace(/_/g, ".");
    const data = root.data;

    try {
      switch (event) {
        /*
         * send.message = pesan yang KITA kirim lewat API. Bentuknya sama persis
         * dengan messages.upsert (key/message/contextInfo/messageTimestamp),
         * hanya key.fromMe = true dan key.participant tidak ada.
         *
         * Tanpa menanganinya, balasan tim TIDAK PERNAH masuk database:
         * "Lihat chat grup" kosong dari sisi kita, utas tiket tidak menampilkan
         * jawaban sendiri, dan atribusi lewat outbox.sentStanzaId tidak pernah
         * terjadi. Outbox bilang "sent", database bilang tidak ada apa-apa.
         */
        case "send.message":
        case "messages.upsert": {
          const items = Array.isArray(data) ? data : [data];
          const out: NormalizedEvent[] = [];

          for (const raw of items) {
            const d = asRecord(raw);
            if (!d) continue;
            out.push(parseMessageUpsert(d));

            /*
             * status di sini adalah status PESAN ITU SENDIRI, dan untuk pesan
             * masuk itu memang ack milik si pengirim - bukan konfirmasi
             * pengiriman kita. Tetap diteruskan karena tidak berbahaya
             * (handleAck hanya mencocokkan outbox.sent_stanza_id), tapi JANGAN
             * mengandalkan ini untuk section 9.4: konfirmasi pesan KITA datang lewat
             * event send.message.update, lihat case di bawah.
             */
            const ack = mapAck(d.status);
            const id = pickString(asRecord(d.key)?.id, d.id);
            if (ack !== null && id) out.push({ kind: "ack", stanzaId: id, ack });
          }
          return out;
        }

        /*
         * KONFIRMASI PENGIRIMAN PESAN KITA (section 9.4).
         *
         * Perlu dua langkah untuk menemukannya, dan langkah pertama salah:
         * awalnya disimpulkan ack datang sebagai messages.upsert kedua dengan
         * status DELIVERY_ACK - keliru. Yang terjadi, id pesan kita muncul di
         * payload itu hanya sebagai contextInfo.stanzaId, karena KLIEN membalas
         * pesan kita. key.id-nya milik pesan klien, dan DELIVERY_ACK itu status
         * pesan klien, bukan status pesan kita. Pelajaran: mencocokkan id
         * dengan mencari string di JSON mentah tidak membuktikan apa pun soal
         * MAKNA field-nya.
         *
         * Yang benar: Evolution punya event SEND_MESSAGE_UPDATE khusus untuk
         * ini, dan harus DIDAFTARKAN di webhook instance - tidak ikut terkirim
         * lewat konfigurasi global. Lihat catatan di README.
         */
        case "send.message.update":
        case "messages.update": {
          const items = Array.isArray(data) ? data : [data];
          const out: NormalizedEvent[] = [];
          for (const raw of items) {
            const d = asRecord(raw);
            if (!d) continue;
            const key = asRecord(d.key) ?? {};
            const stanzaId = pickString(key.id, d.keyId, d.messageId);
            if (!stanzaId) continue;

            const status = String(d.status ?? "").toUpperCase();
            const ack = mapAck(status);
            if (ack !== null) {
              out.push({ kind: "ack", stanzaId, ack });
            } else if (status === "DELETED") {
              out.push({ kind: "revoke", stanzaId, groupJid: pickString(key.remoteJid) });
            }
          }
          return out.length ? out : [{ kind: "ignored", reason: "messages.update tanpa status dikenal" }];
        }

        case "messages.edited":
        case "message.edited": {
          const d = asRecord(Array.isArray(data) ? data[0] : data);
          const key = asRecord(d?.key) ?? {};
          // Untuk event edit, stanzaId target yang diedit sering berada di key.id atau d.messageId
          // Namun Baileys/Evolution terkadang menaruh ID pesan target di d.message.protocolMessage.key.id atau d.protocolMessage.key.id
          const msgObj = asRecord(d?.message);
          const protoMsg = asRecord(msgObj?.protocolMessage ?? d?.protocolMessage);
          const protoKey = asRecord(protoMsg?.key);

          const stanzaId = pickString(protoKey?.id, key.id, d?.messageId);
          if (!stanzaId) break;

          // Evolution API mengirim penarikan/penghapusan pesan via event messages.edited dengan type: "REVOKE"
          // atau protocolMessage.type === 0 (REVOKE).
          const isRevoke =
            String(d?.type ?? "").toUpperCase() === "REVOKE" ||
            Boolean(protoMsg?.type === 0) ||
            Boolean(asRecord(protoMsg?.editedMessage)?.conversation === "");

          if (isRevoke) {
            return [{ kind: "revoke", stanzaId, groupJid: pickString(protoKey?.remoteJid, key.remoteJid) }];
          }

          // Ambil teks baru dari editedMessage (Baileys protocolMessage.editedMessage)
          const editedContent = protoMsg?.editedMessage ?? d?.message ?? d?.editedMessage;

          return [
            {
              kind: "edit",
              stanzaId,
              groupJid: pickString(protoKey?.remoteJid, key.remoteJid),
              newBody: extractText(editedContent),
            },
          ];
        }

        case "messages.delete":
        case "message.delete": {
          const d = asRecord(Array.isArray(data) ? data[0] : data);
          const key = asRecord(d?.key) ?? d ?? {};
          const stanzaId = pickString(key.id, d?.messageId);
          if (!stanzaId) break;
          return [{ kind: "revoke", stanzaId, groupJid: pickString(key.remoteJid) }];
        }

        case "connection.update": {
          const d = asRecord(data) ?? {};
          return [{ kind: "connection", state: mapConnectionState(d.state ?? d.connection), detail: d }];
        }

        case "qrcode.updated":
          return [{ kind: "connection", state: "qr_required", detail: asRecord(data) }];

        /*
         * Nama grup datang dari sini. Bentuk diverifikasi dari dump Fase 0:
         *   { id: "1203...@g.us", subject: "testing bang", participants: [...] }
         * Tanpa menangani ini, kolom nama grup selamanya kosong dan leader
         * harus mengetik sendiri nama tiap grup - padahal WhatsApp mengirimnya.
         */
        case "groups.upsert":
        case "groups.update": {
          const items = Array.isArray(data) ? data : [data];
          const out: NormalizedEvent[] = [];
          for (const raw of items) {
            const g = asRecord(raw);
            const jid = g ? pickString(g.id, g.jid) : null;
            if (!jid?.endsWith("@g.us")) continue;
            out.push({ kind: "group", jid, subject: pickString(g?.subject) });
          }
          if (out.length) return out;
          break;
        }
      }
    } catch (err) {
      return [{ kind: "ignored", reason: `gagal parse: ${(err as Error).message}` }];
    }

    return [{ kind: "ignored", reason: `event tidak ditangani: ${event}` }];
  },

  async sendText({ groupJid, text, replyToStanzaId, mentions }: SendTextArgs): Promise<SendResult> {
    const { instance } = cfg();

    /* section 12: mention hanya bekerja kalau teks memuat @nomor DAN id-nya masuk
       array. Diisi PN dan LID dua-duanya karena kita tidak tahu bentuk mana
       yang dipakai grup ini. */
    const mentioned: string[] = [];
    for (const m of mentions ?? []) {
      if (m.pn) mentioned.push(`${m.pn}@${DOMAIN_PN}`);
      if (m.lid) mentioned.push(`${m.lid}@${DOMAIN_LID}`);
    }

    /* Evolution menerima JID grup apa adanya, tapi untuk chat pribadi bentuk
       yang pasti didukung adalah NOMORNYA saja - "628...@s.whatsapp.net"
       dikirim sebagai teks nomor akan gagal di sebagian versi. JID LID dibiarkan
       utuh karena nomornya memang tidak bisa diturunkan (section 3.3). */
    const tujuan = isPnJid(groupJid) ? (userPart(groupJid) ?? groupJid) : groupJid;

    const res = await call(EP.sendText(instance), {
      method: "POST",
      body: JSON.stringify({
        number: tujuan,
        text,
        ...(mentioned.length ? { mentioned } : {}),
        ...(replyToStanzaId
          ? { quoted: { key: { id: replyToStanzaId, remoteJid: groupJid, fromMe: false } } }
          : {}),
      }),
    });

    const json = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`sendText gagal ${res.status}: ${JSON.stringify(json)?.slice(0, 300)}`);

    return { stanzaId: pickString(asRecord(asRecord(json)?.key)?.id), raw: json };
  },

  async sendDocument(args: SendDocumentArgs): Promise<SendResult> {
    const { instance } = cfg();
    const res = await call(EP.sendMedia(instance), {
      method: "POST",
      body: JSON.stringify({
        number: args.groupJid,
        // section 12: "document", bukan "image" - supaya nama file dan ekstensi utuh.
        mediatype: "document",
        mimetype: args.mimetype,
        fileName: args.fileName,
        caption: args.caption ?? "",
        media: args.data.toString("base64"),
        ...(args.replyToStanzaId
          ? { quoted: { key: { id: args.replyToStanzaId, remoteJid: args.groupJid, fromMe: false } } }
          : {}),
      }),
    });

    const json = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`sendDocument gagal ${res.status}: ${JSON.stringify(json)?.slice(0, 300)}`);
    return { stanzaId: pickString(asRecord(asRecord(json)?.key)?.id), raw: json };
  },

  async fetchMedia(stanzaId: string, groupJid: string): Promise<MediaStream> {
    const { instance } = cfg();
    const res = await call(EP.mediaBase64(instance), {
      method: "POST",
      body: JSON.stringify({ message: { key: { id: stanzaId, remoteJid: groupJid } } }),
    });

    if (!res.ok) {
      // section 12: link media WhatsApp kedaluwarsa dalam hitungan hari. Ini bukan bug.
      return { body: null, mimetype: "application/octet-stream", fileName: stanzaId, expired: true };
    }

    const json = asRecord(await res.json().catch(() => null));
    const b64 = pickString(json?.base64);
    if (!b64) return { body: null, mimetype: "application/octet-stream", fileName: stanzaId, expired: true };

    const buf = Buffer.from(b64, "base64");
    return {
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(buf));
          controller.close();
        },
      }),
      mimetype: pickString(json?.mimetype) ?? "application/octet-stream",
      fileName: pickString(json?.fileName) ?? stanzaId,
      expired: false,
    };
  },

  async fetchGroups() {
    const { instance } = cfg();
    const res = await call(EP.allGroups(instance));
    if (!res.ok) throw new Error(`fetchAllGroups gagal ${res.status}`);
    const json = await res.json().catch(() => null);
    if (!Array.isArray(json)) return [];
    return json
      .map((raw) => asRecord(raw))
      .filter((g): g is Record<string, unknown> => !!g)
      .map((g) => ({ jid: pickString(g.id, g.jid) ?? "", subject: pickString(g.subject) }))
      .filter((g) => g.jid.endsWith("@g.us"));
  },

  /**
   * Diverifikasi ke Evolution v2.3.7 yang berjalan, bukan ditebak. Bentuknya:
   *
   *   {"participants":[
   *      {"id":"200000000000099@lid","phoneNumber":"6281200000099@s.whatsapp.net",
   *       "admin":"superadmin","name":"BudiSantoso","imgUrl":"..."}]}
   *
   * Dipakai endpoint per-grup, BUKAN fetchAllGroups?getParticipants=true.
   * Yang kedua menarik peserta ke-13 grup sekaligus (>500 baris) padahal yang
   * dibutuhkan cuma satu grup, dan ia tidak mengembalikan `name`.
   */
  async fetchPeople(groupJid: string) {
    const { instance } = cfg();
    const res = await call(EP.participants(instance, groupJid));
    if (!res.ok) throw new Error(`daftar peserta gagal ${res.status}`);

    const json = asRecord(await res.json().catch(() => null));
    const raw = json?.participants;
    if (!Array.isArray(raw)) return [];

    return raw
      .map((p) => asRecord(p))
      .filter((p): p is Record<string, unknown> => !!p)
      .map((p) => {
        const id = toIdentity(pickString(p.id), pickString(p.phoneNumber));
        return {
          pn: id.pn,
          lid: id.lid,
          name: pickString(p.name),
          isAdmin: !!pickString(p.admin),
        };
      })
      .filter((p) => p.pn || p.lid);
  },

  /**
   * Kontak tersimpan, seluruhnya. Diverifikasi ke Evolution v2.3.7: entri orang
   * keluar dua kali, sekali di bawah JID PN dan sekali di bawah JID LID, jadi
   * pencarian lewat sumbu mana pun ketemu.
   *
   * Dipakai untuk nama orang DI MANA PUN, bukan cuma mention: yang dikenal tim
   * adalah nama yang mereka simpan sendiri, bukan nama pasang-sendiri klien
   * yang bisa berubah kapan saja.
   */
  async fetchContacts() {
    const { instance } = cfg();
    const res = await call(EP.contacts(instance), { method: "POST", body: "{}" });
    if (!res.ok) throw new Error(`daftar kontak gagal ${res.status}`);

    const json = await res.json().catch(() => null);
    const arr = Array.isArray(json) ? json : asRecord(json)?.contacts;
    if (!Array.isArray(arr)) return [];

    return arr
      .map((k) => asRecord(k))
      .filter((k): k is Record<string, unknown> => !!k && k.isGroup !== true)
      .map((k) => {
        const id = toIdentity(pickString(k.remoteJid, k.id));
        return { pn: id.pn, lid: id.lid, name: pickString(k.name, k.pushName) ?? "" };
      })
      .filter((k) => k.name.length > 0 && (k.pn || k.lid));
  },

  async status() {
    const { instance } = cfg();
    try {
      const res = await call(EP.connectionState(instance));
      const json = asRecord(await res.json().catch(() => null));

      /*
       * Bentuk respons ini diverifikasi langsung ke Evolution v2.3.7, bukan
       * ditebak. Untuk instance yang belum dibuat ia menjawab HTTP 404:
       *   {"status":404,"error":"Not Found",
       *    "response":{"message":["The \"utama\" instance does not exist"]}}
       *
       * Bedanya penting. "Instance belum dibuat" BUKAN "gateway terputus":
       * yang pertama artinya tinggal scan QR, yang kedua artinya ada yang rusak
       * dan pesan klien sedang hilang. section 10 memasang indikator ini paling atas
       * dan paling besar - salah label di sini mengirim leader mengejar masalah
       * yang salah di jam paling sibuk.
       */
      if (res.status === 404) {
        return {
          state: "qr_required" as GatewayState,
          detail: { pesan: `Instance "${instance}" belum dibuat di gateway.`, http: 404 },
        };
      }

      if (!res.ok) {
        return { state: "error" as GatewayState, detail: { http: res.status, body: json } };
      }

      const inner = asRecord(json?.instance) ?? json ?? {};
      return { state: mapConnectionState(inner.state ?? inner.connectionStatus), detail: json };
    } catch (err) {
      // Gateway benar-benar tidak bisa dihubungi - ini yang pantas disebut putus.
      return { state: "disconnected" as GatewayState, detail: { message: (err as Error).message } };
    }
  },
};
