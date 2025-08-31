import express from "express"
import { paymentMiddleware } from "x402-express"
import sqlite3 from "sqlite3"
import crypto from "crypto"
import dotenv from "dotenv"

// Load environment variables
dotenv.config()

// Constants
const DB_PATH = process.env.DB_PATH || "./wall.db"
const PORT = process.env.PORT || 4021

// Initialize Express app
const app = express()
app.use(express.json())
app.use(express.urlencoded({ extended: true }))

// Initialize database
const db = new sqlite3.Database(DB_PATH)

// Request logging middleware
app.use((req, res, next) => {
  console.log(req.method + " "+ req.path, {
    body: JSON.stringify(req.body),
    query: req.query,
    payment: !!req.headers['x-payment']
  })
  next()
})

// Database initialization
// Create messages table
db.run(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message TEXT,
    author TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`, (err) => {
  if (err) {
    console.error("Error creating messages table:", err);
  } else {
    console.log("Messages table created or already exists");
  }
});

// Create pending_messages table
db.run(`
  CREATE TABLE IF NOT EXISTS pending_messages (
    pending_id TEXT PRIMARY KEY,
    message TEXT,
    author TEXT
  )
`, (err) => {
  if (err) {
    console.error("Error creating pending_messages table:", err);
  } else {
    console.log("Pending messages table created or already exists");
  }
});

// Middleware section

/**
 * Middleware: storing message before x402 paywall to POST /wall
 * Also handles retrieval of pending messages for GET /wall-paid
 */
app.use((req, res, next) => {
  
  // detect used pendingId
  if(req.method == "GET" && req.path === "/wall-paid" && req.query?.pendingId){
    db.get(`SELECT message, author FROM pending_messages WHERE pending_id = ?`, [req.query.pendingId],
    (err, row) => {
      if (err || !row) {
        console.error("Pending message not found for id:", req.query.pendingId)
        //return res.status(400).send("Pending message not found")
        return res.redirect("/wall")
      }
      // If we found the row, we should continue to let the next middleware/route handle it
      next()
    })
    // Return to prevent further execution in this middleware
    return
  }
  
  if (req.method === "POST" && req.path === "/wall" && req.body?.message) {
    // Input validation
    if (typeof req.body.message !== 'string' || req.body.message.trim().length === 0) {
      return res.status(400).send("Message is required and must be a non-empty string")
    }
    
    if (req.body.author && typeof req.body.author !== 'string') {
      return res.status(400).send("Author must be a string")
    }
    const pendingId = crypto.randomUUID()
    console.log("storing message:", req.body.message,"from", req.body?.author , "with id", pendingId)
    let author = req.body?.author || "anon"
    
    db.run(
      `INSERT INTO pending_messages (pending_id, message, author) VALUES (?, ?, ?)`, [pendingId, req.body.message, author],
      (err) => {
        if (err) {
          console.error("Error saving pending message:", err)
          return res.status(500).send("Error saving message")
        }
        // Redirect to the paywalled GET route with pendingId
        res.redirect(`/wall-paid?pendingId=${pendingId}`)
      }
    )
  } else {
    next()
  }
})

// Paywall middleware configuration
/**
 * Paywall middleware configuration
 * Sets up payment requirements for posting messages and accessing paid content
 */
try {
  app.use(
    paymentMiddleware(
      process.env.SELLER_ADDRESS,
      {
        "POST /wall": {
          price: process.env.MESSAGE_PRICE,
          network: process.env.NETWORK
        },
        "GET /wall-paid": {
          price: process.env.MESSAGE_PRICE,
          network: process.env.NETWORK
        }
      },
      {
        url: process.env.FACILITATOR_URL
      }
    )
  )
} catch (error) {
  console.error("Error initializing payment middleware:", error);
}

// Route handlers

/**
 * Handle the paywalled route that finalizes the message
 * Retrieves pending message and moves it to the main messages table
 */
app.get("/wall-paid", (req, res) => {
  console.log("/wall-paid GET hit after payment, query:", req.query)

  const pendingId = req.query.pendingId
  if (!pendingId) {
    return res.status(400).send("Missing pendingId")
  }

  console.log("Finalizing message pendingId:", pendingId)
  db.get(`SELECT message, author FROM pending_messages WHERE pending_id = ?`, [pendingId],
    (err, row) => {
      if (err || !row) {
        console.error("Pending message not found for id:", pendingId)
        return res.redirect("/wall")
      }
      // Save the message to the main table
      db.run(
        `INSERT INTO messages (message, author) VALUES (?,?)`,[row.message, row.author],
        function (err) {
          if (err) {
            console.error("❌ Error saving message:", err)
            return res.status(500).send("Error saving message")
          }
          
          // Clean up pending message
          db.run(`DELETE FROM pending_messages WHERE pending_id = ?`, [pendingId], (deleteErr) => {
            if (deleteErr) {
              console.error("Error deleting pending message:", deleteErr)
            }
            
            // this.lastID is the last inserted row id
            console.log("Message SAVED ID:", this.lastID)
            
            // Redirect after all database operations are complete
            res.redirect(301, "/wall")
          })
        }
      )
    }
  )
})

/**
 * POST /wall route handler
 * This should normally be blocked by the paywall middleware
 */
app.post("/wall", (req, res) => {
 // middleware should stop this from executing
  console.log("!!!!! POST /wall reached unexpectedly")
  res.status(400).send("Unexpected request")
})

/**
 * GET /wall route handler
 * Displays the main message wall page with all posted messages
 */
app.get("/wall", (req, res) => {
  db.all(`SELECT message,timestamp,author FROM messages ORDER BY timestamp DESC`, [], (err, rows) => {
    if (err) return res.status(500).send("Error retrieving messages")
    const html = generateWallHTML(rows)
    res.send(html)
  })
})

/**
 * Generate HTML for the message wall page
 * @param {Array} messages - Array of message objects
 * @returns {string} HTML string for the message wall
 */
function generateWallHTML(messages) {
  let html = "<html><head><title>Message Wall x402 example</title></head><body>"
  html += "<h1>Post a Message</h1>"
  html += '<form action="/wall" method="POST">'
  html += '<input type="text" name="message" placeholder="Enter your message" required>'
  html += '<input type="text" name="author" placeholder="anon">'
  html += '<button type="submit">POST ($0.001 USDC)</button>'
  html += "</form>"
  html += "<h1>MESSAGE WALL</h1><ul>"
  
  messages.forEach((row) => {
    html += `<li>${row.message} (${row.timestamp}) by ${row.author}</li>`
  })
  
  html += "</ul>"
  html += `<script> window.onload = (e)=>{console.log("ONLOAD"); history.replaceState(null, '', '/wall')}</script>`
  html += "</body></html>"
  
  return html
}

// Server startup and shutdown

/**
 * Start the HTTP server
 */
// Handle uncaught exceptions and unhandled promise rejections
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

// Log when the process is about to exit
process.on('exit', (code) => {
  console.log(`Process exiting with code: ${code}`);
});

const server = app.listen(PORT, () => {
  console.log(`Server listening at http://localhost:${PORT}`)
})

// Log that the server setup is complete
console.log("Server setup complete");

/**
 * Gracefully shutdown the server and database connection
 */
const shutdown = () => {
  console.debug('SIGTERM/SIGINT signal received: closing HTTP server')
  server.close(() => {
    db.close();
    console.debug('HTTP server closed')
  })
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
