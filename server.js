const express = require("express");
const cors = require("cors");
require("dotenv").config();
const axios = require("axios");

const app = express();
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  next();
});
app.use(cors());
app.use(express.json({ limit: "50mb" }));

app.post("/generate", async (req, res) => {
  try {
    const { pdfBase64, brandName } = req.body;

    const response = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-sonnet-4-20250514",
        max_tokens: 4000,
        messages: [
          {
            role: "user",
            content: `Convert this PDF into email HTML. Brand: ${brandName}. PDF: ${pdfBase64}`
          }
        ]
      },
      {
        headers: {
          "x-api-key": process.env.CLAUDE_API_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json"
        }
      }
    );

    res.json({
      html: response.data.content[0].text
    });

  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({
  error: "Failed",
  details: err.response?.data || err.message
});
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
