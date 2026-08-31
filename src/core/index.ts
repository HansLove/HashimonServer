//The Caos Core: the versioned, deterministic ruleset the ADR (D3) requires both
//client and server to run. The server imports it to VERIFY; the browser runs an
//equivalent copy to PLAY. Keeping this the single source of truth for the rules
//is what lets the server referee without being trusted.
export * from "@/core/sha256";
export * from "@/core/dna";
export * from "@/core/birth-identity";
export * from "@/core/pow";

//Bumped whenever the rules that shape or score a creature change. Stamped on every
//birth so a creature always records which ruleset produced it.
//caos-core@2: Birth Identity V2. La fecha de nacimiento fija espíritu,
//número de vida, elemento y especie; el servidor sólo individualiza. Las
//criaturas @1 conservan su versión en la fila — su DNA y su PoW siguen
//verificando bajo las reglas que las produjeron.
export const CORE_VERSION = "caos-core@2";
