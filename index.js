import express from "express";
import { paymentMiddleware } from "x402-express";

const app = express();

app.use(paymentMiddleware(
  "0x372f66fd8BE9221345370f410542Ac86EBEB8af4", // your receiving wallet address 
  {  // Route configurations for protected endpoints
      "GET /weather": {
        // USDC amount in dollars
        price: "$0.001",
        network: "base-sepolia",
      },
    },
  {
    url: "https://x402.org/facilitator", // Facilitator URL for Base Sepolia testnet. 
  }
));

// Implement your route
app.get("/weather", (req, res) => {
  res.send({
    report: {
      weather: "sunny",
      temperature: 70,
    },
  });
});

app.listen(4021, () => {
  console.log(`Server listening at http://localhost:4021`);
});