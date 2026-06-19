export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "Content-Type")

  // Handle preflight requests
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
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  text: `
Extract invoice information from the text below.

Return ONLY valid JSON.

Format:

{
  "clientName": null,
  "clientEmail": null,
  "invoiceNumber": null,
  "currency": null,
  "dueDate": null,
  "taxPercent": null,
  "discountPercent": null,
  "lineItems": [
    {
      "description": "",
      "quantity": 1,
      "unitPrice": 0
    }
  ]
}

Rules:
- Do not invent information.
- Use null when unknown.
- Extract email if present.
- Extract tax percentage if present.
- Extract discount percentage if present.
- Extract due date if present.
- Return JSON only.

Text:
${text}
                  `,
                },
              ],
            },
          ],
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

    const raw =
      data?.candidates?.[0]?.content?.parts?.[0]?.text || ""

    const cleaned = raw
      .replace(/```json/g, "")
      .replace(/```/g, "")
      .trim()

    let invoice

    try {
      invoice = JSON.parse(cleaned)
    } catch (err) {
      return res.status(502).json({
        error: "Model did not return valid JSON",
        raw,
      })
    }

    return res.status(200).json({
      clientName: invoice.clientName ?? "",
      clientEmail: invoice.clientEmail ?? "",
      invoiceNumber: invoice.invoiceNumber ?? "",
      currency: invoice.currency ?? "USD",
      dueDate: invoice.dueDate ?? "",
      taxPercent:
        typeof invoice.taxPercent === "number"
          ? invoice.taxPercent
          : 0,
      discountPercent:
        typeof invoice.discountPercent === "number"
          ? invoice.discountPercent
          : 0,
      lineItems: Array.isArray(invoice.lineItems)
        ? invoice.lineItems.map((item) => ({
            description: item.description || "",
            quantity:
              typeof item.quantity === "number"
                ? item.quantity
                : 1,
            unitPrice:
              typeof item.unitPrice === "number"
                ? item.unitPrice
                : 0,
          }))
        : [],
    })
  } catch (error) {
    return res.status(500).json({
      error: error.message || "Internal Server Error",
    })
  }
}
