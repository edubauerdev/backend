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

app.use(express.json({ limit: '50mb' }))
app.use(express.urlencoded({ limit: '50mb', extended: true }))

const supabaseUrl = process.env.SUPABASE_URL
const supabaseKey = process.env.SUPABASE_KEY

if (!supabaseUrl || !supabaseKey) {
    console.error("❌ ERRO: Configure SUPABASE_URL e SUPABASE_KEY no .env")
    process.exit(1)
}

const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false }
})

let sock = null
let isStarting = false
let lastQrDataUrl = null
let qrTimeout = null

const connectionStatus = {
    connected: false,
    phone: null,
    status: "disconnected",
}

// Store agora mapeia "NUMERO" -> "NOME" (ex: "551199999999" -> "Mãe")
let contactStore = {}

async function updateStatusInDb(status, qrCode = null, phone = null) {
    try {
        console.log(`[DB] Atualizando status para: ${status}`)
        await supabase.from("instance_settings").upsert({
            id: 1,
            status: status,
            qr_code: qrCode,
            phone: phone,
            updated_at: new Date()
        })
    } catch (err) { console.error("[DB] Erro:", err) }
}

// --- FUNÇÕES AUXILIARES ---

// 🔥 NOVA FUNÇÃO: Extrai apenas o número de telefone de qualquer ID
function extractPhoneNumber(jid) {
    if (!jid) return "";
    // Remove sufixos como @s.whatsapp.net ou @lid e portas :12
    return jid.split('@')[0].split(':')[0];
}

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
    if (msg.message.imageMessage) return "image"
    if (msg.message.videoMessage) return "video"
    if (msg.message.audioMessage) return "audio"
    if (msg.message.documentMessage) return "document"
    if (msg.message.stickerMessage) return "sticker"
    return "text"
}

function prepareMessageForDB(msg, chatId) {
    const type = getMessageType(msg)
    const hasMedia = ["image", "video", "audio", "document", "sticker"].includes(type)
    let mediaMeta = null

    if (hasMedia) {
        try {
            const messageContent = msg.message[type + "Message"]
            if (messageContent) {
                mediaMeta = {
                    url: messageContent.url,
                    mediaKey: messageContent.mediaKey ? Buffer.from(messageContent.mediaKey).toString('base64') : null,
                    mimetype: messageContent.mimetype,
                    fileEncSha256: messageContent.fileEncSha256 ? Buffer.from(messageContent.fileEncSha256).toString('base64') : null,
                    fileSha256: messageContent.fileSha256 ? Buffer.from(messageContent.fileSha256).toString('base64') : null,
                    fileLength: messageContent.fileLength,
                    directPath: messageContent.directPath,
                    iv: messageContent.iv ? Buffer.from(messageContent.iv).toString('base64') : null,
                }
            }
        } catch (e) {}
    }

    return {
        id: msg.key.id,
        chat_id: chatId,
        sender_id: msg.key.participant || msg.key.remoteJid,
        content: getMessageText(msg),
        timestamp: Number(msg.messageTimestamp) * 1000,
        from_me: msg.key.fromMe || false,
        type: type,
        has_media: hasMedia,
        media_meta: mediaMeta,
        ack: msg.status || 0
    }
}

// 🔥 RESOLUÇÃO DE NOME BASEADA NO TELEFONE (Mais robusta)
function resolveChatName(chatId, chatName, pushName) {
    const phone = extractPhoneNumber(chatId);
    
    // 1. Busca pelo número limpo na agenda
    if (contactStore[phone]) return contactStore[phone];
    
    // 2. Nome que veio no chat
    if (chatName) return chatName;
    
    // 3. Nome público
    if (pushName) return pushName;
    
    // 4. Retorna o número
    return phone;
}

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
        })

        sock.ev.on("creds.update", saveCreds)

        if (isManualStart) {
            qrTimeout = setTimeout(async () => {
                if (!sock?.user) {
                    console.log("[TIMEOUT] ⏰ Tempo esgotado.");
                    try { sock.end(undefined); } catch (e) {}
                    sock = null;
                    isStarting = false;
                    await updateStatusInDb("disconnected", null, null);
                }
            }, 5 * 60 * 1000);
        }

        // --- ATUALIZAÇÃO DE CONTATOS ---
        sock.ev.on("contacts.upsert", (contacts) => {
            contacts.forEach(c => { 
                if (c.name) {
                    // Salva mapeando pelo NÚMERO LIMPO
                    const phone = extractPhoneNumber(c.id);
                    contactStore[phone] = c.name;
                }
            })
        })

        // --- PIPELINE DE DADOS ---
        sock.ev.on("messaging-history.set", async ({ chats, contacts, messages }) => {
            console.log(`[SYNC] 🌊 Recebido: ${chats.length} chats, ${messages.length} msgs.`)
            if (qrTimeout) clearTimeout(qrTimeout);

            // 1. Popula contatos na memória (Pelo número limpo)
            if (contacts) {
                contacts.forEach(c => { 
                    if (c.name) {
                        const phone = extractPhoneNumber(c.id);
                        contactStore[phone] = c.name;
                    }
                })
            }

            // 2. PIPELINE DE CHATS
            const privateChats = chats.filter(c => !c.id.includes("@g.us"));
            const CHAT_BATCH_SIZE = 25;
            
            console.log(`[SYNC] Salvando ${privateChats.length} chats (com phone e name)...`);

            for (let i = 0; i < privateChats.length; i += CHAT_BATCH_SIZE) {
                let batch = privateChats.slice(i, i + CHAT_BATCH_SIZE).map(c => {
                    let timestamp = c.conversationTimestamp ? Number(c.conversationTimestamp) : 0;
                    if (timestamp > 0 && timestamp < 946684800000) timestamp = timestamp * 1000;
                    if (timestamp === 0) timestamp = 1000; 
                    
                    const phone = extractPhoneNumber(c.id);

                    return {
                        id: c.id,
                        phone: phone, // 🔥 NOVA COLUNA
                        name: resolveChatName(c.id, c.name, null), // 🔥 NOME RESOLVIDO CORRETAMENTE
                        unread_count: c.unreadCount || 0,
                        is_group: false,
                        is_archived: c.archived || false,
                        last_message_time: timestamp, 
                    };
                });

                const { error } = await supabase.from("chats").upsert(batch, { onConflict: 'id' });
                if (error) console.error(`[SYNC] Erro Chats Lote ${i}:`, error.message);
                
                batch = null; 
                await new Promise(r => setTimeout(r, 100)); 
            }

            // 3. PIPELINE DE MENSAGENS
            const privateMessages = messages.filter(m => m.key.remoteJid && !m.key.remoteJid.includes("@g.us"));
            const MSG_BATCH_SIZE = 50;

            console.log(`[SYNC] Salvando ${privateMessages.length} mensagens...`);

            for (let i = 0; i < privateMessages.length; i += MSG_BATCH_SIZE) {
                let batch = privateMessages.slice(i, i + MSG_BATCH_SIZE).map(m => prepareMessageForDB(m, m.key.remoteJid));
                
                const { error } = await supabase.from("messages").upsert(batch, { onConflict: 'id' });
                if (error) console.error(`[SYNC] Erro Msgs Lote ${i}:`, error.message);
                
                if (i % 500 === 0 && i > 0) console.log(`[SYNC] Progresso: ${i}/${privateMessages.length} msgs.`);

                batch = null; 
                if (global.gc && i % 1000 === 0) global.gc();

                await new Promise(r => setTimeout(r, 200)); 
            }
            
            await updateStatusInDb("connected", null, sock?.user?.id)
            console.log("[SYNC] ✅ Sincronização COMPLETA.")
            if (global.gc) global.gc()
        })

        // --- MENSAGENS EM TEMPO REAL ---
        sock.ev.on("messages.upsert", async ({ messages, type }) => {
            if (type !== "notify" && type !== "append") return
            for (const msg of messages) {
                const chatId = msg.key.remoteJid
                if (!chatId || chatId.includes("@g.us") || chatId === "status@broadcast") continue

                const msgDB = prepareMessageForDB(msg, chatId)
                await supabase.from("messages").upsert(msgDB)

                // Atualiza Chat com nome se for novo
                const phone = extractPhoneNumber(chatId);
                const updateData = {
                    last_message: getMessageText(msg),
                    last_message_time: Number(msg.messageTimestamp) * 1000
                }
                
                // Se chegou mensagem de alguém sem nome, tenta salvar o PushName
                if (!contactStore[phone] && msg.pushName) {
                    updateData.name = msg.pushName
                }
                
                // Se o chat não existir (primeira msg), upsert garante criação
                // Mas para update simples, usamos update.
                // Idealmente, deveríamos fazer um upsert no chat aqui também para garantir.
                // Vamos fazer um update simples para performance.
                await supabase.from("chats").update(updateData).eq("id", chatId)
            }
        })

        sock.ev.on("connection.update", async (update) => {
            const { connection, lastDisconnect, qr } = update
            
            if (qr) {
                lastQrDataUrl = await qrcode.toDataURL(qr)
                connectionStatus.status = "qr"
                console.log("[STATUS] 📱 QR Code")
                await updateStatusInDb("qr", lastQrDataUrl, null)
            }
            
            if (connection === "open") {
                if (qrTimeout) clearTimeout(qrTimeout);
                connectionStatus.connected = true
                connectionStatus.phone = sock.user?.id
                connectionStatus.status = "connected"
                lastQrDataUrl = null
                console.log("[WHATSAPP] ✅ Conectado")
                await updateStatusInDb("connected", null, sock.user?.id)
            }
            
            if (connection === "close") {
                const reason = new Boom(lastDisconnect?.error)?.output?.statusCode
                connectionStatus.connected = false
                connectionStatus.status = "disconnected"
                lastQrDataUrl = null
                
                console.log("[STATUS] ❌ Desconectado. Razão:", reason)
                await updateStatusInDb("disconnected", null, null)

                const hasSession = fs.existsSync("./auth_info/creds.json");
                if (reason !== DisconnectReason.loggedOut && hasSession) {
                    console.log("🔄 Reconectando...");
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

startWhatsApp(false);

const handleShutdown = async (signal) => {
    try {
        await updateStatusInDb("disconnected", null, null);
        if (sock) sock.end(undefined);
    } finally { process.exit(0); }
};
process.on('SIGINT', () => handleShutdown('SIGINT'));
process.on('SIGTERM', () => handleShutdown('SIGTERM'));

// --- ROTAS HTTP ---

app.get("/", (req, res) => res.send("WhatsApp API Online 🚀")); 

app.post("/session/connect", async (req, res) => {
    console.log("[API] Solicitando conexão manual...");
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