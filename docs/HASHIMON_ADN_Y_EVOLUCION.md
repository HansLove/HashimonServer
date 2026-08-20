# ADN Hashiano y evolución

Guía para jugadores y desarrolladores sobre cómo nace un Hashimon, qué hace su ADN y cómo evoluciona con la minería.

Documentos relacionados: [Generación, tipos y prompts (paper técnico)](./HASHIMON_GENERACION_Y_TIPOS.md) · [White Paper v2](./Hashimon_white_paper_2_V1.md) · [PoW bound mode](./HASHIMON-RABBIT-POW.md) · [POW_SPEC](./POW_SPEC.md)

---

## 1. Qué es el ADN

El ADN de un Hashimon es un **hash SHA-256 de 64 caracteres hexadecimales** (256 bits). No es un número aleatorio asignado por el juego: es el resultado determinista de su nacimiento.

```
ADN = SHA-256( templateId : birthNonce : speciesKey )
```

| Campo | Qué es |
|---|---|
| `templateId` | Plantilla del bloque / contexto de nacimiento (ej. `template_genesis_fuego`) |
| `birthNonce` | Nonce de nacimiento — lo genera el **servidor** al emitir la criatura |
| `speciesKey` | Clave de especie en el catálogo (ej. `genesis_agua`) |

Cualquiera puede recomputar el ADN a partir de esos tres valores. Si el hash no coincide, la criatura fue alterada o nunca existió en el ledger.

Los nibbles se indexan desde **1** (como en el white paper): `[1]` es el primer dígito hex, `[64]` el último.

---

## 2. Dos capas de identidad

Un Hashimon tiene **dos fuentes de verdad** que no deben confundirse:

### Capa genética (inmutable)

Fijada en el nacimiento y derivada del ADN + la **especie**:

- **Elemento (tipo)** — lo define la especie en el catálogo, no el jugador ni un grind del hash
- **Subtipo** — variante dentro del elemento (ej. *Pure*, *Volcano*); las especies genesis fuerzan *Pure*
- **Color** — matiz, saturación y acento únicos (posiciones `[9]`–`[24]` del ADN)
- **Rasgos** — arquetipo, postura, ojos, material, rasgo distintivo (posiciones `[35]`–`[52]`)
- **Stats canónicos del compilador** — ataque, defensa, velocidad, HP, suerte (posiciones `[1]`, `[2]`, `[3]`, `[63]`, `[64]`)

Mientras el ADN y la especie no cambien, el compilador siempre produce la **misma descripción** (prompt / value sheet).

### Capa ganada (proof of work)

Fijada por la **minería real** verificada por el servidor:

- **Stage / stars / tier** — `floor(bestShareBits / 4)`, máximo 33
- **Stats de combate** — escalan +18% por stage sobre la base de la especie
- **Forma visual** — el sprite y el bloque de madurez del prompt avanzan con el tier
- **Aura** — ornamentos ligados al `bestShareHash` (el mejor hash encontrado)

Esta capa **no** se elige al nacer: se gana en el laboratorio con el botón **Mine**, sometiendo shares que el servidor recomputa y acepta.

```
Nacimiento          Minería (PoW)
──────────          ─────────────
templateId          job del servidor
birthNonce    →     extranonce2 + nonce
speciesKey          bestShareHash / bits
     ↓                    ↓
   ADN (64 hex)      stage, stars, poder
     ↓
 Compilador → color, rasgos, prompt "Give life"
```

---

## 3. Mapa de posiciones del ADN

Cada rasgo lee un tramo fijo del ADN con uno de tres métodos: **rango**, **paridad/módulo**, **seno/coseno**.

| Posiciones | Determina | Método |
|---|---|---|
| `[1]`–`[2]` | Tipo primario (solo si la especie no fija tipo) | rango |
| `[3]` | Mono-tipo o dual-tipo | paridad |
| `[4]` | Umbral dual-tipo | rango |
| `[5]`–`[6]` | Tipo secundario | rango |
| `[7]` | Subtipo | módulo |
| `[9]` | Banda de matiz dentro del tipo | módulo |
| `[10]`–`[13]` | Matiz exacto (65 536 valores) | rango |
| `[14]`–`[16]` | Saturación | seno |
| `[17]`–`[19]` | Luminosidad | seno |
| `[20]`–`[22]` | Esquema de acento | coseno |
| `[23]`–`[24]` | Saturación del acento | seno |
| `[25]`–`[31]` | Estrellas innatas (ADN; no usadas en rank actual) | umbral encadenado |
| `[35]`–`[36]` | Arquetipo (si la especie no lo fija) | rango |
| `[37]`–`[52]` | Build, postura, tamaño, ojos, marcas, temperamento, material, rasgo | rango |
| `[1]`, `[2]`, `[3]`, `[63]`, `[64]` | Stats de combate (modelo canónico) | posicional |

**Reservados:** `[8]`, `[32]`–`[34]`, `[53]`–`[62]` — 56 bits libres para rasgos futuros sin invalidar criaturas existentes.

---

## 4. El Compilador y «Give life»

El **Look Compiler** (`HashimonCompiler`) traduce ADN + especie en:

1. **Prompt** — texto para pegar en tu IA favorita (ilustración, pixel art o carta)
2. **Value sheet** — JSON con genética completa y ADN de 64 caracteres

El juego **no dibuja** la criatura: tú eres el renderer. En **Mi colección → Give life** puedes copiar el prompt; la descripción genética es idéntica en cada recarga porque depende solo del ADN.

Los colores exactos van en hex y HSL con instrucción explícita de no sustituirlos.

---

## 5. Cómo evolucionan

### Minería (bound mode)

Cada burst de ~260 ms el cliente:

1. Pide un **job** al servidor (`GET /hashimons/:id/job`)
2. Calcula hashes: `doubleSha256(dna:extranonce1:extranonce2:nonce)`
3. Si encuentra un hash con ≥ 12 bits cero a la izquierda, envía el **share** (`POST /hashimons/:id/shares`)
4. El servidor **recomputa** el hash; si coincide, acepta y actualiza el rank

### Progresión

```
tier = stars = stage = min( floor(bestShareBits / 4), 33 )
progreso hacia la siguiente estrella = bits % 4   (0..3 de 4)
```

Cada estrella extra exige un share ~16× más raro que la anterior (un nibble hex completo más de ceros).

### Efecto en combate

Al subir de stage, `HashimonSystem.applyStageScaling` aumenta HP y stats un **18% por stage** sobre la base de la especie. Evolucionar nunca reduce el HP actual proporcionalmente: ganas la diferencia de `maxHp`.

### Qué no cambia al evolucionar

- ADN, tipo, color base, subtipo, especie
- El prompt genético (salvo el bloque de **madurez**, que refleja el stage ganado)

---

## 6. Genesis elemental — tu primer Hashimon

Al empezar **New Adventure**, eliges uno de **cinco elementos puros**:

| Elemento | Especie | Tipo |
|---|---|---|
| Fuego | `genesis_fuego` | fuego · Pure |
| Agua | `genesis_agua` | agua · Pure |
| Aire | `genesis_aire` | aire · Pure |
| Tierra | `genesis_tierra` | tierra · Pure |
| Electricidad | `genesis_electrico` | electrico · Pure |

El **elemento es tu elección**; el **individuo es único** porque el servidor genera un `birthNonce` distinto y el ADN deriva color, rasgos y stats dentro de ese elemento.

Por diseño anti-grind, **no** puedes buscar un ADN «perfecto» antes de nacer: el servidor emite el nonce. Lo que sí controlas es la **especie genesis**, que fija el tipo puro.

Tras entrar al mundo, abre **Mi colección → Give life** cuando quieras renderizar tu Hashimon con tu IA.

---

## 7. Glosario

| Término | Significado |
|---|---|
| **Pure** | Subtipo clásico del elemento — expresión elemental sin mezcla |
| **extranonce1** | Primeros 8 hex del ADN; contexto fijo del job de minería |
| **extranonce2** | Contador de búsqueda del cliente; persiste entre sesiones |
| **Share** | Hash válido con suficientes bits cero; prueba de trabajo real |
| **verified** | El servidor recomputó el share y coincide con el ledger |
| **Give life** | Copiar el prompt del compilador para generar la imagen fuera del juego |
| **serverId** | UUID de la criatura en el servidor; necesario para minar con rank verificado |
