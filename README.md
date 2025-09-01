# x402 public wall

This project shows how to use the [https://x402.org](x402) express middleware to implement a form and pay for submissions.

### Features:
* no client side javascript
* configurable through environment variables
* basic sanitization in posts
* rudimentary moderation through admin password

Sequence diagram of what goes on:

```mermaid
sequenceDiagram
    participant User
    participant Server
    participant PaymentMiddleware

    User->>Server: GET /wall
    Server->>Server: Retrieve all messages from Database
    Server->>User: Display message wall    

    Note left of User: Submits message form

    User->>Server: POST /wall (message)
    Server->>Server: Store message in pending_messages with pendingId
    Note right of Server: Database: Pending Message stored
    Server->>User: Redirect to /wall-paid?pendingId={id}
    
    User->>PaymentMiddleware: GET /wall-paid?pendingId={id}
    PaymentMiddleware->>PaymentMiddleware: Check for x402 payment
    alt No Payment Header
        PaymentMiddleware->>User: Return x402 payment request
    else Valid Payment Header
        PaymentMiddleware->>Server: Forward request
        Server->>Server: Retrieve message by pendingId from Database
        Server->>Server: Move message to messages table in Database
        Server->>Server: Delete message from pending_messages in Database
        Server->>User: Redirect to /wall
    end
```

The key takeaway is that the form post request stores a temporary message that then gets used by the flow with the payment.
The advantage is that no client side javascript is needed, the middleware deals with the x402 paywall, the rest is just a query string for the pending message.