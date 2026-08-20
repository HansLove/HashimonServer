# ADN, Propiedad y Teoría de Juego — documento de referencia para el equipo

**Estado:** documentación del sistema **tal como está implementado hoy**, verificado línea por línea contra el código real (`api/src/`, `encubation-website/src/lib/`, `3d-world/mods/`), no contra el whitepaper ni la memoria del proyecto. Este archivo se perdió al mover `docs/` dentro de `api/docs/` el 2026-08-20 y fue reconstruido el mismo día — si encuentras otra copia con contenido divergente, esta es la vigente.

**Audiencia:** equipo de desarrollo (backend, Luanti, portal).

Relacionados: [`HASHIMON_GENERACION_Y_TIPOS.md`](./HASHIMON_GENERACION_Y_TIPOS.md) *(nota: partes de ese documento describen un cliente `game/Content/*.js` que ya no existe en el repo — ver aviso al inicio de ese archivo)* · [`POW_SPEC.md`](./POW_SPEC.md) · [`HASHIMON-RABBIT-POW.md`](./HASHIMON-RABBIT-POW.md)

---

## 0. Resumen ejecutivo

1. **El ADN no es un hash arbitrario metido en un OP_RETURN.** Para Genesis, es el resultado determinista de `SHA256(ownerPublicKey : speciesKey : birthday)` — ver §6 (fórmula decidida y ya vigente para este tipo de nacimiento).
2. **La propiedad de un Hashimon NO se prueba recomputando el hash con tu llave pública.** La llave pública se guarda pero **nunca se verifica criptográficamente** en ningún punto del código. La propiedad es un registro en base de datos (`owner_id`) protegido por sesión con contraseña (bearer token) — el mismo modelo que un login web normal.
3. El ataque "copiar el hash de un Hashimon ajeno" **está descartado**, pero no por el mecanismo intuitivo de "yo puedo llegar a ese hash con mi llave". Está descartado por dos garantías estructurales distintas: (a) el cliente nunca puede elegir el valor de `dna` al crear una fila, y (b) `dna` es `UNIQUE` en la base de datos.
4. El sistema tiene **dos tipos de nacimiento** con requisitos de diseño distintos: **Genesis** (elegido por el jugador, determinista, sin necesidad de anti-grind) y **Natural** (sembrado por un bloque de Bitcoin real en checkpoints administrativos — diseño pendiente, ver §6.5).
5. **Tipo elemental y arquetipo (cuerpo) son ejes independientes**, verificado contra código — ver §7. No existe ni puede existir hoy una regla tipo "eléctrico = roedor"; si ves esa regla en algún archivo, es código muerto de un catálogo viejo (corregido el 2026-08-20, ver §7.2).

---

## 1. La fórmula exacta del ADN

### 1.1 Genesis (vigente)

```typescript
// encubation-website/src/lib/compiler.ts — compile()
const primaryType = species.type || DNA.pick(dna, 1, 2, TYPES);
```

```
ADN_Genesis = SHA256( ownerPublicKey : speciesKey : birthday )
```

`birthday` es opcional — si el jugador no lo da, se usa `""` fija: `SHA256(ownerPublicKey:speciesKey:"")`.

### 1.2 Fórmula anterior (histórica, aún visible en `api/src/core/dna.ts`)

```typescript
export const Dna = {
  derive(templateId: string | number, birthNonce: string | number, speciesKey = ""): string {
    return sha256(`${templateId}:${birthNonce}:${speciesKey}`);
  },
};
```

```
ADN = SHA256( templateId : birthNonce : speciesKey ), birthNonce = randomBytes(8) del servidor
```

Nota lo que **no** entra en ninguna de las dos fórmulas: la firma del dueño. El ADN es una función pura — cualquiera que tenga los inputs puede recomputar el mismo ADN en cualquier máquina. Esa es la garantía de **verificabilidad** (cualquiera puede confirmar que un ADN es consistente con su origen), pero **no** es, por sí sola, una garantía de **propiedad** (de quién es la criatura).

---

## 2. Qué NO es el ADN (para descartar bien la confusión)

- No prueba propiedad — no incluye ninguna firma ni challenge-response contra la llave pública.
- No se guarda el "look" derivado (tipo, color, arquetipo, stats escalados) en PostgreSQL — se recomputa on-demand desde `dna` + `speciesKey` cada vez que se muestra. Comentario explícito en `api/src/db/schema.sql`: *"Stats and look are NOT stored: they are derived from dna + pow by the Caos Core."*
- No es una lotería competitiva para Genesis — el poder real viene de PoW (`×1.18^stage`), no de la tirada de ADN.

---

## 3. El escenario de ataque, descartado paso a paso

Tres vectores concretos, cada uno bloqueado por un mecanismo distinto al que la intuición sugiere:

1. **Registrar una fila nueva con un ADN copiado** → bloqueado: la API nunca acepta `dna` provisto por el cliente; aunque colisionara, la restricción `UNIQUE` en `hashimons.dna` lo rechaza.
2. **Enviar shares de minería como si fueras el dueño de un Hashimon ajeno** → bloqueado por autorización de sesión/`owner_id`, no por criptografía sobre el hash.
3. **Reclamar propiedad verbalmente por conocer el ADN** → bloqueado porque no existe endpoint de reclamo; la propiedad se fija una sola vez, al emitir, según quién estaba autenticado.

---

## 4. Teoría de juego: incentivos y por qué el sistema aguanta igual

El principio "árbitro, no oráculo" del proyecto (cualquiera puede recomputar y confirmar de forma independiente al servidor) **se cumple** para ADN y PoW — pero **no se cumple** para "quién es dueño de esta fila", que hoy es 100% confianza en la base de datos del servidor, igual que cualquier sistema de cuentas web normal. Es una brecha real y documentada, no un bug — solo necesita ser una decisión **consciente**, no accidental (ver decisión pendiente en `memory/hashimon_ownership_gap.md`, opciones A/B no resueltas).

---

## 5. La decisión de propiedad — pendiente

Dos opciones sobre la mesa, ninguna implementada:

- **Opción A (status quo):** propiedad = cuenta autenticada, basada en ledger. Ya funciona, cero trabajo nuevo, pero más débil que el resto del discurso "verificable sin confianza".
- **Opción B (cerrar la brecha):** firma challenge-response contra `public_key`, o atar la llave pública al ADN desde el nacimiento (rompe el formato actual, requiere `algo_version`).

**Estado:** flagged para el equipo, sin resolver. No asumir ninguna de las dos si se trabaja en propiedad/seguridad más adelante — confirmar primero.

---

## 6. Dos tipos de nacimiento — Genesis vs. Natural

| | **Genesis** | **Natural** |
|---|---|---|
| Quién lo origina | El jugador, deliberadamente | Un bloque de Bitcoin real, en checkpoints administrativos |
| Propósito | Identidad personal, elegida con intención | Escasez real, entropía externa verdadera |
| ¿Necesita anti-grind? | **No** — no es una lotería, es una decisión | **Sí** — aquí vive la protección contra manipulación |
| Estado de diseño | **Resuelto** (esta sección) | **Pendiente** — no diseñado aún |

### 6.1 Qué no gustaba del diseño anterior (solo aplicaba a Genesis)

- `templateId` en la fórmula — confirmado innecesario: `compile()` nunca lo recibe como parámetro; solo usa `dna`, `speciesKey` y `stage`.
- `birthNonce` generado por el servidor — el jugador no podía reproducir ni predecir su propio Hashimon antes de nacer. Para Natural esto es la protección deseada; para Genesis, era una restricción sin propósito.

### 6.2 Fórmula decidida para Genesis

```
ADN_Genesis = SHA256( ownerPublicKey : speciesKey : birthday )
```

- `ownerPublicKey` — siempre existe al momento de emisión (autocustodia o generada por el servidor, ver `players.ts` `registerOwner()`).
- `speciesKey` — el tipo elegido (ej. `genesis_fuego`).
- `birthday` — opcional; `""` fija si se omite.

**Sin riesgo de colisión:** `players.public_key` ya es `UNIQUE`, y ya existe la regla de un solo Genesis (`starter`) por jugador.

### 6.3 El trade-off, dicho en voz alta

Sin nonce de servidor, un jugador puede "probar" combinaciones (llaves desechables, cumpleaños auto-declarados) antes de registrarse. Aceptable porque (1) el poder real viene de minar, no del ADN, y (2) Genesis no pretende ser una lotería justa — esa responsabilidad es de Natural.

### 6.4 Recomendación de seguimiento (no implementada)

Guardar `birth_mode`/`algo_version` para auditar qué regla aplicó a cada fila. Los Hashimon ya emitidos con la fórmula anterior no se ven afectados (su `dna` ya está guardado, no se recalcula).

### 6.5 Qué falta por diseñar (fuera de alcance)

El mecanismo de **Natural** — cómo un bloque de Bitcoin real, en un checkpoint administrativo, se traduce en Hashimon colocados en el mapa — no está diseñado. Es donde debe vivir la protección anti-grind que Genesis ya no tiene.

---

## 7. Tipo elemental vs. arquetipo (cuerpo): ejes independientes, verificado

**Por qué importa:** antes de distribuir los primeros Genesis reales se verificó si existe alguna regla que ate un tipo elemental a una forma de cuerpo (ej. "eléctrico = roedor"). **No existe tal regla en el sistema vigente — y de hecho no es posible en `compiler.ts`.**

- El **arquetipo** sale de `DNA.pick(dna, 35, 2, ARCHETYPES)` en `encubation-website/src/lib/compiler.ts` — las 5 especies Genesis dejan `species.archetype` sin definir, así que cada individuo saca su arquetipo de una posición de ADN independiente de su tipo. La lista de 16 arquetipos (`canine, feline, ursine, avian, aquatic, reptilian, arachnid, mollusk, humanoid, construct, celestial, spectral, fungal, crystalline, amorphous, hybrid`) ni siquiera incluye "roedor".
- El **tipo elemental**, para Genesis, es fijo por elección del jugador (`species.type`, §6.2) — no al azar y no atado al cuerpo.
- Todos los demás rasgos visuales (build, tamaño, postura, ojos, marcas, material, rasgo distintivo, saturación, luminosidad, acento) leen posiciones de ADN independientes entre sí. El tipo solo restringe el **rango de matiz (hue)** vía `ELEMENT_PALETTES`.

### 7.1 Corrección aplicada 2026-08-20: `TYPES` no coincidía con el árbol elemental canónico

`compiler.ts` tenía dos tipos obsoletos (`robot`, `plasma`) que no existen en el árbol de 16 tipos elementales acordado (índice hex 0-F: `Fire, Water, Air, Earth, Electric, Wave, Astro, Pixel, Dream, Magic, Metal, Fungus, Mental, Plant, Spirit, Void`), y le faltaban dos tipos reales (`Spirit`/`espíritu`, `Void`/`vacío`). Corregido en:
- [`encubation-website/src/lib/compiler.ts`](../../encubation-website/src/lib/compiler.ts) — `TYPES` reordenado 0-F; `ELEMENT_PALETTES` actualizado.
- [`3d-world/mods/hashimon_core/dna_compiler.lua`](../../3d-world/mods/hashimon_core/dna_compiler.lua) — mismo cambio de paleta.
- [`3d-world/mods/hashimon_entities/entities.lua`](../../3d-world/mods/hashimon_entities/entities.lua) — `TYPE_COLORS` ampliado (incluía `vegetal` faltante por completo).

**Consecuencia:** como el look se recalcula en vivo (no se guarda), el tipo secundario de cualquier Genesis dual-tipo ya emitido podría mostrarse distinto la próxima vez que se vea. Impacto bajo — la distribución real apenas empieza.

### 7.2 Corrección aplicada 2026-08-20: catálogo muerto en `api/src/data/species.ts`

Este archivo (servidor, distinto del catálogo del portal) todavía tenía, hardcodeado, la regla exacta que se confirmó falsa: `genesis_electrico: { type: "electrico", archetype: "rodent" }`, además de `genesis_fuego → "canine"`, `genesis_aire → "bird"`, etc. — mirror muerto de un catálogo de cliente (`game/Content/hashimons.js`) que **ya no existe en este repo**.

Verificado que **ningún código lee esos campos** — `emit()` en `api/src/domain/hashimons.ts` solo usa `species.templateId` y la existencia de la clave. Se limpió el archivo a solo `{ templateId }` por especie; el tipo/arquetipo/color de cada Hashimon sigue viniendo exclusivamente del compilador del portal + DNA, nunca de este archivo. Tests (`api/src/core/core.test.ts`) y `tsc --noEmit` verificados sin regresión tras el cambio.

---

## 8. Referencias de código citadas en este documento

| Archivo | Qué contiene |
|---|---|
| [`api/src/core/dna.ts`](../src/core/dna.ts) | Fórmula histórica del ADN (`templateId:birthNonce:speciesKey`), helpers de lectura de nibbles |
| [`api/src/domain/hashimons.ts`](../src/domain/hashimons.ts) | `emit()` — nacimiento, generación de `birthNonce`, inserción con reintento |
| [`api/src/data/species.ts`](../src/data/species.ts) | Allowlist de emisión — solo `templateId`, sin tipo/arquetipo (corregido 2026-08-20) |
| [`api/src/db/schema.sql`](../src/db/schema.sql) | Restricción `UNIQUE` en `dna`, estructura de `players`/`hashimons`/`sessions` |
| [`api/src/http/auth.ts`](../src/http/auth.ts) | `requireSession` — el único mecanismo de autenticación real |
| [`api/src/domain/players.ts`](../src/domain/players.ts) | `loginOwner()` (contraseña vía argon2), validación de formato de `publicKey` |
| [`api/src/core/pow.ts`](../src/core/pow.ts) | `verifyStoredPow`, `verifyJobShare` — verificación de minería por recómputo |
| [`encubation-website/src/lib/compiler.ts`](../../encubation-website/src/lib/compiler.ts) | `compile()` — ADN → look; `TYPES`/`ELEMENT_PALETTES` canónicos |
| [`encubation-website/src/lib/species.ts`](../../encubation-website/src/lib/species.ts) | Catálogo del portal — 5 especies Genesis, `archetype` sin fijar a propósito |
