// server.js
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const dotenv = require('dotenv');
const mongoose = require('mongoose');
const { OpenAI } = require('openai');
const twilio = require('twilio');

dotenv.config();

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// MongoDB Interview Schema
const interviewSchema = new mongoose.Schema({
  phoneNumber: String,
  topic: String,
  status: String,
  startTime: Date,
  endTime: Date,
  transcript: [{ 
    role: String, 
    content: String,
    timestamp: Date 
  }]
});

const Interview = mongoose.model('Interview', interviewSchema);

// Initialize OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Initialize Twilio
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// WebSocket connection handler
wss.on('connection', (ws) => {
  console.log('New WebSocket connection');

  ws.on('message', async (message) => {
    const data = JSON.parse(message);
    
    switch(data.event) {
      case 'start_interview':
        try {
          // Create new interview record
          const interview = new Interview({
            phoneNumber: data.phoneNumber,
            topic: data.topic,
            status: 'starting',
            startTime: new Date()
          });
          await interview.save();

          // Initiate call using Twilio
          const call = await twilioClient.calls.create({
            url: `${process.env.BASE_URL}/twiml`,
            to: data.phoneNumber,
            from: process.env.TWILIO_PHONE_NUMBER,
          });

          ws.send(JSON.stringify({
            event: 'call_initiated',
            interviewId: interview._id,
            callSid: call.sid
          }));

        } catch (error) {
          console.error('Error starting interview:', error);
          ws.send(JSON.stringify({
            event: 'error',
            message: 'Failed to start interview'
          }));
        }
        break;

      case 'voice_data':
        // Handle incoming voice data
        try {
          // Convert speech to text using OpenAI Whisper
          const transcript = await openai.audio.transcriptions.create({
            file: Buffer.from(data.audio),
            model: "whisper-1",
          });

          // Get AI response using ChatGPT
          const completion = await openai.chat.completions.create({
            model: "gpt-4",
            messages: [
              {
                role: "system",
                content: `You are conducting an interview about ${data.topic}. Ask relevant questions and provide appropriate responses.`
              },
              { role: "user", content: transcript.text }
            ],
          });

          // Convert AI response to speech
          const speech = await openai.audio.speech.create({
            model: "tts-1",
            voice: "alloy",
            input: completion.choices[0].message.content,
          });

          // Send response back to client
          ws.send(JSON.stringify({
            event: 'ai_response',
            audio: speech.arrayBuffer(),
            text: completion.choices[0].message.content
          }));

        } catch (error) {
          console.error('Error processing voice data:', error);
        }
        break;
    }
  });
});

// TwiML endpoint for Twilio
app.post('/twiml', (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  twiml.connect().stream({
    url: `wss://${req.headers.host}/voice`
  });
  res.type('text/xml');
  res.send(twiml.toString());
});

mongoose.connect(process.env.MONGODB_URI);
server.listen(process.env.PORT || 5000);