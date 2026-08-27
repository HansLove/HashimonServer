# Pack handoff: compilador ADN + prompts → imagen → Meshy

**Audiencia:** backend / pipeline 3D  
**Fecha:** 2026-08-27  
**Estado:** el prompt **ya existe en el portal**; **no** está expuesto en la API ni conectado a Meshy.

---

## 1. Aclaración del hueco (importante)

Tu observación es correcta: **en el servidor API no hay lógica de generación de prompts ni llamada a Meshy**.

| Capa | ¿Existe? | Dónde |
|------|----------|--------|
| ADN → look (compilador) | Sí | Portal + puerto Lua |
| Look → prompt de imagen | Sí | **Solo portal** |
| Prompt → image API | No | Pieza faltante |
| Image → Meshy GLB | No | Pieza faltante |
| GLB → Luanti | Parcial | Script + mod de integración |

```text
ADN → compile() → HashimonLook → generatePrompt() → [FALTA] image → [FALTA] Meshy → GLB → Luanti
                      ▲                    ▲
                 compiler.ts        prompt-generator.ts
                 (portal)              (portal)
```

**No hay un “system prompt” suelto aparte.** El texto se arma de forma **determinista** desde `HashimonLook` en `generatePrompt(...)`. Misma ADN + especie + stage + style ⇒ mismo prompt.

---

## 2. Papers / docs (leer en este orden)

| # | Archivo | Para qué |
|---|---------|----------|
| 1 | [`api/docs/ADN_PROPIEDAD_TEORIA_DE_JUEGO.md`](./ADN_PROPIEDAD_TEORIA_DE_JUEGO.md) | **Fuente de verdad** — fórmula Genesis, propiedad, 16 tipos, lo verificado contra código |
| 2 | [`docs/HASHIMON_ADN_Y_EVOLUCION.md`](./HASHIMON_ADN_Y_EVOLUCION.md) | Guía ADN: capa genética vs PoW; el compilador produce prompt / value sheet estable |
| 3 | [`docs/HASHIMON_GENERACION_Y_TIPOS.md`](./HASHIMON_GENERACION_Y_TIPOS.md) | Paper técnico generación / tipos / prompts — **leer aviso de obsolescencia al inicio** |
| 4 | [`docs/HASHIMON_MORPHOLOGY_COMPILER_PLAN.md`](./HASHIMON_MORPHOLOGY_COMPILER_PLAN.md) | Morphology en Luanti (bodies Creatura); **no** es el pipeline Meshy |

Copia espejo en API (mismo contenido donde aplica):

- [`api/docs/HASHIMON_ADN_Y_EVOLUCION.md`](./HASHIMON_ADN_Y_EVOLUCION.md)
- [`api/docs/HASHIMON_GENERACION_Y_TIPOS.md`](./HASHIMON_GENERACION_Y_TIPOS.md)
- [`api/docs/HASHIMON_MORPHOLOGY_COMPILER_PLAN.md`](./HASHIMON_MORPHOLOGY_COMPILER_PLAN.md)

---

## 3. Código a reutilizar / portar

### Obligatorio para prompts

| Archivo | Rol |
|---------|-----|
| [`encubation-website/src/lib/compiler.ts`](../../encubation-website/src/lib/compiler.ts) | `compile()` — ADN + especie → `HashimonLook` |
| [`encubation-website/src/lib/prompt-generator.ts`](../../encubation-website/src/lib/prompt-generator.ts) | `generatePrompt(dna, look, speciesKey, style, stage)` — estilos: `illustration` \| `pixel-art` \| `card` |
| [`encubation-website/src/components/egg-preview.tsx`](../../encubation-website/src/components/egg-preview.tsx) | UI de referencia que ya copia / muestra el prompt |

### Relacionado (no genera el prompt)

| Archivo | Rol |
|---------|-----|
| [`api/src/core/dna.ts`](../src/core/dna.ts) | Helpers ADN en API |
| [`3d-world/mods/hashimon_core/dna_compiler.lua`](../../3d-world/mods/hashimon_core/dna_compiler.lua) | Puerto visual Luanti (look parcial) |
| [`scripts/meshyai-to-luanti.ts`](../../scripts/meshyai-to-luanti.ts) | Post-proceso GLB → mod Luanti |
| [`3d-world/mods/hashimon_meshy_integration/`](../../3d-world/mods/hashimon_meshy_integration/) | Registra `meshy_*` GLB ya existentes |

---

## 4. Firma de referencia del generador

```typescript
// encubation-website/src/lib/prompt-generator.ts
generatePrompt(
  dna: string,
  look: HashimonLook,
  speciesKey: string,
  style: "illustration" | "pixel-art" | "card" = "illustration",
  stage: number = 1
): PromptOutput  // { text, colors, style }
```

Entrada típica: criatura del roster (ADN + `speciesKey` + stage PoW) → `compile()` → `generatePrompt()`.

---

## 5. Pieza a construir en servidor (siguiente sprint sugerido)

1. Portar o compartir `compiler` + `prompt-generator` hacia `api/` (o un worker).
2. Endpoint ejemplo: `GET /creatures/:id/prompt?style=illustration` → `{ text, colors, style }`.
3. Después: cola imagen → Meshy → publicar GLB / media registry.

Hasta (1)+(2) no hace falta inventar un system prompt nuevo: **reutilizar el del portal**.

---

## 6. Mensaje corto (copiar/pegar)

```text
Buenos días — tienes razón: la API hoy no genera prompts ni llama a Meshy.

Lo que sí existe:
1) Compilador ADN → look: encubation-website/src/lib/compiler.ts
2) Prompt de imagen (illustration / pixel-art / card):
   encubation-website/src/lib/prompt-generator.ts → generatePrompt(...)
3) Docs canónicos:
   - api/docs/ADN_PROPIEDAD_TEORIA_DE_JUEGO.md
   - docs/HASHIMON_ADN_Y_EVOLUCION.md
   - docs/HASHIMON_GENERACION_Y_TIPOS.md (histórico + prompts conceptuales)
   - Pack consolidado: docs/DEV_HANDOFF_ADN_PROMPTS_MESHY.md

Pieza faltante a construir en servidor:
  roster/creature → compile look → generatePrompt → (image API) → Meshy → GLB
  (el cliente ya tiene compile + generatePrompt; hay que portarlos o exponerlos en API)

No hay un “system prompt” separado aparte del generador; el prompt se arma
determinísticamente desde HashimonLook.
```
