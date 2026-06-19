export default async function handler(req, res) {
  // Allow calls from your Framer site
  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "Content-Type")
  if (req.method === "OPTIONS") {
    return res.status(200).end()
  }
  try {
    const text =
      req.body?.text ||
      req.query?.text ||
      "Create invoice for Austin for Framer website cost 750 USD"
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  text: `Extract invoice information from the text below.
Return ONLY valid JSON in this exact format, with no commentary:
{
  "clientName": null,
  "currency": null,
  "lineItems": [
    { "description": "", "quantity": 1, "unitPrice": 0 }
  ]
}
Text:
${text}`,
                },
              ],
            },
          ],
        }),
      }
    )
    // Read the body ONCE
    const data = await response.json()
    if (!response.ok) {
      return res.status(response.status).json({
        error: "Gemini request failed",
        details: data,
      })
    }
    // Gemini wraps the answer in candidates -> content -> parts -> text
    const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? ""
    // Remove ```json … ``` fences if the model added them
    const cleaned = raw.replace(/```json|```/g, "").trim()
    let invoice
    try {
      invoice = JSON.parse(cleaned)
    } catch {
      return res.status(502).json({
        error: "Model did not return valid JSON",
        raw,
      })
    }
    // Normalize so the frontend always gets a predictable shape
    return res.status(200).json({
      clientName: invoice.clientName ?? "",
      currency: invoice.currency ?? "USD",
      lineItems: Array.isArray(invoice.lineItems) ? invoice.lineItems : [],
    })
  } catch (error) {
    return res.status(500).json({ error: error.message })
  }
}
