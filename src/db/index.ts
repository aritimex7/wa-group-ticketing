import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export { schema };
export * from "./schema";

type Db = ReturnType<typeof drizzle<typeof schema>>;

const g = globalThis as unknown as { __waSql?: postgres.Sql; __waDb?: Db };

function connectionString(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL belum diisi. Salin .env.example ke .env lalu isi koneksi Postgres.",
    );
  }
  return url;
}

/**
 * Koneksi dibuat malas (lazy) supaya `next build` tidak gagal hanya karena
 * DATABASE_URL belum ada di mesin build.
 */
export function getSql(): postgres.Sql {
  if (!g.__waSql) {
    g.__waSql = postgres(connectionString(), {
      max: 10,
      idle_timeout: 30,
      // Kolom timestamptz dikembalikan sebagai Date oleh postgres.js secara default.
      onnotice: () => {},
    });
  }
  return g.__waSql;
}

export function getDb(): Db {
  if (!g.__waDb) g.__waDb = drizzle(getSql(), { schema });
  return g.__waDb;
}

/** Ergonomi: `db.select()...` tanpa harus memanggil getDb() di tiap berkas. */
export const db = new Proxy({} as Db, {
  get(_target, prop, receiver) {
    return Reflect.get(getDb() as object, prop, receiver);
  },
});

/**
 * Bungkus timestamp untuk dipakai DI DALAM template `sql`.
 *
 * Jebakan yang sudah memakan korban sekali di proyek ini: objek Date yang
 * diinterpolasi langsung ke template `sql` GAGAL saat dieksekusi -
 * "The string argument must be of type string ... Received an instance of Date".
 * postgres.js tidak menyimpulkan tipe parameter di jalur query mentah, jadi
 * objek Date-nya sampai ke penulis protokol apa adanya.
 *
 * Yang TIDAK kena: operator kolom drizzle biasa (eq, gte, lt, ...) dan
 * .values() - di sana tipenya diketahui dari skema.
 *
 * Aturannya: setiap Date yang masuk ke template `sql` HARUS lewat ts().
 */
export function ts(d: Date) {
  return sql`${d.toISOString()}::timestamptz`;
}
