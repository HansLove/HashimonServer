import { SPIRITS, type SpiritKey } from "@/core/birth-identity";

//El signo va dentro de la speciesKey Genesis V2 (g2_<signo>_<elemento>). Una
//criatura V1 no lo tiene, y eso es correcto: el prompt lo omite.
export function spiritOfSpeciesKeyOrNull(speciesKey: string | null | undefined): SpiritKey | null {
  const m = /^g2_([a-z]+)_/.exec(speciesKey ?? "");
  if (!m) return null;
  const key = m[1] as SpiritKey;
  return SPIRITS.some((s) => s.key === key) ? key : null;
}

//El elemento también vive en la clave. Se devuelve con la ortografía interna
//(con acento en "eléctrico"), que es la que el resto del sistema usa.
export function elementOfSpeciesKey(speciesKey: string | null | undefined): string | null {
  const m = /^g2_[a-z]+_([a-z]+)$/.exec(speciesKey ?? "");
  if (!m) return null;
  return m[1] === "electrico" ? "eléctrico" : m[1]!;
}
