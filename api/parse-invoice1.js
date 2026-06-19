// api/parse-invoice1.js
// Vercel serverless function: parses messy invoice text into structured JSON via Gemini.
// Returns the full field set consumed by InvoiceGenerator.tsx.
const GEMINI_MODEL = "gemini-2.0-flash"
const GEMINI_URL = (key) =>
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`
const ALLOWED_CURRENCIES = ["USD", "EUR", "GBP", "INR", "AUD", "CAD", "JPY"]
// ---- Response schema enforced on Gemini ----
const RESPONSE_SCHEMA = {
    type: "object",
    properties: {
        fromName: { type: "string" },
        fromEmail: { type: "string" },
        clientName: { type: "string" },
        clientEmail: { type: "string" },
        invoiceNumber: { type: "string" },
        currency: { type: "string", enum: ALLOWED_CURRENCIES },
        issueDate: { type: "string", description: "ISO yyyy-mm-dd" },
        dueDate: { type: "string", description: "ISO yyyy-mm-dd" },
        taxPercent: { type: "number" },
        discountPercent: { type: "number" },
        notes: { type: "string" },
        clientMessage: { type: "string" },
        dueReminderMessage: { type: "string" },
        overdueReminderMessage: { type: "string" },
        lineItems: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    description: { type: "string" },
                    quantity: { type: "number" },
                    unitPrice: { type: "number" },
                },
            },
        },
    },
}
function buildPrompt(text, currentInvoice, todayIso) {
    const context = currentInvoice
        ? `\nThe user's current invoice state (use as context, only override fields the new text clearly changes):\n${JSON.stringify(
              currentInvoice,
              null,
              2
          )}\n`
        : ""
    return `You are an invoice parsing engine. Convert the user's free-form text into a structured invoice JSON object.
Today's date is ${todayIso}. Resolve ALL relative dates (e.g. "net 30", "due next Friday", "in 2 weeks", "tomorrow") into absolute ISO yyyy-mm-dd strings relative to today.
Rules:
- Only include a field if you can confidently extract or derive it. Leave unknown fields out (do not invent emails, names, or numbers).
- currency MUST be one of: ${ALLOWED_CURRENCIES.join(", ")}. Detect from symbols (₹=INR, $=USD, €=EUR, £=GBP, ¥=JPY) or words.
- Parse amounts with shorthand: "3k" = 3000, "12,000" = 12000. Strip currency symbols from numbers.
- Each line item: description (clean human label, no prices or client names), quantity (default 1), unitPrice (number).
- taxPercent / discountPercent are plain numbers (e.g. 18 not "18%").
- notes: payment terms or instructions if mentioned.
- clientMessage: a short, friendly delivery message to send the client with the invoice.
- dueReminderMessage: a polite reminder to send shortly before the due date.
- overdueReminderMessage: a firmer follow-up for when the invoice is overdue.
- For the three message fields, write natural, ready-to-send copy using the client name, invoice number, amount, and due date when available.
${context}
User text:
"""${text}"""`
}
// ---- Server-side relative date normalization (safety net) ----
function normalizeDate(value, today) {
    if (!value || typeof value !== "string") return undefined
    const v = value.trim()
    const ref = today instanceof Date && !isNaN(today.getTime()) ? today : new Date()
    const iso = v.match(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/)
    if (iso) {
        const d = new Date(+iso[1], +iso[2] - 1, +iso[3])
        if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10)
    }
    const net = v.toLowerCase().match(/\bnet\s+(\d{1,3})\b/)
    if (net) {
        const d = new Date(ref)
        d.setDate(d.getDate() + +net[1])
        return d.toISOString().slice(0, 10)
    }
    const inDays = v.toLowerCase().match(/\bin\s+(\d{1,3})\s+days?\b/)
    if (inDays) {
        const d = new Date(ref)
        d.setDate(d.getDate() + +inDays[1])
        return d.toISOString().slice(0, 10)
    }
    const parsed = new Date(v)
    if (!isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10)
    return undefined
}
function clampNumber(value) {
    if (typeof value === "number" && isFinite(value)) return value
    if (typeof value === "string") {
        const n = parseFloat(value.replace(/[^0-9.\-]/g, ""))
        if (isFinite(n)) return n
    }
    return undefined
}
function sanitizeInvoice(raw, today) {
    if (!raw || typeof raw !== "object") return null
    const out = {}
    const str = (k) => (typeof raw[k] === "string" && raw[k].trim() ? raw[k].trim() : undefined)
    if (str("fromName")) out.fromName = str("fromName")
    if (str("fromEmail")) out.fromEmail = str("fromEmail")
    if (str("clientName")) out.clientName = str("clientName")
    if (str("clientEmail")) out.clientEmail = str("clientEmail")
    if (str("invoiceNumber")) out.invoiceNumber = str("invoiceNumber")
    if (str("currency")) {
        const c = str("currency").toUpperCase()
        if (ALLOWED_CURRENCIES.includes(c)) out.currency = c
    }
    const issue = normalizeDate(str("issueDate"), today)
    if (issue) out.issueDate = issue
    const due = normalizeDate(str("dueDate"), today)
    if (due) out.dueDate = due
    const tax = clampNumber(raw.taxPercent)
    if (tax !== undefined) out.taxPercent = tax
    const disc = clampNumber(raw.discountPercent)
    if (disc !== undefined) out.discountPercent = disc
    if (str("notes")) out.notes = str("notes")
    if (str("clientMessage")) out.clientMessage = str("clientMessage")
    if (str("dueReminderMessage")) out.dueReminderMessage = str("dueReminderMessage")
    if (str("overdueReminderMessage"))
        out.overdueReminderMessage = str("overdueReminderMessage")
    if (Array.isArray(raw.lineItems)) {
        const items = raw.lineItems
            .map((item) => {
                if (!item || typeof item !== "object") return null
                const description =
                    (typeof item.description === "string" && item.description.trim()) ||
                    (typeof item.name === "string" && item.name.trim()) ||
                    undefined
                const quantity = clampNumber(item.quantity)
                const unitPrice =
                    clampNumber(item.unitPrice) ??
                    clampNumber(item.unit_price) ??
                    clampNumber(item.rate) ??
                    clampNumber(item.price)
                if (!description && unitPrice === undefined) return null
                return {
                    description: description || "Professional services",
                    quantity: quantity !== undefined ? quantity : 1,
                    unitPrice: unitPrice !== undefined ? unitPrice : 0,
                }
            })
            .filter(Boolean)
        if (items.length) out.lineItems = items
    }
    return out
}
function extractJson(text) {
    if (!text || typeof text !== "string") return null
    try {
        return JSON.parse(text)
    } catch (_) {}
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
    if (fenced) {
        try {
            return JSON.parse(fenced[1].trim())
        } catch (_) {}
    }
    const obj = text.match(/\{[\s\S]*\}/)
    if (obj) {
        try {
            return JSON.parse(obj[0])
        } catch (_) {}
    }
    return null
}
function setCors(res) {
    res.setHeader("Access-Control-Allow-Origin", "*")
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS")
    res.setHeader("Access-Control-Allow-Headers", "Content-Type")
}
async function callGeminiWithRetry(apiKey, body, maxRetries = 2) {
    let lastError
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            const resp = await fetch(GEMINI_URL(apiKey), {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            })
            if (resp.status === 429 || resp.status >= 500) {
                lastError = new Error(`Gemini HTTP ${resp.status}`)
                if (attempt < maxRetries) {
                    const backoff = [800, 2000][Math.min(attempt, 1)]
                    await new Promise((r) => setTimeout(r, backoff))
                    continue
                }
                // Bubble the status up so the client can show rate-limit messaging.
                const err = new Error(`Gemini HTTP ${resp.status}`)
                err.status = resp.status
                throw err
            }
            if (!resp.ok) {
                const err = new Error(`Gemini HTTP ${resp.status}`)
                err.status = resp.status
                throw err
            }
            return await resp.json()
        } catch (error) {
            lastError = error
            if (attempt >= maxRetries) throw error
            await new Promise((r) => setTimeout(r, [800, 2000][Math.min(attempt, 1)]))
        }
    }
    throw lastError || new Error("Gemini request failed")
}
export default async function handler(req, res) {
    setCors(res)
    if (req.method === "OPTIONS") {
        res.status(204).end()
        return
    }
    if (req.method !== "POST") {
        res.status(405).json({ error: "Method not allowed" })
        return
    }
    const apiKey = process.env.GEMINI_API_KEY
    if (!apiKey) {
        res.status(500).json({ error: "Server is missing GEMINI_API_KEY" })
        return
    }
    let payload = req.body
    if (typeof payload === "string") {
        try {
            payload = JSON.parse(payload)
        } catch (_) {
            payload = {}
        }
    }
    const text = (payload && payload.text) || ""
    const currentInvoice = (payload && payload.currentInvoice) || null
    if (!text || typeof text !== "string" || !text.trim()) {
        res.status(400).json({ error: "Missing 'text' in request body" })
        return
    }
    const today = new Date()
    const todayIso = today.toISOString().slice(0, 10)
    const geminiBody = {
        contents: [
            {
                role: "user",
                parts: [{ text: buildPrompt(text, currentInvoice, todayIso) }],
            },
        ],
        generationConfig: {
            temperature: 0.2,
            responseMimeType: "application/json",
            responseSchema: RESPONSE_SCHEMA,
        },
    }
    try {
        const data = await callGeminiWithRetry(apiKey, geminiBody, 2)
        const rawText =
            data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || ""
        const parsed = extractJson(rawText)
        const invoice = sanitizeInvoice(parsed, today)
        if (!invoice || Object.keys(invoice).length === 0) {
            res.status(422).json({ error: "Could not extract invoice fields" })
            return
        }
        res.status(200).json({ invoice })
    } catch (error) {
        const status = error && error.status ? error.status : 502
        // Preserve 429 so the component shows its rate-limit fallback messaging.
        res.status(status === 429 ? 429 : status).json({
            error: error?.message || "AI parsing failed",
        })
    }
}
