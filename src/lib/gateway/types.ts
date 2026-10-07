/**
 * Kontrak gateway - SPEC section 2.1.
 *
 * "JANGAN tulis layer WhatsApp sendiri." Kita memakai Evolution API atau WAHA.
 * Berkas ini adalah satu-satunya bentuk yang dikenal sisa aplikasi; kedua
 * wrapper diterjemahkan ke sini, jadi mengganti wrapper tidak menyentuh
 * ingestion, aturan tiket, maupun UI.
 *
 * PERINGATAN (section 14 Fase 0): bentuk payload di adapter mana pun adalah
 * HIPOTESIS sampai diverifikasi dengan dump payload asli. Karena itu parse()
 * tidak pernah melempar - field yang tidak ketemu dicatat sebagai warning dan
 * muncul di panel Kesehatan Data leader, bukan hilang diam-diam.
 */
import type { Identity } from "@/lib/identity";
import type { MediaMeta } from "@/db/schema";

export type MsgType =
  | "text"
  | "image"
  | "video"
  | "document"
  | "audio"
  | "sticker"
  | "location"
  | "other";

export type GatewayState = "connected" | "disconnected" | "qr_required" | "error";

export type NormalizedMessage = {
  stanzaId: string;
  groupJid: string;
  sender: Identity;
  senderPushName: string | null;
  fromMe: boolean;
  msgType: MsgType;
  body: string | null;
  /** dari contextInfo.stanzaId - inti fitur context (section 4.3). */
  replyToStanzaId: string | null;
  /** dari contextInfo.participant - section 3.1 dua-duanya. */
  replyToSender: Identity;
  /** cuplikan pesan yang di-reply, penyelamat untuk pesan pra-sistem (section 7.2). */
  quotedSnippet: string | null;
  /** bisa campuran LID dan PN dalam satu array. */
  mentionedJids: string[];
  mediaMeta: MediaMeta | null;
  timestamp: Date;
  isEdited: boolean;
};

export type NormalizedEvent =
  | { kind: "message"; message: NormalizedMessage; warnings: string[] }
  /** konfirmasi WhatsApp (section 9.4: status kirim TIDAK boleh dari "API sudah dipanggil"). */
  | { kind: "ack"; stanzaId: string; ack: number }
  | { kind: "revoke"; stanzaId: string; groupJid: string | null }
  | { kind: "edit"; stanzaId: string; groupJid: string | null; newBody: string | null }
  | { kind: "connection"; state: GatewayState; detail?: unknown }
  /** metadata grup (nama/subject) - supaya leader tidak perlu mengetik nama manual. */
  | { kind: "group"; jid: string; subject: string | null }
  | { kind: "ignored"; reason: string };

export type SendTextArgs = {
  groupJid: string;
  text: string;
  /** section 6.7 balasan menempel ke pesan asli klien. */
  replyToStanzaId?: string | null;
  /** section 12 mention: teks memuat @nomor DAN id masuk mentionedJid, format PN dan LID. */
  mentions?: { pn: string | null; lid: string | null }[];
};

export type SendDocumentArgs = {
  groupJid: string;
  /** section 12 kirim sebagai document, bukan image - nama file & ekstensi harus utuh. */
  fileName: string;
  mimetype: string;
  /** isi berkas. */
  data: Buffer;
  caption?: string;
  replyToStanzaId?: string | null;
};

export type SendResult = {
  /** id pesan dari WhatsApp. Kalau null, kita TIDAK boleh bilang "terkirim". */
  stanzaId: string | null;
  raw: unknown;
};

/**
 * Satu orang di dalam grup - calon sasaran mention (section 12).
 *
 * `name` adalah nama dari KONTAK TERSIMPAN di HP gateway, bukan pushName.
 * Sering null, dan itu keadaan normal: terukur di grup klien sungguhan cuma
 * 1 dari 10 dan 16 dari 59 nomor yang tersimpan. Pemanggil wajib menyiapkan
 * cadangan namanya sendiri - jangan tampilkan daftar berisi "null".
 */
export type GroupPerson = {
  pn: string | null;
  lid: string | null;
  name: string | null;
  isAdmin: boolean;
};

/**
 * Satu kontak TERSIMPAN di HP gateway (section 12).
 *
 * Evolution menamai medannya `pushName`, tapi isinya bukan nama pasang-sendiri:
 * diukur ke instance yang berjalan, endpoint ini memuat PERSIS kontak yang
 * tersimpan - nol dari 91 peserta grup yang tidak tersimpan muncul di sana -
 * dan nilainya sama persis dengan `name` yang diberikan endpoint peserta untuk
 * kontak tersimpan. Jadi ini memang nama dari buku alamat.
 */
export type SavedContact = { pn: string | null; lid: string | null; name: string };

export type MediaStream = {
  body: ReadableStream<Uint8Array> | null;
  mimetype: string;
  fileName: string;
  /** section 12: link media WhatsApp kedaluwarsa dalam hitungan hari. */
  expired: boolean;
};

export interface GatewayAdapter {
  readonly name: "evolution" | "waha";
  /** Terjemahkan satu body webhook jadi nol atau lebih peristiwa. Tidak pernah melempar. */
  parse(body: unknown): NormalizedEvent[];
  sendText(args: SendTextArgs): Promise<SendResult>;
  sendDocument(args: SendDocumentArgs): Promise<SendResult>;
  /** Ambil media on-demand lalu stream ke browser - tidak disimpan (section 12). */
  fetchMedia(stanzaId: string, groupJid: string): Promise<MediaStream>;
  status(): Promise<{ state: GatewayState; detail?: unknown }>;
  /** Ambil daftar grup beserta namanya - dipakai mengisi nama grup lama sekaligus. */
  fetchGroups(): Promise<{ jid: string; subject: string | null }[]>;
  /** section 12 daftar peserta satu grup - sumber sasaran mention. */
  fetchPeople(groupJid: string): Promise<GroupPerson[]>;
  /** section 12 seluruh kontak tersimpan - sumber nama orang di mana pun. */
  fetchContacts(): Promise<SavedContact[]>;
}

/* ------------------------------ util bersama ------------------------------ */

export function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

export function pickString(...vals: unknown[]): string | null {
  for (const v of vals) {
    if (typeof v === "string" && v.trim().length) return v;
  }
  return null;
}

/**
 * messageTimestamp bisa berupa detik (number), string, atau objek Long
 * {low, high, unsigned} dari protobuf. Ketiganya pernah muncul di Baileys.
 */
export function parseTimestamp(v: unknown): { date: Date; guessed: boolean } {
  if (typeof v === "number" && Number.isFinite(v)) {
    return { date: new Date(v > 1e12 ? v : v * 1000), guessed: false };
  }
  if (typeof v === "string" && /^\d+$/.test(v)) {
    const n = Number(v);
    return { date: new Date(n > 1e12 ? n : n * 1000), guessed: false };
  }
  if (typeof v === "string") {
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return { date: d, guessed: false };
  }
  const rec = asRecord(v);
  if (rec && typeof rec.low === "number") {
    return { date: new Date(rec.low * 1000), guessed: false };
  }
  // Terakhir: pakai waktu terima. Ditandai supaya kelihatan di warning.
  return { date: new Date(), guessed: true };
}

/**
 * contextInfo tidak selalu di tempat yang sama - letaknya menempel pada
 * jenis pesannya (extendedTextMessage.contextInfo, imageMessage.contextInfo, ...).
 * Jadi dicari, bukan diasumsikan.
 */
export function findContextInfo(message: unknown): Record<string, unknown> | null {
  const m = asRecord(message);
  if (!m) return null;
  const direct = asRecord(m.contextInfo);
  if (direct) return direct;
  for (const value of Object.values(m)) {
    const nested = asRecord(value);
    if (!nested) continue;
    const ctx = asRecord(nested.contextInfo);
    if (ctx) return ctx;
    // documentWithCaptionMessage membungkus satu lapis lagi.
    const deeper = asRecord(nested.message);
    if (deeper) {
      const found = findContextInfo(deeper);
      if (found) return found;
    }
  }
  return null;
}

/** Ambil teks dari objek `message` Baileys, lewat berapa pun lapisan pembungkus. */
export function extractText(message: unknown, depth = 0): string | null {
  const m = asRecord(message);
  if (!m || depth > 3) return null;

  const direct = pickString(
    m.conversation,
    asRecord(m.extendedTextMessage)?.text,
    asRecord(m.imageMessage)?.caption,
    asRecord(m.videoMessage)?.caption,
    asRecord(m.documentMessage)?.caption,
    asRecord(m.documentMessage)?.title,
    asRecord(m.buttonsResponseMessage)?.selectedDisplayText,
    asRecord(m.listResponseMessage)?.title,
    asRecord(m.templateButtonReplyMessage)?.selectedDisplayText,
  );
  if (direct) return direct;

  for (const key of ["documentWithCaptionMessage", "ephemeralMessage", "viewOnceMessage", "viewOnceMessageV2", "editedMessage"]) {
    const wrapped = asRecord(m[key]);
    if (wrapped) {
      const inner = extractText(wrapped.message ?? wrapped, depth + 1);
      if (inner) return inner;
    }
  }
  return null;
}

const TYPE_MAP: Record<string, MsgType> = {
  conversation: "text",
  extendedTextMessage: "text",
  imageMessage: "image",
  videoMessage: "video",
  documentMessage: "document",
  documentWithCaptionMessage: "document",
  audioMessage: "audio",
  pttMessage: "audio",
  stickerMessage: "sticker",
  locationMessage: "location",
  liveLocationMessage: "location",
};

export function mapMsgType(hint: string | null | undefined, message: unknown): MsgType {
  if (hint && TYPE_MAP[hint]) return TYPE_MAP[hint];
  const m = asRecord(message);
  if (m) {
    for (const key of Object.keys(m)) {
      if (TYPE_MAP[key]) return TYPE_MAP[key];
    }
  }
  return hint ? "other" : "text";
}

/** section 12: metadata saja, BUKAN filenya. Thumbnail base64 kecil boleh ikut. */
export function extractMediaMeta(message: unknown): MediaMeta | null {
  const m = asRecord(message);
  if (!m) return null;
  for (const key of ["documentMessage", "imageMessage", "videoMessage", "audioMessage", "stickerMessage"]) {
    const node = asRecord(m[key]);
    if (!node) continue;
    const thumb = node.jpegThumbnail;
    return {
      mimetype: typeof node.mimetype === "string" ? node.mimetype : undefined,
      fileName: typeof node.fileName === "string" ? node.fileName : undefined,
      fileLength: Number(node.fileLength) || undefined,
      seconds: Number(node.seconds) || undefined,
      pageCount: Number(node.pageCount) || undefined,
      thumbnailBase64: typeof thumb === "string" && thumb.length < 60_000 ? thumb : undefined,
    };
  }
  const wrapped = asRecord(m.documentWithCaptionMessage);
  if (wrapped) return extractMediaMeta(wrapped.message);
  return null;
}
