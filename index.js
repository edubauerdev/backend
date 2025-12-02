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
    downloadContentFromMessage,
    jidNormalizedUser
} = require("@whiskeysockets/baileys")
const qrcode = require("qrcode")
const fs = require('fs')
const path = require('path')
const mime = require('mime-types')

// --- CONFIGURAÇÃO INICIAL ---
const app = express()
app.use(cors())
app.use(express.json())

// Configuração de pasta pública para Mídias (Zero RAM overhead para servir arquivos)
const MEDIA_FOLDER = path.join(__dirname, 'public', 'media');
if (!fs.existsSync(MEDIA_FOLDER)) {
    fs.mkdirSync(MEDIA_FOLDER, { recursive: true });
}
app.use('/media', express.static(MEDIA_FOLDER));

// --- SUPABASE ---
const supabaseUrl = process.env.SUPABASE_URL
const supabaseKey = process.env.SUPABASE_KEY
// URL Pública do seu servidor para montar os links de mídia
const PUBLIC_API_URL = process.env.API_URL || 'http://localhost:3000';

if (!supabaseUrl || !supabaseKey) {
    console.error("❌ ERRO: Configure .env corretamente")
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
const connectionStatus = { connected: false, phone: null, status: "disconnected" }

// --- FUNÇÕES AUXILIARES ---

async function updateStatusInDb(status, qrCode = null, phone = null) {
    try {
        await supabase.from("instance_settings").upsert({
            id: 1,
            status: status,
            qr_code: qrCode,
            phone: phone,
            updated_at: new Date()
        })
    } catch (err) { console.error("[DB] Erro status:", err) }
}

// Download de mídia OTIMIZADO (Stream -> Disco)
// Não carrega o arquivo inteiro na RAM em momento algum
async function processMediaAndSave(msg, messageId, type) {
    try {
        const messageContent = msg.message[type + "Message"] || msg.message[type];
        if (!messageContent) return null;

        const stream = await downloadContentFromMessage(messageContent, type.replace('Message', ''));
        const ext = mime.extension(messageContent.mimetype) || 'bin';
        const fileName = `${messageId}.${ext}`;
        const filePath = path.join(MEDIA_FOLDER, fileName);

        const writeStream = fs.createWriteStream(filePath);
        
        await new Promise((resolve, reject) => {
            stream.pipe(writeStream);
            stream.on('end', resolve);
            stream.on('error', reject);
        });

        // Retorna a URL pública acessível pelo Front
        return {
            url: `${PUBLIC_API_URL}/media/${fileName}`,
            mimetype: messageContent.mimetype,
            fileName: fileName
        };
    } catch (error) {
        console.error(`[MEDIA] Erro ao baixar mídia ${messageId}:`, error.message);
        return null;
    }
}

function getMessageText(msg) {
    if (!msg || !msg.message) return ""
    const content = msg.message
    return content.conversation || 
           content.extendedTextMessage?.text || 
           content.imageMessage?.caption || 
           content.videoMessage?.caption || 
           "";
}

function getMessageType(msg) {
    if (!msg.message) return "text"
    const types = ["imageMessage", "videoMessage", "audioMessage", "documentMessage", "stickerMessage"];
    const found = types.find(t => msg.message[t]);
    return found ? found.replace("Message", "") : "text";
}

// Função de preparação otimizada
async function prepareMessageForDB(msg, chatId) {
    try {
        const type = getMessageType(msg)
        const hasMedia = ["image", "video", "audio", "document", "sticker"].includes(type)
        let mediaMeta = null

        // Se tiver mídia, baixa para o disco AGORA
        if (hasMedia) {
            mediaMeta = await processMediaAndSave(msg, msg.key.id, type);
        }

        const textContent = getMessageText(msg);
        // Se não tem texto nem mídia válida, ignora
        if (!textContent && !hasMedia) return null;

        let ts = Number(msg.messageTimestamp);
        if (isNaN(ts) || ts === 0) ts = Math.floor(Date.now() / 1000);
        
        return {
            id: msg.key.id,
            chat_id: jidNormalizedUser(chatId),
            sender_id: jidNormalizedUser(msg.key.participant || msg.key.remoteJid || chatId),
            content: textContent || (hasMedia ? `[${type}]` : ""),
            timestamp: new Date(ts * 1000).toISOString(), // Postgres prefere ISO String
            from_me: msg.key.fromMe || false,
            type: type,
            has_media: hasMedia && mediaMeta !== null,
            media_meta: mediaMeta, // Salva o JSON com a URL local
            ack: msg.status || 0
        }
    } catch (err) {
        console.error("[PREPARE] Erro fatal message:", err);
        return null;
    }
}

// --- CORE DO WHATSAPP ---
async function startWhatsApp(isManualStart = false) {
    if (sock?.user || isStarting) return;

    const hasAuthInfo = fs.existsSync("./auth_info/creds.json");
    if (!isManualStart && !hasAuthInfo) {
        console.log("[WHATSAPP] 🛑 Aguardando inicio manual via API.");
        await updateStatusInDb("disconnected");
        return;
    }

    isStarting = true
    if (qrTimeout) clearTimeout(qrTimeout);

    try {
        console.log("[WHATSAPP] 🚀 Iniciando socket (Low Memory Mode)...")
        const { version } = await fetchLatestBaileysVersion()
        const { state, saveCreds } = await useMultiFileAuthState("./auth_info")

        sock = makeWASocket({
            version,
            logger: pino({ level: "error" }), // Log mínimo para economizar CPU
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "error" })),
            },
            browser: ["Server Worker", "Chrome", "1.0.0"],
            syncFullHistory: true,
            generateHighQualityLinkPreview: false, // Desligado para economizar RAM
            connectTimeoutMs: 60000, 
            getMessage: async () => { return { conversation: "" } } 
        })

        sock.ev.on("creds.update", saveCreds)

        // Limpeza de timeout do QR
        if (isManualStart) {
            qrTimeout = setTimeout(async () => {
                if (!sock?.user) {
                    try { sock.end(undefined); } catch (e) {}
                    sock = null;
                    isStarting = false;
                    await updateStatusInDb("disconnected");
                }
            }, 3 * 60 * 1000); // 3 minutos
        }

        // ============================================================
        // SINCRONIZAÇÃO INICIAL (O MOMENTO CRÍTICO DA MEMÓRIA)
        // ============================================================
        sock.ev.on("messaging-history.set", async ({ chats, messages }) => {
            console.log(`[SYNC] 🌊 Recebido histórico: ${chats.length} chats, ${messages.length} msgs`);
            
            if (qrTimeout) clearTimeout(qrTimeout);

            try {
                // 1. INSERÇÃO DE CHATS (LOTE)
                // Inserimos o básico. O Trigger do banco vai corrigir unread_count e last_message depois.
                const cleanChats = chats.map(c => ({
                    id: jidNormalizedUser(c.id),
                    name: c.name || c.verifiedName || c.notify || jidNormalizedUser(c.id).split('@')[0],
                    last_message_at: new Date( (c.conversationTimestamp || Date.now()/1000) * 1000 ).toISOString()
                })).filter(c => !c.id.includes('@g.us') && !c.id.includes('broadcast'));

                // Batch insert de 100 em 100
                for (let i = 0; i < cleanChats.length; i += 100) {
                    await supabase.from("chats").upsert(cleanChats.slice(i, i + 100), { onConflict: 'id' });
                }
                
                // Libera memória imediata
                chats = null; 
                if (global.gc) global.gc();

                // 2. INSERÇÃO DE MENSAGENS
                // Processamento serial para não estourar a RAM baixando mídias
                console.log("[SYNC] 📨 Processando mensagens...");
                
                const validMsgs = messages.filter(m => !m.key.remoteJid.includes('@g.us'));
                
                // Buffer para batch insert no banco
                let batchBuffer = [];
                
                for (const msg of validMsgs) {
                    const chatId = jidNormalizedUser(msg.key.remoteJid);
                    const prepared = await prepareMessageForDB(msg, chatId);
                    
                    if (prepared) batchBuffer.push(prepared);

                    // Se o buffer encher, salva no banco e limpa
                    if (batchBuffer.length >= 50) {
                        await supabase.from("messages").upsert(batchBuffer, { onConflict: 'id' });
                        batchBuffer = []; // Limpa array
                        if (global.gc) global.gc(); // Força limpeza
                    }
                }

                // Salva o resto
                if (batchBuffer.length > 0) {
                    await supabase.from("messages").upsert(batchBuffer, { onConflict: 'id' });
                }

                console.log("[SYNC] ✅ Sincronização completa.");
                await updateStatusInDb("connected", null, sock?.user?.id);

            } catch (error) {
                console.error("[SYNC] ❌ Falha:", error);
            }
        })

        // ============================================================
        // NOVAS MENSAGENS (EVENTO REALTIME)
        // ============================================================
        sock.ev.on("messages.upsert", async ({ messages, type }) => {
            if (type !== "notify") return; // Ignora appends soltos fora do sync

            for (const msg of messages) {
                const chatId = jidNormalizedUser(msg.key.remoteJid);
                
                // Filtros de segurança
                if (chatId === "status@broadcast") continue;
                if (chatId.includes("@g.us")) continue; // Se não suportar grupos

                // 1. Atualizar nome do chat se disponível (Opcional, mas útil)
                if (msg.pushName && !msg.key.fromMe) {
                    // Não espere (await) isso, fire and forget
                    supabase.from('chats').update({ name: msg.pushName }).eq('id', chatId).then();
                }

                // 2. Preparar e Salvar Mensagem
                // O Trigger do banco vai atualizar a tabela 'chats' automaticamente
                const msgDB = await prepareMessageForDB(msg, chatId);
                if (msgDB) {
                    await supabase.from("messages").upsert(msgDB);
                    console.log(`[MSG] Salva: ${msgDB.id}`);
                }
            }
        })

        sock.ev.on("connection.update", async (update) => {
            const { connection, lastDisconnect, qr } = update
            
            if (qr) {
                lastQrDataUrl = await qrcode.toDataURL(qr)
                await updateStatusInDb("qr", lastQrDataUrl)
            }
            
            if (connection === "open") {
                if (qrTimeout) clearTimeout(qrTimeout);
                lastQrDataUrl = null
                await updateStatusInDb("connected", null, sock.user?.id)
            }
            
            if (connection === "close") {
                const reason = new Boom(lastDisconnect?.error)?.output?.statusCode
                lastQrDataUrl = null
                await updateStatusInDb("disconnected")
                
                if (reason !== DisconnectReason.loggedOut) {
                    setTimeout(() => startWhatsApp(false), 5000)
                } else {
                    sock = null
                    isStarting = false
                    // Se deslogou, apaga credenciais para evitar loop
                    fs.rmSync("./auth_info", { recursive: true, force: true });
                }
            }
        })

    } catch (err) {
        console.error("Erro start:", err)
        isStarting = false
    }
}

// Inicializa
startWhatsApp(false);

// --- ROTAS DE CONTROLE (SÓ O NECESSÁRIO) ---

app.get("/", (req, res) => res.send("WhatsApp Worker Running. Frontend must use Supabase Direct.")); 

app.post("/session/connect", async (req, res) => {
    if (sock) { try { sock.end(undefined); sock = null; } catch(e){} }
    isStarting = false;
    // Limpa credenciais antigas para garantir QR novo
    fs.rmSync("./auth_info", { recursive: true, force: true });
    startWhatsApp(true); 
    res.json({ success: true });
});

app.post("/session/disconnect", async (req, res) => {
    try {
        if (sock) await sock.logout();
        sock = null;
        isStarting = false;
        await updateStatusInDb("disconnected");
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/qr", (req, res) => {
    if (connectionStatus.connected) return res.send("ALREADY_CONNECTED")
    if (!lastQrDataUrl) return res.status(202).send("QR_NOT_READY")
    return res.send(lastQrDataUrl)
})

// Rota Opcional de Envio (Write)
app.post("/chats/send", async (req, res) => {
    const { chatId, message } = req.body
    if (!sock) return res.status(400).json({ success: false })
    
    try {
        const id = jidNormalizedUser(chatId);
        const sent = await sock.sendMessage(id, { text: message });
        
        // Insere no banco manualmente aqui para garantir consistência imediata no front
        // (Embora o evento messages.upsert também vá pegar, as vezes o 'ack' demora)
        const msgDB = await prepareMessageForDB(sent, id);
        if(msgDB) await supabase.from("messages").upsert(msgDB);

        res.json({ success: true, id: sent.key.id })
    } catch (error) { res.status(500).json({ success: false, error: error.message }) }
})

const PORT = process.env.PORT || 3000
app.listen(PORT, () => console.log(`[SERVER] 🌐 Worker ativo na porta ${PORT}`))