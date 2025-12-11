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

// ============================================================
// 🧹 SMART CLEAN - SISTEMA DE LIMPEZA INTELIGENTE
// ============================================================
// 
// Este backend implementa um sistema de SMART CLEAN que é executado
// automaticamente quando o WhatsApp é desconectado.
//
// 🎯 OBJETIVO:
// - Limpar dados temporários da sessão WhatsApp
// - Preservar dados importantes definidos pelo usuário
// - Permitir reconexão sem duplicidade de dados
//
// 🚀 VERSÃO OTIMIZADA PARA SERVIDOR LOW-END (500MB RAM)
// ============================================================

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
// 🔧 FUNÇÕES AUXILIARES
// ============================================================

function extractPhoneFromChatId(chatId) {
    if (!chatId) return null
    if (isTemporaryId(chatId)) return null
    return chatId.split("@")[0]
}

function isTemporaryId(chatId) {
    return chatId && chatId.includes("@lid")
}

function isPermanentId(chatId) {
    return chatId && (chatId.includes("@s.whatsapp.net") || chatId.includes("@c.us"))
}

function extractMessageMetadata(msg) {
    const metadata = {
        messageId: msg.key?.id,
        timestamp: msg.messageTimestamp,
        participant: msg.key?.participant,
        sender_pn: msg.attrs?.sender_pn || null,
        participant_pn: msg.attrs?.participant_pn || null,
        recipient_pn: msg.attrs?.recipient_pn || null,
        peer_recipient_pn: msg.attrs?.peer_recipient_pn || null,
        pushName: msg.pushName || null,
        verifiedBizName: msg.verifiedBizName || null,
        broadcast: msg.broadcast || false,
        addressing_mode: msg.attrs?.addressing_mode || null,
    }
    return Object.fromEntries(Object.entries(metadata).filter(([_, v]) => v != null))
}

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
        pnJid: chat.pnJid || null,
        lidJid: chat.lidJid || null,
        tcToken: chat.tcToken ? true : false,
    }
}

function extractContactMetadata(contact) {
    return {
        id: contact.id,
        lid: contact.lid || null,
        name: contact.name || null,
        notify: contact.notify || null,
        verifiedName: contact.verifiedName || null,
        imgUrl: contact.imgUrl || null,
        status: contact.status || null,
        phoneNumber: contact.phoneNumber || null,
    }
}

async function findChatByPhone(telefone) {
    if (!telefone) return null
    try {
        const { data, error } = await supabase
            .from("chats")
            .select("id, uuid, name, phone, is_lid, push_name, lid_metadata")
            .or(`phone.eq.${telefone},id.like.${telefone}@%`)
            .limit(1)
            .single()
        
        if (error && error.code !== 'PGRST116') console.error("[FIND_BY_PHONE] Erro:", error.message)
        return data || null
    } catch (err) {
        console.error("[FIND_BY_PHONE] Erro:", err.message)
        return null
    }
}

async function findMatchingLidChats(telefone, pushName = null, verifiedName = null) {
    const matches = []
    try {
        if (telefone) {
            const { data: byMetadata } = await supabase
                .from("chats")
                .select("id, uuid, name, push_name, lid_metadata")
                .eq("is_lid", true)
                .or(`lid_metadata->>sender_pn.eq.${telefone}@s.whatsapp.net,lid_metadata->>participant_pn.eq.${telefone}@s.whatsapp.net`)
            if (byMetadata?.length) matches.push(...byMetadata.map(c => ({ ...c, matchType: 'metadata_phone' })))
        }
        if (pushName && matches.length === 0) {
            const { data: byPushName } = await supabase
                .from("chats")
                .select("id, uuid, name, push_name, lid_metadata")
                .eq("is_lid", true)
                .eq("push_name", pushName)
                .order("last_message_time", { ascending: false })
                .limit(5)
            if (byPushName?.length) matches.push(...byPushName.map(c => ({ ...c, matchType: 'push_name' })))
        }
        if (verifiedName && matches.length === 0) {
            const { data: byVerified } = await supabase
                .from("chats")
                .select("id, uuid, name, push_name, verified_name, lid_metadata")
                .eq("is_lid", true)
                .eq("verified_name", verifiedName)
            if (byVerified?.length) matches.push(...byVerified.map(c => ({ ...c, matchType: 'verified_name' })))
        }
        return matches
    } catch (err) {
        console.error("[FIND_LID_MATCHES] Erro:", err.message)
        return []
    }
}

async function mergeLidToPermanent(lidId, permanentId, telefone, newMetadata = {}) {
    console.log(`[MERGE] 🔄 Mesclando: ${lidId} -> ${permanentId} (tel: ${telefone})`)
    try {
        const { data: lidChat } = await supabase.from("chats").select("*").eq("id", lidId).single()
        if (!lidChat) return null
        
        const existingByPhone = await findChatByPhone(telefone)
        
        if (existingByPhone && existingByPhone.uuid !== lidChat.uuid) {
            console.log(`[MERGE] ⚠️ Mesclando com chat existente: ${existingByPhone.uuid}`)
            await supabase.from("messages").update({ chat_id: existingByPhone.id, chat_uuid: existingByPhone.uuid }).eq("chat_id", lidId)
            
            const mergedMetadata = {
                ...(existingByPhone.lid_metadata || {}),
                ...(lidChat.lid_metadata || {}),
                ...newMetadata,
                merged_from_lid: lidId,
                merged_at: new Date().toISOString()
            }
            
            await supabase.from("chats").update({
                original_lid_id: lidId,
                lid_metadata: mergedMetadata,
                push_name: existingByPhone.push_name || lidChat.push_name,
                name: existingByPhone.name || lidChat.name
            }).eq("id", existingByPhone.id)
            
            await supabase.from("chats").delete().eq("id", lidId)
            return existingByPhone.uuid
        }
        
        const updatedMetadata = {
            ...(lidChat.lid_metadata || {}),
            ...newMetadata,
            converted_at: new Date().toISOString(),
            original_lid_id: lidId
        }
        
        await supabase.from("chats").update({ 
            id: permanentId,
            phone: telefone,
            is_lid: false,
            original_lid_id: lidId,
            lid_metadata: updatedMetadata
        }).eq("id", lidId)
        
        await supabase.from("messages").update({ chat_id: permanentId }).eq("chat_id", lidId)
        return lidChat.uuid
        
    } catch (err) {
        console.error("[MERGE] Erro:", err.message)
        return null
    }
}

async function tryMatchPermanentToLid(permanentId, msgMetadata = {}) {
    const telefone = extractPhoneFromChatId(permanentId)
    if (!telefone) return null
    const matches = await findMatchingLidChats(telefone, msgMetadata.pushName, msgMetadata.verifiedBizName)
    if (matches.length === 0) return null
    if (matches.length === 1) return await mergeLidToPermanent(matches[0].id, permanentId, telefone, msgMetadata)
    const byPhone = matches.find(m => m.matchType === 'metadata_phone')
    if (byPhone) return await mergeLidToPermanent(byPhone.id, permanentId, telefone, msgMetadata)
    const byVerified = matches.find(m => m.matchType === 'verified_name')
    if (byVerified) return await mergeLidToPermanent(byVerified.id, permanentId, telefone, msgMetadata)
    return null
}

// ============================================================
// 🧹 SMART CLEAN - LIMPEZA INTELIGENTE
// ============================================================
async function smartCleanWhatsAppData() {
    try {
        console.log("[SMART CLEAN] 🧹 Iniciando limpeza inteligente do banco...")
        console.log(`[MEMORY] 💾 Uso antes do clean: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`)
        
        const stats = { messages_deleted: 0, chats_cleaned: 0, chats_preserved: 0 }
        
        // FASE 1: Deletar mensagens
        console.log("[SMART CLEAN] 📝 FASE 1: Deletando mensagens...")
        const { error: msgError, count: msgCount } = await supabase.from("messages").delete().neq('id', '')
        
        if (msgError) console.error("[SMART CLEAN] ❌ Erro ao deletar mensagens:", msgError.message)
        else {
            stats.messages_deleted = msgCount || 0
            console.log(`[SMART CLEAN] ✅ ${stats.messages_deleted} mensagens deletadas`)
            console.log("[DB] 💾 Mensagens deletadas do banco")
        }
        
        // FASE 2: Limpar chats
        console.log("[SMART CLEAN] 💬 FASE 2: Limpando dados temporários dos chats...")
        const { error: chatError, count: chatCount } = await supabase
            .from("chats")
            .update({
                id: null, phone: null, push_name: null, verified_name: null,
                is_lid: false, is_group: false, is_archived: false, unread_count: 0,
                last_message_time: null, lid_metadata: null, original_lid_id: null,
            }).neq('uuid', '')
        
        if (chatError) console.error("[SMART CLEAN] ❌ Erro ao limpar chats:", chatError.message)
        else {
            stats.chats_cleaned = chatCount || 0
            console.log(`[SMART CLEAN] ✅ ${stats.chats_cleaned} chats limpos`)
            console.log("[DB] 💾 Chats limpos no banco")
        }
        
        // FASE 3: Contagem
        const { count: preservedCount } = await supabase.from("chats").select('*', { count: 'exact', head: true })
            .or('name.not.is.null,etiqueta_ids.not.is.null,image_url.not.is.null')
        stats.chats_preserved = preservedCount || 0
        
        // FASE 4: Resetar configs
        console.log("[SMART CLEAN] ⚙️ FASE 4: Resetando configurações...")
        await supabase.from("instance_settings").update({ status: 'disconnected', qr_code: null, phone: null }).eq('id', 1)
        console.log("[DB] 💾 instance_settings resetado no banco")
        
        console.log("\n[SMART CLEAN] ✅ LIMPEZA COMPLETA!")
        console.log(`[MEMORY] 💾 Uso após clean: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`)
        
        return { success: true, ...stats }
    } catch (error) {
        console.error("[SMART CLEAN] ❌ Erro geral:", error.message)
        return { success: false, error: error.message }
    }
}

// ============================================================
// 📡 FUNÇÃO DE ATUALIZAÇÃO DE STATUS (OTIMIZADA)
// ============================================================
async function updateStatus(newStatus, qrCode = null, phone = null, extraInfo = null) {
    connectionStatus.status = newStatus
    connectionStatus.connected = (newStatus === "connected" || newStatus === "syncing")
    connectionStatus.phone = phone
    
    const statusEmojis = { disconnected: "🔴", qr: "📱", syncing: "🔄", connected: "🟢" }
    const statusMessages = { disconnected: "Desconectado", qr: "QR Code aguardando escaneamento", syncing: "Conectado - Sincronizando mensagens", connected: "Conectado e pronto" }
    
    console.log(`[STATUS] ${statusEmojis[newStatus]} ${statusMessages[newStatus]}${extraInfo ? ` (${extraInfo})` : ''}`)
    
    try {
        const updateData = { id: 1, status: newStatus, updated_at: new Date().toISOString() }
        
        if (newStatus === "qr" && qrCode) {
            updateData.qr_code = qrCode
            console.log("[DB] 💾 instance_settings: Salvando QR Code no banco")
        } else if (newStatus !== "qr") {
            updateData.qr_code = null
            console.log("[DB] 💾 instance_settings: Limpando QR Code do banco")
        }
        
        if (phone) {
            updateData.phone = phone
            console.log(`[DB] 💾 instance_settings: Atualizando telefone → ${phone}`)
        }
        
        console.log(`[DB] 💾 instance_settings: Status alterado → ${newStatus}`)
        
        const { error } = await supabase.from("instance_settings").upsert(updateData)
        if (error) console.error("[DB] ❌ instance_settings: Erro ao atualizar:", error.message)
        else console.log("[DB] ✅ instance_settings: Atualização salva com sucesso")
        
    } catch (err) {
        console.error("[DB] ❌ instance_settings: Erro fatal:", err.message)
    }
}

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
    if (chatUuid) messageData.chat_uuid = chatUuid
    return messageData
}

function getContactName(chatId, chatName, pushName) {
    if (contactStore[chatId]) return contactStore[chatId];
    if (pushName && pushName.trim() !== "") return pushName;
    return null;
}

async function upsertChat(chatData, metadata = {}) {
    const { id, unread_count, is_group, is_archived, last_message_time } = chatData
    const telefone = extractPhoneFromChatId(id)
    const isLid = isTemporaryId(id)
    
    if (telefone && !isLid) {
        const existingByPhone = await findChatByPhone(telefone)
        if (existingByPhone && existingByPhone.id !== id) {
            if (isTemporaryId(existingByPhone.id)) {
                const mergedUuid = await mergeLidToPermanent(existingByPhone.id, id, telefone, metadata)
                if (mergedUuid) return mergedUuid
            }
        }
        if (!existingByPhone) {
            const mergedUuid = await tryMatchPermanentToLid(id, metadata)
            if (mergedUuid) return mergedUuid
        }
    }
    
    const chatRecord = {
        id, unread_count: unread_count || 0, is_group: is_group || false,
        is_archived: is_archived || false, last_message_time: last_message_time || Date.now(), is_lid: isLid,
    }
    if (telefone) chatRecord.phone = telefone
    if (isLid && Object.keys(metadata).length > 0) {
        chatRecord.lid_metadata = metadata
        if (metadata.pushName) chatRecord.push_name = metadata.pushName
        if (metadata.verifiedBizName) chatRecord.verified_name = metadata.verifiedBizName
        const senderPhone = metadata.sender_pn || metadata.participant_pn
        if (senderPhone) {
            const phoneFromMetadata = senderPhone.split("@")[0]
            if (phoneFromMetadata) chatRecord.phone = phoneFromMetadata
        }
    }
    
    const { data, error } = await supabase.from("chats").upsert(chatRecord, { onConflict: 'id', ignoreDuplicates: false }).select('uuid').single()
    if (error) { console.error("[CHAT] Erro ao upsert:", error.message); return null }
    const chatUuid = data?.uuid || null
    console.log(`[CHAT] ${isLid ? '🔖 @lid' : '📱'} Chat salvo: ${id.substring(0, 20)}... UUID: ${chatUuid}`)
    return chatUuid
}

// ============================================================
// 🚀 WHATSAPP START (COM OTIMIZAÇÃO DE SYNC)
// ============================================================
async function startWhatsApp() {
    if (isStarting) { console.log("[START] ⚠️ Já existe uma inicialização em andamento..."); return; }
    isStarting = true
    hasSyncedHistory = false
    console.log("[WHATSAPP] 🚀 Iniciando conexão...");
    
    if (sock) {
        try { sock.ev.removeAllListeners(); sock.end(); } catch (e) {}
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
            emitOwnEvents: true,
            markOnlineOnConnect: true,
            getMessage: async () => undefined,
        });

        sock.ev.on("creds.update", saveCreds);

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
                if (statusCode === DisconnectReason.loggedOut || !hasSession) {
                    console.log("[WHATSAPP] 🧹 Desconexão permanente. Smart Clean...")
                    await smartCleanWhatsAppData()
                    sock = null
                } else {
                    console.log("[WHATSAPP] 🔄 Reconectando em 5s...");
                    setTimeout(() => startWhatsApp(), 5000)
                }
            }
        })

        // ============================================================
        // 📚 EVENTO: SYNC DE HISTÓRICO (CORRIGIDO PARA CHUNKS)
        // ============================================================
        sock.ev.on("messaging-history.set", async ({ chats, contacts, messages, isLatest }) => {
            // CORREÇÃO: Removemos o return antecipado. Processamos cada chunk (pacote) de dados.
            // O WhatsApp envia em várias partes. Se retornarmos na primeira, perdemos o resto.
            
            console.log(`[SYNC] 📚 Chunk recebido: ${chats.length} chats, ${messages.length} msgs. isLatest: ${isLatest}`)
            console.log(`[MEMORY] 💾 Uso atual: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`)
            
            if (qrTimeout) clearTimeout(qrTimeout);
            if (contacts) contacts.forEach(c => { if (c.name) contactStore[c.id] = c.name })
            messages.forEach(m => {
                if (m.pushName) {
                    const senderId = m.key.participant || m.key.remoteJid
                    if (!contactStore[senderId]) contactStore[senderId] = m.pushName
                }
            })

            // ⏰ FILTRO DE 6 MESES
            const SIX_MONTHS_MS = 6 * 30 * 24 * 60 * 60 * 1000
            const cutoffTimestamp = Date.now() - SIX_MONTHS_MS
            
            const privateChats = chats.filter(c => !c.id.includes("@g.us"));
            const privateMessages = messages.filter(m => {
                if (!m.key.remoteJid || m.key.remoteJid.includes("@g.us")) return false
                const msgTimestamp = Number(m.messageTimestamp) * 1000
                return msgTimestamp >= cutoffTimestamp
            });

            const chatUuidMap = new Map()
            
            // 🔧 CORREÇÃO: Deduplicar chats usando Map (último valor prevalece)
            const chatRecordsMap = new Map()

            for (const c of privateChats) {
                let timestamp = c.conversationTimestamp ? Number(c.conversationTimestamp) : 0;
                if (timestamp > 0 && timestamp < 946684800000) timestamp = timestamp * 1000;
                if (timestamp === 0) timestamp = Date.now();

                const chatMetadata = extractChatMetadata(c)
                if (contactStore[c.id]) chatMetadata.pushName = contactStore[c.id]
                const isLid = isTemporaryId(c.id)
                const telefone = extractPhoneFromChatId(c.id)
                
                const chatRecord = {
                    id: c.id, unread_count: c.unreadCount || 0, is_group: false,
                    is_archived: c.archived || false, last_message_time: timestamp, is_lid: isLid,
                }
                if (telefone) chatRecord.phone = telefone
                if (isLid && Object.keys(chatMetadata).length > 0) {
                    chatRecord.lid_metadata = chatMetadata
                    if (chatMetadata.pushName) chatRecord.push_name = chatMetadata.pushName
                    if (chatMetadata.notify) chatRecord.push_name = chatRecord.push_name || chatMetadata.notify
                }
                
                // 🔧 Se já existe, mesclar dados (preservar o mais recente)
                if (chatRecordsMap.has(c.id)) {
                    const existing = chatRecordsMap.get(c.id)
                    // Manter o timestamp mais recente
                    if (timestamp > (existing.last_message_time || 0)) {
                        chatRecordsMap.set(c.id, { ...existing, ...chatRecord })
                    } else {
                        chatRecordsMap.set(c.id, { ...chatRecord, ...existing })
                    }
                } else {
                    chatRecordsMap.set(c.id, chatRecord)
                }
            }
            
            // Converter Map para Array (sem duplicatas)
            const allChatRecords = Array.from(chatRecordsMap.values())

            if (allChatRecords.length > 0) {
                console.log(`[SYNC] 📦 Processando ${allChatRecords.length} chats únicos deste chunk...`)
                const CHAT_BATCH_SIZE = 50
                
                for (let i = 0; i < allChatRecords.length; i += CHAT_BATCH_SIZE) {
                    const batch = allChatRecords.slice(i, i + CHAT_BATCH_SIZE)
                    const { data: insertedChats, error } = await supabase.from("chats").upsert(batch, { onConflict: 'id', ignoreDuplicates: false }).select('id, uuid')
                    if (error) console.error(`[DB] ❌ Erro ao salvar chats ${i}:`, error.message)
                    else if (insertedChats) insertedChats.forEach(chat => { if (chat.uuid) chatUuidMap.set(chat.id, chat.uuid) })
                    
                    await new Promise(r => setTimeout(r, 50)); // Pequeno delay para respirar
                }
            }

            // FASE 2: MENSAGENS - Também deduplicar
            if (privateMessages.length > 0) {
                const MSG_BATCH_SIZE = 50
                console.log(`[DB] 💾 Processando ${privateMessages.length} mensagens deste chunk...`)
                
                // 🔧 Deduplicar mensagens por ID
                const messagesMap = new Map()
                for (const m of privateMessages) {
                    const chatId = m.key.remoteJid
                    const msgData = prepareMessageForDB(m, chatId, chatUuidMap.get(chatId) || null)
                    messagesMap.set(m.key.id, msgData) // ID único da mensagem
                }
                const uniqueMessages = Array.from(messagesMap.values())
                
                for (let i = 0; i < uniqueMessages.length; i += MSG_BATCH_SIZE) {
                    let batch = uniqueMessages.slice(i, i + MSG_BATCH_SIZE)
                    
                    const { error } = await supabase.from("messages").upsert(batch, { onConflict: 'id' })
                    if (error) console.error(`[DB] ❌ Erro em mensagens ${i}:`, error.message)
                    
                    batch = null;
                    if (global.gc && i % 200 === 0) { global.gc(); }
                    await new Promise(r => setTimeout(r, 100));
                }
            }

            // AQUI ESTÁ A CORREÇÃO PRINCIPAL:
            // Só marcamos como sincronizado (connected) se for o último chunk (isLatest).
            if (isLatest) {
                console.log(`[SYNC] ✅ TODOS OS PACOTES RECEBIDOS. SYNC COMPLETO.`)
                hasSyncedHistory = true
                // 🔧 Limpar contactStore após sync para liberar memória
                contactStore = {}
                await updateStatus("connected", null, sock?.user?.id, "Sincronização completa")
            } else {
                console.log(`[SYNC] ⏳ Aguardando mais pacotes...`)
            }
            
            if (global.gc) global.gc()
        })

        sock.ev.on("messages.upsert", async ({ messages, type }) => {
            if (type !== "notify" && type !== "append") return
            for (const msg of messages) {
                const chatId = msg.key.remoteJid
                if (!chatId || chatId.includes("@g.us") || chatId === "status@broadcast") continue
                const msgMetadata = extractMessageMetadata(msg)
                
                if (isTemporaryId(chatId)) console.log(`[MSG] 🔖 Mensagem @lid recebida:`, chatId)

                const { data: chatData } = await supabase.from("chats").select("uuid, unread_count, is_lid").eq("id", chatId).single()
                let chatUuid = chatData?.uuid || null
                
                if (!chatData) {
                    chatUuid = await upsertChat({
                        id: chatId, unread_count: msg.key.fromMe ? 0 : 1, is_group: false,
                        is_archived: false, last_message_time: Number(msg.messageTimestamp) * 1000,
                    }, msgMetadata)
                } else {
                    const updateData = { last_message_time: Number(msg.messageTimestamp) * 1000, unread_count: msg.key.fromMe ? 0 : (chatData.unread_count || 0) + 1 }
                    if (chatData.is_lid && msgMetadata.pushName) updateData.push_name = msgMetadata.pushName
                    await supabase.from("chats").update(updateData).eq("id", chatId)
                }

                const msgDB = prepareMessageForDB(msg, chatId, chatUuid)
                if (isTemporaryId(chatId) && Object.keys(msgMetadata).length > 0) msgDB.sender_metadata = msgMetadata
                const { error } = await supabase.from("messages").upsert(msgDB, { onConflict: 'id' })
                if (error) console.error("[MSG] Erro:", error.message)
            }
        })

        sock.ev.on("contacts.update", async (updates) => {
            for (const contact of updates) {
                const contactId = contact.id
                if (!contactId || contactId.includes("@g.us")) continue
                const contactMetadata = extractContactMetadata(contact)
                if (contact.notify) contactStore[contactId] = contact.notify
                if (isPermanentId(contactId)) {
                    const telefone = extractPhoneFromChatId(contactId)
                    const matches = await findMatchingLidChats(telefone, contact.notify || contact.name, contact.verifiedName)
                    if (matches.length === 1) await mergeLidToPermanent(matches[0].id, contactId, telefone, contactMetadata)
                }
                if (isTemporaryId(contactId) && contactMetadata.phoneNumber) {
                    await supabase.from("chats").update({
                        phone: contactMetadata.phoneNumber.split("@")[0],
                        lid_metadata: supabase.raw(`COALESCE(lid_metadata, '{}'::jsonb) || '${JSON.stringify(contactMetadata)}'::jsonb`)
                    }).eq("id", contactId)
                }
            }
        })

        sock.ev.on("chats.update", async (updates) => {
            for (const update of updates) {
                const chatId = update.id
                if (!chatId || chatId.includes("@g.us")) continue
                const chatMetadata = extractChatMetadata(update)
                if (isPermanentId(chatId)) {
                    const telefone = extractPhoneFromChatId(chatId)
                    const { data: existingChat } = await supabase.from("chats").select("uuid").eq("id", chatId).single()
                    if (!existingChat) {
                        const matches = await findMatchingLidChats(telefone, update.name || update.notify)
                        if (matches.length === 1) await mergeLidToPermanent(matches[0].id, chatId, telefone, chatMetadata)
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
    if (sock) { try { sock.logout(); sock.end(); } catch (e) {} }
    process.exit(0);
};
process.on('SIGINT', () => handleShutdown('SIGINT'));
process.on('SIGTERM', () => handleShutdown('SIGTERM'));

// ============================================================
// 🌐 ROTAS HTTP
// ============================================================
app.get("/", (req, res) => res.send("WhatsApp API Low-End Optimized 🚀")); 
app.get("/health", (req, res) => res.json({ ok: true, status: connectionStatus.status, connected: connectionStatus.connected, phone: connectionStatus.phone, memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + "MB" }))
app.get("/qr", (req, res) => { connectionStatus.status === "qr" && lastQrDataUrl ? res.json({ qr: lastQrDataUrl, status: "qr" }) : res.json({ qr: null, status: connectionStatus.status }) })

app.post("/session/connect", async (req, res) => {
    try {
        if (connectionStatus.status === "connected" || connectionStatus.status === "syncing") return res.json({ success: true, message: "Já conectado", status: connectionStatus.status });
        if (isStarting) return res.json({ success: true, message: "Conexão em andamento", status: "connecting" });
        startWhatsApp();
        res.json({ success: true, message: "Iniciando conexão..." });
    } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.post("/session/disconnect", async (req, res) => {
    try {
        isStarting = false; hasSyncedHistory = false;
        if (sock) { try { await sock.logout(); } catch (e) {} sock.end(); sock = null; }
        if (fs.existsSync("./auth_info")) { fs.rmSync("./auth_info", { recursive: true, force: true }); fs.mkdirSync("./auth_info", { recursive: true }); }
        await updateStatus("disconnected", null, null, "Logout manual")
        const cleanupResult = await smartCleanWhatsAppData()
        res.json({ success: true, message: "Desconectado", cleanup: cleanupResult });
    } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.post("/session/smart-clean", async (req, res) => {
    try {
        if (connectionStatus.status === "connected" || connectionStatus.status === "syncing") return res.status(400).json({ success: false, error: "Desconecte primeiro." });
        const cleanupResult = await smartCleanWhatsAppData()
        res.json({ success: cleanupResult.success, stats: cleanupResult });
    } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.get("/chats/avatar/:chatId", async (req, res) => {
    try {
        if (!sock || connectionStatus.status !== "connected") return res.status(503).json({ error: "WhatsApp offline" });
        const url = await sock.profilePictureUrl(req.params.chatId, "image").catch(() => null);
        if (!url) return res.status(404).json({ error: "Avatar não encontrado" });
        const response = await fetch(url);
        const buffer = await response.arrayBuffer();
        res.set("Content-Type", response.headers.get("content-type") || "image/jpeg");
        res.send(Buffer.from(buffer));
    } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get("/chats", async (req, res) => {
    const { data, error } = await supabase.from("chats").select("*").order("last_message_time", { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

app.get("/chats/uuid/:uuid", async (req, res) => {
    const { data, error } = await supabase.from("chats").select("*").eq("uuid", req.params.uuid).single();
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

app.get("/chats/phone/:phone", async (req, res) => {
    const chat = await findChatByPhone(req.params.phone);
    if (!chat) return res.status(404).json({ error: "Chat não encontrado" });
    res.json(chat);
});

app.get("/chats/:chatId/messages", async (req, res) => {
    const { limit = 50, before } = req.query;
    let query = supabase.from("messages").select("*").eq("chat_id", req.params.chatId).order("timestamp", { ascending: false }).limit(Number(limit));
    if (before) query = query.lt("timestamp", Number(before));
    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

app.get("/chats/uuid/:uuid/messages", async (req, res) => {
    const { limit = 50, before } = req.query;
    let query = supabase.from("messages").select("*").eq("chat_uuid", req.params.uuid).order("timestamp", { ascending: false }).limit(Number(limit));
    if (before) query = query.lt("timestamp", Number(before));
    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

app.post("/chats/send", async (req, res) => {
    try {
        const { chatId, message } = req.body;
        if (!sock || connectionStatus.status !== "connected") return res.status(503).json({ error: "WhatsApp offline" });
        const result = await sock.sendMessage(chatId, { text: message });
        res.json({ success: true, messageId: result.key.id });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

app.patch("/chats/:chatId/name", async (req, res) => {
    const { name } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: "Nome obrigatório" });
    const { data, error } = await supabase.from("chats").update({ name: name.trim() }).eq("id", req.params.chatId).select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true, chat: data });
});

const PORT = process.env.PORT || 3000
app.listen(PORT, () => console.log(`[SERVER] 🌐 Porta ${PORT} - GC Mode: ${global.gc ? 'ENABLED' : 'DISABLED'}`))
