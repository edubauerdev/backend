require("dotenv").config()
const express = require("express")
const cors = require("cors")
const fs = require("fs")
const pino = require("pino")
const { Boom } = require("@hapi/boom")
const { createClient } = require("@supabase/supabase-js")
const qrcode = require("qrcode")
const {
    default: makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    DisconnectReason,
    makeCacheableSignalKeyStore,
    downloadMediaMessage,
} = require("@whiskeysockets/baileys")

// ═══════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════
const app = express()
app.use(cors())
app.use(express.json({ limit: "50mb" }))

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
    auth: { persistSession: false }
})

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
    console.error("❌ Configure SUPABASE_URL e SUPABASE_KEY no .env")
    process.exit(1)
}

// ═══════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════
let sock = null
let qrDataUrl = null
let syncTimeout = null
let currentPhone = null

const SYNC_TIMEOUT_MS = 15000
const SIX_MONTHS_MS = 6 * 30 * 24 * 60 * 60 * 1000
const BATCH_SIZE = 100

const status = { state: "disconnected", phone: null }

// ═══════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════
const isGroup = (id) => id?.includes("@g.us")
const isLid = (id) => id?.includes("@lid")
const getPhone = (id) => id && !isLid(id) ? id.split("@")[0] : null
const normalizePhone = (id) => id?.split("@")[0]?.split(":")[0] || null

const log = (tag, msg) => console.log(`[${tag}] ${msg}`)

async function updateStatus(newState, phone = null) {
    status.state = newState
    status.phone = phone || status.phone
    
    const data = { id: 1, status: newState, updated_at: new Date().toISOString() }
    if (newState === "qr" && qrDataUrl) data.qr_code = qrDataUrl
    else data.qr_code = null
    if (phone) data.phone = phone
    
    await supabase.from("instance_settings").upsert(data)
    log("STATUS", `${newState}${phone ? ` (${normalizePhone(phone)})` : ""}`)
}

// ═══════════════════════════════════════════════════════════
// DATABASE
// ═══════════════════════════════════════════════════════════
async function findChatByPhone(phone) {
    if (!phone) return null
    const { data } = await supabase
        .from("chats")
        .select("uuid, id, phone")
        .eq("phone", phone)
        .limit(1)
        .single()
    return data
}

async function saveChats(chats) {
    if (!chats.length) return new Map()
    
    const uuidMap = new Map()
    const phones = chats.map(c => getPhone(c.id)).filter(Boolean)
    
    // Buscar UUIDs existentes
    const { data: existing } = await supabase
        .from("chats")
        .select("uuid, phone")
        .in("phone", phones)
    
    const existingMap = new Map(existing?.map(c => [c.phone, c.uuid]) || [])
    
    // Separar: atualizar existentes vs inserir novos
    const toUpdate = []
    const toInsert = []
    
    for (const chat of chats) {
        const phone = getPhone(chat.id)
        if (phone && existingMap.has(phone)) {
            toUpdate.push({ ...chat, _uuid: existingMap.get(phone) })
            uuidMap.set(chat.id, existingMap.get(phone))
        } else {
            toInsert.push(chat)
        }
    }
    
    // Atualizar existentes (preserva UUID)
    for (const chat of toUpdate) {
        const uuid = chat._uuid
        delete chat._uuid
        await supabase.from("chats").update(chat).eq("uuid", uuid)
    }
    
    // Inserir novos
    if (toInsert.length) {
        for (let i = 0; i < toInsert.length; i += BATCH_SIZE) {
            const batch = toInsert.slice(i, i + BATCH_SIZE)
            const { data } = await supabase
                .from("chats")
                .upsert(batch, { onConflict: "id", ignoreDuplicates: false })
                .select("id, uuid")
            data?.forEach(c => uuidMap.set(c.id, c.uuid))
        }
    }
    
    return uuidMap
}

async function saveMessages(messages) {
    if (!messages.length) return
    for (let i = 0; i < messages.length; i += BATCH_SIZE) {
        const batch = messages.slice(i, i + BATCH_SIZE)
        await supabase.from("messages").upsert(batch, { onConflict: "id" })
    }
}

// ═══════════════════════════════════════════════════════════
// PHONE CHANGE DETECTION
// ═══════════════════════════════════════════════════════════
async function handlePhoneChange(newPhoneId) {
    const newPhone = normalizePhone(newPhoneId)
    if (!newPhone) return
    
    const { data } = await supabase
        .from("instance_settings")
        .select("phone")
        .eq("id", 1)
        .single()
    
    const oldPhone = normalizePhone(data?.phone)
    
    if (oldPhone && oldPhone !== newPhone) {
        log("PHONE", `Mudou: ${oldPhone} → ${newPhone}`)
        
        // Desassociar chats antigos
        await supabase
            .from("chats")
            .update({ connected_phone: null })
            .eq("connected_phone", oldPhone)
        
        // Deletar mensagens antigas
        await supabase.from("messages").delete().neq("id", "")
        
        log("PHONE", "Dados anteriores limpos")
    }
    
    currentPhone = newPhone
}

async function cleanup() {
    log("CLEAN", "Limpando dados...")
    
    await supabase.from("messages").delete().neq("id", "")
    await supabase.from("chats").update({
        id: null, connected_phone: null, push_name: null,
        is_lid: false, is_archived: false, unread_count: 0,
        last_message_time: null, lid_metadata: null
    }).neq("uuid", "")
    await supabase.from("instance_settings").update({
        status: "disconnected", qr_code: null, phone: null
    }).eq("id", 1)
    
    currentPhone = null
    log("CLEAN", "Concluído")
}

// ═══════════════════════════════════════════════════════════
// MESSAGE PARSER
// ═══════════════════════════════════════════════════════════
function parseMessage(msg, chatUuid) {
    const content = msg.message
    if (!content) return null
    
    let type = "text", text = "", hasMedia = false, mediaType = null
    
    if (content.conversation) {
        text = content.conversation
    } else if (content.extendedTextMessage) {
        text = content.extendedTextMessage.text || ""
    } else if (content.imageMessage) {
        type = "image"; hasMedia = true; mediaType = "image"
        text = content.imageMessage.caption || ""
    } else if (content.videoMessage) {
        type = "video"; hasMedia = true; mediaType = "video"
        text = content.videoMessage.caption || ""
    } else if (content.audioMessage) {
        type = "audio"; hasMedia = true; mediaType = "audio"
    } else if (content.documentMessage) {
        type = "document"; hasMedia = true; mediaType = "document"
        text = content.documentMessage.fileName || ""
    } else if (content.stickerMessage) {
        type = "sticker"; hasMedia = true; mediaType = "sticker"
    } else {
        type = "unknown"
    }
    
    let timestamp = Number(msg.messageTimestamp) || Date.now()
    if (timestamp < 1000000000000) timestamp *= 1000
    
    return {
        id: msg.key.id,
        chat_id: msg.key.remoteJid,
        chat_uuid: chatUuid,
        sender: msg.key.fromMe ? "me" : (msg.key.participant || msg.key.remoteJid),
        content: text,
        type,
        timestamp,
        is_from_me: msg.key.fromMe || false,
        has_media: hasMedia,
        media_type: mediaType,
        push_name: msg.pushName || null,
        raw_data: msg
    }
}

// ═══════════════════════════════════════════════════════════
// WHATSAPP CONNECTION
// ═══════════════════════════════════════════════════════════
async function startWhatsApp() {
    log("WA", "🚀 Iniciando...")
    
    if (sock) {
        try { sock.end() } catch {}
        sock = null
    }
    
    if (!fs.existsSync("./auth_info")) {
        fs.mkdirSync("./auth_info", { recursive: true })
    }
    
    const { state, saveCreds } = await useMultiFileAuthState("./auth_info")
    const { version } = await fetchLatestBaileysVersion()
    
    sock = makeWASocket({
        version,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" }))
        },
        printQRInTerminal: false,
        logger: pino({ level: "silent" }),
        browser: ["Chrome", "Desktop", "3.0"],
        syncFullHistory: true,
        getMessage: async () => undefined
    })
    
    sock.ev.on("creds.update", saveCreds)
    
    // ─────────────────────────────────────────────────────
    // CONNECTION UPDATE
    // ─────────────────────────────────────────────────────
    sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
        if (qr) {
            qrDataUrl = await qrcode.toDataURL(qr)
            await updateStatus("qr")
            log("WA", "📱 QR Code gerado")
        }
        
        if (connection === "open") {
            qrDataUrl = null
            await handlePhoneChange(sock.user?.id)
            await updateStatus("syncing", sock.user?.id)
            log("WA", "🔄 Conectado - Sincronizando...")
        }
        
        if (connection === "close") {
            const code = new Boom(lastDisconnect?.error)?.output?.statusCode
            qrDataUrl = null
            if (syncTimeout) clearTimeout(syncTimeout)
            
            await updateStatus("disconnected")
            log("WA", `🔴 Desconectado (${DisconnectReason[code] || code})`)
            
            if (code === DisconnectReason.loggedOut || !fs.existsSync("./auth_info/creds.json")) {
                await cleanup()
                sock = null
            } else {
                log("WA", "🔄 Reconectando em 5s...")
                setTimeout(startWhatsApp, 5000)
            }
        }
    })
    
    // ─────────────────────────────────────────────────────
    // HISTORY SYNC
    // ─────────────────────────────────────────────────────
    sock.ev.on("messaging-history.set", async ({ chats, messages, isLatest }) => {
        log("SYNC", `📦 Chunk: ${chats.length} chats, ${messages.length} msgs`)
        
        const cutoff = Date.now() - SIX_MONTHS_MS
        
        // Filtrar privados
        const privateChats = chats.filter(c => !isGroup(c.id))
        const privateMessages = messages.filter(m => {
            if (isGroup(m.key?.remoteJid)) return false
            const ts = Number(m.messageTimestamp) * 1000
            return ts >= cutoff
        })
        
        // Preparar chats
        const chatRecords = privateChats.map(c => {
            let ts = Number(c.conversationTimestamp) || Date.now()
            if (ts < 1000000000000) ts *= 1000
            
            return {
                id: c.id,
                phone: getPhone(c.id),
                is_lid: isLid(c.id),
                is_group: false,
                is_archived: c.archived || false,
                unread_count: c.unreadCount || 0,
                last_message_time: ts,
                connected_phone: currentPhone,
                push_name: c.name || c.notify || null,
                lid_metadata: isLid(c.id) ? { pnJid: c.pnJid, lidJid: c.lidJid } : null
            }
        })
        
        // Salvar chats
        const uuidMap = await saveChats(chatRecords)
        
        // Preparar mensagens
        const msgRecords = privateMessages
            .map(m => parseMessage(m, uuidMap.get(m.key.remoteJid)))
            .filter(Boolean)
        
        // Salvar mensagens
        await saveMessages(msgRecords)
        
        // Reset timeout
        if (syncTimeout) clearTimeout(syncTimeout)
        
        // Finalizar sync
        const finalize = async () => {
            if (status.state !== "syncing") return
            await updateStatus("connected", sock?.user?.id)
            log("SYNC", "✅ Completo")
            if (global.gc) global.gc()
        }
        
        if (isLatest) {
            await finalize()
        } else {
            syncTimeout = setTimeout(finalize, SYNC_TIMEOUT_MS)
        }
    })
    
    // ─────────────────────────────────────────────────────
    // NEW MESSAGES
    // ─────────────────────────────────────────────────────
    sock.ev.on("messages.upsert", async ({ messages, type }) => {
        if (type !== "notify") return
        
        for (const msg of messages) {
            const chatId = msg.key?.remoteJid
            if (!chatId || isGroup(chatId)) continue
            
            // Buscar/criar chat
            let chatUuid = null
            const phone = getPhone(chatId)
            
            if (phone) {
                const existing = await findChatByPhone(phone)
                chatUuid = existing?.uuid
            }
            
            if (!chatUuid) {
                const { data } = await supabase
                    .from("chats")
                    .upsert({
                        id: chatId,
                        phone: phone,
                        is_lid: isLid(chatId),
                        is_group: false,
                        connected_phone: currentPhone,
                        last_message_time: Date.now(),
                        push_name: msg.pushName || null
                    }, { onConflict: "id" })
                    .select("uuid")
                    .single()
                chatUuid = data?.uuid
            }
            
            // Atualizar last_message_time
            await supabase
                .from("chats")
                .update({ last_message_time: Date.now(), unread_count: supabase.rpc ? 0 : 0 })
                .eq("uuid", chatUuid)
            
            // Salvar mensagem
            const msgRecord = parseMessage(msg, chatUuid)
            if (msgRecord) {
                await supabase.from("messages").upsert(msgRecord, { onConflict: "id" })
            }
        }
    })
}

// ═══════════════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════════════
app.get("/", (_, res) => res.send("WhatsApp API 🚀"))

app.get("/health", (_, res) => res.json({
    ok: true,
    status: status.state,
    phone: status.phone ? normalizePhone(status.phone) : null,
    memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + "MB"
}))

app.get("/status", (_, res) => res.json({
    connected: status.state === "connected",
    status: status.state,
    phone: status.phone ? normalizePhone(status.phone) : null
}))

app.get("/qr", (_, res) => {
    res.json({
        qr: status.state === "qr" ? qrDataUrl : null,
        status: status.state
    })
})

app.post("/session/connect", async (_, res) => {
    if (status.state === "connected" || status.state === "syncing") {
        return res.json({ success: true, message: "Já conectado" })
    }
    startWhatsApp()
    res.json({ success: true, message: "Iniciando..." })
})

app.post("/session/disconnect", async (_, res) => {
    if (syncTimeout) clearTimeout(syncTimeout)
    if (sock) {
        try { await sock.logout() } catch {}
        sock.end()
        sock = null
    }
    if (fs.existsSync("./auth_info")) {
        fs.rmSync("./auth_info", { recursive: true, force: true })
        fs.mkdirSync("./auth_info", { recursive: true })
    }
    await cleanup()
    res.json({ success: true, message: "Desconectado" })
})

app.post("/logout", async (req, res) => {
    // Alias para /session/disconnect
    if (syncTimeout) clearTimeout(syncTimeout)
    if (sock) {
        try { await sock.logout() } catch {}
        sock.end()
        sock = null
    }
    if (fs.existsSync("./auth_info")) {
        fs.rmSync("./auth_info", { recursive: true, force: true })
        fs.mkdirSync("./auth_info", { recursive: true })
    }
    await cleanup()
    res.json({ success: true, message: "Desconectado" })
})

// ─────────────────────────────────────────────────────
// CHATS
// ─────────────────────────────────────────────────────
app.get("/chats", async (req, res) => {
    const { limit = 50, offset = 0 } = req.query
    
    let query = supabase
        .from("chats")
        .select("*")
        .order("last_message_time", { ascending: false })
        .range(Number(offset), Number(offset) + Number(limit) - 1)
    
    if (currentPhone) {
        query = query.eq("connected_phone", currentPhone)
    } else {
        query = query.not("id", "is", null)
    }
    
    const { data, error } = await query
    if (error) return res.status(500).json({ error: error.message })
    res.json(data)
})

app.get("/chats/uuid/:uuid", async (req, res) => {
    const { data, error } = await supabase
        .from("chats")
        .select("*")
        .eq("uuid", req.params.uuid)
        .single()
    if (error) return res.status(404).json({ error: "Chat não encontrado" })
    res.json(data)
})

app.get("/chats/phone/:phone", async (req, res) => {
    const chat = await findChatByPhone(req.params.phone)
    if (!chat) return res.status(404).json({ error: "Chat não encontrado" })
    res.json(chat)
})

app.get("/chats/avatar/:chatId", async (req, res) => {
    try {
        if (!sock || status.state !== "connected") {
            return res.status(503).json({ error: "WhatsApp offline" })
        }
        const url = await sock.profilePictureUrl(req.params.chatId, "image").catch(() => null)
        if (!url) return res.status(404).json({ error: "Não encontrado" })
        
        const response = await fetch(url)
        const buffer = await response.arrayBuffer()
        res.set("Content-Type", response.headers.get("content-type") || "image/jpeg")
        res.send(Buffer.from(buffer))
    } catch (e) {
        res.status(500).json({ error: e.message })
    }
})

// ─────────────────────────────────────────────────────
// MESSAGES
// ─────────────────────────────────────────────────────
app.get("/chats/:chatId/messages", async (req, res) => {
    const { limit = 50, offset = 0 } = req.query
    const { data, error } = await supabase
        .from("messages")
        .select("*")
        .eq("chat_id", req.params.chatId)
        .order("timestamp", { ascending: false })
        .range(Number(offset), Number(offset) + Number(limit) - 1)
    
    if (error) return res.status(500).json({ error: error.message })
    res.json({ success: true, messages: data || [] })
})

app.get("/chats/uuid/:uuid/messages", async (req, res) => {
    const { limit = 50, offset = 0 } = req.query
    const { data, error } = await supabase
        .from("messages")
        .select("*")
        .eq("chat_uuid", req.params.uuid)
        .order("timestamp", { ascending: false })
        .range(Number(offset), Number(offset) + Number(limit) - 1)
    
    if (error) return res.status(500).json({ error: error.message })
    res.json({ success: true, messages: data || [] })
})

// ─────────────────────────────────────────────────────
// SEND
// ─────────────────────────────────────────────────────
app.post("/chats/send", async (req, res) => {
    try {
        const { chatId, message } = req.body
        if (!sock || status.state !== "connected") {
            return res.status(503).json({ success: false, error: "WhatsApp offline" })
        }
        if (!chatId || !message) {
            return res.status(400).json({ success: false, error: "chatId e message obrigatórios" })
        }
        
        const result = await sock.sendMessage(chatId, { text: message })
        res.json({ success: true, messageId: result.key.id })
    } catch (e) {
        res.status(500).json({ success: false, error: e.message })
    }
})

app.post("/chats/send-media", async (req, res) => {
    try {
        const { chatId, type, mediaUrl, caption, fileName, mimetype } = req.body
        
        if (!sock || status.state !== "connected") {
            return res.status(503).json({ success: false, error: "WhatsApp offline" })
        }
        if (!chatId || !mediaUrl) {
            return res.status(400).json({ success: false, error: "chatId e mediaUrl obrigatórios" })
        }
        
        // Decodificar base64
        const base64Data = mediaUrl.split(",")[1] || mediaUrl
        const buffer = Buffer.from(base64Data, "base64")
        
        let messageContent = {}
        
        if (type === "image") {
            messageContent = { image: buffer, caption: caption || undefined }
        } else if (type === "video") {
            messageContent = { video: buffer, caption: caption || undefined }
        } else if (type === "audio") {
            messageContent = { audio: buffer, mimetype: mimetype || "audio/mp4" }
        } else {
            messageContent = {
                document: buffer,
                mimetype: mimetype || "application/octet-stream",
                fileName: fileName || "file"
            }
        }
        
        const result = await sock.sendMessage(chatId, messageContent)
        res.json({ success: true, messageId: result.key.id })
    } catch (e) {
        res.status(500).json({ success: false, error: e.message })
    }
})

// ─────────────────────────────────────────────────────
// MEDIA DOWNLOAD
// ─────────────────────────────────────────────────────
app.get("/media/:chatId/:msgId", async (req, res) => {
    try {
        if (!sock || status.state !== "connected") {
            return res.status(503).json({ error: "WhatsApp offline" })
        }
        
        // Buscar mensagem no banco
        const { data: msg } = await supabase
            .from("messages")
            .select("raw_data")
            .eq("id", req.params.msgId)
            .single()
        
        if (!msg?.raw_data) {
            return res.status(404).json({ error: "Mensagem não encontrada" })
        }
        
        const buffer = await downloadMediaMessage(msg.raw_data, "buffer", {})
        const content = msg.raw_data.message
        
        let mimetype = "application/octet-stream"
        if (content?.imageMessage) mimetype = content.imageMessage.mimetype || "image/jpeg"
        else if (content?.videoMessage) mimetype = content.videoMessage.mimetype || "video/mp4"
        else if (content?.audioMessage) mimetype = content.audioMessage.mimetype || "audio/ogg"
        else if (content?.documentMessage) mimetype = content.documentMessage.mimetype
        
        res.set("Content-Type", mimetype)
        res.send(buffer)
    } catch (e) {
        res.status(500).json({ error: e.message })
    }
})

// ═══════════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════════
if (fs.existsSync("./auth_info/creds.json")) {
    log("INIT", "Sessão encontrada, reconectando...")
    startWhatsApp()
} else {
    log("INIT", "Aguardando /session/connect")
    updateStatus("disconnected")
}

const shutdown = async (sig) => {
    log("SHUTDOWN", sig)
    await updateStatus("disconnected")
    if (sock) { try { sock.end() } catch {} }
    process.exit(0)
}
process.on("SIGINT", () => shutdown("SIGINT"))
process.on("SIGTERM", () => shutdown("SIGTERM"))

const PORT = process.env.PORT || 3000
app.listen(PORT, () => log("SERVER", `🌐 Porta ${PORT}`))
