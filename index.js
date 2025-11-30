require("dotenv").config() // Garante leitura do .env se existir localmente
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

// -------------------------
// AJUSTE DE LIMITE DE PAYLOAD
// -------------------------
app.use(express.json({ limit: '20mb' }))
app.use(express.urlencoded({ limit: '20mb', extended: true }))

// -------------------------
// CONFIGURAÇÃO SUPABASE (ESSENCIAL)
// -------------------------
const supabaseUrl = process.env.SUPABASE_URL
const supabaseKey = process.env.SUPABASE_KEY // Use a chave SERVICE_ROLE para ter permissão de escrita total

if (!supabaseUrl || !supabaseKey) {
    console.error("❌ ERRO CRÍTICO: SUPABASE_URL e SUPABASE_KEY são obrigatórios nas variáveis de ambiente.")
    process.exit(1)
}

const supabase = createClient(supabaseUrl, supabaseKey)

// -------------------------
// Estado da Conexão (Apenas controle, sem dados pesados)
// -------------------------
let sock = null
let isStarting = false
let lastQrDataUrl = null
const connectionStatus = {
    connected: false,
    phone: null,
    status: "disconnected",
}

// -------------------------
// 🛠️ FUNÇÕES AUXILIARES (TRANSFORMADORES)
// -------------------------

// Extrai texto simples da mensagem
function getMessageText(msg) {
    if (!msg || !msg.message) return ""
    const content = msg.message
    if (content.conversation) return content.conversation
    if (content.extendedTextMessage?.text) return content.extendedTextMessage.text
    if (content.imageMessage?.caption) return content.imageMessage.caption || "[Imagem]"
    if (content.videoMessage?.caption) return content.videoMessage.caption || "[Vídeo]"
    if (content.documentMessage?.caption) return content.documentMessage.caption || "[Documento]"
    return ""
}

// Determina o tipo de mensagem
function getMessageType(msg) {
    if (!msg.message) return "text"
    if (msg.message.imageMessage) return "image"
    if (msg.message.videoMessage) return "video"
    if (msg.message.audioMessage) return "audio"
    if (msg.message.documentMessage) return "document"
    if (msg.message.stickerMessage) return "sticker"
    return "text"
}

// Prepara mensagem para salvar no Banco (Extrai metadados de mídia e deleta o buffer)
function prepareMessageForDB(msg, chatId) {
    const type = getMessageType(msg)
    const hasMedia = ["image", "video", "audio", "document", "sticker"].includes(type)
    
    let mediaMeta = null

    if (hasMedia) {
        // Extrai o objeto de mídia (imageMessage, videoMessage, etc)
        const messageContent = msg.message[type + "Message"]
        if (messageContent) {
            // SALVA APENAS OS DADOS NECESSÁRIOS PARA BAIXAR DEPOIS
            mediaMeta = {
                url: messageContent.url,
                mediaKey: messageContent.mediaKey ? Buffer.from(messageContent.mediaKey).toString('base64') : null,
                mimetype: messageContent.mimetype,
                fileEncSha256: messageContent.fileEncSha256 ? Buffer.from(messageContent.fileEncSha256).toString('base64') : null,
                fileSha256: messageContent.fileSha256 ? Buffer.from(messageContent.fileSha256).toString('base64') : null,
                fileLength: messageContent.fileLength,
                directPath: messageContent.directPath,
                iv: messageContent.iv ? Buffer.from(messageContent.iv).toString('base64') : null, // Necessário para alguns tipos
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
        media_meta: mediaMeta, // JSON leve
        ack: msg.status || 0
    }
}

// -------------------------
// 🚀 INICIAR O WHATSAPP
// -------------------------
async function startWhatsApp() {
    if (isStarting) return
    isStarting = true

    try {
        console.log("[WHATSAPP] 🚀 Iniciando conexão...")
        const { version } = await fetchLatestBaileysVersion()
        const logger = pino({ level: "silent" })
        const { state, saveCreds } = await useMultiFileAuthState("./auth_info")

        const socket = makeWASocket({
            version,
            logger,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger),
            },
            browser: ["WhatsApp Backend", "Chrome", "1.0.0"],
            // 💡 IMPORTANTE: syncFullHistory: true é seguro agora porque NÃO guardamos na RAM.
            // O processamento será feito via Stream para o Supabase.
            syncFullHistory: true, 
            generateHighQualityLinkPreview: true,
        })

        sock = socket
        sock.ev.on("creds.update", saveCreds)

        // -------------------------
        // 🌊 O "CANO" (PIPELINE) DE DADOS
        // Recebe do WA -> Joga no Supabase -> Limpa RAM
        // -------------------------
        
        // 1. Histórico Inicial / Sincronização
        sock.ev.on("messaging-history.set", async ({ chats, messages }) => {
            console.log(`[SYNC] 🌊 Recebendo Tsunami: ${chats.length} chats, ${messages.length} mensagens.`)

            // A) Processar Chats
            if (chats.length > 0) {
                const chatsBatch = chats.map(c => ({
                    id: c.id,
                    name: c.name || c.subject || c.verifiedName || (c.id.includes("@s.whatsapp.net") ? c.id.split("@")[0] : "Desconhecido"),
                    unread_count: c.unreadCount || 0,
                    is_group: c.id.includes("@g.us"),
                    is_archived: c.archived || false,
                    last_message_time: c.conversationTimestamp ? Number(c.conversationTimestamp) * 1000 : Date.now()
                }))

                // Upsert em lotes de 100 para não travar o banco
                for (let i = 0; i < chatsBatch.length; i += 100) {
                    const batch = chatsBatch.slice(i, i + 100)
                    const { error } = await supabase.from("chats").upsert(batch, { onConflict: 'id' })
                    if (error) console.error("[SYNC] Erro ao salvar chats:", error.message)
                }
            }

            // B) Processar Mensagens (Pipeline para o Banco)
            if (messages.length > 0) {
                const msgsBatch = messages.map(m => prepareMessageForDB(m, m.key.remoteJid))
                
                // Salva em lotes de 500
                for (let i = 0; i < msgsBatch.length; i += 500) {
                    const batch = msgsBatch.slice(i, i + 500)
                    const { error } = await supabase.from("messages").upsert(batch, { onConflict: 'id' })
                    if (error) console.error("[SYNC] Erro ao salvar mensagens:", error.message)
                }
            }

            console.log("[SYNC] ✅ Dados salvos no Supabase. Memória RAM liberada.")
            
            // Força limpeza (opcional, Node faz auto, mas ajuda na lógica mental)
            chats = null
            messages = null 
            if (global.gc) global.gc()
        })

        // 2. Novas Mensagens (Tempo Real)
        sock.ev.on("messages.upsert", async ({ messages, type }) => {
            if (type !== "notify" && type !== "append") return

            for (const msg of messages) {
                const chatId = msg.key.remoteJid
                if (!chatId || chatId === "status@broadcast") continue

                // 1. Salvar Mensagem no Banco
                const msgDB = prepareMessageForDB(msg, chatId)
                await supabase.from("messages").upsert(msgDB)

                // 2. Atualizar o Chat (Última mensagem e unread)
                const updateData = {
                    last_message: getMessageText(msg),
                    last_message_time: Number(msg.messageTimestamp) * 1000
                }
                
                // Se não fui eu que enviei, incrementa contador
                if (!msg.key.fromMe) {
                    // Nota: Incremento atômico seria ideal, mas simplificamos aqui
                    // Precisaria de uma RPC no supabase para incrementar seguro, 
                    // vamos apenas definir como não lido por hora ou buscar e somar.
                    // Para performance, vamos apenas atualizar o timestamp.
                }

                await supabase.from("chats").update(updateData).eq("id", chatId)
            }
        })

        // 3. Atualizações de Chats (ex: arquivar, limpar unread)
        sock.ev.on("chats.update", async (updates) => {
            for (const update of updates) {
                if (!update.id) continue
                const { id, unreadCount, archived } = update
                
                const dataToUpdate = {}
                if (unreadCount !== undefined) dataToUpdate.unread_count = unreadCount
                if (archived !== undefined) dataToUpdate.is_archived = archived

                if (Object.keys(dataToUpdate).length > 0) {
                    await supabase.from("chats").update(dataToUpdate).eq("id", id)
                }
            }
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
            }

            if (connection === "open") {
                connectionStatus.connected = true
                connectionStatus.phone = sock.user?.id
                connectionStatus.status = "connected"
                lastQrDataUrl = null
                console.log("[WHATSAPP] ✅ Conectado:", sock.user?.id)
            }

            if (connection === "close") {
                const reason = new Boom(lastDisconnect?.error)?.output?.statusCode
                connectionStatus.connected = false
                connectionStatus.status = "disconnected"
                lastQrDataUrl = null

                if (reason !== DisconnectReason.loggedOut) {
                    isStarting = false
                    setTimeout(startWhatsApp, 3000)
                }
            }
        })

        console.log("[WHATSAPP] ⚡ Socket iniciado")
    } catch (err) {
        console.error("[WHATSAPP] ❌ Erro:", err)
        isStarting = false
    }
}

startWhatsApp()

// ---------------------------------------------------------------------------------------------------
// ROTAS HTTP (Agora lendo do Supabase - Lazy Loading Real)
// ---------------------------------------------------------------------------------------------------

app.get("/health", (req, res) => res.json({ ok: true, status: connectionStatus }))

app.get("/qr", (req, res) => {
    if (connectionStatus.connected) return res.send("ALREADY_CONNECTED")
    if (!lastQrDataUrl) return res.status(202).send("QR_NOT_READY")
    return res.send(lastQrDataUrl)
})

app.get("/status", (req, res) => res.json(connectionStatus))

// --- LISTA DE CONVERSAS (Lê do Supabase) ---
app.get("/chats", async (req, res) => {
    const limit = Number(req.query.limit) || 20
    const offset = Number(req.query.offset) || 0

    try {
        // Busca paginada no Banco
        const { data: chats, error, count } = await supabase
            .from('chats')
            .select('*', { count: 'exact' })
            .eq('is_archived', false) // Ignora arquivados
            .not('id', 'ilike', '%@g.us') // Ignora grupos (conforme seu pedido anterior)
            .order('last_message_time', { ascending: false })
            .range(offset, offset + limit - 1)

        if (error) throw error

        // Mapeia para o formato que seu frontend espera
        const formattedChats = chats.map(c => ({
            id: c.id,
            name: c.name,
            pictureUrl: null, // Opcional: implementar lógica de cache de foto
            lastMessage: c.last_message || "",
            lastMessageTime: c.last_message_time,
            unreadCount: c.unread_count,
            isGroup: c.is_group
        }))

        res.json({
            success: true,
            chats: formattedChats,
            hasMore: (offset + limit) < count,
            total: count
        })

    } catch (error) {
        console.error("[API] Erro chats:", error)
        res.status(500).json({ success: false, chats: [] })
    }
})

// --- MENSAGENS (Lazy Loading do Banco) ---
app.get("/chats/:chatId/messages", async (req, res) => {
    const { chatId } = req.params
    const limit = Number(req.query.limit) || 20
    const offset = Number(req.query.offset) || 0

    try {
        // Busca paginada no Banco
        const { data: messages, error, count } = await supabase
            .from('messages')
            .select('*', { count: 'exact' })
            .eq('chat_id', chatId)
            .order('timestamp', { ascending: false }) // Do mais recente para o antigo
            .range(offset, offset + limit - 1)

        if (error) throw error

        // Reverte array para o frontend mostrar cronologicamente (Antigo -> Novo)
        const sortedMsgs = messages.sort((a, b) => a.timestamp - b.timestamp)

        const formattedMsgs = sortedMsgs.map(m => ({
            id: m.id,
            body: m.content,
            timestamp: m.timestamp,
            from: m.sender_id,
            to: m.chat_id,
            fromMe: m.from_me,
            type: m.type,
            hasMedia: m.has_media,
            // Se tiver mídia, gera o link para o nosso endpoint de download
            mediaUrl: m.has_media ? `${process.env.API_URL || 'http://localhost:3000'}/media/${m.chat_id}/${m.id}` : null,
            mimeType: m.media_meta?.mimetype,
            ack: m.ack
        }))

        res.json({
            success: true,
            messages: formattedMsgs,
            hasMore: (offset + limit) < count,
            total: count
        })

    } catch (error) {
        console.error("[API] Erro mensagens:", error)
        res.status(500).json({ success: false, messages: [] })
    }
})

// --- DOWNLOAD DE MÍDIA (Lazy Loading de Arquivo) ---
app.get("/media/:chatId/:messageId", async (req, res) => {
    const { messageId } = req.params

    try {
        // 1. Busca os metadados no Supabase
        const { data: msg, error } = await supabase
            .from('messages')
            .select('media_meta, type')
            .eq('id', messageId)
            .single()

        if (error || !msg || !msg.media_meta) {
            return res.status(404).send("Mídia não encontrada no banco.")
        }

        const meta = msg.media_meta

        // Reconstrói o objeto que o Baileys precisa para descriptografar
        // Convertendo de volta de Base64 para Buffer onde necessário
        const mediaMessage = {
            url: meta.url,
            mediaKey: meta.mediaKey ? Buffer.from(meta.mediaKey, 'base64') : undefined,
            mimetype: meta.mimetype,
            fileEncSha256: meta.fileEncSha256 ? Buffer.from(meta.fileEncSha256, 'base64') : undefined,
            fileSha256: meta.fileSha256 ? Buffer.from(meta.fileSha256, 'base64') : undefined,
            fileLength: meta.fileLength,
            directPath: meta.directPath,
            iv: meta.iv ? Buffer.from(meta.iv, 'base64') : undefined
        }

        // 2. Baixa e Descriptografa usando Baileys
        const buffer = await downloadMediaMessage(
            {
                key: { id: messageId }, 
                message: { [msg.type + "Message"]: mediaMessage } // Hack para montar a estrutura msg.message.imageMessage
            },
            'buffer',
            {},
            { logger: pino({ level: "silent" }), reuploadRequest: sock.updateMediaMessage }
        )

        res.set("Content-Type", meta.mimetype)
        res.send(buffer)

    } catch (error) {
        console.error("[MEDIA] Erro ao baixar:", error)
        res.status(500).send("Erro ao processar mídia")
    }
})

// --- ENVIO DE MENSAGEM (Mantido igual, mas usando socket) ---
app.post("/chats/send", async (req, res) => {
    const { chatId, message } = req.body
    if (!connectionStatus.connected || !sock) return res.status(400).json({ success: false })

    try {
        const result = await sock.sendMessage(chatId, { text: message })
        // O evento 'messages.upsert' vai capturar essa mensagem e salvar no banco automaticamente
        res.json({ success: true, messageId: result?.key?.id })
    } catch (error) {
        res.status(500).json({ success: false, error: error.message })
    }
})

// Rota de Logout
app.post("/logout", async (req, res) => {
    try {
        if (sock) await sock.logout()
        // Opcional: Limpar tabela de chats no banco? Geralmente não, apenas desconecta.
        connectionStatus.connected = false
        res.json({ success: true })
    } catch (err) {
        res.status(500).json({ success: false })
    }
})

const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
    console.log(`[SERVER] 🌐 Servidor Express rodando na porta ${PORT}`)
})