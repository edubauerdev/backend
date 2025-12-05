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
let isStarting = false

const connectionStatus = {
    connected: false,
    phone: null,
    status: "disconnected",
}

// Cache de contatos (apenas para referência, NÃO usamos para nome do chat)
let contactStore = {}

// GARANTE QUE A PASTA DE SESSÃO EXISTE
if (!fs.existsSync('./auth_info')) {
    fs.mkdirSync('./auth_info', { recursive: true });
}

// ============================================================
// 🔧 FUNÇÕES AUXILIARES PARA GERENCIAMENTO DE IDs @lid
// ============================================================
// O WhatsApp usa @lid como ID temporário interno.
// @lid NÃO contém o telefone real - é um número aleatório.
// Eventualmente o WhatsApp fornece o ID permanente @s.whatsapp.net
// com o telefone real. Precisamos rastrear e mesclar.
// ============================================================

/**
 * Extrai o telefone de um chatId do WhatsApp
 * APENAS funciona para IDs permanentes (@s.whatsapp.net ou @c.us)
 */
function extractPhoneFromChatId(chatId) {
    if (!chatId) return null
    if (isTemporaryId(chatId)) return null
    return chatId.split("@")[0]
}

/**
 * Verifica se é um ID temporário (@lid)
 */
function isTemporaryId(chatId) {
    return chatId && chatId.includes("@lid")
}

/**
 * Verifica se é um ID permanente (@s.whatsapp.net ou @c.us)
 */
function isPermanentId(chatId) {
    return chatId && (chatId.includes("@s.whatsapp.net") || chatId.includes("@c.us"))
}

/**
 * Extrai TODOS os metadados disponíveis de uma mensagem do Baileys
 * Isso inclui dados que podem ajudar a identificar o @lid posteriormente
 */
function extractMessageMetadata(msg) {
    const metadata = {
        // Dados básicos
        messageId: msg.key?.id,
        timestamp: msg.messageTimestamp,
        
        // Dados do remetente que podem conter telefone
        participant: msg.key?.participant,
        sender_pn: msg.attrs?.sender_pn || null,
        participant_pn: msg.attrs?.participant_pn || null,
        recipient_pn: msg.attrs?.recipient_pn || null,
        peer_recipient_pn: msg.attrs?.peer_recipient_pn || null,
        
        // Nome do contato
        pushName: msg.pushName || null,
        verifiedBizName: msg.verifiedBizName || null,
        
        // Outros metadados úteis
        broadcast: msg.broadcast || false,
        addressing_mode: msg.attrs?.addressing_mode || null,
    }
    
    // Remove campos null/undefined para economizar espaço
    return Object.fromEntries(
        Object.entries(metadata).filter(([_, v]) => v != null)
    )
}

/**
 * Extrai metadados de um chat do Baileys
 */
function extractChatMetadata(chat) {
    return {
        id: chat.id,
        conversationTimestamp: chat.conversationTimestamp,
        unreadCount: chat.unreadCount,
        archived: chat.archived,
        pinned: chat.pinned,
        mute: chat.mute,
        name: chat.name,
        notify: chat.notify,
        // Metadados extras que podem existir
        pnJid: chat.pnJid || null,
        lidJid: chat.lidJid || null,
        tcToken: chat.tcToken ? true : false, // Não salva o token, só se existe
    }
}

/**
 * Extrai metadados de um contato do Baileys
 */
function extractContactMetadata(contact) {
    return {
        id: contact.id,
        lid: contact.lid || null,
        name: contact.name || null,
        notify: contact.notify || null,
        verifiedName: contact.verifiedName || null,
        imgUrl: contact.imgUrl || null,
        status: contact.status || null,
        phoneNumber: contact.phoneNumber || null, // Quando disponível!
    }
}

/**
 * Busca chat existente pelo telefone
 */
async function findChatByPhone(telefone) {
    if (!telefone) return null
    
    try {
        const { data, error } = await supabase
            .from("chats")
            .select("id, uuid, name, phone, is_lid, push_name, lid_metadata")
            .or(`phone.eq.${telefone},id.like.${telefone}@%`)
            .limit(1)
            .single()
        
        if (error && error.code !== 'PGRST116') {
            console.error("[FIND_BY_PHONE] Erro:", error.message)
        }
        
        return data || null
    } catch (err) {
        console.error("[FIND_BY_PHONE] Erro:", err.message)
        return null
    }
}

/**
 * Busca chats @lid que podem corresponder a um ID permanente
 * Usa múltiplas estratégias de matching
 */
async function findMatchingLidChats(telefone, pushName = null, verifiedName = null) {
    const matches = []
    
    try {
        // Estratégia 1: Buscar @lid que já tem esse telefone nos metadados
        if (telefone) {
            const { data: byMetadata } = await supabase
                .from("chats")
                .select("id, uuid, name, push_name, lid_metadata")
                .eq("is_lid", true)
                .or(`lid_metadata->>sender_pn.eq.${telefone}@s.whatsapp.net,lid_metadata->>participant_pn.eq.${telefone}@s.whatsapp.net`)
            
            if (byMetadata?.length) {
                matches.push(...byMetadata.map(c => ({ ...c, matchType: 'metadata_phone' })))
            }
        }
        
        // Estratégia 2: Buscar por pushName (menos confiável, pode ter duplicatas)
        if (pushName && matches.length === 0) {
            const { data: byPushName } = await supabase
                .from("chats")
                .select("id, uuid, name, push_name, lid_metadata")
                .eq("is_lid", true)
                .eq("push_name", pushName)
                .order("last_message_time", { ascending: false })
                .limit(5)
            
            if (byPushName?.length) {
                matches.push(...byPushName.map(c => ({ ...c, matchType: 'push_name' })))
            }
        }
        
        // Estratégia 3: Buscar por verifiedName (business accounts)
        if (verifiedName && matches.length === 0) {
            const { data: byVerified } = await supabase
                .from("chats")
                .select("id, uuid, name, push_name, verified_name, lid_metadata")
                .eq("is_lid", true)
                .eq("verified_name", verifiedName)
            
            if (byVerified?.length) {
                matches.push(...byVerified.map(c => ({ ...c, matchType: 'verified_name' })))
            }
        }
        
        return matches
    } catch (err) {
        console.error("[FIND_LID_MATCHES] Erro:", err.message)
        return []
    }
}

/**
 * Mescla um chat @lid com o ID permanente
 * Move todas as mensagens e preserva os metadados
 */
async function mergeLidToPermanent(lidId, permanentId, telefone, newMetadata = {}) {
    console.log(`[MERGE] 🔄 Mesclando: ${lidId} -> ${permanentId} (tel: ${telefone})`)
    
    try {
        // 1. Busca o chat @lid
        const { data: lidChat } = await supabase
            .from("chats")
            .select("id, uuid, name, push_name, verified_name, lid_metadata")
            .eq("id", lidId)
            .single()
        
        if (!lidChat) {
            console.log(`[MERGE] ⚠️ Chat @lid não encontrado: ${lidId}`)
            return null
        }
        
        // 2. Verifica se já existe chat com esse telefone
        const existingByPhone = await findChatByPhone(telefone)
        
        if (existingByPhone && existingByPhone.uuid !== lidChat.uuid) {
            // Já existe chat permanente - mesclar mensagens
            console.log(`[MERGE] ⚠️ Mesclando com chat existente: ${existingByPhone.uuid}`)
            
            // Move mensagens do @lid para o chat permanente
            await supabase
                .from("messages")
                .update({ 
                    chat_id: existingByPhone.id,
                    chat_uuid: existingByPhone.uuid 
                })
                .eq("chat_id", lidId)
            
            // Atualiza o chat permanente com dados do @lid
            const mergedMetadata = {
                ...(existingByPhone.lid_metadata || {}),
                ...(lidChat.lid_metadata || {}),
                ...newMetadata,
                merged_from_lid: lidId,
                merged_at: new Date().toISOString()
            }
            
            await supabase
                .from("chats")
                .update({
                    original_lid_id: lidId,
                    lid_metadata: mergedMetadata,
                    // Preserva pushName/name se o permanente não tiver
                    push_name: existingByPhone.push_name || lidChat.push_name,
                    name: existingByPhone.name || lidChat.name
                })
                .eq("id", existingByPhone.id)
            
            // Deleta o chat @lid
            await supabase.from("chats").delete().eq("id", lidId)
            
            console.log(`[MERGE] ✅ Mesclado! UUID mantido: ${existingByPhone.uuid}`)
            return existingByPhone.uuid
        }
        
        // 3. Não existe chat permanente - atualizar o @lid
        const updatedMetadata = {
            ...(lidChat.lid_metadata || {}),
            ...newMetadata,
            converted_at: new Date().toISOString(),
            original_lid_id: lidId
        }
        
        await supabase
            .from("chats")
            .update({ 
                id: permanentId,
                phone: telefone,
                is_lid: false,
                original_lid_id: lidId,
                lid_metadata: updatedMetadata
            })
            .eq("id", lidId)
        
        // Atualiza as mensagens
        await supabase
            .from("messages")
            .update({ chat_id: permanentId })
            .eq("chat_id", lidId)
        
        console.log(`[MERGE] ✅ Convertido! UUID mantido: ${lidChat.uuid}`)
        return lidChat.uuid
        
    } catch (err) {
        console.error("[MERGE] Erro:", err.message)
        return null
    }
}

/**
 * Processa uma mensagem com ID permanente e tenta encontrar @lid correspondente
 */
async function tryMatchPermanentToLid(permanentId, msgMetadata = {}) {
    const telefone = extractPhoneFromChatId(permanentId)
    if (!telefone) return null
    
    const pushName = msgMetadata.pushName || null
    const verifiedName = msgMetadata.verifiedBizName || null
    
    // Busca chats @lid que podem corresponder
    const matches = await findMatchingLidChats(telefone, pushName, verifiedName)
    
    if (matches.length === 0) {
        return null // Nenhum @lid encontrado para mesclar
    }
    
    if (matches.length === 1) {
        // Match único - podemos mesclar com confiança
        const match = matches[0]
        console.log(`[MATCH] ✅ Match único encontrado: ${match.id} (tipo: ${match.matchType})`)
        return await mergeLidToPermanent(match.id, permanentId, telefone, msgMetadata)
    }
    
    // Múltiplos matches - prioriza por tipo
    const byPhone = matches.find(m => m.matchType === 'metadata_phone')
    if (byPhone) {
        console.log(`[MATCH] ✅ Match por telefone em metadados: ${byPhone.id}`)
        return await mergeLidToPermanent(byPhone.id, permanentId, telefone, msgMetadata)
    }
    
    const byVerified = matches.find(m => m.matchType === 'verified_name')
    if (byVerified) {
        console.log(`[MATCH] ✅ Match por verified_name: ${byVerified.id}`)
        return await mergeLidToPermanent(byVerified.id, permanentId, telefone, msgMetadata)
    }
    
    // Múltiplos matches por pushName - não podemos ter certeza
    console.log(`[MATCH] ⚠️ ${matches.length} matches por pushName, não mesclando automaticamente`)
    return null
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

function prepareMessageForDB(msg, chatId, chatUuid = null) {
    const type = getMessageType(msg)
    const hasMedia = ["image", "video", "audio", "document", "sticker"].includes(type)

    const messageData = {
        id: msg.key.id,
        chat_id: chatId,
        sender_id: msg.key.fromMe ? "me" : (msg.key.participant || chatId),
        content: getMessageText(msg),
        timestamp: Number(msg.messageTimestamp) * 1000,
        from_me: msg.key.fromMe || false,
        type: type,
        has_media: hasMedia,
    }
    
    // Adiciona chat_uuid se disponível
    if (chatUuid) {
        messageData.chat_uuid = chatUuid
    }
    
    return messageData
}

/**
 * ⚠️ IMPORTANTE: NÃO usamos mais esta função para definir o nome do chat
 * O nome é definido APENAS pelo usuário no frontend
 * Esta função é mantida apenas para referência interna (pushName)
 */
function getContactName(chatId, chatName, pushName) {
    // Retorna pushName apenas para uso interno (contatos)
    if (contactStore[chatId]) {
        return contactStore[chatId];
    }
    if (pushName && pushName.trim() !== "") {
        return pushName;
    }
    return null;
}

// ============================================================
// 💾 FUNÇÃO PARA SALVAR/ATUALIZAR CHAT NO BANCO
// ============================================================
async function upsertChat(chatData, metadata = {}) {
    const { id, unread_count, is_group, is_archived, last_message_time } = chatData
    
    // Extrai telefone apenas de IDs permanentes
    const telefone = extractPhoneFromChatId(id)
    const isLid = isTemporaryId(id)
    
    // Se é um ID permanente, tenta encontrar @lid correspondente para mesclar
    if (telefone && !isLid) {
        // Primeiro verifica se já existe por telefone
        const existingByPhone = await findChatByPhone(telefone)
        
        if (existingByPhone && existingByPhone.id !== id) {
            if (isTemporaryId(existingByPhone.id)) {
                // O chat existente é @lid - mesclar
                const mergedUuid = await mergeLidToPermanent(existingByPhone.id, id, telefone, metadata)
                if (mergedUuid) return mergedUuid
            }
        }
        
        // Se não achou por telefone, tenta outras estratégias de matching
        if (!existingByPhone) {
            const mergedUuid = await tryMatchPermanentToLid(id, metadata)
            if (mergedUuid) return mergedUuid
        }
    }
    
    // ⚠️ IMPORTANTE: NÃO enviamos 'name' no upsert
    // O nome é definido APENAS pelo usuário no frontend
    const chatRecord = {
        id,
        unread_count: unread_count || 0,
        is_group: is_group || false,
        is_archived: is_archived || false,
        last_message_time: last_message_time || Date.now(),
        is_lid: isLid, // Marca se é @lid
    }
    
    // Adiciona telefone se disponível (apenas para IDs permanentes)
    if (telefone) {
        chatRecord.phone = telefone
    }
    
    // Para @lid, salva metadados para matching futuro
    if (isLid && Object.keys(metadata).length > 0) {
        chatRecord.lid_metadata = metadata
        
        // Salva pushName e verifiedName separadamente para indexação
        if (metadata.pushName) {
            chatRecord.push_name = metadata.pushName
        }
        if (metadata.verifiedBizName) {
            chatRecord.verified_name = metadata.verifiedBizName
        }
        
        // Se temos telefone nos metadados (sender_pn), salva também
        const senderPhone = metadata.sender_pn || metadata.participant_pn
        if (senderPhone) {
            // Extrai só o número do formato 5511999999999@s.whatsapp.net
            const phoneFromMetadata = senderPhone.split("@")[0]
            if (phoneFromMetadata) {
                chatRecord.phone = phoneFromMetadata
            }
        }
    }
    
    const { data, error } = await supabase
        .from("chats")
        .upsert(chatRecord, { 
            onConflict: 'id',
            ignoreDuplicates: false
        })
        .select('uuid')
        .single()
    
    if (error) {
        console.error("[CHAT] Erro ao upsert:", error.message)
        return null
    }
    
    const chatUuid = data?.uuid || null
    
    console.log(`[CHAT] ${isLid ? '🔖 @lid' : '📱'} Chat salvo: ${id.substring(0, 20)}... UUID: ${chatUuid}`)
    
    return chatUuid
}

// ============================================================
// 🚀 WHATSAPP START - FUNÇÃO PRINCIPAL
// ============================================================
async function startWhatsApp() {
    if (isStarting) {
        console.log("[START] ⚠️ Já existe uma inicialização em andamento...");
        return;
    }
    
    isStarting = true
    hasSyncedHistory = false

    console.log("[WHATSAPP] 🚀 Iniciando conexão...");
    
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
            
            if (qr) {
                lastQrDataUrl = await qrcode.toDataURL(qr)
                await updateStatus("qr", lastQrDataUrl, null)
            }
            
            if (connection === "open") {
                if (qrTimeout) clearTimeout(qrTimeout);
                lastQrDataUrl = null
                isStarting = false
                
                const phoneId = sock.user?.id
                await updateStatus("syncing", null, phoneId, "Iniciando sincronização")
            }
            
            if (connection === "close") {
                const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode
                const reason = DisconnectReason[statusCode] || statusCode
                
                lastQrDataUrl = null
                hasSyncedHistory = false
                isStarting = false
                
                await updateStatus("disconnected", null, null, `Razão: ${reason}`)

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

            // Armazena contatos apenas para referência interna
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

            // ============================================================
            // FASE 1: SALVAR TODOS OS CHATS EM LOTES
            // Primeiro populamos TODOS os chats antes de salvar mensagens
            // ============================================================
            const privateChats = chats.filter(c => !c.id.includes("@g.us"));
            const CHAT_BATCH_SIZE = 50; // Lotes de 50 chats
            
            // Conta quantos são @lid
            const lidCount = privateChats.filter(c => isTemporaryId(c.id)).length
            console.log(`[SYNC] 💬 FASE 1: Salvando ${privateChats.length} chats em lotes de ${CHAT_BATCH_SIZE} (${lidCount} são @lid)...`);

            // Map para armazenar chat_id -> uuid
            const chatUuidMap = new Map()
            
            // Prepara todos os registros de chat primeiro
            const allChatRecords = []
            
            for (const c of privateChats) {
                let timestamp = c.conversationTimestamp ? Number(c.conversationTimestamp) : 0;
                if (timestamp > 0 && timestamp < 946684800000) timestamp = timestamp * 1000;
                if (timestamp === 0) timestamp = 1000;

                // Extrai metadados do chat para matching futuro
                const chatMetadata = extractChatMetadata(c)
                
                // Adiciona pushName do contactStore se disponível
                if (contactStore[c.id]) {
                    chatMetadata.pushName = contactStore[c.id]
                }
                
                const isLid = isTemporaryId(c.id)
                const telefone = extractPhoneFromChatId(c.id)
                
                // Monta o registro do chat
                const chatRecord = {
                    id: c.id,
                    unread_count: c.unreadCount || 0,
                    is_group: false,
                    is_archived: c.archived || false,
                    last_message_time: timestamp,
                    is_lid: isLid,
                }
                
                // Adiciona telefone se disponível
                if (telefone) {
                    chatRecord.phone = telefone
                }
                
                // Para @lid, salva metadados
                if (isLid && Object.keys(chatMetadata).length > 0) {
                    chatRecord.lid_metadata = chatMetadata
                    
                    if (chatMetadata.pushName) {
                        chatRecord.push_name = chatMetadata.pushName
                    }
                    if (chatMetadata.notify) {
                        chatRecord.push_name = chatRecord.push_name || chatMetadata.notify
                    }
                }
                
                allChatRecords.push(chatRecord)
            }
            
            console.log(`[SYNC] 📦 ${allChatRecords.length} registros de chat preparados. Iniciando inserção em lotes...`);
            
            // Salva chats em lotes de 50
            for (let i = 0; i < allChatRecords.length; i += CHAT_BATCH_SIZE) {
                const batch = allChatRecords.slice(i, i + CHAT_BATCH_SIZE)
                
                const { data: insertedChats, error } = await supabase
                    .from("chats")
                    .upsert(batch, { 
                        onConflict: 'id',
                        ignoreDuplicates: false
                    })
                    .select('id, uuid')
                
                if (error) {
                    console.error(`[SYNC] ❌ Erro ao salvar lote de chats ${i}-${i + batch.length}:`, error.message)
                } else if (insertedChats) {
                    // Mapeia id -> uuid para usar nas mensagens
                    insertedChats.forEach(chat => {
                        if (chat.uuid) {
                            chatUuidMap.set(chat.id, chat.uuid)
                        }
                    })
                    
                    const percent = Math.round(((i + batch.length) / allChatRecords.length) * 100)
                    console.log(`[SYNC] 💬 Chats: ${percent}% (${i + batch.length}/${allChatRecords.length})`)
                }
                
                // Pausa entre lotes para não sobrecarregar
                await new Promise(r => setTimeout(r, 100));
            }
            
            console.log(`[SYNC] ✅ FASE 1 COMPLETA: ${chatUuidMap.size} chats salvos com UUID mapeado`);

            // ============================================================
            // FASE 2: SALVAR TODAS AS MENSAGENS EM LOTES
            // Só começa depois que TODOS os chats foram salvos
            // ============================================================
            const privateMessages = messages.filter(m => {
                if (!m.key.remoteJid || m.key.remoteJid.includes("@g.us")) return false
                const msgTimestamp = Number(m.messageTimestamp) * 1000
                return msgTimestamp >= cutoffTimestamp
            });
            
            const MSG_BATCH_SIZE = 50;
            const totalFiltered = messages.length - privateMessages.length
            console.log(`[SYNC] 📝 FASE 2: Salvando ${privateMessages.length} mensagens em lotes de ${MSG_BATCH_SIZE} (${totalFiltered} filtradas)...`);

            for (let i = 0; i < privateMessages.length; i += MSG_BATCH_SIZE) {
                let batch = privateMessages.slice(i, i + MSG_BATCH_SIZE).map(m => {
                    const chatId = m.key.remoteJid
                    const chatUuid = chatUuidMap.get(chatId) || null
                    return prepareMessageForDB(m, chatId, chatUuid)
                });
                
                const { error } = await supabase.from("messages").upsert(batch, { onConflict: 'id' });
                if (error) console.error(`[SYNC] ❌ Erro Msgs lote ${i}-${i + batch.length}:`, error.message);
                
                // Log de progresso a cada 10 lotes (500 mensagens)
                if ((i / MSG_BATCH_SIZE) % 10 === 0 && i > 0) {
                    const percent = Math.round((i / privateMessages.length) * 100)
                    console.log(`[SYNC] 📝 Mensagens: ${percent}% (${i}/${privateMessages.length})`);
                }

                batch = null;
                if (global.gc && i % 1000 === 0) global.gc();
                await new Promise(r => setTimeout(r, 150));
            }
            
            await updateStatus("connected", null, sock?.user?.id, "Sincronização completa")
            console.log("[SYNC] ✅ Sincronização finalizada com sucesso!")
            
            if (global.gc) global.gc()
        })

        // ============================================================
        // 💬 EVENTO: MENSAGENS EM TEMPO REAL
        // Extrai TODOS os metadados do Baileys para matching de @lid
        // ============================================================
        sock.ev.on("messages.upsert", async ({ messages, type }) => {
            if (type !== "notify" && type !== "append") return
            
            for (const msg of messages) {
                const chatId = msg.key.remoteJid
                if (!chatId || chatId.includes("@g.us") || chatId === "status@broadcast") continue

                // Extrai todos os metadados disponíveis
                const msgMetadata = extractMessageMetadata(msg)
                
                // Log para debug de @lid
                if (isTemporaryId(chatId)) {
                    console.log(`[MSG] 🔖 Mensagem @lid recebida:`, {
                        chatId: chatId.substring(0, 30) + "...",
                        pushName: msgMetadata.pushName,
                        sender_pn: msgMetadata.sender_pn,
                        participant_pn: msgMetadata.participant_pn
                    })
                }

                // Verifica se o chat existe
                const { data: chatData } = await supabase
                    .from("chats")
                    .select("uuid, unread_count, is_lid")
                    .eq("id", chatId)
                    .single()
                
                let chatUuid = chatData?.uuid || null
                
                // Se o chat não existe, cria um novo com metadados
                if (!chatData) {
                    chatUuid = await upsertChat({
                        id: chatId,
                        unread_count: msg.key.fromMe ? 0 : 1,
                        is_group: false,
                        is_archived: false,
                        last_message_time: Number(msg.messageTimestamp) * 1000,
                    }, msgMetadata) // Passa metadados para matching futuro
                } else {
                    // Atualiza último timestamp
                    const updateData = {
                        last_message_time: Number(msg.messageTimestamp) * 1000,
                        unread_count: msg.key.fromMe ? 0 : (chatData.unread_count || 0) + 1
                    }
                    
                    // Se é @lid e temos novos metadados, atualiza também
                    if (chatData.is_lid && msgMetadata.pushName) {
                        updateData.push_name = msgMetadata.pushName
                    }
                    
                    await supabase
                        .from("chats")
                        .update(updateData)
                        .eq("id", chatId)
                }

                // Prepara mensagem com metadados do sender
                const msgDB = prepareMessageForDB(msg, chatId, chatUuid)
                
                // Adiciona metadados do sender se for @lid
                if (isTemporaryId(chatId) && Object.keys(msgMetadata).length > 0) {
                    msgDB.sender_metadata = msgMetadata
                }
                
                const { error } = await supabase.from("messages").upsert(msgDB, { onConflict: 'id' })
                if (error) console.error("[MSG] Erro:", error.message)
            }
        })

        // ============================================================
        // 📱 EVENTO: CONTATOS ATUALIZADOS
        // O WhatsApp pode enviar o telefone real aqui!
        // ============================================================
        sock.ev.on("contacts.update", async (updates) => {
            for (const contact of updates) {
                const contactId = contact.id
                if (!contactId || contactId.includes("@g.us")) continue
                
                // Extrai metadados do contato
                const contactMetadata = extractContactMetadata(contact)
                
                // Salva no cache local
                if (contact.notify) {
                    contactStore[contactId] = contact.notify
                }
                
                // Se é um ID permanente E temos telefone, tenta encontrar @lid correspondente
                if (isPermanentId(contactId)) {
                    const telefone = extractPhoneFromChatId(contactId)
                    const pushName = contact.notify || contact.name
                    const verifiedName = contact.verifiedName
                    
                    // Tenta encontrar e mesclar com @lid
                    const matches = await findMatchingLidChats(telefone, pushName, verifiedName)
                    
                    if (matches.length === 1) {
                        console.log(`[CONTACT] 🔄 Encontrado @lid para mesclar: ${matches[0].id}`)
                        await mergeLidToPermanent(matches[0].id, contactId, telefone, contactMetadata)
                    } else if (matches.length > 1) {
                        console.log(`[CONTACT] ⚠️ Múltiplos @lid encontrados para ${contactId}, verificação manual necessária`)
                    }
                }
                
                // Se é @lid e temos phoneNumber no contato, salva nos metadados
                if (isTemporaryId(contactId) && contactMetadata.phoneNumber) {
                    console.log(`[CONTACT] 📞 @lid com telefone descoberto:`, contactId, contactMetadata.phoneNumber)
                    
                    await supabase
                        .from("chats")
                        .update({
                            phone: contactMetadata.phoneNumber.split("@")[0],
                            lid_metadata: supabase.raw(`COALESCE(lid_metadata, '{}'::jsonb) || '${JSON.stringify(contactMetadata)}'::jsonb`)
                        })
                        .eq("id", contactId)
                }
            }
        })

        // ============================================================
        // 🔄 EVENTO: CHATS ATUALIZADOS
        // Pode incluir conversões de @lid para ID permanente
        // ============================================================
        sock.ev.on("chats.update", async (updates) => {
            for (const update of updates) {
                const chatId = update.id
                if (!chatId || chatId.includes("@g.us")) continue
                
                // Extrai metadados do chat update
                const chatMetadata = extractChatMetadata(update)
                
                // Se é um ID permanente, tenta encontrar @lid correspondente
                if (isPermanentId(chatId)) {
                    const telefone = extractPhoneFromChatId(chatId)
                    
                    // Verifica se já existe chat com esse ID
                    const { data: existingChat } = await supabase
                        .from("chats")
                        .select("uuid")
                        .eq("id", chatId)
                        .single()
                    
                    if (!existingChat) {
                        // Chat não existe com ID permanente - procura @lid para mesclar
                        const matches = await findMatchingLidChats(telefone, update.name || update.notify)
                        
                        if (matches.length === 1) {
                            console.log(`[CHAT_UPDATE] 🔄 Mesclando @lid ${matches[0].id} -> ${chatId}`)
                            await mergeLidToPermanent(matches[0].id, chatId, telefone, chatMetadata)
                        }
                    }
                }
            }
        })

    } catch (error) {
        console.error("[START] ❌ Erro ao iniciar:", error.message)
        await updateStatus("disconnected", null, null, `Erro: ${error.message}`)
        isStarting = false
    }
}

// ============================================================
// 🔌 INICIALIZAÇÃO
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
        if (connectionStatus.status === "connected" || connectionStatus.status === "syncing") {
            return res.json({ 
                success: true, 
                message: "Já conectado",
                status: connectionStatus.status 
            });
        }
        
        if (connectionStatus.status === "qr") {
            return res.json({ 
                success: true, 
                message: "QR Code já disponível",
                status: "qr"
            });
        }
        
        if (isStarting) {
            return res.json({ 
                success: true, 
                message: "Conexão em andamento",
                status: "connecting"
            });
        }
        
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

// Nova rota: buscar chat por UUID
app.get("/chats/uuid/:uuid", async (req, res) => {
    try {
        const { uuid } = req.params;
        const { data, error } = await supabase
            .from("chats")
            .select("*")
            .eq("uuid", uuid)
            .single();
        if (error) throw error;
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Nova rota: buscar chat por telefone
app.get("/chats/phone/:phone", async (req, res) => {
    try {
        const { phone } = req.params;
        const chat = await findExistingChatByPhone(phone);
        if (!chat) {
            return res.status(404).json({ error: "Chat não encontrado" });
        }
        res.json(chat);
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

// Nova rota: buscar mensagens por chat_uuid
app.get("/chats/uuid/:uuid/messages", async (req, res) => {
    try {
        const { uuid } = req.params;
        const { limit = 50, before } = req.query;
        
        let query = supabase
            .from("messages")
            .select("*")
            .eq("chat_uuid", uuid)
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

// Nova rota: atualizar nome do chat (apenas pelo usuário)
app.patch("/chats/:chatId/name", async (req, res) => {
    try {
        const { chatId } = req.params;
        const { name } = req.body;
        
        if (!name || !name.trim()) {
            return res.status(400).json({ error: "Nome é obrigatório" });
        }
        
        const { data, error } = await supabase
            .from("chats")
            .update({ name: name.trim() })
            .eq("id", chatId)
            .select()
            .single();
        
        if (error) throw error;
        res.json({ success: true, chat: data });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

//

const PORT = process.env.PORT || 3000
app.listen(PORT, () => console.log(`[SERVER] 🌐 Porta ${PORT}`))
