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

// Aumentando limite de payload para garantir recebimento de mídias grandes
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
let qrTimeout = null
let hasSyncedHistory = false // ✅ FLAG para evitar múltiplas sincronizações

const connectionStatus = {
    connected: false,
    phone: null,
    status: "disconnected",
}

let contactStore = {}

// GARANTE QUE A PASTA DE SESSÃO EXISTE
if (!fs.existsSync('./auth_info')) {
    fs.mkdirSync('./auth_info', { recursive: true });
}

// --- FUNÇÃO DE STATUS DO BANCO ---
async function updateStatusInDb(status, qrCode = null, phone = null) {
    try {
        console.log(`[DB] 📝 Atualizando status para: ${status}`)
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

// --- FUNÇÕES AUXILIARES ---
function getMessageText(msg) {
    if (!msg || !msg.message) return ""
    const content = msg.message
    if (content.conversation) return content.conversation
    if (content.extendedTextMessage?.text) return content.extendedTextMessage.text
    if (content.imageMessage?.caption) return content.imageMessage.caption
    if (content.videoMessage?.caption) return content.videoMessage.caption
    if (content.documentMessage?.caption) return content.documentMessage.caption
    if (content.audioMessage) return "🎵 Áudio"
    if (content.stickerMessage) return "🏷️ Sticker"
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
        const mediaMsg = msg.message?.imageMessage || msg.message?.videoMessage || 
                         msg.message?.audioMessage || msg.message?.documentMessage || 
                         msg.message?.stickerMessage
        if (mediaMsg) {
            mediaMeta = {
                mimetype: mediaMsg.mimetype || null,
                fileLength: mediaMsg.fileLength ? Number(mediaMsg.fileLength) : null,
                fileName: mediaMsg.fileName || null,
                seconds: mediaMsg.seconds || null,
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
    if (chatName && chatName.trim() !== "" && !chatName.includes("@")) {
        return chatName;
    }
    if (contactStore[chatId]) {
        return contactStore[chatId];
    }
    if (pushName && pushName.trim() !== "") {
        return pushName;
    }
    return chatId.split("@")[0];
}

// --- WHATSAPP START ---
async function startWhatsApp(isManualStart = false) {
    if (isStarting) {
        console.log("[START] Já existe uma inicialização em andamento...");
        return;
    }
    isStarting = true;
    hasSyncedHistory = false; // ✅ Reset flag ao iniciar nova conexão

    console.log("[WHATSAPP] Iniciando...");
    if (sock) {
        sock.ev.removeAllListeners();
        sock = null;
    }

    const { state, saveCreds } = await useMultiFileAuthState("./auth_info");
    const { version } = await fetchLatestBaileysVersion();

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
        defaultQueryTimeoutMs: undefined,
        emitOwnEvents: true,
        markOnlineOnConnect: true,
        getMessage: async () => undefined,
    });

    sock.ev.on("creds.update", saveCreds);

    // --- SINCRONIZAÇÃO EM LOTES (PIPELINE) ---
    sock.ev.on("messaging-history.set", async ({ chats, contacts, messages, isLatest }) => {
        // ✅ EVITA MÚLTIPLAS SINCRONIZAÇÕES - VERIFICAÇÃO NO INÍCIO
        if (hasSyncedHistory) {
            console.log(`[SYNC] ⏭️ Ignorando sync adicional (já sincronizado). Recebido: ${messages.length} msgs.`)
            return
        }

        // ✅ MARCA IMEDIATAMENTE para evitar race conditions
        hasSyncedHistory = true

        console.log(`[SYNC] 🌊 Recebido: ${chats.length} chats, ${messages.length} msgs. isLatest: ${isLatest}`)
        if (qrTimeout) clearTimeout(qrTimeout);

        if (contacts) {
            contacts.forEach(c => { if (c.name) contactStore[c.id] = c.name })
        }

        // Popular contactStore também dos pushNames das mensagens
        messages.forEach(m => {
            if (m.pushName) {
                const senderId = m.key.participant || m.key.remoteJid
                if (!contactStore[senderId]) {
                    contactStore[senderId] = m.pushName
                }
            }
        })

        // ✅ FILTRO DE 6 MESES
        const SIX_MONTHS_MS = 6 * 30 * 24 * 60 * 60 * 1000 // ~180 dias
        const cutoffTimestamp = Date.now() - SIX_MONTHS_MS

        // 1. CHATS (Lotes de 25)
        const privateChats = chats.filter(c => !c.id.includes("@g.us"));
        const CHAT_BATCH_SIZE = 25;
        
        console.log(`[SYNC] Salvando ${privateChats.length} chats...`);

        for (let i = 0; i < privateChats.length; i += CHAT_BATCH_SIZE) {
            let batch = privateChats.slice(i, i + CHAT_BATCH_SIZE).map(c => {
                let timestamp = c.conversationTimestamp ? Number(c.conversationTimestamp) : 0;
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
            
            batch = null; 
            await new Promise(r => setTimeout(r, 100)); 
        }

        // 2. MENSAGENS (Lotes de 50) - COM FILTRO DE 6 MESES
        const privateMessages = messages.filter(m => {
            if (!m.key.remoteJid || m.key.remoteJid.includes("@g.us")) return false
            
            // Filtro de 6 meses
            const msgTimestamp = Number(m.messageTimestamp) * 1000
            return msgTimestamp >= cutoffTimestamp
        });
        
        const MSG_BATCH_SIZE = 50;

        // Log útil para debug
        const totalFiltered = messages.length - privateMessages.length
        console.log(`[SYNC] Salvando ${privateMessages.length} mensagens (${totalFiltered} filtradas por idade/grupo)...`);

        for (let i = 0; i < privateMessages.length; i += MSG_BATCH_SIZE) {
            let batch = privateMessages.slice(i, i + MSG_BATCH_SIZE).map(m => prepareMessageForDB(m, m.key.remoteJid));
            
            const { error } = await supabase.from("messages").upsert(batch, { onConflict: 'id' });
            if (error) console.error(`[SYNC] Erro Msgs Lote ${i}:`, error.message);
            
            if (i % 500 === 0 && i > 0) console.log(`[SYNC] Progresso: ${i}/${privateMessages.length} msgs.`);

            batch = null; 
            if (global.gc && i % 1000 === 0) global.gc();

            await new Promise(r => setTimeout(r, 200)); 
        }
        
        // ✅ ATUALIZA STATUS PARA CONNECTED
        await updateStatusInDb("connected", null, sock?.user?.id)
        console.log("[SYNC] ✅ Sincronização COMPLETA. Status alterado para: connected")
        
        if (global.gc) global.gc()
    })

    // --- MENSAGENS EM TEMPO REAL ---
    sock.ev.on("messages.upsert", async ({ messages, type }) => {
        if (type !== "notify" && type !== "append") return
        for (const msg of messages) {
            const chatId = msg.key.remoteJid
            if (!chatId || chatId.includes("@g.us") || chatId === "status@broadcast") continue

            const msgDB = prepareMessageForDB(msg, chatId)
            const { error } = await supabase.from("messages").upsert(msgDB, { onConflict: 'id' })
            if (error) console.error("[MSG] Erro ao salvar:", error.message)
        }
    })

    // --- ATUALIZAÇÃO DE STATUS DA CONEXÃO ---
    sock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect, qr } = update
        
        if (qr) {
            lastQrDataUrl = await qrcode.toDataURL(qr)
            connectionStatus.status = "qr"
            console.log("[STATUS] 📱 QR Code gerado. Status alterado para: qr")
            await updateStatusInDb("qr", lastQrDataUrl, null)
        }
        
        if (connection === "open") {
            if (qrTimeout) clearTimeout(qrTimeout);
            connectionStatus.connected = true
            connectionStatus.phone = sock.user?.id
            connectionStatus.status = "syncing"
            lastQrDataUrl = null
            
            // ✅ ALTERA PARA SYNCING ASSIM QUE CONECTAR
            console.log("[WHATSAPP] ✅ Socket conectado. Status alterado para: syncing")
            await updateStatusInDb("syncing", null, sock.user?.id)
        }
        
        if (connection === "close") {
            const reason = new Boom(lastDisconnect?.error)?.output?.statusCode
            connectionStatus.connected = false
            connectionStatus.status = "disconnected"
            lastQrDataUrl = null
            hasSyncedHistory = false // ✅ Reset flag ao desconectar
            
            console.log("[STATUS] ❌ Desconectado. Razão:", reason, "- Status alterado para: disconnected")
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

    isStarting = false;
}

startWhatsApp(false);

const handleShutdown = async (signal) => {
    console.log(`\n[SHUTDOWN] Recebido ${signal}. Encerrando...`);
    await updateStatusInDb("disconnected", null, null);
    if (sock) {
        sock.ev.removeAllListeners();
        sock.end();
    }
    process.exit(0);
};
process.on('SIGINT', () => handleShutdown('SIGINT'));
process.on('SIGTERM', () => handleShutdown('SIGTERM'));

// --- ROTAS HTTP ---

app.get("/", (req, res) => res.send("WhatsApp API Online 🚀")); 

app.post("/session/connect", async (req, res) => {
    try {
        hasSyncedHistory = false; // ✅ Reset flag ao solicitar nova conexão
        await startWhatsApp(true);
        res.json({ success: true, message: "Iniciando conexão..." });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post("/session/disconnect", async (req, res) => {
    try {
        if (sock) {
            sock.logout();
        }
        // Limpa a pasta de autenticação
        if (fs.existsSync("./auth_info")) {
            fs.rmSync("./auth_info", { recursive: true, force: true });
            fs.mkdirSync("./auth_info", { recursive: true });
        }
        hasSyncedHistory = false; // ✅ Reset flag ao desconectar
        await updateStatusInDb("disconnected", null, null);
        res.json({ success: true, message: "Desconectado" });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get("/health", (req, res) => res.json({ ok: true, status: connectionStatus }))

app.get("/qr", (req, res) => {
    if (lastQrDataUrl) {
        res.json({ qr: lastQrDataUrl })
    } else {
        res.status(404).json({ error: "QR não disponível" })
    }
})

// ROTA PROXY DE AVATAR (O Backend baixa e entrega a imagem real)
app.get("/chats/avatar/:chatId", async (req, res) => {
    try {
        const { chatId } = req.params;
        if (!sock || connectionStatus.status !== "connected") {
            return res.status(503).json({ error: "WhatsApp não conectado" });
        }
        const url = await sock.profilePictureUrl(chatId, "image").catch(() => null);
        if (!url) {
            return res.status(404).json({ error: "Avatar não encontrado" });
        }
        const response = await fetch(url);
        const buffer = await response.arrayBuffer();
        res.set("Content-Type", response.headers.get("content-type") || "image/jpeg");
        res.set("Cache-Control", "public, max-age=86400");
        res.send(Buffer.from(buffer));
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get("/chats", async (req, res) => {
    try {
        const { data, error } = await supabase
            .from("chats")
            .select("*")
            .order("last_message_time", { ascending: false });
        if (error) throw error;
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get("/chats/:chatId/messages", async (req, res) => {
    try {
        const { chatId } = req.params;
        const { limit = 50, before } = req.query;
        
        let query = supabase
            .from("messages")
            .select("*")
            .eq("chat_id", chatId)
            .order("timestamp", { ascending: false })
            .limit(Number(limit));
        
        if (before) {
            query = query.lt("timestamp", Number(before));
        }
        
        const { data, error } = await query;
        if (error) throw error;
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get("/media/:chatId/:messageId", async (req, res) => {
    try {
        const { chatId, messageId } = req.params;
        
        if (!sock || connectionStatus.status !== "connected") {
            return res.status(503).json({ error: "WhatsApp não conectado" });
        }
        
        // Busca a mensagem no store do Baileys
        const msg = await sock.loadMessage(chatId, messageId);
        if (!msg) {
            return res.status(404).json({ error: "Mensagem não encontrada" });
        }
        
        const buffer = await downloadMediaMessage(msg, "buffer", {});
        const mediaMsg = msg.message?.imageMessage || msg.message?.videoMessage || 
                         msg.message?.audioMessage || msg.message?.documentMessage;
        
        res.set("Content-Type", mediaMsg?.mimetype || "application/octet-stream");
        res.set("Cache-Control", "public, max-age=86400");
        res.send(buffer);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post("/chats/send", async (req, res) => {
    try {
        const { chatId, message } = req.body;
        
        if (!sock || connectionStatus.status !== "connected") {
            return res.status(503).json({ error: "WhatsApp não conectado" });
        }
        
        if (!chatId || !message) {
            return res.status(400).json({ error: "chatId e message são obrigatórios" });
        }
        
        const result = await sock.sendMessage(chatId, { text: message });
        res.json({ success: true, messageId: result.key.id });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

const PORT = process.env.PORT || 3000
app.listen(PORT, () => console.log(`[SERVER] 🌐 Porta ${PORT}`))