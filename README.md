# 🤖 WhatsApp Agentic AI Bridge (Antigravity / Vibe Coding)

Puente bidireccional y autónomo que conecta **WhatsApp** con **Antigravity CLI (`agy`)** en Linux (CachyOS / Hyprland), permitiendo controlar el computador, programar, compilar hardware (Arduino), editar documentos (PDF/Markdown) y gestionar una bóveda técnica en Obsidian de forma remota desde el teléfono móvil mediante **texto, notas de voz e imágenes**.

## ✨ Características Principales

- **🎙️ Control por Notas de Voz (`audio/ogg`):** Descarga desencriptada en memoria desde `InMemoryMediaBlobCache` de WhatsApp Web e interpretación nativa multimodal.
- **🖼️ Visión Multimodal (Imágenes y Documentos):** Envío de fotografías de circuitos (Tinkercad/laboratorio), capturas de pantalla o documentos PDF para diagnóstico y edición remota en tiempo real.
- **🧠 Persistencia de Sesión:** Mantiene el contexto continuo de conversación entre reinicios mediante `.agy_conversation_id` y soporta reinicio rápido con `/nueva` o `/reset`.
- **⚡ Ejecución Autónoma en Terreno:** Capaz de abrir y compilar código en Arduino IDE, modificar configuraciones del sistema Linux/Hyprland, actualizar apuntes de ingeniería en Obsidian y editar archivos vectoriales PDF directamente desde WhatsApp.

## 🏗️ Arquitectura del Flujo

```
[WhatsApp Móvil (Texto / Voz / Imagen)]
          │
          ▼
[whatsapp-web.js + Puppeteer Headless]
          │  (Extracción desencriptada desde InMemoryMediaBlobCache)
          ▼
[Puente Node.js (index.js)]
          │  (Persistencia de contexto + Enrutamiento multimodal)
          ▼
[Antigravity CLI (agy)] ──► [Sistema Linux / Arduino IDE / Obsidian / Git]
```

## 🚀 Instalación y Uso

1. Clonar el repositorio e instalar dependencias:
   ```bash
   git clone https://github.com/concubito/whatsapp-bot.git
   cd whatsapp-bot
   npm install
   ```

2. Iniciar el puente:
   ```bash
   node index.js
   ```

3. Escanear el código QR en la terminal y enviar mensajes, audios o fotos dentro del grupo exclusivo **`agy`**.

---
**Autor:** Francisco Antonio Muñoz Núñez — *Ingeniería Eléctrica & Automatización con IA (INACAP Osorno)*
