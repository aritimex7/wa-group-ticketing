# SPEC — Dashboard Tiket WhatsApp Grup

> **Cara pakai file ini:** simpan di root folder proyek. Buka Claude Code, minta dia
> membaca file ini **sampai habis** sebelum menulis kode apa pun. File ini adalah
> sumber kebenaran. Bagian **§13 Keputusan yang Sengaja Ditolak** sama pentingnya
> dengan bagian fitur — jangan tambahkan apa pun yang ada di daftar itu.

---

## 1. Konteks & Masalah

Satu nomor WhatsApp dipakai bersama oleh 4 orang untuk melayani klien **di dalam grup
WhatsApp** (bukan chat personal). Klien memanggil tim dengan cara mention (`@`) atau
swipe-reply ke pesan tim.

Masalah yang dipecahkan:

1. Tidak tahu **siapa** yang membalas (semua balasan tampil sebagai satu identitas)
2. Tidak tahu **mana yang sudah dibalas dan mana yang belum**
3. Tidak ada ukuran SLA / beban kerja per orang
4. Dua orang bisa membalas hal yang sama tanpa sadar

Kondisi operasional:

- Operasional **24 jam**, ada shift
- Semua agen membalas dari **PC kantor** lewat dashboard. HP utama disimpan, jarang dipakai
- Tim sudah punya kebiasaan menandatangani balasan dengan `#dsp {kode}` (kode unik per agen)
- Statistik hanya boleh dilihat **team leader**
- Dibangun **dari nol** (tidak ada source code lama)

---

## 2. Arsitektur

Tiga komponen **terpisah**. Jangan digabung jadi satu proses.

```
WhatsApp  <--QR session-->  GATEWAY  --webhook-->  WEB APP (API + UI)
                               |                        |
                               +------> POSTGRES <------+
                                             |
                                    FILE: hanya credential sesi
```

| Komponen | Isi | Kenapa terpisah |
|---|---|---|
| **Gateway** | pemegang sesi WhatsApp, hidup 24/7 | kalau digabung UI, tiap deploy ulang sesi WA ikut putus |
| **Postgres** | seluruh data | — |
| **Web App** | REST API + UI, login per agen | bebas di-deploy kapan saja |

### 2.1 Gateway: JANGAN tulis layer WhatsApp sendiri

Gunakan **Evolution API** atau **WAHA** (pembungkus Baileys yang sudah menangani QR,
reconnect, dan webhook). Alasan: perbaikan bug LID datang dari upstream, bukan dari PR
kalian sendiri.

Catatan jujur: isu LID **masih ada** di wrapper mana pun. Tetap harus diverifikasi sendiri
(lihat §3).

### 2.2 Infrastruktur

- VPS kecil (2 GB cukup), nyala 24 jam
- **Volume persisten** untuk folder credential sesi — kalau hilang, harus scan QR ulang
- Login web app **dibatasi IP kantor** (semua agen dari PC kantor, jadi ini pengaman gratis)
- Backup Postgres harian, dan **uji restore-nya minimal sekali**

---

## 3. LID — Jebakan Nomor Satu

WhatsApp sedang migrasi dari identitas berbasis nomor (`@s.whatsapp.net` / **PN**) ke
identitas acak (`@lid` / **LID**). Di grup, field `participant` dan `mentionedJid` sering
keluar dalam format LID, bukan nomor.

**Akibat kalau diabaikan:** deteksi "orang me-reply pesan kita" gagal diam-diam, dan
mention yang dikirim tidak menotifikasi siapa pun. Bug-nya tidak error — hanya tidak jalan.

### Aturan wajib

1. **Setiap identitas disimpan dua kolom**: `*_pn` dan `*_lid`. Tanpa kecuali.
2. **Setiap perbandingan identitas mengecek keduanya** — apakah ini reply ke kita, siapa
   pengirimnya, siapa yang di-mention.
3. Konversi **PN → LID tersedia**. Arah **LID → PN tidak dijamin**. Jangan bikin logika
   yang bergantung pada selalu bisa mengembalikan LID jadi nomor.
4. Simpan LID milik akun sendiri di config, karena dipakai terus untuk pencocokan.

### Aturan kerja untuk Claude Code

- **Jangan tulis logika parsing dari ingatan.** Baca type definitions dari library yang
  benar-benar terinstall di `node_modules`.
- **Fase 0 wajib dijalankan dulu** (§12): dump payload asli ke file JSON selama beberapa
  hari, baru tulis parser berdasarkan bentuk nyata itu.

---

## 4. Skema Database

Postgres. Nama kolom di bawah adalah acuan, boleh disesuaikan asal maknanya sama.

### 4.1 `groups`

| kolom | catatan |
|---|---|
| `jid` | PK, `...@g.us` |
| `name` | |
| `is_monitored` | **default FALSE** — grup diaktifkan manual oleh leader |
| `client_label` | label klien/kategori |
| `sla_first_response_min` | nullable, override target global |
| `sla_resolution_min` | nullable |
| `created_at` | dipakai untuk notifikasi "grup baru terdeteksi" |

### 4.2 `agents`

| kolom | catatan |
|---|---|
| `id` | PK |
| `name` | |
| `username`, `password_hash` | login |
| `signature_code` | kode `#dsp` — **UNIQUE, wajib divalidasi** |
| `role` | `agent` \| `leader` |
| `shift` | untuk pengelompokan statistik |
| `is_active` | **nonaktifkan, jangan pernah DELETE** (statistik lama ikut rusak) |

### 4.3 `messages` — semua pesan grup, bukan hanya yang jadi tiket

| kolom | catatan |
|---|---|
| `stanza_id` | PK, ID pesan dari WhatsApp |
| `group_jid` | FK |
| `sender_pn`, `sender_lid` | **dua-duanya** |
| `sender_push_name` | nama tampilan |
| `direction` | `in` \| `out` |
| `msg_type` | `text` \| `image` \| `video` \| `document` \| `audio` \| `sticker` \| `location` |
| `body` | teks / caption |
| `reply_to_stanza_id` | dari `contextInfo.stanzaId` — **inti dari fitur context** |
| `reply_to_sender_pn`, `reply_to_sender_lid` | dari `contextInfo.participant` |
| `quoted_snippet` | cuplikan isi pesan yang di-reply, dari payload. Berguna untuk pesan pra-sistem |
| `media_meta` | JSONB: mimetype, ukuran, nama file, thumbnail. **BUKAN filenya** |
| `agent_id` | hanya untuk `direction=out` dari dashboard. NULL = tidak teratribusi |
| `signature_code` | hasil parsing `#dsp xx` dari teks |
| `is_deleted`, `is_edited` | |
| `raw_payload` | JSONB mentah — sangat menolong saat debugging |
| `created_at` | timestamp WhatsApp |

Index yang perlu: `(group_jid, created_at)`, `reply_to_stanza_id`, full-text pada `body`.

### 4.4 `tickets`

**Aturan: 1 pesan masuk = 1 tiket.**

| kolom | catatan |
|---|---|
| `id` | PK |
| `stanza_id` | FK ke pesan pemicu, UNIQUE |
| `group_jid` | FK |
| `status` | `open` \| `on_progress` \| `closed` \| `not_for_us` |
| `trigger_type` | `mention` \| `reply` |
| `likely_not_ours` | boolean, lihat §6.4 |
| `claimed_by`, `claimed_at` | hanya terisi saat `on_progress` |
| `first_response_at`, `first_responder_id` | balasan pertama, **termasuk "on check"** |
| `resolved_at`, `resolved_by` | jawaban tuntas |
| `closed_at`, `closed_by` | |
| `sla_target_fr_min`, `sla_target_res_min` | **disalin saat tiket dibuat** — supaya ubah setting tidak mengubah laporan lama |
| `note` | catatan serah terima antar shift |

### 4.5 `ticket_events` — audit log

`ticket_id`, `agent_id`, `action`, `from_value`, `to_value`, `created_at`.

Action minimal: `claim`, `release`, `takeover`, `reply_sent`, `mark_on_check`,
`mark_resolved`, `mark_not_for_us`, `undo`.

### 4.6 `settings` + `settings_audit`

Semua perubahan setting **wajib tercatat**: siapa, kapan, dari nilai apa ke apa.
Target SLA yang diubah diam-diam bisa mengubah makna seluruh laporan.

### 4.7 `archive_messages` — OPSIONAL, dan WAJIB TERPISAH

Hasil impor export chat `.txt` (tanggal, pengirim, teks). Tujuannya **hanya satu**:
pencarian teks untuk mencocokkan `quoted_snippet` pesan lama yang tidak ada di DB.

- Cocokkan lewat **isi teks**, bukan ID (file export tidak memuat ID pesan)
- Tampilkan sebagai **"kemungkinan cocok"**, bisa lebih dari satu kandidat
- **Jangan pernah** ikut masuk statistik SLA atau hitungan tiket

---

## 5. Ingestion (Gateway)

1. Terima webhook dari gateway untuk **semua** pesan di grup yang `is_monitored = true`
2. Simpan **semua** ke `messages` — tidak peduli apakah jadi tiket atau tidak
3. Baru kemudian evaluasi aturan pembuatan tiket (§6)

Kenapa semua disimpan: fitur "lihat chat grup", pencarian, dan Fase 4 semuanya bergantung
pada ini. Kalau di tahap ini hanya menyimpan pesan yang nge-tag, semua fitur itu berarti
bongkar ulang dari awal.

**Grup baru:** kalau webhook datang dari grup yang belum ada di tabel `groups`, buat
recordnya dengan `is_monitored = FALSE` dan kirim notifikasi ke leader.

---

## 6. Aturan Tiket

### 6.1 Pemicu (bisa dimatikan per jenis di setting)

- Pesan yang **mention** akun kita → tiket
- Pesan yang **swipe-reply** pesan kita → tiket
- Pesan dari akun sendiri → **tidak pernah** jadi tiket
- Pesan dari nomor internal (daftar di setting) → diabaikan
- Frasa yang diabaikan ("ok", "siap", "makasih") → lihat §6.6

> Catatan: `#dsp xx` adalah **tanda tangan balasan tim**, BUKAN pemicu tiket.

### 6.2 Pool terbuka

Semua tiket `open` terlihat oleh semua agen. Siapa cepat dia dapat. Tidak ada penugasan.

### 6.3 Lock — hanya pada `on_progress`

- Tiket `open` → bebas diambil siapa saja
- Tiket dibuka/diambil agen → `on_progress`, terkunci ke dia
- Agen lain melihat "Sedang ditangani {nama}", kotak balas nonaktif
- **Tidak ada lock per grup.** Tiket lain dari grup yang sama tetap bebas

**Pengecekan lock dilakukan di server saat tombol kirim ditekan, bukan saat tiket dibuka.**
Layar bisa basi; server tidak. Perebutan claim harus pakai operasi atomik (misal
`UPDATE ... WHERE claimed_by IS NULL RETURNING`) supaya dua klik bersamaan hanya
menghasilkan satu pemenang. Yang kalah mendapat pesan "{nama} sudah mengambil tiket ini".

**Takeover:**
- Tombol tersedia bebas, tidak perlu izin
- Wajib konfirmasi: "Tiket ini sedang ditangani Rio. Yakin ambil alih?"
- Dicatat di `ticket_events`
- Layar agen lama langsung berubah jadi "diambil alih oleh {nama}" supaya dia berhenti mengetik

**Auto-release:** `on_progress` kembali ke `open` kalau agennya logout atau tidak aktif
melebihi durasi di setting. Ini yang mencegah tiket nyangkut saat pergantian shift.

### 6.4 Penanda "kemungkinan bukan untuk kita"

Kalau pesan me-mention kita **tapi** `contextInfo.participant`-nya adalah orang lain,
berarti pengirim sedang berbicara dengan orang lain dan hanya menyebut kita.

→ set `likely_not_ours = true`, kartu diberi penanda kuning
→ **tetap masuk antrean**, hanya diturunkan prioritasnya. Jangan disembunyikan otomatis.

### 6.5 "Bukan untuk kami"

- Satu klik → status `not_for_us`, kartu hilang dari antrean agen
- **Tidak menyimpan alasan**
- **Tidak dihitung** dalam SLA maupun jumlah tiket agen
- Ada undo beberapa detik
- Kalau kemudian ada reply lagi di utas itu yang memang untuk kita → **tiket baru**,
  bukan menghidupkan tiket lama
- Leader bisa melihat daftar tiket yang dibuang dan persentasenya per agen

### 6.6 Frasa yang diabaikan

Pesan yang kena filter **jangan dibuang**. Masukkan ke keranjang **"diabaikan"** yang bisa
ditinjau leader. Setting ini yang paling berbahaya — salah isi berarti tiket hilang tanpa jejak.

Hal yang sama berlaku untuk pola yang mirip tapi tidak persis → keranjang **"perlu ditinjau"**.

### 6.7 Alur balas

- **Balas langsung lalu tandai selesai** — untuk yang mudah
- **Ambil dulu tanpa balas** (`on_progress`) — untuk yang perlu dicek. Jam SLA tetap jalan
- **"On check"** = balasan penahan. Mengisi `first_response_at`, **tidak** mengisi
  `resolved_at`. Balasan lanjutan tetap menempel ke pesan asli klien, bukan ke pesan
  "on check" milik sendiri

### 6.8 Satu balasan menutup beberapa tiket

Karena 1 pesan = 1 tiket, klien yang mengirim 3 pesan beruntun menghasilkan 3 tiket yang
sering dijawab dengan satu balasan.

→ Saat agen mengirim, tampilkan tiket lain yang masih terbuka dari grup yang sama, dengan
checkbox untuk ikut ditutup sekaligus.

→ Di kartu tiket, tampilkan peringatan lunak: *"ada 2 tiket lain terbuka dari grup ini"*.
Tidak menghalangi, hanya membuat sadar.

---

## 7. Context Percakapan

### 7.1 Utas bercabang — bukan garis lurus

Kasus: A reply B, C reply B, C tag kita.

Penelusuran naik dari C hanya menghasilkan C→B. **A hilang**, padahal A ikut membahas B.

**Algoritma yang benar:**
1. Telusuri `reply_to_stanza_id` ke atas sampai ketemu akar (pesan tanpa parent)
2. Dari akar, tarik **semua** turunannya secara rekursif
3. Urutkan berdasarkan waktu, tampilkan sebagai utas

Pesan tim sendiri **ikut** ditampilkan kalau bagian dari utas.

Utas tumbuh terus: setelah tim membalas, lalu A reply balasan itu tanpa tag → tiket baru,
tapi utasnya tetap sama dan contextnya sudah lengkap.

Gunakan recursive CTE Postgres. Beri batas kedalaman wajar untuk jaga performa.

### 7.2 Pesan lama dari sebelum sistem aktif

Dashboard hanya "melihat" sejak hari gateway tersambung.

Kalau `reply_to_stanza_id` tidak ditemukan di DB:
1. Tampilkan `quoted_snippet` dari payload (WhatsApp ikut mengirim cuplikannya)
2. Kalau `archive_messages` ada, cari kandidat kecocokan teks — tampilkan sebagai
   "kemungkinan cocok"
3. Kalau tetap tidak ada: tampilkan *"Membalas pesan dari sebelum sistem aktif"* +
   tombol buka WhatsApp. **Jangan tampilkan kutipan kosong.**

### 7.3 Tombol "Lihat chat grup"

Membuka percakapan grup apa adanya di sekitar jam tiket, bisa di-scroll seperti WhatsApp.
**Read-only** — membalas tetap harus lewat tiket supaya tercatat.

Plus pencarian teks lintas grup.

---

## 8. SLA

Operasional **24 jam** → tidak ada kalender jam kerja. Hitungan mentah selisih waktu.

Dua metrik **dipisah**:

| Metrik | Definisi |
|---|---|
| **First Response Time** | `first_response_at` − waktu pesan masuk |
| **Resolution Time** | `resolved_at` − waktu pesan masuk |

Aturan:

- Gunakan **median**, bukan rata-rata. Satu tiket nyangkut semalaman bisa merusak rata-rata
  seorang agen yang kerjanya normal
- Hitung **jumlah tiket**, bukan jumlah pesan terkirim
- Tiket `not_for_us` **tidak masuk** perhitungan
- Target disalin ke tiket saat dibuat → mengubah setting tidak mengubah laporan lama
- Ambang peringatan (misal 80% target) diatur di setting

---

## 9. Dashboard Agen

### 9.1 Layar utama — tiga kolom

| Kolom | Urutan |
|---|---|
| Belum dibalas | **yang paling lama menunggu di atas** |
| Sedang ditangani | dengan nama pemegangnya |
| Selesai hari ini | terbaru di atas |

Isi kartu: nama grup, siapa yang tag, cuplikan pesan, dan **sudah menunggu berapa lama**
(angka berjalan — "menunggu 12 menit" jauh lebih menggerakkan daripada "masuk 14.03").

Kartu berubah **realtime** saat ada yang mengambil, tanpa perlu refresh.

### 9.2 Halaman tiket

- Panel context utas (§7.1) di atas
- Tombol "Lihat chat grup"
- Kotak balas + tombol mention + upload dokumen/media
- Tombol: Kirim, On check, Selesai, Bukan untuk kami
- Otomatis `claim` saat dibuka
- **Nama grup ditampilkan besar dan mencolok di dekat kotak balas.** Salah kirim ke grup
  lain adalah kesalahan paling fatal dan paling sering. Munculkan konfirmasi kalau grupnya
  berbeda dari tiket yang terakhir dibuka

### 9.3 Panel statistik pribadi

Hari ini menangani berapa, median waktu balas dirinya, berapa yang lewat SLA.

Agen **harus** bisa melihat angkanya sendiri — sama persis dengan yang dilihat leader.
Metrik yang hanya terlihat dari atas lebih cepat diakali daripada diperbaiki.

### 9.4 Pengaman pengiriman

- Tombol kirim **mati** begitu ditekan
- **Idempotency key** per pengiriman — klik ganda / internet lambat tidak menghasilkan dua pesan
- **Undo 5 detik**: pesan ditahan di server, baru dilempar ke WhatsApp setelah jeda habis.
  Ini undo sungguhan, bukan "hapus untuk semua" yang meninggalkan jejak
  *pesan ini telah dihapus* di grup klien
- Status kirim diambil dari **konfirmasi WhatsApp**, bukan dari "API sudah dipanggil"
- **Kirim gagal → tiket kembali ke antrean dengan tanda merah dan teks balasan masih utuh.**
  Jangan pernah hilang diam-diam

### 9.5 Lain-lain

- Notifikasi untuk tiket baru dan tiket mendekati batas SLA. Tanpa ini agen tetap mengintip
  HP dan dashboard jadi sia-sia
- Balasan cepat / template
- **Target desain: dari notifikasi sampai balasan terkirim, maksimal 2 klik.** Yang membunuh
  dashboard seperti ini bukan fiturnya kurang, tapi kalah cepat dari membuka WhatsApp langsung

### 9.6 Yang TIDAK ada di dashboard agen

- Perbandingan antar agen (itu milik leader)
- Semua grup sekaligus tanpa filter

---

## 10. Dashboard Leader

Hanya dapat diakses `role = leader`.

**Kondisi sekarang**
- **Indikator gateway tersambung/putus — paling atas, paling besar**
- Jumlah antrean: open / on_progress / lewat SLA
- Tiket paling lama menunggu
- Siapa sedang aktif dan memegang berapa

**Per agen** (filter hari / minggu / bulan)
- Jumlah tiket ditangani
- Median FRT dan median resolution
- Jumlah pelanggaran SLA
- **Dipisah per shift**

**Kesehatan data** — bagian yang menentukan angka di atas boleh dipercaya atau tidak
- Balasan tanpa `#dsp` / tanpa `agent_id` (tidak teratribusi)
- Keranjang "perlu ditinjau" dan "diabaikan"
- Kirim gagal
- Total waktu gateway terputus

**Beban kerja**
- Volume per jam dalam sehari → untuk mengatur shift
- Volume per grup/klien
- Daftar tiket `not_for_us` + persentase per agen

**Export CSV** dan klik-tembus ke percakapan.

### Rambu tampilan

- **Jangan bandingkan shift malam dan siang berdampingan.** Agen malam mungkin 5 tiket,
  siang 40. Tanpa konteks, yang malam terlihat santai padahal dia yang melek jam 3 pagi
- **Jangan pasang papan peringkat.** Begitu diperingkat, agen akan memilih tiket mudah dan
  menghindari yang rumit
- Persentase `not_for_us` tinggi pada satu orang **bukan otomatis berarti curang** — bisa
  jadi dia pegang grup paling ramai. Sajikan sebagai sinyal untuk ditanya, bukan vonis

---

## 11. Halaman Setting

**Koneksi**
- Status gateway, tombol scan ulang QR, riwayat putus-nyambung
- Alarm putus dikirim ke mana (WA leader / email)

**Grup**
- Daftar grup terdeteksi, toggle aktif/nonaktif per grup — **default nonaktif**
- Label klien/kategori
- Target SLA override per grup

**Pemicu tiket**
- Mention bikin tiket: ya/tidak
- Swipe-reply bikin tiket: ya/tidak
- Daftar nomor internal yang diabaikan
- Daftar frasa yang diabaikan

**Tanda tangan**
- Pola: `#dsp {kode}`
- Daftar kode per agen — **validasi unik, tolak kalau kembar**
- Sisip otomatis saat kirim dari dashboard: nyala
- Tingkat kelonggaran pencocokan (huruf besar-kecil bebas, spasi bebas)

**SLA**
- Target first response & resolution (menit)
- Ambang peringatan

**Agen & akses**
- Tambah agen, atur shift, tentukan leader
- **Nonaktifkan, jangan hapus**
- IP whitelist kantor

**Operasional**
- Durasi auto-release claim (menit)
- Durasi undo (detik)
- Balasan cepat / template

Semua perubahan masuk `settings_audit`.

---

## 12. Media & Dokumen

**Keputusan: media TIDAK disimpan.**

- Metadata saja di `messages.media_meta` (mimetype, ukuran, nama file, thumbnail)
- Agen klik unduh → gateway mengambil dari WhatsApp → **stream langsung ke browser**
- Tidak ada file tersimpan di server, tidak ada di database, tidak ada aturan retensi

**Konsekuensi yang diterima:** link media WhatsApp kedaluwarsa dalam hitungan hari. Media di
tiket lama tidak bisa diunduh lagi → tampilkan pesan jelas *"media sudah kedaluwarsa, buka
di WhatsApp"*. Ini dapat diterima karena tiket dibalas di hari yang sama.

**Kirim dokumen dari dashboard** (Excel, PDF, Word, ZIP)
- Kirim sebagai **document**, bukan image — supaya nama file dan ekstensi utuh
- **Pertahankan nama file asli.** Ini sering jadi bug — masukkan ke daftar uji
- Batas WhatsApp 2 GB; tampilkan indikator progres supaya agen tidak klik dua kali
- File sementara **dihapus setelah terkirim**

**Mention dari dashboard**
Teks pesan harus memuat `@<nomor>` **DAN** ID orangnya dimasukkan ke `mentionedJid`.
Kalau hanya teks → tidak ada notifikasi. Kalau hanya array → tidak ada highlight.
**Isi dalam format PN dan LID** (§3).

**Pesan dihapus/diedit klien**
Tandai *"pesan ini dihapus pengirim"* — jangan ikut hilang dari tiket.

---

## 13. Keputusan yang Sengaja DITOLAK

> Jangan tambahkan hal-hal berikut. Semuanya sudah dipertimbangkan dan ditolak.

| Ditolak | Alasan |
|---|---|
| Kalender jam kerja / hari libur | operasional 24 jam |
| Lock per grup | terlalu ketat; diganti peringatan lunak §6.8 |
| Menyimpan alasan pembuangan tiket | tidak diperlukan |
| Menyimpan file media di server/DB | §12 |
| **Sync riwayat penuh saat scan QR** | **BERBAHAYA** — sinkronisasi tidak lengkap & tidak konsisten, berat, dan pola menarik riwayat besar di awal adalah salah satu yang paling mudah kena flag |
| Impor export `.txt` sebagai data utama | file export tidak memuat ID pesan → tidak bisa dicocokkan. Hanya boleh sebagai arsip pencarian terpisah (§4.7) |
| Papan peringkat antar agen | mendorong agen memilih tiket mudah |
| WhatsApp Business API resmi | tidak bisa masuk grup pihak lain (Groups API resmi maks 8 peserta, wajib Official Business Account, grup harus dibuat oleh bisnis) |
| Menebak reply tanpa tag & tanpa swipe secara otomatis | tidak ada penanda apa pun di protokol; tebakan waktu terlalu sering salah di grup ramai |

---

## 14. Urutan Pengerjaan

### Fase 0 — Ingestion (WAJIB DULUAN, jangan dilewati)

- Gateway tersambung, webhook masuk
- Simpan **semua** pesan grup ke `messages`, tanpa filter apa pun
- **Jalankan diam-diam 2–3 hari**, dump `raw_payload` ke file JSON
- Periksa bentuk nyatanya: format LID vs PN, isi `contextInfo`, tipe media
- Baru tulis parser berdasarkan temuan itu

> Kenapa ini tidak boleh dipotong jadi "simpan yang nge-tag saja": fitur lihat chat grup,
> pencarian, context utas, dan Fase 4 semuanya bergantung pada data lengkap ini.
> Memotongnya berarti bongkar ulang nanti.

### Fase 1 — Atribusi (prioritas #1 pemilik)
Login per agen → kirim dari dashboard → catat `agent_id` + sisip `#dsp` otomatis.

### Fase 2 — Status & SLA (prioritas #2)
Tiket, claim/lock, takeover, on check, selesai, bukan-untuk-kami, auto-release,
dashboard leader.

### Fase 3 — Mention & Media (prioritas #3)
Mention PN+LID, unduh on-demand, kirim dokumen.

### Fase 4 — Reply tanpa tag (prioritas #4)
Kalau Fase 0 benar, ini **hanya soal menulis query** — datanya sudah ada.

---

## 15. Reliabilitas

| Risiko | Penanganan |
|---|---|
| Gateway putus tanpa ketahuan | indikator besar di layar + alarm ke leader kalau putus > beberapa menit. **Ini mimpi buruknya**: dashboard terlihat normal, antrean sepi, tim santai, padahal pesan masuk terus |
| Sepi beneran vs sepi karena rusak | alarm kalau tidak ada pesan masuk melebihi ambang, padahal jam ramai |
| Kirim gagal ditampilkan berhasil | status dari konfirmasi WhatsApp, bukan dari pemanggilan API |
| Database hilang | backup harian **+ uji restore** |
| Dashboard mati | rencana cadangan tertulis: balas dari HP utama pakai **swipe-reply + `#dsp`**, catat manual. Tanpa rencana ini yang terjadi adalah kepanikan |

---

## 16. Peringatan Risiko (baca sebelum mulai)

- Sesi QR adalah **klien tidak resmi** dan melanggar ToS WhatsApp. Nomor bisa diblokir.
  Ini keputusan sadar pemilik, bukan sesuatu yang bisa dihilangkan oleh kode
- **Jangan pernah** pakai nomor ini untuk blasting. Pola pakai manusiawi (baca–balas di grup
  yang sudah ada) jauh lebih kecil risikonya daripada kirim massal
- **Uji dengan nomor dan grup percobaan minimal seminggu** sebelum menyentuh nomor kerja
- Gateway **memakan 1 slot device** (jatah 1 HP utama + 4 tertaut). Karena semua agen balas
  lewat dashboard, cukup HP utama + gateway — 3 slot sisanya jadi cadangan
- **HP utama wajib dibuka minimal tiap 14 hari**, kalau tidak semua sesi tertaut putus
  termasuk gateway
- Angka SLA sebelum Fase 4 selesai **belum lengkap** (reply tanpa tag belum tertangkap),
  jadi cenderung terlihat lebih bagus dari kenyataan. Sampaikan ke leader sejak awal
- **Jangan pakai angka ini untuk menilai orang di 1–2 bulan pertama.** Datanya belum bersih.
  Kalau bulan pertama sudah dipakai menegur, tim akan fokus mengakali angka

---

## 17. Yang Bisa Dikerjakan Hari Ini Tanpa Kode

Export chat grup ("Tanpa Media") → buka di Excel → hitung baris yang memuat `#dsp {kode}`
per agen.

Ini langsung menjawab pertanyaan awal (total balasan & siapa yang balas) memakai data yang
sudah ada, sekaligus jadi angka pembanding sebelum-sesudah dashboard.

Saat menghitung, **periksa dulu kode unik apa saja yang muncul** — kemungkinan besar ada
varian salah ketik yang selama ini tidak terhitung.
