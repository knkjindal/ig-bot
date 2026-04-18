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
// Inside your webhook POST route, you first check the user's state in Supabase:
// let userState = await getUserStateFromSupabase(sender_id);

async function handleMessage(sender_id, webhook_event, userState) {
    // 1. Check if they clicked a button
    if (webhook_event.message.quick_reply) {
        let payload = webhook_event.message.quick_reply.payload;
        
        if (payload === "PLACE_ORDER") {
            // Change DB state to 'AWAITING_PRODUCT'
            await updateUserState(sender_id, 'AWAITING_PRODUCT');
            return callSendAPI(sender_id, "Great! Please share the Instagram post of the product you want to buy into this chat.");
        }
    }

    // 2. Handle the conversation based on their current "State"
    switch (userState) {
        case 'AWAITING_PRODUCT':
            // Check if they shared a post
            if (webhook_event.message.attachments && webhook_event.message.attachments[0].type === 'share') {
                let sharedUrl = webhook_event.message.attachments[0].payload.url;
                
                // Query Supabase to find the product matching this URL
                // let product = await findProduct(sharedUrl);
                
                // Update DB state to 'AWAITING_NAME'
                await updateUserState(sender_id, 'AWAITING_NAME');
                return callSendAPI(sender_id, `Ah! The [Product Name] is ₹[Price]. I'd love to help you order it. What is your full name?`);
            } else {
                return callSendAPI(sender_id, "Please use the share button on the post to send the product here so I can check the price!");
            }

        case 'AWAITING_NAME':
            let customerName = webhook_event.message.text;
            // Save name to temp_order_data in Supabase
            await updateUserState(sender_id, 'AWAITING_ADDRESS');
            return callSendAPI(sender_id, `Thanks, ${customerName}. And what is your delivery address?`);

        case 'AWAITING_ADDRESS':
            let customerAddress = webhook_event.message.text;
            // Save address, move the final order to the pending_orders table, and reset state
            await updateUserState(sender_id, 'IDLE');
            return callSendAPI(sender_id, "Perfect! Your order is placed. Our team will verify it shortly.");

        default:
            // The IDLE state (Standard Keyword Checks / Welcome Message)
            handleIdleConversation(sender_id, webhook_event.message.text);
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