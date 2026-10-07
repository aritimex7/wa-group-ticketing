/**
 * /setelan tidak punya isi sendiri - ia mengarahkan ke tab pertama.
 *
 * Tautan lama ke "/setelan" masih banyak (nav utama, notifikasi, dokumen), jadi
 * rutenya dipertahankan alih-alih dihapus: yang berubah cuma tujuannya.
 */
import { redirect } from "next/navigation";

export default function SetelanIndex() {
  redirect("/setelan/koneksi");
}
