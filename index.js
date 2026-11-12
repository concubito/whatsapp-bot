const { ejecutarComandoLinux } = require('./tools.js');
const fs = require('fs');
const path = require('path');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

// ============================================================================
// CONFIGURACIÓN DE OLLAMA LOCAL (GTX 1650 - 4GB VRAM)
// ============================================================================
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434/api/chat';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3.2:3b'; // O 'qwen2.5:3b'
const MAX_ITERATIONS = 5;
const MAX_HISTORY_MESSAGES = 10; // 5 turnos para no saturar los 4 GB de VRAM

const SYSTEM_PROMPT = `Eres el asistente autónomo personal de Fran operando directamente en su laptop HP Victus con CachyOS (Arch Linux) a través de WhatsApp.
Tu única forma de responder al sistema es devolviendo UN ÚNICO objeto JSON válido. NUNCA escribas texto fuera del JSON.

REGLAS DE FLUJO:
1. Analiza lo que pide Fran.
2. Si necesitas inspeccionar el sistema, leer archivos, ver el estado del hardware o ejecutar cualquier acción en Linux, llena el campo "accion" con la herramienta "ejecutar_comando_linux" y deja "respuesta_final" en null.
3. Cuando ya tengas el resultado del comando (o si es charla normal), pon "accion" en null y escribe tu respuesta clara y conversacional en español dentro de "respuesta_final". Nunca pidas confirmación antes de ejecutar un comando de lectura o diagnóstico: ejecútalo directamente.

ESQUEMA JSON OBLIGATORIO:
{
  "pensamiento": "Razonamiento breve de lo que debes hacer ahora",
  "accion": {
    "herramienta": "ejecutar_comando_linux",
    "parametros": {
      "comando": "comando bash exacto a ejecutar"
    }
  },
  "respuesta_final": null
}

EJEMPLO 1 (Cuando necesitas usar la terminal):
{
  "pensamiento": "Fran pregunta cuánta VRAM está usando la GTX 1650. Ejecutaré nvidia-smi.",
  "accion": {
    "herramienta": "ejecutar_comando_linux",
    "parametros": {
      "comando": "nvidia-smi --query-gpu=memory.used,memory.total --format=csv"
    }
  },
  "respuesta_final": null
}

EJEMPLO 2 (Cuando ya tienes el dato o conversas con Fran):
{
  "pensamiento": "Ya tengo la salida del comando, le respondo directamente a Fran.",
  "accion": null,
  "respuesta_final": "Actualmente la GTX 1650 está ocupando 2350 MiB de los 4096 MiB disponibles."
}`;

// Archivo donde persistimos el historial limpio de la conversación con Ollama
const HISTORY_FILE = path.join(__dirname, '.ollama_history.json');
let chatHistory = [];

function inicializarChat() {
    chatHistory = [];
    try {
        if (fs.existsSync(HISTORY_FILE)) {
            const raw = fs.readFileSync(HISTORY_FILE, 'utf8');
            chatHistory = JSON.parse(raw);
        }
    } catch (e) {
        console.error('Iniciando historial de conversación limpio.');
        chatHistory = [];
    }
}

function guardarHistorial() {
    try {
        if (chatHistory.length > MAX_HISTORY_MESSAGES) {
            chatHistory = chatHistory.slice(chatHistory.length - MAX_HISTORY_MESSAGES);
        }
        fs.writeFileSync(HISTORY_FILE, JSON.stringify(chatHistory, null, 2));
    } catch (e) {
        console.error('Error al guardar historial:', e);
    }
}

inicializarChat();

// Nombres aceptados para el grupo exclusivo en WhatsApp donde hablarás con el bot
const NOMBRES_CHAT_BOT = ['agy', 'antigravity', 'gemini'];

// Guardar referencia a la última imagen o documento recibido
let ultimoArchivoRecibido = null;

// Conjunto para registrar los IDs de los mensajes enviados por el propio bot y evitar bucles infinitos
const mensajesDelBot = new Set();

// ============================================================================
// CONFIGURACIÓN DEL CLIENTE DE WHATSAPP
// ============================================================================
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        executablePath: '/usr/bin/google-chrome-stable',
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--disable-extensions',
            '--mute-audio'
        ]
    }
});

client.on('qr', (qr) => {
    console.log('Escanea el siguiente código QR con tu WhatsApp:');
    qrcode.generate(qr, { small: true });
});

client.on('ready', async () => {
    await client.pupPage.evaluate(() => {
        window.__ultimosMensajes = new Map();
        const { Msg } = window.require('WAWebCollections');
        const guardarRef = (msg) => {
            if (!msg || !msg.id) return;
            if (msg.id._serialized) window.__ultimosMensajes.set(msg.id._serialized, msg);
            if (msg.id.id) window.__ultimosMensajes.set(msg.id.id, msg);
            if (msg.type === 'ptt' || msg.type === 'audio') {
                window.__ultimoMensajeAudio = msg;
            }
            if (msg.type === 'image' || msg.type === 'document' || msg.type === 'sticker') {
                window.__ultimoMensajeMedia = msg;
            }
        };
        Msg.on('add', guardarRef);
        Msg.on('change', guardarRef);
    });

    const miNumero = client.info && client.info.wid ? client.info.wid._serialized : 'desconocido';
    console.log(`¡Cliente de WhatsApp conectado (${miNumero}) y vinculado con Ollama (${OLLAMA_MODEL})!`);
    console.log('Escribe, envía notas de voz o archivos en tu grupo "agy" de WhatsApp para conversar.');
});

/**
 * Verifica si el mensaje fue enviado dentro del grupo exclusivo.
 */
async function esElChatDeAntigravity(message) {
    const msgId = message.id._serialized;
    const chatId = message.to || message.from;

    if (!chatId.endsWith('@g.us')) {
        return false;
    }

    try {
        const esGrupoBot = await client.pupPage.evaluate(({ msgId, chatId, nombresEsperados }) => {
            const Chat = window.require('WAWebCollections').Chat;
            const chats = Chat.getModelsArray();

            const chat =
                Chat.get(chatId) ||
                chats.find((c) => (c.msgs && c.msgs.get(msgId)) || c.id?._serialized === chatId);

            if (!chat) {
                return false;
            }

            const titulo = (chat.name || chat.formattedTitle || chat.contact?.name || '').trim().toLowerCase();
            return nombresEsperados.some((nombre) => titulo.includes(nombre));
        }, { msgId, chatId, nombresEsperados: NOMBRES_CHAT_BOT });

        return Boolean(esGrupoBot);
    } catch (err) {
        console.error('Error al verificar el nombre del grupo:', err);
        return false;
    }
}

/**
 * Descarga de forma segura el contenido multimedia desde InMemoryMediaBlobCache de WhatsApp Web.
 */
async function descargarMediaSeguro(message) {
    const msgFullId = message.id._serialized;
    const msgShortId = message.id.id;
    const chatId = message.to || message.from;

    return await client.pupPage.evaluate(async ({ msgFullId, msgShortId, chatId }) => {
        const Chat = window.require('WAWebCollections').Chat;
        const cache = window.require('WAWebMediaInMemoryBlobCache').InMemoryMediaBlobCache;
        const mapa = window.__ultimosMensajes;

        let msg =
            (mapa && (mapa.get(msgFullId) || mapa.get(msgShortId))) ||
            window.__ultimoMensajeMedia ||
            window.__ultimoMensajeAudio;

        if (!msg) {
            const chat = Chat.get(chatId) || Chat.getModelsArray().find((c) => c.id?._serialized === chatId);
            if (chat && chat.msgs) {
                const models = typeof chat.msgs.getModelsArray === 'function' ? chat.msgs.getModelsArray() : [];
                msg = models.find((m) => m.id && (m.id.id === msgShortId || m.id._serialized === msgFullId)) || models[models.length - 1];
            }
        }

        if (!msg) {
            throw new Error('No se encontró la referencia del mensaje en WhatsApp Web.');
        }

        for (let i = 0; i < 25; i++) {
            if (msg.filehash && (msg.directPath || cache.get(msg.filehash))) {
                break;
            }
            await new Promise((r) => setTimeout(r, 400));
        }

        let blob = msg.filehash ? cache.get(msg.filehash) : null;
        if (!blob) {
            await msg.downloadMedia({
                downloadEvenIfExpensive: true,
                isUserInitiated: true,
                rmrReason: 1
            });
            for (let i = 0; i < 15; i++) {
                blob = msg.filehash ? cache.get(msg.filehash) : null;
                if (blob) break;
                await new Promise((r) => setTimeout(r, 300));
            }
        }

        if (!blob && msg.mediaData && msg.mediaData.mediaBlob) {
            const mb = msg.mediaData.mediaBlob;
            blob = typeof mb.formData === 'function' ? mb.formData() : (mb instanceof Blob ? mb : null);
        }

        if (!blob) {
            throw new Error('No se pudo obtener el Blob desencriptado del archivo multimedia.');
        }

        const arrayBuffer = await blob.arrayBuffer();
        const base64Data = await window.WWebJS.arrayBufferToBase64Async(arrayBuffer);

        return {
            data: base64Data,
            mimetype: blob.type || msg.mimetype || 'application/octet-stream',
            filename: msg.filename || null
        };
    }, { msgFullId, msgShortId, chatId });
}

function obtenerExtensionMedia(mimetype, filename) {
    if (filename && path.extname(filename)) {
        return path.extname(filename);
    }
    const cleanMime = (mimetype || '').split(';')[0].trim().toLowerCase();
    const mapa = {
        'image/jpeg': '.jpg',
        'image/jpg': '.jpg',
        'image/png': '.png',
        'image/webp': '.webp',
        'image/gif': '.gif',
        'application/pdf': '.pdf',
        'audio/ogg': '.ogg',
        'audio/mpeg': '.mp3',
        'audio/mp4': '.m4a',
        'video/mp4': '.mp4'
    };
    return mapa[cleanMime] || '.bin';
}

/**
 * Llama a la API local de Ollama forzando respuesta JSON.
 */
async function llamarOllamaJSON(messages) {
    const response = await fetch(OLLAMA_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: OLLAMA_MODEL,
            messages: messages,
            format: 'json',
            stream: false,
            options: {
                num_ctx: 8192,
                temperature: 0.1,
                keep_alive: -1
            }
        })
    });

    if (!response.ok) {
        throw new Error(`Error HTTP Ollama: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    try {
        return JSON.parse(data.message.content);
    } catch (err) {
        console.error('[Ollama] JSON malformado:', data.message.content);
        return {
            pensamiento: 'Fallo de formato JSON',
            accion: null,
            respuesta_final: data.message.content || 'Error al estructurar la respuesta.'
        };
    }
}

/**
 * Bucle autónomo (ReAct) sobre Ollama: piensa, ejecuta comandos Linux si hace falta y responde.
 */
async function consultarOllama(promptText) {
    const messages = [
        { role: 'system', content: SYSTEM_PROMPT },
        ...chatHistory,
        { role: 'user', content: promptText }
    ];

    let respuestaFinal = 'Alcancé el límite de pasos intentando resolver la tarea.';

    for (let paso = 1; paso <= MAX_ITERATIONS; paso++) {
        console.log(`[Ollama Paso ${paso}/${MAX_ITERATIONS}] Pensando...`);
        const decision = await llamarOllamaJSON(messages);

        if (decision.pensamiento) {
            console.log(`[Pensamiento]: ${decision.pensamiento}`);
        }

        messages.push({
            role: 'assistant',
            content: JSON.stringify(decision)
        });

        // Si el modelo pide usar la herramienta de terminal Linux
        const comandoSolicitado =
            decision.accion?.parametros?.comando ||
            decision.accion?.comando;

        if (decision.accion && comandoSolicitado) {
            const salidaConsola = await ejecutarComandoLinux(comandoSolicitado);
            messages.push({
                role: 'user',
                content: `[RESULTADO DE ejecutar_comando_linux]:\n${salidaConsola}\n\nAnaliza este resultado. Si ya tienes lo necesario para responder a Fran, pon "accion": null y escribe tu respuesta en "respuesta_final".`
            });
            continue;
        }

        if (decision.respuesta_final) {
            respuestaFinal = String(decision.respuesta_final).trim();
            break;
        }

        messages.push({
            role: 'user',
            content: 'Debes indicar un comando válido en "accion" o dar tu "respuesta_final" a Fran.'
        });
    }

    // Guardamos solo el intercambio final limpio para cuidar los 4 GB de VRAM
    chatHistory.push(
        { role: 'user', content: promptText },
        {
            role: 'assistant',
            content: JSON.stringify({
                pensamiento: 'Respuesta entregada a Fran.',
                accion: null,
                respuesta_final: respuestaFinal
            })
        }
    );
    guardarHistorial();

    return respuestaFinal;
}

/**
 * Envía la respuesta al grupo de WhatsApp con fallback de seguridad.
 */
async function responderEnGrupoBot(message, texto) {
    const mensajeConPrefijo = `🤖 ${texto}`;
    const msgId = message.id._serialized;
    const chatId = message.to || message.from;

    try {
        const sentMsgId = await client.pupPage.evaluate(
            async ({ msgId, chatId, content }) => {
                const Chat = window.require('WAWebCollections').Chat;
                const chats = Chat.getModelsArray();

                const chat =
                    Chat.get(chatId) ||
                    chats.find((c) => (c.msgs && c.msgs.get(msgId)) || c.id?._serialized === chatId);

                if (!chat) {
                    throw new Error('No se encontró el grupo agy en la memoria de WhatsApp Web.');
                }

                const sent = await window.WWebJS.sendMessage(chat, content, {});
                return sent && sent.id ? sent.id._serialized : null;
            },
            { msgId, chatId, content: mensajeConPrefijo }
        );

        if (sentMsgId) {
            mensajesDelBot.add(sentMsgId);
        }
    } catch (e) {
        const sent = await client.sendMessage(chatId, mensajeConPrefijo);
        if (sent && sent.id) {
            mensajesDelBot.add(sent.id._serialized);
        }
    }
}

// ============================================================================
// CAPTURA DE MENSAJES (EXCLUSIVAMENTE EN EL GRUPO "AGY")
// ============================================================================

client.on('message_create', async (message) => {
    if (!message.fromMe) {
        return;
    }

    if (mensajesDelBot.has(message.id._serialized) || (message.body && message.body.startsWith('🤖 '))) {
        return;
    }

    const esChatBot = await esElChatDeAntigravity(message);
    if (!esChatBot) {
        return;
    }

    // Soporte para notas de voz
    if (message.type === 'ptt' || message.type === 'audio') {
        console.log('[WhatsApp -> Ollama]: Nota de voz recibida. Descargando...');
        try {
            const media = await descargarMediaSeguro(message);
            if (media && media.data) {
                const tempAudioPath = '/tmp/whatsapp_nota_voz.ogg';
                fs.writeFileSync(tempAudioPath, Buffer.from(media.data, 'base64'));
                console.log(`Audio guardado en ${tempAudioPath}.`);

                const contextoImagen = ultimoArchivoRecibido
                    ? ` (Además, el último archivo enviado está en ${ultimoArchivoRecibido}).`
                    : '';

                const promptAudio = `Fran acaba de enviar una nota de voz guardada en ${tempAudioPath}.${contextoImagen} Si hay una herramienta CLI de transcripción disponible o si necesitas inspeccionar el archivo, usa ejecutar_comando_linux; de lo contrario indícale que el archivo quedó guardado en ${tempAudioPath}.`;
                const respuesta = await consultarOllama(promptAudio);
                await responderEnGrupoBot(message, respuesta);
            }
        } catch (error) {
            console.error('Error al procesar la nota de voz:', error);
            try {
                await responderEnGrupoBot(message, `No pude procesar la nota de voz: ${error.message}`);
            } catch (_) {}
        }
        return;
    }

    // Soporte para imágenes, stickers y documentos
    if (message.type === 'image' || message.type === 'document' || message.type === 'sticker') {
        console.log(`[WhatsApp -> Ollama]: Archivo multimedia (${message.type}) recibido.`);
        try {
            const media = await descargarMediaSeguro(message);
            if (media && media.data) {
                const ext = obtenerExtensionMedia(media.mimetype, media.filename);
                const timestamp = Date.now();
                const tempMediaPath = `/tmp/whatsapp_imagen_${timestamp}${ext}`;
                const symlinkFijo = `/tmp/whatsapp_ultima_imagen${ext}`;

                const buffer = Buffer.from(media.data, 'base64');
                fs.writeFileSync(tempMediaPath, buffer);
                fs.writeFileSync(symlinkFijo, buffer);
                ultimoArchivoRecibido = tempMediaPath;

                const comentario = message.body ? message.body.trim() : '';
                console.log(`Archivo guardado en ${tempMediaPath} (${buffer.length} bytes).`);

                const promptMedia = comentario
                    ? `He enviado un archivo guardado localmente en ${tempMediaPath} con este mensaje: "${comentario}". Usa ejecutar_comando_linux si necesitas inspeccionarlo o procesarlo.`
                    : `He enviado un archivo que quedó guardado en ${tempMediaPath}. Confírmame que lo recibiste y queda atento a mis instrucciones.`;

                const respuesta = await consultarOllama(promptMedia);
                await responderEnGrupoBot(message, respuesta);
            }
        } catch (error) {
            console.error('Error al procesar la imagen/archivo:', error);
            try {
                await responderEnGrupoBot(message, `No pude procesar la imagen o archivo: ${error.message}`);
            } catch (_) {}
        }
        return;
    }

    const texto = message.body ? message.body.trim() : '';
    if (!texto) {
        return;
    }

    // Comando para reiniciar la memoria de la conversación
    if (texto.toLowerCase() === '/nueva' || texto.toLowerCase() === '/reset') {
        try {
            if (fs.existsSync(HISTORY_FILE)) fs.unlinkSync(HISTORY_FILE);
        } catch (_) {}
        inicializarChat();
        ultimoArchivoRecibido = null;
        await responderEnGrupoBot(message, 'Memoria de Ollama reiniciada. ¿En qué trabajamos ahora?');
        return;
    }

    console.log(`[WhatsApp -> Ollama]: ${texto}`);

    try {
        const promptTexto = ultimoArchivoRecibido
            ? `${texto}\n\n[Contexto automático: El último archivo enviado por Fran está guardado en ${ultimoArchivoRecibido}]`
            : texto;
        const respuesta = await consultarOllama(promptTexto);
        await responderEnGrupoBot(message, respuesta);
        console.log('[Ollama -> WhatsApp]: Respuesta enviada.');
    } catch (error) {
        console.error('Error al procesar mensaje:', error);
        try {
            await responderEnGrupoBot(message, `Hubo un inconveniente con Ollama local: ${error.message}`);
        } catch (sendErr) {
            console.error('No se pudo enviar el mensaje de error a WhatsApp:', sendErr);
        }
    }
});

// Inicializar el cliente
client.initialize();
