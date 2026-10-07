-- Evolution API menyimpan datanya sendiri (termasuk kredensial sesi WhatsApp)
-- di database terpisah pada instance Postgres yang sama.
--
-- Dipisah, bukan digabung ke dashboard_wa, karena dua alasan:
--   1. skema Evolution ikut berubah tiap kali versinya naik; kalau bercampur,
--      migrasi kita dan migrasi mereka saling menimpa
--   2. saat memulihkan backup dashboard, kita tidak sengaja ikut menimpa
--      kredensial sesi - yang berarti scan QR ulang tanpa perlu
SELECT 'CREATE DATABASE evolution'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'evolution')\gexec
