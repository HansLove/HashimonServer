import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MEMORY_PROFILE, TEMPERAMENTS, buildSystemPrompt, temperamentOf, wellbeingOf,
} from "@/domain/companion";

const HOUR = 3_600_000;
function ago(hours: number) { return new Date(Date.now() - hours * HOUR); }
function rowAll(hours: number) {
  return { fed_at: ago(hours), talked_at: ago(hours), mined_at: ago(hours), world_at: ago(hours), last_sector: null };
}

test("wellbeing is the MINIMUM of the four cares, never the average", () => {
  //Un animal con hambre está mal aunque lo saques a pasear. Con promedio, el
  //jugador compensaría la carencia difícil con la fácil y no atendería nunca lo
  //que falta de verdad.
  const row = { ...rowAll(0), fed_at: ago(28) }; //hambre casi a cero, el resto llenos
  const w = wellbeingOf(row);
  assert.ok(w.care.hunger < 10, `hambre debería estar casi vacía: ${w.care.hunger}`);
  assert.equal(w.overall, w.care.hunger, "el bienestar debe seguir al peor cuidado");
  assert.ok(w.overall < 50, "el promedio habría dado >70 y ocultado el hambre");
});

test("the want always names the lowest care", () => {
  const row = { ...rowAll(0), world_at: ago(330) };
  const w = wellbeingOf(row);
  assert.equal(w.want?.kind, "world");
});

test("a cared-for companion wants nothing", () => {
  const w = wellbeingOf(rowAll(0));
  assert.equal(w.overall, 100);
  assert.equal(w.want, null, "un compañero que siempre exige cansa");
});

test("memory capacity follows temperament, and aloof remembers least", () => {
  for (const t of TEMPERAMENTS) {
    assert.ok(MEMORY_PROFILE[t], `falta perfil de memoria para ${t}`);
    assert.ok(MEMORY_PROFILE[t].capacity >= 2);
  }
  assert.equal(MEMORY_PROFILE.aloof.capacity, 2, "el aloof recuerda poco: es su carácter");
  assert.ok(MEMORY_PROFILE.curious.capacity > MEMORY_PROFILE.aggressive.capacity);
});

test("temperament is derived from nibble [47] and is stable", () => {
  const dna = "7e28a75eb22969289e885969b089bd3025e2a8b4a578405fceaae177ea321278";
  const first = temperamentOf(dna);
  for (let i = 0; i < 100; i++) assert.equal(temperamentOf(dna), first);
  assert.ok(TEMPERAMENTS.includes(first));
});

test("the prompt never offers services", () => {
  //La queja original: la criatura respondía como una IA y cerraba con
  //"¿quieres que...?". La prohibición tiene que estar escrita, no implícita.
  const p = buildSystemPrompt({
    name: "Petunia",
    dna: "7e28a75eb22969289e885969b089bd3025e2a8b4a578405fceaae177ea321278",
    spirit: "guardian", element: "fuego", stage: 4,
    wellbeing: wellbeingOf(rowAll(0)), keepsakes: [],
  });
  assert.match(p, /NUNCA te ofrezcas a hacer tareas/);
  assert.match(p, /No eres un asistente/);
  assert.doesNotMatch(p, /compañero de trabajo/, "ese encuadre era la causa del problema");
  assert.doesNotMatch(p, /ayudas con código/);
});

test("the same DNA always produces the same prompt", () => {
  const input = {
    name: "Petunia",
    dna: "7e28a75eb22969289e885969b089bd3025e2a8b4a578405fceaae177ea321278",
    spirit: "guardian" as const, element: "fuego", stage: 4,
    wellbeing: wellbeingOf(rowAll(0)), keepsakes: ["Te vi minar toda la noche."],
  };
  assert.equal(buildSystemPrompt(input), buildSystemPrompt(input));
});

test("a hungry companion asks, and the ask carries no numbers", () => {
  const w = wellbeingOf({ ...rowAll(0), fed_at: ago(29) });
  const p = buildSystemPrompt({
    name: "Petunia", dna: "7e28a75eb22969289e885969b089bd3025e2a8b4a578405fceaae177ea321278",
    spirit: "guardian", element: "fuego", stage: 4, wellbeing: w, keepsakes: [],
  });
  assert.match(p, /Lo que quieres ahora/);
  assert.match(p, /Tienes hambre/);
  //El bienestar es del sistema, no del personaje: nunca aparece como número.
  assert.doesNotMatch(p, new RegExp(`bienestar[^\\n]*${w.overall}`));
});
