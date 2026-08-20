# Hashimon — Arquitectura de inferencia LLM (Ollama + servidor de juego)

Documento técnico de referencia para investigación de infraestructura: memoria, API de inferencia, droplets y integración con el mundo Hashimon (Luanti).

**Estado:** borrador para PoC / spike  
**Audiencia:** backend, DevOps, integración juego ↔ modelos  
**Última revisión:** 2026-08-09

---

## 1. Preguntas abiertas (spike)

| # | Pregunta | Cómo validarla |
|---|----------|----------------|
| 1 | ¿Cuánta RAM consume el servidor de juego + modelos 2–7B? | PoC en droplet con `htop`, `ollama ps`, carga concurrente |
| 2 | ¿Ollama expone API estilo OpenAI/Anthropic para el servidor? | PoC con `POST /v1/chat/completions` |
| 3 | ¿Un solo droplet basta o conviene separar juego e inferencia? | Medir p95 de latencia y % RAM bajo carga mixta |

---

## 2. Contexto Hashimon

- El mundo 3D corre en **Luanti** (`3d-world/`), no en Minecraft vanilla. La arquitectura de inferencia es la misma: el servidor (o un bridge) llama a un servicio HTTP de LLM.
- Casos de uso probables: NPCs con diálogo, narrador de eventos, asistente de quests, respuestas contextuales con coords/inventario/estado de guerra (`hashimon_village_war`, etc.).
- El LLM **no debe bloquear el tick del servidor**. Toda llamada va en async + timeout + cola.

---

## 3. Memoria: servidor de juego + modelos

### 3.1 Son dos cargas distintas

No sumar “servidor + 7B parámetros” como un solo número. El peso en RAM depende de:

- Cuantización (`Q4_K_M`, `Q5`, etc.)
- Si la inferencia es **CPU** (RAM del host) o **GPU** (VRAM + algo de RAM del host)
- Jugadores online, mods, chunks cargados, mapas (`discovery_maps` genera PNGs por tile)

### 3.2 Estimaciones de orden de magnitud

| Componente | RAM típica |
|------------|------------|
| Servidor Luanti + mods Hashimon (pocos jugadores) | 2–4 GB |
| Servidor Minecraft/Paper (10–30 jugadores) | 4–8 GB |
| Modelo **2–3B** Q4 en CPU (Ollama) | ~1.5–3 GB |
| Modelo **7B** Q4 en CPU | ~4–6 GB |
| Modelo **7B** en GPU | ~4–8 GB VRAM; ~1–2 GB RAM host |
| Overhead Ollama + contexto KV (depende de `num_ctx`) | +0.5–2 GB |

### 3.3 Reglas prácticas para droplets

| RAM del droplet | Escenario viable |
|-----------------|------------------|
| **8 GB** | Solo PoC; juego ligero + modelo 2–3B, poca concurrencia |
| **16 GB** | MVP: Luanti + `llama3.2:3b` / `phi3:mini`, 1–2 chats simultáneos |
| **32 GB** | 7B en CPU con quant agresiva; latencia alta (segundos) |
| **GPU dedicada** | 7B+ en producción con varios NPCs o respuestas &lt; 2–3 s |

**Conclusión:** modelos 2–7B “ligeros” en parámetros **sí ocupan RAM** si no están bien cuantizados. Para 7B en producción interactiva, planear **GPU** o API gestionada (Groq, Together, etc.).

### 3.4 Comandos útiles en PoC

```bash
# Modelos descargados y en memoria
ollama list
ollama ps

# RAM / CPU del host
htop
free -h

# Probar carga (ejemplo)
time curl -s http://127.0.0.1:11434/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"llama3.2:3b","messages":[{"role":"user","content":"Hola"}]}'
```

---

## 4. Ollama y APIs compatibles

### 4.1 API compatible con OpenAI (recomendada para integración)

Ollama expone **`/v1/chat/completions`**, compatible con el formato OpenAI Chat Completions:

```http
POST http://<ollama-host>:11434/v1/chat/completions
Content-Type: application/json

{
  "model": "llama3.2:3b",
  "messages": [
    {
      "role": "system",
      "content": "Eres un aldeano de Hashimon. Responde en español, máximo 2 frases."
    },
    {
      "role": "user",
      "content": "¿Dónde está la aldea en guerra?"
    }
  ],
  "stream": false,
  "options": {
    "num_ctx": 4096,
    "temperature": 0.7
  }
}
```

Respuesta (forma OpenAI):

```json
{
  "choices": [
    {
      "message": {
        "role": "assistant",
        "content": "..."
      }
    }
  ]
}
```

**Base URL para SDKs OpenAI:**

```text
OPENAI_API_BASE=http://<ollama-host>:11434/v1
OPENAI_API_KEY=ollama
```

(La key suele ser ignorada en LAN; no exponer el puerto 11434 a internet sin auth.)

### 4.2 Otras APIs de Ollama

| Endpoint | Uso |
|----------|-----|
| `POST /api/chat` | Formato nativo Ollama |
| `POST /api/generate` | Completado simple (no chat) |
| `GET /api/tags` | Listar modelos |

### 4.3 Anthropic

Ollama **no** emula la API de Anthropic. Para Claude:

- API directa de Anthropic, o
- Proxy unificado (**LiteLLM**, **OpenRouter**) que abstraiga varios proveedores detrás de una interfaz.

### 4.4 Modelos sugeridos para PoC

| Modelo (Ollama) | Tamaño aprox. | Notas |
|-----------------|---------------|-------|
| `phi3:mini` | ~2B | Rápido en CPU, bueno para smoke test |
| `llama3.2:3b` | ~3B | Balance calidad/latencia en CPU |
| `llama3.1:8b` | ~7B | Mejor calidad; preferir GPU |
| `mistral:7b` | ~7B | Alternativa 7B |

Empezar con **3B en CPU**; escalar a GPU solo si la latencia o calidad no alcanzan.

---

## 5. Arquitectura de despliegue (droplets)

### 5.1 Opciones

```text
┌─────────────────────────────────────────────────────────────┐
│  A) Todo en uno (MVP)                                       │
│  ┌──────────────────────────────────────┐                   │
│  │ Droplet 16–32 GB RAM (CPU)           │                   │
│  │  • Luanti / bridge                   │                   │
│  │  • Ollama :11434 (solo localhost/VPC)│                   │
│  └──────────────────────────────────────┘                   │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│  B) Separado (recomendado al crecer)                        │
│  ┌─────────────────┐      VPC / firewall      ┌───────────┐ │
│  │ Droplet JUEGO   │ ─── HTTP interno ───────►│ Droplet   │ │
│  │ Luanti + bridge │                          │ INFERENCIA│ │
│  │ 4–8 GB RAM      │                          │ Ollama+GPU│ │
│  └─────────────────┘                          └───────────┘ │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│  C) Inferencia gestionada                                   │
│  Juego ──► bridge ──► Groq / Together / OpenAI (API)        │
│  Menos ops; coste por token; latencia predecible            │
└─────────────────────────────────────────────────────────────┘
```

### 5.2 ¿Importa el tipo de droplet?

**Sí.**

- **CPU-only (DigitalOcean standard):** válido para PoC y pocos NPCs; latencia de varios segundos con 7B.
- **GPU (DO GPU droplets, Lambda, RunPod, etc.):** necesario para 7B+ con varios usuarios o UX fluida.
- **Separar juego e inferencia** aísla picos: cuando Ollama responde, el servidor de juego no compite por CPU/RAM en el mismo host.

### 5.3 Red y seguridad

- Ollama **no** debe escuchar en `0.0.0.0:11434` en producción sin túnel/VPN/firewall.
- Patrón: bridge en el droplet de juego llama a `http://10.x.x.x:11434` (red privada).
- Timeouts cortos (ej. 15–30 s), reintentos limitados, fallback a línea de diálogo estática si el LLM falla.

---

## 6. Arquitectura de software (integración)

```text
┌──────────────┐     evento      ┌──────────────┐     HTTP      ┌─────────┐
│ Luanti       │ ───────────────►│ LLM Bridge   │ ─────────────►│ Ollama  │
│ (mods Lua)   │◄───────────────│ (Node/Python)│◄───────────────│ /v1/... │
└──────────────┘   chat / action └──────────────┘   JSON         └─────────┘
                       │
                       ▼
                 cola, rate limit,
                 truncar contexto,
                 logs, métricas
```

### 6.1 Responsabilidades del bridge

1. **Construir el prompt** — system + estado del juego (coords, quest, facción, Hashimon activo).
2. **Truncar contexto** — no enviar inventario completo; resumen estructurado.
3. **Cola async** — no bloquear el servidor Luanti (HTTP desde Lua con timeout o sidecar).
4. **Rate limit** — por jugador y global (evitar spam de chat → inferencia).
5. **Fallback** — respuesta por defecto si timeout o 5xx.
6. **Observabilidad** — latencia p50/p95, tokens, errores.

### 6.2 Ejemplo de payload de contexto (NPC aldeano)

```json
{
  "model": "llama3.2:3b",
  "messages": [
    {
      "role": "system",
      "content": "Eres un aldeano en el mundo Hashimon. Responde en español, máximo 2 frases. No inventes items que no existen."
    },
    {
      "role": "user",
      "content": "Jugador 'Alice' en X=120 Z=-45 pregunta: ¿Hay guerra cerca?\nEstado: aldea 'Northwood' en paz; 'Eastvale' en guerra (vwar)."
    }
  ]
}
```

### 6.3 Integración desde Luanti (sketch)

Luanti puede usar `HTTPApi` (si está habilitado) o un **sidecar** que escuche en localhost y reciba eventos vía mod channel / socket:

```lua
-- Pseudocódigo: no bloquear globalstep
http.fetch_async({
  url = "http://127.0.0.1:8787/npc/reply",
  method = "POST",
  post_data = minetest.write_json({ player = name, question = text }),
  timeout = 20,
})
-- En callback: minetest.chat_send_player(name, response)
```

Preferir sidecar si `HTTPApi` no está disponible o se quiere lógica de cola fuera del proceso del juego.

---

## 7. Plan de PoC (checklist)

### Fase 1 — Inferencia aislada (1–2 días)

- [ ] Droplet 16 GB, instalar Ollama
- [ ] `ollama pull llama3.2:3b`
- [ ] Medir RAM en idle y bajo 10 requests secuenciales
- [ ] Medir latencia p95 con `curl` / script Python
- [ ] Confirmar `/v1/chat/completions` con payload de NPC

### Fase 2 — Carga mixta (1–2 días)

- [ ] Mismo droplet (o dos) con Luanti/bridge + Ollama
- [ ] 5 requests concurrentes mientras el servidor de juego está activo
- [ ] Registrar RAM &gt; 80 % o p95 &gt; 5 s → activar plan B (split o GPU)

### Fase 3 — Integración mínima (3–5 días)

- [ ] Bridge HTTP con timeout + fallback
- [ ] Un NPC o comando de chat de prueba en Luanti
- [ ] Logs de latencia y errores

### Criterios de éxito MVP

| Métrica | Objetivo |
|---------|----------|
| Latencia p95 (3B CPU) | &lt; 5 s |
| Latencia p95 (7B GPU) | &lt; 3 s |
| RAM bajo carga | &lt; 80 % del droplet |
| Disponibilidad | Fallback estático si LLM cae |

---

## 8. Decisión rápida (árbol)

```text
¿Presupuesto GPU?
├─ No  → 16 GB droplet, 3B CPU, bridge, 1–2 NPCs
├─ Sí  → Droplet juego (4–8 GB) + droplet GPU con Ollama
└─ ¿Mucho tráfico / sin ops?
       → API gestionada (Groq, Together) + bridge
```

---

## 9. Referencias

- [Ollama — OpenAI compatibility](https://github.com/ollama/ollama/blob/main/docs/openai.md)
- [Ollama API](https://github.com/ollama/ollama/blob/main/docs/api.md)
- Hashimon Luanti: `3d-world/README.md`
- Mapas / estado mundo: `3d-world/mods/discovery_maps/`, `3d-world/mods/hashimon_village_war/`

---

## 10. Próximos pasos sugeridos

1. Ejecutar Fase 1 del PoC y documentar números reales (RAM, latencia, modelo elegido).
2. Definir contrato del bridge (`POST /npc/reply`, schema JSON).
3. Decidir MVP: **un droplet 16 GB** vs **split** vs **API externa** según resultados del PoC.
