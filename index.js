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
const fs = require('fs') // Necessário para verificar se existe sessão salva

const app = express()
app.use(cors())

// AJUSTE DE LIMITE DE PAYLOAD
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

// ESTADO
let sock = null
let isStarting = false
let lastQrDataUrl = null
let qrTimeout = null // ⏱️ Variável para controlar os 5 minutos

const connectionStatus = {
    connected: false,
    phone: null,
    status: "disconnected",
}

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
        if (error) console.error("[DB] Erro status:", error.message)
    } catch (err) { console.error("[DB] Erro:", err) }
}

// --- FUNÇÕES AUXILIARES DE MENSAGEM ---
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
async function startWhatsApp(isManualStart = false) {
    // Se já estiver conectado ou iniciando, ignora
    if (sock?.user || isStarting) {
        console.log("[WHATSAPP] Já está rodando ou iniciando.");
        return;
    }

    // 🛑 VERIFICAÇÃO DE LOGIN:
    // Se NÃO for manual (boot do server) E NÃO tiver credenciais salvas, 
    // não faz nada. Espera o usuário clicar no botão.
    const hasAuthInfo = fs.existsSync("./auth_info/creds.json");
    if (!isManualStart && !hasAuthInfo) {
        console.log("[WHATSAPP] 🛑 Nenhuma sessão salva. Aguardando comando manual para gerar QR.");
        await updateStatusInDb("disconnected", null, null);
        return;
    }

    isStarting = true
    
    // Limpa timer anterior se existir
    if (qrTimeout) clearTimeout(qrTimeout);

    try {
        console.log("[WHATSAPP] 🚀 Iniciando conexão...")
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
            printQRInTerminal: true, // Útil para debug
        })

        sock.ev.on("creds.update", saveCreds)

        // --- TIMER DE 5 MINUTOS PARA QR CODE ---
        // Se após 5 minutos não conectar, derruba tudo.
        qrTimeout = setTimeout(async () => {
            if (!sock?.user) {
                console.log("[TIMEOUT] ⏰ 5 minutos passaram. Desligando socket.");
                try {
                    await sock.logout(); // Tenta logout limpo
                } catch (e) {}
                try {
                    sock.end(undefined); // Força fechar
                } catch (e) {}
                
                sock = null;
                isStarting = false;
                lastQrDataUrl = null;
                await updateStatusInDb("disconnected", null, null);
            }
        }, 5 * 60 * 1000); // 5 Minutos em ms


        // --- EVENTOS ---
        sock.ev.on("contacts.upsert", (contacts) => {
            contacts.forEach(c => { if (c.name) contactStore[c.id] = c.name })
        })

        sock.ev.on("messaging-history.set", async ({ chats, contacts, messages }) => {
            console.log(`[SYNC] 🌊 Importando histórico...`)
            // Limpa o timer de timeout pois CONECTOU COM SUCESSO
            if (qrTimeout) clearTimeout(qrTimeout);

            // ... (Lógica de mensagens mantida igual - omitida para brevidade) ...
            // ... (Use o mesmo bloco de código da resposta anterior para processar chats/msgs) ...
            
            // Mas mantenha este trecho essencial no final do evento history.set:
            await updateStatusInDb("connected", null, sock?.user?.id)
            console.log("[SYNC] ✅ Sincronização e Conexão Confirmadas.")
        })

        sock.ev.on("messages.upsert", async ({ messages, type }) => {
            // ... (Lógica de novas mensagens mantida igual) ...
            // Apenas para garantir, copiei a lógica simplificada:
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
                if (!contactStore[chatId] && msg.pushName) updateData.name = msg.pushName
                await supabase.from("chats").update(updateData).eq("id", chatId)
            }
        })

        sock.ev.on("connection.update", async (update) => {
            const { connection, lastDisconnect, qr } = update
            
            if (qr) {
                // QR Code gerado (o Baileys muda ele a cada ~40s, isso é normal)
                // Nós atualizamos o banco, mas o timer de 5min continua rodando
                lastQrDataUrl = await qrcode.toDataURL(qr)
                connectionStatus.status = "qr"
                console.log("[STATUS] 📱 Novo QR Code gerado (Janela de 5min ativa)")
                await updateStatusInDb("qr", lastQrDataUrl, null)
            }
            
            if (connection === "open") {
                // SUCESSO: Cancela o timer de desligamento
                if (qrTimeout) clearTimeout(qrTimeout);
                
                connectionStatus.connected = true
                connectionStatus.phone = sock.user?.id
                connectionStatus.status = "connected"
                lastQrDataUrl = null
                console.log("[WHATSAPP] ✅ Online e Estável")
                await updateStatusInDb("connected", null, sock.user?.id)
            }
            
            if (connection === "close") {
                const reason = new Boom(lastDisconnect?.error)?.output?.statusCode
                connectionStatus.connected = false
                connectionStatus.status = "disconnected"
                lastQrDataUrl = null
                
                console.log("[STATUS] ❌ Caiu. Razão:", reason)
                await updateStatusInDb("disconnected", null, null)

                // LÓGICA DE RECONEXÃO INTELIGENTE:
                // Só reconecta se:
                // 1. Não foi Logout manual
                // 2. Não foi Timeout dos 5 minutos (nosso controle)
                // 3. JÁ ESTAVA LOGADO ANTES (tem sessão)
                
                const hasSession = fs.existsSync("./auth_info/creds.json");

                if (reason !== DisconnectReason.loggedOut && hasSession) {
                    console.log("🔄 Tentando reconectar automaticamente...");
                    isStarting = false
                    setTimeout(() => startWhatsApp(false), 3000)
                } else {
                    console.log("🛑 Conexão encerrada. Aguardando comando manual.");
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

// Inicia automaticamente APENAS se tiver sessão salva
startWhatsApp(false);

const handleShutdown = async (signal) => {
    console.log(`[SERVER] 🛑 Shutdown: ${signal}`);
    try {
        await updateStatusInDb("disconnected", null, null);
        if (sock) sock.end(undefined);
    } finally { process.exit(0); }
};
process.on('SIGINT', () => handleShutdown('SIGINT'));
process.on('SIGTERM', () => handleShutdown('SIGTERM'));

// --- ROTAS ---

// 🆕 ROTA NOVA: Botão "Gerar QR Code" chama isso
app.post("/session/connect", async (req, res) => {
    console.log("[API] Solicitada nova conexão manual");
    // Força reset se estiver travado
    if (sock) {
        try { sock.end(undefined); sock = null; } catch(e){}
    }
    isStarting = false;
    
    // Inicia com flag manual = true
    startWhatsApp(true); 
    res.json({ success: true, message: "Iniciando sessão por 5 minutos..." });
});

// 🆕 ROTA NOVA: Botão "Desconectar"
app.post("/session/disconnect", async (req, res) => {
    try {
        if (sock) await sock.logout();
        if (qrTimeout) clearTimeout(qrTimeout);
        sock = null;
        isStarting = false;
        await updateStatusInDb("disconnected", null, null);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Rotas antigas mantidas para compatibilidade
app.get("/health", (req, res) => res.json({ ok: true, status: connectionStatus }))
app.get("/qr", (req, res) => {
    if (connectionStatus.connected) return res.send("ALREADY_CONNECTED")
    if (!lastQrDataUrl) return res.status(202).send("QR_NOT_READY")
    return res.send(lastQrDataUrl)
})

// ... (Copie aqui as rotas de /chats, /messages, /media e /send do código anterior) ...
// ... (Elas não mudam) ...

// Rota de Logout antiga (redireciona para a nova lógica)
app.post("/logout", async (req, res) => {
    try {
        if (sock) await sock.logout()
        await updateStatusInDb("disconnected", null, null)
        res.json({ success: true })
    } catch (err) { res.status(500).json({ success: false }) }
})

const PORT = process.env.PORT || 3000
app.listen(PORT, () => console.log(`[SERVER] 🌐 Porta ${PORT}`))