const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

const execFileAsync = promisify(execFile);

// Cargar variables de entorno desde .env (opcional, por si más adelante usas APIs de voz STT/TTS)
try {
    process.loadEnvFile(path.join(__dirname, '.env'));
} catch (_) {
    // Si no existe .env, continúa sin problema
}

// Ruta al ejecutable de Antigravity CLI (agy) en tu PC
const AGY_BIN = '/home/fran/.local/bin/agy';

// Nombres aceptados para el grupo exclusivo en WhatsApp donde hablarás con el bot
const NOMBRES_CHAT_BOT = ['agy', 'antigravity'];

// Archivo donde persistimos el ID de la conversación actual con Antigravity para no perder contexto al reiniciar
const CONVERSATION_FILE = path.join(__dirname, '.agy_conversation_id');

let agyConversationId = null;
try {
    if (fs.existsSync(CONVERSATION_FILE)) {
        agyConversationId = fs.readFileSync(CONVERSATION_FILE, 'utf8').trim() || null;
    }
} catch (_) {}

function guardarConversationId(id) {
    agyConversationId = id;
    try {
        if (id) {
            fs.writeFileSync(CONVERSATION_FILE, id, 'utf8');
        } else if (fs.existsSync(CONVERSATION_FILE)) {
            fs.unlinkSync(CONVERSATION_FILE);
        }
    } catch (_) {}
}

// Guardar referencia a la última imagen o documento recibido para asociarlo con notas de voz o textos posteriores
let ultimoArchivoRecibido = null;

// Conjunto para registrar los IDs de los mensajes enviados por el propio bot y evitar bucles infinitos
const mensajesDelBot = new Set();

// Configuración del cliente con LocalAuth y optimización de RAM en Puppeteer
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

// Evento 'qr': Muestra el QR en la terminal
client.on('qr', (qr) => {
    console.log('Escanea el siguiente código QR con tu WhatsApp:');
    qrcode.generate(qr, { small: true });
});

// Evento 'ready': Sesión iniciada
client.on('ready', async () => {
    // Registrar un mapa en memoria dentro de WhatsApp Web para capturar las referencias exactas de cada mensaje nuevo
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
    console.log(`¡Cliente de WhatsApp conectado (${miNumero}) y vinculado con Antigravity!`);
    console.log('Escribe, envía notas de voz o imágenes en tu grupo "agy" de WhatsApp para conversar.');
});

/**
 * Verifica si el mensaje fue enviado dentro del grupo exclusivo llamado "agy" (o "Antigravity").
 */
async function esElChatDeAntigravity(message) {
    const msgId = message.id._serialized;
    const chatId = message.to || message.from;

    // Solo nos interesan los grupos (@g.us)
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
 * Descarga de forma segura el contenido multimedia (audio, imagen, documento) extrayendo el Blob desencriptado
 * desde InMemoryMediaBlobCache de WhatsApp Web.
 */
async function descargarMediaSeguro(message) {
    const msgFullId = message.id._serialized;
    const msgShortId = message.id.id;
    const chatId = message.to || message.from;

    return await client.pupPage.evaluate(async ({ msgFullId, msgShortId, chatId }) => {
        const Chat = window.require('WAWebCollections').Chat;
        const cache = window.require('WAWebMediaInMemoryBlobCache').InMemoryMediaBlobCache;
        const mapa = window.__ultimosMensajes;

        // 1. Obtener la referencia viva del mensaje
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

        // 2. Esperar hasta 10 segundos si el teléfono aún está subiendo el archivo
        for (let i = 0; i < 25; i++) {
            if (msg.filehash && (msg.directPath || cache.get(msg.filehash))) {
                break;
            }
            await new Promise((r) => setTimeout(r, 400));
        }

        // 3. Descargar y desencriptar en el caché en memoria de WhatsApp Web
        let blob = msg.filehash ? cache.get(msg.filehash) : null;
        if (!blob) {
            await msg.downloadMedia({
                downloadEvenIfExpensive: true,
                isUserInitiated: true,
                rmrReason: 1
            });
            // Esperar un momento a que se deposite en InMemoryMediaBlobCache
            for (let i = 0; i < 15; i++) {
                blob = msg.filehash ? cache.get(msg.filehash) : null;
                if (blob) break;
                await new Promise((r) => setTimeout(r, 300));
            }
        }

        // 4. Fallback a mediaBlob en caso de que esté ahí
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

/**
 * Obtiene la extensión adecuada según el mimetype o nombre de archivo.
 */
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
 * Envía un prompt a Antigravity CLI (agy) en tu PC y devuelve su respuesta en español natural.
 * Mantiene el historial de la conversación automáticamente.
 * @param {string} promptText - El mensaje o instrucción enviado desde WhatsApp
 * @returns {Promise<string>} Respuesta de Antigravity
 */
async function consultarAntigravity(promptText) {
    // Instrucción para asegurar que responda siempre en español y lenguaje natural apto para WhatsApp
    const promptConContexto = agyConversationId
        ? promptText
        : `[Instrucción de sistema: Estás conversando con Fran a través de WhatsApp. Responde siempre en español, con lenguaje natural, conversacional y claro. Nunca uses menús de opciones numéricas ni pidas confirmación para ejecutar herramientas, hazlo directamente.]\n\nMensaje de Fran: ${promptText}`;

    const args = [
        '-p', promptConContexto,
        '--output-format', 'json',
        '--dangerously-skip-permissions'
    ];

    if (agyConversationId) {
        args.push('--conversation', agyConversationId);
    }

    const { stdout } = await execFileAsync(AGY_BIN, args, {
        cwd: '/home/fran',
        maxBuffer: 10 * 1024 * 1024
    });

    const lines = stdout.trim().split('\n');
    const jsonLine = lines[lines.length - 1];
    const data = JSON.parse(jsonLine);

    if (data.conversation_id) {
        guardarConversationId(data.conversation_id);
    }

    return (data.response || 'Listo, tarea completada.').trim();
}

/**
 * Envía la respuesta de Antigravity directamente al grupo "agy" en memoria de WhatsApp Web.
 */
async function responderEnGrupoBot(message, texto) {
    const mensajeConPrefijo = `🤖 ${texto}`;
    const msgId = message.id._serialized;
    const chatId = message.to || message.from;

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
}

// ============================================================================
// CAPTURA DE MENSAJES (EXCLUSIVAMENTE EN EL GRUPO "AGY")
// ============================================================================

client.on('message_create', async (message) => {
    // 1. Solo procesar mensajes enviados por ti
    if (!message.fromMe) {
        return;
    }

    // 2. Ignorar los mensajes que el propio bot acaba de escribir (evita bucles infinitos)
    if (mensajesDelBot.has(message.id._serialized) || (message.body && message.body.startsWith('🤖 '))) {
        return;
    }

    // 3. Verificar que estemos dentro del grupo llamado "agy"
    const esChatBot = await esElChatDeAntigravity(message);
    if (!esChatBot) {
        return;
    }

    // Soporte activo para notas de voz en el grupo "agy"
    if (message.type === 'ptt' || message.type === 'audio') {
        console.log('[WhatsApp -> Antigravity]: Nota de voz recibida. Descargando y procesando...');
        try {
            const media = await descargarMediaSeguro(message);
            if (media && media.data) {
                const tempAudioPath = '/tmp/whatsapp_nota_voz.ogg';
                fs.writeFileSync(tempAudioPath, Buffer.from(media.data, 'base64'));
                console.log(`Audio guardado en ${tempAudioPath} (${media.data.length} caracteres Base64). Consultando a Antigravity...`);

                const contextoImagen = ultimoArchivoRecibido
                    ? ` (Nota: El último archivo/imagen que envié está guardado en ${ultimoArchivoRecibido}, por si hago referencia a él en el audio).`
                    : '';

                const promptAudio = `He enviado una nota de voz guardada en ${tempAudioPath}.${contextoImagen} Usa tu herramienta read_file para escuchar el archivo ${tempAudioPath}, entiende lo que te digo o pido en el audio y respóndeme o ejecuta la tarea directamente en español.`;
                const respuesta = await consultarAntigravity(promptAudio);
                await responderEnGrupoBot(message, respuesta);
                console.log('[Antigravity -> WhatsApp]: Respuesta a nota de voz enviada.');
            }
        } catch (error) {
            console.error('Error al procesar la nota de voz:', error);
            try {
                await responderEnGrupoBot(message, `No pude procesar la nota de voz: ${error.message}`);
            } catch (_) {}
        }
        return;
    }

    // Soporte activo para imágenes, stickers y documentos en el grupo "agy"
    if (message.type === 'image' || message.type === 'document' || message.type === 'sticker') {
        console.log(`[WhatsApp -> Antigravity]: Archivo multimedia (${message.type}) recibido. Descargando y procesando...`);
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

                let promptMedia;
                if (comentario) {
                    promptMedia = `He enviado una imagen/archivo guardado en ${tempMediaPath} junto con este mensaje: "${comentario}". Usa tu herramienta read_file para ver el archivo ${tempMediaPath} y ejecuta la tarea o respóndeme directamente en español.`;
                } else {
                    promptMedia = `He enviado una imagen/archivo guardado en ${tempMediaPath} (sin texto adicional). Usa tu herramienta read_file para ver el archivo ${tempMediaPath}, dime brevemente qué ves o si corresponde a alguna tarea en curso, y queda atento por si te envío instrucciones en el siguiente mensaje o nota de voz.`;
                }

                const respuesta = await consultarAntigravity(promptMedia);
                await responderEnGrupoBot(message, respuesta);
                console.log('[Antigravity -> WhatsApp]: Respuesta a imagen/archivo enviada.');
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

    // Comando opcional para empezar una conversación desde cero
    if (texto.toLowerCase() === '/nueva' || texto.toLowerCase() === '/reset') {
        guardarConversationId(null);
        ultimoArchivoRecibido = null;
        await responderEnGrupoBot(message, 'Conversación reiniciada. ¿En qué trabajamos ahora?');
        return;
    }

    console.log(`[WhatsApp -> Antigravity]: ${texto}`);

    try {
        const promptTexto = ultimoArchivoRecibido
            ? `${texto}\n\n[Contexto automático: El último archivo/imagen enviado por Fran está guardado en ${ultimoArchivoRecibido}]`
            : texto;
        const respuesta = await consultarAntigravity(promptTexto);
        await responderEnGrupoBot(message, respuesta);
        console.log('[Antigravity -> WhatsApp]: Respuesta enviada.');
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
