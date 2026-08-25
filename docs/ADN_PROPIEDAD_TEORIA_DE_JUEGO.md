# ADN, Propiedad y Teoría de Juego — documento de referencia para el equipo

**Estado:** documentación del sistema **tal como está implementado hoy**, verificado línea por línea contra el código real (`api/src/`, `encubation-website/src/lib/`, `3d-world/mods/`), no contra el whitepaper ni la memoria del proyecto. Este archivo se perdió al mover `docs/` dentro de `api/docs/` el 2026-08-20 y fue reconstruido el mismo día — si encuentras otra copia con contenido divergente, esta es la vigente.

**Audiencia:** equipo de desarrollo (backend, Luanti, portal).

Relacionados: [`HASHIMON_GENERACION_Y_TIPOS.md`](./HASHIMON_GENERACION_Y_TIPOS.md) *(nota: partes de ese documento describen un cliente `game/Content/*.js` que ya no existe en el repo — ver aviso al inicio de ese archivo)* · [`POW_SPEC.md`](./POW_SPEC.md) · [`HASHIMON-RABBIT-POW.md`](./HASHIMON-RABBIT-POW.md)

---

## 0. Resumen ejecutivo

1. **El ADN no es un hash arbitrario metido en un OP_RETURN.** Para Genesis, es el resultado determinista de `SHA256(ownerPublicKey : speciesKey : birthday)` — ver §6 (fórmula decidida y ya vigente para este tipo de nacimiento).
2. **La propiedad de un Hashimon NO se prueba recomputando el hash con tu llave pública.** La llave pública se guarda pero **nunca se verifica criptográficamente** en ningún punto del código. La propiedad es un registro en base de datos (`owner_id`) protegido por sesión con contraseña (bearer token) — el mismo modelo que un login web normal.
3. El ataque "copiar el hash de un Hashimon ajeno" **está descartado**, pero no por el mecanismo intuitivo de "yo puedo llegar a ese hash con mi llave". Está descartado por dos garantías estructurales distintas: (a) el cliente nunca puede elegir el valor de `dna` al crear una fila, y (b) `dna` es `UNIQUE` en la base de datos.
4. El sistema tiene **dos tipos de nacimiento** con requisitos de diseño distintos: **Genesis** (elegido por el jugador, determinista, sin necesidad de anti-grind) y **Natural** (sembrado por un bloque de Bitcoin real). Más una tercera capa que **no es de emisión sino de renderizado**: los **Exceptions** (diseños 3D artesanales que no derivan del ADN). Modelo completo en §7 — **especificado, no implementado**.
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

### 6.5 El mecanismo de Natural

Diseñado en §7. Es donde vive la protección anti-grind que Genesis ya no tiene: la entropía viene de bloques de Bitcoin reales, que nadie puede predecir ni elegir.

---

## 7. Modelo de emisión: Genesis, Naturales y Exceptions

**Estado:** diseño acordado 2026-08-25. **Nada de esta sección está implementado todavía** — no existe schema, ni checkpoint, ni derivación de bloque a criatura. Es la especificación a construir, no una descripción del código actual.

### 7.0 Las tres capas

| Capa | Origen | Cantidad | Renderizado | Propiedad |
|---|---|---|---|---|
| **Genesis** | Elección del jugador, determinista desde su llave pública (§6.2) | 1 por jugador | Procedural desde ADN | Al registrarse |
| **Natural** | Camada derivada de un bloque de Bitcoin real | Elástica (§7.3) | Procedural desde ADN | Primero en reclamar |
| **Exception** | Diseño 3D hecho a mano | Unos pocos, curados | **Artesanal — no deriva del ADN** (§7.4) | Según se coloque |

Las tres comparten la misma capa de identidad: ADN, tipo e historial de PoW son siempre derivables y verificables. Lo único que cambia entre ellas es **de dónde viene la entropía** y, en el caso de Exception, **de dónde viene la forma visual**.

### 7.1 Naturales — selección por suerte del bloque

Cada checkpoint (~1000 bloques ≈ 1 semana) recorre una ventana fija de alturas y ordena sus bloques por **suerte**:

```
extraBits(bloque) = leadingZeroBits(blockHash) − bitsRequeridos(dificultad del bloque)
```

Se toman los **N bloques con mayor `extraBits`** de la ventana (empates por altura ascendente, para que sea determinista). N ≈ 5% de la ventana.

Por qué esta métrica y no el número de transacciones, las comisiones o la marca de tiempo:

- **Ya existe en el código.** `leadingZeroBits()` está en [`api/src/core/pow.ts`](../src/core/pow.ts) y es exactamente la misma función con la que evolucionan los Hashimon. Un solo concepto de "suerte" en todo el sistema.
- **Infalsificable y no manipulable.** Nadie puede volver un bloque más afortunado después de minado.
- **Top-N, no umbral.** Un umbral fijo daría 0 criaturas una semana y 200 la siguiente; top-N da exactamente N siempre.

**ADN de un Natural:**

```
ADN_Natural = SHA256( blockHash : merkleRoot : slotIndex )
```

Nota honesta sobre `merkleRoot`: **no aporta entropía criptográfica** — ya está comprometido dentro del header que produjo `blockHash`. Se incluye porque hace la derivación legible (la criatura desciende de las transacciones de ese bloque), no porque agregue aleatoriedad. El único eje verdaderamente independiente es `slotIndex`, que distingue a los miembros de una misma camada.

**Tipo elemental:** de los primeros nibbles del ADN sobre los 16 tipos canónicos. A diferencia de Genesis, un Natural **no está restringido a los 5 elementos iniciales** — puede nacer Vacío o Vegetal directamente.

### 7.2 La escalera de 128 — tamaño de camada

Cada Natural seleccionado no es una criatura: es una **camada**. Su tamaño sale del mismo `extraBits`:

```
poblacionBase = clamp(128 >> extraBits, 1, 128)
```

| `extraBits` | Camada | Probabilidad |
|---|---|---|
| 0 | 128 | 50% |
| 1 | 64 | 25% |
| 2 | 32 | 12.5% |
| 3 | 16 | 6.25% |
| 4 | 8 | 3.1% |
| 5 | 4 | 1.6% |
| 6 | 2 | 0.8% |
| 7+ | **1 — pieza única** | 0.8% |

**Por qué 128 y no 100.** Dos razones:

*Estética:* 128 = 2⁷ produce exactamente 8 peldaños que terminan justo en 1. Con 100 la escalera sería `100 → 50 → 25 → 12 → 6 → 3 → 1 → 0`: mitades inexactas, redondeos, y toca el cero.

*Estructural, y es la que sostiene el diseño:* la suerte de un bloque cumple exactamente

```
P(extraBits ≥ k) = 2^−k
```

Cada bit extra de ceros **parte a la mitad** la probabilidad. Al partir también la camada a la mitad por cada bit, la rareza dentro del juego queda calcada de la rareza en la cadena **en la misma escala logarítmica**: una criatura el doble de rara de encontrar nació de un bloque el doble de raro de minar. Es un mapeo 1:1 en espacio log, no un número elegido para que "se sienta" raro.

**Magnitud resultante:** el valor esperado de la camada es

```
E[128 >> extraBits] = Σ 2^−(k+1) · 128·2^−k ≈ 85
```

Con N = 50 camadas por checkpoint: **≈ 4,250 criaturas por semana** con multiplicador 1. La escalera está dominada por los peldaños comunes (población sana) con la pieza única en la cola.

### 7.3 Multiplicador de emisión — inflación atada a bloques encontrados

```
camada(diseño) = poblacionBase(extraBits) × multiplicador(época)
```

**Invariante que hace esto seguro:** el multiplicador es **global**, así que la *proporción* entre camadas nunca cambia. Una de `extraBits = 0` siempre será 128× más común que una de `extraBits = 7`, con multiplicador 1 o 40. La rareza es un ranking, y los rankings sobreviven a la inflación — una legendaria sigue siendo legendaria aunque el suministro total crezca.

El multiplicador se mueve por dos vías, **ambas deterministas y publicadas de antemano — ninguna es una perilla discrecional**:

**a) Bloque encontrado con señal Hashimon (el evento grande).** Cuando la minería de los jugadores produce un bloque de Bitcoin real con la señal Hashimon en el coinbase, el multiplicador sube.

Esta es la mejor señal de demanda disponible, por una razón concreta: es **pública, permanente y no requiere confiar en el servidor para nada**. Cualquiera consulta la cadena y cuenta. Contrasta con escalar por "shares verificados", que prueba integridad pero no completitud (el servidor podría omitir shares y nadie lo detectaría con facilidad). Aquí no hay nada que omitir.

Y se auto-calibra: `E[bloques/año] ∝ hashrate agregado ∝ jugadores activos`. Es el ajuste de dificultad de Bitcoin, al revés y sin árbitro.

*Realidad numérica* (red ≈ 800 EH/s, 52,560 bloques/año):

| Escenario | Bloques esperados |
|---|---|
| 10,000 jugadores en navegador (~500 kH/s c/u) | 1 cada ~3 millones de años |
| ~76 ASICs modernos (~15 PH/s) | ~1 al año |
| ~230 ASICs (~46 PH/s) | ~3 al año |

**Consecuencia operativa:** la minería de navegador nunca dispara el evento — es participación y progresión, no inflación. El disparador vive en el hashrate rentado. Eso le da a la renta de máquinas un propósito narrativo además del económico: los mineros reales hacen crecer el mundo para todos.

**b) Piso de crecimiento pasivo (la cobertura).** Encontrar bloques es un proceso de Poisson: grumoso. Podrían caer dos en un mes y luego dieciocho meses secos. Un incremento pequeño y fijo por época (orden de +2%) cubre las sequías. Además, el salto del inciso (a) debe repartirse escalonadamente a lo largo de varias épocas en vez de aplicarse de golpe — mismo total, curva suave.

**Segundo dial, lento:** el número de camadas por checkpoint (la N del §7.1) también puede crecer, pero **logarítmicamente y atado a entrega real de arte** — orden de +1 por cada duplicación del trabajo acumulado. Nunca ates una variable elástica a un recurso no elástico: las camadas cuestan cero, los diseños cuestan trabajo humano (esqueletos, arte, mecánicas).

**Condición operativa crítica:** la regla debe publicarse **antes** de computarse. Si se computa primero y se publica después, se pueden probar ventanas hasta que el resultado guste — exactamente el mismo grinding que se aceptó en Genesis, pero aquí sí destruiría el argumento entero. Ver §7.5.

### 7.4 Exceptions — excepción de renderizado, no capa de emisión

Un **Exception** es un diseño 3D hecho a mano que **no corresponde a la compilación del ADN** — por ejemplo un modelo Meshy/Blender curado. Son unos pocos, deliberadamente.

**Esto ya está implementado**: es el registro `hashimon_media/<dna>.glb` de [`media.lua`](../../3d-world/mods/hashimon_core/media.lua), el primer nivel de la cadena de spawn. No hay mecanismo nuevo que construir, solo acotarlo y etiquetarlo.

**Requisito de honestidad, no cosmético:** un Exception rompe la regla "todo lo visual se deriva del ADN", que es una afirmación central del proyecto. **Debe estar etiquetado como tal en la UI.** Sin etiqueta, un jugador que compare el modelo contra su ADN concluirá que la derivación es mentira, y tendrá razón en ese caso puntual.

| | ¿Deriva del ADN? | ¿Verificable por cualquiera? |
|---|---|---|
| Identidad (ADN, tipo, historial PoW) | Sí — también en Exceptions | Sí |
| Renderizado | Normalmente sí | En Exception: **no, es artesanal** |

Etiqueta sugerida: *"Forma artesanal"* vs *"Forma compilada"*. Así la excepción refuerza la regla en vez de erosionarla. Concuerda con lo que ya dice el plan de morfología (§19: *"Premium nunca reemplaza stats, DNA, ni ownership"*).

### 7.5 El argumento anti-NFT, dicho con precisión

La afirmación defendible **no** es "nuestro suministro no es arbitrario" — alguien eligió 128, alguien eligió el 5%, alguien eligió el tamaño de la ventana. Sobre-afirmar aquí es regalarle el argumento al primer crítico técnico.

Lo defendible, y es fuerte:

> **El emisor no puede cambiar el suministro después de publicar la regla, y cualquiera puede verificar el conjunto de forma independiente.**

- **NFT:** el emisor controla el minteo; "10,000" lo garantiza solo su propio contrato, y lanzar otra colección es trivial.
- **Pokémon:** el suministro es ilimitado y no verificable; la editora spawnea lo que quiera.
- **Hashimon:** el conjunto es función pura de un ledger público inmutable más una regla publicada. Emitir fuera de la regla es **detectable**.

**Anclaje en cadena (recomendado).** Cada época, comprometer en el coinbase de un bloque propio:

```
commitment = SHA256( época ‖ multiplicador ‖ N camadas ‖ ventana de alturas )
```

Son 32 bytes; el scriptSig del coinbase tiene ~100 y ya se usa una parte (`COINBASE_TAG_ASCII = "hashimon"`, altura BIP34, extranonce — ver [`block-template.ts`](../src/domain/block-template.ts)). Con esto el historial de emisión queda con marca de tiempo en Bitcoin: no solo verificable, sino **imposible de reescribir retroactivamente**.

**Limitación que hay que decir en voz alta:** el commitment prueba **integridad**, no **completitud**. Se puede verificar que lo publicado es válido y que no fue alterado después; no se puede probar que se publicó *todo*. Es la diferencia real entre "verificable" y "sin confianza". El inciso (a) del §7.3 mitiga esto precisamente porque un bloque encontrado no depende de que el servidor publique nada.

---

## 8. Tipo elemental vs. arquetipo (cuerpo): ejes independientes, verificado

**Por qué importa:** antes de distribuir los primeros Genesis reales se verificó si existe alguna regla que ate un tipo elemental a una forma de cuerpo (ej. "eléctrico = roedor"). **No existe tal regla en el sistema vigente — y de hecho no es posible en `compiler.ts`.**

- El **arquetipo** sale de `DNA.pick(dna, 35, 2, ARCHETYPES)` en `encubation-website/src/lib/compiler.ts` — las 5 especies Genesis dejan `species.archetype` sin definir, así que cada individuo saca su arquetipo de una posición de ADN independiente de su tipo. La lista de 16 arquetipos (`canine, feline, ursine, avian, aquatic, reptilian, arachnid, mollusk, humanoid, construct, celestial, spectral, fungal, crystalline, amorphous, hybrid`) ni siquiera incluye "roedor".
- El **tipo elemental**, para Genesis, es fijo por elección del jugador (`species.type`, §6.2) — no al azar y no atado al cuerpo.
- Todos los demás rasgos visuales (build, tamaño, postura, ojos, marcas, material, rasgo distintivo, saturación, luminosidad, acento) leen posiciones de ADN independientes entre sí. El tipo solo restringe el **rango de matiz (hue)** vía `ELEMENT_PALETTES`.

### 8.1 Corrección aplicada 2026-08-20: `TYPES` no coincidía con el árbol elemental canónico

`compiler.ts` tenía dos tipos obsoletos (`robot`, `plasma`) que no existen en el árbol de 16 tipos elementales acordado (índice hex 0-F: `Fire, Water, Air, Earth, Electric, Wave, Astro, Pixel, Dream, Magic, Metal, Fungus, Mental, Plant, Spirit, Void`), y le faltaban dos tipos reales (`Spirit`/`espíritu`, `Void`/`vacío`). Corregido en:
- [`encubation-website/src/lib/compiler.ts`](../../encubation-website/src/lib/compiler.ts) — `TYPES` reordenado 0-F; `ELEMENT_PALETTES` actualizado.
- [`3d-world/mods/hashimon_core/dna_compiler.lua`](../../3d-world/mods/hashimon_core/dna_compiler.lua) — mismo cambio de paleta.
- [`3d-world/mods/hashimon_entities/entities.lua`](../../3d-world/mods/hashimon_entities/entities.lua) — `TYPE_COLORS` ampliado (incluía `vegetal` faltante por completo).

**Consecuencia:** como el look se recalcula en vivo (no se guarda), el tipo secundario de cualquier Genesis dual-tipo ya emitido podría mostrarse distinto la próxima vez que se vea. Impacto bajo — la distribución real apenas empieza.

### 8.2 Corrección aplicada 2026-08-20: catálogo muerto en `api/src/data/species.ts`

Este archivo (servidor, distinto del catálogo del portal) todavía tenía, hardcodeado, la regla exacta que se confirmó falsa: `genesis_electrico: { type: "electrico", archetype: "rodent" }`, además de `genesis_fuego → "canine"`, `genesis_aire → "bird"`, etc. — mirror muerto de un catálogo de cliente (`game/Content/hashimons.js`) que **ya no existe en este repo**.

Verificado que **ningún código lee esos campos** — `emit()` en `api/src/domain/hashimons.ts` solo usa `species.templateId` y la existencia de la clave. Se limpió el archivo a solo `{ templateId }` por especie; el tipo/arquetipo/color de cada Hashimon sigue viniendo exclusivamente del compilador del portal + DNA, nunca de este archivo. Tests (`api/src/core/core.test.ts`) y `tsc --noEmit` verificados sin regresión tras el cambio.

---

## 9. Referencias de código citadas en este documento

| Archivo | Qué contiene |
|---|---|
| [`api/src/core/dna.ts`](../src/core/dna.ts) | Fórmula histórica del ADN (`templateId:birthNonce:speciesKey`), helpers de lectura de nibbles |
| [`api/src/domain/hashimons.ts`](../src/domain/hashimons.ts) | `emit()` — nacimiento, generación de `birthNonce`, inserción con reintento |
| [`api/src/data/species.ts`](../src/data/species.ts) | Allowlist de emisión — solo `templateId`, sin tipo/arquetipo (corregido 2026-08-20) |
| [`api/src/db/schema.sql`](../src/db/schema.sql) | Restricción `UNIQUE` en `dna`, estructura de `players`/`hashimons`/`sessions` |
| [`api/src/http/auth.ts`](../src/http/auth.ts) | `requireSession` — el único mecanismo de autenticación real |
| [`api/src/domain/players.ts`](../src/domain/players.ts) | `loginOwner()` (contraseña vía argon2), validación de formato de `publicKey` |
| [`api/src/core/pow.ts`](../src/core/pow.ts) | `verifyStoredPow`, `verifyJobShare`, `leadingZeroBits` — verificación por recómputo y métrica de suerte usada en §7 |
| [`api/src/domain/block-template.ts`](../src/domain/block-template.ts) | Conexión al nodo Bitcoin (`getblocktemplate`), coinbase partido alrededor del extranonce — la misma conexión sirve para los datos históricos que necesita §7.1 |
| [`3d-world/mods/hashimon_core/media.lua`](../../3d-world/mods/hashimon_core/media.lua) | Registro `hashimon_media/<dna>.glb` — la capa de Exception (§7.4), ya implementada |
| [`encubation-website/src/lib/compiler.ts`](../../encubation-website/src/lib/compiler.ts) | `compile()` — ADN → look; `TYPES`/`ELEMENT_PALETTES` canónicos |
| [`encubation-website/src/lib/species.ts`](../../encubation-website/src/lib/species.ts) | Catálogo del portal — 5 especies Genesis, `archetype` sin fijar a propósito |
