//The Caos Core: the versioned, deterministic ruleset the ADR (D3) requires both
//client and server to run. The server imports it to VERIFY; the browser runs an
//equivalent copy to PLAY. Keeping this the single source of truth for the rules
//is what lets the server referee without being trusted.
export * from "./sha256";
export * from "./dna";
export * from "./pow";

//Bumped whenever the rules that shape or score a creature change. Stamped on every
//birth so a creature always records which ruleset produced it.
export const CORE_VERSION = "caos-core@1";
