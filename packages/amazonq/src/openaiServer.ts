/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 *
 * OpenAI-compatible API server that proxies to Amazon Q / CodeWhisperer
 * streaming API. Ported from kiro-gateway (Python) to TypeScript,
 * reusing the VS Code extension's existing authentication.
 */

import * as http from 'http'
import * as https from 'https'
import * as vscode from 'vscode'
import { AuthUtil } from 'aws-core-vscode/codewhisperer'
import { getLogger } from 'aws-core-vscode/shared'
import { randomUUID } from 'crypto'

const log = getLogger()

// ── Types ────────────────────────────────────────────────────────────────────

interface OpenAIMessage {
    role: string
    content: any
    tool_calls?: any[]
    tool_call_id?: string
}

interface OpenAITool {
    type: string
    function?: { name: string; description?: string; parameters?: any }
}

interface OpenAIChatRequest {
    model?: string
    messages: OpenAIMessage[]
    tools?: OpenAITool[]
    stream?: boolean
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function extractText(content: any): string {
    if (!content) return ''
    if (typeof content === 'string') return content
    if (Array.isArray(content)) {
        return content
            .filter((b: any) => b.type === 'text' || b.text)
            .map((b: any) => b.text ?? '')
            .join('')
    }
    return String(content)
}

function sanitizeSchema(schema: any): any {
    if (!schema || typeof schema !== 'object') return schema
    const out: any = {}
    for (const [k, v] of Object.entries(schema)) {
        if (k === 'additionalProperties') continue
        if (k === 'required' && Array.isArray(v) && v.length === 0) continue
        if (k === 'properties' && typeof v === 'object' && v !== null) {
            out[k] = Object.fromEntries(
                Object.entries(v).map(([pk, pv]) => [pk, sanitizeSchema(pv)])
            )
        } else if (Array.isArray(v)) {
            out[k] = v.map((i: any) => (typeof i === 'object' ? sanitizeSchema(i) : i))
        } else if (typeof v === 'object' && v !== null) {
            out[k] = sanitizeSchema(v)
        } else {
            out[k] = v
        }
    }
    return out
}

// ── Payload builder (OpenAI → Kiro/CW format) ───────────────────────────────

function buildKiroPayload(req: OpenAIChatRequest, conversationId: string, profileArn?: string) {
    let systemPrompt = ''
    const unified: { role: string; content: string; toolCalls?: any[]; toolResults?: any[] }[] = []
    const pendingToolResults: any[] = []

    for (const m of req.messages) {
        if (m.role === 'system') {
            systemPrompt += extractText(m.content) + '\n'
            continue
        }
        if (m.role === 'tool') {
            pendingToolResults.push({
                content: [{ text: extractText(m.content) || '(empty result)' }],
                status: 'success',
                toolUseId: m.tool_call_id ?? '',
            })
            continue
        }
        if (pendingToolResults.length) {
            unified.push({ role: 'user', content: '', toolResults: [...pendingToolResults] })
            pendingToolResults.length = 0
        }
        const entry: (typeof unified)[0] = { role: m.role, content: extractText(m.content) }
        if (m.role === 'assistant' && m.tool_calls?.length) {
            entry.toolCalls = m.tool_calls.map((tc: any) => ({
                name: tc.function?.name ?? '',
                input: JSON.parse(tc.function?.arguments ?? '{}'),
                toolUseId: tc.id ?? '',
            }))
        }
        unified.push(entry)
    }
    if (pendingToolResults.length) {
        unified.push({ role: 'user', content: '', toolResults: [...pendingToolResults] })
    }

    systemPrompt = systemPrompt.trim()

    // Merge adjacent same-role messages
    const merged: typeof unified = []
    for (const m of unified) {
        const last = merged[merged.length - 1]
        if (last && last.role === m.role) {
            last.content = (last.content + '\n' + m.content).trim()
            if (m.toolCalls) last.toolCalls = [...(last.toolCalls ?? []), ...m.toolCalls]
            if (m.toolResults) last.toolResults = [...(last.toolResults ?? []), ...m.toolResults]
        } else {
            merged.push({ ...m })
        }
    }

    // Ensure first message is user
    if (merged.length && merged[0].role !== 'user') {
        merged.unshift({ role: 'user', content: '(empty)' })
    }

    // Ensure alternating roles
    const alternated: typeof merged = [merged[0]]
    for (let i = 1; i < merged.length; i++) {
        if (merged[i].role === alternated[alternated.length - 1].role) {
            alternated.push({ role: merged[i].role === 'user' ? 'assistant' : 'user', content: '(empty)' })
        }
        alternated.push(merged[i])
    }

    const modelId = req.model ?? 'claude-sonnet-4.5'
    const historyMsgs = alternated.length > 1 ? alternated.slice(0, -1) : []
    const current = alternated[alternated.length - 1]

    // Prepend system prompt to first user message in history (or current if no history)
    if (systemPrompt) {
        if (historyMsgs.length && historyMsgs[0].role === 'user') {
            historyMsgs[0].content = systemPrompt + '\n\n' + historyMsgs[0].content
        } else {
            current.content = systemPrompt + '\n\n' + current.content
        }
    }

    // Build history array
    const history: any[] = historyMsgs.map((m) => {
        if (m.role === 'user') {
            const ui: any = { content: m.content || '(empty)', modelId, origin: 'AI_EDITOR' }
            if (m.toolResults?.length) {
                ui.userInputMessageContext = { toolResults: m.toolResults }
            }
            return { userInputMessage: ui }
        }
        const ar: any = { content: m.content || '(empty)' }
        if (m.toolCalls?.length) ar.toolUses = m.toolCalls
        return { assistantResponseMessage: ar }
    })

    // Current message
    let currentContent = current.content || '(empty)'
    if (current.role === 'assistant') {
        history.push({ assistantResponseMessage: { content: currentContent } })
        currentContent = 'Continue'
    }

    const userInput: any = { content: currentContent, modelId, origin: 'AI_EDITOR' }
    const ctx: any = {}

    // Tools
    if (req.tools?.length) {
        ctx.tools = req.tools
            .filter((t) => t.type === 'function' && t.function)
            .map((t) => ({
                toolSpecification: {
                    name: t.function!.name,
                    description: t.function!.description || `Tool: ${t.function!.name}`,
                    inputSchema: { json: sanitizeSchema(t.function!.parameters ?? {}) },
                },
            }))
    }

    // Tool results on current message
    if (current.toolResults?.length) {
        ctx.toolResults = current.toolResults
    }

    if (Object.keys(ctx).length) userInput.userInputMessageContext = ctx

    const payload: any = {
        conversationState: {
            chatTriggerType: 'MANUAL',
            conversationId,
            currentMessage: { userInputMessage: userInput },
        },
    }
    if (history.length) payload.conversationState.history = history
    if (profileArn) payload.profileArn = profileArn

    return payload
}

// ── AWS SSE stream parser ────────────────────────────────────────────────────

interface ParsedEvent {
    type: 'content' | 'tool_start' | 'tool_input' | 'tool_stop' | 'usage' | 'context_usage'
    data: any
}

function findMatchingBrace(text: string, start: number): number {
    if (start >= text.length || text[start] !== '{') return -1
    let depth = 0
    let inStr = false
    let esc = false
    for (let i = start; i < text.length; i++) {
        const c = text[i]
        if (esc) { esc = false; continue }
        if (c === '\\' && inStr) { esc = true; continue }
        if (c === '"') { inStr = !inStr; continue }
        if (!inStr) {
            if (c === '{') depth++
            else if (c === '}' && --depth === 0) return i
        }
    }
    return -1
}

const EVENT_PATTERNS: [string, ParsedEvent['type']][] = [
    ['{"content":', 'content'],
    ['{"name":', 'tool_start'],
    ['{"input":', 'tool_input'],
    ['{"stop":', 'tool_stop'],
    ['{"usage":', 'usage'],
    ['{"contextUsagePercentage":', 'context_usage'],
]

function parseChunk(buffer: { value: string }): ParsedEvent[] {
    const events: ParsedEvent[] = []
    while (true) {
        let earliest = -1
        let eType: ParsedEvent['type'] | undefined
        for (const [pat, t] of EVENT_PATTERNS) {
            const pos = buffer.value.indexOf(pat)
            if (pos !== -1 && (earliest === -1 || pos < earliest)) {
                earliest = pos
                eType = t
            }
        }
        if (earliest === -1 || !eType) break
        const end = findMatchingBrace(buffer.value, earliest)
        if (end === -1) break
        const json = buffer.value.slice(earliest, end + 1)
        buffer.value = buffer.value.slice(end + 1)
        try {
            const data = JSON.parse(json)
            events.push({ type: eType, data })
        } catch { /* skip malformed */ }
    }
    return events
}

// ── HTTP request to CodeWhisperer API ────────────────────────────────────────

function postStream(url: string, body: string, headers: Record<string, string>): Promise<http.IncomingMessage> {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url)
        const opts: https.RequestOptions = {
            hostname: parsed.hostname,
            port: parsed.port || 443,
            path: parsed.pathname,
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        }
        const req = https.request(opts, (res) => resolve(res))
        req.on('error', reject)
        req.write(body)
        req.end()
    })
}

async function streamFromCW(payload: any): Promise<http.IncomingMessage> {
    const token = await AuthUtil.instance.getBearerToken()
    const clientConfig = AuthUtil.instance.regionProfileManager.clientConfig as { endpoint: string; region: string }
    const url = `${clientConfig.endpoint}/generateAssistantResponse`
    const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        'x-amzn-codewhisperer-optout': 'false',
    }
    return postStream(url, JSON.stringify(payload), headers)
}

// ── Request handler ──────────────────────────────────────────────────────────

async function handleChatCompletions(req: OpenAIChatRequest, res: http.ServerResponse) {
    const conversationId = randomUUID()
    const requestId = `chatcmpl-${randomUUID().replace(/-/g, '').slice(0, 24)}`
    const created = Math.floor(Date.now() / 1000)
    const model = req.model ?? 'amazon-q'

    let profileArn: string | undefined
    try {
        profileArn = AuthUtil.instance.regionProfileManager?.activeRegionProfile?.arn
    } catch { /* optional */ }

    const payload = buildKiroPayload(req, conversationId, profileArn)

    let upstream: http.IncomingMessage
    try {
        upstream = await streamFromCW(payload)
    } catch (err: any) {
        log.error('CW API request failed: %s', err)
        res.writeHead(502, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: `Upstream error: ${err.message}` } }))
        return
    }

    if (upstream.statusCode !== 200) {
        const chunks: Buffer[] = []
        for await (const c of upstream) chunks.push(c as Buffer)
        const body = Buffer.concat(chunks).toString()
        log.error('CW API returned %d: %s', upstream.statusCode, body)
        res.writeHead(upstream.statusCode ?? 502, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: `Upstream ${upstream.statusCode}: ${body}` } }))
        return
    }

    const buffer = { value: '' }
    const toolCalls: any[] = []
    let currentTool: any = null
    let lastContent: string | null = null

    if (req.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
        let first = true

        const sendChunk = (delta: any, finishReason: string | null) => {
            const chunk = { id: requestId, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finishReason }] }
            res.write(`data: ${JSON.stringify(chunk)}\n\n`)
        }

        for await (const raw of upstream) {
            buffer.value += (raw as Buffer).toString('utf-8')
            for (const ev of parseChunk(buffer)) {
                if (ev.type === 'content') {
                    const text = ev.data.content ?? ''
                    if (text === lastContent) continue
                    lastContent = text
                    const delta: any = { content: text }
                    if (first) { delta.role = 'assistant'; first = false }
                    sendChunk(delta, null)
                } else if (ev.type === 'tool_start') {
                    if (currentTool) toolCalls.push(currentTool)
                    currentTool = {
                        id: ev.data.toolUseId ?? `call_${randomUUID().slice(0, 8)}`,
                        type: 'function',
                        function: { name: ev.data.name ?? '', arguments: typeof ev.data.input === 'object' ? JSON.stringify(ev.data.input) : (ev.data.input ?? '') },
                    }
                    if (ev.data.stop) { toolCalls.push(currentTool); currentTool = null }
                } else if (ev.type === 'tool_input' && currentTool) {
                    const inp = typeof ev.data.input === 'object' ? JSON.stringify(ev.data.input) : (ev.data.input ?? '')
                    currentTool.function.arguments += inp
                } else if (ev.type === 'tool_stop' && currentTool) {
                    // Try to normalize arguments JSON
                    try { currentTool.function.arguments = JSON.stringify(JSON.parse(currentTool.function.arguments)) } catch { /* keep raw */ }
                    toolCalls.push(currentTool)
                    currentTool = null
                }
            }
        }
        if (currentTool) {
            try { currentTool.function.arguments = JSON.stringify(JSON.parse(currentTool.function.arguments)) } catch {}
            toolCalls.push(currentTool)
        }

        if (toolCalls.length) {
            sendChunk({ tool_calls: toolCalls.map((tc, i) => ({ index: i, ...tc })) }, null)
        }

        sendChunk({}, toolCalls.length ? 'tool_calls' : 'stop')
        res.write('data: [DONE]\n\n')
        res.end()
    } else {
        // Non-streaming: collect full response
        let fullContent = ''
        for await (const raw of upstream) {
            buffer.value += (raw as Buffer).toString('utf-8')
            for (const ev of parseChunk(buffer)) {
                if (ev.type === 'content') {
                    const text = ev.data.content ?? ''
                    if (text !== lastContent) { fullContent += text; lastContent = text }
                } else if (ev.type === 'tool_start') {
                    if (currentTool) toolCalls.push(currentTool)
                    currentTool = { id: ev.data.toolUseId ?? `call_${randomUUID().slice(0, 8)}`, type: 'function', function: { name: ev.data.name ?? '', arguments: typeof ev.data.input === 'object' ? JSON.stringify(ev.data.input) : (ev.data.input ?? '') } }
                    if (ev.data.stop) { toolCalls.push(currentTool); currentTool = null }
                } else if (ev.type === 'tool_input' && currentTool) {
                    currentTool.function.arguments += typeof ev.data.input === 'object' ? JSON.stringify(ev.data.input) : (ev.data.input ?? '')
                } else if (ev.type === 'tool_stop' && currentTool) {
                    try { currentTool.function.arguments = JSON.stringify(JSON.parse(currentTool.function.arguments)) } catch {}
                    toolCalls.push(currentTool); currentTool = null
                }
            }
        }
        if (currentTool) {
            try { currentTool.function.arguments = JSON.stringify(JSON.parse(currentTool.function.arguments)) } catch {}
            toolCalls.push(currentTool)
        }

        const message: any = { role: 'assistant', content: fullContent }
        if (toolCalls.length) message.tool_calls = toolCalls
        const finishReason = toolCalls.length ? 'tool_calls' : 'stop'

        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
            id: requestId, object: 'chat.completion', created, model,
            choices: [{ index: 0, message, finish_reason: finishReason }],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        }))
    }
}

function handleModels(res: http.ServerResponse) {
    const created = Math.floor(Date.now() / 1000)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
        object: 'list',
        data: [
            { id: 'amazon-q', object: 'model', created, owned_by: 'amazon' },
            { id: 'claude-sonnet-4.6', object: 'model', created, owned_by: 'amazon' },
            { id: 'claude-sonnet-4.5', object: 'model', created, owned_by: 'amazon' },
            { id: 'claude-sonnet-4', object: 'model', created, owned_by: 'amazon' },
            { id: 'claude-haiku-4.5', object: 'model', created, owned_by: 'amazon' },
        ],
    }))
}

function readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = []
        req.on('data', (c: Buffer) => chunks.push(c))
        req.on('end', () => resolve(Buffer.concat(chunks).toString()))
        req.on('error', reject)
    })
}

// ── Server ───────────────────────────────────────────────────────────────────

export class OpenAICompatServer {
    private server: http.Server | undefined
    private _port: number

    constructor(port = 61822) { this._port = port }
    get port() { return this._port }
    get isRunning() { return !!this.server }

    async start(): Promise<void> {
        if (this.server) return

        this.server = http.createServer(async (req, res) => {
            res.setHeader('Access-Control-Allow-Origin', '*')
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
            if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

            const url = req.url ?? ''

            if (url === '/v1/models' && req.method === 'GET') return handleModels(res)

            if (url === '/v1/chat/completions' && req.method === 'POST') {
                if (!AuthUtil.instance.isConnected()) {
                    res.writeHead(401, { 'Content-Type': 'application/json' })
                    res.end(JSON.stringify({ error: { message: 'Not authenticated with Amazon Q' } }))
                    return
                }
                const body = await readBody(req)
                let parsed: OpenAIChatRequest
                try { parsed = JSON.parse(body) } catch {
                    res.writeHead(400, { 'Content-Type': 'application/json' })
                    res.end(JSON.stringify({ error: { message: 'Invalid JSON' } }))
                    return
                }
                if (!parsed.messages?.length) {
                    res.writeHead(400, { 'Content-Type': 'application/json' })
                    res.end(JSON.stringify({ error: { message: 'messages required' } }))
                    return
                }
                try {
                    await handleChatCompletions(parsed, res)
                } catch (err: any) {
                    log.error('handleChatCompletions error: %s', err)
                    if (!res.headersSent) {
                        res.writeHead(500, { 'Content-Type': 'application/json' })
                        res.end(JSON.stringify({ error: { message: err.message ?? 'Internal error' } }))
                    }
                }
                return
            }

            res.writeHead(404, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: { message: 'Not found' } }))
        })

        return new Promise((resolve, reject) => {
            this.server!.listen(this._port, '127.0.0.1', () => {
                log.info('OpenAI-compatible server listening on http://127.0.0.1:%d', this._port)
                resolve()
            })
            this.server!.on('error', (err) => { this.server = undefined; reject(err) })
        })
    }

    stop(): Promise<void> {
        return new Promise((resolve) => {
            if (!this.server) { resolve(); return }
            this.server.close(() => { this.server = undefined; log.info('OpenAI-compatible server stopped'); resolve() })
        })
    }
}

// ── Activation ───────────────────────────────────────────────────────────────

let serverInstance: OpenAICompatServer | undefined

export function activateOpenAIServer(context: vscode.ExtensionContext) {
    const config = vscode.workspace.getConfiguration('amazonQ')
    const port = config.get<number>('openAICompatServer.port', 61822)
    const autoStart = config.get<boolean>('openAICompatServer.autoStart', true)

    serverInstance = new OpenAICompatServer(port)

    context.subscriptions.push(
        vscode.commands.registerCommand('aws.amazonq.openaiServer.start', async () => {
            try {
                await serverInstance!.start()
                void vscode.window.showInformationMessage(`Amazon Q OpenAI-compatible server on http://127.0.0.1:${serverInstance!.port}`)
            } catch (err: any) { void vscode.window.showErrorMessage(`Failed to start: ${err.message}`) }
        }),
        vscode.commands.registerCommand('aws.amazonq.openaiServer.stop', async () => {
            await serverInstance!.stop()
            void vscode.window.showInformationMessage('Amazon Q OpenAI-compatible server stopped')
        }),
        { dispose: () => serverInstance?.stop() }
    )

    if (autoStart) {
        serverInstance.start().catch((err) => log.error('Auto-start failed: %s', err))
    }
}
