# Deploy ke produksi

Panduan ini khusus untuk **aplikasi ini**, bukan panduan Next.js umum. Semua
angka dan nama berkas di sini diambil dari keadaan nyata mesin pengembangan
per 24 Agustus 2026.

Sumber kebenaran tetap [`SPEC.md`](SPEC.md). 
---

## 1. Yang sebenarnya di-deploy: tiga bagian, bukan satu

Ini bukan "web app yang di-upload". Ada tiga proses yang harus hidup bersamaan,
dan dua di antaranya harus hidup **24 jam**, bukan hanya saat orang membuka
dashboard.

| # | Bagian | Sekarang di mana | Harus hidup 24 jam? | Kalau mati, apa yang terjadi |
|---|---|---|---|---|
| 1 | **Evolution API v2.3.7** (Docker) | WSL di laptop | **Ya** | Pesan masuk berhenti total. Pesan keluar mengendap di outbox. Sesi WhatsApp bisa putus. |
| 2 | **PostgreSQL 18** | WSL di laptop | **Ya** | Dashboard mati, webhook gagal, pesan **hilang permanen** (belum ada replay otomatis). |
| 3 | **Next.js app** | `npm run dev` di Windows, port 3100 | Sebaiknya | Pesan yang datang saat mati **tidak masuk** — payloadnya cuma tersimpan di `var/raw/` dan harus diputar ulang manual. |

Bagian 1 memegang **kredensial sesi WhatsApp**. Itu barang paling berharga di
server ini (SPEC §2.2). Kalau volume `evolution_instances` + database
`evolution` hilang, harus scan QR ulang — dan itu memakai **satu slot device
lagi** (§16).

### Kenapa Vercel / Netlify / Cloudflare Pages TIDAK bisa

Bukan soal selera. Empat hal di kode ini langsung patah di serverless:

1. **`src/instrumentation.ts`** menjalankan `setInterval` 10 detik di dalam
   proses web. Serverless tidak punya proses yang hidup terus. Cron Vercel
   minimum **1 menit**, sementara `ops.undo_seconds` = **5 detik** — artinya
   balasan agen bisa mengendap sampai 60 detik setelah tombol Batalkan hilang.
   Agen akan mengira sistemnya rusak.
2. **`var/raw/*.jsonl`** (Fase 0, §14) menulis ke disk lokal. Disk serverless
   ephemeral — dump-nya hilang tiap request, dan itu satu-satunya bahan untuk
   memeriksa bug parser.
3. **`/api/stream`** adalah SSE — koneksi terbuka lama. Serverless memutusnya.
4. Tetap butuh VPS juga untuk bagian 1 dan 2. Jadi Vercel malah menambah satu
   tempat lagi untuk dijaga, bukan mengurangi.

**Kesimpulan: satu VPS menjalankan ketiganya.**

### Ukuran VPS

Semua angka di bawah **diukur**, bukan ditebak.

**Saat berjalan** — ini yang menentukan biaya bulanan:

| Bagian | Terukur | Cara mengukur |
|---|---|---|
| Evolution API | **145 MB**, CPU 0.25% | `docker stats`, idle, 1 nomor tersambung |
| PostgreSQL | **48 MB** PSS (`shared_buffers` 128 MB) | jumlah `Pss` dari `smaps_rollup` semua proses |
| Next.js produksi | **~460 MB** | `next start` + wrapper, setelah beberapa halaman dibuka |
| Caddy + Docker daemon + OS | ~300–400 MB | perkiraan Ubuntu 24.04 minimal |
| **Total berjalan** | **≈ 1,0–1,4 GB** | |

Database sendiri kecil: `dashboard_wa` 9,7 MB, `evolution` 11 MB.

**Saat `next build`** — dan di sinilah satu-satunya masalahnya:

| Percobaan | Puncak RAM |
|---|---|
| build dingin, 11 worker (mesin 11 core) | **1.646 MB** |
| build dingin, dipaksa 2 worker (`experimental.cpus: 2`) | **2.090 MB** |

Membatasi worker **tidak menolong** — malah naik, karena kompilasi Turbopack
memang satu proses besar dan mengurangi worker cuma memindahkan bebannya, tidak
menghilangkannya. Jadi jangan mengandalkan "VPS-nya cuma 2 core, pasti lebih
irit".

### Jadi, 2 vCPU / 2 GB / 40 GB cukup?

**Untuk menjalankan: cukup, lega.** ≈1,2 GB terpakai dari 2 GB.

**Untuk `next build`: tidak cukup.** Puncaknya 1,6–2,1 GB sementara RAM 2 GB
sudah terisi ~1,2 GB oleh Postgres, gateway, dan OS yang sedang jalan. Kernel
akan membunuh proses build (OOM), dan kalau apes yang dibunuh justru Postgres
atau gateway.

Tiga jalan keluar, semuanya sah:

1. **Tambah swap 2 GB** (paling sederhana — ada di Langkah 2). Build jadi lebih
   lambat karena menyentuh disk, tapi build cuma dijalankan saat memperbarui,
   bukan tiap hari. **Ini yang saya sarankan untuk paket 2 GB.**
2. **Build di laptop, kirim hasilnya.** VPS tidak pernah mem-build sama sekali.
   Perlu `.next/`, `package.json`, `package-lock.json`, `node_modules` produksi,
   `public/`, dan `drizzle/`.
3. **Ambil 4 GB** dan tidak usah memikirkan ini lagi.

**Disk 40 GB: lega.** Database 21 MB, `node_modules` + `.next` ~1,5 GB. Yang
tumbuh diam-diam cuma `var/raw/*.jsonl` (dump Fase 0, ~8 MB per beberapa hari
di grup uji). Matikan `FASE0_DUMP` setelah 2–3 minggu, atau pasang pembersih.

**Bandwidth 20 Mbps: jauh lebih dari cukup.** Lalu lintasnya JSON kecil — satu
webhook pesan teks beberapa kilobyte. Yang berat hanya media.

**Lokasi: Singapura atau Jakarta.** Latensi ke WhatsApp dan ke tim.

---

## 2. Yang perlu disiapkan sebelum mulai

- [ ] VPS Ubuntu 24.04 LTS, akses root/sudo
- [ ] Domain (**sudah ada**) — siapkan satu subdomain, misal `tiket.domain-anda.com`
- [ ] Akses ke panel DNS domain itu
- [ ] **HP dengan nomor gateway** (`6281234567890`) ada di tangan, untuk scan QR ulang
- [ ] Isi `.env` sekarang — beberapa nilai dipakai lagi, beberapa **wajib diganti**

> **Nomor gateway.** Sesi sekarang terikat ke laptop ini. Memindahkannya ke VPS
> berarti **scan QR ulang** = satu slot device terpakai lagi. HP utama wajib
> dibuka minimal tiap 14 hari, kalau tidak semua sesi tertaut putus (§16).

---

## 3. Langkah-langkah

### Langkah 1 — DNS

Arahkan subdomain ke IP VPS. Satu record saja:

```
A    tiket    <IP-VPS>    TTL 300
```

Tunggu sampai `ping tiket.domain-anda.com` menjawab IP VPS. Biasanya
1–15 menit. **Jangan lanjut ke Caddy sebelum ini beres** — penerbitan
sertifikat TLS akan gagal dan Let's Encrypt punya batas percobaan.

### Langkah 2 — Siapkan VPS

```bash
sudo apt update && sudo apt upgrade -y
```

```bash
sudo apt install -y ca-certificates curl git ufw && curl -fsSL https://get.docker.com | sudo sh
```

Node 22 (versi yang dipakai di pengembangan; Next 16 minimal Node 20.9):

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs
```

**Swap 2 GB — wajib kalau RAM cuma 2 GB**, kalau tidak `next build` di Langkah 6
akan dibunuh kernel (lihat "Ukuran VPS"). Lewati kalau RAM 4 GB:

```bash
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile && echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab && free -h
```

Turunkan kecenderungan kernel memakai swap saat RAM masih ada — swap di sini
untuk jaga-jaga saat build, bukan untuk dipakai sehari-hari:

```bash
echo 'vm.swappiness=10' | sudo tee /etc/sysctl.d/99-swap.conf && sudo sysctl --system
```

Firewall — **hanya 22, 80, 443**. Port 5432 dan 8080 tidak boleh terbuka ke
internet:

```bash
sudo ufw allow 22/tcp && sudo ufw allow 80/tcp && sudo ufw allow 443/tcp && sudo ufw --force enable
```

### Langkah 3 — Ambil kode

```bash
sudo mkdir -p /srv && sudo chown $USER:$USER /srv && git clone <url-repo-anda> /srv/dashboard-wa && cd /srv/dashboard-wa
```

Kalau repo belum di remote mana pun, kirim dari laptop dengan `rsync`/`scp` —
**tanpa** `node_modules/`, `.next/`, `.env`, dan `var/raw/`.

### Langkah 4 — Nyalakan Postgres + gateway

Di VPS pakai `docker-compose.yml` yang **biasa** (bukan `.wsl.yml`). Berkas itu
sudah menjalankan Postgres dan gateway sekaligus, dan sudah memasang
`ops/init-evolution-db.sql` yang membuat database `evolution` terpisah.

Buat `.env` dulu (isi lengkapnya di bagian 4 di bawah), lalu:

```bash
docker compose up -d && docker compose ps
```

Tunggu `db` berstatus `healthy`. Postgres di compose ini terikat ke
`127.0.0.1:5432` dan gateway ke `127.0.0.1:8080` — keduanya **tidak** terekspos
keluar. Itu disengaja, jangan diubah.

> Perhatikan: `docker-compose.yml` memakai `postgres:17-alpine`, sementara
> pengembangan memakai Postgres 18 di WSL. Tidak ada fitur 18 yang dipakai
> skema ini, jadi aman. Kalau mau seragam, ganti tag ke `postgres:18-alpine`
> **sebelum** `up -d` pertama — mengganti versi setelah volume terbentuk akan
> gagal start.

### Langkah 5 — Migrasi database

```bash
npm ci && npm run db:migrate
```

Migrasi sekarang sampai `0005_woozy_spiral`. Enam berkas di `drizzle/`, semua
harus terpakai.

**Jangan** `npm run db:seed` di produksi — itu membuat 4 akun contoh. Pakai:

```bash
npx tsx --conditions=react-server scripts/reset-total.ts --ya
```

Itu membuat dua akun: `leader` dan `sla`, sandi dari `SEED_PASSWORD`.
**Ganti sandi keduanya lewat Setelan → Agen & akses begitu bisa login.**

### Langkah 6 — Build & jalankan sebagai layanan

```bash
npm run build
```

Buat systemd unit supaya hidup lagi setelah reboot:

```bash
sudo tee /etc/systemd/system/dashboard-wa.service > /dev/null <<'EOF'
[Unit]
Description=Dispatch WhatsApp
After=network.target docker.service
Wants=docker.service

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/srv/dashboard-wa
EnvironmentFile=/srv/dashboard-wa/.env
Environment=NODE_ENV=production
Environment=PORT=3100
ExecStart=/srv/dashboard-wa/node_modules/.bin/next start -p 3100
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
```

Ganti `User=ubuntu` kalau nama penggunanya lain.

> **Kenapa memanggil `next` langsung, bukan `npm run start`.** Lewat npm ada
> proses npm yang ikut nongkrong seumur hidup layanan — terukur **71 MB** yang
> tidak mengerjakan apa pun. Di mesin 2 GB itu sayang. Bonusnya: PID yang
> dipegang systemd adalah server sungguhan, jadi `restart` dan `stop` bekerja
> pada proses yang benar.

Lalu:

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now dashboard-wa && sudo systemctl status dashboard-wa --no-pager
```

### Langkah 7 — Reverse proxy + HTTPS

Caddy, karena sertifikatnya otomatis dan diperpanjang sendiri:

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https && curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg && curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list && sudo apt update && sudo apt install -y caddy
```

```bash
sudo tee /etc/caddy/Caddyfile > /dev/null <<'EOF'
tiket.domain-anda.com {
	encode zstd gzip

	# SSE di /api/stream tidak boleh di-buffer, kalau di-buffer papan tiket
	# berhenti bergerak sendiri tanpa error apa pun.
	reverse_proxy 127.0.0.1:3100 {
		flush_interval -1
	}
}
EOF
```

Ganti `tiket.domain-anda.com` dengan domain asli, lalu:

```bash
sudo systemctl reload caddy && sudo caddy validate --config /etc/caddy/Caddyfile
```

> **`flush_interval -1` itu wajib.** Tanpa itu Caddy menahan respons SSE di
> buffer, dan `/api/stream` tidak pernah mengirim apa pun ke browser. Gejalanya
> menipu: tidak ada error, dashboard cuma tidak pernah memperbarui diri.

### Langkah 8 — Arahkan ulang webhook gateway

**Ini langkah yang paling sering terlupa, dan gejalanya adalah "tidak ada tiket
yang masuk sama sekali".**

Webhook sekarang menunjuk ke alamat WSL laptop
(`http://172.17.112.1:3100/...`). Alamat itu tidak ada artinya di VPS.

Karena gateway dan app ada di mesin yang sama, arahkan ke `localhost` —
lebih cepat dan tidak keluar-masuk internet. Di `docker-compose.yml` gateway
punya `host.docker.internal`, jadi dari dalam container:

```
WEBHOOK_TARGET=http://host.docker.internal:3100/api/webhook/evolution?token=<WEBHOOK_TOKEN>
```

`docker-compose.yml` sudah memasang `WEBHOOK_GLOBAL_URL` dari variabel itu, jadi
cukup benar di `.env` sebelum `docker compose up -d`.

**Tapi webhook per-instance menimpa yang global**, dan instance lama membawa
13 event yang sudah disetel manual. Kalau instance dipindahkan (bukan dibuat
baru), setel ulang eksplisit:

```bash
set -a; . /srv/dashboard-wa/.env; set +a; curl -s -X POST -H "apikey: $GATEWAY_API_KEY" -H "Content-Type: application/json" "$GATEWAY_URL/webhook/set/$GATEWAY_INSTANCE" -d "{\"webhook\":{\"enabled\":true,\"url\":\"$WEBHOOK_TARGET\",\"byEvents\":false,\"events\":[\"MESSAGES_UPSERT\",\"MESSAGES_UPDATE\",\"MESSAGES_EDITED\",\"MESSAGES_DELETE\",\"SEND_MESSAGE\",\"SEND_MESSAGE_UPDATE\",\"CONNECTION_UPDATE\",\"QRCODE_UPDATED\",\"GROUPS_UPSERT\",\"GROUP_UPDATE\",\"CONTACTS_SET\",\"CONTACTS_UPSERT\",\"CONTACTS_UPDATE\"]}}"
```

**`/webhook/set` mengganti seluruh konfigurasi, bukan menambah.** Ketiga belas
event itu harus ikut disebut semuanya. Kalau `CONTACTS_*` hilang, nama kontak
tersimpan tidak akan pernah masuk dan semua orang tampil sebagai nomor
(temuan 8 di STATUS). Kalau `SEND_MESSAGE` hilang, konfirmasi kirim tidak
pernah datang dan semua balasan terlihat "belum terkirim" selamanya.

Periksa hasilnya:

```bash
set -a; . /srv/dashboard-wa/.env; set +a; curl -s -H "apikey: $GATEWAY_API_KEY" "$GATEWAY_URL/webhook/find/$GATEWAY_INSTANCE"
```

### Langkah 9 — Sambungkan WhatsApp

Manager Evolution terikat ke `127.0.0.1:8080` dan **tidak boleh** dibuka ke
internet. Jangkau lewat SSH tunnel dari laptop:

```bash
ssh -L 8080:127.0.0.1:8080 ubuntu@<IP-VPS>
```

Sambil tunnel terbuka, buka `http://localhost:8080/manager` di browser laptop,
masuk dengan `GATEWAY_API_KEY`, buat instance bernama sama dengan
`GATEWAY_INSTANCE` (`whatsapp`), scan QR dengan nomor `6281234567890`.

Setelah tersambung, cek bahwa `WA_SELF_LID` di `.env` masih cocok — dibaca dari
payload `connection.update` field `me`. Kalau LID berubah, **seluruh pencocokan
identitas salah** dan tiket tidak akan pernah terbuat (§3.4). Cari di dump:

```bash
grep -o '"[0-9]*@lid"' /srv/dashboard-wa/var/raw/*.jsonl | sort | uniq -c | sort -rn | head
```

### Langkah 10 — Kunci akses (setelah terbukti jalan)

Baru setelah semua terbukti jalan, pasang pagar IP. **Urutannya penting** —
salah urutan, Anda mengunci diri sendiri.

Di `.env`:

```
ACCESS_PROXY_HOPS=1
ACCESS_IP_ALLOWLIST=203.0.113.10,203.0.113.0/24
```

> **`ACCESS_PROXY_HOPS=1` itu wajib di belakang Caddy.** Isi `0` (bawaan)
> dengan daftar IP terisi = **semua orang ditolak, termasuk Anda**. Itu
> disengaja: aplikasi memilih gagal ke arah tertutup daripada mempercayai
> header `X-Forwarded-For` yang bisa dikarang siapa pun. Lihat `ipKlien()` di
> `src/proxy.ts` dan `clientIp()` di `src/lib/auth.ts` — keduanya menghitung
> dari kanan sebanyak `hops`.

Kalau terlanjur terkunci: SSH ke VPS, kosongkan `ACCESS_IP_ALLOWLIST`,
`sudo systemctl restart dashboard-wa`.

> **Daftar ini juga menutup `/api/sehat`.** Di `src/proxy.ts` hanya
> `/api/webhook` yang dikecualikan dari pagar IP — `/api/sehat` tidak. Begitu
> daftar terisi, uptime monitor dari luar akan menerima **403** dan melapor
> "down" terus-menerus. Tiga jalan keluarnya, pilih satu:
>
> 1. **Monitor di dalam VPS** — cron memanggil `http://127.0.0.1:3100/api/sehat`
>    lalu mengabari lewat cara lain kalau gagal. Tidak memerlukan perubahan kode,
>    tapi tidak mendeteksi VPS-nya sendiri mati.
> 2. **Masukkan rentang IP monitor** ke `ACCESS_IP_ALLOWLIST`. Praktis hanya
>    kalau penyedia monitornya memberi daftar IP tetap yang pendek.
> 3. **Kecualikan `/api/sehat`** di `src/proxy.ts`, sejajar dengan
>    `/api/webhook`. Endpoint itu memang sudah dirancang tanpa auth dan tanpa
>    data sensitif — ia cuma menjawab hidup/mati. Ini perubahan kode, jadi
>    diputuskan sadar, bukan diam-diam.

> **Jangan pasang record AAAA (IPv6).** `ipMatches()` di `src/proxy.ts`
> hanya mengerti IPv4 untuk notasi CIDR — `toInt()` menuntut empat oktet.
> Pengunjung yang datang lewat IPv6 tidak akan pernah cocok dengan aturan
> `/24` mana pun dan langsung kena 403. Satu record A saja sudah cukup.

---

## 4. Daftar environment produksi

Yang **berubah** dari `.env` pengembangan:

| Variabel | Nilai produksi | Kenapa |
|---|---|---|
| `DATABASE_URL` | `postgresql://wa:<sandi>@localhost:5432/dashboard_wa` | Postgres dari compose, bukan WSL |
| `POSTGRES_PASSWORD` | **sandi baru, panjang** | yang lama sudah pernah ada di laptop |
| `AUTH_SECRET` | **nilai baru** | membocorkan ini = siapa pun bisa memalsukan sesi login |
| `GATEWAY_API_KEY` | **nilai baru** | |
| `GATEWAY_PUBLIC_URL` | `http://localhost:8080` | gateway tidak public; ini hanya dibaca Evolution sendiri |
| `WEBHOOK_TARGET` | `http://host.docker.internal:3100/api/webhook/evolution?token=<token>` | **bukan** IP WSL lagi |
| `WEBHOOK_TOKEN` | **wajib terisi** | tanpa ini route balas **503** di produksi (`src/app/api/webhook/[provider]/route.ts`) |
| `CRON_TOKEN` | **wajib terisi** | tanpa ini `/api/cron/tick` balas **503** di produksi |
| `FASE0_DUMP` | `on` selama 2–3 minggu pertama, lalu `off` | isinya percakapan klien; jangan disimpan selamanya tanpa alasan |
| `ACCESS_PROXY_HOPS` | `1` | ada Caddy di depan |
| `ACCESS_IP_ALLOWLIST` | IP kantor | kosongkan dulu sampai terbukti jalan |
| `SEED_PASSWORD` | sandi sementara | ganti lewat UI setelah login pertama |
| `INTERNAL_TICKER` | `on` | biarkan; systemd sudah menjaga prosesnya |
| `NODE_ENV` | `production` | disetel systemd, bukan di `.env` |

Yang **tetap sama**: `POSTGRES_USER`, `POSTGRES_DB`, `GATEWAY_PROVIDER`,
`GATEWAY_URL`, `GATEWAY_INSTANCE`, `WA_SELF_PN`, `WA_SELF_LID`.

Bikin rahasia baru:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

`.env` tidak pernah masuk git (sudah di `.gitignore`). Di VPS:

```bash
chmod 600 /srv/dashboard-wa/.env
```

---

## 5. Cek setelah hidup

Urut, jangan dilompati:

```bash
curl -s https://tiket.domain-anda.com/api/sehat
```

Harus `{"ok":true,"db":"up"}`. Kalau `503`, database tidak terjangkau — lihat
`sudo journalctl -u dashboard-wa -n 50`.

```bash
sudo journalctl -u dashboard-wa -n 30 --no-pager | grep detak
```

Harus ada `[detak] aktif tiap 10 detik`. Kalau tidak ada, `INTERNAL_TICKER`
ter-`off` dan **balasan agen tidak akan pernah terkirim**.

Lalu manual, dari HP:

1. Buka `https://tiket.domain-anda.com`, login sebagai `leader` → gembok
   hijau, tidak ada peringatan sertifikat
2. Setelan → **Grup**: aktifkan grup yang dipakai (bawaannya nonaktif)
3. Kirim pesan ke grup itu sambil menandai nomor gateway → **tiket harus muncul
   dalam beberapa detik tanpa refresh** (ini sekaligus menguji SSE dan
   `flush_interval -1`)
4. Ambil tiket, balas → tombol **Batalkan** muncul 5 detik → biarkan lewat →
   pesan sampai di grup, status jadi terkirim
5. Ulangi sekali lagi, tapi tekan **Batalkan** → pesan tidak boleh sampai
6. Ganti sandi `leader` dan `sla`

---

## 6. Backup

Database kecil (≈21 MB total), jadi tidak ada alasan tidak mem-backup.

```bash
sudo tee /usr/local/bin/backup-wa.sh > /dev/null <<'EOF'
#!/bin/bash
set -e
d=/srv/backup && mkdir -p "$d"
cd /srv/dashboard-wa
docker compose exec -T db pg_dump -U wa dashboard_wa | gzip > "$d/dashboard_wa-$(date +%F).sql.gz"
docker compose exec -T db pg_dump -U wa evolution     | gzip > "$d/evolution-$(date +%F).sql.gz"
find "$d" -name '*.sql.gz' -mtime +14 -delete
EOF
sudo chmod +x /usr/local/bin/backup-wa.sh
```

```bash
echo "17 3 * * * root /usr/local/bin/backup-wa.sh" | sudo tee /etc/cron.d/backup-wa
```

**Database `evolution` ikut di-backup, dan itu bukan kelebihan.** Di situlah
kredensial sesi WhatsApp disimpan (`DATABASE_SAVE_DATA_INSTANCE: "true"`).
Tanpa itu, memulihkan server berarti scan QR ulang.

Salin hasilnya ke luar VPS secara berkala. Backup yang hanya ada di mesin yang
sama tidak menolong saat mesin itu yang hilang.

---

## 7. Pemantauan

Pasang uptime monitor gratis (UptimeRobot / BetterStack) ke:

```
https://tiket.domain-anda.com/api/sehat
```

Endpoint itu sengaja tanpa auth dan tanpa data sensitif — ia hanya menjawab
hidup/mati. **Ini pengganti satu-satunya untuk alarm yang belum jalan.**

Tapi baca dulu peringatan di Langkah 10: begitu `ACCESS_IP_ALLOWLIST` terisi,
monitor dari luar kena 403. Selesaikan itu dulu, kalau tidak monitornya justru
jadi sumber alarm palsu — dan alarm palsu yang berulang lebih buruk daripada
tidak ada alarm, karena orang berhenti membacanya.

---

## 8. Kalau ada yang salah

| Gejala | Kemungkinan besar |
|---|---|
| Tidak ada tiket masuk sama sekali | `WEBHOOK_TARGET` masih menunjuk alamat lama → Langkah 8. Cek `docker compose logs gateway \| tail -50`. |
| Semua orang tampil sebagai nomor | event `CONTACTS_*` tidak terdaftar di webhook → Langkah 8 |
| Balasan selalu "belum terkirim" | event `SEND_MESSAGE` tidak terdaftar → Langkah 8 |
| Balasan mengendap, tidak pernah terbang | `INTERNAL_TICKER=off` tanpa cron pengganti → cek log `[detak]` |
| Papan tiket tidak bergerak sendiri | `flush_interval -1` hilang dari Caddyfile → Langkah 7 |
| Semua orang kena 403 | `ACCESS_IP_ALLOWLIST` terisi tapi `ACCESS_PROXY_HOPS=0` → Langkah 10 |
| Uptime monitor melapor "down" padahal dashboard normal | `/api/sehat` ikut kena pagar IP → Langkah 10 |
| Sebagian orang kena 403, sebagian tidak | mereka datang lewat IPv6 → Langkah 10 |
| Webhook balas 503 | `WEBHOOK_TOKEN` kosong di produksi |
| `next build` mati sendiri / "Killed" | RAM habis — pasang swap 2 GB (Langkah 2) atau build di laptop |
| Gateway/Postgres tiba-tiba mati saat memperbarui | OOM killer memilih korban lain saat build — sama, pasang swap |
| `/api/cron/tick` balas 503 | `CRON_TOKEN` kosong di produksi |
| Login berhasil lalu dilempar balik ke `/masuk` | cookie `secure` butuh HTTPS asli — pastikan diakses lewat `https://`, bukan IP mentah |
| Tiket tidak terbuat padahal ditandai | `WA_SELF_LID` tidak cocok setelah scan QR ulang → Langkah 9 |

Log:

```bash
sudo journalctl -u dashboard-wa -f
```

```bash
cd /srv/dashboard-wa && docker compose logs -f gateway
```

---

## 9. Cara memperbarui nanti

```bash
cd /srv/dashboard-wa && git pull && npm ci && npm run db:migrate && npm run build && sudo systemctl restart dashboard-wa
```

**Container tidak ikut di-restart, dan itu disengaja** (SPEC §2). Sesi WhatsApp
tidak boleh putus tiap kali kode diperbarui.

Kalau menyentuh berkas query, jalankan `npm run smoke` **sebelum** deploy —
`npm run typecheck` tidak menangkap bug query.
