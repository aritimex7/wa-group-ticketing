/**
 * Adapter WAHA.
 *
 * Sama seperti adapter Evolution: bentuk payload di sini HIPOTESIS sampai
 * diverifikasi dengan dump Fase 0 (SPEC section 14).
 *
 * Catatan khusus WAHA yang gampang menjebak:
 *   - id pesan berbentuk gabungan "false_<chatId>_<ID>". Kita simpan APA ADANYA
 *     sebagai stanza_id, karena bentuk itulah yang diminta WAHA saat reply.
 *     Jangan dipotong jadi bagian ID-nya saja.
 *   - engine WEBJS dan NOWEB memberi bentuk _data yang berbeda. Bagian yang
 *     dipakai di sini sengaja hanya field tingkat atas yang stabil di keduanya,
 *     dan sisanya diambil dari _data secara defensif.
 *   - domain PN di WAHA adalah "@c.us", bukan "@s.whatsapp.net" (sudah
 *     ditangani di lib/identity).
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
  type MsgType,
  type NormalizedEvent,
  type SendDocumentArgs,
  type SendResult,
  type SendTextArgs,
} from "./types";
import { DOMAIN_LID, DOMAIN_PN_ALT, toIdentity } from "@/lib/identity";
import type { MediaMeta } from "@/db/schema";

const EP = {
  sendText: "/api/sendText",
  sendFile: "/api/sendFile",
  session: (s: string) => `/api/sessions/${s}`,
  message: (s: string, chatId: string, msgId: string) =>
    `/api/${s}/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(msgId)}`,
};

function cfg() {
  const base = (process.env.GATEWAY_URL ?? "").replace(/\/$/, "");
  const key = process.env.GATEWAY_API_KEY ?? "";
  const session = process.env.GATEWAY_INSTANCE ?? "default";
  return { base, key, session };
}

/** Alasannya sama persis seperti di adapter Evolution - lihat catatan di sana. */
const BATAS_MS = 20_000;

async function call(path: string, init?: RequestInit): Promise<Response> {
  const { base, key } = cfg();
  if (!base) throw new Error("GATEWAY_URL belum diisi.");
  try {
    return await fetch(base + path, {
      ...init,
      headers: { "Content-Type": "application/json", "X-Api-Key": key, ...(init?.headers ?? {}) },
      cache: "no-store",
      signal: init?.signal ?? AbortSignal.timeout(BATAS_MS),
    });
  } catch (err) {
    if ((err as Error).name === "TimeoutError" || (err as Error).name === "AbortError") {
      throw new Error(`gateway tidak menjawab dalam ${BATAS_MS / 1000} detik (${path})`);
    }
    throw err;
  }
}

function mapSessionStatus(raw: unknown): GatewayState {
  const s = String(raw ?? "").toUpperCase();
  if (s === "WORKING") return "connected";
  if (s === "SCAN_QR_CODE" || s === "STARTING") return "qr_required";
  if (s === "STOPPED" || s === "DISCONNECTED") return "disconnected";
  return "error";
}

function parseMessage(p: Record<string, unknown>): NormalizedEvent {
  const warnings: string[] = [];
  const inner = asRecord(p._data) ?? {};

  const stanzaId = pickString(p.id, asRecord(inner.id)?._serialized);
  const groupJid = pickString(p.from, p.chatId);
  if (!stanzaId) return { kind: "ignored", reason: "tanpa payload.id" };
  if (!groupJid) return { kind: "ignored", reason: "tanpa payload.from" };
  if (!groupJid.endsWith("@g.us")) return { kind: "ignored", reason: "bukan grup" };

  const sender = toIdentity(
    p.participant as string,
    p.author as string,
    asRecord(inner.author)?._serialized as string,
    inner.participant as string,
    inner.senderLid as string,
    inner.participantLid as string,
  );
  if (!sender.pn && !sender.lid) warnings.push("identitas pengirim kosong (cek payload.participant di dump)");
  if (!sender.lid) warnings.push("LID pengirim tidak ada di payload");

  /* --- reply: WAHA menaruhnya di replyTo, tapi engine NOWEB tetap membawa
         contextInfo di _data. Dicoba dua-duanya. --- */
  const replyTo = asRecord(p.replyTo);
  const ctx = findContextInfo(inner.message ?? inner);

  const replyToStanzaId = pickString(replyTo?.id, ctx?.stanzaId, asRecord(inner.quotedMsg)?.id);
  const replyToSender = toIdentity(
    replyTo?.participant as string,
    ctx?.participant as string,
    ctx?.participantAlt as string,
  );
  if (replyToStanzaId && !replyToSender.pn && !replyToSender.lid) {
    warnings.push("reply tanpa identitas pemilik pesan yang di-reply");
  }

  const quotedSnippet = pickString(replyTo?.body) ?? extractText(ctx?.quotedMessage);

  const mentionsRaw = p.mentionedIds ?? ctx?.mentionedJid ?? inner.mentionedIds;
  const mentionedJids = Array.isArray(mentionsRaw)
    ? mentionsRaw
        .map((x) => (typeof x === "string" ? x : pickString(asRecord(x)?._serialized)))
        .filter((x): x is string => !!x)
    : [];

  const { date, guessed } = parseTimestamp(p.timestamp ?? inner.t);
  if (guessed) warnings.push("timestamp tidak terbaca, dipakai waktu terima");

  /* --- jenis pesan & media --- */
  const media = asRecord(p.media);
  let msgType: MsgType = mapMsgType(pickString(p.type, inner.type), inner.message);
  if (msgType === "text" && (p.hasMedia === true || media)) msgType = "document";

  let mediaMeta: MediaMeta | null = extractMediaMeta(inner.message);
  if (!mediaMeta && media) {
    mediaMeta = {
      mimetype: pickString(media.mimetype) ?? undefined,
      fileName: pickString(media.filename, media.fileName) ?? undefined,
      fileLength: Number(media.filesize ?? media.size) || undefined,
    };
  }

  return {
    kind: "message",
    warnings,
    message: {
      stanzaId,
      groupJid,
      sender,
      senderPushName: pickString(p.notifyName, inner.notifyName, p.pushName),
      fromMe: p.fromMe === true,
      msgType,
      body: pickString(p.body) ?? extractText(inner.message),
      replyToStanzaId,
      replyToSender,
      quotedSnippet,
      mentionedJids,
      mediaMeta,
      timestamp: date,
      isEdited: false,
    },
  };
}

export const wahaAdapter: GatewayAdapter = {
  name: "waha",

  parse(body: unknown): NormalizedEvent[] {
    const root = asRecord(body);
    if (!root) return [{ kind: "ignored", reason: "body bukan objek" }];

    const event = String(root.event ?? "").toLowerCase();
    const payload = asRecord(root.payload);

    try {
      switch (event) {
        case "message":
        case "message.any": {
          if (!payload) break;
          return [parseMessage(payload)];
        }

        case "message.ack": {
          const stanzaId = pickString(payload?.id);
          const ack = Number(payload?.ack);
          if (!stanzaId || Number.isNaN(ack)) break;
          return [{ kind: "ack", stanzaId, ack }];
        }

        case "message.revoked": {
          const before = asRecord(payload?.before);
          const stanzaId = pickString(before?.id, payload?.id);
          if (!stanzaId) break;
          return [{ kind: "revoke", stanzaId, groupJid: pickString(before?.from, payload?.from) }];
        }

        case "message.edited": {
          const stanzaId = pickString(payload?.id);
          if (!stanzaId) break;
          return [
            {
              kind: "edit",
              stanzaId,
              groupJid: pickString(payload?.from),
              newBody: pickString(payload?.body),
            },
          ];
        }

        case "session.status": {
          return [{ kind: "connection", state: mapSessionStatus(payload?.status), detail: payload }];
        }
      }
    } catch (err) {
      return [{ kind: "ignored", reason: `gagal parse: ${(err as Error).message}` }];
    }

    return [{ kind: "ignored", reason: `event tidak ditangani: ${event}` }];
  },

  async sendText({ groupJid, text, replyToStanzaId, mentions }: SendTextArgs): Promise<SendResult> {
    const { session } = cfg();
    const mentionIds: string[] = [];
    for (const m of mentions ?? []) {
      if (m.pn) mentionIds.push(`${m.pn}@${DOMAIN_PN_ALT}`);
      if (m.lid) mentionIds.push(`${m.lid}@${DOMAIN_LID}`);
    }

    const res = await call(EP.sendText, {
      method: "POST",
      body: JSON.stringify({
        session,
        chatId: groupJid,
        text,
        ...(mentionIds.length ? { mentions: mentionIds } : {}),
        ...(replyToStanzaId ? { reply_to: replyToStanzaId } : {}),
      }),
    });

    const json = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`sendText gagal ${res.status}: ${JSON.stringify(json)?.slice(0, 300)}`);
    return { stanzaId: pickString(asRecord(json)?.id, asRecord(asRecord(json)?.id)?._serialized), raw: json };
  },

  async sendDocument(args: SendDocumentArgs): Promise<SendResult> {
    const { session } = cfg();
    const res = await call(EP.sendFile, {
      method: "POST",
      body: JSON.stringify({
        session,
        chatId: args.groupJid,
        caption: args.caption ?? "",
        // section 12: nama file asli WAJIB dipertahankan.
        file: {
          mimetype: args.mimetype,
          filename: args.fileName,
          data: args.data.toString("base64"),
        },
        ...(args.replyToStanzaId ? { reply_to: args.replyToStanzaId } : {}),
      }),
    });

    const json = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`sendDocument gagal ${res.status}: ${JSON.stringify(json)?.slice(0, 300)}`);
    return { stanzaId: pickString(asRecord(json)?.id, asRecord(asRecord(json)?.id)?._serialized), raw: json };
  },

  async fetchMedia(stanzaId: string, groupJid: string): Promise<MediaStream> {
    const { session, base } = cfg();
    const expired: MediaStream = {
      body: null,
      mimetype: "application/octet-stream",
      fileName: stanzaId,
      expired: true,
    };

    const metaRes = await call(EP.message(session, groupJid, stanzaId));
    if (!metaRes.ok) return expired;

    const meta = asRecord(await metaRes.json().catch(() => null));
    const media = asRecord(meta?.media);
    const url = pickString(media?.url);
    if (!url) return expired;

    // URL media WAHA dilayani oleh WAHA sendiri; kalau relatif, lengkapi.
    const fileRes = await fetch(url.startsWith("http") ? url : base + url, {
      headers: { "X-Api-Key": cfg().key },
      cache: "no-store",
    });
    if (!fileRes.ok || !fileRes.body) return expired;

    return {
      body: fileRes.body,
      mimetype: pickString(media?.mimetype, fileRes.headers.get("content-type")) ?? "application/octet-stream",
      fileName: pickString(media?.filename, media?.fileName) ?? stanzaId,
      expired: false,
    };
  },

  async fetchGroups() {
    // BELUM DIVERIFIKASI ke WAHA yang berjalan - proyek ini memakai Evolution.
    const { session } = cfg();
    const res = await call(`/api/${session}/groups`);
    if (!res.ok) throw new Error(`daftar grup gagal ${res.status}`);
    const json = await res.json().catch(() => null);
    if (!Array.isArray(json)) return [];
    return json
      .map((raw) => asRecord(raw))
      .filter((g): g is Record<string, unknown> => !!g)
      .map((g) => ({
        jid: pickString(g.id, asRecord(g.id)?._serialized) ?? "",
        subject: pickString(g.name, g.subject),
      }))
      .filter((g) => g.jid.endsWith("@g.us"));
  },

  async fetchPeople(groupJid: string) {
    /* BELUM DIVERIFIKASI ke WAHA yang berjalan - proyek ini memakai Evolution.
       WAHA tidak mengembalikan nama kontak di sini, cuma id peserta; pemanggil
       memang sudah menyiapkan cadangan nama dari pushName. */
    const { session } = cfg();
    const res = await call(`/api/${session}/groups/${encodeURIComponent(groupJid)}/participants`);
    if (!res.ok) throw new Error(`daftar peserta gagal ${res.status}`);
    const json = await res.json().catch(() => null);
    if (!Array.isArray(json)) return [];
    return json
      .map((raw) => asRecord(raw))
      .filter((p): p is Record<string, unknown> => !!p)
      .map((p) => {
        const id = toIdentity(pickString(p.id, asRecord(p.id)?._serialized));
        return {
          pn: id.pn,
          lid: id.lid,
          name: pickString(p.name, p.pushname),
          isAdmin: p.isAdmin === true || p.isSuperAdmin === true,
        };
      })
      .filter((p) => p.pn || p.lid);
  },

  async fetchContacts() {
    // BELUM DIVERIFIKASI ke WAHA yang berjalan - proyek ini memakai Evolution.
    const { session } = cfg();
    const res = await call(`/api/contacts/all?session=${encodeURIComponent(session)}`);
    if (!res.ok) throw new Error(`daftar kontak gagal ${res.status}`);
    const json = await res.json().catch(() => null);
    if (!Array.isArray(json)) return [];
    return json
      .map((raw) => asRecord(raw))
      .filter((k): k is Record<string, unknown> => !!k)
      .map((k) => {
        const id = toIdentity(pickString(k.id, asRecord(k.id)?._serialized));
        return { pn: id.pn, lid: id.lid, name: pickString(k.name, k.pushname, k.shortName) ?? "" };
      })
      .filter((k) => k.name.length > 0 && (k.pn || k.lid));
  },

  async status() {
    const { session } = cfg();
    try {
      const res = await call(EP.session(session));
      const json = asRecord(await res.json().catch(() => null));
      return { state: mapSessionStatus(json?.status), detail: json };
    } catch (err) {
      return { state: "error" as GatewayState, detail: { message: (err as Error).message } };
    }
  },
};
