import { evolutionAdapter } from "./evolution";
import { wahaAdapter } from "./waha";
import type { GatewayAdapter } from "./types";

export * from "./types";

/**
 * Pilih wrapper lewat GATEWAY_PROVIDER. Default Evolution API.
 *
 * Alasan lapisan ini ada (SPEC section 2.1): perbaikan bug LID datang dari upstream.
 * Kalau ternyata wrapper yang satu menangani LID lebih baik, pindah cukup ganti
 * satu variabel environment - tidak ada kode ingestion, tiket, atau UI yang
 * ikut berubah.
 */
export function gateway(): GatewayAdapter {
  const provider = (process.env.GATEWAY_PROVIDER ?? "evolution").toLowerCase();
  switch (provider) {
    case "waha":
      return wahaAdapter;
    case "evolution":
      return evolutionAdapter;
    default:
      throw new Error(`GATEWAY_PROVIDER tidak dikenal: ${provider} (pilih "evolution" atau "waha")`);
  }
}
