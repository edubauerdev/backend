const express = require("express")
const cors = require("cors")
const { Boom } = require("@hapi/boom")
const pino = require("pino")
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

// -------------------------
// AJUSTE DE LIMITE DE PAYLOAD
// Define o limite máximo de corpo da requisição (payload) para 20 megabytes (20mb).
app.use(express.json({ limit: '20mb' }))
app.use(express.urlencoded({ limit: '20mb', extended: true }))
// -------------------------


// -------------------------
// Estado em memória
// -------------------------
let sock = null
let isStarting = false
let lastQrDataUrl = null

let chatsStore = {}
let messagesStore = {}
let contactsStore = {} // 🟢 CORREÇÃO 1: Adição do contactsStore

const connectionStatus = {
    connected: false,
    phone: null,
    status: "disconnected",
}

// -------------------------
// Função auxiliar para extrair texto da mensagem
// -------------------------
function getMessageText(msg) {
    if (!msg || !msg.message) return ""

    const messageContent = msg.message

    if (messageContent.conversation) return messageContent.conversation
    if (messageContent.extendedTextMessage?.text) return messageContent.extendedTextMessage.text
    if (messageContent.imageMessage?.caption) return `[Imagem] ${messageContent.imageMessage.caption || ""}`
    if (messageContent.videoMessage?.caption) return `[Vídeo] ${messageContent.videoMessage.caption || ""}`
    if (messageContent.documentMessage?.caption) return `[Documento] ${messageContent.documentMessage.caption || ""}`
    if (messageContent.audioMessage) return "[Áudio]"
    if (messageContent.stickerMessage) return "[Sticker]"
    if (messageContent.contactMessage) return "[Contato]"
    if (messageContent.locationMessage) return "[Localização]"

    return "[Mensagem]"
}

// -------------------------
// Função para normalizar chats para o formato do frontend
// TORNADA ASSÍNCRONA PARA BUSCAR A FOTO DE PERFIL
// -------------------------
async function normalizeChatForFrontend(chat) { // <--- ALTERADO: Adicionado 'async'
    const chatId = chat.id
    const chatMessages = messagesStore[chatId] || []
    
    // ... (restante da lógica de lastMsg) ...

    const sortedMessages = [...chatMessages].sort(
        (a, b) => (Number(b.messageTimestamp) || 0) - (Number(a.messageTimestamp) || 0),
    )
    const lastMsg = sortedMessages[0]

    // 🟢 CORREÇÃO 3: Lógica de prioridade para o nome do chat
    const contactInfo = contactsStore[chatId] || {}
    
    let chatName = 
        contactInfo.name || 
        chat.name || 
        chat.notify || 
        chat.verifiedName ||
        chat.subject || 
        ""

    if (!chatName) {
        if (chatId.includes("@g.us")) {
            chatName = "Grupo"
        } else {
            chatName = chatId.split("@")[0] // Fallback para o número (ID)
        }
    }
    // FIM da Correção 3
    
    // ------------------------------------
    // 📸 NOVO: Busca Assíncrona da Foto de Perfil
    let profilePicUrl = null
    if (sock && connectionStatus.connected) {
        try {
            profilePicUrl = await sock.profilePictureUrl(chatId, "image")
        } catch (e) {
            // Ignora erro se não houver foto (ex: 404)
        }
    }
    // ------------------------------------

    const lastMsgTimestamp = lastMsg?.messageTimestamp
        ? Number(lastMsg.messageTimestamp) * 1000
        : chat.conversationTimestamp
        ? Number(chat.conversationTimestamp) * 1000
        : Date.now()

    return {
        id: chatId,
        name: chatName,
        // 📸 NOVO: Adicionado pictureUrl
        pictureUrl: profilePicUrl, 
        lastMessage: lastMsg ? getMessageText(lastMsg) : "",
        lastMessageTime: lastMsgTimestamp,
        unreadCount: chat.unreadCount || 0,
        isArchived: chat.archived || false,
        isPinned: chat.pinned || false,
        // NOVO: Adicionado isGroup para fácil filtragem no frontend
        isGroup: chatId.includes("@g.us"), 
    }
}

// -------------------------
// Função para normalizar mensagens para o formato do frontend
// -------------------------
function normalizeMessageForFrontend(msg) {
    if (!msg || !msg.key) return null

    const fromMe = msg.key.fromMe || false
    const messageText = getMessageText(msg)

    const timestampMs = msg.messageTimestamp ? Number(msg.messageTimestamp) * 1000 : Date.now()
    
    const hasMedia = !!(
        msg.message?.imageMessage ||
        msg.message?.videoMessage ||
        msg.message?.audioMessage ||
        msg.message?.documentMessage
    )

    // ✅ CORREÇÃO: URL completa da mídia
    const baseUrl = process.env.API_URL || 'http://localhost:3000'
    const mediaUrl = hasMedia 
        ? `${baseUrl}/media/${msg.key.remoteJid}/${msg.key.id}` 
        : null

    let type = "text"
    if (hasMedia) {
        if (msg.message?.imageMessage) type = "image"
        else if (msg.message?.videoMessage) type = "video"
        else if (msg.message?.audioMessage) type = "audio"
        else if (msg.message?.documentMessage) type = "document"
        else if (msg.message?.stickerMessage) type = "sticker"
    }

    // ✅ NOVO: Incluir mimeType correto
    let mimeType = null
    if (hasMedia) {
        const mediaContent = 
            msg.message?.imageMessage ||
            msg.message?.videoMessage ||
            msg.message?.audioMessage ||
            msg.message?.documentMessage
        mimeType = mediaContent?.mimetype || null
    }

    return {
        id: msg.key.id || "",
        body: messageText,
        timestamp: timestampMs,
        from: msg.key.participant || msg.key.remoteJid || "",
        to: msg.key.remoteJid || "",
        fromMe: fromMe,
        type: type,
        hasMedia: hasMedia,
        mediaUrl: mediaUrl,
        mimeType: mimeType, // ✅ Agora com mimeType correto
        ack: msg.status || 0,
        caption: msg.message?.imageMessage?.caption || 
                 msg.message?.videoMessage?.caption || 
                 msg.message?.documentMessage?.caption || 
                 null,
    }
}

// -------------------------
// Iniciar o WhatsApp
// -------------------------
async function startWhatsApp() {
    if (isStarting) return
    isStarting = true

    try {
        console.log("[WHATSAPP] 🚀 Iniciando conexão...")

        const { version } = await fetchLatestBaileysVersion()
        const logger = pino({ level: "silent" })
        const authStatePath = "./auth_info"
        const { state, saveCreds } = await useMultiFileAuthState(authStatePath)

        const socket = makeWASocket({
            version,
            logger,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger),
            },
            browser: ["WhatsApp Business", "Chrome", "1.0.0"],
            syncFullHistory: true,
            getMessage: async (key) => {
                const jid = key.remoteJid
                const messages = messagesStore[jid] || []
                const msg = messages.find((m) => m.key.id === key.id)
                return msg?.message || { conversation: "" }
            },
        })

        sock = socket

        sock.ev.on("creds.update", saveCreds)

        // -------------------------
        // CHATS - Sincronização completa
        // -------------------------
        sock.ev.on("messaging-history.set", ({ chats, contacts, messages, isLatest }) => {
            console.log("[SYNC] 📚 Histórico recebido:", {
                chats: chats.length,
                messages: messages.length,
                isLatest,
            })

            chats.forEach((chat) => {
                chatsStore[chat.id] = chat
            })

            // 🟢 CORREÇÃO 2A: Popula o contactsStore na sincronização inicial
            contacts.forEach((contact) => {
                contactsStore[contact.id] = contact
            })
            // FIM da Correção 2A

            messages.forEach((msg) => {
                const jid = msg.key.remoteJid
                if (!jid) return

                if (!messagesStore[jid]) messagesStore[jid] = []

                const exists = messagesStore[jid].find((x) => x.key.id === msg.key.id)
                if (!exists) {
                    messagesStore[jid].push(msg)
                }
            })

            console.log("[SYNC] ✅ Chats:", Object.keys(chatsStore).length)
        })

        sock.ev.on("chats.set", ({ chats }) => {
            chats.forEach((chat) => {
                chatsStore[chat.id] = chat
            })
        })

        sock.ev.on("chats.upsert", (chats) => {
            chats.forEach((chat) => {
                chatsStore[chat.id] = { ...chatsStore[chat.id], ...chat }
            })
        })

        sock.ev.on("chats.update", (updates) => {
            updates.forEach((update) => {
                if (chatsStore[update.id]) {
                    chatsStore[update.id] = { ...chatsStore[update.id], ...update }
                }
            })
        })

        sock.ev.on("chats.delete", (ids) => {
            ids.forEach((id) => delete chatsStore[id])
        })

        // -------------------------
        // CONTATOS - Sincronização/Atualização
        // -------------------------
        // 🟢 CORREÇÃO 2B: Evento para atualizações de contatos
        sock.ev.on("contacts.upsert", (contacts) => {
            contacts.forEach((contact) => {
                contactsStore[contact.id] = { ...contactsStore[contact.id], ...contact }
            })
        })
        // FIM da Correção 2B

        // -------------------------
        // MENSAGENS - Sincronização
        // -------------------------
        sock.ev.on("messages.set", ({ messages }) => {
            messages.forEach((msg) => {
                const jid = msg.key.remoteJid
                if (!jid) return

                if (!messagesStore[jid]) messagesStore[jid] = []

                const exists = messagesStore[jid].find((x) => x.key.id === msg.key.id)
                if (!exists) {
                    messagesStore[jid].push(msg)
                }
            })
        })

        sock.ev.on("messages.upsert", (m) => {
            const messages = m.messages || []

            messages.forEach((msg) => {
                const jid = msg.key.remoteJid
                if (!jid) return

                if (!messagesStore[jid]) messagesStore[jid] = []

                const exists = messagesStore[jid].find((x) => x.key.id === msg.key.id)
                if (!exists) {
                    messagesStore[jid].push(msg)
                }

                if (!chatsStore[jid]) {
                    chatsStore[jid] = {
                        id: jid,
                        name: msg.pushName || jid.split("@")[0],
                        conversationTimestamp: Number(msg.messageTimestamp) || Math.floor(Date.now() / 1000),
                        unreadCount: msg.key.fromMe ? 0 : 1,
                    }
                } else {
                    chatsStore[jid].conversationTimestamp = Number(msg.messageTimestamp) || Math.floor(Date.now() / 1000)

                    if (!msg.key.fromMe) {
                        chatsStore[jid].unreadCount = (chatsStore[jid].unreadCount || 0) + 1
                    }
                }
            })
        })

        sock.ev.on("messages.update", (updates) => {
            updates.forEach((update) => {
                const jid = update.key.remoteJid
                if (!jid || !messagesStore[jid]) return

                const idx = messagesStore[jid].findIndex((m) => m.key.id === update.key.id)
                if (idx !== -1) {
                    messagesStore[jid][idx] = { ...messagesStore[jid][idx], ...update }
                }
            })
        })

        // -------------------------
        // CONEXÃO
        // -------------------------
        sock.ev.on("connection.update", async (update) => {
            const { connection, lastDisconnect, qr } = update

            if (qr) {
                lastQrDataUrl = await qrcode.toDataURL(qr)
                connectionStatus.status = "qr"
                console.log("[STATUS] 📱 QR Code gerado")
                return
            }

            if (connection === "open") {
                connectionStatus.connected = true
                connectionStatus.phone = sock.user?.id || null
                connectionStatus.status = "connected"
                lastQrDataUrl = null

                console.log("[WHATSAPP] ✅ Conectado:", sock.user?.id)
            }

            if (connection === "close") {
                const reason = new Boom(lastDisconnect?.error)?.output?.statusCode

                connectionStatus.connected = false
                connectionStatus.phone = null
                connectionStatus.status = "disconnected"
                lastQrDataUrl = null

                if (reason !== DisconnectReason.loggedOut) {
                    isStarting = false
                    setTimeout(() => startWhatsApp(), 3000)
                }
            }
        })

        console.log("[WHATSAPP] ⚡ Socket iniciado")
    } catch (err) {
        console.error("[WHATSAPP] ❌ Erro:", err)
    } finally {
        isStarting = false
    }
}

startWhatsApp()
// ---------------------------------------------------------------------------------------------------
// ROTAS HTTP
// ---------------------------------------------------------------------------------------------------

// --- Rota de Status e Health ---
app.get("/health", (req, res) => {
    res.json({
        ok: true,
        status: connectionStatus,
        stats: {
            chats: Object.keys(chatsStore).length,
            chatsWithMessages: Object.keys(messagesStore).length,
        },
    })
})

app.get("/qr", (req, res) => {
    if (connectionStatus.connected) {
        return res.send("ALREADY_CONNECTED")
    }
    if (!lastQrDataUrl) {
        return res.status(202).send("QR_NOT_READY")
    }
    return res.send(lastQrDataUrl)
})

app.get("/status", (req, res) => {
    res.json({
        ...connectionStatus,
        stats: {
            chats: Object.keys(chatsStore).length,
            chatsWithMessages: Object.keys(messagesStore).length,
        },
    })
})

// --- Rotas de Chats (LISTA DE CONVERSAS) ---
app.get("/chats", async (req, res) => { // <--- ALTERADO: Adicionado 'async'
    if (!connectionStatus.connected) {
        return res.json({ success: false, chats: [], hasMore: false, total: 0 })
    }

    try {
        const limit = Number.parseInt(req.query.limit) || 50
        const offset = Number.parseInt(req.query.offset) || 0

        const allChats = Object.values(chatsStore)

        // 💥 AJUSTE REALIZADO AQUI: FILTRA CHATS ARQUIVADOS E GRUPOS 💥
        const validChats = allChats.filter((chat) => {
            const id = chat.id
            // Exclui broadcast, status, chats arquivados E GRUPOS
            return (
                id && 
                !id.includes("broadcast") && 
                !id.includes("status") && 
                !chat.archived &&
                !id.includes("@g.us") // <--- NOVO: Exclui grupos
            )
        })
        // ----------------------------------------------------

        const sorted = validChats.sort((a, b) => {
            const tsA = a.conversationTimestamp || 0
            const tsB = b.conversationTimestamp || 0
            return Number(tsB) - Number(tsA)
        })

        const paginatedChats = sorted.slice(offset, offset + limit)
        const hasMore = offset + limit < sorted.length

        // 📸 NOVO: Usa Promise.all para processar a busca de foto assíncrona
        const normalized = await Promise.all(
            paginatedChats.map(normalizeChatForFrontend)
        )

        res.json({
            success: true,
            chats: normalized,
            hasMore,
            total: sorted.length,
            offset,
            limit,
        })
    } catch (error) {
        console.error("[API] ❌ Erro ao processar chats:", error)
        res.status(500).json({
            success: false,
            message: "Erro ao processar chats",
            chats: [],
            hasMore: false,
            total: 0,
        })
    }
})

// [NOVA ROTA] Buscar Chats
app.get("/chats/search", async (req, res) => { // <--- ALTERADO: Adicionado 'async'
    const query = req.query.q ? req.query.q.toLowerCase() : ""

    if (!connectionStatus.connected) {
        return res.json({ success: false, chats: [] })
    }

    try {
        if (!query) {
            return res.json({ success: true, chats: [] })
        }

        const allChats = Object.values(chatsStore)
        
        // Inclui o filtro de arquivados E GRUPOS na busca
        const activeAndPrivateChats = allChats.filter(chat => 
            !chat.archived && !chat.id.includes("@g.us") // <--- NOVO: Exclui grupos
        ); 

        // 📸 NOVO: Usa Promise.all
        const normalizedChats = await Promise.all(
            activeAndPrivateChats.map(normalizeChatForFrontend)
        )

        const filtered = normalizedChats.filter((chat) => {
            const searchName = chat.name ? chat.name.toLowerCase() : ""
            const searchId = chat.id ? chat.id.toLowerCase().replace(/@s\.whatsapp\.net|@g\.us/g, "") : ""

            return searchName.includes(query) || searchId.includes(query)
        })

        const sorted = filtered.sort((a, b) => b.lastMessageTime - a.lastMessageTime)

        res.json({
            success: true,
            chats: sorted,
            total: sorted.length,
        })
    } catch (error) {
        console.error("[API] ❌ Erro ao buscar chats:", error)
        res.status(500).json({ success: false, message: "Erro ao buscar chats" })
    }
})

// [NOVA ROTA] Informações do Contato/Grupo
app.get("/chats/:chatId/info", async (req, res) => {
    const { chatId } = req.params

    if (!connectionStatus.connected || !sock) {
        return res.status(400).json({ success: false, message: "WhatsApp não conectado" })
    }

    // 💥 NOVO: Bloqueia a rota de info para grupos (pois eles não são o foco)
    if (chatId.includes("@g.us")) { 
        return res.status(403).json({ 
            success: false, 
            message: "Informações de grupos não estão disponíveis nesta API." 
        })
    }
    // -------------------------------------------------------------

    try {
        const isGroup = chatId.includes("@g.us")
        const chatData = chatsStore[chatId] || {}
        const contactInfo = contactsStore[chatId] || {} // Obtém as informações do contato/nome
        let profilePicUrl = null
        let groupInfo = {}

        try {
            profilePicUrl = await sock.profilePictureUrl(chatId, "image")
        } catch (e) {
            // Ignora erro se não tiver foto
        }

        if (isGroup) {
            try {
                groupInfo = await sock.groupMetadata(chatId)
            } catch (e) {
                console.warn(`[API] Falha ao buscar metadados do grupo ${chatId}: ${e.message}`)
            }
        }
        
        // Define o nome usando a mesma lógica de prioridade (com o contactInfo incluído)
        const name = contactInfo.name || chatData.name || chatData.subject || groupInfo.subject || chatId.split("@")[0]

        res.json({
            success: true,
            id: chatId,
            name: name,
            isGroup: isGroup,
            pictureUrl: profilePicUrl,
            participants: groupInfo.participants || [],
            owner: groupInfo.owner || null,
            creation: groupInfo.creation || null,
        })

    } catch (error) {
        console.error("[API] ❌ Erro ao buscar info do chat:", error)
        res.status(500).json({ success: false, message: error.message })
    }
})

// [NOVA ROTA] Marcar Mensagens como Lidas
app.post("/chats/:chatId/read", async (req, res) => {
    const { chatId } = req.params

    if (!connectionStatus.connected || !sock) {
        return res.status(400).json({ success: false, message: "WhatsApp não conectado" })
    }

    // 💥 NOVO: Bloqueia a rota de leitura para grupos
    if (chatId.includes("@g.us")) {
        return res.status(403).json({ 
            success: false, 
            message: "Marcação de leitura para grupos não é suportada nesta API." 
        })
    }
    // -------------------------------------------------------------

    try {
        const messages = messagesStore[chatId] || []

        const lastIncomingMsg = messages
            .filter((msg) => !msg.key.fromMe)
            .sort((a, b) => Number(b.messageTimestamp) - Number(a.messageTimestamp))[0]

        if (lastIncomingMsg) {
            const receiptKey = {
                remoteJid: chatId,
                id: lastIncomingMsg.key.id,
                participant: lastIncomingMsg.key.participant || chatId,
            }

            await sock.readMessages([receiptKey])
        }

        if (chatsStore[chatId]) {
            chatsStore[chatId].unreadCount = 0
        }

        res.json({ success: true, message: `Chat ${chatId} marcado como lido` })
    } catch (error) {
        console.error("[API] ❌ Erro ao marcar como lido:", error)
        res.status(500).json({ success: false, message: error.message })
    }
})

// --- Rota de Mensagens (com lazy load / paginação reversa) ---
app.get("/chats/:chatId/messages", async (req, res) => {
    const { chatId } = req.params
    
    // Limite padrão de 10 mensagens
    const limit = Number.parseInt(req.query.limit) || 10
    const offset = Number.parseInt(req.query.offset) || 0

    if (!connectionStatus.connected || !sock) {
        return res.status(400).json({
            success: false,
            message: "WhatsApp não conectado",
            messages: [],
            hasMore: false,
            total: 0,
        })
    }

    // 💥 NOVO: Bloqueia a rota de mensagens para grupos
    if (chatId.includes("@g.us")) {
        return res.status(403).json({ 
            success: false, 
            message: "Visualização de mensagens de grupos não é suportada nesta API.",
            messages: [],
            hasMore: false,
            total: 0,
        })
    }
    // -------------------------------------------------------------

    try {
        let messages = messagesStore[chatId] || []

        // Se o cache local for pequeno, tente buscar mais histórico do WA
        if (messages.length < 50 && offset === 0) { 
            try {
                const history = await sock.fetchMessagesFromWA(chatId, 50)

                if (history && history.length > 0) {
                    history.forEach((msg) => {
                        if (!messagesStore[chatId]) messagesStore[chatId] = []
                        const exists = messagesStore[chatId].find((x) => x.key.id === msg.key.id)
                        if (!exists) {
                            messagesStore[chatId].push(msg)
                        }
                    })

                    messages = messagesStore[chatId]
                }
            } catch (fetchError) {
                // Continua com cache existente se a busca falhar
                console.warn(`[API] Falha ao buscar histórico adicional para ${chatId}: ${fetchError.message}`)
            }
        }

        // 1. Ordena todas as mensagens do chat por ordem de envio (mais antigas primeiro)
        const sorted = [...messages].sort((a, b) => (Number(a.messageTimestamp) || 0) - (Number(b.messageTimestamp) || 0))

        const total = sorted.length

        // 2. Lógica de paginação reversa (Lazy Load para mensagens antigas)
        const start = Math.max(0, total - offset - limit)
        const end = total - offset
        const paginatedMessages = sorted.slice(start, end)

        const hasMore = offset + limit < total

        const normalized = paginatedMessages.map(normalizeMessageForFrontend).filter((msg) => msg !== null)

        res.json({
            success: true,
            messages: normalized,
            hasMore,
            total,
            offset,
            limit,
        })
    } catch (error) {
        console.error("[API] ❌ Erro ao buscar mensagens:", error)
        res.status(500).json({
            success: false,
            message: error.message,
            messages: [],
            hasMore: false,
            total: 0,
        })
    }
})

// [NOVA ROTA] Visualizar Mídia Recebida
app.get("/media/:chatId/:messageId", async (req, res) => {
    const { chatId, messageId } = req.params

    if (!connectionStatus.connected || !sock) {
        return res.status(400).json({ success: false, message: "WhatsApp não conectado" })
    }

    // 💥 NOVO: Bloqueia a rota de mídia para grupos
    if (chatId.includes("@g.us")) {
        return res.status(403).json({ 
            success: false, 
            message: "Visualização de mídia de grupos não é suportada nesta API." 
        })
    }
    // -------------------------------------------------------------

    try {
        const messages = messagesStore[chatId] || []
        const targetMsg = messages.find((m) => m.key.id === messageId)

        if (!targetMsg || !targetMsg.message) {
            return res.status(404).json({ success: false, message: "Mensagem não encontrada ou não contém mídia" })
        }

        // Baixar a mídia de forma genérica
        const mediaBuffer = await downloadMediaMessage(
            targetMsg,
            "buffer", // Tipo de retorno como Buffer
            {}, // Opções
            { logger: pino({ level: "silent" }), reuploadRequest: sock.updateMediaMessage }, // Handlers
        )

        if (!mediaBuffer) {
            return res.status(404).json({ success: false, message: "Falha ao baixar a mídia" })
        }

        // Obter o objeto de mídia
        const mediaContent =
            targetMsg.message.imageMessage ||
            targetMsg.message.videoMessage ||
            targetMsg.message.audioMessage ||
            targetMsg.message.documentMessage
        const mimeType = mediaContent?.mimetype || "application/octet-stream"

        res.set("Content-Type", mimeType)
        res.send(mediaBuffer)

    } catch (error) {
        console.error("[API] ❌ Erro ao buscar mídia:", error)
        res.status(500).json({ success: false, message: error.message })
    }
})


// --- Rotas de Envio ---
app.post("/chats/send", async (req, res) => {
    const { chatId, message } = req.body

    if (!chatId || !message) {
        return res.status(400).json({
            success: false,
            message: "chatId e message são obrigatórios",
        })
    }

    // 💥 NOVO: Bloqueia envio para grupo
    if (chatId.includes("@g.us")) { 
        return res.status(403).json({
            success: false,
            message: "Envio de mensagens para grupos não é permitido nesta API.",
        })
    }
    // -------------------------------------------------------------

    if (!connectionStatus.connected || !sock) {
        return res.status(400).json({
            success: false,
            message: "WhatsApp não conectado",
        })
    }

    try {
        const result = await sock.sendMessage(chatId, { text: message })

        res.json({ success: true, messageId: result?.key?.id })
    } catch (error) {
        console.error("[API] ❌ Erro ao enviar:", error)
        res.status(500).json({
            success: false,
            message: "Erro ao enviar: " + error.message,
        })
    }
})

/**
 * Rota corrigida para lidar com o erro de desestruturação (Cannot destructure property 'chatId' of 'req.body' as it is undefined).
 */
app.post("/chats/send-media", async (req, res) => {
    // Validação inicial para evitar erro de desestruturação
    if (!req.body || typeof req.body !== 'object') {
        return res.status(400).json({
            success: false,
            message: "Corpo da requisição inválido ou ausente. Certifique-se de enviar Content-Type: application/json.",
        })
    }

    if (!connectionStatus.connected || !sock) {
        return res.status(400).json({
            success: false,
            message: "WhatsApp não conectado",
        })
    }

    try {
        const { chatId, type, mediaUrl, caption, fileName, mimetype } = req.body

        if (!chatId) {
            return res.status(400).json({
                success: false,
                message: "chatId é obrigatório",
            })
        }

        // 💥 NOVO: Bloqueia envio de mídia para grupo
        if (chatId.includes("@g.us")) { 
            return res.status(403).json({
                success: false,
                message: "Envio de mídia para grupos não é permitido nesta API.",
            })
        }
        // -------------------------------------------------------------
        
        // Validação de type e mediaUrl, conforme sugerido
        if (!type || !mediaUrl) {
            return res.status(400).json({
                success: false,
                message: "type e mediaUrl são obrigatórios para envio de mídia via URL.",
            })
        }
        
        let messageContent = null

        if (mediaUrl) {
            switch (type) {
                case "image":
                    messageContent = {
                        image: { url: mediaUrl },
                        caption: caption || "",
                    }
                    break

                case "video":
                    messageContent = {
                        video: { url: mediaUrl },
                        caption: caption || "",
                    }
                    break

                case "audio":
                    messageContent = {
                        audio: { url: mediaUrl },
                        mimetype: mimetype || "audio/mpeg",
                        ptt: true, // Indica que é um Voice Note (gravação de áudio)
                    }
                    break

                case "document":
                    messageContent = {
                        document: { url: mediaUrl },
                        fileName: fileName || "arquivo",
                        mimetype: mimetype || "application/octet-stream",
                    }
                    break

                default:
                    // Fallback para imagem
                    messageContent = {
                        image: { url: mediaUrl },
                        caption: caption || "",
                    }
                    break
            }
        } else if (caption) {
            // Se não houver mediaUrl, mas houver caption, envia como texto
            messageContent = { text: caption }
        } else {
            return res.status(400).json({
                success: false,
                message: "Nenhuma mídia ou texto (caption) fornecido",
            })
        }

        const result = await sock.sendMessage(chatId, messageContent)

        return res.json({
            success: true,
            messageId: result?.key?.id,
        })
    } catch (error) {
        console.error("[API] ❌ Erro ao enviar mídia:", error)
        return res.status(500).json({
            success: false,
            message: "Erro ao enviar mídia: " + error.message,
        })
    }
})

// --- Rota de Logout ---
app.post("/logout", async (req, res) => {
    try {
        if (sock) {
            await sock.logout()
        }

        chatsStore = {}
        messagesStore = {}
        contactsStore = {} // Limpa a store de contatos também
        connectionStatus.connected = false
        connectionStatus.phone = null
        connectionStatus.status = "disconnected"
        lastQrDataUrl = null

        res.json({ success: true })
    } catch (err) {
        console.error("[API] ❌ Erro ao fazer logout:", err)
        res.status(500).json({ success: false, message: "Erro ao fazer logout" })
    }
})

// ---------------------------------------------------------------------------------------------------
// 🛠️ CONFIGURAÇÃO DE PORTA PARA O RENDER
// O Render injeta a porta de escuta na variável de ambiente PORT.
// ---------------------------------------------------------------------------------------------------
const PORT = process.env.PORT || 3000

app.listen(PORT, () => {
    console.log(`[SERVER] 🌐 Servidor Express rodando na porta ${PORT}`)
})