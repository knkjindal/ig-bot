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

function handleMessage(sender_id, message_text) {
    let text = message_text.toLowerCase();
    let responseText = "";

    if (text.includes("code")) {
        responseText = "Here is our latest promo code: SAVE20!";
        callSendAPI(sender_id, responseText);
        
    } else if (text.includes("budget")) {
        responseText = "Our custom projects usually range from $50 to $500. What did you have in mind?";
        callSendAPI(sender_id, responseText);
        
    } else if (text.includes("order")) {
        responseText = "Awesome! I have notified our team to get your order started. What exactly would you like?";
        callSendAPI(sender_id, responseText);
        
        // TRIGGER THE SUPABASE SAVE!
        saveOrderToDatabase(sender_id, message_text);
        
    } else {
        responseText = "Hi! Are you asking about a discount 'code', our 'budget' options, or placing an 'order'?";
        callSendAPI(sender_id, responseText);
    }
}

async function callSendAPI(sender_id, responseText) {
    const url = `https://graph.facebook.com/v18.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`;
    const payload = { recipient: { id: sender_id }, message: { text: responseText } };

    try {
        await axios.post(url, payload);
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