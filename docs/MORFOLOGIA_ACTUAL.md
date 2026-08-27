# Morfología Hashimon — estado actual

**Fecha:** 2026-08-25 · **Estado:** implementado y verificado contra el código, no contra el diseño.

Este documento describe **lo que el código hace hoy**. Todo número viene de correr los
compiladores reales (`luajit` sobre `morphology.lua`), no de la especificación.

---

## 0. Resumen

Un Hashimon tiene **cuatro ejes visuales independientes**:

| Eje | De dónde sale | ¿Cambia con el stage? |
|---|---|---|
| **Familia corporal** | ADN + elemento | **Nunca.** Fijo de por vida |
| **Cuerpo dentro de la familia** | ADN (destino) + stage (lo que puede cargar) | Sí, sube por su línea |
| **Color** | ADN, independiente del elemento | No |
| **Proporciones anatómicas** | ADN (6 rasgos por hueso) | No |

Cifras actuales: **57 cuerpos · 25 familias**, de los cuales **17 tienen proporciones
procedurales**. Verificado: **0 incoherencias evolutivas en 20,000 criaturas**.

---

## 1. Cómo se elige el cuerpo

### 1.1 La familia se fija al nacer

```
familia = dna_pick(ADN[8], pools_de_familia[elemento])
```

Los pools (`G0_FAMILY_POOLS` en [`morphology.lua`](../3d-world/mods/hashimon_core/morphology.lua))
listan **nombres de familia, nunca IDs de asset**. El stage no entra en este cálculo.

> **Esto es una corrección, no un diseño original.** La primera versión re-elegía el
> cuerpo desde un pool filtrado por stage. Como `dna_pick` reparte el nibble sobre
> `#pool`, y el pool crecía al subir de stage, el mismo ADN caía en otro índice: un
> `aquatic_parrotfish` se volvía ballena y luego **rana**; un erizo se volvía cocodrilo.
> Medido: **9 de 12 criaturas de agua cambiaban de familia al evolucionar.** Hoy: 0.

### 1.2 El cuerpo concreto: destino fijo, portador según stage

```
línea    = cuerpos de esa familia, ordenados de menor a mayor altura
destino  = dna_pick(ADN[59], línea)          -- fijo de por vida
portado  = destino, si el stage lo permite
           si no, el cuerpo más grande de la MISMA familia que sí permita
```

Es la forma de una línea evolutiva de Pokémon: el destino está predeterminado desde el
nacimiento, y la criatura camina hacia él conforme crece. **Nunca sale de su familia.**

### 1.3 Techo de tamaño por stage

Los tiers salen del `hitbox.height` real de cada malla, no de una declaración manual:

| Tier | Altura | Se desbloquea en |
|---|---|---|
| ① chico | < 1.0 nodos | stage 1 |
| ② medio | 1.0 – 2.5 | stage 6 |
| ③ grande | ≥ 2.5 | stage 15 |

Esto impide que un jugador de stage 1 aparezca montado en un braquiosaurio de 5.25 nodos.

---

## 2. Las 25 familias y sus líneas evolutivas

Símbolos: ① chico · ② medio · ③ grande. Entre paréntesis, altura en nodos.

| Familia | Línea evolutiva (menor → mayor) |
|---|---|
| `amphibian` | ① frog (0.30) |
| `aquatic` | ① dolphin (0.51) → ① parrotfish (0.51) → ① nautilus (0.51) → ① octopus (0.96) → ① jellyfish (0.96) → ② whale (2.10) |
| `arthropod` | ② wasp (2.00) |
| `avian` | ① bat (0.30) → ① owl (0.30) → ① songbird (0.40) → ① chicken (0.50) → ① turkey (0.60) |
| `canine` | ① fox (0.50) → ① badger (0.55) → ① wolf (0.70) → ① direwolf (0.90) |
| `ceratopsian` | ③ triceratops (2.50) |
| `cervid` | ① reindeer (0.90) |
| `chelonian` | ① tortoise (0.30) |
| `construct` | ② gnorm (1.10) → ③ golem (2.50) |
| `crocodilian` | ② sarcosuchus (1.60) → ③ spinosaurus (3.10) |
| `dragon` | ② wyvern (1.51) → ③ ice (5.00) → ③ fire (5.00) |
| `equine` | ② horse (1.20) |
| `feline` | ① cat (0.40) → ① thylacoleo (0.75) → ① smilodon (0.95) |
| `flora` | ③ treeman (3.00) |
| `humanoid` | ② orc (2.30) → ③ skeleton (2.50) → ③ ogre (2.80) |
| `livestock` | ① pig (0.70) → ① sheep (0.80) → ② cow (1.00) |
| `marine_reptile` | ① plesiosaurus (0.80) → ② dunkleosteus (1.30) → ③ mosasaurus (2.80) |
| `marsupial` | ② procoptodon (1.40) |
| `megafauna` | ② elephant (2.10) → ③ elasmotherium (2.60) → ③ mammoth (2.60) |
| `pterosaur` | ① pteranodon (0.80) → ② quetzalcoatlus (2.45) |
| `rodent` | ① hedgehog (0.30) → ① rat (0.30) → ① opossum (0.40) |
| `sauropod` | ③ brachiosaurus (5.25) |
| `stegosaur` | ③ stegosaurus (2.50) |
| `theropod` | ① velociraptor (0.50) → ② carnotaurus (2.25) → ③ tyrannosaurus (2.70) |
| `ursine` | ② bear (1.00) → ② panda (1.00) |

**Familias de un solo cuerpo** (amphibian, arthropod, ceratopsian, cervid, chelonian,
equine, flora, marsupial, sauropod, stegosaur): no evolucionan de forma; solo escalan
con el stage. Son candidatas naturales a recibir cuerpos nuevos.

---

## 3. Los Genesis

Cinco especies, una por elemento inicial. **No fijan familia ni esqueleto** — a
propósito: si lo hicieran, todos los Hashimon de agua tendrían el mismo cuerpo.

| Genesis | Familias alcanzables | Reparto medido (4,000 ADN c/u) |
|---|---|---|
| `genesis_fuego` | canine, feline, theropod, dragon, megafauna | canine 24%, theropod 19%, megafauna 19%, feline 19%, dragon 19% |
| `genesis_agua` | aquatic, amphibian, marine_reptile, crocodilian, rodent | aquatic 25%, amphibian 19%, crocodilian 19%, rodent 19%, marine_reptile 18% |
| `genesis_aire` | avian, pterosaur, feline, arthropod | pterosaur 26%, avian 25%, arthropod 25%, feline 24% |
| `genesis_tierra` | ursine, equine, ceratopsian, stegosaur, chelonian, livestock | chelonian 19%, stegosaur 19%, equine 18%, ursine 18%, livestock 13%, ceratopsian 13% |
| `genesis_electrico` | rodent, feline, canine, avian, marsupial | rodent 26%, marsupial 19%, feline 19%, avian 19%, canine 18% |

El elemento **restringe el pool**; el ADN elige dentro. Eso no es lo mismo que "el
elemento determina el cuerpo": dos Hashimon de fuego normalmente tienen familias
distintas. Ver la §8 del [doc de ADN](../api/docs/ADN_PROPIEDAD_TEORIA_DE_JUEGO.md).

---

## 4. Color: eje totalmente independiente del elemento

El tipo elemental **no influye en el color en absoluto**. Antes sí — cada elemento tenía
una banda de matiz, así que todo Hashimon de agua salía azul.

```
matiz       = ADN[10..13] sobre la rueda completa (0-360°)
armonía     = ADN[32] → analogous | complementary | split | triadic | tetradic | monochrome
secundario  = matiz + desplazamiento de la armonía
saturación  = ADN[14..16] → 55..95
luminosidad = ADN[17..19] → 42..64
```

Las bandas estrechas de saturación/luminosidad son deliberadas: el rango completo 0-100
producía criaturas negras, blancas o lavadas.

El recoloreado usa `[colorizehsl`, que convierte a gris y tiñe, **preservando la
luminancia** — por eso sobreviven los ojos, el hocico y el patrón del pelaje que ya
están pintados en la textura. Con el `[colorize` plano anterior se aplastaban.

---

## 5. Proporciones anatómicas (mutación procedural)

Seis rasgos independientes, un nibble reservado cada uno:

| Rasgo | Nibble | Rango medido (20k ADN) |
|---|---|---|
| `headScale` | [53] | 0.86 – 1.21 |
| `neckLength` | [54] | 0.88 – 1.13 |
| `torsoWidth` | [55] | 0.88 – 1.17 |
| `torsoLength` | [56] | 0.90 – 1.12 |
| `limbLength` | [57] | 0.85 – 1.15 |
| `tailScale` | [58] | 0.85 – 1.18 |

El rasgo `build` (delicate/stocky/muscular/…) sesga torso y extremidades, así que por fin
significa algo más que tamaño global.

Se aplican con `set_bone_override(hueso, {scale = …, absolute = false})` — multiplicación
per-eje **contra la animación**, así que la override viaja con el ciclo de caminata en vez
de pelearse con él.

> **Cuidado al modificar:** la escala de hueso es multiplicativa. `clear_proportions` debe
> correr antes de `apply_proportions` o los valores se componen en cada resync
> (1.14 → 1.30 → 1.48…).

**Hoy son uniformes**, aunque los seis rasgos se derivan por separado y se transportan
per-eje. Motivo: los ejes locales de un hueso dependen del modelo, y escalar un cuello
por el eje equivocado lo hace *gordo* en vez de *largo*. La función `axes(part, t)` es el
único punto que hay que cambiar cuando se confirme la convención en pantalla.

Resultado: dos Hashimon de la misma familia y el mismo cuerpo tienen anatomías distintas.

```
ADN c9d59bf8..  head 1.09  neck 0.98  torso 0.96  limbs 1.05  tail 1.09
ADN b09715fc..  head 1.11  neck 1.00  torso 1.01  limbs 0.96  tail 1.05
```

---

## 6. Arquitectura: el firewall de licencias

```
hashimon_core/morphology.lua      ← familias, proporciones ABSTRACTAS. Cero nombres de asset.
        ↓ hashimon.register_body()
hashimon_bodies         (MIT)         25 cuerpos · animalia, draconis, marinaramobs, xocean
hashimon_bodies_paleo   (GPL-3.0)     19 cuerpos · paleotest
hashimon_bodies_dmobs   (CC BY-SA)    13 cuerpos · dmobs
```

El core declara intención (*"este ADN quiere un `aquatic`"*); el pack instalado responde.
**No se redistribuye ningún asset**: los mods traen su propia media y Luanti la resuelve
globalmente, así que un pack solo referencia nombres de archivo. Con el mod ausente, el
pack no registra nada.

Los nombres de hueso viven **solo** en los packs
([`proportions.lua`](../3d-world/mods/hashimon_bodies/proportions.lua)), nunca en el core.
Un cuerpo se apunta declarando `bones = { head = "Head", … }`; el que no declara, se deja
en paz. Por eso paleotest y dmobs (con huesos `cube.014` / `Cube.004`) quedan fuera sin
código especial.

**Prueba de aislamiento:** cargando solo el pack MIT → 11 familias, 25 cuerpos, el juego
funciona. Esa es la demostración de que ADN, especies y protocolo no dependen de los assets.

---

## 7. Qué NO existe todavía

- **Especies con nombre.** Solo hay 5 Genesis. La capa de iconografía (48 especies
  curadas con nombre, silueta fija y sub-banda de color) está diseñada pero no construida.
  El mecanismo ya está: `species.json` acepta `bodyFamily` y `skeleton`.
- **Mutaciones por gema/bloque.** No hay nada.
- **Intercambio de cabezas.** Verificado como viable
  (`set_bone_override` con `scale` a cero + adjuntar malla) pero no implementado.
- **Props de attachment** (cuernos, alas): apagados por defecto, sin calibrar.
- **Serpiente y pavorreal:** no existen en ninguno de los 8 mods instalados.

## 8. Cómo re-verificar

```bash
luajit scripts/validate_morphology.lua
```

Comprueba que cada Genesis produce más de un cuerpo, e informa cuántos cuerpos hay por
licencia y cuántos tienen huesos semánticos.
