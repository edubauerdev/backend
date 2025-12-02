require("dotenv").config()
const express = require("express")
const cors = require("cors")
const { Boom } = require("@hapi/boom")
const pino = require("pino")
const { createClient } = require("@supabase/supabase-js")
const {
    default: makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    DisconnectReason,
    makeCacheableSignalKeyStore,
    downloadMediaMessage,
    jidNormalizedUser
} = require("@whiskeysockets/baileys")
const qrcode = require("qrcode")
const fs = require('fs')

const app = express()
app.use(cors())

// Limite alto para mídias
app.use(express.json({ limit: '50mb' }))
app.use(express.urlencoded({ limit: '50mb', extended: true }))

// --- CONFIGURAÇÃO SUPABASE ---
const supabaseUrl = process.env.SUPABASE_URL
const supabaseKey = process.env.SUPABASE_KEY

if (!supabaseUrl || !supabaseKey) {
    console.error("❌ ERRO: Configure SUPABASE_URL e SUPABASE_KEY no .env")
    process.exit(1)
}

const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false }
})

// --- ESTADO GLOBAL ---
let sock = null
let isStarting = false
let lastQrDataUrl = null
let qrTimeout = null

const connectionStatus = {
    connected: false,
    phone: null,
    status: "disconnected",
}

// Armazena nomes temporariamente na memória para vincular aos chats
let contactNameStore = {} 

// --- ATUALIZA STATUS NO BANCO ---
async function updateStatusInDb(status, qrCode = null, phone = null) {
    try {
        const { error } = await supabase.from("instance_settings").upsert({
            id: 1,
            status: status,
            qr_code: qrCode,
            phone: phone,
            updated_at: new Date()
        })
        if (error) console.error("[DB] Erro status:", error.message)
    } catch (err) { console.error("[DB] Erro:", err) }
}

// --- UTILITÁRIOS DE MENSAGEM ---
function getMessageText(msg) {
    if (!msg || !msg.message) return ""
    const content = msg.message
    if (content.conversation) return content.conversation
    if (content.extendedTextMessage?.text) return content.extendedTextMessage.text
    if (content.imageMessage?.caption) return content.imageMessage.caption || "[Imagem]"
    if (content.videoMessage?.caption) return content.videoMessage.caption || "[Vídeo]"
    if (content.documentMessage?.caption) return content.documentMessage.caption || "[Documento]"
    if (content.audioMessage) return "[Áudio]"
    if (content.stickerMessage) return "[Sticker]"
    return ""
}

function getMessageType(msg) {
    if (!msg.message) return "text"
    const types = ["imageMessage", "videoMessage", "audioMessage", "documentMessage", "stickerMessage", "reactionMessage", "protocolMessage"];
    const found = types.find(t => msg.message[t]);
    return found ? found.replace("Message", "") : "text";
}

const safeVal = (val) => (val === undefined ? null : val);

function prepareMessageForDB(msg, chatId) {
    try {
        const type = getMessageType(msg)
        const hasMedia = ["image", "video", "audio", "document", "sticker"].includes(type)
        let mediaMeta = null

        if (hasMedia) {
            try {
                const messageContent = msg.message[type + "Message"]
                if (messageContent) {
                    mediaMeta = {
                        url: safeVal(messageContent.url),
                        mediaKey: messageContent.mediaKey ? Buffer.from(messageContent.mediaKey).toString('base64') : null,
                        mimetype: safeVal(messageContent.mimetype),
                        fileEncSha256: messageContent.fileEncSha256 ? Buffer.from(messageContent.fileEncSha256).toString('base64') : null,
                        fileSha256: messageContent.fileSha256 ? Buffer.from(messageContent.fileSha256).toString('base64') : null,
                        fileLength: safeVal(messageContent.fileLength),
                        directPath: safeVal(messageContent.directPath),
                        iv: messageContent.iv ? Buffer.from(messageContent.iv).toString('base64') : null,
                    }
                }
            } catch (e) { }
        }

        const textContent = getMessageText(msg);
        if (!textContent && !hasMedia) return null;

        let ts = Number(msg.messageTimestamp);
        if (isNaN(ts) || ts === 0) ts = Math.floor(Date.now() / 1000);
        
        return {
            id: msg.key.id,
            chat_id: chatId,
            sender_id: msg.key.participant || msg.key.remoteJid || chatId,
            content: textContent,
            timestamp: ts * 1000,
            from_me: msg.key.fromMe || false,
            type: type,
            has_media: hasMedia,
            media_meta: mediaMeta,
            ack: msg.status || 0
        }
    } catch (err) {
        return null;
    }
}

// --- FUNÇÃO PRINCIPAL WHATSAPP ---
async function startWhatsApp(isManualStart = false) {
    if (sock?.user || isStarting) return;

    const hasAuthInfo = fs.existsSync("./auth_info/creds.json");
    if (!isManualStart && !hasAuthInfo) {
        console.log("[WHATSAPP] 🛑 Modo de Espera.");
        await updateStatusInDb("disconnected", null, null);
        return;
    }

    isStarting = true
    if (qrTimeout) clearTimeout(qrTimeout);

    try {
        console.log("[WHATSAPP] 🚀 Iniciando socket...")
        const { version } = await fetchLatestBaileysVersion()
        const logger = pino({ level: "silent" })
        const { state, saveCreds } = await useMultiFileAuthState("./auth_info")

        sock = makeWASocket({
            version,
            logger,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger),
            },
            browser: ["WhatsApp Backend", "Chrome", "1.0.0"],
            syncFullHistory: true,
            generateHighQualityLinkPreview: true,
            connectTimeoutMs: 60000, 
            keepAliveIntervalMs: 10000,
            getMessage: async (key) => { return { conversation: "loading..." } } 
        })

        sock.ev.on("creds.update", saveCreds)

        if (isManualStart) {
            qrTimeout = setTimeout(async () => {
                if (!sock?.user) {
                    try { sock.end(undefined); } catch (e) {}
                    sock = null;
                    isStarting = false;
                    await updateStatusInDb("disconnected", null, null);
                }
            }, 5 * 60 * 1000);
        }

        // --- LÓGICA DE SINCRONIZAÇÃO (2 ETAPAS) ---
        sock.ev.on("messaging-history.set", async ({ chats, contacts, messages }) => {
            console.log(`[SYNC] 🌊 Recebido: ${chats.length} chats | ${messages.length} mensagens`);
            if (qrTimeout) clearTimeout(qrTimeout);

            // 0. PREPARAÇÃO: Mapear nomes dos contatos para usar nos chats
            if (contacts) contacts.forEach(c => { 
                if (c.name || c.notify) contactNameStore[c.id] = c.name || c.notify 
            });
            // Tenta pegar nomes também das mensagens (PushNames)
            messages.forEach(m => {
                if (m.pushName && m.key.remoteJid) {
                    contactNameStore[m.key.remoteJid] = m.pushName;
                }
            });

            // ==================================================================================
            // ETAPA 1: POPULAR CHATS (LOTE 100)
            // ==================================================================================
            // Filtra chats (remove grupos se necessário, aqui removendo @g.us conforme padrão anterior)
            const privateChats = chats.filter(c => !c.id.includes("@g.us") && !c.id.includes("broadcast"));
            const CHAT_BATCH_SIZE = 100;

            console.log(`[SYNC - ETAPA 1] 📁 Processando ${privateChats.length} chats...`);

            for (let i = 0; i < privateChats.length; i += CHAT_BATCH_SIZE) {
                const batchRaw = privateChats.slice(i, i + CHAT_BATCH_SIZE);
                
                const batchChats = batchRaw.map(c => {
                    const id = jidNormalizedUser(c.id);
                    // Tenta achar o nome no mapa, ou no objeto chat, ou usa o número
                    const name = contactNameStore[id] || c.name || id.split('@')[0];
                    
                    let timestamp = c.conversationTimestamp ? Number(c.conversationTimestamp) : Date.now() / 1000;
                    if (timestamp < 946684800000) timestamp *= 1000;

                    return {
                        id: id,
                        name: name,
                        phone: id.split('@')[0],
                        unread_count: c.unreadCount || 0,
                        is_archived: c.archived || false,
                        last_message_time: timestamp,
                        is_group: false // Como filtramos !@g.us, é false
                    };
                });

                // Upsert garantindo que o chat exista antes das mensagens
                const { error } = await supabase.from("chats").upsert(batchChats, { onConflict: 'id' });
                if (error) console.error(`[SYNC - ERRO CHATS] Lote ${i}:`, error.message);
            }
            console.log("[SYNC - ETAPA 1] ✅ Todos os chats foram salvos.");

            // ==================================================================================
            // ETAPA 2: POPULAR MENSAGENS (LOTE 50) - SÓ RODA APÓS ETAPA 1
            // ==================================================================================
            const privateMessages = messages.filter(m => m.key.remoteJid && !m.key.remoteJid.includes("@g.us"));
            const MSG_BATCH_SIZE = 50; 

            console.log(`[SYNC - ETAPA 2] 📨 Processando ${privateMessages.length} mensagens...`);

            for (let i = 0; i < privateMessages.length; i += MSG_BATCH_SIZE) {
                const chunk = privateMessages.slice(i, i + MSG_BATCH_SIZE);
                // Prepara e filtra mensagens inválidas
                const batchMsgs = chunk
                    .map(m => prepareMessageForDB(m, m.key.remoteJid))
                    .filter(item => item !== null);
                
                if (batchMsgs.length > 0) {
                    const { error } = await supabase.from("messages").upsert(batchMsgs, { onConflict: 'id' });
                    if (error) {
                        // Loga erro mas continua, pode ser duplicidade ou erro pontual
                        console.error(`[SYNC - ERRO MSG] Lote ${i}:`, error.message);
                    }
                }
                
                // Progresso e pausa para não travar CPU
                if (i % 500 === 0 && i > 0) console.log(`[SYNC] Msg Progresso: ${i}/${privateMessages.length}`);
                await new Promise(r => setTimeout(r, 50)); 
            }

            console.log("[SYNC - ETAPA 2] ✅ Mensagens salvas.");
            
            // FIM
            await updateStatusInDb("connected", null, sock?.user?.id)
            console.log("[SYNC] 🏁 Sincronização Finalizada!")
            if (global.gc) global.gc()
        })

        // Eventos Tempo Real (Mantém atualizado pós-sync)
        sock.ev.on("messages.upsert", async ({ messages, type }) => {
            if (type !== "notify" && type !== "append") return
            for (const msg of messages) {
                const chatId = msg.key.remoteJid
                if (!chatId || chatId.includes("@g.us") || chatId === "status@broadcast") continue

                // Se descobrir um nome novo, atualiza o chat existente
                if(!msg.key.fromMe && msg.pushName) {
                    const id = jidNormalizedUser(chatId);
                    // Atualiza apenas o nome sem mexer no resto
                    await supabase.from('chats').upsert({ id: id, name: msg.pushName }, { onConflict: 'id' }).catch(() => {});
                }

                const msgDB = prepareMessageForDB(msg, chatId)
                if (msgDB) {
                    await supabase.from("messages").upsert(msgDB)
                }
            }
        })

        sock.ev.on("connection.update", async (update) => {
            const { connection, lastDisconnect, qr } = update
            if (qr) {
                lastQrDataUrl = await qrcode.toDataURL(qr)
                connectionStatus.status = "qr"
                await updateStatusInDb("qr", lastQrDataUrl, null)
            }
            if (connection === "open") {
                if (qrTimeout) clearTimeout(qrTimeout);
                connectionStatus.connected = true
                connectionStatus.phone = sock.user?.id
                connectionStatus.status = "connected"
                lastQrDataUrl = null
                await updateStatusInDb("connected", null, sock.user?.id)
            }
            if (connection === "close") {
                const reason = new Boom(lastDisconnect?.error)?.output?.statusCode
                connectionStatus.connected = false
                connectionStatus.status = "disconnected"
                lastQrDataUrl = null
                await updateStatusInDb("disconnected", null, null)
                const hasSession = fs.existsSync("./auth_info/creds.json");
                if (reason !== DisconnectReason.loggedOut && hasSession) {
                    isStarting = false
                    setTimeout(() => startWhatsApp(false), 3000)
                } else {
                    isStarting = false
                    sock = null
                }
            }
        })
    } catch (err) {
        console.error("Erro start:", err)
        await updateStatusInDb("error", null, null)
        isStarting = false
    }
}

// Inicia
startWhatsApp(false);

const handleShutdown = async (signal) => {
    try {
        await updateStatusInDb("disconnected", null, null);
        if (sock) sock.end(undefined);
    } finally { process.exit(0); }
};
process.on('SIGINT', () => handleShutdown('SIGINT'));
process.on('SIGTERM', () => handleShutdown('SIGTERM'));

// ROTAS API
app.get("/", (req, res) => res.send("WhatsApp API Online 🚀")); 
app.post("/session/connect", async (req, res) => {
    if (sock) { try { sock.end(undefined); sock = null; } catch(e){} }
    isStarting = false;
    startWhatsApp(true); 
    res.json({ success: true });
});
app.post("/session/disconnect", async (req, res) => {
    try {
        if (sock) await sock.logout();
        if (qrTimeout) clearTimeout(qrTimeout);
        sock = null;
        isStarting = false;
        await updateStatusInDb("disconnected", null, null);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get("/health", (req, res) => res.json({ ok: true, status: connectionStatus }))
app.get("/qr", (req, res) => {
    if (connectionStatus.connected) return res.send("ALREADY_CONNECTED")
    if (!lastQrDataUrl) return res.status(202).send("QR_NOT_READY")
    return res.send(lastQrDataUrl)
})
app.get("/chats/avatar/:chatId", async (req, res) => {
    const { chatId } = req.params;
    try {
        const url = await sock.profilePictureUrl(chatId, "image").catch(() => null);
        if (!url) return res.status(404).send("Sem foto");
        const response = await fetch(url);
        if (!response.ok) return res.status(404).send("Erro baixar");
        const buffer = Buffer.from(await response.arrayBuffer());
        res.set("Content-Type", "image/jpeg");
        res.set("Cache-Control", "public, max-age=3600"); 
        res.send(buffer);
    } catch (error) { res.status(500).send("Erro interno"); }
});

// Lazy Loading Chats
app.get("/chats", async (req, res) => { 
    const limit = Number(req.query.limit) || 20
    const offset = Number(req.query.offset) || 0
    try {
        const { data: chats, error, count } = await supabase.from('chats').select('*', { count: 'exact' }).eq('is_archived', false).not('id', 'ilike', '%@g.us').order('last_message_time', { ascending: false }).range(offset, offset + limit - 1)
        if (error) throw error
        const formattedChats = chats.map(c => ({ id: c.id, name: c.name, pictureUrl: c.image_url, lastMessage: c.last_message || "", lastMessageTime: c.last_message_time, unreadCount: c.unread_count, isGroup: false }))
        res.json({ success: true, chats: formattedChats, hasMore: (offset + limit) < count, total: count })
    } catch (error) { res.status(500).json({ success: false, chats: [] }) }
})

// Lazy Loading Messages
app.get("/chats/:chatId/messages", async (req, res) => { 
    const { chatId } = req.params
    const limit = Number(req.query.limit) || 20
    const offset = Number(req.query.offset) || 0
    if (chatId.includes("@g.us")) return res.status(403).json({ success: false })
    try {
        const { data: messages, error, count } = await supabase.from('messages').select('*', { count: 'exact' }).eq('chat_id', chatId).order('timestamp', { ascending: false }).range(offset, offset + limit - 1)
        if (error) throw error
        const formattedMsgs = messages.sort((a, b) => a.timestamp - b.timestamp).map(m => ({ id: m.id, body: m.content, timestamp: m.timestamp, from: m.sender_id, to: m.chat_id, fromMe: m.from_me, type: m.type, hasMedia: m.has_media, mediaUrl: m.has_media ? `${process.env.API_URL || 'http://localhost:3000'}/media/${m.chat_id}/${m.id}` : null, mimeType: m.media_meta?.mimetype, ack: m.ack }))
        res.json({ success: true, messages: formattedMsgs, hasMore: (offset + limit) < count, total: count })
    } catch (error) { res.status(500).json({ success: false, messages: [] }) }
})
app.get("/media/:chatId/:messageId", async (req, res) => { 
    const { chatId, messageId } = req.params
    if (chatId.includes("@g.us")) return res.status(403).send("Bloqueado")
    try {
        const { data: msg } = await supabase.from('messages').select('media_meta, type').eq('id', messageId).single()
        if (!msg?.media_meta) return res.status(404).send("Mídia não encontrada")
        const meta = msg.media_meta
        const mediaMessage = { url: meta.url, mediaKey: meta.mediaKey ? Buffer.from(meta.mediaKey, 'base64') : undefined, mimetype: meta.mimetype, fileEncSha256: meta.fileEncSha256 ? Buffer.from(meta.fileEncSha256, 'base64') : undefined, fileSha256: meta.fileSha256 ? Buffer.from(meta.fileSha256, 'base64') : undefined, fileLength: meta.fileLength, directPath: meta.directPath, iv: meta.iv ? Buffer.from(meta.iv, 'base64') : undefined }
        const buffer = await downloadMediaMessage({ key: { id: messageId }, message: { [msg.type + "Message"]: mediaMessage } }, 'buffer', {}, { logger: pino({ level: "silent" }), reuploadRequest: sock.updateMediaMessage })
        res.set("Content-Type", meta.mimetype)
        res.send(buffer)
    } catch (error) { res.status(500).send("Erro mídia") }
})
app.post("/chats/send", async (req, res) => {
    const { chatId, message } = req.body
    if (!connectionStatus.connected || !sock) return res.status(400).json({ success: false })
    try {
        const result = await sock.sendMessage(chatId, { text: message })
        res.json({ success: true, messageId: result?.key?.id })
    } catch (error) { res.status(500).json({ success: false, error: error.message }) }
})
const PORT = process.env.PORT || 3000
app.listen(PORT, () => console.log(`[SERVER] 🌐 Porta ${PORT}`))