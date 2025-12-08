# 🧹 Smart Clean - Guia de Uso

## O que é o Smart Clean?

O **Smart Clean** é um sistema de limpeza inteligente que executa automaticamente quando o WhatsApp é desconectado. Ele limpa dados temporários da sessão, mas **preserva dados importantes** definidos pelo usuário.

---

## 🎯 Objetivo

- ✅ Limpar dados temporários (mensagens, IDs do WhatsApp)
- ✅ Preservar dados permanentes (nomes customizados, etiquetas, imagens)
- ✅ Permitir reconexão sem duplicidade de dados
- ✅ Suportar múltiplos números sem conflitos

---

## 📊 O que é Deletado vs Preservado

### Tabela `messages` (100% deletada)
❌ **TODAS as mensagens são deletadas**
- Justificativa: As mensagens serão sincronizadas novamente na próxima conexão
- Benefício: Economiza espaço e evita mensagens desatualizadas

### Tabela `chats` (limpeza seletiva)

#### ✅ PRESERVADO (dados permanentes)
- `uuid` - Identificador único permanente (PK)
- `name` - Nome customizado pelo usuário
- `image_url` - Foto customizada do chat
- `etiqueta_ids` - Tags/categorias definidas pelo usuário
- `created_at`, `updated_at` - Timestamps de auditoria
- Todos os relacionamentos (notes, assignments, history, etc)

#### 🧹 LIMPO (dados temporários)
- `id` - Chat ID do WhatsApp (será repopulado)
- `phone` - Número de telefone (será extraído novamente)
- `push_name` - Nome do contato no WhatsApp (será sincronizado)
- `verified_name` - Nome verificado de empresas
- `is_lid`, `is_group`, `is_archived` - Flags de estado
- `unread_count` - Contador de não lidas
- `last_message_time` - Timestamp da última mensagem
- `lid_metadata`, `original_lid_id` - Metadados de sessão

---

## 🔄 Cenários de Reconexão

### Cenário 1: Reconexão com o MESMO número

```
ANTES DA DESCONEXÃO:
Chat UUID: abc-123
- id: 5511999999999@s.whatsapp.net
- phone: 5511999999999
- name: "João Silva (Cliente VIP)"
- etiqueta_ids: [1, 3, 5]
- image_url: "custom-avatar.jpg"

APÓS SMART CLEAN:
Chat UUID: abc-123
- id: NULL
- phone: NULL
- name: "João Silva (Cliente VIP)"  ✅ PRESERVADO
- etiqueta_ids: [1, 3, 5]          ✅ PRESERVADO
- image_url: "custom-avatar.jpg"    ✅ PRESERVADO

APÓS RECONEXÃO (mesmo número):
Chat UUID: abc-123  ✅ MESMO UUID!
- id: 5511999999999@s.whatsapp.net  ⬅️ Repopulado
- phone: 5511999999999              ⬅️ Extraído novamente
- name: "João Silva (Cliente VIP)"  ✅ Mantido
- etiqueta_ids: [1, 3, 5]          ✅ Mantido
- image_url: "custom-avatar.jpg"    ✅ Mantido
- mensagens sincronizadas novamente ⬅️ Novas
```

✅ **RESULTADO**: Os dados "casam" perfeitamente pelo UUID!

---

### Cenário 2: Reconexão com OUTRO número

```
ANTES DA DESCONEXÃO (Número A):
Chat UUID: abc-123
- id: 5511999999999@s.whatsapp.net
- phone: 5511999999999
- name: "João Silva"

APÓS SMART CLEAN:
Chat UUID: abc-123
- id: NULL          ⬅️ Zerado
- phone: NULL       ⬅️ Zerado
- name: "João Silva" ✅ Preservado (órfão)

APÓS RECONEXÃO (Número B):
Chat UUID: xyz-789  ✅ NOVO UUID!
- id: 5511888888888@s.whatsapp.net  ⬅️ Novo número
- phone: 5511888888888              ⬅️ Novo
- name: NULL                        ⬅️ Novo chat
```

✅ **RESULTADO**: Sem duplicidade! Número antigo fica "órfão" (pode ser limpo depois)

---

## 🚀 Como Executar

### 1. Automático (ao desconectar)

O Smart Clean é executado automaticamente quando:
- Você faz logout via API (`POST /session/disconnect`)
- O WhatsApp é desconectado permanentemente (logout remoto)
- A sessão expira ou é removida

```bash
POST http://localhost:3000/session/disconnect
```

**Resposta:**
```json
{
  "success": true,
  "message": "Desconectado com sucesso",
  "cleanup": {
    "success": true,
    "messages_deleted": 1543,
    "chats_cleaned": 87,
    "chats_preserved": 42
  }
}
```

---

### 2. Manual (via API)

Execute o Smart Clean manualmente quando o WhatsApp estiver desconectado:

```bash
POST http://localhost:3000/session/smart-clean
```

**Resposta de sucesso:**
```json
{
  "success": true,
  "message": "Smart Clean executado com sucesso",
  "stats": {
    "success": true,
    "messages_deleted": 1543,
    "chats_cleaned": 87,
    "chats_preserved": 42
  }
}
```

**Erro se conectado:**
```json
{
  "success": false,
  "error": "Não é possível executar Smart Clean enquanto conectado. Desconecte primeiro."
}
```

---

## 📝 Logs do Smart Clean

Quando o Smart Clean é executado, você verá logs detalhados no console:

```
[SMART CLEAN] 🧹 Iniciando limpeza inteligente do banco...
[SMART CLEAN] 📋 Estratégia:
  ✅ PRESERVA: uuid, name, etiquetas, image_url
  🧹 LIMPA: id, phone, mensagens, metadados temporários
[SMART CLEAN] 📝 FASE 1: Deletando mensagens...
[SMART CLEAN] ✅ 1543 mensagens deletadas
[SMART CLEAN] 💬 FASE 2: Limpando dados temporários dos chats...
[SMART CLEAN] ✅ 87 chats limpos
[SMART CLEAN] ⚙️ FASE 4: Resetando configurações da instância...

[SMART CLEAN] ✅ LIMPEZA COMPLETA!
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📝 Mensagens deletadas:      1543
💬 Chats limpos:             87
✅ Chats com dados do usuário: 42
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
💡 Próxima conexão:
   • MESMO número → dados casam pelo UUID
   • OUTRO número → sem duplicidade (IDs zerados)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

---

## 🔍 Verificando Dados Preservados

Para verificar quais chats têm dados do usuário preservados:

```sql
-- Chats com dados personalizados pelo usuário
SELECT 
    uuid,
    name,
    image_url,
    etiqueta_ids,
    phone,
    id,
    created_at
FROM chats
WHERE 
    name IS NOT NULL 
    OR etiqueta_ids IS NOT NULL 
    OR image_url IS NOT NULL
ORDER BY created_at DESC;
```

---

## ⚠️ Avisos Importantes

1. **Não execute Smart Clean com WhatsApp conectado**
   - O sistema bloqueia automaticamente via API
   - Sempre desconecte primeiro

2. **Dados preservados são PERMANENTES**
   - `uuid` nunca muda
   - `name`, `etiquetas`, `image_url` sobrevivem à limpeza
   - Use isso para manter contexto entre sessões

3. **Chats órfãos podem acumular**
   - Se trocar de número frequentemente
   - Considere criar uma rotina de limpeza de chats órfãos (sem `id` e sem dados do usuário)

4. **Backup recomendado**
   - Antes de testes, faça backup do banco
   - Especialmente se tiver dados importantes

---

## 🧪 Testando o Smart Clean

### Teste 1: Preservação de Dados

1. Conecte o WhatsApp
2. Customize alguns chats (nome, etiquetas, foto)
3. Desconecte (`POST /session/disconnect`)
4. Verifique o banco: `name`, `etiquetas`, `image_url` devem estar preservados
5. Reconecte com o MESMO número
6. Verifique: dados customizados devem "casar" perfeitamente

### Teste 2: Troca de Número

1. Conecte com número A
2. Customize chats
3. Desconecte
4. Conecte com número B
5. Verifique: novos chats criados, sem duplicidade

### Teste 3: Limpeza Manual

1. Desconecte o WhatsApp
2. Execute `POST /session/smart-clean`
3. Verifique os logs e estatísticas
4. Confirme que mensagens foram deletadas mas dados do usuário preservados

---

## 📞 Suporte

Se você encontrar problemas:
1. Verifique os logs do console
2. Confirme que está desconectado antes de executar Smart Clean manual
3. Verifique a estrutura do banco de dados (colunas corretas)
4. Teste com dados de exemplo primeiro

---

## 🎉 Benefícios

- ✅ Economiza espaço no banco de dados
- ✅ Evita dados desatualizados
- ✅ Permite múltiplos números sem conflitos
- ✅ Preserva contexto do usuário entre sessões
- ✅ Automático e transparente
- ✅ Reversível (mensagens são resincronizadas)

---

**Última atualização**: Dezembro 2025
