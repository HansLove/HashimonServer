//ADN Hashiano — the server's copy of the client's HashimonDNA, kept faithful so
//a creature's identity recomputes identically on either side. A Hashimon's DNA is
//bound to its proof of work: the same template + birth nonce + species always
//yields the same 64-hex genome, on any machine, forever.
import { sha256 } from "./sha256";

export const Dna = {
  derive(templateId: string | number, birthNonce: string | number, speciesKey = ""): string {
    return sha256(`${templateId}:${birthNonce}:${speciesKey}`);
  },

  //The whitepaper indexes DNA from 1: [1] is the first nibble, [64] the last.
  at(dna: string, position: number): number {
    return parseInt(dna[position - 1]!, 16);
  },

  //A window of consecutive nibbles as one integer.
  window(dna: string, position: number, length: number): number {
    return parseInt(dna.slice(position - 1, position - 1 + length), 16);
  },

  //Scale a window into [min, max].
  range(dna: string, position: number, length: number, min: number, max: number): number {
    const span = Math.pow(16, length);
    return min + (this.window(dna, position, length) / span) * (max - min);
  },

  isEven(dna: string, position: number): boolean {
    return this.at(dna, position) % 2 === 0;
  },

  modulo(dna: string, position: number, n: number): number {
    return this.at(dna, position) % n;
  },

  //Pick from a list by scaling a window across it (finer than a raw modulo when
  //the list length is not a power of two).
  pick<T>(dna: string, position: number, length: number, list: readonly T[]): T {
    const span = Math.pow(16, length);
    const i = Math.floor((this.window(dna, position, length) / span) * list.length);
    return list[Math.min(list.length - 1, i)]!;
  },

  //Leading zero hex nibbles of a hash — difficulty made visible.
  leadingZeros(hash: string): number {
    let n = 0;
    while (n < hash.length && hash[n] === "0") { n++; }
    return n;
  },
};
