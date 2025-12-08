-- ============================================================
-- 🧹 SMART CLEAN - SCRIPTS DE TESTE E VERIFICAÇÃO
-- ============================================================

-- ============================================================
-- 1. VERIFICAR ESTADO ANTES DO SMART CLEAN
-- ============================================================

-- Ver todos os chats com seus dados
SELECT 
    uuid,
    id as whatsapp_id,
    phone,
    push_name,
    name as custom_name,
    image_url,
    etiqueta_ids,
    is_lid,
    unread_count,
    last_message_time,
    created_at
FROM chats
ORDER BY last_message_time DESC NULLS LAST
LIMIT 20;

-- Contar mensagens por chat
SELECT 
    c.uuid,
    c.name as custom_name,
    c.id as whatsapp_id,
    COUNT(m.id) as total_messages
FROM chats c
LEFT JOIN messages m ON m.chat_uuid = c.uuid
GROUP BY c.uuid, c.name, c.id
ORDER BY total_messages DESC
LIMIT 10;

-- Total de mensagens no sistema
SELECT COUNT(*) as total_messages FROM messages;

-- Total de chats
SELECT COUNT(*) as total_chats FROM chats;

-- Chats com dados personalizados
SELECT COUNT(*) as chats_with_user_data
FROM chats
WHERE name IS NOT NULL 
   OR etiqueta_ids IS NOT NULL 
   OR image_url IS NOT NULL;


-- ============================================================
-- 2. VERIFICAR ESTADO APÓS O SMART CLEAN
-- ============================================================

-- IMPORTANTE: Execute isso APÓS rodar o Smart Clean
-- Você deve ver:
-- - Mensagens = 0
-- - Chats com id = NULL
-- - Chats com phone = NULL
-- - Mas name, etiquetas, image_url PRESERVADOS

-- Ver chats após limpeza
SELECT 
    uuid,
    id as whatsapp_id,           -- Deve ser NULL
    phone,                        -- Deve ser NULL
    push_name,                    -- Deve ser NULL
    name as custom_name,          -- DEVE ESTAR PRESERVADO
    image_url,                    -- DEVE ESTAR PRESERVADO
    etiqueta_ids,                 -- DEVE ESTAR PRESERVADO
    is_lid,                       -- Deve ser false
    unread_count,                 -- Deve ser 0
    last_message_time,            -- Deve ser NULL
    lid_metadata,                 -- Deve ser NULL
    created_at                    -- DEVE ESTAR PRESERVADO
FROM chats
ORDER BY created_at DESC
LIMIT 20;

-- Total de mensagens (deve ser 0)
SELECT COUNT(*) as total_messages FROM messages;

-- Chats com dados do usuário PRESERVADOS
SELECT 
    uuid,
    name as custom_name,
    image_url,
    etiqueta_ids,
    created_at
FROM chats
WHERE name IS NOT NULL 
   OR etiqueta_ids IS NOT NULL 
   OR image_url IS NOT NULL
ORDER BY created_at DESC;


-- ============================================================
-- 3. SIMULAR RECONEXÃO COM MESMO NÚMERO
-- ============================================================

-- Este script simula o que acontece quando reconecta com o MESMO número
-- (Na prática, o sistema faz isso automaticamente)

-- Passo 1: Encontrar chat órfão (sem id)
SELECT uuid, name, created_at
FROM chats
WHERE id IS NULL
  AND name IS NOT NULL
LIMIT 1;

-- Passo 2: "Reconectar" manualmente (EXEMPLO - não execute em produção)
-- UPDATE chats
-- SET 
--     id = '5511999999999@s.whatsapp.net',
--     phone = '5511999999999',
--     push_name = 'João WhatsApp',
--     last_message_time = EXTRACT(epoch FROM NOW()) * 1000
-- WHERE uuid = 'SEU-UUID-AQUI';


-- ============================================================
-- 4. IDENTIFICAR CHATS ÓRFÃOS (sem dados do usuário)
-- ============================================================

-- Chats que não têm mais conexão com WhatsApp
-- E também não têm dados do usuário
-- Estes podem ser deletados com segurança

SELECT 
    uuid,
    id,
    phone,
    name,
    image_url,
    etiqueta_ids,
    created_at
FROM chats
WHERE id IS NULL                    -- Sem conexão WhatsApp
  AND phone IS NULL
  AND name IS NULL                  -- Sem nome customizado
  AND etiqueta_ids IS NULL          -- Sem etiquetas
  AND image_url IS NULL             -- Sem foto customizada
ORDER BY created_at DESC;

-- OPCIONAL: Deletar chats órfãos sem dados do usuário
-- (Cuidado! Execute apenas se tiver certeza)
-- 
-- DELETE FROM chats
-- WHERE id IS NULL 
--   AND phone IS NULL
--   AND name IS NULL
--   AND etiqueta_ids IS NULL
--   AND image_url IS NULL;


-- ============================================================
-- 5. ESTATÍSTICAS E AUDITORIA
-- ============================================================

-- Resumo completo do estado atual
SELECT 
    'Chats Totais' as metric,
    COUNT(*)::text as value
FROM chats
UNION ALL
SELECT 
    'Chats com WhatsApp ID' as metric,
    COUNT(*)::text
FROM chats
WHERE id IS NOT NULL
UNION ALL
SELECT 
    'Chats Órfãos (sem ID)' as metric,
    COUNT(*)::text
FROM chats
WHERE id IS NULL
UNION ALL
SELECT 
    'Chats com Dados do Usuário' as metric,
    COUNT(*)::text
FROM chats
WHERE name IS NOT NULL 
   OR etiqueta_ids IS NOT NULL 
   OR image_url IS NOT NULL
UNION ALL
SELECT 
    'Mensagens Totais' as metric,
    COUNT(*)::text
FROM messages
UNION ALL
SELECT 
    'Status Atual' as metric,
    status::text
FROM instance_settings
WHERE id = 1;


-- ============================================================
-- 6. TESTE DE INTEGRIDADE
-- ============================================================

-- Verificar se há mensagens órfãs (sem chat)
SELECT 
    m.id,
    m.chat_id,
    m.chat_uuid,
    m.content,
    m.timestamp
FROM messages m
LEFT JOIN chats c ON c.uuid = m.chat_uuid
WHERE c.uuid IS NULL
LIMIT 10;

-- Verificar se há inconsistências de UUID
SELECT 
    chat_id,
    chat_uuid,
    COUNT(*) as total
FROM messages
WHERE chat_uuid IS NULL
GROUP BY chat_id, chat_uuid
ORDER BY total DESC
LIMIT 10;


-- ============================================================
-- 7. COMPARAÇÃO ANTES/DEPOIS
-- ============================================================

-- Execute ANTES do Smart Clean e salve os resultados
CREATE TEMP TABLE IF NOT EXISTS smart_clean_before AS
SELECT 
    (SELECT COUNT(*) FROM messages) as messages_count,
    (SELECT COUNT(*) FROM chats) as chats_count,
    (SELECT COUNT(*) FROM chats WHERE id IS NOT NULL) as chats_with_id,
    (SELECT COUNT(*) FROM chats WHERE name IS NOT NULL OR etiqueta_ids IS NOT NULL OR image_url IS NOT NULL) as chats_with_user_data,
    NOW() as snapshot_time;

-- Execute APÓS o Smart Clean e compare
CREATE TEMP TABLE IF NOT EXISTS smart_clean_after AS
SELECT 
    (SELECT COUNT(*) FROM messages) as messages_count,
    (SELECT COUNT(*) FROM chats) as chats_count,
    (SELECT COUNT(*) FROM chats WHERE id IS NOT NULL) as chats_with_id,
    (SELECT COUNT(*) FROM chats WHERE name IS NOT NULL OR etiqueta_ids IS NOT NULL OR image_url IS NOT NULL) as chats_with_user_data,
    NOW() as snapshot_time;

-- Ver comparação
SELECT 
    'ANTES' as momento,
    messages_count,
    chats_count,
    chats_with_id,
    chats_with_user_data
FROM smart_clean_before
UNION ALL
SELECT 
    'DEPOIS' as momento,
    messages_count,
    chats_count,
    chats_with_id,
    chats_with_user_data
FROM smart_clean_after;


-- ============================================================
-- 8. RECUPERAÇÃO (SE NECESSÁRIO)
-- ============================================================

-- Se você tiver um backup, pode restaurar com:
-- 
-- 1. Restaurar tabela messages:
--    pg_restore -d seu_banco -t messages backup.dump
-- 
-- 2. Restaurar apenas campos específicos dos chats:
--    (Execute isso com cuidado, apenas em caso de necessidade)

-- EXEMPLO de restauração seletiva (NÃO EXECUTE sem backup)
-- UPDATE chats c
-- SET 
--     id = b.id,
--     phone = b.phone,
--     push_name = b.push_name
-- FROM chats_backup b
-- WHERE c.uuid = b.uuid;


-- ============================================================
-- 9. MANUTENÇÃO PREVENTIVA
-- ============================================================

-- Identificar chats muito antigos sem atividade
SELECT 
    uuid,
    name,
    created_at,
    last_message_time,
    AGE(NOW(), created_at) as idade
FROM chats
WHERE last_message_time IS NULL
  OR last_message_time < EXTRACT(epoch FROM (NOW() - INTERVAL '6 months')) * 1000
ORDER BY created_at ASC
LIMIT 20;

-- Limpar chats órfãos com mais de 30 dias sem dados do usuário
-- (CUIDADO - Execute apenas se tiver certeza!)
-- 
-- DELETE FROM chats
-- WHERE id IS NULL
--   AND phone IS NULL
--   AND name IS NULL
--   AND etiqueta_ids IS NULL
--   AND image_url IS NULL
--   AND created_at < NOW() - INTERVAL '30 days';


-- ============================================================
-- 10. QUERIES ÚTEIS PARA DEBUG
-- ============================================================

-- Ver configuração da instância
SELECT * FROM instance_settings WHERE id = 1;

-- Ver chats recentes com mais detalhes
SELECT 
    uuid,
    id,
    phone,
    push_name,
    name,
    is_lid,
    is_group,
    unread_count,
    TO_TIMESTAMP(last_message_time / 1000) as last_message,
    created_at
FROM chats
ORDER BY last_message_time DESC NULLS LAST
LIMIT 10;

-- Contar chats por tipo
SELECT 
    CASE 
        WHEN id IS NULL THEN 'Órfão (sem ID)'
        WHEN is_lid THEN 'LID (@lid)'
        WHEN is_group THEN 'Grupo'
        ELSE 'Normal'
    END as tipo,
    COUNT(*) as total
FROM chats
GROUP BY tipo
ORDER BY total DESC;
