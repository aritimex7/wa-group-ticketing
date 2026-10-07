"use server";

import { revalidatePath } from "next/cache";
import { requireLeader } from "@/lib/auth";
import { tandaiDibaca, tandaiSemuaDibaca } from "@/lib/notifications";

function segarkan() {
  revalidatePath("/leader");
  revalidatePath("/setelan", "layout");
  revalidatePath("/");
}

export async function aksiTandaiDibaca(fd: FormData): Promise<void> {
  await requireLeader();
  const id = Number(fd.get("id"));
  if (Number.isInteger(id)) await tandaiDibaca(id);
  segarkan();
}

export async function aksiTandaiSemuaDibaca(): Promise<void> {
  await requireLeader();
  await tandaiSemuaDibaca();
  segarkan();
}
