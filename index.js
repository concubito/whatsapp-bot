const { herramientasGemini, ejecutarComandoLinux } = require('./tools.js');
const fs = require('fs');
const path = require('path');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// Cargar variables de entorno desde .env
try {
    process.loadEnvFile(path.join(__dirname, '.env'));
} catch (_) {
    // Si no existe .env, continúa sin problema
}

// ============================================================================
// CONFIGURACIÓN DE GEMINI API Y HERRAMIENTAS (TOOLS)
// ============================================================================
const apiKey = process.env.GOOGLE_AI_STUDIO_API_KEY;
if (!apiKey) {
    console.error('⚠️ ERROR: No se encontró GOOGLE_AI_STUDIO_API_KEY en tu archivo .env');
}

const genAI = new GoogleGenerativeAI(apiKey);

// Instanciar el modelo con instrucciones de sistema y acceso a comandos Linux
const aiModel = genAI.getGenerativeModel({ 
    model: 'gemini-3.8-flash-lite',
    systemInstruction: "Estás conversando con Fran a través de WhatsApp. Responde siempre en español, con lenguaje natural, conversacional y claro. Nunca uses menús de opciones numéricas ni pidas confirmación para ejecutar herramientas, hazlo directamente usando tu herramienta ejecutar_comando_linux.",
    tools: [herramientasGemini]
});

// Archivo donde persistimos el historial de la conversación con Gemini
const HISTORY_FILE = path.join(__dirname, '.gemini_history.json');
let chatSession;

function inicializarChat() {
    let history = [];
    try {
        if (fs.existsSync(HISTORY_FILE)) {
            const raw = fs.readFileSync(HISTORY_FILE, 'utf8');
            history = JSON.parse(raw);
        }
    } catch (e) {
        console.error('Iniciando historial de conversación limpio.');
    }
    chatSession = aiModel.startChat({ history });
}

async function guardarHistorial() {
    try {
        const history = await chatSession.getHistory();
        fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
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
    console.log(`¡Cliente de WhatsApp conectado (${miNumero}) y vinculado con Google Gemini!`);
    console.log('Escribe, envía notas de voz o imágenes en tu grupo "agy" de WhatsApp para conversar.');
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

// Función auxiliar para reintentar si Google devuelve 503 por saturación temporal
async function enviarConReintento(session, payload, maxIntentos = 3) {
    for (let intento = 1; intento <= maxIntentos; intento++) {
        try {
            return await session.sendMessage(payload);
        } catch (error) {
            const es503 = error.message && (error.message.includes('503') || error.message.includes('high demand'));
            if (es503 && intento < maxIntentos) {
                const esperaSegundos = intento * 2;
                console.warn(`[Gemini] Servidores de Google con alta demanda (503). Reintentando en ${esperaSegundos}s (intento ${intento}/${maxIntentos})...`);
                await new Promise((r) => setTimeout(r, esperaSegundos * 1000));
            } else {
                throw error;
            }
        }
    }
}

/**
 * Envía el prompt (y archivos multimedia) a Gemini, ejecuta comandos de Linux si el modelo lo solicita,
 * y devuelve la respuesta final.
 */
async function consultarGemini(promptText, mediaObj = null) {
    const payload = [];

    if (mediaObj && mediaObj.data) {
        payload.push({
            inlineData: {
                data: mediaObj.data,
                mimeType: mediaObj.mimetype.split(';')[0]
            }
        });
    }

    payload.push(promptText);

    // Primer envío con reintento automático
    let result = await enviarConReintento(chatSession, payload);
    let response = result.response;

    // Procesar llamadas a herramientas por lote (Batch) para soportar múltiples comandos simultáneos
    while (response.functionCalls() && response.functionCalls().length > 0) {
        const functionResponses = [];

        for (const call of response.functionCalls()) {
            if (call.name === 'ejecutar_comando_linux') {
                const { comando } = call.args;
                const salidaConsola = await ejecutarComandoLinux(comando);
                functionResponses.push({
                    functionResponse: {
                        name: 'ejecutar_comando_linux',
                        response: { resultado: salidaConsola }
                    }
                });
            }
        }

        if (functionResponses.length === 0) break;

        // Se envían todas las respuestas de las funciones juntas a Gemini
        result = await enviarConReintento(chatSession, functionResponses);
        response = result.response;
    }

    await guardarHistorial();

    let textoFinal = '';
    try {
        textoFinal = response.text();
    } catch (_) {
        textoFinal = 'Tarea completada exitosamente.';
    }

    return (textoFinal || 'Listo.').trim();
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
        // Fallback nativo de whatsapp-web.js si falla la inyección de DOM
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
        console.log('[WhatsApp -> Gemini]: Nota de voz recibida. Descargando y procesando...');
        try {
            const media = await descargarMediaSeguro(message);
            if (media && media.data) {
                const tempAudioPath = '/tmp/whatsapp_nota_voz.ogg';
                fs.writeFileSync(tempAudioPath, Buffer.from(media.data, 'base64'));
                console.log(`Audio guardado en ${tempAudioPath}. Consultando a Gemini...`);

                const contextoImagen = ultimoArchivoRecibido
                    ? ` (Nota: El último archivo/imagen que envié está guardado en ${ultimoArchivoRecibido}, por si hago referencia a él en el audio).`
                    : '';

                const promptAudio = `Escucha esta nota de voz, entiende lo que te digo o pido en el audio y respóndeme o ejecuta la tarea directamente en español.${contextoImagen}`;
                const respuesta = await consultarGemini(promptAudio, media);
                await responderEnGrupoBot(message, respuesta);
                console.log('[Gemini -> WhatsApp]: Respuesta a nota de voz enviada.');
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
        console.log(`[WhatsApp -> Gemini]: Archivo multimedia (${message.type}) recibido. Descargando y procesando...`);
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
                    ? `He enviado este archivo (también guardado localmente en ${tempMediaPath}) junto con este mensaje: "${comentario}". Analízalo y ejecuta la tarea o respóndeme directamente en español.`
                    : `He enviado este archivo (también guardado localmente en ${tempMediaPath}). Dime brevemente qué ves y queda atento por si te envío instrucciones en el siguiente mensaje o nota de voz.`;

                const respuesta = await consultarGemini(promptMedia, media);
                await responderEnGrupoBot(message, respuesta);
                console.log('[Gemini -> WhatsApp]: Respuesta a imagen/archivo enviada.');
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
        await responderEnGrupoBot(message, 'Conversación reiniciada. ¿En qué trabajamos ahora?');
        return;
    }

    console.log(`[WhatsApp -> Gemini]: ${texto}`);

    try {
        const promptTexto = ultimoArchivoRecibido
            ? `${texto}\n\n[Contexto automático: El último archivo/imagen enviado por Fran está guardado en ${ultimoArchivoRecibido}]`
            : texto;
        const respuesta = await consultarGemini(promptTexto);
        await responderEnGrupoBot(message, respuesta);
        console.log('[Gemini -> WhatsApp]: Respuesta enviada.');
    } catch (error) {
        console.error('Error al procesar mensaje:', error);
        try {
            await responderEnGrupoBot(message, `Hubo un inconveniente al procesar tu mensaje: ${error.message}`);
        } catch (sendErr) {
            console.error('No se pudo enviar el mensaje de error a WhatsApp:', sendErr);
        }
    }
});

// Inicializar el cliente
client.initialize();
