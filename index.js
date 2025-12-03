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

// ESTADO
let sock = null
let lastQrDataUrl = null
let qrTimeout = null
let hasSyncedHistory = false
let isStarting = false  // ← ÚNICO LOCK NECESSÁRIO

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

// ============================================================
// 📡 FUNÇÃO DE ATUALIZAÇÃO DE STATUS - TEMPO REAL
// ============================================================
async function updateStatus(newStatus, qrCode = null, phone = null, extraInfo = null) {
    connectionStatus.status = newStatus
    connectionStatus.connected = (newStatus === "connected" || newStatus === "syncing")
    connectionStatus.phone = phone
    
    const statusEmojis = {
        disconnected: "🔴",
        qr: "📱",
        syncing: "🔄",
        connected: "🟢"
    }
    
    const statusMessages = {
        disconnected: "Desconectado",
        qr: "QR Code aguardando escaneamento",
        syncing: "Conectado - Sincronizando mensagens",
        connected: "Conectado e pronto"
    }
    
    console.log(`[STATUS] ${statusEmojis[newStatus]} ${statusMessages[newStatus]}${extraInfo ? ` (${extraInfo})` : ''}`)
    
    try {
        const updateData = {
            id: 1,
            status: newStatus,
            updated_at: new Date().toISOString()
        }
        
        if (newStatus === "qr" && qrCode) {
            updateData.qr_code = qrCode
        } else if (newStatus !== "qr") {
            updateData.qr_code = null
        }
        
        if (phone) {
            updateData.phone = phone
        }
        
        const { error } = await supabase
            .from("instance_settings")
            .upsert(updateData)
        
        if (error) {
            console.error("[STATUS] ❌ Erro ao atualizar no banco:", error.message)
        }
    } catch (err) {
        console.error("[STATUS] ❌ Erro:", err.message)
    }
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

// ✅ CORRIGIDO: Removido media_metadata que não existe no banco
function prepareMessageForDB(msg, chatId) {
    const type = getMessageType(msg)
    const hasMedia = ["image", "video", "audio", "document", "sticker"].includes(type)

    return {
        id: msg.key.id,
        chat_id: chatId,
        sender: msg.key.fromMe ? "me" : (msg.key.participant || chatId),
        content: getMessageText(msg),
        timestamp: Number(msg.messageTimestamp) * 1000,
        from_me: msg.key.fromMe || false,  // ← CORRIGIDO: era is_from_me
        type: type,
        has_media: hasMedia,
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

// ============================================================
// 🚀 WHATSAPP START - FUNÇÃO PRINCIPAL
// ============================================================
async function startWhatsApp() {
    // ✅ LOCK ÚNICO E SIMPLES
    if (isStarting) {
        console.log("[START] ⚠️ Já existe uma inicialização em andamento...");
        return;
    }
    
    isStarting = true
    hasSyncedHistory = false

    console.log("[WHATSAPP] 🚀 Iniciando conexão...");
    
    // Limpa socket anterior se existir
    if (sock) {
        try {
            sock.ev.removeAllListeners();
            sock.end();
        } catch (e) {}
        sock = null;
    }

    try {
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

        // ============================================================
        // 📨 EVENTO: ATUALIZAÇÃO DE CONEXÃO
        // ============================================================
        sock.ev.on("connection.update", async (update) => {
            const { connection, lastDisconnect, qr } = update
            
            // 📱 QR CODE GERADO
            if (qr) {
                lastQrDataUrl = await qrcode.toDataURL(qr)
                await updateStatus("qr", lastQrDataUrl, null)
            }
            
            // ✅ CONEXÃO ABERTA
            if (connection === "open") {
                if (qrTimeout) clearTimeout(qrTimeout);
                lastQrDataUrl = null
                isStarting = false  // ← LIBERA LOCK
                
                const phoneId = sock.user?.id
                await updateStatus("syncing", null, phoneId, "Iniciando sincronização")
            }
            
            // ❌ CONEXÃO FECHADA
            if (connection === "close") {
                const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode
                const reason = DisconnectReason[statusCode] || statusCode
                
                lastQrDataUrl = null
                hasSyncedHistory = false
                isStarting = false  // ← LIBERA LOCK
                
                await updateStatus("disconnected", null, null, `Razão: ${reason}`)

                // ✅ RECONEXÃO APENAS SE TEM SESSÃO VÁLIDA E NÃO FOI LOGOUT
                const hasSession = fs.existsSync("./auth_info/creds.json");
                if (statusCode !== DisconnectReason.loggedOut && hasSession) {
                    console.log("[WHATSAPP] 🔄 Reconectando em 5 segundos...");
                    setTimeout(() => startWhatsApp(), 5000)
                } else {
                    sock = null
                }
            }
        })

        // ============================================================
        // 📚 EVENTO: SINCRONIZAÇÃO DE HISTÓRICO
        // ============================================================
        sock.ev.on("messaging-history.set", async ({ chats, contacts, messages, isLatest }) => {
            if (hasSyncedHistory) {
                console.log(`[SYNC] ⏭️ Ignorando sync adicional. Recebido: ${messages.length} msgs.`)
                return
            }

            hasSyncedHistory = true

            console.log(`[SYNC] 📚 Recebido: ${chats.length} chats, ${messages.length} msgs.`)
            if (qrTimeout) clearTimeout(qrTimeout);

            if (contacts) {
                contacts.forEach(c => { if (c.name) contactStore[c.id] = c.name })
            }
            messages.forEach(m => {
                if (m.pushName) {
                    const senderId = m.key.participant || m.key.remoteJid
                    if (!contactStore[senderId]) {
                        contactStore[senderId] = m.pushName
                    }
                }
            })

            const SIX_MONTHS_MS = 6 * 30 * 24 * 60 * 60 * 1000
            const cutoffTimestamp = Date.now() - SIX_MONTHS_MS

            // 1. SALVAR CHATS
            const privateChats = chats.filter(c => !c.id.includes("@g.us"));
            const CHAT_BATCH_SIZE = 25;
            
            console.log(`[SYNC] 💬 Salvando ${privateChats.length} chats...`);

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
                if (error) console.error(`[SYNC] Erro Chats:`, error.message);
                
                batch = null; 
                await new Promise(r => setTimeout(r, 100)); 
            }

            // 2. SALVAR MENSAGENS
            const privateMessages = messages.filter(m => {
                if (!m.key.remoteJid || m.key.remoteJid.includes("@g.us")) return false
                const msgTimestamp = Number(m.messageTimestamp) * 1000
                return msgTimestamp >= cutoffTimestamp
            });
            
            const MSG_BATCH_SIZE = 50;
            const totalFiltered = messages.length - privateMessages.length
            console.log(`[SYNC] 📝 Salvando ${privateMessages.length} mensagens (${totalFiltered} filtradas)...`);

            for (let i = 0; i < privateMessages.length; i += MSG_BATCH_SIZE) {
                let batch = privateMessages.slice(i, i + MSG_BATCH_SIZE).map(m => prepareMessageForDB(m, m.key.remoteJid));
                
                const { error } = await supabase.from("messages").upsert(batch, { onConflict: 'id' });
                if (error) console.error(`[SYNC] Erro Msgs:`, error.message);
                
                if (i % 500 === 0 && i > 0) {
                    const percent = Math.round((i / privateMessages.length) * 100)
                    console.log(`[SYNC] 📊 Progresso: ${percent}% (${i}/${privateMessages.length})`);
                }

                batch = null; 
                if (global.gc && i % 1000 === 0) global.gc();
                await new Promise(r => setTimeout(r, 200)); 
            }
            
            await updateStatus("connected", null, sock?.user?.id, "Sincronização completa")
            console.log("[SYNC] ✅ Sincronização finalizada com sucesso!")
            
            if (global.gc) global.gc()
        })

        // ============================================================
        // 💬 EVENTO: MENSAGENS EM TEMPO REAL
        // ============================================================
        sock.ev.on("messages.upsert", async ({ messages, type }) => {
            if (type !== "notify" && type !== "append") return
            
            for (const msg of messages) {
                const chatId = msg.key.remoteJid
                if (!chatId || chatId.includes("@g.us") || chatId === "status@broadcast") continue

                const msgDB = prepareMessageForDB(msg, chatId)
                const { error } = await supabase.from("messages").upsert(msgDB, { onConflict: 'id' })
                if (error) console.error("[MSG] Erro:", error.message)
            }
        })

    } catch (error) {
        console.error("[START] ❌ Erro ao iniciar:", error.message)
        await updateStatus("disconnected", null, null, `Erro: ${error.message}`)
        isStarting = false
    }
}

// ============================================================
// 🔌 INICIALIZAÇÃO - SÓ CONECTA SE TEM SESSÃO SALVA
// ============================================================
const hasExistingSession = fs.existsSync("./auth_info/creds.json");
if (hasExistingSession) {
    console.log("[INIT] 📂 Sessão encontrada, reconectando automaticamente...");
    startWhatsApp();
} else {
    console.log("[INIT] 📂 Nenhuma sessão encontrada. Aguardando /session/connect...");
    updateStatus("disconnected", null, null, "Aguardando conexão manual");
}

const handleShutdown = async (signal) => {
    console.log(`\n[SHUTDOWN] Recebido ${signal}. Encerrando...`);
    await updateStatus("disconnected", null, null, "Servidor encerrado")
    if (sock) {
        sock.ev.removeAllListeners();
        sock.end();
    }
    process.exit(0);
};
process.on('SIGINT', () => handleShutdown('SIGINT'));
process.on('SIGTERM', () => handleShutdown('SIGTERM'));

// ============================================================
// 🌐 ROTAS HTTP
// ============================================================

app.get("/", (req, res) => res.send("WhatsApp API Online 🚀")); 

app.get("/health", (req, res) => res.json({ 
    ok: true, 
    status: connectionStatus.status,
    connected: connectionStatus.connected,
    phone: connectionStatus.phone
}))

app.get("/qr", (req, res) => {
    if (connectionStatus.status === "qr" && lastQrDataUrl) {
        res.json({ qr: lastQrDataUrl, status: "qr" })
    } else {
        res.json({ qr: null, status: connectionStatus.status })
    }
})

app.post("/session/connect", async (req, res) => {
    try {
        // Se já está conectado ou sincronizando
        if (connectionStatus.status === "connected" || connectionStatus.status === "syncing") {
            return res.json({ 
                success: true, 
                message: "Já conectado",
                status: connectionStatus.status 
            });
        }
        
        // Se já está gerando QR
        if (connectionStatus.status === "qr") {
            return res.json({ 
                success: true, 
                message: "QR Code já disponível",
                status: "qr"
            });
        }
        
        // Se já está iniciando
        if (isStarting) {
            return res.json({ 
                success: true, 
                message: "Conexão em andamento",
                status: "connecting"
            });
        }
        
        // ✅ INICIA NOVA CONEXÃO
        startWhatsApp();
        res.json({ success: true, message: "Iniciando conexão..." });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post("/session/disconnect", async (req, res) => {
    try {
        isStarting = false
        hasSyncedHistory = false
        
        if (sock) {
            try {
                await sock.logout();
            } catch (e) {
                console.log("[DISCONNECT] Erro no logout:", e.message)
            }
            sock.ev.removeAllListeners();
            sock.end();
            sock = null;
        }
        
        // Limpa pasta de autenticação
        if (fs.existsSync("./auth_info")) {
            fs.rmSync("./auth_info", { recursive: true, force: true });
            fs.mkdirSync("./auth_info", { recursive: true });
        }
        
        await updateStatus("disconnected", null, null, "Logout manual")
        
        res.json({ success: true, message: "Desconectado com sucesso" });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// PROXY DE AVATAR
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