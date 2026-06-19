export default async function handler(req, res) {
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
  "currency": null,
  "lineItems": [
    {
      "description": "",
      "quantity": 1,
      "unitPrice": 0
    }
  ]
}

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

    const invoice = await response.json()

    setClient(invoice.clientName)
    
    setCurrency(invoice.currency)
    
    setLineItems(invoice.lineItems)
  } catch (error) {
    res.status(500).json({
      error: error.message,
    })
  }
}
