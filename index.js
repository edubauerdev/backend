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
const fs = require('fs')

const app = express()
app.use(cors())
app.use(express.json({ limit: '50mb' }))
app.use(express.urlencoded({ limit: '50mb', extended: true }))

// CONFIGURAÇÃO SUPABASE
const supabaseUrl = process.env.SUPABASE_URL
const supabaseKey = process.env.SUPABASE_KEY

if (!supabaseUrl || !supabaseKey) {
    console.error("❌ ERRO: Configure SUPABASE_URL e SUPABASE_KEY no .env")
    process.exit(1)
}

const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false }
})

// ============================================================
// 🔒 ESTADO GLOBAL
// ============================================================
let sock = null
let lastQrDataUrl = null
let qrTimeout = null

// Flags de controle (mutex simples)
let isInitializing = false
let hasSyncedHistory = false
let currentStatus = "disconnected"

let contactStore = {}

// Garante pasta de sessão
if (!fs.existsSync('./auth_info')) {
    fs.mkdirSync('./auth_info', { recursive: true })
}

// ============================================================
// 📡 ATUALIZAÇÃO DE STATUS EM TEMPO REAL
// ============================================================
// STATUS:
//   "disconnected" → Desconectado
//   "qr"           → QR Code aguardando escaneamento  
//   "syncing"      → Sincronizando histórico
//   "connected"    → Conectado e pronto
// ============================================================
async function updateStatus(newStatus, qrCode = null, phone = null) {
    // Evita atualizações duplicadas
    if (currentStatus === newStatus && newStatus !== "qr") {
        return
    }
    
    currentStatus = newStatus
    
    const info = {
        disconnected: "🔴 Desconectado",
        qr: "📱 QR Code aguardando escaneamento",
        syncing: "🔄 Sincronizando mensagens",
        connected: "🟢 Conectado e pronto"
    }
    
    console.log(`[STATUS] ${info[newStatus] || newStatus}`)
    
    try {
        const { error } = await supabase
            .from("instance_settings")
            .upsert({
                id: 1,
                status: newStatus,
                qr_code: newStatus === "qr" ? qrCode : null,
                phone: phone || null,
                updated_at: new Date().toISOString()
            })
        
        if (error) console.error("[DB] Erro:", error.message)
    } catch (err) {
        console.error("[DB] Erro:", err.message)
    }
}

// ============================================================
// 🛠️ FUNÇÕES AUXILIARES
// ============================================================
function getMessageText(msg) {
    if (!msg?.message) return ""
    const c = msg.message
    if (c.conversation) return c.conversation
    if (c.extendedTextMessage?.text) return c.extendedTextMessage.text
    if (c.imageMessage?.caption) return c.imageMessage.caption
    if (c.videoMessage?.caption) return c.videoMessage.caption
    if (c.documentMessage?.caption) return c.documentMessage.caption
    if (c.audioMessage) return "🎵 Áudio"
    if (c.stickerMessage) return "🏷️ Sticker"
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
        const m = msg.message?.imageMessage || msg.message?.videoMessage || 
                  msg.message?.audioMessage || msg.message?.documentMessage || 
                  msg.message?.stickerMessage
        if (m) {
            mediaMeta = {
                mimetype: m.mimetype || null,
                fileLength: m.fileLength ? Number(m.fileLength) : null,
                fileName: m.fileName || null,
                seconds: m.seconds || null,
            }
        }
    }

    return {
        id: msg.key.id,
        chat_id: chatId,
        sender: msg.key.fromMe ? "me" : (msg.key.participant || chatId),
        content: getMessageText(msg),
        timestamp: Number(msg.messageTimestamp) * 1000,
        is_from_me: msg.key.fromMe || false,
        type: type,
        has_media: hasMedia,
        media_metadata: mediaMeta,
    }
}

function resolveChatName(chatId, chatName, pushName) {
    if (chatName?.trim() && !chatName.includes("@")) return chatName
    if (contactStore[chatId]) return contactStore[chatId]
    if (pushName?.trim()) return pushName
    return chatId.split("@")[0]
}

// ============================================================
// 🚀 INICIALIZAÇÃO DO WHATSAPP
// ============================================================
async function startWhatsApp() {
    // LOCK: Evita múltiplas inicializações
    if (isInitializing) {
        console.log("[START] ⚠️ Já inicializando, ignorando...")
        return
    }
    
    isInitializing = true
    hasSyncedHistory = false
    
    console.log("[WHATSAPP] 🚀 Iniciando...")

    // Limpa socket anterior
    if (sock) {
        try {
            sock.ev.removeAllListeners()
            sock.end()
        } catch (e) {}
        sock = null
    }

    try {
        const { state, saveCreds } = await useMultiFileAuthState("./auth_info")
        const { version } = await fetchLatestBaileysVersion()

        sock = makeWASocket({
            version,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" })),
            },
            printQRInTerminal: false,
            logger: pino({ level: "silent" }),
            browser: ["Chrome", "Desktop", "3.0"],
            syncFullHistory: true,
            keepAliveIntervalMs: 30000,
            connectTimeoutMs: 60000,
            emitOwnEvents: true,
            markOnlineOnConnect: true,
            getMessage: async () => undefined,
        })

        sock.ev.on("creds.update", saveCreds)

        // ========================================
        // 📶 CONEXÃO
        // ========================================
        sock.ev.on("connection.update", async (update) => {
            const { connection, lastDisconnect, qr } = update
            
            // QR CODE
            if (qr) {
                lastQrDataUrl = await qrcode.toDataURL(qr)
                await updateStatus("qr", lastQrDataUrl, null)
            }
            
            // CONEXÃO ABERTA → SYNCING
            if (connection === "open") {
                if (qrTimeout) clearTimeout(qrTimeout)
                lastQrDataUrl = null
                await updateStatus("syncing", null, sock.user?.id)
            }
            
            // CONEXÃO FECHADA
            if (connection === "close") {
                const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode
                
                lastQrDataUrl = null
                hasSyncedHistory = false
                isInitializing = false
                
                await updateStatus("disconnected", null, null)

                // Reconecta se não foi logout
                const hasSession = fs.existsSync("./auth_info/creds.json")
                if (statusCode !== DisconnectReason.loggedOut && hasSession) {
                    console.log("[WHATSAPP] 🔄 Reconectando em 5s...")
                    setTimeout(() => startWhatsApp(), 5000)
                } else {
                    sock = null
                }
            }
        })

        // ========================================
        // 📚 SINCRONIZAÇÃO (APENAS 1 VEZ)
        // ========================================
        sock.ev.on("messaging-history.set", async ({ chats, contacts, messages }) => {
            // LOCK: Ignora syncs adicionais silenciosamente
            if (hasSyncedHistory) return
            hasSyncedHistory = true

            console.log(`[SYNC] 📚 Recebido: ${chats.length} chats, ${messages.length} msgs`)

            // Popula contatos
            contacts?.forEach(c => { if (c.name) contactStore[c.id] = c.name })
            messages.forEach(m => {
                if (m.pushName) {
                    const id = m.key.participant || m.key.remoteJid
                    if (!contactStore[id]) contactStore[id] = m.pushName
                }
            })

            // Filtro 6 meses
            const cutoff = Date.now() - (6 * 30 * 24 * 60 * 60 * 1000)

            // CHATS
            const privateChats = chats.filter(c => !c.id.includes("@g.us"))
            console.log(`[SYNC] 💬 Salvando ${privateChats.length} chats...`)

            for (let i = 0; i < privateChats.length; i += 25) {
                const batch = privateChats.slice(i, i + 25).map(c => {
                    let ts = c.conversationTimestamp ? Number(c.conversationTimestamp) : 0
                    if (ts > 0 && ts < 946684800000) ts *= 1000
                    if (ts === 0) ts = 1000

                    return {
                        id: c.id,
                        name: resolveChatName(c.id, c.name, null),
                        unread_count: c.unreadCount || 0,
                        is_group: false,
                        is_archived: c.archived || false,
                        last_message_time: ts,
                    }
                })

                const { error } = await supabase.from("chats").upsert(batch, { onConflict: 'id' })
                if (error) console.error("[SYNC] Erro chats:", error.message)
                await new Promise(r => setTimeout(r, 100))
            }

            // MENSAGENS
            const privateMsgs = messages.filter(m => {
                if (!m.key.remoteJid || m.key.remoteJid.includes("@g.us")) return false
                return Number(m.messageTimestamp) * 1000 >= cutoff
            })

            console.log(`[SYNC] 📝 Salvando ${privateMsgs.length} mensagens...`)

            for (let i = 0; i < privateMsgs.length; i += 50) {
                const batch = privateMsgs.slice(i, i + 50).map(m => 
                    prepareMessageForDB(m, m.key.remoteJid)
                )

                const { error } = await supabase.from("messages").upsert(batch, { onConflict: 'id' })
                if (error) console.error("[SYNC] Erro msgs:", error.message)
                
                if (i > 0 && i % 500 === 0) {
                    console.log(`[SYNC] 📊 ${Math.round((i / privateMsgs.length) * 100)}%`)
                }
                
                await new Promise(r => setTimeout(r, 200))
            }

            // FINALIZADO → CONNECTED
            await updateStatus("connected", null, sock?.user?.id)
            console.log("[SYNC] ✅ Sincronização completa!")
        })

        // ========================================
        // 💬 MENSAGENS EM TEMPO REAL
        // ========================================
        sock.ev.on("messages.upsert", async ({ messages, type }) => {
            if (type !== "notify" && type !== "append") return

            for (const msg of messages) {
                const chatId = msg.key.remoteJid
                if (!chatId || chatId.includes("@g.us") || chatId === "status@broadcast") continue

                const msgDB = prepareMessageForDB(msg, chatId)
                await supabase.from("messages").upsert(msgDB, { onConflict: 'id' })
            }
        })

        isInitializing = false

    } catch (error) {
        console.error("[START] ❌ Erro:", error.message)
        isInitializing = false
        await updateStatus("disconnected", null, null)
    }
}

// ============================================================
// 🔌 INICIALIZAÇÃO
// ============================================================
startWhatsApp()

const shutdown = async (signal) => {
    console.log(`[SERVER] 🛑 ${signal} - Encerrando...`)
    await updateStatus("disconnected", null, null)
    if (sock) {
        sock.ev.removeAllListeners()
        sock.end()
    }
    process.exit(0)
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

// ============================================================
// 🌐 ROTAS HTTP
// ============================================================
app.get("/", (req, res) => res.send("WhatsApp API Online 🚀"))

app.get("/health", (req, res) => res.json({ ok: true, status: currentStatus }))

app.get("/qr", (req, res) => {
    res.json({ 
        qr: currentStatus === "qr" ? lastQrDataUrl : null, 
        status: currentStatus 
    })
})

app.post("/session/connect", async (req, res) => {
    if (currentStatus === "connected" || currentStatus === "syncing") {
        return res.json({ success: true, message: "Já conectado", status: currentStatus })
    }
    
    if (currentStatus === "qr") {
        return res.json({ success: true, message: "QR disponível", status: "qr" })
    }
    
    isInitializing = false
    hasSyncedHistory = false
    startWhatsApp()
    
    res.json({ success: true, message: "Iniciando..." })
})

app.post("/session/disconnect", async (req, res) => {
    try {
        isInitializing = false
        hasSyncedHistory = false
        
        if (sock) await sock.logout()
        
        if (fs.existsSync("./auth_info")) {
            fs.rmSync("./auth_info", { recursive: true, force: true })
            fs.mkdirSync("./auth_info", { recursive: true })
        }
        
        await updateStatus("disconnected", null, null)
        sock = null
        
        res.json({ success: true, message: "Desconectado" })
    } catch (error) {
        res.status(500).json({ success: false, error: error.message })
    }
})

app.get("/chats/avatar/:chatId", async (req, res) => {
    try {
        if (!sock || currentStatus !== "connected") {
            return res.status(503).json({ error: "Não conectado" })
        }
        
        const url = await sock.profilePictureUrl(req.params.chatId, "image").catch(() => null)
        if (!url) return res.status(404).json({ error: "Não encontrado" })
        
        const response = await fetch(url)
        res.set("Content-Type", response.headers.get("content-type") || "image/jpeg")
        res.set("Cache-Control", "public, max-age=86400")
        res.send(Buffer.from(await response.arrayBuffer()))
    } catch (error) {
        res.status(500).json({ error: error.message })
    }
})

app.get("/chats", async (req, res) => {
    try {
        const { data, error } = await supabase
            .from("chats")
            .select("*")
            .order("last_message_time", { ascending: false })
        
        if (error) throw error
        res.json(data)
    } catch (error) {
        res.status(500).json({ error: error.message })
    }
})

app.get("/chats/:chatId/messages", async (req, res) => {
    try {
        const { chatId } = req.params
        const { limit = 50, before } = req.query
        
        let query = supabase
            .from("messages")
            .select("*")
            .eq("chat_id", chatId)
            .order("timestamp", { ascending: false })
            .limit(Number(limit))
        
        if (before) query = query.lt("timestamp", Number(before))
        
        const { data, error } = await query
        if (error) throw error
        res.json(data)
    } catch (error) {
        res.status(500).json({ error: error.message })
    }
})

app.get("/media/:chatId/:messageId", async (req, res) => {
    try {
        if (!sock || currentStatus !== "connected") {
            return res.status(503).json({ error: "Não conectado" })
        }
        
        const msg = await sock.loadMessage(req.params.chatId, req.params.messageId)
        if (!msg) return res.status(404).json({ error: "Não encontrada" })
        
        const buffer = await downloadMediaMessage(msg, "buffer", {})
        const media = msg.message?.imageMessage || msg.message?.videoMessage || 
                      msg.message?.audioMessage || msg.message?.documentMessage
        
        res.set("Content-Type", media?.mimetype || "application/octet-stream")
        res.set("Cache-Control", "public, max-age=86400")
        res.send(buffer)
    } catch (error) {
        res.status(500).json({ error: error.message })
    }
})

app.post("/chats/send", async (req, res) => {
    try {
        const { chatId, message } = req.body
        
        if (!sock || currentStatus !== "connected") {
            return res.status(503).json({ error: "Não conectado" })
        }
        
        if (!chatId || !message) {
            return res.status(400).json({ error: "chatId e message obrigatórios" })
        }
        
        const result = await sock.sendMessage(chatId, { text: message })
        res.json({ success: true, messageId: result.key.id })
    } catch (error) {
        res.status(500).json({ error: error.message })
    }
})

const PORT = process.env.PORT || 3000
app.listen(PORT, () => console.log(`[SERVER] 🌐 Porta ${PORT}`))