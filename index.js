import express from "express"
import { paymentMiddleware } from "x402-express"
import sqlite3 from "sqlite3"
import crypto from "crypto"
import dotenv from "dotenv"
import path from 'path'
import fs from 'fs'
import pg from 'pg'

dotenv.config()

// Ensure data directory exists
const dataDir = path.dirname(process.env.DB_PATH || "./data/wall.db")
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true })
}

// Constants
const DB_PATH = process.env.DB_PATH || "./data/wall.db"
const PORT = process.env.PORT || 4021

// Initialize Express app
const app = express()
app.use(express.json())
app.use(express.urlencoded({ extended: true }))
app.use(express.static(path.join(process.cwd(),'public')))
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
  res.header('Cross-Origin-Embedder-Policy', 'require-corp');
  next();
});



const decodeX402Header = (content)=>{
  const decodedJsonString = atob(content) // Decodes from Base64
  const transactionData = JSON.parse(decodedJsonString)
  return transactionData
}

// Request logging middleware
app.use((req, res, next) => {
  console.log(req.method + " "+ req.path, {
    body: JSON.stringify(req.body),
    query: req.query,
    payment: req.headers['x-payment']
  })
  if(!!req.headers['x-payment']){
    req.paymentHeader = decodeX402Header(req.headers['x-payment'])
    console.log(req.paymentHeader)
  }
  next()
})


let pgclient = undefined
let sqlitedb = undefined

if(process.env.USE_PG){

const config = {
    user: process.env.PG_USER,
    password: process.env.PG_PASSWORD,
    host: process.env.PG_HOST,
    port: process.env.PG_PORT,
    database: process.env.PG_DB,
    ssl: {
        rejectUnauthorized: true,
        ca: fs.readFileSync("./etc/secrets/ca.pem")
    },
};

pgclient = new pg.Client(config);
pgclient.connect(function (err) {
    if (err) {
        console.error("Error connecting to PostgreSQL:", err);
        throw err;
    }
    
    console.log("Connected to PostgreSQL database");
    
    // Create messages table
    const createMessagesTable = `
      CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        message TEXT,
        author TEXT,
        payer TEXT,
        timestamp TIMESTAMP DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
      )
    `;
    
    pgclient.query(createMessagesTable, (err) => {
      if (err) {
        console.error("Error creating messages table:", err.message);
        console.error("Table creation query:", createMessagesTable);
      } else {
        console.log("Messages table created or already exists");
      }
    });
    
    // Create pending_messages table
    const createPendingMessagesTable = `
      CREATE TABLE IF NOT EXISTS pending_messages (
        pending_id TEXT PRIMARY KEY,
        message TEXT,
        author TEXT
      )
    `;
    
    pgclient.query(createPendingMessagesTable, (err) => {
      if (err) {
        console.error("Error creating pending_messages table:", err.message);
        console.error("Table creation query:", createPendingMessagesTable);
      } else {
        console.log("Pending messages table created or already exists");
      }
    });
})

}else{ // use SQLITE
 // Database initialization
// Initialize database
sqlitedb = new sqlite3.Database(DB_PATH)
// Create messages table
sqlitedb.run(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message TEXT,
    author TEXT,
    payer TEXT,
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
sqlitedb.run(`
  CREATE TABLE IF NOT EXISTS pending_messages (
    pending_id TEXT PRIMARY KEY,
    message TEXT,
    author TEXT
  )`, (err) => {
  if (err) {
    console.error("Error creating pending_messages table:", err);
  } else {
    console.log("Pending messages table created or already exists");
  }
});
}


function escapeHtml(text) {
    if (typeof text !== 'string') return '';
    
    const escapeMap = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#x27;',
        '/': '&#x2F;'
    };
    
    return text.replace(/[&<>"'/]/g, char => escapeMap[char]);
}

// Middleware section

/**
 * Middleware: storing message before x402 paywall to POST /wall
 * Also handles retrieval of pending messages for GET /wall-paid
 */
app.use((req, res, next) => {
  
  // detect used pendingId
  if(req.method == "GET" && req.path === "/wall-paid" && req.query?.pendingId){
    if(process.env.USE_PG){
      
      pgclient.query('SELECT message, author FROM pending_messages WHERE pending_id = $1 LIMIT 1', [req.query.pendingId], (err, result) => {
        if (err || result.rows.length === 0) {
          console.error("Pending message not found for id:", req.query.pendingId)
          return res.redirect("/wall")
        }
        // If we found the row, we should continue to let the next middleware/route handle it
        next()
      })
      // Return to prevent further execution in this middleware
      return
    }else{
      sqlitedb.get(`SELECT message, author FROM pending_messages WHERE pending_id = ?`, [req.query.pendingId],
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
    author = author.substr(0,100)
    let message = req.body.message.substr(0,1024)
    message = escapeHtml(message)
    if(process.env.USE_PG){
      pgclient.query(
        `INSERT INTO pending_messages (pending_id, message, author) VALUES ($1, $2, $3)`, [pendingId, message, author],
        (err) => {
          if (err) {
            console.error("Error saving pending message:", err)
            return res.status(500).send("Error saving message")
          }
          // Redirect to the paywalled GET route with pendingId
          res.redirect(`/wall-paid?pendingId=${pendingId}`)
        }
      )
    }else{
      sqlitedb.run(
        `INSERT INTO pending_messages (pending_id, message, author) VALUES (?, ?, ?)`, [pendingId, message, author],
        (err) => {
          if (err) {
            console.error("Error saving pending message:", err)
            return res.status(500).send("Error saving message")
          }
          // Redirect to the paywalled GET route with pendingId
          res.redirect(`/wall-paid?pendingId=${pendingId}`)
        }
      )
    }
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
  if(process.env.USE_PG){
    pgclient.query('SELECT message, author FROM pending_messages WHERE pending_id = $1', [pendingId], (err, result) => {
      if (err || result.rows.length === 0) {
        console.error("Pending message not found for id:", pendingId)
        return res.redirect("/wall")
      }
      const row = result.rows[0];
      // Save the message to the main table
      pgclient.query(
        `INSERT INTO messages (message, author, payer) VALUES ($1, $2, $3) RETURNING id`, [row.message, row.author, req.paymentHeader.payload.authorization.from],
        (err, insertResult) => {
          if (err) {
            console.error("Error saving message:", err)
            return res.status(500).send("Error saving message")
          }
          
          // Clean up pending message
          pgclient.query(`DELETE FROM pending_messages WHERE pending_id = $1`, [pendingId], (deleteErr) => {
            if (deleteErr) {
              console.error("Error deleting pending message:", deleteErr)
            }
            
            // this.lastID is the last inserted row id
            console.log("Message SAVED ID:", insertResult.rows[0].id)
            
            // Redirect after all database operations are complete
            res.redirect(301, "/wall")
          })
        }
      )
    })
  }
  else{
  sqlitedb.get(`SELECT message, author FROM pending_messages WHERE pending_id = ?`, [pendingId],
    (err, row) => {
      if (err || !row) {
        console.error("Pending message not found for id:", pendingId)
        return res.redirect("/wall")
      }
      // Save the message to the main table
      sqlitedb.run(
        `INSERT INTO messages (message, author, payer) VALUES (?,?,?)`,[row.message, row.author, req.paymentHeader.payload.authorization.from],
        function (err) {
          if (err) {
            console.error("Error saving message:", err)
            return res.status(500).send("Error saving message")
          }
          
          // Clean up pending message
          sqlitedb.run(`DELETE FROM pending_messages WHERE pending_id = ?`, [pendingId], (deleteErr) => {
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
}
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
app.get(["/","/wall"], (req, res) => {
  if(process.env.USE_PG){
    pgclient.query(`SELECT id,message,to_char(timestamp AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS UTC') as timestamp_utc,author,payer FROM messages ORDER BY timestamp_utc DESC`, (err, result) => {
      if (err) return res.status(500).send("Error retrieving messages")
      const rows = result.rows;
      const html = generateWallHTML(rows)
      res.send(html)
    })
  }else{
    sqlitedb.all(`SELECT id,message,timestamp AS timestamp_utc,author,payer FROM messages ORDER BY timestamp DESC`, [], (err, rows) => {
      if (err) return res.status(500).send("Error retrieving messages")
      const html = generateWallHTML(rows)
      res.send(html)
    })
  }
})

/**
 * DELETE /wall/:id route handler
 * Deletes a message by its ID if the correct admin password is provided
 */
app.delete("/wall/:id", (req, res) => {
  const messageId = req.params.id;
  const adminPassword = req.body.adminPassword || req.headers['admin-password'];
  
  // Verify admin password
  if (!adminPassword || adminPassword !== process.env.ADMIN_PASSWORD) {
    return res.status(401).send("Unauthorized: Invalid admin password");
  }
  
  // Delete the message with the specified ID
  if(process.env.USE_PG){
    pgclient.query('DELETE FROM messages WHERE id = $1', [messageId], (err, result) => {
      if (err) {
        console.error("Error deleting message:", err);
        return res.status(500).send("Error deleting message");
      }
      
      // Check if a row was actually deleted
      if (result.rowCount === 0) {
        return res.status(404).send("Message not found");
      }
      
      console.log(`Message ${messageId} deleted successfully`);
      res.status(200).send("Message deleted successfully");
    });
  }else{
    sqlitedb.run(`DELETE FROM messages WHERE id = ?`, [messageId], function(err) {
      if (err) {
        console.error("Error deleting message:", err);
        return res.status(500).send("Error deleting message");
      }
      
      // Check if a row was actually deleted
      if (this.changes === 0) {
        return res.status(404).send("Message not found");
      }
      
      console.log(`Message ${messageId} deleted successfully`);
      res.status(200).send("Message deleted successfully");
    });
  }
})


/**
 * Generate HTML for the message wall page
 * @param {Array} messages - Array of message objects
 * @returns {string} HTML string for the message wall
 */
function generateWallHTML(messages) {
  let html = "<html><head>"
  //html += '<link rel="stylesheet" href="https://cdn.simplecss.org/simple.min.css">'
  html += '<link rel="stylesheet" href="./wall.css">'
  html += "<title>Message Wall x402 example</title></head><body>"
  html += "<div class='messages-header'><h2>x402 MESSAGE WALL</h2>"
  html += `<p>Leave a public message for $0.001 USDC (BASE Sepolia) using the <a href="https://www.x402.org/">x402 standard</a></div>`
  html += '<div class="post-form">'
  html += "<h2>Post a Message</h2>"
  html += '<form action="/wall" method="POST">'
  html += '<div id="form-group"><textarea maxlength="1024" name="message" id="message" placeholder="Enter your message" required></textarea></div>'
  html += '<div id="form-group"><input maxlength="100" type="text" name="author" placeholder="your name"></div>'
  html += '<div id="form-group"><button type="submit" class="button">POST<span class="cost">($0.001 USDC)</span></button></div>'
  html += "</form></div>"

  html += "<div class='messages-header'><h2>MESSAGES</h2></div>"
  html += '<div class="messages-list">'
  messages.forEach((row) => {
    html += `<div class="message-card"><span class="message-id">#${row.id}</span><p class="message-content">${row.message}</p>`
    html += `<div class="divider"></div><p class="message-author">by ${row.author}</p><p class="message-payer">[${row.payer}]</p>`
    html += `<p class="message-timestamp">(${row.timestamp_utc})</p></div>`
  })
  html +="</div>"
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
    if(process.env.USE_PG){
      pgclient.end((err) => {
        if (err) {
          console.error('Error closing PostgreSQL connection:', err)
        } else {
          console.debug('PostgreSQL connection closed')
        }
        console.debug('HTTP server closed')
        process.exit(0)
      })
    }else{
      sqlitedb.close((err) => {
        if (err) {
          console.error('Error closing database:', err)
        } else {
          console.debug('Database closed')
        }
        console.debug('HTTP server closed')
        process.exit(0)
      })
    }
  })
  
  // Force shutdown if graceful shutdown takes too long
  setTimeout(() => {
    console.error('Forcing shutdown due to timeout')
    process.exit(1)
  }, 10000)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
