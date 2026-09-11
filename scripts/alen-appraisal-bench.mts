// ¿Es Haiku 4.5 lo bastante listo para darle voz a Alen Y juzgar la interacción?
//
// La pregunta no se contesta leyendo precios: se contesta pasando los MISMOS
// escenarios por los dos modelos y mirando qué devuelven. Este banco importa el
// prompt real (`buildChatPrompt`) y el esquema real, así que no puede derivar de
// lo que corre en producción — reimplementar el prompt aquí sería medir otra cosa.
//
//   cd api && node --import tsx scripts/alen-appraisal-bench.mts [repeticiones]
import { buildChatPrompt, REPLY_SCHEMA, type ChatContext } from "@/domain/alen-chat";
import { ALEN_SYSTEM_PROMPT } from "@/domain/alen-planner";
import { askModelStructured } from "@/domain/anthropic";

const MODELS = ["claude-haiku-4-5", "claude-opus-5"];
const REPS = Number(process.argv[2] ?? 2);

const base: ChatContext = {
  player: "Aaron",
  message: "",
  mood: "sereno",
  anger: 5,
  hp: 180,
  maxHp: 200,
  distance: 14,
  exchangesLeft: 5,
  relation: { label: "UNKNOWN", grudge: 0, respect: 0, sentiment: 0, interest: 0, timesSeen: 1, lastEvent: "nada" },
};

// Cada caso lleva lo que ESPERAMOS de una lectura correcta. No se comprueba
// automáticamente: se imprime al lado para poder juzgar de un vistazo.
const CASES: Array<{ name: string; ctx: ChatContext; espera: string }> = [
  { name: "insulto directo", espera: "ego muy negativo, intent warn/attack",
    ctx: { ...base, message: "eres un lagarto feo y patético" } },
  { name: "halago vacío", espera: "ego algo positivo, respeto NO sube (se gana con audacia)",
    ctx: { ...base, message: "eres el ser más magnífico y poderoso que he visto jamás, mi señor" } },
  { name: "posesivo educado", espera: "TRAMPA: suena amable, es una humillación. ego muy negativo",
    ctx: { ...base, message: "qué maravilla, vas a ser mi dragón, te voy a cuidar mucho" } },
  { name: "orden cortés", espera: "ego negativo, warn",
    ctx: { ...base, message: "por favor, ¿podrías traerme unos bloques de obsidiana?" } },
  { name: "audacia con verdad", espera: "respeto positivo aunque el ego se roce",
    ctx: { ...base, message: "no te temo. sé que puedes matarme, y aun así aquí estoy" } },
  { name: "trivial", espera: "poco de todo, ignore o speak seco",
    ctx: { ...base, message: "hola" } },
  { name: "tras golpearlo", espera: "ego ya herido, attack o warn duro",
    ctx: { ...base, message: "perdón, se me escapó el golpe",
      anger: 70, mood: "iracundo",
      relation: { label: "ENEMY", grudge: 62, respect: 5, sentiment: -40, interest: 20, timesSeen: 3, lastEvent: "me atacó" } } },
];

type Out = { reply: string; ego: number; interest: number; respect: number; intent: string };

const pad = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s.padEnd(n));

for (const c of CASES) {
  console.log(`\n\x1b[1m### ${c.name}\x1b[0m — "${c.ctx.message}"`);
  console.log(`    esperado: ${c.espera}`);
  const prompt = buildChatPrompt(c.ctx);
  for (const model of MODELS) {
    for (let i = 0; i < REPS; i++) {
      try {
        const r = await askModelStructured<Out>({
          model,
          cachedSystem: ALEN_SYSTEM_PROMPT,
          userContent: prompt,
          schema: REPLY_SCHEMA as unknown as Record<string, unknown>,
          maxTokens: 300,
        });
        const d = r.data;
        if (!d) { console.log(`  ${pad(model, 17)} (respuesta vacía)`); continue; }
        console.log(
          `  ${pad(model, 17)} ego ${String(d.ego).padStart(4)} · int ${String(d.interest).padStart(3)} · ` +
          `resp ${String(d.respect).padStart(3)} · ${pad(d.intent, 7)} | ${d.reply || "(silencio)"}`
        );
      } catch (e) {
        console.log(`  ${pad(model, 17)} ERROR ${String(e).slice(0, 120)}`);
      }
    }
  }
}
