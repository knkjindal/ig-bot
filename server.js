require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");

// --- SUPABASE SETUP ---
const { createClient } = require('@supabase/supabase-js');
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);
// ----------------------

const app = express();
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;

app.get("/", (req, res) => { res.send("🚀 IG Bot Server Running"); });

app.get("/webhook", (req, res) => {
  const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode && token === VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.post('/webhook', (req, res) => {
    let body = req.body;

    if (body.object === 'instagram') {
        body.entry.forEach(function(entry) {
            let webhook_event = entry.messaging[0];
            
            if (webhook_event.message && webhook_event.message.text) {
                let sender_id = webhook_event.sender.id;
                let message_text = webhook_event.message.text;
                
                handleMessage(sender_id, message_text);
            }
        });
        res.status(200).send('EVENT_RECEIVED');
    } else {
        res.sendStatus(404);
    }
});

/**
 * The Brain: Upgraded with Quick Replies
 */
function handleMessage(sender_id, message_text) {
    let text = message_text.toLowerCase();
    
    if (text.includes("code")) {
        callSendAPI(sender_id, "Here is our latest promo code: SAVE20!");
        
    } else if (text.includes("budget")) {
        callSendAPI(sender_id, "Our custom projects usually range from ₹500 to ₹5000. What did you have in mind?");
        
    } else if (text.includes("order")) {
        callSendAPI(sender_id, "Awesome! I have notified our team. What exactly would you like?");
        saveOrderToDatabase(sender_id, message_text);
        
    } else {
        // THE UPGRADED WELCOME/FALLBACK MESSAGE
        let welcomeText = "Hi there! 👋 I am the digital assistant. How can I help you today?";
        
        // Define the buttons we want to show
        let quickReplies = [
            {
                content_type: "text",
                title: "Discount Code 🎟️",
                payload: "CHECK_CODE"
            },
            {
                content_type: "text",
                title: "Place an Order 📦",
                payload: "PLACE_ORDER"
            },
            {
                content_type: "text",
                title: "Talk to a Person 🙋‍♂️",
                payload: "TRIGGER_HUMAN_TAKEOVER"
            }
        ];

        // Send the text along with the buttons
        callSendAPI(sender_id, welcomeText, quickReplies);
    }
}

/**
 * The Voice: Upgraded to support Quick Replies
 */
async function callSendAPI(sender_id, text, quickReplies = null) {
    const url = `https://graph.facebook.com/v18.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`;
    
    // Base payload with just text
    let payload = {
        recipient: { id: sender_id },
        message: { text: text }
    };

    // If buttons were passed into the function, attach them to the payload
    if (quickReplies) {
        payload.message.quick_replies = quickReplies;
    }

    try {
        await axios.post(url, payload);
        console.log("📤 Message sent successfully!");
    } catch (error) {
        console.error("❌ Error sending message:", error.response ? error.response.data : error.message);
    }
}

// --- THE NEW SUPABASE LEDGER FUNCTION ---
async function saveOrderToDatabase(sender_id, message_text) {
    try {
        const { data, error } = await supabase
            .from('pending_orders')
            .insert([
                { 
                    instagram_user_id: sender_id, 
                    original_message: message_text,
                    status: "New Lead"
                }
            ])
            .select(); // .select() ensures it returns the newly created row data back to us

        if (error) {
            throw error;
        }

        console.log(`✅ Order logged in Supabase! Row ID: ${data[0].id}`);
    } catch (error) {
        console.error("❌ Error saving to Supabase:", error.message);
    }
}

app.listen(PORT, () => {
  console.log(`🔥 Server running on port ${PORT}`);
});