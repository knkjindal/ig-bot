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

// --- 1. WEBHOOK VERIFICATION ---
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

// --- 2. WEBHOOK GATEKEEPER ---
app.post('/webhook', async (req, res) => {
    let body = req.body;

    if (body.object === 'instagram') {
        for (let entry of body.entry) {
            let webhook_event = entry.messaging[0];
            let sender_id = webhook_event.sender.id;
            
            // GATEKEEPER: Get user state before replying
            let userData = await getUserData(sender_id);
            
            // Pass the data to the brain
            await handleMessage(sender_id, webhook_event, userData);
        }
        res.status(200).send('EVENT_RECEIVED');
    } else {
        res.sendStatus(404);
    }
});

// --- 3. THE BRAIN (STATE MACHINE) ---
async function handleMessage(sender_id, webhook_event, userData) {
    let currentState = userData.bot_state || 'IDLE';
    let tempData = userData.temp_order_data || {};

    // Check if they clicked a Quick Reply button first
    if (webhook_event.message && webhook_event.message.quick_reply) {
        let payload = webhook_event.message.quick_reply.payload;
        
        if (payload === "PLACE_ORDER") {
            await updateUserState(sender_id, 'AWAITING_PRODUCT', tempData);
            return callSendAPI(sender_id, "Great! Please use the share icon below the Instagram post of the product you want to buy, and send it directly into this chat.");
        }
        if (payload === "TRIGGER_HUMAN_TAKEOVER") {
            // We will build the time-based snooze here next!
            return callSendAPI(sender_id, "I've paused my automated replies. A human agent will jump in here shortly!");
        }
        if (payload === "CHECK_CODE") {
            return callSendAPI(sender_id, "Our current active promo code is SAVE20!");
        }
    }

    let message_text = webhook_event.message ? webhook_event.message.text : null;

    // Route conversation based on their current state
    switch (currentState) {
        case 'AWAITING_PRODUCT':
            if (webhook_event.message && webhook_event.message.attachments && webhook_event.message.attachments[0].type === 'share') {
                let sharedUrl = webhook_event.message.attachments[0].payload.url;
                
                // Clean the URL to remove tracking parameters (everything after '?')
                let cleanUrl = sharedUrl.split('?')[0];

                // Query Supabase
                let { data: product } = await supabase
                    .from('products')
                    .select('*')
                    .ilike('insta_post_url', `%${cleanUrl}%`)
                    .single();

                if (product) {
                    tempData.product_id = product.id;
                    tempData.product_name = product.product_name;
                    tempData.price = product.price;

                    await updateUserState(sender_id, 'AWAITING_NAME', tempData);
                    return callSendAPI(sender_id, `Ah, the ${product.product_name}! It is priced at ₹${product.price}. To start the order, what is your full name?`);
                } else {
                    return callSendAPI(sender_id, "I couldn't find that exact product in our system. Are you sure that is the right post?");
                }
            } else {
                return callSendAPI(sender_id, "Please use the airplane/share icon on the post to send it directly to me!");
            }

        case 'AWAITING_NAME':
            if (message_text) {
                tempData.customer_name = message_text;
                await updateUserState(sender_id, 'AWAITING_ADDRESS', tempData);
                return callSendAPI(sender_id, `Thanks, ${message_text}! And what is your full delivery address?`);
            }
            break;

        case 'AWAITING_ADDRESS':
            if (message_text) {
                tempData.customer_address = message_text;
                
                // Finalize order
                await finalizeOrderInDatabase(sender_id, tempData);
                
                // Reset state
                await updateUserState(sender_id, 'IDLE', {});
                return callSendAPI(sender_id, "Perfect! Your order has been logged. Our team will review it and get back to you shortly to arrange payment.");
            }
            break;

        case 'IDLE':
        default:
            let welcomeText = "Hi there! 👋 I am the digital assistant. How can I help you today?";
            let quickReplies = [
                { content_type: "text", title: "Discount Code 🎟️", payload: "CHECK_CODE" },
                { content_type: "text", title: "Place an Order 📦", payload: "PLACE_ORDER" },
                { content_type: "text", title: "Talk to a Person 🙋‍♂️", payload: "TRIGGER_HUMAN_TAKEOVER" }
            ];
            return callSendAPI(sender_id, welcomeText, quickReplies);
    }
}

// --- 4. THE VOICE ---
async function callSendAPI(sender_id, text, quickReplies = null) {
    const url = `https://graph.facebook.com/v18.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`;
    
    let payload = {
        recipient: { id: sender_id },
        message: { text: text }
    };

    if (quickReplies) {
        payload.message.quick_replies = quickReplies;
    }

    try {
        await axios.post(url, payload);
    } catch (error) {
        console.error("❌ Error sending message:", error.response ? error.response.data : error.message);
    }
}

// --- 5. SUPABASE HELPERS ---
async function getUserData(sender_id) {
    let { data } = await supabase
        .from('customers')
        .select('*')
        .eq('instagram_user_id', sender_id)
        .single();

    if (!data) {
        const { data: newUser } = await supabase
            .from('customers')
            .insert([{ instagram_user_id: sender_id, bot_state: 'IDLE', temp_order_data: {} }])
            .select()
            .single();
        return newUser;
    }
    return data;
}

async function updateUserState(sender_id, newState, tempData = {}) {
    await supabase
        .from('customers')
        .update({ bot_state: newState, temp_order_data: tempData })
        .eq('instagram_user_id', sender_id);
}

async function finalizeOrderInDatabase(sender_id, finalData) {
    try {
        await supabase
            .from('pending_orders')
            .insert([{ 
                instagram_user_id: sender_id, 
                original_message: `Order for ${finalData.product_name}`,
                status: "Pending Verification",
                // Storing the JSON data cleanly for your future admin app
                order_details: finalData 
            }]);
        console.log(`✅ Order finalized for ${finalData.customer_name}`);
    } catch (error) {
        console.error("❌ Error finalizing order:", error);
    }
}

app.listen(PORT, () => {
  console.log(`🔥 Server running on port ${PORT}`);
});