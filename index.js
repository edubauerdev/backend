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
} = require("@whiskeysockets/baileys")
const qrcode = require("qrcode")

const app = express()
app.use(cors())

// AJUSTE DE LIMITE DE PAYLOAD
app.use(express.json({ limit: '50mb' })) // Aumentado para 50mb por segurança
app.use(express.urlencoded({ limit: '50mb', extended: true }))

// CONFIGURAÇÃO SUPABASE
const supabaseUrl = process.env.SUPABASE_URL
const supabaseKey = process.env.SUPABASE_KEY

if (!supabaseUrl || !supabaseKey) {
    console.error("❌ ERRO: Configure SUPABASE_URL e SUPABASE_KEY no .env")
    process.exit(1)
}

const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false } // Otimização para backend
})

// ESTADO
let sock = null
let isStarting = false
let lastQrDataUrl = null
const connectionStatus = {
    connected: false,
    phone: null,
    status: "disconnected",
}

// Store local apenas para contatos
let contactStore = {}

// --- FUNÇÃO DE STATUS DO BANCO ---
async function updateStatusInDb(status, qrCode = null, phone = null) {
    try {
        console.log(`[DB] Atualizando status para: ${status}`)
        const { error } = await supabase.from("instance_settings").upsert({
            id: 1,
            status: status,
            qr_code: qrCode,
            phone: phone,
            updated_at: new Date()
        })
        
        if (error) console.error("[DB] Erro ao salvar status:", error.message)
    } catch (err) {
        console.error("[DB] Erro crítico status:", err)
    }
}

// --- FUNÇÕES AUXILIARES ---

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

function resolveChatName(chatId, chatName, pushName) {
    if (contactStore[chatId]) return contactStore[chatId];
    if (chatName) return chatName;
    if (pushName) return pushName;
    return chatId.split('@')[0];
}

// --- WHATSAPP START ---
async function startWhatsApp() {
    if (isStarting) return
    isStarting = true

    // Reseta status no inicio
    await updateStatusInDb("disconnected", null, null);

    try {
        console.log("[WHATSAPP] 🚀 Iniciando...")
        const { version } = await fetchLatestBaileysVersion()
        const logger = pino({ level: "silent" }) // Mude para 'info' se quiser ver logs do Baileys
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
            keepAliveIntervalMs: 20000, // Ping mais frequente
            retryRequestDelayMs: 5000,
        })

        sock.ev.on("creds.update", saveCreds)

        sock.ev.on("contacts.upsert", (contacts) => {
            contacts.forEach(c => {
                if (c.name) contactStore[c.id] = c.name;
            })
        })

        // --- SINCRONIZAÇÃO OTIMIZADA EM LOTES ---
        sock.ev.on("messaging-history.set", async ({ chats, contacts, messages }) => {
            console.log(`[SYNC] 🌊 Iniciando Importação: ${chats.length} chats, ${messages.length} msgs.`)

            if (contacts) {
                contacts.forEach(c => { if (c.name) contactStore[c.id] = c.name })
            }

            // 1. Processa CHATS em Lotes de 50 (Menor lote para garantir)
            const privateChats = chats.filter(c => !c.id.includes("@g.us"));
            const totalChats = privateChats.length;
            
            // Mapa para data
            const lastMsgMap = {};
            messages.forEach(msg => {
                const jid = msg.key.remoteJid;
                const ts = Number(msg.messageTimestamp);
                if (!lastMsgMap[jid] || ts > lastMsgMap[jid]) lastMsgMap[jid] = ts;
            });

            for (let i = 0; i < totalChats; i += 50) {
                const batch = privateChats.slice(i, i + 50).map(c => {
                    let timestamp = 0;
                    if (lastMsgMap[c.id]) timestamp = lastMsgMap[c.id];
                    else if (c.conversationTimestamp) timestamp = Number(c.conversationTimestamp);

                    if (timestamp > 0 && timestamp < 946684800000) timestamp = timestamp * 1000;
                    if (timestamp === 0) timestamp = 1000; 

                    return {
                        id: c.id,
                        name: resolveChatName(c.id, c.name, null), 
                        unread_count: c.unreadCount || 0,
                        is_group: false,
                        is_archived: c.archived || false,
                        last_message_time: timestamp, 
                    };
                });

                const { error } = await supabase.from("chats").upsert(batch, { onConflict: 'id' });
                if (error) console.error(`[SYNC] Erro Chats Lote ${i}:`, error.message);
                
                // Pequena pausa para respirar o Event Loop
                await new Promise(r => setTimeout(r, 50)); 
            }
            console.log(`[SYNC] Chats processados.`);

            // 2. Processa MENSAGENS em Lotes de 100
            const privateMessages = messages.filter(m => m.key.remoteJid && !m.key.remoteJid.includes("@g.us"));
            const totalMsgs = privateMessages.length;

            for (let i = 0; i < totalMsgs; i += 100) {
                const batch = privateMessages.slice(i, i + 100).map(m => prepareMessageForDB(m, m.key.remoteJid));
                
                const { error } = await supabase.from("messages").upsert(batch, { onConflict: 'id' });
                if (error) console.error(`[SYNC] Erro Msgs Lote ${i}:`, error.message);
                
                // Log de progresso a cada 1000 mensagens
                if (i % 1000 === 0 && i > 0) console.log(`[SYNC] ${i}/${totalMsgs} mensagens salvas...`);
                
                await new Promise(r => setTimeout(r, 100)); // Pausa maior para mensagens (mais pesado)
            }
            
            console.log("[SYNC] ✅ Sincronização COMPLETA.")
            
            // Só marca como conectado depois de terminar tudo
            await updateStatusInDb("connected", null, sock?.user?.id)
            
            if (global.gc) global.gc()
        })

        // ... (eventos messages.upsert e connection.update mantidos IGUAIS, apenas garanta que updateStatusInDb esteja lá) ...
        
        sock.ev.on("messages.upsert", async ({ messages, type }) => {
            if (type !== "notify" && type !== "append") return
            for (const msg of messages) {
                const chatId = msg.key.remoteJid
                if (!chatId || chatId.includes("@g.us") || chatId === "status@broadcast") continue

                const msgDB = prepareMessageForDB(msg, chatId)
                await supabase.from("messages").upsert(msgDB)

                const updateData = {
                    last_message: getMessageText(msg),
                    last_message_time: Number(msg.messageTimestamp) * 1000
                }
                if (!contactStore[chatId] && msg.pushName) {
                    updateData.name = msg.pushName
                }
                await supabase.from("chats").update(updateData).eq("id", chatId)
            }
        })

        sock.ev.on("connection.update", async (update) => {
            const { connection, lastDisconnect, qr } = update
            
            if (qr) {
                lastQrDataUrl = await qrcode.toDataURL(qr)
                connectionStatus.status = "qr"
                console.log("[STATUS] 📱 QR Code gerado")
                await updateStatusInDb("qr", lastQrDataUrl, null)
            }
            
            if (connection === "open") {
                connectionStatus.connected = true
                connectionStatus.phone = sock.user?.id
                connectionStatus.status = "connected"
                lastQrDataUrl = null
                console.log("[WHATSAPP] ✅ Online")
                await updateStatusInDb("connected", null, sock.user?.id)
            }
            
            if (connection === "close") {
                const reason = new Boom(lastDisconnect?.error)?.output?.statusCode
                connectionStatus.connected = false
                connectionStatus.status = "disconnected"
                lastQrDataUrl = null
                
                console.log("[STATUS] ❌ Desconectado. Razão:", reason)
                await updateStatusInDb("disconnected", null, null)

                if (reason !== DisconnectReason.loggedOut) {
                    isStarting = false
                    setTimeout(startWhatsApp, 3000)
                } else {
                    await updateStatusInDb("disconnected", null, null)
                }
            }
        })

    } catch (err) {
        console.error("Erro start:", err)
        await updateStatusInDb("error", null, null)
        isStarting = false
    }
}

startWhatsApp()

const handleShutdown = async (signal) => {
    console.log(`[SERVER] 🛑 Recebido sinal: ${signal}`);
    try {
        await updateStatusInDb("disconnected", null, null);
        console.log("[DB] Status off.");
        if (sock) sock.end(undefined);
    } catch (err) {
        console.error("[SERVER] Erro off:", err);
    } finally {
        process.exit(0);
    }
};

process.on('SIGINT', () => handleShutdown('SIGINT'));
process.on('SIGTERM', () => handleShutdown('SIGTERM'));

// ROTAS
app.get("/health", (req, res) => res.json({ ok: true, status: connectionStatus }))
app.get("/qr", (req, res) => { if (connectionStatus.connected) return res.send("ALREADY_CONNECTED"); if (!lastQrDataUrl) return res.status(202).send("QR_NOT_READY"); return res.send(lastQrDataUrl) })
// ... (rotas chats, messages, media, send, logout mantidas IGUAIS) ...
// Para garantir que não faltou nada, vou incluir as rotas resumidas aqui para copiar/colar seguro:

app.get("/chats", async (req, res) => {
    const limit = Number(req.query.limit) || 20
    const offset = Number(req.query.offset) || 0
    try {
        const { data: chats, error, count } = await supabase.from('chats').select('*', { count: 'exact' }).eq('is_archived', false).not('id', 'ilike', '%@g.us').order('last_message_time', { ascending: false }).range(offset, offset + limit - 1)
        if (error) throw error
        if (connectionStatus.connected && sock) {
            const chatsMissingPic = chats.filter(c => !c.image_url);
            await Promise.allSettled(chatsMissingPic.map(async (c) => {
                try { const url = await sock.profilePictureUrl(c.id, "image"); if (url) { c.image_url = url; await supabase.from("chats").update({ image_url: url }).eq("id", c.id) } } catch (e) {}
            }))
        }
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
    if (chatId?.includes("@g.us")) return res.status(403).json({ success: false })
    if (!connectionStatus.connected || !sock) return res.status(400).json({ success: false })
    try {
        const result = await sock.sendMessage(chatId, { text: message })
        res.json({ success: true, messageId: result?.key?.id })
    } catch (error) { res.status(500).json({ success: false, error: error.message }) }
})

app.post("/logout", async (req, res) => {
    try {
        if (sock) await sock.logout()
        connectionStatus.connected = false
        await updateStatusInDb("disconnected", null, null)
        res.json({ success: true })
    } catch (err) { res.status(500).json({ success: false }) }
})

const PORT = process.env.PORT || 3000
app.listen(PORT, () => console.log(`[SERVER] 🌐 Porta ${PORT}`))