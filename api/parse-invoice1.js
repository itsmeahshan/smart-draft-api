export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "Content-Type")

  if (req.method === "OPTIONS") {
    return res.status(200).end()
  }

  try {
    const body = req.body || {}
    const text =
      body.text ||
      req.query?.text ||
      "Create invoice for Austin for Framer website cost 750 USD"

    const currentInvoice = body.currentInvoice || null
    const today = new Date()
    const todayIso = today.toISOString().slice(0, 10)

    const contextBlock = currentInvoice
      ? `\nCurrent invoice state (use as context — only override fields the new text clearly changes):\n${JSON.stringify(currentInvoice, null, 2)}\n`
      : ""

    const prompt = `You are an invoice parsing engine. Extract invoice information from the text below.
Today's date is ${todayIso}. Resolve ALL relative dates (e.g. "net 30", "due next Friday", "in 2 weeks", "tomorrow", "next Monday") into absolute ISO yyyy-mm-dd strings relative to today.

Return ONLY valid JSON matching this exact format:
{
  "fromName": null,
  "fromEmail": null,
  "clientName": null,
  "clientEmail": null,
  "invoiceNumber": null,
  "currency": null,
  "issueDate": null,
  "dueDate": null,
  "taxPercent": null,
  "discountPercent": null,
  "notes": null,
  "clientMessage": null,
  "dueReminderMessage": null,
  "overdueReminderMessage": null,
  "lineItems": [
    {
      "description": "",
      "quantity": 1,
      "unitPrice": 0
    }
  ]
}

Rules:
- Do NOT invent information. Use null when unknown.
- currency MUST be one of: USD, EUR, GBP, INR, AUD, CAD, JPY. Detect from symbols (₹=INR, $=USD, €=EUR, £=GBP, ¥=JPY) or words.
- issueDate: today's date if not specified (${todayIso}).
- dueDate: resolve relative expressions to ISO yyyy-mm-dd. "net 30" = 30 days from today, "next Friday" = next Friday's date, etc.
- taxPercent and discountPercent are plain numbers (e.g. 18, not "18%").
- Parse amount shorthand: "3k" = 3000, "12,000" = 12000. Strip currency symbols from numbers.
- lineItems: each item has a clean description (no prices or client names in the label), quantity (default 1), unitPrice (number).
- notes: payment terms or instructions if mentioned. If not mentioned, write a standard "Payment due within 14 days. Late payments subject to 1.5% monthly interest."
- clientMessage: a short, friendly, ready-to-send email to the client delivering the invoice. Use their name, invoice number, total amount, and due date if available.
- dueReminderMessage: a polite reminder to send shortly before the due date. Reference invoice number and amount.
- overdueReminderMessage: a firmer but professional follow-up for when the invoice is overdue. Reference invoice number and amount.
- fromName / fromEmail: only extract if explicitly mentioned as the sender/business. Otherwise null.
- invoiceNumber: if mentioned, format as INV-XXXX. Otherwise null.
- Return JSON only. No markdown, no backticks, no explanation.
${contextBlock}
Text:
"""${text}"""`

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.2,
            responseMimeType: "application/json",
          },
        }),
      }
    )

    const data = await response.json()

    if (!response.ok) {
      return res.status(response.status).json({
        error: "Gemini request failed",
        details: data,
      })
    }

    const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text || ""
    const cleaned = raw.replace(/```json/g, "").replace(/```/g, "").trim()

    let parsed
    try {
      parsed = JSON.parse(cleaned)
    } catch (err) {
      return res.status(502).json({ error: "Model did not return valid JSON", raw })
    }

    const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : null)
    const num = (v) => (typeof v === "number" && isFinite(v) ? v : null)

    const ALLOWED_CURRENCIES = ["USD", "EUR", "GBP", "INR", "AUD", "CAD", "JPY"]
    const currency = str(parsed.currency)?.toUpperCase()

    const lineItems = Array.isArray(parsed.lineItems)
      ? parsed.lineItems
          .map((item) => ({
            description: str(item.description) || "Professional services",
            quantity: num(item.quantity) ?? 1,
            unitPrice: num(item.unitPrice) ?? 0,
          }))
          .filter((item) => item.unitPrice > 0 || item.description !== "Professional services")
      : []

    const invoice = {}

    if (str(parsed.fromName)) invoice.fromName = str(parsed.fromName)
    if (str(parsed.fromEmail)) invoice.fromEmail = str(parsed.fromEmail)
    if (str(parsed.clientName)) invoice.clientName = str(parsed.clientName)
    if (str(parsed.clientEmail)) invoice.clientEmail = str(parsed.clientEmail)
    if (str(parsed.invoiceNumber)) invoice.invoiceNumber = str(parsed.invoiceNumber)
    if (currency && ALLOWED_CURRENCIES.includes(currency)) invoice.currency = currency
    if (str(parsed.issueDate)) invoice.issueDate = str(parsed.issueDate)
    if (str(parsed.dueDate)) invoice.dueDate = str(parsed.dueDate)
    if (num(parsed.taxPercent) !== null) invoice.taxPercent = num(parsed.taxPercent)
    if (num(parsed.discountPercent) !== null) invoice.discountPercent = num(parsed.discountPercent)
    if (str(parsed.notes)) invoice.notes = str(parsed.notes)
    if (str(parsed.clientMessage)) invoice.clientMessage = str(parsed.clientMessage)
    if (str(parsed.dueReminderMessage)) invoice.dueReminderMessage = str(parsed.dueReminderMessage)
    if (str(parsed.overdueReminderMessage)) invoice.overdueReminderMessage = str(parsed.overdueReminderMessage)
    if (lineItems.length > 0) invoice.lineItems = lineItems

    return res.status(200).json({ invoice })
  } catch (error) {
    return res.status(500).json({ error: error.message || "Internal Server Error" })
  }
}
